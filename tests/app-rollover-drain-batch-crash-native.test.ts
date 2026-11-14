/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import {
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { readV3RoomSettlementBatchCounts } from "../packages/node/src/v3-room.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Per-drain batching across process death (SIGKILL right after a real SQLite COMMIT of the Writer's
// issuance store). A one-epoch install displaces the Writer's moves (they never reached the creator)
// and its drain prepares every row in one dependency turn, issues the author fence, then issues the
// replacements one chunk of V3_SETTLEMENT_DRAIN_TURN_ROWS (8) at a time, each chunk ONE batched
// issuance (transactIssueBatch: one entered-marker commit, then one commit of every row). The whole
// process dies at:
//   fence:          the commit that issues the drain's author fence (every row prepared, none replaced);
//   chunk-marker:   the commit of the first chunk's entered marker (signed nothing, replaced nothing);
//                   the reopened Writer resumes the marker whole before any plan write;
//   between-chunks: the commit of the first chunk (8 rows replaced, the other 2 not);
//   between-journal: after the first chunk's commit, the journal commit of its third row (rows 4..8
//                   committed to issuance but not yet journaled); reopen admits each exactly once.
// At death the Writer's replacement rows carry the logical times singles give them (fence + 2, + 4, ...):
// a batch attempt that fell back or retried left no gap and reused no time.
// Every commit of the Writer's issuance store is watched: a chunk is never partly replaced (no commit
// leaves 0 < replaced-in-chunk < chunk). The fallback (a store without transactIssueBatch: one
// replacement per transaction, as before) has its own edge (DRAIN_BATCH_CRASH_SINGLES=1, SINGLES_EDGES):
//   between-issues: the commit of the drain's second single replacement (some rows replaced);
//   single-marker:  the commit of the first single replacement's entered marker (the singles' chunk-marker;
//                   its earlier reserved marker is cancellable, an entered one is resumed).
// (The drain's one transform-refusal plan CAS needs an application whose displaced moves transform;
// Grid and Chat rebase.)
// The test reopens the same directory, reconnects, and requires every move to be admitted by the
// creator exactly once: no loss, no double apply. No native write, signature or transaction is mocked.
const INNER = process.env.RUN_DRAIN_BATCH_CRASH === "1";
type Edge = "fence" | "chunk-marker" | "between-chunks" | "between-journal" | "between-issues" | "single-marker";
/**
 * The fallback edge: run with DRAIN_BATCH_CRASH_SINGLES=1 against a build whose issuance store has no
 * transactIssueBatch (the drain then issues one replacement per transaction, as before batching).
 */
const SINGLES_EDGES: readonly Edge[] = ["between-issues", "single-marker"];
const EDGES: readonly Edge[] =
	process.env.DRAIN_BATCH_CRASH_SINGLES === "1"
		? SINGLES_EDGES
		: ["fence", "chunk-marker", "between-chunks", "between-journal"];
const MOVES = 10;
const CHUNK = 8;

const track = {
	rooms: new Set<{ close(): Promise<void> }>(),
	heads: new Set<{ close(): Promise<void> }>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
};
const directories: string[] = [];
afterEach(async () => {
	await Promise.allSettled([...track.rooms].map((room) => room.close()));
	await Promise.allSettled([...track.heads].map((head) => head.close()));
	await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.rooms.clear();
	track.heads.clear();
	track.ports.clear();
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type RowValue = { epoch: number; author: string; authorSequence: number; operation: Record<string, unknown> };
const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as RowValue;
const idOf = (operation: string): string | undefined => {
	const value = JSON.parse(operation) as Record<string, unknown> | null;
	return typeof value?.id === "string" ? value.id : undefined;
};
const journalFile = (directory: string, name: string) =>
	join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify(["journal", name]))
			.digest("hex")}.sqlite.drp-live-journal-v1.sqlite`
	);
const issuanceFile = (directory: string, name: string) =>
	join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify(["issuance", name]))
			.digest("hex")}.sqlite.drp-issuance-v1.sqlite`
	);

type PlanEntry = { disposition: string; sourceSequence: number; replacementSequence: number | null };
/**
 * The logical times of the Writer's rows after its latest author fence, and the fence's own.
 * @param file
 * @param author
 */
function writerTimes(file: string, author: string) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const rows = db
			.prepare("SELECT canonical_preimage FROM issued_records WHERE author=? ORDER BY author_sequence")
			.all(author)
			.map(
				(row) =>
					decodeCanonical(new Uint8Array(row.canonical_preimage as Uint8Array)) as RowValue & { logicalTime: number }
			);
		const fence = rows.findLastIndex((row) => row.operation.action === "$drp.author-fence.v1");
		return fence < 0
			? { fenceTime: null, times: [] as number[] }
			: { fenceTime: rows[fence]!.logicalTime, times: rows.slice(fence + 1).map((row) => row.logicalTime) };
	} finally {
		db.close();
	}
}
/**
 * The plan effect kind and phase of the Writer's pending marker, if any (a single's or a batch's).
 * @param file
 * @param author
 */
function writerMarkerEffect(file: string, author: string): string | null {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const row = db.prepare("SELECT pending_unsigned FROM lineages WHERE author=?").get(author) as
			| { pending_unsigned: Uint8Array | null }
			| undefined;
		if (row?.pending_unsigned == null) return null;
		const pending = decodeCanonical(new Uint8Array(row.pending_unsigned)) as {
			phase: string;
			planEffect?: { kind?: string };
		};
		return `${pending.planEffect?.kind ?? "none"}:${pending.phase}`;
	} finally {
		db.close();
	}
}
/**
 * The size of the entered batch marker in the Writer's lineage (null: none, or a single's marker).
 * @param file
 * @param author
 */
function writerBatchMarker(file: string, author: string): number | null {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const row = db.prepare("SELECT pending_unsigned FROM lineages WHERE author=?").get(author) as
			| { pending_unsigned: Uint8Array | null }
			| undefined;
		if (row?.pending_unsigned == null) return null;
		const pending = decodeCanonical(new Uint8Array(row.pending_unsigned)) as { followingIntents?: unknown[] };
		return Array.isArray(pending.followingIntents) ? pending.followingIntents.length + 1 : null;
	} finally {
		db.close();
	}
}
/**
 * The Writer's settlement plan, read straight from its SQLite file.
 * @param file
 * @param author
 */
function writerPlan(file: string, author: string) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const row = db.prepare("SELECT entries_json, fence_sequence FROM settlement_plans WHERE author=?").get(author) as
			| { entries_json: string; fence_sequence: number | null }
			| undefined;
		if (row === undefined) return { entries: [] as PlanEntry[], fence: null as number | null };
		const decoded = JSON.parse(row.entries_json) as unknown;
		const entries = Array.isArray(decoded)
			? (decoded as PlanEntry[])
			: (
					decodeCanonical(new Uint8Array(Buffer.from((decoded as { bytes: string }).bytes, "base64"))) as {
						entries: PlanEntry[];
					}
				).entries;
		return { entries, fence: row.fence_sequence };
	} finally {
		db.close();
	}
}

async function openPair(directory: string, reopen: boolean) {
	const options = {
		app: "grid" as const,
		host: "node" as const,
		recipient: "writer" as const,
		creatorLull: false,
		epochs: 1,
		moves: 1,
		chatFormat: "shares" as const,
		rollover: "app" as const,
	};
	const env = {
		host: nodeHostFor("node", directory, reopen),
		unique: directory,
		track,
		openFloor: (role: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${role}-external-floor.sqlite`),
				initialization: { kind: reopen ? ("reopen" as const) : ("create" as const) },
			}),
	};
	const creator = await openRole(options, 0, env);
	const writer = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
	return { creator, writer };
}

function rowWire(creator: RoleEndpoint, writer: RoleEndpoint) {
	const cursor = { creator: null as number | null, writer: null as number | null };
	const carry = async (from: RoleEndpoint, to: RoleEndpoint, key: "creator" | "writer") => {
		const published = await from.published(cursor[key]);
		if (published.length === 0) return;
		const current = (await to.authorityEpoch()) ?? 0;
		const ahead = published.findIndex((row) => rowValue(row).epoch > current);
		const rows = ahead < 0 ? published : published.slice(0, ahead);
		if (rows.length === 0) return;
		await to.inject(rows.filter((row) => rowValue(row).epoch === current));
		cursor[key] = rows.at(-1)?.authorSequence ?? cursor[key];
	};
	return { toWriter: () => carry(creator, writer, "creator"), toCreator: () => carry(writer, creator, "writer") };
}

async function rollCreator(creator: RoleEndpoint, carry: () => Promise<void>, ordinal: { next: number }) {
	const before = (await creator.rollover?.())?.epoch ?? 0;
	for (;;) {
		await creator.issue(0, ordinal.next++);
		await carry();
		const epoch = (await creator.rollover?.())?.epoch ?? 0;
		if (epoch > before) return epoch;
	}
}

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 2000)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function acceptedCounts(role: RoleEndpoint, author: string, ids: readonly string[]) {
	const vertices = (await role.acceptedVertices?.()) ?? [];
	return ids.map((id) => vertices.filter((vertex) => vertex.author === author && idOf(vertex.operation) === id).length);
}

type Setup = { writerAuthor: string; ids: string[]; ordinal: number };

it.runIf(INNER)(
	"a Writer dies inside a batched drain",
	async () => {
		const directory = process.env.DRAIN_BATCH_CRASH_DIRECTORY!;
		const edge = process.env.DRAIN_BATCH_CRASH_EDGE as Edge;
		const deathFile = join(directory, "death.json"),
			setupFile = join(directory, "setup.json"),
			partialFile = join(directory, "partial-chunk.json");
		const singles = process.env.DRAIN_BATCH_CRASH_SINGLES === "1";
		const file = issuanceFile(directory, "recipient");
		const journal = journalFile(directory, "recipient");
		const exec = DatabaseSync.prototype.exec;
		const watch = { author: "", armed: false, inside: false, journalCommits: null as number | null };
		// Native transactions since the drain's fence committed, split by kind (observation only: the per-row cost).
		// A write is a BEGIN IMMEDIATE transaction; a read is a plain BEGIN snapshot (no fsync); both end in COMMIT.
		const since = {
			fenced: false,
			issuanceWrites: 0,
			issuanceReads: 0,
			journalWrites: 0,
			journalReads: 0,
			issuanceSites: [] as string[],
		};
		const transactionKind = new WeakMap<DatabaseSync, "write" | "read">();
		// The first library frames (function and file:line) of each counted issuance commit, prefixed by its kind.
		const commitSite = (): string => {
			const limit = Error.stackTraceLimit;
			Error.stackTraceLimit = 40;
			const stack = new Error().stack ?? "";
			Error.stackTraceLimit = limit;
			return stack
				.split("\n")
				.filter((line) => line.includes("/packages/") && !line.includes("node:"))
				.map((line) => line.trim().replace(/^at /u, "").replace(/\(.*\/packages\//u, "("))
				.slice(0, 8)
				.join(" < ");
		};
		const die = (detail: Record<string, unknown>) => {
			const times = writerTimes(file, watch.author);
			writeFileSync(
				deathFile,
				JSON.stringify({
					edge,
					pid: process.pid,
					signal: "SIGKILL",
					...times,
					commitsSinceFence: since,
					settlementBatch: readV3RoomSettlementBatchCounts(),
					...detail,
				})
			);
			process.kill(process.pid, "SIGKILL");
			throw Error("SIGKILL_DID_NOT_TERMINATE");
		};
		DatabaseSync.prototype.exec = function (sql: string) {
			if (sql.startsWith("BEGIN")) transactionKind.set(this, sql.includes("IMMEDIATE") ? "write" : "read");
			const result = exec.call(this, sql);
			if (since.fenced && (sql === "COMMIT" || sql.endsWith("COMMIT"))) {
				const kind = transactionKind.get(this) ?? "read";
				if (this.location()?.endsWith(`/${basename(file)}`) === true) {
					if (kind === "write") since.issuanceWrites += 1;
					else since.issuanceReads += 1;
					if (since.issuanceSites.length < 40) since.issuanceSites.push(`${kind}: ${commitSite()}`);
				}
				if (this.location()?.endsWith(`/${basename(journal)}`) === true) {
					if (kind === "write") since.journalWrites += 1;
					else since.journalReads += 1;
				}
			}
			if (
				watch.journalCommits !== null &&
				(sql === "COMMIT" || sql.endsWith("COMMIT")) &&
				this.location()?.endsWith(`/${basename(journal)}`) === true &&
				++watch.journalCommits === 3
			)
				die({ journalCommits: watch.journalCommits, replaced: CHUNK });
			if (
				watch.armed &&
				(sql === "COMMIT" || sql.endsWith("COMMIT")) &&
				!watch.inside &&
				this.location()?.endsWith(`/${basename(file)}`) === true
			) {
				watch.inside = true;
				try {
					const { entries, fence } = writerPlan(file, watch.author);
					const rebase = entries.filter((entry) => entry.disposition === "rebase");
					const replaced = rebase.filter((entry) => entry.replacementSequence !== null);
					// A chunk commits whole: replaced counts only ever land on chunk boundaries.
					if (!singles && rebase.length === MOVES && replaced.length % CHUNK !== 0 && replaced.length !== MOVES)
						writeFileSync(partialFile, JSON.stringify({ replaced: replaced.length, rebase: rebase.length }));
					if (fence !== null && rebase.length === MOVES && replaced.length === 0 && !since.fenced) {
						since.fenced = true;
						since.issuanceWrites = 0;
						since.issuanceReads = 0;
						since.issuanceSites.length = 0;
					}
					if (edge === "fence" && fence !== null && rebase.length === MOVES && replaced.length === 0)
						die({ fence, rebase: rebase.length });
					const marker = writerBatchMarker(file, watch.author);
					if (edge === "chunk-marker" && marker !== null && replaced.length === 0)
						die({ marker, rebase: rebase.length });
					if (edge === "between-chunks" && replaced.length === CHUNK)
						die({ replaced: replaced.map((entry) => entry.sourceSequence), rebase: rebase.length });
					if (edge === "between-journal" && replaced.length === CHUNK) watch.journalCommits ??= 0;
					if (
						edge === "single-marker" &&
						replaced.length === 0 &&
						writerMarkerEffect(file, watch.author) === "replacement:entered"
					)
						die({ marker: 1, rebase: rebase.length });
					if (edge === "between-issues" && replaced.length === 2)
						die({ replaced: replaced.map((entry) => entry.sourceSequence), rebase: rebase.length });
				} finally {
					watch.inside = false;
				}
			}
			return result;
		};
		const restore = await installEnvironment("node", () => undefined);
		try {
			const { creator, writer } = await openPair(directory, false);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: 0 };
			let epoch = 0;
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
			}
			const ids: string[] = [];
			for (let k = 0; k < MOVES; k++) {
				await writer.issue(epoch, k);
				ids.push(`block-1-${k}`);
			}
			watch.author = rowValue((await writer.published(null))[0]!).author;
			writeFileSync(
				setupFile,
				JSON.stringify({ writerAuthor: watch.author, ids, ordinal: ordinal.next } satisfies Setup)
			);
			watch.armed = true;
			// One one-epoch install: the Writer's moves (never carried) are displaced and replaced.
			for (let round = 0; round < 3; round++) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 120_000);
				await rows.toWriter();
				await new Promise((resolve) => setTimeout(resolve, 2_000));
			}
			throw Error(`DRAIN_BATCH_CRASH_EDGE_NOT_REACHED:${edge} ${JSON.stringify(writerPlan(file, watch.author))}`);
		} finally {
			restore();
		}
	},
	900_000
);

it.skipIf(INNER).each(EDGES)(
	"SIGKILL at the batched drain's %s commit: every move is admitted exactly once",
	async (edge) => {
		const directory = mkdtempSync(join(tmpdir(), `app-rollover-drain-batch-crash-${edge}-`));
		directories.push(directory);
		const file = fileURLToPath(import.meta.url);
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			env: {
				...process.env,
				RUN_DRAIN_BATCH_CRASH: "1",
				DRAIN_BATCH_CRASH_DIRECTORY: directory,
				DRAIN_BATCH_CRASH_EDGE: edge,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const deathFile = join(directory, "death.json");
		if (!existsSync(deathFile)) throw new Error(`the Writer did not die at ${edge}:\n${output.slice(-6000)}`);
		const death = JSON.parse(readFileSync(deathFile, "utf8")) as Record<string, unknown>;
		const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as Setup;
		process.stdout.write(`DRAIN_BATCH_CRASH_DEATH ${JSON.stringify({ death, setup })}\n`);
		expect(death).toMatchObject({ signal: "SIGKILL", edge });
		expect(existsSync(join(directory, "partial-chunk.json")), "a chunk was partly replaced").toBe(false);
		if (edge === "chunk-marker") expect(death).toMatchObject({ marker: CHUNK, rebase: MOVES });
		if (edge === "between-chunks") expect((death.replaced as number[]).length).toBe(CHUNK);
		if (edge === "between-journal") expect(death).toMatchObject({ journalCommits: 3 });
		// Replacement logical times are the singles' own: fence + 2, + 4, ... (no gap, no reuse).
		const times = death.times as number[];
		if (edge !== "fence" && edge !== "chunk-marker" && edge !== "single-marker") {
			expect(times.length).toBeGreaterThan(0);
			expect(times).toEqual(times.map((_, index) => (death.fenceTime as number) + 2 * (index + 1)));
		}

		const restore = await installEnvironment("node", () => undefined);
		try {
			const { creator, writer } = await openPair(directory, true);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: setup.ordinal + 1_000 };
			try {
				// Reconnected: every row of the Writer reaches the creator from here on.
				await rows.toWriter();
				await rows.toCreator();
				let epoch = (await creator.rollover?.())?.epoch ?? 0;
				await waitFor(
					"the creator admits every move of the Writer",
					async () => {
						epoch = await rollCreator(creator, rows.toWriter, ordinal);
						await wire.caughtUp(epoch, 120_000);
						await rows.toWriter();
						await rows.toCreator();
						return acceptedCounts(creator, setup.writerAuthor, setup.ids);
					},
					(counts) => counts.every((count) => count >= 1),
					600_000
				);
				// Two more closes: anything still being offered lands, then nothing may be twice.
				for (let round = 0; round < 2; round++) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await wire.caughtUp(epoch, 120_000);
					await rows.toWriter();
					await rows.toCreator();
				}
				expect(await acceptedCounts(creator, setup.writerAuthor, setup.ids)).toEqual(setup.ids.map(() => 1));
				expect(await writer.state()).toBe(await creator.state());
			} finally {
				await wire.stop();
			}
		} finally {
			restore();
		}
	},
	1_200_000
);

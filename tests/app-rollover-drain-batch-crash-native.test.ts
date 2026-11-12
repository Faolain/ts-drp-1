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
import { fromBase64, type RoleEndpoint, successorWire, type WireRow } from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Per-drain batching across process death (SIGKILL right after a real SQLite COMMIT of the Writer's
// issuance store). A one-epoch install displaces the Writer's moves (they never reached the creator)
// and its drain prepares every row in one dependency turn, issues the author fence, then issues one
// replacement per row, each its own durable transaction. The whole process dies at:
//   fence:          the commit that issues the drain's author fence (every row prepared, none replaced);
//   between-issues: the commit of the drain's second replacement (some rows replaced, the rest not).
// (The drain's one transform-refusal plan CAS needs an application whose displaced moves transform;
// Grid and Chat rebase.)
// The test reopens the same directory, reconnects, and requires every move to be admitted by the
// creator exactly once: no loss, no double apply. No native write, signature or transaction is mocked.
const INNER = process.env.RUN_DRAIN_BATCH_CRASH === "1";
const EDGES = ["fence", "between-issues"] as const;
type Edge = (typeof EDGES)[number];
const MOVES = 6;

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
const issuanceFile = (directory: string, name: string) =>
	join(directory, `${createHash("sha256").update(JSON.stringify(["issuance", name])).digest("hex")}.sqlite.drp-issuance-v1.sqlite`);

type PlanEntry = { disposition: string; sourceSequence: number; replacementSequence: number | null };
/** The Writer's settlement plan, read straight from its SQLite file. */
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
			: (decodeCanonical(new Uint8Array(Buffer.from((decoded as { bytes: string }).bytes, "base64"))) as { entries: PlanEntry[] })
					.entries;
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
			setupFile = join(directory, "setup.json");
		const file = issuanceFile(directory, "recipient");
		const exec = DatabaseSync.prototype.exec;
		const watch = { author: "", armed: false, inside: false };
		const die = (detail: Record<string, unknown>) => {
			writeFileSync(deathFile, JSON.stringify({ edge, pid: process.pid, signal: "SIGKILL", ...detail }));
			process.kill(process.pid, "SIGKILL");
			throw Error("SIGKILL_DID_NOT_TERMINATE");
		};
		DatabaseSync.prototype.exec = function (sql: string) {
			const result = exec.call(this, sql);
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
					if (edge === "fence" && fence !== null && rebase.length === MOVES && replaced.length === 0)
						die({ fence, rebase: rebase.length });
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
			writeFileSync(setupFile, JSON.stringify({ writerAuthor: watch.author, ids, ordinal: ordinal.next } satisfies Setup));
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
			env: { ...process.env, RUN_DRAIN_BATCH_CRASH: "1", DRAIN_BATCH_CRASH_DIRECTORY: directory, DRAIN_BATCH_CRASH_EDGE: edge },
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

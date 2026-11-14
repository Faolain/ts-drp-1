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

// A Writer's handed-back moves across process death (SIGKILL right after a real SQLite COMMIT of the
// Writer's issuance store). The settlement window gives a move back to the application once it has
// waited the window without reaching the creator; the application keeps it and offers it again when
// its moves reach the creator. The whole process dies (creator and Writer); this test reopens the
// same directory, reconnects, and requires every move the Writer made to be admitted by the creator
// exactly once: no loss, no double apply. No native write, signature or transaction is mocked.
//   resolution: the commit that first resolves a displaced move as window-expired (the hand-back).
//   pruned:     the commit that retires the expired row of a move the application holds in memory
//               (taken back, not yet offered again because its moves do not reach the creator).
//   reissue:    after reconnecting, the commit that issues the application's new row for that move.
//
// Before the fix (hand-backs derived in memory from retained rows, dff7d4ed): "pruned" loses the move
// (nothing durable names it once its row is retired, and the application's copy died with the
// process) and "reissue" applies it twice (the expired row is still retained, so the reopened room
// gives the move back again although its new row is already committed and published). The fix keeps
// each handed-back operation in a durable hand-back record written in the expiry's own plan write; it
// outlives row retirement and is consumed by the issuance transaction of the row that offers the move
// again (a settlement plan effect), so a crash at any point either still lists it or never lists it
// again. Writing the reissued row and consuming the record are one transaction: there is no separate
// "reissued but not consumed" edge.
const INNER = process.env.RUN_HANDBACK_CRASH === "1";
const EDGES = ["resolution", "pruned", "reissue"] as const;
type Edge = (typeof EDGES)[number];
// Silent epochs before the death (or before reconnecting, for "reissue"): the window is 4, so move 1
// is given back at epoch 5 and its expired row is retired a few epochs later.
const SILENT: Readonly<Record<Edge, number>> = { resolution: 6, pruned: 12, reissue: 5 };
const TARGET = "block-1-1";

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
const moveId = (epoch: number) => `block-1-${epoch}`;
const idOf = (operation: string): string | undefined => {
	const value = JSON.parse(operation) as Record<string, unknown> | null;
	return typeof value?.id === "string" ? value.id : undefined;
};
const chain = (cause: unknown) => {
	const parts: string[] = [];
	for (let value: unknown = cause; value instanceof Error && parts.length < 10; value = value.cause)
		parts.push(`${value.name}: ${value.message}`);
	return parts;
};
const issuanceFile = (directory: string, name: string) =>
	join(directory, `${createHash("sha256").update(JSON.stringify(["issuance", name])).digest("hex")}.sqlite.drp-issuance-v1.sqlite`);

/** Every move id ("block-…") a decoded value carries. */
function moveIds(value: unknown, out = new Set<string>()): Set<string> {
	if (typeof value === "string") {
		if (/^block-\d+-\d+$/u.test(value)) out.add(value);
	} else if (Array.isArray(value)) for (const item of value) moveIds(item, out);
	else if (value !== null && typeof value === "object" && !(value instanceof Uint8Array))
		for (const item of Object.values(value)) moveIds(item, out);
	return out;
}

type PlanEntry = { disposition: string; sourceSequence: number; sourceContextDigest?: unknown };
type HandBack = { sourceSequence: number; intent: number; reissueSequence: number | null; exactCanonicalOperationBytes: Uint8Array };
/**
 * The Writer's settlement plan entries, hand-back records and issued rows, read straight from its SQLite file.
 * @param file - The Writer's issuance store.
 * @param author - The Writer's author.
 * @returns Its plan entries, its hand-back records with their move ids, and its issued rows' move ids by author sequence.
 */
function writerIssuance(file: string, author: string) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const planRow = db.prepare("SELECT entries_json FROM settlement_plans WHERE author=?").get(author) as
			| { entries_json: string }
			| undefined;
		let entries: PlanEntry[] = [];
		let handBacks: (HandBack & { ids: Set<string> })[] = [];
		if (planRow !== undefined) {
			const decoded = JSON.parse(planRow.entries_json) as unknown;
			if (Array.isArray(decoded)) entries = decoded as PlanEntry[];
			else {
				const bytes = Buffer.from((decoded as { bytes: string }).bytes, "base64");
				const plan = decodeCanonical(new Uint8Array(bytes)) as { entries: PlanEntry[]; handBacks?: HandBack[] };
				entries = plan.entries;
				handBacks = (plan.handBacks ?? []).map((record) => ({
					...record,
					ids: moveIds(decodeCanonical(record.exactCanonicalOperationBytes)),
				}));
			}
		}
		const issued = new Map<number, Set<string>>();
		for (const row of db
			.prepare("SELECT author_sequence, canonical_preimage FROM issued_records WHERE author=?")
			.all(author) as { author_sequence: number; canonical_preimage: Uint8Array }[]) {
			const preimage = decodeCanonical(new Uint8Array(row.canonical_preimage)) as { operation: unknown };
			issued.set(Number(row.author_sequence), moveIds(preimage.operation));
		}
		return { entries, handBacks, issued };
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
	let stage = "open-creator";
	try {
		const creator = await openRole(options, 0, env);
		stage = "open-writer";
		const writer = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
		return { creator, writer };
	} catch (cause) {
		throw new Error(`${stage}: ${chain(cause).join(" <- ")}`, { cause });
	}
}

/** The scripted row wire: each side's rows reach the other only in the receiver's current epoch. */
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

async function follow(wire: ReturnType<typeof successorWire>, writer: RoleEndpoint, epoch: number) {
	try {
		await wire.caughtUp(epoch, 60_000);
	} catch (error) {
		const member = await writer.successorDelivery?.();
		throw new Error(
			`the Writer stopped following at epoch ${member?.epoch} (creator ${epoch}): ${JSON.stringify(member?.lastError ?? null)}`,
			{ cause: error }
		);
	}
}

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000) {
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

type Status = Readonly<{ state: string; kept: readonly Record<string, unknown>[] }>;
type Setup = { writerAuthor: string; ids: string[]; epoch: number; ordinal: number; reconnected: boolean };

it.runIf(INNER)(
	"a Writer dies right after a hand-back commit",
	async () => {
		const directory = process.env.HANDBACK_CRASH_DIRECTORY!;
		const edge = process.env.HANDBACK_CRASH_EDGE as Edge;
		const deathFile = join(directory, "death.json"),
			setupFile = join(directory, "setup.json"),
			admittedFile = join(directory, "admitted.json");
		const file = issuanceFile(directory, "recipient");
		const exec = DatabaseSync.prototype.exec;
		const watch = {
			author: "",
			armed: false,
			// Window-expired sources seen so far and the move ids their rows carried.
			expired: new Map<number, Set<string>>(),
			// The author sequences issued before reconnecting (a reissue is a later row).
			before: -1,
			inside: false,
			// "pruned": the durable hand-back record of the target move that armed the edge.
			arm: undefined as { sourceSequence: number; intent: number } | undefined,
		};
		const die = (detail: Record<string, unknown>) => {
			writeFileSync(deathFile, JSON.stringify({ edge, pid: process.pid, signal: "SIGKILL", ...detail }));
			process.kill(process.pid, "SIGKILL");
			throw Error("SIGKILL_DID_NOT_TERMINATE");
		};
		DatabaseSync.prototype.exec = function (sql: string) {
			const result = exec.call(this, sql);
			if (
				(sql === "COMMIT" || sql.endsWith("COMMIT")) &&
				watch.author !== "" &&
				!watch.inside &&
				this.location()?.endsWith(`/${basename(file)}`) === true
			) {
				watch.inside = true;
				try {
					const { entries, handBacks, issued } = writerIssuance(file, watch.author);
					const windowExpired = entries.filter(
						(entry) => entry.disposition === "expire" && entry.sourceContextDigest === undefined
					);
					for (const entry of windowExpired)
						if (!watch.expired.has(entry.sourceSequence))
							watch.expired.set(entry.sourceSequence, issued.get(entry.sourceSequence) ?? new Set());
					// "pruned" arms on the durable record, not on a status poll: the move is given back (its
					// unconsumed hand-back record, written in the expiry's own plan write) and not yet offered
					// again. The application offers a given-back move within about an epoch, so a per-epoch poll
					// of its kept moves may never see it.
					const target = handBacks.find((record) => record.reissueSequence === null && record.ids.has(TARGET));
					if (edge === "pruned" && !watch.armed && target !== undefined) {
						watch.armed = true;
						watch.arm = { sourceSequence: target.sourceSequence, intent: target.intent };
						process.stdout.write(`HANDBACK_CRASH_ARMED ${JSON.stringify({ edge, record: watch.arm })}\n`);
					}
					if (watch.armed) {
						if (edge === "resolution" && windowExpired.length > 0)
							die({ sources: windowExpired.map((entry) => entry.sourceSequence) });
						if (edge === "pruned")
							for (const [sequence, ids] of watch.expired)
								if (ids.has(TARGET) && !issued.has(sequence))
									die({
										retired: sequence,
										armedBy: watch.arm,
										// Whether the application had offered the move again before this commit.
										recordConsumed: handBacks.some(
											(record) => record.ids.has(TARGET) && record.reissueSequence !== null
										),
									});
						if (edge === "reissue")
							for (const [sequence, ids] of issued)
								if (sequence > watch.before && ids.has(TARGET)) die({ reissued: sequence });
					}
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
			const wireRows = rowWire(creator, writer);
			const ordinal = { next: 0 };
			const ids: string[] = [];
			// The creator's admissions are observed in memory (acceptedVertices), so the reopened process
			// cannot see what this one admitted. Every carry of the Writer's rows records them durably first.
			const rows = {
				toWriter: wireRows.toWriter,
				toCreator: async () => {
					await wireRows.toCreator();
					if (watch.author !== "")
						writeFileSync(admittedFile, JSON.stringify(await acceptedCounts(creator, watch.author, ids)));
				},
			};
			let epoch = 0;
			const save = (reconnected: boolean) =>
				writeFileSync(
					setupFile,
					JSON.stringify({ writerAuthor: watch.author, ids, epoch, ordinal: ordinal.next, reconnected } satisfies Setup)
				);
			watch.armed = edge === "resolution";
			// "pruned" arms itself in the commit hook, on the target move's durable hand-back record.
			// Silent: the creator's rows reach the Writer; the Writer's rows reach no one.
			while (epoch < SILENT[edge]) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await follow(wire, writer, epoch);
				await rows.toWriter();
				await writer.issue(1, epoch);
				ids.push(moveId(epoch));
				if (watch.author === "") watch.author = rowValue((await writer.published(null))[0]!).author;
				save(false);
				const status = (await writer.rolloverStatus?.()) as Status;
				process.stdout.write(`HANDBACK_CRASH_EPOCH ${JSON.stringify({ epoch, state: status.state, kept: status.kept.map((op) => op.id) })}\n`);
			}
			if (edge === "reissue") {
				await waitFor(
					"the application takes the move back",
					async () => ((await writer.rolloverStatus?.()) as Status).kept.map((operation) => operation.id),
					(kept) => kept.includes(TARGET)
				);
				watch.before = Math.max(...(await writer.published(null)).map((row) => row.authorSequence));
				watch.armed = true;
				save(true);
				// Reconnect: the Writer's rows reach the creator, its settlement lands, the move is offered again.
				await rows.toCreator();
				for (let round = 0; round < 4; round++) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					save(true);
					await follow(wire, writer, epoch);
					await rows.toWriter();
					await rows.toCreator();
					await new Promise((resolve) => setTimeout(resolve, 2_000));
				}
			}
			throw Error(`HANDBACK_CRASH_EDGE_NOT_REACHED:${edge} ${JSON.stringify([...watch.expired].map(([s, v]) => [s, [...v]]))}`);
		} finally {
			restore();
		}
	},
	900_000
);

it.skipIf(INNER).each(EDGES)(
	"SIGKILL right after the Writer's %s commit: every move is admitted exactly once",
	async (edge) => {
		const directory = mkdtempSync(join(tmpdir(), `app-rollover-handback-crash-${edge}-`));
		directories.push(directory);
		const file = fileURLToPath(import.meta.url);
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			env: { ...process.env, RUN_HANDBACK_CRASH: "1", HANDBACK_CRASH_DIRECTORY: directory, HANDBACK_CRASH_EDGE: edge },
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
		// What the creator admitted before the death (its in-memory observation does not survive reopen).
		const admittedFile = join(directory, "admitted.json");
		const before = existsSync(admittedFile) ? (JSON.parse(readFileSync(admittedFile, "utf8")) as number[]) : [];
		process.stdout.write(`HANDBACK_CRASH_DEATH ${JSON.stringify({ death, setup, before })}\n`);
		const total = async (role: RoleEndpoint) =>
			(await acceptedCounts(role, setup.writerAuthor, setup.ids)).map((count, index) => count + (before[index] ?? 0));
		expect(death).toMatchObject({ signal: "SIGKILL", edge });
		// The pruned edge is reached only after its arm: the target move's durable hand-back record.
		if (edge === "pruned") expect(death.armedBy, "the pruned edge was armed by the target's hand-back record").toBeDefined();

		const restore = await installEnvironment("node", () => undefined);
		try {
			const { creator, writer } = await openPair(directory, true);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: setup.ordinal + 1_000 };
			try {
				// Reconnected (again): every row of the Writer reaches the creator from here on.
				await rows.toWriter();
				await rows.toCreator();
				let epoch = (await creator.rollover?.())?.epoch ?? 0;
				let counts: number[] = [];
				for (let round = 0; round < 6; round++) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await follow(wire, writer, epoch);
					await rows.toWriter();
					await rows.toCreator();
					const status = (await writer.rolloverStatus?.()) as Status;
					counts = await total(creator);
					process.stdout.write(
						`HANDBACK_CRASH_AFTER ${JSON.stringify({ edge, epoch, state: status.state, kept: status.kept.map((op) => op.id), counts, settlement: await writer.settlementStatus?.() })}\n`
					);
					if (round >= 1 && status.kept.length === 0 && counts.every((count) => count >= 1)) break;
				}
				await waitFor(
					"the creator admits every move of the Writer",
					async () => {
						await rows.toCreator();
						return total(creator);
					},
					(value) => value.every((count) => count >= 1)
				);
				// One more close: anything still being offered lands, then nothing may be twice.
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await follow(wire, writer, epoch);
				await rows.toWriter();
				await rows.toCreator();
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await follow(wire, writer, epoch);
				await rows.toWriter();
				expect(await total(creator)).toEqual(setup.ids.map(() => 1));
				expect(((await writer.settlementStatus?.()) as { undelivered: unknown[] }).undelivered).toEqual([]);
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

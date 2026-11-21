/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native probe inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { decodeAheRetirementControl } from "@ts-drp/storage";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
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
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// fix/browser-rollover-member-stall, box m39 (red-cold at d2100df7 failed once, in 11.5 s, with
// "creator snapshot role reconciliation refused: chain-invalid"; m42 passed it 3/3). That check is the
// creator's closed-retirement law: a durable ACTIVE AHE retirement preparation must re-derive the same
// source and decision digests from the census when it resumes. red-cold kills the whole process (the
// creator too) at a member's drain signature, which lands inside the creator's recovery maintenance at
// a varying point; the DIAGC probes of the passing runs show the kill landing just after a maintenance
// pass began, before its preparation (no active preparation at the kill, none seen on reopen).
//
// This RED kills the CREATOR deterministically inside that window: SIGKILL right after a real SQLite
// COMMIT of the creator, counted from the COMMIT that saved a fresh ACTIVE retirement preparation in its
// AHE store (k = 0: that commit; k = n: the n-th creator commit after it while the preparation is still
// active, any store; if that preparation ends first, the count goes on in the next active window).
// Nothing native is mocked. The same directory reopens; the creator must resume or
// redo the interrupted retirement, keep closing epochs, the member must follow, and every member move
// must be admitted by the creator exactly once with equal states. No rule-R deferral is set up: the
// member is plain, so the outcome does not depend on the cold-reopen settlement path.
const INNER = process.env.RUN_CREATOR_RETIREMENT_CRASH === "1";
const EDGES = [0, 1, 2, 3, 4, 5] as const;
// Epochs closed and followed before the hook arms (the creator's maintenance retires older epochs from
// epoch 3 on, as in red-cold's death at creator epoch 4).
const WARM = 3;
// The child gives up (edge not reached) after this many epochs.
const MAX_EPOCHS = 14;

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const movesOf = (operation: unknown): string[] => {
	if (operation === null || typeof operation !== "object") return [];
	const id = Reflect.get(operation, "id");
	if (typeof id === "string") return [id];
	const entries = Reflect.get(Reflect.get(operation, "batch") ?? {}, "entries");
	return Array.isArray(entries) ? entries.flatMap((entry) => movesOf(Reflect.get(entry, "operation"))) : [];
};
// Block ids in a role's projected Grid state (examples/grid/src/v3-zone.ts canonicalZoneStateBytes:
// blocks are kept sorted by id, one per id). The reopened projection is rebuilt from the role's durable
// stores, so this is the durable record of every admitted move.
const creatorBlocks = async (role: RoleEndpoint): Promise<string[]> => {
	const state = decodeCanonical(Buffer.from(await role.state(), "hex")) as { blocks?: { id?: unknown }[] };
	return (state.blocks ?? []).map((block) => String(block.id));
};
// The creator's native files (tests/fixtures/track-m-apps/app-long-room.ts sqliteFile; the AHE owner
// opens "<name>--ahe").
const FAMILIES = ["ahe", "issuance", "journal", "snapshots", "signing"] as const;
const creatorFiles = new Map(
	FAMILIES.flatMap((family) =>
		["creator", "creator--ahe"].map(
			(name) =>
				[
					createHash("sha256")
						.update(JSON.stringify([family, name]))
						.digest("hex"),
					family,
				] as const
		)
	)
);
const creatorFamily = (location: string | null) =>
	location === null ? undefined : creatorFiles.get(basename(location).slice(0, 64));

// node:sqlite DatabaseSync.location() (present at runtime; absent from this @types/node).
const locationOf = (database: DatabaseSync) => (database as unknown as { location(): string | null }).location();

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
	const writer = await openRole(options, 1, {
		...env,
		relay: (request: string) => creator.dispatch(request),
	});
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
	let carrying: Promise<void> = Promise.resolve();
	const serial = (run: () => Promise<void>) => (carrying = carrying.then(run, run));
	return {
		toWriter: () => serial(() => carry(creator, writer, "creator")),
		toCreator: () => serial(() => carry(writer, creator, "writer")),
	};
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
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 3000)}`);
		await sleep(50);
	}
}

type Death = {
	edge: number;
	family: string;
	creatorEpoch: number;
	writerAuthor: string;
	ids: string[];
	nextMove: number;
	ordinal: number;
	preparation: { sourceProofDigest: string; decisionDigest: string; throughEpoch: unknown };
	creatorAdmitted: string[];
};

/**
 * Installs the commit hook: tracks the creator AHE store's retirement control as each transaction
 * commits, and calls `kill` after the k-th creator COMMIT counted from the commit that saved a fresh
 * active preparation.
 * @param edge - k.
 * @param armed - Whether the hook may fire now.
 * @param kill - Called synchronously after the chosen COMMIT returned.
 * @returns The restore function.
 */
function installCommitHook(
	edge: number,
	armed: () => boolean,
	kill: (family: string, preparation: Death["preparation"]) => void
) {
	const prepare = DatabaseSync.prototype.prepare,
		run = StatementSync.prototype.run,
		exec = DatabaseSync.prototype.exec;
	const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
	// Per AHE connection: the control written in its open transaction (undefined: none written).
	const staged = new WeakMap<DatabaseSync, { active: Death["preparation"] | null }>();
	const state = { active: null as Death["preparation"] | null, count: -1 };
	DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
		const statement = prepare.call(this, sql);
		statements.set(statement, { database: this, sql });
		return statement;
	} as typeof DatabaseSync.prototype.prepare;
	StatementSync.prototype.run = function (this: StatementSync, ...args: unknown[]) {
		const result = (run as (...values: unknown[]) => ReturnType<typeof run>).apply(this, args);
		const source = statements.get(this);
		if (
			source !== undefined &&
			/retirement_controls/.test(source.sql) &&
			creatorFamily(locationOf(source.database)) === "ahe"
		) {
			const record = /^\s*UPDATE/i.test(source.sql) ? args[0] : args[1];
			if (record instanceof Uint8Array) {
				const decoded = decodeAheRetirementControl(record);
				if (decoded.ok) {
					const active = decoded.value.active;
					staged.set(source.database, {
						active:
							active === null
								? null
								: {
										sourceProofDigest: active.preparation.sourceProofDigest,
										decisionDigest: active.preparation.decisionDigest,
										throughEpoch: Reflect.get(active.preparation, "throughEpoch") ?? null,
									},
					});
				}
			}
		}
		return result;
	} as typeof StatementSync.prototype.run;
	DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
		const family = creatorFamily(locationOf(this));
		const result = exec.call(this, sql);
		if (family === undefined) return result;
		if (/ROLLBACK/i.test(sql)) staged.delete(this);
		if (!(sql === "COMMIT" || sql.endsWith("COMMIT"))) return result;
		const wasActive = state.active;
		const written = staged.get(this);
		staged.delete(this);
		if (written !== undefined) state.active = written.active;
		if (!armed()) return result;
		if (state.count < 0) {
			// A fresh preparation: the control turned active in this commit.
			if (wasActive === null && state.active !== null) state.count = 0;
		} else if (wasActive !== null) state.count++;
		const preparation = wasActive ?? state.active;
		if (state.count === edge && preparation !== null) kill(family, preparation);
		return result;
	} as typeof DatabaseSync.prototype.exec;
	return () => {
		DatabaseSync.prototype.prepare = prepare;
		StatementSync.prototype.run = run;
		DatabaseSync.prototype.exec = exec;
	};
}

it.runIf(INNER)(
	"the creator dies inside its closed-retirement window",
	async () => {
		const directory = process.env.CREATOR_RETIREMENT_CRASH_DIRECTORY ?? "";
		const edge = Number(process.env.CREATOR_RETIREMENT_CRASH_EDGE ?? "NaN");
		if (directory === "" || !Number.isSafeInteger(edge)) throw Error("CREATOR_RETIREMENT_CRASH_* is not set");
		const restore = await installEnvironment("node", () => undefined);
		const ids: string[] = [];
		const ordinal = { next: 0 };
		let nextMove = 0;
		let creatorEpoch = 0;
		let writerAuthor = "";
		let armed = false;
		let admitted: string[] = [];
		const unhook = installCommitHook(
			edge,
			() => armed,
			(family, preparation) => {
				writeFileSync(
					join(directory, "death.json"),
					JSON.stringify({
						edge,
						family,
						creatorEpoch,
						writerAuthor,
						ids,
						nextMove,
						ordinal: ordinal.next,
						preparation,
						creatorAdmitted: admitted,
					} satisfies Death)
				);
				process.kill(process.pid, "SIGKILL");
				throw Error("SIGKILL_DID_NOT_TERMINATE");
			}
		);
		try {
			const { creator, writer } = await openPair(directory, false);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const creatorMoves = async () =>
				((await creator.acceptedVertices?.()) ?? [])
					.filter((vertex) => vertex.author === writerAuthor)
					.flatMap((vertex) => movesOf(JSON.parse(vertex.operation)));
			for (let n = 0; n < MAX_EPOCHS; n++) {
				if (n === WARM) armed = true;
				creatorEpoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(creatorEpoch);
				await rows.toWriter();
				ids.push(`block-1-${nextMove}`);
				await writer.issue(creatorEpoch, nextMove++);
				await rows.toCreator();
				if (writerAuthor === "") {
					const [firstOwn] = await writer.published(null);
					if (firstOwn !== undefined) writerAuthor = rowValue(firstOwn).author;
				}
				// What the creator admitted so far (its in-memory record does not survive the kill).
				admitted = await creatorMoves();
			}
			await wire.stop();
			throw Error(`CREATOR_RETIREMENT_EDGE_NOT_REACHED ${JSON.stringify({ edge, creatorEpoch })}`);
		} finally {
			unhook();
			restore();
		}
	},
	900_000
);

(INNER ? it.skip : it).each(EDGES)(
	"a creator SIGKILLed at commit %i of an active closed-retirement preparation resumes, keeps closing, and admits every member move once",
	async (edge) => {
		const directory = mkdtempSync(join(tmpdir(), "creator-retirement-crash-"));
		directories.push(directory);
		const child = spawn(
			"npx",
			["vitest", "run", fileURLToPath(import.meta.url), "--no-file-parallelism", "--coverage.enabled=false"],
			{
				env: {
					...process.env,
					RUN_CREATOR_RETIREMENT_CRASH: "1",
					CREATOR_RETIREMENT_CRASH_DIRECTORY: directory,
					CREATOR_RETIREMENT_CRASH_EDGE: String(edge),
				},
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const deathFile = join(directory, "death.json");
		if (!existsSync(deathFile)) throw new Error(`the creator did not die at edge ${edge}:\n${output.slice(-6000)}`);
		const death = JSON.parse(readFileSync(deathFile, "utf8")) as Death;
		process.stdout.write(`CREATOR_RETIREMENT_DEATH ${JSON.stringify(death)}\n`);
		expect(death.edge).toBe(edge);
		expect(death.writerAuthor).not.toBe("");

		const restore = await installEnvironment("node", () => undefined);
		try {
			const { creator, writer } = await openPair(directory, true);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: death.ordinal + 1_000 };
			const ids = [...death.ids];
			let nextMove = death.nextMove + 1_000;
			// What the creator admitted before the kill, from its DURABLE state (the reopened projection), read
			// before anything reaches it. The child's record (death.creatorAdmitted) is in memory and can be
			// stale: the creator admits received rows asynchronously, so a kill can land after an admission and
			// before the record (box m46: move 2 admitted durably, never in the record), and the reopened
			// creator's acceptedVertices only sees admissions after the reopen.
			const durable = await creatorBlocks(creator);
			expect(
				death.creatorAdmitted.filter((id) => !durable.includes(id)),
				"every admission the child recorded before the kill is in the reopened creator's durable state"
			).toEqual([]);
			const admittedBeforeKill = new Set(death.ids.filter((id) => durable.includes(id)));
			process.stdout.write(
				`CREATOR_RETIREMENT_REOPEN ${JSON.stringify({ edge, durableBeforeKill: [...admittedBeforeKill], recorded: death.creatorAdmitted })}\n`
			);
			const admitted = async () =>
				((await creator.acceptedVertices?.()) ?? [])
					.filter((vertex) => vertex.author === death.writerAuthor)
					.flatMap((vertex) => movesOf(JSON.parse(vertex.operation)));
			// A move admitted before the kill counts once from durable state and must not be admitted again;
			// every other move must be admitted after the reopen exactly once.
			const counts = async () => {
				const moves = await admitted();
				return ids.map((id) => (admittedBeforeKill.has(id) ? 1 : 0) + moves.filter((move) => move === id).length);
			};
			try {
				let epoch = (await creator.rollover?.())?.epoch ?? 0;
				const reopenedAt = epoch;
				// The room keeps closing after the reopen; the member follows and its new moves land.
				for (let round = 0; round < 3; round++) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await wire.caughtUp(epoch, 120_000);
					await rows.toWriter();
					ids.push(`block-1-${nextMove}`);
					await writer.issue(epoch, nextMove++);
					await rows.toCreator();
				}
				expect(epoch, "the reopened creator closes three more epochs").toBeGreaterThanOrEqual(reopenedAt + 3);
				await waitFor(
					"the creator admits every member move after its restart",
					async () => {
						epoch = await rollCreator(creator, rows.toWriter, ordinal);
						await wire.caughtUp(epoch, 120_000).catch(() => undefined);
						await rows.toWriter();
						await rows.toCreator();
						return { counts: await counts(), creator: epoch, member: await writer.authorityEpoch() };
					},
					(state) => state.counts.every((count) => count >= 1),
					300_000
				);
				expect(await counts(), "each member move admitted by the creator once").toEqual(ids.map(() => 1));
				// The durable outcome: every move is in the creator's state exactly once.
				const finalBlocks = await creatorBlocks(creator);
				expect(
					ids.map((id) => finalBlocks.filter((block) => block === id).length),
					"each member move in the creator's state exactly once"
				).toEqual(ids.map(() => 1));
				expect(await writer.state()).toBe(await creator.state());
			} finally {
				await wire.stop();
			}
		} finally {
			restore();
		}
	},
	1_500_000
);

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native probe inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
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

// fix/browser-rollover-member-stall, box m49/m52/m55 (creator-retirement-crash-native, any edge, ~1 run in 2):
// "creator retained recovery authenticated adoption failed" when the MEMBER reopens. Probes (m55, 5 of 5):
// the member had kept a received successor (its snapshot store retained the creator's close certificate,
// retention 'recovery') but its native head was still the predecessor, so its startup re-adopted it
// through selectRetainedCreatorSuccessorAdoption, and verifyCreatorSuccessorAdoption refused
// chain-invalid ("creator successor trust chain is invalid").
//
// This RED kills the whole process (both roles) deterministically right after the member's snapshot store
// COMMITs that retention (k-th retention after WARM epochs), reopens the same directory, and requires the
// member to open, the room to keep closing, the member to follow, every member move admitted by the
// creator exactly once (pre-kill admissions from the creator's durable state) and equal states. Nothing
// native is mocked.
const INNER = process.env.RUN_MEMBER_RETAINED_CRASH === "1";
// The k-th retention after the hook arms (each is one received successor, E -> E+1 with E >= WARM).
const RETENTIONS = [0, 1] as const;
// Epochs closed and followed before the hook arms: past the genesis transition, so the received successor
// retires a predecessor Cut/QC/ACL.
const WARM = 3;
// The child gives up (retention not reached) after this many epochs.
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
// The member's ("recipient", tests/fixtures/track-m-apps/long-room-core.ts) snapshot store
// (tests/fixtures/track-m-apps/app-long-room.ts sqliteFile: "<sha256([family, name])>.sqlite<suffix>").
const recipientSnapshots = `${createHash("sha256")
	.update(JSON.stringify(["snapshots", "recipient"]))
	.digest("hex")}.sqlite.drp-snapshot-quarantine-v1.sqlite`;
const isRecipientSnapshots = (location: string | null) =>
	location !== null && basename(location) === recipientSnapshots;
// packages/storage-node/src/snapshot-transfer.ts retainForRecovery: the member keeps a received successor.
const RETAIN = /UPDATE snapshot_scopes_v2 SET retention='recovery',received_certificate_bytes=\?/;

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
	retention: number;
	creatorEpoch: number;
	writerAuthor: string;
	ids: string[];
	nextMove: number;
	ordinal: number;
	creatorAdmitted: string[];
};

/**
 * Installs the commit hook: SIGKILL right after the member's snapshot store COMMITs the k-th received
 * successor retention while armed.
 * @param retention - k.
 * @param armed - Whether the hook may fire now.
 * @param kill - Called synchronously after the chosen COMMIT returned.
 * @returns The restore function.
 */
function installRetentionHook(retention: number, armed: () => boolean, kill: () => void) {
	const prepare = DatabaseSync.prototype.prepare,
		run = StatementSync.prototype.run,
		exec = DatabaseSync.prototype.exec;
	const statements = new WeakMap<StatementSync, { database: DatabaseSync; sql: string }>();
	const retaining = new WeakSet<DatabaseSync>();
	let count = -1;
	DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
		const statement = prepare.call(this, sql);
		statements.set(statement, { database: this, sql });
		return statement;
	} as typeof DatabaseSync.prototype.prepare;
	StatementSync.prototype.run = function (this: StatementSync, ...args: unknown[]) {
		const result = (run as (...values: unknown[]) => ReturnType<typeof run>).apply(this, args);
		const source = statements.get(this);
		if (source !== undefined && RETAIN.test(source.sql) && isRecipientSnapshots(locationOf(source.database)))
			retaining.add(source.database);
		return result;
	} as typeof StatementSync.prototype.run;
	DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
		const result = exec.call(this, sql);
		if (/ROLLBACK/i.test(sql)) retaining.delete(this);
		if (!(sql === "COMMIT" || sql.endsWith("COMMIT")) || !retaining.has(this)) return result;
		retaining.delete(this);
		if (!armed()) return result;
		count++;
		if (count === retention) kill();
		return result;
	} as typeof DatabaseSync.prototype.exec;
	return () => {
		DatabaseSync.prototype.prepare = prepare;
		StatementSync.prototype.run = run;
		DatabaseSync.prototype.exec = exec;
	};
}

it.runIf(INNER)(
	"the process dies right after the member retains a received successor",
	async () => {
		const directory = process.env.MEMBER_RETAINED_CRASH_DIRECTORY ?? "";
		const retention = Number(process.env.MEMBER_RETAINED_CRASH_RETENTION ?? "NaN");
		if (directory === "" || !Number.isSafeInteger(retention)) throw Error("MEMBER_RETAINED_CRASH_* is not set");
		const restore = await installEnvironment("node", () => undefined);
		const ids: string[] = [];
		const ordinal = { next: 0 };
		let nextMove = 0;
		let creatorEpoch = 0;
		let writerAuthor = "";
		let armed = false;
		let admitted: string[] = [];
		const unhook = installRetentionHook(
			retention,
			() => armed,
			() => {
				writeFileSync(
					join(directory, "death.json"),
					JSON.stringify({
						retention,
						creatorEpoch,
						writerAuthor,
						ids,
						nextMove,
						ordinal: ordinal.next,
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
				admitted = await creatorMoves();
			}
			await wire.stop();
			throw Error(`MEMBER_RETENTION_NOT_REACHED ${JSON.stringify({ retention, creatorEpoch })}`);
		} finally {
			unhook();
			restore();
		}
	},
	900_000
);

(INNER ? it.skip : it).each(RETENTIONS)(
	"a process SIGKILLed right after the member's retention %i of a received successor reopens, the member follows, and every member move is admitted once",
	async (retention) => {
		const directory = mkdtempSync(join(tmpdir(), "member-retained-crash-"));
		directories.push(directory);
		const child = spawn(
			"npx",
			["vitest", "run", fileURLToPath(import.meta.url), "--no-file-parallelism", "--coverage.enabled=false"],
			{
				env: {
					...process.env,
					RUN_MEMBER_RETAINED_CRASH: "1",
					MEMBER_RETAINED_CRASH_DIRECTORY: directory,
					MEMBER_RETAINED_CRASH_RETENTION: String(retention),
				},
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const deathFile = join(directory, "death.json");
		if (!existsSync(deathFile))
			throw new Error(`the process did not die at retention ${retention}:\n${output.slice(-6000)}`);
		const death = JSON.parse(readFileSync(deathFile, "utf8")) as Death;
		process.stdout.write(`MEMBER_RETAINED_DEATH ${JSON.stringify(death)}\n`);
		expect(death.retention).toBe(retention);
		expect(death.writerAuthor).not.toBe("");

		const restore = await installEnvironment("node", () => undefined);
		try {
			const { creator, writer } = await openPair(directory, true);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: death.ordinal + 1_000 };
			const ids = [...death.ids];
			let nextMove = death.nextMove + 1_000;
			const durable = await creatorBlocks(creator);
			expect(
				death.creatorAdmitted.filter((id) => !durable.includes(id)),
				"every admission the child recorded before the kill is in the reopened creator's durable state"
			).toEqual([]);
			const admittedBeforeKill = new Set(death.ids.filter((id) => durable.includes(id)));
			const admitted = async () =>
				((await creator.acceptedVertices?.()) ?? [])
					.filter((vertex) => vertex.author === death.writerAuthor)
					.flatMap((vertex) => movesOf(JSON.parse(vertex.operation)));
			const counts = async () => {
				const moves = await admitted();
				return ids.map((id) => (admittedBeforeKill.has(id) ? 1 : 0) + moves.filter((move) => move === id).length);
			};
			try {
				let epoch = (await creator.rollover?.())?.epoch ?? 0;
				const reopenedAt = epoch;
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
					"the creator admits every member move after the reopen",
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

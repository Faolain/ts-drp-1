/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { observeCanonicalCalls } from "@ts-drp/canonical/instrumentation";
import { observeEd25519Verifications } from "@ts-drp/protocol-v3/instrumentation";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { callSite, installSqliteCountSeams } from "./fixtures/perf-counts/counts.js";
import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole, type RoleEnvironment } from "./fixtures/track-m-apps/long-room-core.js";
import {
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { observeEd25519Verifications } from "@ts-drp/protocol-v3/instrumentation";
import { readV3SettlementWorkCounts } from "../packages/node/src/v3-live.js";
import { readV3RoomStageTimes, V3_ROOM_LOCAL_BACKLOG_LIMIT } from "../packages/node/src/v3-room.js";
import {
	nodeIssuanceReadCounts,
	nodeRecoveryCensusCounts,
} from "../packages/storage-node/src/internal/node-issuance-store.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Found by fix/int7-slow-member-landing (tests/app-rollover-slow-member-native.test.ts under host
// load 120-180: the member's room closed at epoch 29 with "creator snapshot role reconciliation
// refused: chain-invalid ... RECOVERY_DEPENDENCY_ANCHOR_UNCOVERED:12", journal protected scopes
// [12,13,14,17,22,26]).
//
// A Writer's moves that never reach the creator are replaced on each one-epoch install (a chain of
// rows E -> E+1 -> E+2), and then the Writer skip-installs: the chain's newest rows are retained and
// resolved from the creator's frontier (never admitted: given back). The chain's older rows (plan
// entries "rebase" whose replacement is now resolved) must not keep their journal scopes protected
// for good: once such a scope is older than the retirement's recovery trusts (current - 4) the
// Writer's next install refuses and its room closes.

const track = {
	rooms: new Set<{ close(): Promise<void> }>(),
	heads: new Set<{ close(): Promise<void> }>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
};
const directories: string[] = [];

// Reported, not asserted: Ed25519 checks made by scanOwnFences' own-fence row authentication over a
// window, split into computed and answered by the exact-byte memo (attributed by stack).
const ownFenceVerifies = { computed: 0, memo: 0 };
observeEd25519Verifications((outcome) => {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 80;
	const stack = new Error().stack ?? "";
	Error.stackTraceLimit = limit;
	if (stack.includes("authenticateOwnFenceRow")) ownFenceVerifies[outcome === "computed" ? "computed" : "memo"] += 1;
});
const ownFenceVerifiesSince = (before: { computed: number; memo: number }) => ({
	computed: ownFenceVerifies.computed - before.computed,
	memo: ownFenceVerifies.memo - before.memo,
});
afterEach(async () => {
	await Promise.allSettled([...track.rooms].map((room) => room.close()));
	await Promise.allSettled([...track.heads].map((head) => head.close()));
	await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.rooms.clear();
	track.heads.clear();
	track.ports.clear();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type RowValue = { epoch: number; author: string; authorSequence: number; operation: Record<string, unknown> };
const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as RowValue;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idOf = (operation: string): string | undefined => {
	const value = JSON.parse(operation) as Record<string, unknown> | null;
	return typeof value?.id === "string" ? value.id : undefined;
};

type MemberHooks = Pick<RoleEnvironment, "deliveryRoom"> & Readonly<{ relay?(request: string, forward: () => Promise<string[]>): Promise<string[]> }>;

async function openPair(
	directory: string,
	member: MemberHooks = {},
	rolloverBudget?: Readonly<{ movesPerAuthor: number; idleMs: number }>
) {
	const options = {
		app: "grid" as const,
		host: "node" as const,
		recipient: "writer" as const,
		creatorLull: false,
		epochs: 1,
		moves: 1,
		chatFormat: "shares" as const,
		rollover: "app" as const,
		...(rolloverBudget === undefined ? {} : { rolloverBudget }),
	};
	const env = {
		host: nodeHostFor("node", directory),
		unique: directory,
		track,
		openFloor: (role: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${role}-external-floor.sqlite`),
				initialization: { kind: "create" as const },
			}),
	};
	const creator = await openRole(options, 0, env);
	const writer = await openRole(options, 1, {
		...env,
		...(member.deliveryRoom === undefined ? {} : { deliveryRoom: member.deliveryRoom }),
		relay: (request) =>
			member.relay === undefined ? creator.dispatch(request) : member.relay(request, () => creator.dispatch(request)),
	});
	return { creator, writer };
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
	return {
		toWriter: () => carry(creator, writer, "creator"),
		toCreator: () => carry(writer, creator, "writer"),
	};
}

// The creator's moves place Grid blocks from a fixed set of CREATOR_BLOCK_IDS ids (x carries the
// ordinal, so every move is a distinct operation). Grid keeps one block per id and its state is
// bounded (32 KiB canonical, about 850 blocks): a creator placing a new id per move would reach that
// bound in a long run (about 850 moves) and fail as "outside the bounded canonical domain" instead of
// on what the test measures.
const CREATOR_BLOCK_IDS = 64;
function creatorMove(creator: RoleEndpoint, ordinal: { next: number }) {
	const k = ordinal.next++;
	return creator.issue(k, k % CREATOR_BLOCK_IDS);
}

/** Creator moves (with the creator's rows carried to the Writer) until its policy rolls the epoch. */
async function rollCreator(creator: RoleEndpoint, carry: () => Promise<void>, ordinal: { next: number }) {
	const before = (await creator.rollover?.())?.epoch ?? 0;
	for (;;) {
		await creatorMove(creator, ordinal);
		await carry();
		const epoch = (await creator.rollover?.())?.epoch ?? 0;
		if (epoch > before) return epoch;
	}
}

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`${label}: timed out at ${JSON.stringify(value).slice(0, 2000)}`);
		await sleep(100);
	}
}

/** Accepted vertices of `author` carrying each move id, on one replica. */
async function acceptedCounts(role: RoleEndpoint, author: string, ids: readonly string[]) {
	const vertices = (await role.acceptedVertices?.()) ?? [];
	return ids.map((id) => vertices.filter((vertex) => vertex.author === author && idOf(vertex.operation) === id).length);
}


async function rebaseChainThenSkip(chainInstalls: number, followEpochs: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-rebase-chain-skip-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		const ids: string[] = [];
		let n = 0;
		let epoch = 0;
		const observe = async (label: string) =>
			process.stdout.write(
				`REBASE_CHAIN ${JSON.stringify({ label, epoch, member: await writer.authorityEpoch(), settlement: await writer.settlementStatus?.().then((value) => { const status = value as { unsettledEpochs?: number; undelivered?: unknown[] } | null; return { unsettled: status?.unsettledEpochs, undelivered: status?.undelivered?.length }; }), plan: (await writer.settlementAudit()).dispositions, delivery: await writer.successorDelivery?.() })}\n`
			);
		try {
			// Connected for two epochs: rows both ways.
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await writer.issue(epoch, n);
				ids.push(`block-1-${n++}`);
				await rows.toCreator();
			}
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			// Two moves the creator never receives (the Writer's rows are not carried) ...
			for (let k = 0; k < 2; k++) {
				await writer.issue(epoch, n);
				ids.push(`block-1-${n++}`);
			}
			// ... replaced on each of `chainInstalls` one-epoch installs (still never carried) ...
			for (let install = 0; install < chainInstalls; install++) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await observe(`chain-${install}`);
			}
			// ... and then the Writer skip-installs past three creator epochs.
			await wire.pause();
			for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
			wire.resume();
			await wire.caughtUp(epoch);
			await rows.toWriter();
			await observe("skip");
			// Connected again from here: the Writer follows the creator epoch by epoch, past the
			// retirement's recovery depth, and every move lands on the creator once.
			for (let follow = 0; follow < followEpochs; follow++) {
				await rows.toCreator();
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 120_000);
				await rows.toWriter();
				await rows.toCreator();
				await observe(`follow-${follow}`);
			}
			await waitFor(
				"the creator admits every move of the Writer",
				async () => {
					await rows.toCreator();
					const counts = await acceptedCounts(creator, writerAuthor, ids);
					if (counts.some((count) => count === 0)) {
						epoch = await rollCreator(creator, rows.toWriter, ordinal);
						await wire.caughtUp(epoch, 120_000);
						await rows.toWriter();
					}
					return { counts, plan: (await writer.settlementAudit()).dispositions };
				},
				(value) => value.counts.every((count) => count >= 1),
				300_000
			);
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 120_000);
			await rows.toWriter();
			await rows.toCreator();
			expect(await acceptedCounts(creator, writerAuthor, ids)).toEqual(ids.map(() => 1));
			const delivery = (await writer.successorDelivery?.()) as { refusals?: readonly string[] } | undefined;
			expect(delivery?.refusals ?? [], "the Writer's install refusals").toEqual([]);
		} finally {
			process.stdout.write(
				`REBASE_CHAIN_SUMMARY ${JSON.stringify({ epoch, ids, plan: await writer.settlementAudit(), delivery: await writer.successorDelivery?.(), status: await writer.rolloverStatus?.() })}\n`
			);
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it(
	"moves replaced on two one-epoch installs and then retained by a skip install land once, and the Writer keeps following",
	() => rebaseChainThenSkip(2, 8),
	900_000
);

// A Writer whose rows never reach the creator (silent) keeps following through a pattern of one-epoch
// installs (its moves replaced: chains of rows) and skip installs (the chains' newest rows retained and
// resolved from the frontier) for well past the retirement's recovery depth. Its room must keep
// installing (no refusal, never closed); once its rows are carried again every move lands once.
// Measured failing under host load (paced-01): "creator snapshot role reconciliation refused:
// chain-invalid ... RECOVERY_DEPENDENCY_ANCHOR_UNCOVERED:12" at epoch 29, protected [12,13,14,17,22,26].
async function silentChainsAndSkips(cycles: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-silent-chain-skip-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		const ids: string[] = [];
		let n = 0;
		let epoch = 0;
		const observe = async (label: string) =>
			process.stdout.write(
				`SILENT_CHAIN ${JSON.stringify({ label, epoch, member: await writer.authorityEpoch(), plan: (await writer.settlementAudit()).dispositions, status: await writer.rolloverStatus?.().then((value) => { const status = value as { state?: string; kept?: unknown[]; unsettledEpochs?: number } | null; return [status?.state, status?.kept?.length, status?.unsettledEpochs]; }), delivery: await writer.successorDelivery?.().then((value) => { const delivery = value as { installed?: number; refused?: number; refusals?: string[] } | undefined; return [delivery?.installed, delivery?.refused, delivery?.refusals?.slice(0, 2)]; }) })}\n`
			);
		const move = async () => {
			try {
				await writer.issue(epoch, n);
			} catch (error) {
				process.stdout.write(`SILENT_CHAIN_ISSUE ${JSON.stringify({ n, error: String(error).slice(0, 300) })}\n`);
			}
			ids.push(`block-1-${n++}`);
		};
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await writer.issue(epoch, n);
				ids.push(`block-1-${n++}`);
				await rows.toCreator();
			}
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			for (let cycle = 0; cycle < cycles; cycle++) {
				// Two one-epoch installs with a move each (never carried): chains of replaced rows.
				for (let install = 0; install < 2; install++) {
					await move();
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await wire.caughtUp(epoch, 120_000);
					await rows.toWriter();
				}
				// A move, then a skip install past three creator epochs.
				await move();
				await wire.pause();
				for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
				wire.resume();
				await wire.caughtUp(epoch, 120_000);
				await rows.toWriter();
				await observe(`cycle-${cycle}`);
			}
			// Carried again: every move lands once.
			await waitFor(
				"the creator admits every move of the Writer",
				async () => {
					await rows.toCreator();
					const counts = await acceptedCounts(creator, writerAuthor, ids);
					if (counts.some((count) => count === 0)) {
						epoch = await rollCreator(creator, rows.toWriter, ordinal);
						await wire.caughtUp(epoch, 120_000);
						await rows.toWriter();
						await observe("landing");
					}
					return { counts, plan: (await writer.settlementAudit()).dispositions };
				},
				(value) => value.counts.every((count) => count >= 1),
				600_000
			);
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 120_000);
			await rows.toWriter();
			await rows.toCreator();
			expect(await acceptedCounts(creator, writerAuthor, ids)).toEqual(ids.map(() => 1));
			const delivery = (await writer.successorDelivery?.()) as { refusals?: readonly string[] } | undefined;
			expect(delivery?.refusals ?? [], "the Writer's install refusals").toEqual([]);
		} finally {
			process.stdout.write(
				`SILENT_CHAIN_SUMMARY ${JSON.stringify({ epoch, ids, plan: await writer.settlementAudit(), delivery: await writer.successorDelivery?.(), status: await writer.rolloverStatus?.() })}\n`
			);
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it(
	"a silent Writer that follows through replaced-row chains and skip installs past the recovery depth keeps installing, and its moves land once",
	() => silentChainsAndSkips(6),
	1_800_000
);

// A skip install resolving N retained rows from the creator's frontier (each never admitted: its
// move is given back). Measured before the fix on a quiet 8-vCPU host (cost-02, int7 2d825dec):
// 8 rows 1.4 s, 16 rows 4.7 s, 32 rows 17.8 s -- quadratic. Each row ran its own charged native
// dependency turn (withActiveRebaseDependencies: about six complete recovery census reads, each
// costing time in proportion to the author's whole settlement state), its own retained contract
// preparations and its own plan write, so the work per row grew with the number of rows. The
// assertions count native work (host independent); the wall clock is printed for the record.
async function retainedResolutionCost(count: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-retained-cost-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
			}
			for (let k = 0; k < count; k++) await writer.issue(epoch, k);
			await wire.pause();
			for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
			const before = readV3SettlementWorkCounts();
			const censusBefore = nodeRecoveryCensusCounts();
			const issuanceReads = () =>
				Object.values(nodeIssuanceReadCounts()).reduce(
					(sum, row) => ({ reads: sum.reads + row.reads, full: sum.full + row.fullReads }),
					{ reads: 0, full: 0 }
				);
			const issuanceBefore = issuanceReads();
			const byKindBefore = nodeIssuanceReadCounts();
			const started = performance.now();
			// Process CPU over the install (user + system), the cost that matters on a device.
			const cpuBefore = process.cpuUsage();
			wire.resume();
			await wire.caughtUp(epoch, 1_200_000);
			const ms = performance.now() - started;
			const cpu = process.cpuUsage(cpuBefore);
			const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
			const after = readV3SettlementWorkCounts();
			const censusAfter = nodeRecoveryCensusCounts();
			const issuanceAfter = issuanceReads();
			const byKindAfter = nodeIssuanceReadCounts();
			const work = {
				dependencyTurns: after.dependencyTurns - before.dependencyTurns,
				// Complete census reads by the turns' own holds (the seal and each full check).
				dependencyTurnCensusReads: after.dependencyTurnCensusReads - before.dependencyTurnCensusReads,
				recoveryCensusReads: after.recoveryCensusReads - before.recoveryCensusReads,
				// Native census reads by both roles' stores, and those that read and classified every row.
				nativeCensusReads: censusAfter.reads - censusBefore.reads,
				fullCensusReads: censusAfter.fullReads - censusBefore.fullReads,
				// Issuance store reads (outbox pages, issued closures, plans, lineages) by both roles' stores.
				issuanceReads: issuanceAfter.reads - issuanceBefore.reads,
				fullIssuanceReads: issuanceAfter.full - issuanceBefore.full,
				issuanceByKind: Object.fromEntries(
					Object.entries(byKindAfter).map(([kind, row]) => [
						kind,
						[
							row.reads - byKindBefore[kind as keyof typeof byKindBefore].reads,
							row.fullReads - byKindBefore[kind as keyof typeof byKindBefore].fullReads,
						],
					])
				),
				retainedContractPreparations: after.retainedContractPreparations - before.retainedContractPreparations,
				sourceExpirySignatures: after.sourceExpirySignatures - before.sourceExpirySignatures,
			};
			const status = (await writer.settlementStatus?.()) as { undelivered?: unknown[] } | null;
			// The next one-epoch install, with the resolved rows still unretired: what each of its census
			// reads costs in own-fence outbox scans.
			const nextBefore = readV3SettlementWorkCounts();
			const nextVerifiesBefore = { ...ownFenceVerifies };
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 1_200_000);
			const nextAfter = readV3SettlementWorkCounts();
			const next = {
				recoveryCensusReads: nextAfter.recoveryCensusReads - nextBefore.recoveryCensusReads,
				ownFenceScans: nextAfter.ownFenceScans - nextBefore.ownFenceScans,
				// Reported, not asserted: own fence rows authenticated (one memoised Ed25519 check each).
				ownFenceAuthentications: nextAfter.ownFenceAuthentications - nextBefore.ownFenceAuthentications,
				ownFenceVerifies: ownFenceVerifiesSince(nextVerifiesBefore),
			};
			const result = { count, installMs: Math.round(ms), cpuMs, perRowMs: Math.round(ms / count), givenBack: status?.undelivered?.length, work, next };
			process.stdout.write(`RETAINED_COST ${JSON.stringify(result)}\n`);
			return result;
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it("a skip install resolving retained rows pays the native settlement turn once per drain, not once per row", async () => {
	const small = await retainedResolutionCost(8);
	const large = await retainedResolutionCost(32);
	// Every retained row is resolved: signed once, its move given back once.
	expect([small.givenBack, large.givenBack]).toEqual([8, 32]);
	expect([small.work.sourceExpirySignatures, large.work.sourceExpirySignatures]).toEqual([8, 32]);
	// The charged dependency turn and the retained contract preparation do not repeat per row.
	expect(large.work.dependencyTurns, "dependency turns, 32 rows vs 8").toBeLessThanOrEqual(small.work.dependencyTurns + 2);
	expect(large.work.retainedContractPreparations, "retained contract preparations, 32 rows vs 8").toBeLessThanOrEqual(
		small.work.retainedContractPreparations + 2
	);
	// Each further row adds at most its own signature's currency checks (two census reads around the
	// signing), not another turn's.
	expect(large.work.recoveryCensusReads - small.work.recoveryCensusReads, "census reads per further row").toBeLessThanOrEqual(
		(32 - 8) * 2.5
	);
	// Those currency checks read a database the settlement turn's reservation holds unchanged: proven by
	// the connection's revision, they read and encode no row, so the census reads that read every row
	// do not grow with the number of rows (they grew by two per row, each costing time in proportion to
	// the author's whole settlement state: O(rows x state) per install).
	expect(large.work.fullCensusReads, "full census reads, 32 rows vs 8").toBeLessThanOrEqual(
		small.work.fullCensusReads + 2
	);
	// One dependency turn reads its census completely twice: the seal, and the first check after the
	// hold owns the turn's issuance reservation. Every later check of the turn (the turn's own two,
	// and the two around its signing) reuses that held read: the reservation excludes every issuance
	// writer for the whole turn, and each reuse still checks the native current probe, the replay
	// and the bound context (six complete reads per turn before).
	expect(
		[small.work.dependencyTurnCensusReads, large.work.dependencyTurnCensusReads],
		"complete census reads per dependency turn"
	).toEqual([2 * small.work.dependencyTurns, 2 * large.work.dependencyTurns]);
	// The same holds for the issuance reads the turn's dependency checks repeat (outbox pages, plans,
	// lineages, issued closures already read): under the reservation they read no row again, so each
	// further row adds only its own reads (about 12 full reads per row; 23 when every re-read read
	// every row).
	expect(
		large.work.fullIssuanceReads - small.work.fullIssuanceReads,
		"full issuance reads per further row"
	).toBeLessThanOrEqual((32 - 8) * 16);
	// Wall clock, generous: per-row time does not grow with the number of rows, and 32 rows resolve
	// well inside the quiet-host time they took before (15.7-17.8 s; 1.1 s after the fix under host
	// load ~30).
	expect(large.perRowMs, "per-row time, 32 rows vs 8").toBeLessThanOrEqual(small.perRowMs * 1.5);
	expect(large.installMs, "32-row skip install").toBeLessThanOrEqual(8_000);
}, 1_500_000);

// A move given back is no longer waiting in the room: the application holds it. Its expired row
// only waits for retirement, so it must not count as unsettled. Counting it kept the member in
// "not-reaching-host" (unsettledEpochs >= window - 2) for epochs after every move had been given
// back, and in that state the application does not offer the given-back moves again
// (tests/app-rollover-slow-member-native.test.ts: 45 given-back moves never re-offered).
async function givenBackMovesAreNotWaiting(count: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-given-back-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		const ids: string[] = [];
		let epoch = 0;
		let n = 0;
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await writer.issue(epoch, n);
				ids.push(`block-1-${n++}`);
				await rows.toCreator();
			}
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			// Moves the creator never receives, then a skip install past three creator epochs: the
			// retained rows are resolved from the frontier (never admitted) and every move is given back.
			for (let k = 0; k < count; k++) {
				await writer.issue(epoch, n);
				ids.push(`block-1-${n++}`);
			}
			await wire.pause();
			for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
			wire.resume();
			await wire.caughtUp(epoch);
			const settlement = (await writer.settlementStatus?.()) as { unsettledEpochs: number; undelivered: unknown[] } | null;
			const status = (await writer.rolloverStatus?.()) as { state: string } | null;
			process.stdout.write(`GIVEN_BACK ${JSON.stringify({ epoch, settlement: { unsettledEpochs: settlement?.unsettledEpochs, undelivered: settlement?.undelivered.length }, status, plan: (await writer.settlementAudit()).dispositions })}\n`);
			expect(settlement?.undelivered.length, "moves given back").toBe(count);
			expect(settlement?.unsettledEpochs, "epochs any own move still waits").toBe(0);
			expect(status?.state, "the member's rollover state").not.toBe("not-reaching-host");
			// Connected again: the application offers the given-back moves again and each lands once.
			for (let follow = 0; follow < 8; follow++) {
				await rows.toWriter();
				await rows.toCreator();
				const counts = await acceptedCounts(creator, writerAuthor, ids);
				if (counts.every((value) => value >= 1)) break;
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 120_000);
			}
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 120_000);
			await rows.toWriter();
			await rows.toCreator();
			expect(await acceptedCounts(creator, writerAuthor, ids)).toEqual(ids.map(() => 1));
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it("moves given back by a skip install do not count as waiting, and land once when offered again", () => givenBackMovesAreNotWaiting(4), 900_000);

/** CPU profile (the format of node --cpu-prof) of `run`, written when CATCH_UP_PROFILE_DIR is set. */
async function profiled<T>(name: string, run: () => Promise<T>): Promise<T> {
	const dir = process.env.CATCH_UP_PROFILE_DIR;
	if (dir === undefined || dir === "") return run();
	const session = new Session();
	session.connect();
	await session.post("Profiler.enable");
	await session.post("Profiler.setSamplingInterval", { interval: 1000 });
	await session.post("Profiler.start");
	try {
		return await run();
	} finally {
		const { profile } = await session.post("Profiler.stop");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.cpuprofile`), JSON.stringify(profile));
		session.disconnect();
	}
}

// Catch-up: a member falls `moves` moves and `epochs` creator epochs behind (its rows never reach
// the creator; it follows by skip installs over two closed epochs each), then is connected again
// while the creator keeps moving every 300 ms and rolls at its own policy's rate. Every move must
// land on the creator exactly once; the time from reconnecting to the last move landing is the
// catch-up time (printed with the native work counts of that phase).
//
// Two failures, each named: "catch-up stalled" (no move landed for CATCH_UP_STALL_MS) and "catch-up
// too slow" (not every move landed within the time budget, CATCH_UP_S_PER_MOVE seconds per move).
// The budget is 12 s per move: about 1.5x the slowest passing 100x16 run on the boat boxes (633-800 s
// for 102 moves, 6.2-7.8 s per move; 50x8 passed at 4.3-9.0 s per move). 100x16 gets 1,224 s, 50x8
// 624 s, 25x4 324 s. It trips before any other bound: the creator's state stays far below Grid's
// 32 KiB (CREATOR_BLOCK_IDS), and budget plus the behind phase and the final exactly-once check stay
// inside the test's 1 h timeout. The real-time bar is far tighter than this; the budget names a slow
// catch-up as slow rather than measuring it (the CATCH_UP line does that).
const CATCH_UP_STALL_MS = Number(process.env.CATCH_UP_STALL_MS ?? 300_000);
const CATCH_UP_S_PER_MOVE = Number(process.env.CATCH_UP_S_PER_MOVE ?? 12);
async function catchUp(moves: number, epochs: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-catch-up-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		const ids: string[] = [];
		const refusedAtIssue: string[] = [];
		let epoch = 0;
		let n = 0;
		const issue = async () => {
			const id = `block-1-${n}`;
			try {
				await writer.issue((await writer.authorityEpoch()) ?? 0, n++);
			} catch (error) {
				refusedAtIssue.push(`${id}: ${String(error).slice(0, 160)}`);
			}
			ids.push(id);
		};
		// Diagnostic (CATCH_UP_DUMP_DIR): the member's plan, all its rows [sequence, epoch, action] and the
		// creator's admitted rows of the member.
		const dumpPlan = async (label: string) => {
			const dumpDir = process.env.CATCH_UP_DUMP_DIR;
			if (dumpDir === undefined || dumpDir === "") return;
			const action = (operation: unknown) => {
				const value = (typeof operation === "string" ? JSON.parse(operation) : operation) as Record<string, unknown> | null;
				return typeof value?.action === "string" ? value.action : "?";
			};
			const published: [number, number, string][] = [];
			for (let after: number | null = null; ; ) {
				const page = await writer.published(after);
				if (page.length === 0) break;
				for (const row of page) {
					const value = rowValue(row);
					published.push([value.authorSequence, value.epoch, action(value.operation)]);
				}
				after = page.at(-1)!.authorSequence;
			}
			const author = rowValue((await writer.published(null))[0]!).author;
			mkdirSync(dumpDir, { recursive: true });
			writeFileSync(join(dumpDir, `plan-${moves}x${epochs}-${label}.json`), JSON.stringify({
				label, creator: (await creator.rollover?.())?.epoch, member: await writer.authorityEpoch(),
				plan: await writer.settlementPlanDump?.(), published,
				creatorAccepted: ((await creator.acceptedVertices?.()) ?? []).filter((vertex) => vertex.author === author)
					.map((vertex) => [vertex.authorSequence, vertex.epoch, action(vertex.operation)]) }));
		};
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await issue();
				await rows.toCreator();
			}
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			// Behind: the member's rows never reach the creator; every two creator epochs it skip-installs.
			const steps = Math.max(1, Math.floor(epochs / 2));
			for (let step = 0; step < steps; step++) {
				const quota = Math.round(((step + 1) * moves) / steps) - Math.round((step * moves) / steps);
				for (let k = 0; k < quota; k++) await issue();
				await dumpPlan(`behind-${step}`);
				await wire.pause();
				for (let roll = 0; roll < 2; roll++) epoch = await rollCreator(creator, rows.toWriter, ordinal);
				wire.resume();
				if (step < steps - 1) await wire.caughtUp(epoch, 600_000);
			}
			const behind = { creator: epoch, member: (await writer.authorityEpoch()) ?? 0 };
			// Connected again: the creator keeps moving; the member's rows are carried both ways.
			const before = readV3SettlementWorkCounts();
			const started = performance.now();
			const budgetS = CATCH_UP_S_PER_MOVE * ids.length;
			let landedAt = started;
			let landed = 0;
			let counts: number[] = [];
			// The member's epoch over the catch-up: when each install landed and how far behind it was.
			const memberEpochs: { at: number; member: number; creator: number }[] = [];
			let traceLast = "";
			const describe = async () => {
				const status = (await writer.rolloverStatus?.()) as Record<string, unknown> | undefined;
				const settlement = (await writer.settlementStatus?.()) as { unsettledEpochs?: number; undelivered?: unknown[] } | null;
				return JSON.stringify({ creator: (await creator.rollover?.())?.epoch, member: await writer.authorityEpoch(),
					settlement: [settlement?.unsettledEpochs, settlement?.undelivered?.length],
					state: status?.state, kept: Array.isArray(status?.kept) ? status.kept.length : undefined,
					delivery: await writer.successorDelivery?.(), memberEpochs: memberEpochs.slice(-12),
					creatorErrors: ((await creator.rollover?.())?.errors ?? []).slice(-3).map((error) => String(error).slice(0, 300)),
					memberErrors: ((await writer.rollover?.())?.errors ?? []).slice(-3).map((error) => String(error).slice(0, 300)) });
			};
			await profiled(`catch-up-${moves}-${epochs}`, async () => {
				for (;;) {
					await rows.toWriter();
					await rows.toCreator();
					counts = await acceptedCounts(creator, writerAuthor, ids);
					const memberEpoch = (await writer.authorityEpoch()) ?? 0;
					if (memberEpoch !== memberEpochs.at(-1)?.member) {
						memberEpochs.push({ at: Math.round(performance.now() - started), member: memberEpoch,
							creator: (await creator.rollover?.())?.epoch ?? 0 });
						await dumpPlan(`m${memberEpoch}`);
					}
					const now = counts.filter((count) => count >= 1).length;
					// CATCH_UP_TRACE=1: the member's policy gate each step (state, kept, unsettled epochs, the
					// settlement window, given-back records) beside the epochs and moves landed.
					if (process.env.CATCH_UP_TRACE === "1") {
						const status = (await writer.rolloverStatus?.()) as
							| { state?: string; kept?: unknown[]; unsettledEpochs?: number; window?: number }
							| undefined;
						const settlement = (await writer.settlementStatus?.()) as
							| { unsettledEpochs?: number; undelivered?: unknown[]; deferred?: number }
							| null;
						const line = JSON.stringify({
							at: Math.round(performance.now() - started),
							creator: (await creator.rollover?.())?.epoch,
							member: await writer.authorityEpoch(),
							landed: now,
							state: status?.state,
							kept: status?.kept?.length,
							unsettled: settlement?.unsettledEpochs,
							window: status?.window,
							undelivered: settlement?.undelivered?.length,
							deferred: settlement?.deferred,
							memberErrors: ((await writer.rollover?.())?.errors ?? []).length,
						});
						if (line.replace(/"at":\d+,/u, "") !== traceLast) process.stdout.write(`CATCH_UP_TRACE ${line}\n`);
						traceLast = line.replace(/"at":\d+,/u, "");
					}
					if (now > landed) {
						landed = now;
						landedAt = performance.now();
					}
					if (now === ids.length) return;
					if (performance.now() - landedAt > CATCH_UP_STALL_MS)
						throw new Error(`catch-up stalled: ${now}/${ids.length} landed, ${(await describe()).slice(0, 6000)}`);
					const elapsed = (performance.now() - started) / 1000;
					if (elapsed > budgetS)
						throw new Error(
							`catch-up too slow: ${now}/${ids.length} landed after ${Math.round(elapsed)} s ` +
								`(${now === 0 ? "no move landed" : `${(elapsed / now).toFixed(1)} s per landed move`}; ` +
								`budget ${budgetS} s = ${CATCH_UP_S_PER_MOVE} s x ${ids.length} moves), ${(await describe()).slice(0, 6000)}`
						);
					await creatorMove(creator, ordinal);
					await sleep(300);
				}
			});
			const ms = performance.now() - started;
			const after = readV3SettlementWorkCounts();
			const caughtUpAt = { creator: (await creator.rollover?.())?.epoch ?? 0, member: (await writer.authorityEpoch()) ?? 0 };
			const result = {
				moves: ids.length,
				epochsBehind: behind.creator - 2,
				behind,
				caughtUpAt,
				catchUpMs: Math.round(ms),
				creatorEpochsDuringCatchUp: caughtUpAt.creator - behind.creator,
				msPerMove: Math.round(ms / ids.length),
				refusedAtIssue: refusedAtIssue.length,
				memberInstalls: memberEpochs.length,
				memberEpochs: memberEpochs.slice(0, 40),
				work: {
					dependencyTurns: after.dependencyTurns - before.dependencyTurns,
					recoveryCensusReads: after.recoveryCensusReads - before.recoveryCensusReads,
					retainedContractPreparations: after.retainedContractPreparations - before.retainedContractPreparations,
					sourceExpirySignatures: after.sourceExpirySignatures - before.sourceExpirySignatures,
				},
			};
			process.stdout.write(`CATCH_UP ${JSON.stringify(result)}\n`);
			// Exactly once, after one more epoch carried both ways; the member is at the creator's epoch.
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 300_000);
			await rows.toWriter();
			await rows.toCreator();
			expect(await acceptedCounts(creator, writerAuthor, ids)).toEqual(ids.map(() => 1));
			return result;
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

const CATCH_UP_CASES = (process.env.CATCH_UP_CASES ?? "25x4,50x8,100x16").split(",").map((value) => value.split("x").map(Number) as [number, number]);
for (const [moves, epochs] of CATCH_UP_CASES)
	it(`catch-up: a member ${moves} moves and ${epochs} epochs behind lands every move once while the creator keeps rolling`, () => catchUp(moves, epochs), 3_600_000);

// A move that waited the settlement window through one-epoch installs is expired and given back;
// its rows (the original and each replacement) stay in the outbox until retirement. Every complete
// recovery census classifies each such row as settled (ownSourceSettlementIsComplete), and that
// check scanned the author's whole outbox for its own fences once per row: a census cost the number
// of expired rows times the outbox, and the member runs several census reads per row it settles.
async function windowExpiredCensusCost(count: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-window-expired-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
			}
			for (let k = 0; k < count; k++) await writer.issue(epoch, k);
			// One-epoch installs past the window: the moves are replaced, then expired and given back.
			for (let roll = 0; roll < 6; roll++) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 600_000);
				await rows.toWriter();
			}
			const before = readV3SettlementWorkCounts();
			const verifiesBefore = { ...ownFenceVerifies };
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 600_000);
			const after = readV3SettlementWorkCounts();
			const status = (await writer.settlementStatus?.()) as { undelivered?: unknown[] } | null;
			const result = {
				count,
				givenBack: status?.undelivered?.length,
				plan: (await writer.settlementAudit()).dispositions,
				recoveryCensusReads: after.recoveryCensusReads - before.recoveryCensusReads,
				ownFenceScans: after.ownFenceScans - before.ownFenceScans,
				ownFenceAuthentications: after.ownFenceAuthentications - before.ownFenceAuthentications,
				ownFenceVerifies: ownFenceVerifiesSince(verifiesBefore),
			};
			process.stdout.write(`WINDOW_EXPIRED_COST ${JSON.stringify(result)}\n`);
			return result;
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it("a census does not rescan the author's outbox for each expired row", async () => {
	const result = await windowExpiredCensusCost(16);
	expect((result.plan as Record<string, number>).expire ?? 0, "rows expired by the window").toBeGreaterThanOrEqual(16);
	// One own-fence scan answers every row of one census read.
	expect(result.ownFenceScans, "own-fence scans per census read").toBeLessThanOrEqual(result.recoveryCensusReads + 8);
}, 900_000);

// The undelivered-move bound must hold at the install that settles them. A Writer's moves of its
// current epoch are undelivered until an install says otherwise, but the room counted them only from
// that install on, so an offline Writer accepted any number of moves in one epoch. Its next skip
// install proves every retained row never admitted and gives its move back, one hand-back record
// each, but records are bounded (SETTLEMENT_HAND_BACK_LIMITS.maxRecords): the rows past the bound
// stay manual-review (unknown retained work), which withholds the author fence, so the Writer's next
// epoch has no fence and its rows there can never be proven either. Measured in the 100-move,
// 16-epoch catch-up: 64 records, 11 rows of epoch 12 left manual-review, no fence at epochs 14 and
// 16, one more protected journal scope per epoch until the retirement preparation refused the
// eighth ("journal retirement refused: malformed-input") or the recovery certificate no longer
// covered the oldest (RECOVERY_DEPENDENCY_ANCHOR_UNCOVERED).
async function backlogBoundHoldsAtInstall(offered: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-backlog-bound-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		let n = 0;
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await writer.issue(epoch, n++);
				await rows.toCreator();
			}
			const plan = async () => (await writer.settlementPlanDump?.()) as { fence: number | null; entries: { e: number; d: string }[] };
			const status = async () => (await writer.settlementStatus?.()) as { undelivered: unknown[] } | null;
			// Offline: moves the creator never receives, straight to the room.
			let accepted = 0;
			const refusals: string[] = [];
			for (let k = 0; k < offered; k++) {
				try {
					await writer.issueRoom!(epoch, n++);
					accepted++;
				} catch (error) {
					refusals.push(String((error as Error).name ?? error));
				}
			}
			// A skip install past three creator epochs retains them; the frontier proves each never admitted.
			await wire.pause();
			for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
			wire.resume();
			await wire.caughtUp(epoch, 600_000);
			// The install's settlement drain resolves the retained rows; give it up to a minute.
			const settled = async () => {
				const deadline = performance.now() + 60_000;
				for (;;) {
					const value = await plan();
					if (!value.entries.some((entry) => entry.d === "manual-review") || performance.now() > deadline) return value;
					await sleep(250);
				}
			};
			const afterFirst = await settled();
			const givenBack = (await status())?.undelivered.length ?? 0;
			// One more offline move and skip install: its row is proven never admitted only if the Writer
			// fenced its epoch first.
			await writer.issueRoom!(epoch, n++).catch(() => undefined);
			await wire.pause();
			for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
			wire.resume();
			await wire.caughtUp(epoch, 600_000);
			const afterSecond = await settled();
			const summary = {
				accepted,
				refusals: [...new Set(refusals)],
				refused: refusals.length,
				givenBack,
				manualReviewAfterFirst: afterFirst.entries.filter((entry) => entry.d === "manual-review").length,
				manualReviewAfterSecond: afterSecond.entries.filter((entry) => entry.d === "manual-review").length,
				fenceAfterSecond: afterSecond.fence,
			};
			process.stdout.write(`BACKLOG_BOUND ${JSON.stringify(summary)}\n`);
			// The room refuses new moves at the bound, so every retained move fits a record ...
			expect(accepted, "new moves accepted in one undelivered epoch").toBeLessThanOrEqual(V3_ROOM_LOCAL_BACKLOG_LIMIT);
			expect(summary.manualReviewAfterFirst, "retained rows left unresolved by the skip install").toBe(0);
			expect(givenBack, "moves given back").toBe(accepted);
			// ... and the Writer keeps fencing, so its later rows stay provable.
			expect(summary.manualReviewAfterSecond, "retained rows unresolved after the next skip install").toBe(0);
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it("an offline Writer's moves of one epoch are bounded by the hand-back records its next skip install needs", () =>
	backlogBoundHoldsAtInstall(V3_ROOM_LOCAL_BACKLOG_LIMIT + 6), 1_800_000);

// The bound counts moves without admission evidence, not every move of the epoch. With rollover off a
// healthy online Writer stays in one epoch indefinitely; the creator admits every move and, whenever
// it moves, signs a row whose causal past reaches the Writer's rows. Those moves need no hand-back
// record (they are in the epoch's seal), so they must not count: 474946c9 counted every own move of
// the epoch until the next install and refused this Writer at its 65th move. The control continues in
// the same epoch with the creator silent: from the last creator row on, moves count again and the
// Writer is refused at the bound.
async function admittedMovesLeaveTheBacklog(moves: number, creatorEvery: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-backlog-admitted-"));
	directories.push(directory);
	try {
		// Rollover off: no app trigger fires in this run.
		const { creator, writer } = await openPair(directory, {}, { movesPerAuthor: 1_000_000, idleMs: 3_600_000 });
		const rows = rowWire(creator, writer);
		const epoch = (await creator.authorityEpoch()) ?? 0;
		let ordinal = 0;
		let n = 0;
		let accepted = 0;
		const refusals: string[] = [];
		let unprovenAtEnd = 0;
		for (let k = 0; k < moves; k++) {
			if (k % creatorEvery === 0) {
				await creator.issueRoom!(epoch, ordinal++);
				await rows.toWriter();
				unprovenAtEnd = 0;
			}
			try {
				await writer.issueRoom!(epoch, n++);
				accepted++;
				unprovenAtEnd++;
			} catch (error) {
				refusals.push(String((error as Error).name ?? error));
			}
			await rows.toCreator();
		}
		const writerAuthor = (await writer.acceptedVertices!()).find((vertex) => vertex.epoch === epoch)?.author;
		const admitted = (await creator.acceptedVertices!()).filter((vertex) => vertex.author === writerAuthor).length;
		// Control: the creator falls silent; the Writer's further moves have no evidence and count.
		let silentAccepted = 0;
		let silentRefusal: string | undefined;
		for (let k = 0; k < V3_ROOM_LOCAL_BACKLOG_LIMIT + creatorEvery + 8 && silentRefusal === undefined; k++) {
			try {
				await writer.issueRoom!(epoch, n++);
				silentAccepted++;
			} catch (error) {
				silentRefusal = String((error as Error).name ?? error);
			}
		}
		const epochAfter = (await writer.authorityEpoch()) ?? 0;
		const summary = { moves, creatorEvery, accepted, refused: refusals.length, refusals: [...new Set(refusals)], admitted, unprovenAtEnd, silentAccepted, silentRefusal, epoch, epochAfter };
		process.stdout.write(`BACKLOG_ADMITTED ${JSON.stringify(summary)}\n`);
		expect(epochAfter, "rollover off: one epoch throughout").toBe(epoch);
		expect(admitted, "the creator admitted the Writer's moves").toBeGreaterThanOrEqual(moves);
		expect(summary.refused, "admitted moves refused as undelivered").toBe(0);
		// The bound still holds for moves without evidence: unproven moves since the last creator row.
		expect(silentRefusal, "the silent creator's Writer is refused at the bound").toBe("V3RoomLocalBacklogFull");
		expect(unprovenAtEnd + silentAccepted, "moves without admission evidence accepted").toBe(V3_ROOM_LOCAL_BACKLOG_LIMIT);
	} finally {
		restore();
	}
}

it("an online Writer's admitted moves do not count against the undelivered bound (rollover off)", () =>
	admittedMovesLeaveTheBacklog(V3_ROOM_LOCAL_BACKLOG_LIMIT + 36, 8), 1_800_000);

// The undelivered-move bound counts moves, as hand-back records do. Grid batches the moves issued
// together into one row ("applicationBatch"), and the backlog counted the plan's entries, one per
// row: once an install's plan write counted a batched row as one, the Writer accepted more new moves,
// and when the window expired them they needed more hand-back records than the bound had left. The
// rows past the record bound stay live (replaced again) or retained (withholding the author fence),
// and a member whose waiting rows never clear is not reaching its host (decoded in the 4-author
// scorecard, .logs/realtime-resume-2026-11-10/landing/hold-sc/anchor-w3-o5-01: 64 records from 45
// rows, one row with 16 moves, 16 rows left unresolved, no fence, RECOVERY_DEPENDENCY_ANCHOR_UNCOVERED).
async function backlogCountsBatchedMoves(batch: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-backlog-batched-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		let n = 0;
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await writer.issue(epoch, n++);
				await rows.toCreator();
			}
			const plan = async () => (await writer.settlementPlanDump?.()) as { fence: number | null; entries: { e: number; d: string }[] };
			const status = async () =>
				(await writer.settlementStatus?.()) as { undelivered: unknown[]; unsettledEpochs: number; deferred?: number } | null;
			// Offline (the creator never receives them): moves made together, which Grid batches into one row.
			const together = await Promise.allSettled(Array.from({ length: batch }, () => writer.issueRoom!(epoch, n++)));
			const acceptedTogether = together.filter((result) => result.status === "fulfilled").length;
			const ownRows = (await writer.published(null)).filter((row) => rowValue(row).epoch === epoch).length;
			// A one-epoch install displaces that row; its plan write counts the Writer's backlog.
			epoch = await rollCreator(creator, async () => undefined, ordinal);
			await wire.caughtUp(epoch, 600_000);
			for (let waited = 0; waited < 60_000 && !(await plan()).entries.some((entry) => entry.e >= 0); waited += 250) await sleep(250);
			await sleep(2_000);
			// Then one move at a time until the room refuses at the bound.
			let acceptedAfter = 0;
			const refusals: string[] = [];
			for (let k = 0; k < V3_ROOM_LOCAL_BACKLOG_LIMIT + 8; k++) {
				try {
					await writer.issueRoom!(epoch, n++);
					acceptedAfter++;
				} catch (error) {
					refusals.push(String((error as Error).name ?? error));
					break;
				}
			}
			const accepted = acceptedTogether + acceptedAfter;
			// A skip install past three creator epochs: the window gives every undelivered move back.
			await wire.pause();
			for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
			wire.resume();
			await wire.caughtUp(epoch, 600_000);
			const deadline = performance.now() + 60_000;
			let settled = await plan();
			while (settled.entries.some((entry) => entry.d === "manual-review") && performance.now() < deadline) {
				await sleep(250);
				settled = await plan();
			}
			const after = await status();
			const summary = {
				batch,
				acceptedTogether,
				rowsForThem: ownRows,
				acceptedAfter,
				accepted,
				refusals,
				givenBack: after?.undelivered.length ?? 0,
				unsettledEpochs: after?.unsettledEpochs,
				deferred: after?.deferred,
				dispositions: settled.entries.reduce<Record<string, number>>((counts, entry) => ((counts[entry.d] = (counts[entry.d] ?? 0) + 1), counts), {}),
				fence: settled.fence,
			};
			process.stdout.write(`BACKLOG_BATCHED ${JSON.stringify(summary)}\n`);
			// The bound counts moves: no more undelivered moves than hand-back records ...
			expect(accepted, "undelivered moves accepted (the batched ones counted per move)").toBeLessThanOrEqual(V3_ROOM_LOCAL_BACKLOG_LIMIT);
			// ... so the skip install gives every one of them back and leaves nothing unresolved.
			expect(summary.dispositions["manual-review"] ?? 0, "rows left unresolved").toBe(0);
			// The room's safety net agrees: no move waits for a hand-back record.
			expect(summary.deferred, "moves deferred for want of a hand-back record").toBe(0);
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it("the undelivered-move bound counts each move of a batched row, as hand-back records do", () =>
	backlogCountsBatchedMoves(24), 1_800_000);

// A given-back move counts against the undelivered bound only while its newest row has no admission
// evidence. An offline Writer's GIVEN_BACK moves are given back by a skip install (that many records);
// in the next epoch its policy offers them again (each reissue consumes its record). In this run the
// creator rolls once more before the reissued rows reach it, so the Writer's next install replaces
// them; the creator admits every replacement and signs a row reaching them: those moves are
// delivered. The Writer, offline again, must then be accepted for the bound's full 64 new moves in
// that epoch. 4109c500 counted a consumed record until the next plan merge dropped it, and a replaced
// move until the next plan write (the cached count also predated the drain's replacements), so it
// refused the Writer after 64 - GIVEN_BACK new moves (in the 100x16 catch-up, about 24 kept moves per
// install). The creator's budget (20 moves per author, under its own epoch's capacity of about 25)
// holds the check in one epoch: the Writer's rows count 16 there and the creator signs one row.
const GIVEN_BACK = 16;
async function deliveredReissuesLeaveTheBacklog() {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-backlog-reissued-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory, {}, { movesPerAuthor: 20, idleMs: 3_600_000 });
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const both = async () => {
			await rows.toWriter();
			await rows.toCreator();
		};
		const ordinal = { next: 0 };
		const ids: string[] = [];
		let epoch = 0;
		let n = 0;
		const status = async () => (await writer.settlementStatus?.()) as { undelivered: unknown[] } | null;
		const phase = async (label: string) =>
			process.stdout.write(
				`BACKLOG_REISSUED_PHASE ${JSON.stringify({
					label,
					epoch,
					creator: await creator.authorityEpoch(),
					writer: await writer.authorityEpoch(),
					undelivered: (await status())?.undelivered.length,
					kept: ((await writer.rolloverStatus?.()) as { kept?: unknown[] } | null)?.kept?.length,
					plan: await writer.settlementPlanDump?.(),
				})}\n`
			);
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, both, ordinal);
				await wire.caughtUp(epoch);
				await both();
			}
			// Offline: moves the creator never receives, straight to the room; a skip install gives them back.
			for (let k = 0; k < GIVEN_BACK; k++) {
				await writer.issueRoom!(epoch, n);
				ids.push(`block-1-${n++}`);
			}
			await wire.pause();
			for (let roll = 0; roll < 3; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
			wire.resume();
			await wire.caughtUp(epoch, 600_000);
			const givenBack = (await waitFor("moves given back", status, (value) => value?.undelivered.length === GIVEN_BACK, 120_000))
				?.undelivered.length;
			await phase("given-back");
			// Connected: the next epoch, where the policy offers the given-back moves again.
			await both();
			epoch = await rollCreator(creator, both, ordinal);
			await wire.caughtUp(epoch, 600_000);
			const writerAuthor = rowValue((await writer.published(null))[0]!).author;
			await waitFor(
				"every reissued move admitted",
				async () => {
					await both();
					return {
						landed: (await acceptedCounts(creator, writerAuthor, ids)).filter((count) => count >= 1).length,
						epochs: [await creator.authorityEpoch(), await writer.authorityEpoch()],
						undelivered: (await status())?.undelivered.length,
					};
				},
				(value) => value.landed === ids.length,
				120_000
			);
			await phase("reissues-admitted");
			// Evidence: a creator row of this epoch whose causal past reaches every reissued row.
			await creator.issueRoom!(epoch, ordinal.next++);
			await rows.toWriter();
			await phase("delivered");
			// Offline again: new moves until the room refuses one at the bound.
			let accepted = 0;
			let refusal: string | undefined;
			while (refusal === undefined && accepted <= V3_ROOM_LOCAL_BACKLOG_LIMIT) {
				try {
					await writer.issueRoom!(epoch, n++);
					accepted++;
				} catch (error) {
					refusal = String((error as Error).name ?? error);
				}
			}
			const epochs = { creator: (await creator.authorityEpoch()) ?? 0, writer: (await writer.authorityEpoch()) ?? 0 };
			const summary = { givenBack, accepted, refusal, epoch, epochs };
			process.stdout.write(`BACKLOG_REISSUED ${JSON.stringify(summary)}\n`);
			expect(givenBack, "moves given back").toBe(GIVEN_BACK);
			expect(epochs, "one epoch from the reissues to the refusal").toEqual({ creator: epoch, writer: epoch });
			expect(refusal, "refused at the bound").toBe("V3RoomLocalBacklogFull");
			expect(accepted, "new moves accepted after every reissued move was delivered").toBe(V3_ROOM_LOCAL_BACKLOG_LIMIT);
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}

it("a consumed hand-back record whose reissued row the creator admitted leaves the undelivered bound", () =>
	deliveredReissuesLeaveTheBacklog(), 1_800_000);

// Profile (SKIP_PROFILE=1; measurement only, no budget): the skip install of the 100x16 catch-up's
// steady state, which carries about 60 hand-back records. An offline Writer's SKIP_PROFILE_MOVES moves
// are given back by a skip install over two closed epochs (install A: retained rows resolved from the
// frontier); in the next epoch its policy offers them again, but those rows never reach the creator;
// the next skip install over two closed epochs (install B) finds every reissued row displaced and gives
// each move back again. For each install: deterministic counts (SQLite statements by keyword and
// transactions by mode, canonical encodes and decodes with bytes, Ed25519 verifications computed and
// memoized, the settlement work counters), per record, and wall and process CPU time per stage
// (readV3RoomStageTimes; nested stages overlap their parent). One process holds both roles: the
// creator only serves the successor material during the window, and its stages are listed apart.
async function profileHandBackSkipInstall(moves: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-skip-profile-"));
	directories.push(directory);
	const counts = new Map<string, number>();
	// SKIP_PROFILE_ATTRIBUTE=1: each canonical encode (and its bytes) and each SELECT by its call site.
	const attribute = process.env.SKIP_PROFILE_ATTRIBUTE === "1";
	const sites = new Map<string, number>();
	const bump = (key: string, amount = 1) => {
		counts.set(key, (counts.get(key) ?? 0) + amount);
		if (!attribute || (key !== "canonical.encode" && key !== "canonical.encodeBytes" && key !== "sql.SELECT")) return;
		const site = `${key} | ${callSite(Number(process.env.SKIP_PROFILE_DEPTH ?? 5))}`;
		sites.set(site, (sites.get(site) ?? 0) + amount);
	};
	const restores: (() => void)[] = [await installSqliteCountSeams((key) => bump(key))];
	observeCanonicalCalls((kind, byteLength) => {
		bump(`canonical.${kind}`);
		bump(`canonical.${kind}Bytes`, byteLength);
	});
	restores.push(() => observeCanonicalCalls(undefined));
	// Both protocol-v3 instances: the source this test's importers load, and the dist build the dist
	// packages (storage, compaction, issuance-store) resolve through node.
	const distVerifications = (
		(await import(join(import.meta.dirname, "../packages/protocol-v3/dist/src/instrumentation.js"))) as {
			observeEd25519Verifications: typeof observeEd25519Verifications;
		}
	).observeEd25519Verifications;
	for (const observe of [observeEd25519Verifications, distVerifications]) {
		observe((outcome) => bump(outcome === "computed" ? "ed25519.verify" : "ed25519.verifyMemo"));
		restores.push(() => observe(undefined));
	}
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let epoch = 0;
		let n = 0;
		const status = async () =>
			(await writer.settlementStatus?.()) as { undelivered: unknown[]; unsettledEpochs: number } | null;
		const plan = async () => (await writer.settlementPlanDump?.()) as { handBacks: number; entries: { d: string }[] } | null;
		// One measured skip install: from resuming the wire until the member's install (adoption and
		// settlement drain) has completed and the room lists `listed` given-back moves.
		const measured = async (label: string, listed: number) => {
			const stagesBefore = readV3RoomStageTimes();
			const workBefore = readV3SettlementWorkCounts();
			const adoptsBefore = stagesBefore["member.install.adopt"]?.count ?? 0;
			counts.clear();
			sites.clear();
			const cpuBefore = process.cpuUsage();
			const started = performance.now();
			wire.resume();
			await wire.caughtUp(epoch, 1_200_000);
			await waitFor(
				`${label}: install and drain complete`,
				async () => ({ adopts: readV3RoomStageTimes()["member.install.adopt"]?.count ?? 0, listed: (await status())?.undelivered.length }),
				(value) => value.adopts > adoptsBefore && value.listed === listed,
				600_000
			);
			const wallMs = performance.now() - started;
			const cpu = process.cpuUsage(cpuBefore);
			const snapshot = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
			const workAfter = readV3SettlementWorkCounts();
			const work = Object.fromEntries(
				Object.keys(workAfter).map((key) => [key, workAfter[key as keyof typeof workAfter] - workBefore[key as keyof typeof workBefore]])
			);
			const stagesAfter = readV3RoomStageTimes();
			const stages = Object.fromEntries(
				Object.entries(stagesAfter)
					.map(([stage, row]) => [stage, { ms: Math.round(row.ms - (stagesBefore[stage]?.ms ?? 0)), count: row.count - (stagesBefore[stage]?.count ?? 0) }] as const)
					.filter(([, row]) => row.count > 0)
			);
			const records = Math.max(1, listed);
			const perRecord = Object.fromEntries(
				[
					["sqlStatements", Object.entries(snapshot).filter(([key]) => key.startsWith("sql.") && !/begin|commit|rollback|stmt/u.test(key)).reduce((sum, [, value]) => sum + value, 0)],
					["sqlWriteTransactions", snapshot["sql.beginWrite"] ?? 0],
					["sqlReadTransactions", snapshot["sql.beginRead"] ?? 0],
					["canonicalEncodes", snapshot["canonical.encode"] ?? 0],
					["canonicalEncodedBytes", snapshot["canonical.encodeBytes"] ?? 0],
					["ed25519Verify", snapshot["ed25519.verify"] ?? 0],
					["dependencyTurns", work.dependencyTurns ?? 0],
					["recoveryCensusReads", work.recoveryCensusReads ?? 0],
				].map(([key, value]) => [key, Math.round(((value as number) / records) * 10) / 10])
			);
			const result = {
				label,
				epoch,
				records: listed,
				wallMs: Math.round(wallMs),
				cpuMs: Math.round((cpu.user + cpu.system) / 1000),
				stages,
				work,
				counts: snapshot,
				perRecord,
				plan: await plan(),
			};
			process.stdout.write(`SKIP_PROFILE ${JSON.stringify(result)}\n`);
			if (attribute)
				for (const kind of ["canonical.encode |", "canonical.encodeBytes |", "sql.SELECT |"])
					process.stdout.write(
						`SKIP_PROFILE_SITES ${JSON.stringify({ label, kind, top: [...sites].filter(([site]) => site.startsWith(kind)).sort((a, b) => b[1] - a[1]).slice(0, 12) })}\n`
					);
			return result;
		};
		try {
			while (epoch < 2) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch);
				await rows.toWriter();
				await rows.toCreator();
			}
			// Offline: moves the creator never receives, straight to the room.
			for (let k = 0; k < moves; k++) await writer.issueRoom!(epoch, n++);
			await wire.pause();
			for (let roll = 0; roll < 2; roll++) epoch = await rollCreator(creator, async () => undefined, ordinal);
			const installA = await measured("A: retained rows resolved", moves);
			// The next epoch: the policy offers the given-back moves again; their rows never reach the creator.
			epoch = await rollCreator(creator, rows.toWriter, ordinal);
			await wire.caughtUp(epoch, 600_000);
			const reissued = await waitFor(
				"given-back moves offered again (records consumed)",
				async () => ({ listed: (await status())?.undelivered.length ?? -1, policy: (({ state, kept }) => ({ state, kept: kept?.length }))(((await writer.rolloverStatus?.()) ?? {}) as { state?: string; kept?: unknown[] }) }),
				(value) => value.listed === 0,
				300_000
			).catch((error: unknown) => ({ timedOut: String(error).slice(0, 600) }));
			process.stdout.write(`SKIP_PROFILE_REISSUED ${JSON.stringify(reissued)}\n`);
			await wire.pause();
			for (let roll = 0; roll < 2; roll++) epoch = await rollCreator(creator, rows.toWriter, ordinal);
			const installB = await measured("B: reissued rows displaced, given back again", moves);
			return { installA, installB };
		} finally {
			await wire.stop();
		}
	} finally {
		for (const undo of restores.splice(0).reverse()) undo();
		restore();
	}
}

it.runIf(process.env.SKIP_PROFILE === "1")(
	"profile: a skip install carrying about 60 hand-back records (deterministic counts and stage times)",
	() => profileHandBackSkipInstall(Number(process.env.SKIP_PROFILE_MOVES ?? 60)),
	1_800_000
);

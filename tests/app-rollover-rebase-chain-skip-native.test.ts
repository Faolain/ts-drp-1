/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole, type RoleEnvironment } from "./fixtures/track-m-apps/long-room-core.js";
import {
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { readV3SettlementWorkCounts } from "../packages/node/src/v3-live.js";
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

async function openPair(directory: string, member: MemberHooks = {}) {
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

/** Creator moves (with the creator's rows carried to the Writer) until its policy rolls the epoch. */
async function rollCreator(creator: RoleEndpoint, carry: () => Promise<void>, ordinal: { next: number }) {
	const before = (await creator.rollover?.())?.epoch ?? 0;
	for (;;) {
		await creator.issue(0, ordinal.next++);
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
			const started = performance.now();
			wire.resume();
			await wire.caughtUp(epoch, 1_200_000);
			const ms = performance.now() - started;
			const after = readV3SettlementWorkCounts();
			const work = {
				dependencyTurns: after.dependencyTurns - before.dependencyTurns,
				recoveryCensusReads: after.recoveryCensusReads - before.recoveryCensusReads,
				retainedContractPreparations: after.retainedContractPreparations - before.retainedContractPreparations,
				sourceExpirySignatures: after.sourceExpirySignatures - before.sourceExpirySignatures,
			};
			const status = (await writer.settlementStatus?.()) as { undelivered?: unknown[] } | null;
			const result = { count, installMs: Math.round(ms), perRowMs: Math.round(ms / count), givenBack: status?.undelivered?.length, work };
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
	// Each further row adds at most its own signature's currency checks (two complete census reads
	// around the signing), not another turn's.
	expect(large.work.recoveryCensusReads - small.work.recoveryCensusReads, "census reads per further row").toBeLessThanOrEqual(
		(32 - 8) * 2.5
	);
}, 1_500_000);

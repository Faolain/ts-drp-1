/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole, type RoleEnvironment } from "./fixtures/track-m-apps/long-room-core.js";
import { fromBase64, type RoleEndpoint, successorWire, type WireRow } from "./fixtures/track-m-apps/long-room-driver.js";
import { readV3SettlementWorkCounts } from "../packages/node/src/v3-live.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// A member that fell behind must always catch up (the user's bar), whatever its host's speed. The
// measured costs on the boat boxes (2a429eb6, 100x16 catch-up, .logs/realtime-resume-2026-11-10/livelock):
// - the recipient lull (recovery-pool maintenance, once per epoch after the pool fills) takes 1-9 s
//   (median about 3.5 s); it holds the lifetime FIFO (the next install waits for it) and the
//   pool-maintenance barrier every local issue waits on;
// - a one-epoch install replaces every displaced own row with one dependency turn each, 0.3-0.6 s per
//   row (1.2-2.3 s before the census memo), so a drain of 20-40 rows outlasts the creator's epoch.
// These tests inject those costs (a lull delay and a per-signature delay) instead of relying on a slow
// box, so the outcome depends on the room's rules, not on the machine.

// The injected cost sits in the recovery turnover's own pass (one native reconciliation), wherever a
// pass runs: in a lull, or inline in an install whose lull did not settle. Both versions of the lull
// run the SAME passes, so the injected work is the same before and after any scheduling change.
const lull = vi.hoisted(() => ({ delayMs: 0, active: 0, entered: 0, passes: 0 }));
vi.mock("../packages/node/src/internal/creator-closed-rollback-data.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../packages/node/src/internal/creator-closed-rollback-data.js")>();
	return {
		...original,
		reconcileCreatorReceivedSnapshotRecoveryRoles: async (
			...args: Parameters<typeof original.reconcileCreatorReceivedSnapshotRecoveryRoles>
		) => {
			lull.active++;
			lull.entered++;
			if (lull.delayMs > 0) lull.passes++;
			try {
				if (lull.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, lull.delayMs));
				return await original.reconcileCreatorReceivedSnapshotRecoveryRoles(...args);
			} finally {
				lull.active--;
			}
		},
	};
});

// The per-row drain cost is the member's dependency turn: each seals, borrows and checks the author's
// whole recovery census (7-9 reads at 20-60 ms on the boxes, 0.3-0.6 s per turn), CPU in this one
// process, so it delays the creator too, as on a real shared host. Injected as a synchronous
// TURN_COST_MS once per dependency turn of the member's (the "recipient" role's): charged at the
// turn's first native transaction on one of its stores (recognised by its caller), once per turn.
const turns = { costMs: 0, charged: 0, last: -1, memberBegins: 0, newTurnBegins: 0 };
// The node host names each native file by sha256([family, role database name]) (app-long-room.ts).
const memberFiles = ["ahe", "issuance", "journal", "snapshots", "signing"].map((family) =>
	createHash("sha256").update(JSON.stringify([family, "recipient"])).digest("hex")
);
const isMemberFile = (location: string | null) => location !== null && memberFiles.some((hash) => location.includes(hash));
{
	const exec = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
		if (turns.costMs > 0 && sql.startsWith("BEGIN") && isMemberFile(this.location())) {
			turns.memberBegins++;
			const turn = readV3SettlementWorkCounts().dependencyTurns;
			if (turn !== turns.last) {
				turns.newTurnBegins++;
				const limit = Error.stackTraceLimit;
				Error.stackTraceLimit = 60;
				const stack = new Error().stack ?? "";
				Error.stackTraceLimit = limit;
				if (stack.includes("withActiveRebaseDependencies")) {
					turns.last = turn;
					turns.charged++;
					const until = performance.now() + turns.costMs;
					while (performance.now() < until) {
						/* the turn's census CPU */
					}
				}
			}
		}
		return exec.call(this, sql);
	};
}

const track = {
	rooms: new Set<{ close(): Promise<void> }>(),
	heads: new Set<{ close(): Promise<void> }>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
};
const directories: string[] = [];
afterEach(async () => {
	lull.delayMs = 0;
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

async function openPair(
	directory: string,
	member: Pick<RoleEnvironment, "deliveryRoom"> = {},
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
		relay: (request) => creator.dispatch(request),
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
	return { toWriter: () => carry(creator, writer, "creator"), toCreator: () => carry(writer, creator, "writer") };
}

const CREATOR_BLOCK_IDS = 64;
function creatorMove(creator: RoleEndpoint, ordinal: { next: number }) {
	const k = ordinal.next++;
	return creator.issue(k, k % CREATOR_BLOCK_IDS);
}
async function rollCreator(creator: RoleEndpoint, carry: () => Promise<void>, ordinal: { next: number }) {
	const before = (await creator.rollover?.())?.epoch ?? 0;
	for (;;) {
		await creatorMove(creator, ordinal);
		await carry();
		const epoch = (await creator.rollover?.())?.epoch ?? 0;
		if (epoch > before) return epoch;
	}
}
async function acceptedCounts(role: RoleEndpoint, author: string, ids: readonly string[]) {
	const vertices = (await role.acceptedVertices?.()) ?? [];
	return ids.map((id) => vertices.filter((vertex) => vertex.author === author && idOf(vertex.operation) === id).length);
}
async function warmUp(creator: RoleEndpoint, writer: RoleEndpoint, wire: ReturnType<typeof successorWire>, rows: ReturnType<typeof rowWire>, ordinal: { next: number }, issue: () => Promise<void>) {
	let epoch = 0;
	while (epoch < 2) {
		epoch = await rollCreator(creator, rows.toWriter, ordinal);
		await wire.caughtUp(epoch);
		await rows.toWriter();
		await issue();
		await rows.toCreator();
	}
	return epoch;
}

// A: the lull is the room's own maintenance; it must not stall the member's moves. Each turnover pass
// costs PASS_MS (injected); a move issued while a scheduled lull's pass runs must wait for at most
// that one pass, never the lull's other passes (today it waits on the pool-maintenance barrier for the
// whole lull, every epoch the lull runs: a Profile M stall, not only a catch-up one).
const PASS_MS = 2_000;
it("a member's move issued during its recipient lull waits for at most one turnover pass", async () => {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-lull-issue-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory);
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		let n = 0;
		try {
			let epoch = await warmUp(creator, writer, wire, rows, ordinal, async () => {
				await writer.issue((await writer.authorityEpoch()) ?? 0, n++);
			});
			// Follow (the member current, its moves carried) until its scheduled lulls run turnover passes.
			const measured: { issueMs: number; passesBefore: number; passesAfter: number }[] = [];
			lull.delayMs = PASS_MS;
			for (let roll = 0; roll < 40 && measured.length < 3; roll++) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				await wire.caughtUp(epoch, 300_000);
				const deadline = performance.now() + 3_000;
				while (lull.active === 0 && performance.now() < deadline) await sleep(10);
				if (lull.active === 0) {
					await rows.toCreator();
					continue;
				}
				const passesBefore = lull.passes;
				const started = performance.now();
				await writer.issue(epoch, n++);
				measured.push({ issueMs: Math.round(performance.now() - started), passesBefore, passesAfter: lull.passes });
				await rows.toCreator();
			}
			lull.delayMs = 0;
			process.stdout.write(`LULL_ISSUE ${JSON.stringify({ passMs: PASS_MS, measured })}\n`);
			expect(measured.length, "scheduled lulls ran turnover passes").toBeGreaterThan(0);
			for (const sample of measured) expect(sample.issueMs).toBeLessThan(PASS_MS * 1.5);
		} finally {
			await wire.stop();
		}
	} finally {
		restore();
	}
}, 900_000);

// The livelock: a member BEHIND (its rows never reached the creator for `epochs` creator epochs) is
// connected again while the creator keeps rolling every CREATOR_MOVES_PER_EPOCH moves, one move every
// CREATOR_MOVE_MS. The member's host costs are injected at the measured values: each turnover pass
// LULL_COST_MS (a lull runs 2-3), each member dependency turn TURN_COST_MS (a drain of 20-40 displaced rows, one
// turn each, outlasts the creator's epoch). Every
// move must land on the creator within MAX_INSTALLS member installs, and that bound does not depend on
// how far behind the member was.
const CREATOR_MOVES_PER_EPOCH = 12;
const CREATOR_MOVE_MS = 450;
const LULL_COST_MS = Number(process.env.CONVERGE_PASS_MS ?? 1_500);
const TURN_COST_MS = Number(process.env.CONVERGE_TURN_MS ?? 400);
const MAX_INSTALLS = Number(process.env.CONVERGE_MAX_INSTALLS ?? 12);
async function convergesBehind(moves: number, epochs: number) {
	const restore = await installEnvironment("node", () => undefined);
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-converge-"));
	directories.push(directory);
	try {
		const { creator, writer } = await openPair(directory, {}, { movesPerAuthor: CREATOR_MOVES_PER_EPOCH, idleMs: 3_600_000 });
		const wire = successorWire(() => [creator, writer] as const);
		const rows = rowWire(creator, writer);
		const ordinal = { next: 0 };
		const ids: string[] = [];
		let n = 0;
		const issue = async () => {
			const id = `block-1-${n}`;
			try {
				await writer.issue((await writer.authorityEpoch()) ?? 0, n++);
			} catch {
				// A refusal at issue is kept by the app's policy and offered again (kept-reoffer).
			}
			ids.push(id);
		};
		try {
			let epoch = await warmUp(creator, writer, wire, rows, ordinal, issue);
			const author = rowValue((await writer.published(null))[0]!).author;
			// Behind: the member's rows never reach the creator; it follows every two creator epochs.
			const steps = Math.max(1, Math.floor(epochs / 2));
			for (let step = 0; step < steps; step++) {
				const quota = Math.round(((step + 1) * moves) / steps) - Math.round((step * moves) / steps);
				for (let k = 0; k < quota; k++) await issue();
				await wire.pause();
				for (let roll = 0; roll < 2; roll++) epoch = await rollCreator(creator, rows.toWriter, ordinal);
				wire.resume();
				if (step < steps - 1) await wire.caughtUp(epoch, 600_000);
			}
			// Connected again, with the host's costs injected.
			turns.costMs = TURN_COST_MS;
			lull.delayMs = LULL_COST_MS;
			const memberAtStart = (await writer.authorityEpoch()) ?? 0;
			const started = performance.now();
			let installs = 0;
			let lastMember = memberAtStart;
			let landed = 0;
			for (;;) {
				await rows.toWriter();
				await rows.toCreator();
				const member = (await writer.authorityEpoch()) ?? 0;
				if (member !== lastMember) {
					installs++;
					lastMember = member;
				}
				landed = (await acceptedCounts(creator, author, ids)).filter((count) => count >= 1).length;
				if (landed === ids.length) break;
				if (installs > MAX_INSTALLS) break;
				await creatorMove(creator, ordinal);
				await sleep(CREATOR_MOVE_MS);
			}
			const result = {
				moves: ids.length,
				epochsBehind: epochs,
				landed,
				installs,
				creatorEpochs: ((await creator.rollover?.())?.epoch ?? 0) - epoch,
				ms: Math.round(performance.now() - started),
				injectedPasses: lull.passes,
				injectedTurns: turns.charged,
				memberBegins: turns.memberBegins,
				newTurnBegins: turns.newTurnBegins,
				status: await writer.rolloverStatus?.(),
			};
			process.stdout.write(`CONVERGE ${JSON.stringify(result).slice(0, 2000)}\n`);
			expect(result, "every move lands within the install bound").toMatchObject({ landed: ids.length });
		} finally {
			turns.costMs = 0;
			lull.delayMs = 0;
			await wire.stop();
		}
	} finally {
		restore();
	}
}

for (const epochs of [4, 8])
	it(`a member ${epochs} epochs behind with a drain and lull longer than the creator's epoch lands every move within ${MAX_INSTALLS} installs`, () =>
		convergesBehind(32, epochs), 1_800_000);

import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, hex, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import {
	type FloorHooks,
	readinessHoldRoom,
	type ReadinessHoldPeer,
	type ReadinessHoldRoom,
} from "./fixtures/track-x/readiness-hold-room.js";

// Track X, decision row 51: the readiness ingress hold meets a close and a seal. The creator
// adopts epoch 1 after the Writer installed it and played its first move there; that move
// arrives while the creator's adoption readiness job holds its first capture, and while the
// hold is set the test calls the creator's close (or seal).
// - close: close waits for the job; the held arrival then meets the closing plane as an
//   arrival already queued at close does today; close returns and every native owner joins.
// - seal: the seal's lifetime transition waits for the adoption. The held arrival enters the
//   FIFO when the hold is released; the seal's stage closes admission synchronously and waits
//   behind every queued task (stageBlueprintEpoch), so the arrival is either admitted before the
//   stage or meets the closed gate at authentication, as an arrival already queued at a seal does
//   today. Nothing is admitted after the stage, and the Writer's move is not lost: both peers
//   reach epoch 2 with the same projection, the move included.

const SETTLE_MS = Number(process.env.TRACK_M_SETTLE_MS ?? 300);
const CLOSE_MS = Number(process.env.TRACK_X_CLOSE_MS ?? 60_000);

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Event = Readonly<Record<string, unknown>>;

interface Hold {
	hooks: FloorHooks;
	state: { armed: boolean; heldAt: number; releasedAt: number };
	arm(rows: readonly DurableIssuanceOutboxRecord[], during: () => Promise<void> | void): void;
}

/**
 * Once armed, holds the creator's first readiness capture at its floor reservation, delivers
 * the Writer's rows as gossip, and runs `during` while the hold is set.
 * @returns The floor hooks, what they observed, and the arming call.
 */
function holdReadiness(): Hold {
	const events: Event[] = [];
	Reflect.set(globalThis, "__warmProofEvent", (event: Event) => {
		events.push(event);
	});
	const state = { armed: false, armedAt: 0, heldAt: 0, releasedAt: 0 };
	let rows: readonly DurableIssuanceOutboxRecord[] = [];
	let during: () => Promise<void> | void = () => undefined;
	const hooks: FloorHooks = {
		beforeReserve: async (stack, peer) => {
			if (!state.armed) return;
			const cold = events
				.slice(state.armedAt)
				.some(
					(event) => event.kind === "ordinary-readiness-source-refresh" && event.outcome === "cold-boundary-fallback"
				);
			if (
				!stack.includes("refreshCreatorOrdinarySourceReadiness") &&
				!(cold && stack.includes("captureCreatorOrdinarySourceWithoutForecast"))
			)
				return;
			state.armed = false;
			state.heldAt = performance.now();
			try {
				peer.inject(rows, 1);
				await sleep(250);
				await during();
				await sleep(250);
			} finally {
				state.releasedAt = performance.now();
			}
		},
	};
	return {
		hooks,
		state,
		arm: (selected, action): void => {
			rows = selected;
			during = action;
			state.armedAt = events.length;
			state.armed = true;
		},
	};
}

/**
 * Plays epoch 0, seals it, and lets the Writer install epoch 1 and play its first move there,
 * before the creator adopts.
 * @param fixture - The room.
 * @param creator - The creator.
 * @param writer - The Writer.
 * @returns The Writer's epoch-1 rows, the move's digest, and the creator's last delivered sequence.
 */
async function writerAhead(
	fixture: ReadinessHoldRoom,
	creator: ReadinessHoldPeer,
	writer: ReadinessHoldPeer
): Promise<{
	rows: readonly DurableIssuanceOutboxRecord[];
	move: string;
	creatorDelivered: number;
	writerDelivered: number;
}> {
	const delivered: (number | null)[] = [null, null];
	for (let ordinal = 0; ordinal < 4; ordinal++) {
		const index = ordinal % 2;
		const peer = index === 0 ? creator : writer;
		await peer.room.issue({
			action: "placeBlock",
			id: `block-${index}-${ordinal >> 1}`,
			kind: "stone",
			x: 2,
			y: index,
		});
		const rows = await fixture.publishedAfter(index, delivered[index] ?? null);
		await (index === 0 ? writer : creator).receive(rows, index);
		delivered[index] = required(rows.at(-1)).commit.authorSequence;
	}
	await sleep(SETTLE_MS);
	const sealed = await creator.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	const room = fixture as unknown as SettlementRoom;
	const transfer = await settlementDelivery(room);
	Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	expect(writer.room.authority()?.epoch).toBe(1);
	await writer.room.issue({ action: "placeBlock", id: "writer-epoch-1", kind: "stone", x: 41, y: 1 });
	const rows = await fixture.publishedAfter(1, delivered[1] ?? null);
	return {
		rows,
		move: hex(required(rows.at(-1)).commit.envelope.digest),
		creatorDelivered: required(delivered[0]),
		writerDelivered: required(delivered[1]),
	};
}

it("close while the readiness hold is set: close waits for the job, the held arrival meets the closing plane, nothing hangs", async () => {
	const fixture = await readinessHoldRoom();
	const hold = holdReadiness();
	const creator = await fixture.open(0, { floor: hold.hooks });
	const writer = await fixture.open(1);
	const { rows, move } = await writerAhead(fixture, creator, writer);

	let closing: Promise<string> | undefined;
	let closeCalledAt = 0;
	let closedAt = 0;
	hold.arm(rows, () => {
		closeCalledAt = performance.now();
		closing = creator.room.close().then(
			() => {
				closedAt = performance.now();
				return "closed";
			},
			(error: unknown) => {
				closedAt = performance.now();
				return `close-failed:${String(error)}`;
			}
		);
	});
	const adoption = creator.room.adoptCreatorSuccessor().then(
		(value) => `adopted:${JSON.stringify(value)}`,
		(error: unknown) => `adoption-failed:${String(error)}`
	);
	const adopted = await adoption;
	expect(hold.state.heldAt, "the creator's adoption readiness capture reserved its floor").toBeGreaterThan(0);
	expect(closing, "close was called while the hold was set").toBeDefined();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const closed = await Promise.race([
		required(closing),
		new Promise<string>((resolve) => {
			timer = setTimeout(() => resolve("TRACK_X_CLOSE_HANG"), CLOSE_MS);
		}),
	]);
	clearTimeout(timer);
	const admittedAt = creator.accepted.get(move);
	console.log(
		`TRACK_X_HOLD_CLOSE ${JSON.stringify({
			adopted,
			closed,
			heldMs: Math.round(hold.state.releasedAt - hold.state.heldAt),
			closeCalledAfterHoldMs: Math.round(closeCalledAt - hold.state.heldAt),
			closedAfterReleaseMs: Math.round(closedAt - hold.state.releasedAt),
			moveAdmittedAfterReleaseMs: admittedAt === undefined ? null : Math.round(admittedAt - hold.state.releasedAt),
		})}`
	);
	expect(closed).toBe("closed");
	expect(closedAt, "close waited for the readiness job").toBeGreaterThanOrEqual(hold.state.releasedAt);
	// Nothing is admitted once close has returned.
	if (admittedAt !== undefined) expect(admittedAt).toBeLessThanOrEqual(closedAt);
	const settledCount = creator.accepted.size;
	await sleep(500);
	expect(creator.accepted.size).toBe(settledCount);
}, 240_000);

it("seal while the readiness hold is set: nothing is admitted after the stage and the Writer's move is not lost", async () => {
	const fixture = await readinessHoldRoom();
	const hold = holdReadiness();
	const creator = await fixture.open(0, { floor: hold.hooks });
	const writer = await fixture.open(1);
	const { rows, move, creatorDelivered, writerDelivered } = await writerAhead(fixture, creator, writer);

	let sealing: Promise<unknown> | undefined;
	let sealedAt = 0;
	hold.arm(rows, () => {
		sealing = creator.room.sealEpoch().then((value) => {
			sealedAt = performance.now();
			return value;
		});
	});
	await creator.room.adoptCreatorSuccessor();
	expect(hold.state.heldAt, "the creator's adoption readiness capture reserved its floor").toBeGreaterThan(0);
	expect(creator.room.authority()?.epoch).toBe(1);
	const sealed = await required(sealing);
	await sleep(500);
	const admittedAt = creator.accepted.get(move);
	console.log(
		`TRACK_X_HOLD_SEAL ${JSON.stringify({
			sealed,
			heldMs: Math.round(hold.state.releasedAt - hold.state.heldAt),
			moveAdmittedAfterReleaseMs: admittedAt === undefined ? null : Math.round(admittedAt - hold.state.releasedAt),
			sealedAfterReleaseMs: Math.round(sealedAt - hold.state.releasedAt),
		})}`
	);
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	if (admittedAt !== undefined) expect(admittedAt, "admitted before the seal returned").toBeLessThanOrEqual(sealedAt);
	// The Writer installs epoch 2 and the creator adopts it; the Writer's epoch-2 rows reach the
	// creator, and both agree, the Writer's move included (in the cut or replaced by its settlement).
	const room = fixture as unknown as SettlementRoom;
	const transfer = await settlementDelivery(room);
	Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	await creator.room.adoptCreatorSuccessor();
	expect(writer.room.authority()?.epoch).toBe(2);
	expect(creator.room.authority()?.epoch).toBe(2);
	await creator.receive(await fixture.publishedAfter(1, writerDelivered), 1);
	expect(writer.room.projection()).toEqual(creator.room.projection());
	expect(JSON.stringify(creator.room.projection())).toContain("writer-epoch-1");
	// And the creator stays live.
	await creator.room.issue({ action: "placeBlock", id: "creator-epoch-2", kind: "stone", x: 42, y: 2 });
	await writer.receive(await fixture.publishedAfter(0, creatorDelivered), 0);
	expect(writer.room.projection()).toEqual(creator.room.projection());
}, 240_000);

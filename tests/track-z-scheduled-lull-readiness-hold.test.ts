import { afterEach, expect, it, vi } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { type FloorHooks, readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import type * as Binding from "../examples/v3-room/src/index.js";

// Track Z: the scheduled lull and Track X's readiness ingress hold (decision row 51).
//
// A creator's ordinary readiness preparation (prepareCreatorOrdinaryReadiness) holds every
// arrival on its plane until it ends. It runs inside the room's startup barrier and inside
// each successor adoption, both lifecycle transitions, and releases the hold before the
// transition returns. The scheduled lull is requested at the end of the adoption transition
// and runs as the next lifecycle transition, so its maintenance must never run while the
// adoption's preparation holds ingress: it must start only after the adoption has returned.
//
// Track X's settlement room on the node SQLite host (Grid zone application, the creator and
// one Writer). The creator's external floor is observed: while the creator adopts, every
// readiness capture is held at its floor reservation for HOLD_MS, inside the preparation and
// so inside its ingress hold. A lull that could run beside the preparation would start inside
// an adoption, at least HOLD_MS before it returns. The binding is wrapped to turn the
// scheduled lull on for the creator only (an explicit host never gets it by default), so every
// `recovery-pool-lull` event observed is the creator's.

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => {
	const original = await importOriginal<typeof Binding>();
	return {
		...original,
		createV3RoomSession: (
			input: Parameters<typeof Binding.createV3RoomSession>[0]
		): ReturnType<typeof Binding.createV3RoomSession> =>
			original.createV3RoomSession(
				input.creatorFinalitySigner === undefined ? input : { ...input, recoveryPoolScheduledLull: true }
			),
	};
});

const HOLD_MS = Number(process.env.TRACK_Z_READINESS_HOLD_MS ?? 300);
// The adoption's caller and the next lifecycle transition resume in the same microtask flush.
const ORDER_TOLERANCE_MS = 50;
const EPOCHS = 4;

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Window = { start: number; end: number; held: number };
type Lull = Readonly<{ start: number; end: number; epoch: unknown; trigger: unknown; result: unknown }>;

const readinessCapture = (stack: string): boolean =>
	stack.includes("prepareCreatorOrdinaryReadiness") ||
	stack.includes("refreshCreatorOrdinarySourceReadiness") ||
	stack.includes("captureCreatorOrdinarySourceWithoutForecast");

it("the creator's scheduled lull never runs while its adoption's readiness preparation holds ingress", async () => {
	const lulls: Lull[] = [];
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		if (event.kind !== "recovery-pool-lull") return;
		const end = performance.now();
		lulls.push({
			start: end - Number(event.ms),
			end,
			epoch: event.epoch,
			trigger: event.trigger,
			result: event.result,
		});
	});
	let adoption: Window | undefined;
	const hooks: FloorHooks = {
		beforeReserve: async (stack) => {
			if (adoption === undefined || !readinessCapture(stack)) return;
			adoption.held += 1;
			await sleep(HOLD_MS);
		},
	};
	const fixture = await readinessHoldRoom();
	const room = fixture as unknown as SettlementRoom;
	const creator = await fixture.open(0, { floor: hooks });
	const writer = await fixture.open(1);
	const peers = [creator, writer] as const;
	const delivered: (number | null)[] = [null, null];
	const adoptions: Window[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		// Track M's settlementTransition (tests/fixtures/track-m/settlement-room.ts), with the
		// adoption timed: two moves per peer, each delivered before the next, seal, adoption, install.
		for (let ordinal = 0; ordinal < 4; ordinal++) {
			const index = ordinal % 2;
			await required(peers[index]).room.issue({
				action: "placeBlock",
				id: `block-${index}-${ordinal >> 1}`,
				kind: "stone",
				x: epoch,
				y: index,
			});
			const rows = await fixture.publishedAfter(index, delivered[index] ?? null);
			await required(peers[1 - index]).receive(rows, index);
			delivered[index] = required(rows.at(-1)).commit.authorSequence;
		}
		await sleep(Number(process.env.TRACK_M_SETTLE_MS ?? 300));
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		const window: Window = { start: performance.now(), end: 0, held: 0 };
		adoption = window;
		try {
			await creator.room.adoptCreatorSuccessor();
		} finally {
			adoption = undefined;
			window.end = performance.now();
		}
		adoptions.push(window);
		const transfer = await settlementDelivery(room);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	}
	// The explicit call queues behind the last scheduled lull and answers with its settled result.
	const explicit = await creator.room.maintainRecoveryPool();
	const round = (value: number): number => Math.round(value);
	console.log(
		`TRACK_Z_READINESS_LULL ${JSON.stringify({
			holdMs: HOLD_MS,
			adoptions: adoptions.map((window) => ({ start: round(window.start), end: round(window.end), held: window.held })),
			lulls: lulls.map((lull) => ({ ...lull, start: round(lull.start), end: round(lull.end) })),
			explicit: explicit.kind,
		})}`
	);

	for (const [index, window] of adoptions.entries())
		expect(window.held, `the epoch-${index + 1} adoption's readiness capture was held`).toBeGreaterThan(0);
	expect(
		lulls.map((lull) => [lull.trigger, lull.epoch]),
		"one scheduled lull per adopted epoch, and no second lull"
	).toEqual(Array.from({ length: EPOCHS }, (_, index) => ["scheduled", index + 1]));
	for (const lull of lulls) {
		const own = required(adoptions[Number(lull.epoch) - 1]);
		expect(
			lull.start,
			`the epoch-${String(lull.epoch)} lull started after its adoption (and its readiness hold) ended`
		).toBeGreaterThan(own.end - ORDER_TOLERANCE_MS);
		for (const [index, window] of adoptions.entries())
			expect(
				lull.start < window.end - ORDER_TOLERANCE_MS && lull.end > window.start,
				`the epoch-${String(lull.epoch)} lull ran during the epoch-${index + 1} adoption`
			).toBe(false);
	}
	// The rooms stay live and converged.
	expect(writer.room.projection()).toEqual(creator.room.projection());
}, 480_000);

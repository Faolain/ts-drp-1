import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, hex, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom, settlementTransition } from "./fixtures/track-m/settlement-room.js";
import {
	type FloorHooks,
	type ReadinessHoldPeer,
	type ReadinessHoldRoom,
	readinessHoldRoom,
} from "./fixtures/track-x/readiness-hold-room.js";

// Track X RED (decision row 51): a Writer's append that reaches a settlement creator while the
// creator prepares ordinary readiness must be admitted once the preparation ends, without any
// further ingress, and the creator must stay live.
//
// A creator bound for maintenance takes local replacement custody of its AHE store, live
// journal and whole floor for every new received append (`handleV3Ingress`,
// packages/node/src/v3-live.ts), and its maintenance consumer refuses any append while a
// maintenance job is in flight (creator-close.ts). The readiness preparation
// (`prepareCreatorOrdinaryReadiness` -> `prepareOrdinaryReadiness`) is such a job, run from the
// room's startup and successor-install barriers outside the plane's FIFO, and its captures hold
// the same native read reservations. An append that arrives meanwhile is either refused custody
// and dropped without being kept (NATIVE_READ_RESERVATION_BUSY: the node and browser owners
// refuse a second reservation at once), or kept as pending ingress; a kept append changes the
// pending ingress that the capture's census and the job's own maintenance boundary require
// (`runCreatorOrdinaryReadinessMaintenance` needs none), so the job fails and the barrier makes
// the creator terminal. Phase 3a1b d9346 (Chromium, Track X section 11.3) lost the Writer's
// first append the first way.
//
// Two cases, on the node SQLite host, each with the Writer's rows delivered as gossip while
// the readiness job's first capture holds the creator's floor reservation:
// - "startup": the creator closes with the Writer's last move undelivered and reopens at epoch
//   0; the startup preparation captures once.
// - "maintenance": a host-local finishing window the capture cannot certify. At the creator's
//   third adoption (epoch 3) the preparation refreshes its source (the first capture), then
//   runs its readiness maintenance boundary, then captures cold again. The Writer installs
//   epoch 3 before the creator adopts it and plays its first move there.

const ADMIT_MS = Number(process.env.TRACK_X_RED_ADMIT_MS ?? 15_000);
const CUSTODY_MS = Number(process.env.TRACK_X_RED_CUSTODY_MS ?? 1_500);

// Declares more ordinary work than one epoch's finishing capacity certifies (every field within
// the validator's bounds), so a capture is never certified and the boundary runs.
const UNCERTIFIED_WINDOW = Object.freeze({
	maxAdditionalLocalRows: 2048,
	maxAdditionalReceivedRows: 2048,
	maxAdditionalActions: 4096,
	maxAdditionalOperationBytes: 2_097_152,
	maxAdditionalPreimageBytes: 4_194_304,
	maxAdditionalEpochVertexBytes: 4_194_304,
	maxCanonicalOperationByteLength: 4096,
	maxCanonicalPreimageByteLength: 8192,
	maxCanonicalEpochVertexByteLength: 8192,
	maxSuccessorFencePreimageByteLength: 8192,
	maxReceivedPendingIngressByteLength: 8192,
	maxApplicationBytes: 1_048_576,
	maxApplicationItems: 4096,
	maxApplicationDepth: 8,
});

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Event = Readonly<Record<string, unknown>> & { at: number };

/**
 * Observes the creator's warm-proof events (diagnostics only) from now on.
 * @returns The recorded events.
 */
function observeReadiness(): Event[] {
	const events: Event[] = [];
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		events.push({ ...event, at: performance.now() });
	});
	return events;
}

interface HoldState {
	armed: boolean;
	armedAt: number;
	rows: readonly DurableIssuanceOutboxRecord[];
	holding: boolean;
	heldAt: number;
	releasedAt: number;
	custodyReads: number;
	custodyReservations: number;
}

/**
 * Once armed, holds the creator's first readiness capture at its floor reservation and
 * delivers the Writer's rows as gossip meanwhile.
 * @param events - The creator's warm-proof events.
 * @returns The floor hooks and what they observed.
 */
function holdFirstReadinessCapture(events: Event[]): {
	hooks: FloorHooks;
	state: HoldState;
	arm(rows: readonly DurableIssuanceOutboxRecord[]): void;
} {
	const state: HoldState = {
		armed: false,
		armedAt: 0,
		rows: [] as readonly DurableIssuanceOutboxRecord[],
		holding: false,
		heldAt: 0,
		releasedAt: 0,
		custodyReads: 0,
		custodyReservations: 0,
	};
	const arm = (rows: readonly DurableIssuanceOutboxRecord[]): void => {
		state.rows = rows;
		state.armedAt = events.length;
		state.armed = true;
	};
	const hooks: FloorHooks = {
		beforeReserve: async (stack, peer) => {
			if (state.holding && stack.includes("acquireLocalReplacementCustody")) state.custodyReservations++;
			if (!state.armed) return;
			// The readiness job's captures: the warm refresh (readiness only), or the cold capture
			// right after the job reported its cold boundary.
			const cold = events
				.slice(state.armedAt)
				.some(
					(event) => event.kind === "ordinary-readiness-source-refresh" && event.outcome === "cold-boundary-fallback"
				);
			const readiness =
				stack.includes("refreshCreatorOrdinarySourceReadiness") ||
				(cold && stack.includes("captureCreatorOrdinarySourceWithoutForecast"));
			if (!readiness) return;
			state.armed = false;
			state.holding = true;
			state.heldAt = performance.now();
			try {
				peer.inject(state.rows, 1);
				// Without a hold, the creator's ingress reads its whole floor right before it takes
				// custody; give it the time to try.
				const deadline = performance.now() + CUSTODY_MS;
				while (state.custodyReads === 0 && performance.now() < deadline) await sleep(10);
				await sleep(250);
			} finally {
				state.holding = false;
				state.releasedAt = performance.now();
			}
		},
		onReadImage: (stack) => {
			if (state.holding && stack.includes("handleV3Ingress")) state.custodyReads++;
		},
	};
	return { hooks, state, arm };
}

async function admittedAndLive(
	fixture: ReadinessHoldRoom,
	creator: ReadinessHoldPeer,
	writer: ReadinessHoldPeer,
	move: string,
	creatorDelivered: number | null,
	label: string
): Promise<void> {
	const deadline = performance.now() + ADMIT_MS;
	while (!creator.accepted.has(move) && performance.now() < deadline) await sleep(25);
	expect(
		creator.accepted.has(move),
		`TRACK_X_RED ${label}: the Writer's move that reached the creator during its readiness preparation was not admitted within ${ADMIT_MS} ms of the preparation's end`
	).toBe(true);
	expect(creator.room.projection()).toEqual(writer.room.projection());
	// The creator stays live: its next move is admitted by the Writer.
	await creator.room.issue({ action: "placeBlock", id: `${label}-creator-after`, kind: "stone", x: 42, y: 2 });
	await writer.receive(await fixture.publishedAfter(0, creatorDelivered), 0);
	expect(writer.room.projection()).toEqual(creator.room.projection());
}

function logHold(label: string, epoch: number | undefined, state: HoldState, events: readonly Event[]): Event[] {
	const readiness = events.filter(
		(event) => event.kind === "ordinary-boundary-readiness" || event.kind === "ordinary-readiness-source-refresh"
	);
	console.log(
		`TRACK_X_READINESS_HOLD ${JSON.stringify({
			label,
			epoch,
			custodyReadsDuringCapture: state.custodyReads,
			custodyReservationsDuringCapture: state.custodyReservations,
			heldMs: Math.round(state.releasedAt - state.heldAt),
			readiness,
		})}`
	);
	return readiness;
}

it("startup: a Writer's move that arrives while the creator prepares readiness is admitted after it", async () => {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	await creator.room.issue({ action: "placeBlock", id: "startup-creator", kind: "stone", x: 40, y: 0 });
	const creatorRows = await fixture.publishedAfter(0, null);
	await writer.receive(creatorRows, 0);
	await writer.room.issue({ action: "placeBlock", id: "startup-writer", kind: "stone", x: 41, y: 1 });
	const writerRows = await fixture.publishedAfter(1, null);
	// The creator holds every Writer row but the move, so the move's dependencies are installed.
	creator.inject(writerRows.slice(0, -1), 1);
	await sleep(2000);
	const move = hex(required(writerRows.at(-1)).commit.envelope.digest);
	await fixture.stop(creator);

	const events = observeReadiness();
	const { hooks, state, arm } = holdFirstReadinessCapture(events);
	arm(writerRows.slice(-1));
	const reopened = await fixture.open(0, { reopen: true, floor: hooks });
	expect(state.heldAt, "the creator's startup readiness capture reserved its floor").toBeGreaterThan(0);
	logHold("startup", reopened.room.authority()?.epoch, state, events);
	await admittedAndLive(fixture, reopened, writer, move, required(creatorRows.at(-1)).commit.authorSequence, "startup");
}, 240_000);

it("maintenance: a Writer's move that arrives during a readiness capture that then needs maintenance is admitted after it", async () => {
	const fixture = await readinessHoldRoom({ window: UNCERTIFIED_WINDOW });
	const events = observeReadiness();
	const { hooks, state, arm } = holdFirstReadinessCapture(events);
	const creator = await fixture.open(0, { floor: hooks });
	const writer = await fixture.open(1);
	const delivered: (number | null)[] = [null, null];
	const room = fixture as unknown as SettlementRoom;
	for (let epoch = 0; epoch < 2; epoch++)
		await settlementTransition(room, [creator, writer] as never, delivered, epoch);
	// The third rollover in Track N's order, except that the Writer installs epoch 3 and plays
	// its first move there before the creator adopts it.
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
	await sleep(Number(process.env.TRACK_M_SETTLE_MS ?? 300));
	const sealed = await creator.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	const transfer = await settlementDelivery(room);
	Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	expect(writer.room.authority()?.epoch).toBe(3);
	await writer.room.issue({ action: "placeBlock", id: "maintenance-writer", kind: "stone", x: 41, y: 1 });
	const writerRows = await fixture.publishedAfter(1, delivered[1] ?? null);
	const move = hex(required(writerRows.at(-1)).commit.envelope.digest);

	arm(writerRows);
	await creator.room.adoptCreatorSuccessor();
	expect(state.heldAt, "the creator's adoption readiness capture reserved its floor").toBeGreaterThan(0);
	const readiness = logHold("maintenance", creator.room.authority()?.epoch, state, events.slice(state.armedAt));
	const boundary = readiness.find((event) => event.kind === "ordinary-boundary-readiness" && event.epoch === 3);
	expect(boundary, "the held readiness job captured, ran its maintenance boundary, and captured again").toMatchObject({
		maintenanceRan: true,
		preparationAttempts: 2,
	});
	await admittedAndLive(fixture, creator, writer, move, delivered[0] ?? null, "maintenance");
}, 480_000);

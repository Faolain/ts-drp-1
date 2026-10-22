import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { fenceDeliveryRoom } from "./fixtures/track-x/fence-delivery-room.js";
import { waitForV3RoomStartupForDiagnostics } from "../examples/v3-room/src/index.js";

// Track X RED (startup order, owner decision of 2026-10-21): on creator-trusted-settlement-v1
// a creator with no subscriber on its topic must prepare its ordinary readiness without
// waiting for one, and its first placement after a peer joins must take the warm path.
//
// The creator's startup barrier (`rebasePromise`, packages/node/src/v3-room.ts) publishes
// the accepted rows (the genesis bootstrap), drains the settlement outbox (which issues and
// publishes the genesis author fence) and only then prepares readiness. Each publication goes
// through `DRPNetworkNode.publishMessage`, which first waits for a subscriber on the topic
// (`waitForSubscriber`, packages/network/src/node.ts, at most 1000 ms per publication), and
// it waits inside the live plane's FIFO, ahead of the drain's local issue. The creator's own
// open-time gossip republication of its retained history (room-network.ts
// RETAINED_REQUEST_DELAYS) takes the same FIFO and waits the same way. Phase 3a1b d9346 (Grid
// under Track V's switch, Chromium) sees the result: the creator's first placement after the
// first join waits on the barrier and runs the readiness build
// (`ordinary-finishing-resource-program-build`, phase `boundary-preparation`) inside the
// placement.
//
// Here every peer publishes through the genuine `publishMessage`; its per-publication
// subscriber bound is lengthened (SUBSCRIBER_WAIT_MS) so that "no subscriber yet" lasts for
// the whole check, whatever the machine load. The creator opens alone. Its readiness must be
// prepared while no peer is subscribed. Then a Writer joins: the creator's startup
// publications must still wait for a subscriber and reach the Writer (none is dropped), the
// creator admits the Writer's first move, and the creator's next placement must build no
// finishing resource program.

const SUBSCRIBER_WAIT_MS = Number(process.env.TRACK_X_RED_SUBSCRIBER_WAIT_MS ?? 60_000);
const READINESS_MS = Number(process.env.TRACK_X_RED_READINESS_MS ?? 20_000);
const DELIVERY_MS = Number(process.env.TRACK_X_RED_DELIVERY_MS ?? 30_000);
const FENCE_ACTION = "$drp.author-fence.v1";

type Observed = Readonly<Record<string, unknown>> & { readonly at: number };

let restoreObserver: (() => void) | undefined;

afterEach(async () => {
	restoreObserver?.();
	restoreObserver = undefined;
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
	// A close joins a publication that is still waiting for a subscriber (at most one bound).
}, SUBSCRIBER_WAIT_MS + 60_000);

const sleep = (ms: number): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

it("a settlement creator with no subscriber prepares readiness without waiting for one, and its first placement after a join is warm", async () => {
	const events: Observed[] = [];
	const previous = Reflect.get(globalThis, "__warmProofEvent") as unknown;
	Reflect.set(globalThis, "__warmProofEvent", (event: unknown) => {
		if (event !== null && typeof event === "object")
			events.push({ ...(event as Readonly<Record<string, unknown>>), at: performance.now() });
	});
	restoreObserver = (): void => {
		Reflect.set(globalThis, "__warmProofEvent", previous);
	};
	const fixture = await fenceDeliveryRoom("writer", { genuinePublication: { subscriberWaitMs: SUBSCRIBER_WAIT_MS } });
	const creatorPeer = required(fixture.roster[0]).peerId;
	const writerPeer = required(fixture.roster[1]).peerId;
	const opened = performance.now();
	const creator = await fixture.open(0, { awaitStartup: false });
	const returned = performance.now();
	let startedUp: number | undefined;
	const startup = waitForV3RoomStartupForDiagnostics(creator.room).then(() => {
		startedUp = performance.now();
	});
	// Awaited below; a failed startup is reported there, or by the close, not as unhandled.
	void startup.catch(() => undefined);
	const prepared = (): Observed | undefined =>
		events.find((event) => event.kind === "ordinary-boundary-readiness" && event.prepared === true);
	while (prepared() === undefined && performance.now() - opened < READINESS_MS) await sleep(25);
	const timeline = (): string =>
		JSON.stringify({
			returned: Math.round(returned - opened),
			startedUp: startedUp === undefined ? undefined : Math.round(startedUp - opened),
			events: events.map(({ at, ...event }) => ({ at: Math.round(at - opened), ...event })),
			publications: fixture.network.publications.map(({ started, completed, ...row }) => ({
				started: Math.round(started - opened),
				completed: Math.round(completed - opened),
				...row,
			})),
		});
	console.log(`TRACK_X_STARTUP_ALONE ${timeline()}`);
	expect(
		prepared(),
		`TRACK_X_RED the settlement creator's readiness waits for a subscriber: not prepared within ${READINESS_MS} ms with none`
	).toBeDefined();

	// A Writer joins. The startup publications reach it by gossip once it subscribes.
	const writer = await fixture.open(1);
	await startup;
	const converged = async (label: string): Promise<void> => {
		const deadline = performance.now() + DELIVERY_MS;
		while (JSON.stringify(writer.room.projection()) !== JSON.stringify(creator.room.projection())) {
			if (performance.now() > deadline)
				throw new TypeError(`TRACK_X_RED ${label}: not converged within ${DELIVERY_MS} ms`);
			await sleep(25);
		}
	};
	await writer.room.issue({ action: "placeBlock", id: "writer-join", kind: "stone", x: 1, y: 1 });
	await converged("the Writer's first move");
	await fixture.network.idle();
	expect(
		fixture.network.publications
			.filter(({ from, sequence }) => from === creatorPeer && (sequence === 0 || sequence === 1))
			.map(({ sequence, action, recipients }) => ({ sequence, action, reached: recipients.includes(writerPeer) })),
		"the creator's startup publications (genesis bootstrap, genesis fence) still wait for a subscriber and reach the Writer"
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ sequence: 0, reached: true }),
			{ sequence: 1, action: FENCE_ACTION, reached: true },
		])
	);

	// The creator's first placement after the join.
	const placementStarted = performance.now();
	await creator.room.issue({ action: "placeBlock", id: "creator-first", kind: "stone", x: 2, y: 2 });
	const placementCompleted = performance.now();
	await converged("the creator's first placement");
	console.log(
		`TRACK_X_STARTUP_PLACEMENT ${JSON.stringify({ placementStarted: Math.round(placementStarted - opened), placementCompleted: Math.round(placementCompleted - opened), timeline: JSON.parse(timeline()) as unknown })}`
	);
	expect(
		events.filter(
			({ at, kind }) =>
				kind === "ordinary-finishing-resource-program-build" && at >= placementStarted && at <= placementCompleted
		),
		"TRACK_X_RED the creator's first placement after the join must not construct future resource programs"
	).toEqual([]);
}, 240_000);

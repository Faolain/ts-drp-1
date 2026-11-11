/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native fixture inference preserves the owners' signatures. */
// Liveness (a)/(b) at the application level (fix/maintenance-image-capacity): several Writers'
// combined moves fill the creator's per-epoch maintenance proof book. The creator then refuses a
// received move with the typed capacity reason (a), reports it through the session's observation-only
// onIngressCapacityRefusal, and the shipped rollover policy seals promptly on it (b): the Writers'
// held moves reach the successor through the existing re-delivery and settlement (c), so every move
// is admitted and nothing waits for a successor that never comes.
//
// Four Writers of a settlement-profile Grid zone room and the creator, on genuine local libp2p
// (nativePlayNetwork) with each page's own composition: the shipped rollover policy and successor
// delivery. The budget and idle triggers are set too high to fire, so a capacity refusal is the only
// rollover cause. One Writer alone cannot reach the creator's received-move refusal: its own
// settlement reserve refuses its move first (about 255 own moves in an epoch, against about 330
// received). The creator's own move is refused at a lower fill of its proof book than a received
// one (its quote is larger), so the creator moves every few Writer moves (its rows are the
// admission evidence that keeps the Writers' admitted moves out of their 64-move undelivered
// bound) and then pauses while the Writers' received moves fill the rest. The pause must stay
// under 64 moves per Writer, which is why it takes four Writers (two or three never reached the
// received refusal on bx_6ytwadfw before the creator's own).
import { expect, it } from "vitest";

import { nativePlayNetwork } from "./fixtures/active-endurance/native-network.js";
import { creatorDeliveryRoom, sleep } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, directories, required } from "./fixtures/track-m/room-retention-fixture.js";
import { GRID_ROLLOVER_BUDGET } from "../examples/grid/src/rollover.js";
import { createV3RoomRolloverPolicy, type V3RoomRolloverPolicy } from "../examples/v3-room/src/rollover.js";
import {
	createV3RoomSuccessorChannel,
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/successor-delivery.js";

const env = process.env;
const WRITERS = Number(env.RECEIVED_REFUSAL_WRITERS ?? 4);
const MOVES_PER_WRITER = Number(env.RECEIVED_REFUSAL_MOVES ?? 300);
const CREATOR_EVERY = Number(env.RECEIVED_REFUSAL_CREATOR_EVERY ?? 16);
// The creator pauses for PAUSE combined Writer moves from PAUSE_AT on (0: never), so the Writers'
// received moves, not its own, are what fill its proof book's last room.
const PAUSE_AT = Number(env.RECEIVED_REFUSAL_PAUSE_AT ?? 88);
const PAUSE = Number(env.RECEIVED_REFUSAL_PAUSE ?? 212);
const SLOTS = 16;
const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

it("several hot Writers: a received move the creator refuses at capacity triggers a rollover and every move is admitted", async () => {
	const network = await nativePlayNetwork(5, WRITERS + 1);
	const ingressRefusals: string[] = [];
	const errors: string[] = [];
	const policies: (V3RoomRolloverPolicy | undefined)[] = [];
	const deliveries: (V3RoomSuccessorDelivery | undefined)[] = [];
	// The creator's latest admitted position of every Writer block.
	const admitted = new Map<string, number>();
	const events: { epoch: number; trigger: string; moves: number }[] = [];
	let failure: unknown;
	try {
		const fixture = await creatorDeliveryRoom({
			profile: "settlement",
			network: network as never,
			peerIds: network.peerIds,
			writers: WRITERS,
			onIngressCapacityRefusal: (reason) => {
				ingressRefusals.push(reason);
				policies[0]?.refused(reason);
			},
			onAccepted: (receiver, _digest, author, vertex) => {
				if (vertex !== undefined)
					policies[receiver]?.observe({ ...(vertex as object), author, epoch: vertex.epoch } as never);
				if (receiver !== 0) return;
				const root = vertex?.operation as
					| { action?: string; batch?: { entries?: { operation?: unknown }[] } }
					| undefined;
				const operations = (
					root?.action === "applicationBatch" ? (root.batch?.entries ?? []).map((entry) => entry.operation) : [root]
				) as ({ action?: string; id?: string; x?: number } | undefined)[];
				for (const operation of operations)
					if (operation?.action === "placeBlock" && operation.id?.startsWith("w") === true && operation.x !== undefined)
						admitted.set(operation.id, Math.max(admitted.get(operation.id) ?? -1, operation.x));
			},
		});
		const peers: Awaited<ReturnType<typeof fixture.open>>[] = [];
		for (let index = 0; index <= WRITERS; index++) peers.push(await fixture.open(index));
		const creatorPeer = required(peers[0]).peerId;
		const budget = Object.freeze({ ...GRID_ROLLOVER_BUDGET, movesPerAuthor: 1_000_000, idleMs: 3_600_000 });
		for (const [index, peer] of peers.entries()) {
			const role = index === 0 ? "creator" : "member";
			const delivery = createV3RoomSuccessorDelivery({
				role,
				objectId: fixture.objectId,
				creatorPeer,
				channel: createV3RoomSuccessorChannel(network.successorNode(peer.peerId), fixture.objectId),
				hooks: { onRefused: (error) => errors.push(`delivery ${index}: ${errorText(error)}`) },
			});
			deliveries[index] = delivery;
			const policy = createV3RoomRolloverPolicy({
				role,
				budget,
				hooks: {
					publishSuccessor: (offer, successorEpoch) => delivery.publish(offer, successorEpoch),
					requestSuccessor: () => delivery.request(),
					creatorReachable: () => delivery.creatorReachable(),
					onError: (error) => errors.push(`policy ${index}: ${errorText(error)}`),
					onRollover: (event) => events.push({ epoch: event.epoch, trigger: event.trigger, moves: event.moves }),
				},
			});
			policies[index] = policy;
			policy.bind(peer.room as never);
			delivery.bind(peer.room as never);
		}
		const last = new Map<string, number>();
		let creatorSeq = 0;
		for (let move = 0; move < MOVES_PER_WRITER * WRITERS; move++) {
			const paused = PAUSE_AT > 0 && move >= PAUSE_AT && move < PAUSE_AT + PAUSE;
			if (move % CREATOR_EVERY === 0 && !paused) {
				const slot = creatorSeq % SLOTS;
				await required(policies[0]).issue({ action: "placeBlock", id: `c-${slot}`, kind: "stone", x: creatorSeq++, y: 0 });
			}
			const writer = 1 + (move % WRITERS);
			const seq = Math.floor(move / WRITERS);
			const id = `w${writer}-${seq % SLOTS}`;
			await required(policies[writer]).issue({ action: "placeBlock", id, kind: "stone", x: seq, y: writer });
			last.set(id, seq);
		}
		// Every Writer's last position of every block reaches the creator (re-delivered after a rollover).
		const deadline = performance.now() + 180_000;
		const missing = () => [...last].filter(([id, x]) => (admitted.get(id) ?? -1) < x);
		while (missing().length > 0 && performance.now() < deadline) await sleep(100);
		await required(policies[0]).settled();
		const creator = required(policies[0]).stats();
		process.stdout.write(
			`RECEIVED_REFUSAL ${JSON.stringify({
				writers: WRITERS,
				movesPerWriter: MOVES_PER_WRITER,
				creatorEvery: CREATOR_EVERY,
				ingressRefusals: ingressRefusals.length,
				firstRefusal: ingressRefusals[0]?.slice(0, 200),
				creator,
				events,
				epochs: peers.map((peer) => peer.room.authority()?.epoch ?? null),
				missing: missing().slice(0, 8),
				errors: errors.slice(0, 8),
				pauseAt: PAUSE_AT,
				pause: PAUSE,
			})}\n`
		);
		// (a): the creator refused a received move with the typed capacity reason, and reported it.
		expect(ingressRefusals.length, "the creator refused a received Writer move at capacity").toBeGreaterThan(0);
		expect(ingressRefusals.every((reason) => reason.includes("ISSUANCE_CAPACITY_FORECAST_EXCEEDED"))).toBe(true);
		// (b): the room rolled over (only a refusal can trigger it here), and (c) every move was admitted.
		expect(creator.rollovers).toBeGreaterThan(0);
		expect(events.map((event) => event.trigger)).toContain("refusal");
		expect(missing(), "every Writer move reaches the creator").toEqual([]);
		// HARNESS ARTIFACT: in-process Writers pulling the same successor share one process-wide snapshot
		// session bound (see realtime-scorecard-rate-native); the page's delivery backs off and retries.
		expect(errors.filter((error) => !error.includes("snapshot transfer session capacity is exhausted"))).toEqual([]);
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		for (const policy of policies) policy?.close();
		for (const delivery of deliveries) delivery?.close();
		const cleanup = [...(await closeFixtures()), ...(await network.close())];
		if (failure === undefined && cleanup.length > 0) throw new AggregateError(cleanup, "cleanup failed");
		directories.clear();
	}
}, 1_800_000);

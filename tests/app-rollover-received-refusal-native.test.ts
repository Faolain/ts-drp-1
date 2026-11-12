/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion -- Native fixture inference preserves the owners' signatures; optional room methods are checked before use. */
// Liveness (a)/(b) at the application level (fix/maintenance-image-capacity): several Writers'
// combined moves fill the creator's per-epoch maintenance proof book. The creator then refuses a
// received move with the typed capacity reason (a), reports it through the session's observation-only
// onIngressCapacityRefusal, and the shipped rollover policy seals promptly on it (b): the Writers'
// held moves reach the successor through the existing re-delivery and settlement (c), so every move
// is admitted and nothing waits for a successor that never comes.
//
// Five Writers of a settlement-profile Grid zone room and the creator, on genuine local libp2p
// (nativePlayNetwork) with each page's own composition: the shipped rollover policy and successor
// delivery. The budget and idle triggers are set too high to fire, so a capacity refusal is the only
// rollover cause. One Writer alone cannot reach the creator's received-move refusal: its own
// settlement reserve refuses its move first (about 255 own moves in an epoch, against about 330
// received). The creator's own move is refused at a lower fill of its proof book than a received
// one (its quote is larger), so the creator moves every few Writer moves (its rows are the
// admission evidence that keeps the Writers' admitted moves out of their 64-move undelivered
// bound) and then pauses while the Writers' received moves fill the rest. The pause must stay
// under 64 moves per Writer and span about 330 received moves of the epoch, which is why it takes
// several Writers (two or three never reached the received refusal on bx_6ytwadfw before the
// creator's own; four reached it in one of two runs).
import { appendFileSync } from "node:fs";

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
const WRITERS = Number(env.RECEIVED_REFUSAL_WRITERS ?? 5);
const MOVES_PER_WRITER = Number(env.RECEIVED_REFUSAL_MOVES ?? 300);
const CREATOR_EVERY = Number(env.RECEIVED_REFUSAL_CREATOR_EVERY ?? 16);
// In every epoch the creator pauses for PAUSE combined Writer moves from the epoch's PAUSE_AT-th on
// (0: never), so the Writers' received moves, not its own, are what fill its proof book's last room.
// PAUSE / WRITERS must stay under the Writers' 64-move undelivered bound.
const PAUSE_AT = Number(env.RECEIVED_REFUSAL_PAUSE_AT ?? 100);
const PAUSE = Number(env.RECEIVED_REFUSAL_PAUSE ?? 280);
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
	const events: { peer: number; epoch: number; trigger: string; moves: number; at: number }[] = [];
	let failure: unknown;
	let progress: Readonly<Record<string, unknown>> = {};
	let report: () => Readonly<Record<string, unknown>> = () => ({});
	const stages: string[] = [];
	let watchdog: ReturnType<typeof setInterval> | undefined;
	try {
		const fixture = await creatorDeliveryRoom({
			profile: "settlement",
			network: network as never,
			peerIds: network.peerIds,
			writers: WRITERS,
			// One native storage host per peer, as on separate devices.
			separateStorage: true,
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
		let installTail: Promise<void> = Promise.resolve();
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
					onRollover: (event) =>
						events.push({ peer: index, epoch: event.epoch, trigger: event.trigger, moves: event.moves, at: Math.round(performance.now() / 1000) }),
				},
			});
			policies[index] = policy;
			// Diagnostics only: the creator's rollover stages (seal, adopt, export) with their times. The
			// session is frozen and its methods close over their state, so a copy carries the wrappers.
			const stage =
				(name: string, run: (...input: never[]) => Promise<unknown>) =>
				async (...input: never[]) => {
					const at = () => Math.round(performance.now() / 1000);
					stages.push(`${name}:start@${at()}`);
					try {
						const result = await run(...input);
						stages.push(`${name}:ok@${at()}`);
						return result;
					} catch (error) {
						stages.push(`${name}:failed@${at()}:${errorText(error).slice(0, 160)}`);
						throw error;
					}
				};
			const session = peer.room as unknown as Record<string, (...input: never[]) => Promise<unknown>>;
			policy.bind(
				(index !== 0
					? peer.room
					: {
							...peer.room,
							sealEpoch: stage("sealEpoch", session.sealEpoch!),
							adoptCreatorSuccessor: stage("adoptCreatorSuccessor", session.adoptCreatorSuccessor!),
							exportCreatorSuccessor: stage("exportCreatorSuccessor", session.exportCreatorSuccessor!),
						}) as never
			);
			const room = peer.room;
			// HARNESS ARTIFACT GUARD (as realtime-scorecard-rate-native): snapshot pulls are bounded per
			// process, so in-process Writers installing the same successor at once refuse each other and
			// back off for seconds; separate devices never share that bound. Installs run one at a time.
			delivery.bind(
				index === 0
					? room
					: ({
							authority: () => room.authority(),
							connectedPeers: () => room.connectedPeers(),
							currencyStatement: room.currencyStatement === undefined ? undefined : () => room.currencyStatement!(),
							confirmCurrent:
								room.confirmCurrent === undefined ? undefined : (statement: never) => room.confirmCurrent!(statement),
							localIssueCurrency: room.localIssueCurrency === undefined ? undefined : () => room.localIssueCurrency!(),
							installCreatorSuccessor: (input: never) => {
								const result = installTail.then(() => room.installCreatorSuccessor(input));
								installTail = result.then(
									() => undefined,
									() => undefined
								);
								return result;
							},
						} as never)
			);
		}
		const last = new Map<string, number>();
		let creatorSeq = 0;
		let epoch = required(peers[0]).room.authority()?.epoch;
		let epochMoves = 0;
		const started = performance.now();
		const state = () => ({
			seconds: Math.round((performance.now() - started) / 1000),
			epochs: peers.map((peer) => peer.room.authority()?.epoch ?? null),
			stats: policies.map((policy) => policy?.stats()),
			deliveries: deliveries.map((delivery) => delivery?.stats()),
			ingressRefusals: ingressRefusals.length,
			stages: stages.slice(-6),
			events,
			errors: errors.slice(-4),
		});
		report = state;
		// Every 15 s the room's state goes to the state file, so a stall shows where it stopped.
		watchdog = setInterval(() => {
			if (env.RECEIVED_REFUSAL_STATE_FILE !== undefined)
				appendFileSync(env.RECEIVED_REFUSAL_STATE_FILE, `RECEIVED_REFUSAL_STATE ${JSON.stringify({ ...progress, ...state() })}\n`);
		}, 15_000);
		for (let move = 0; move < MOVES_PER_WRITER * WRITERS; move++) {
			progress = { move, epochMoves };
			const current = required(peers[0]).room.authority()?.epoch;
			if (current !== epoch) {
				process.stdout.write(`RECEIVED_REFUSAL_EPOCH ${JSON.stringify({ move, epochMoves, ...state() })}\n`);
				epoch = current;
				epochMoves = 0;
			}
			const paused = PAUSE_AT > 0 && epochMoves >= PAUSE_AT && epochMoves < PAUSE_AT + PAUSE;
			epochMoves++;
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

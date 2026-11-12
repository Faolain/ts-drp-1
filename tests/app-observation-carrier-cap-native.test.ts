/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion -- Native fixture inference preserves the owners' signatures; optional room methods are checked before use. */
// One bound for maintenance observation carriers (fix/maintenance-image-capacity). The creator's
// close, and its own maintenance quote (every own move, including the settlement fence of its
// adoption), encode each observation carrier (journal {control, image, canonicalRows}, snapshot,
// AHE, floor, inventory) with closedRetirementBytes, capped at AHE maxUnionBytes (786,432).
// Readiness sizing bounded the journal carrier by the journal's own image bound (2 MiB) and the
// ordinary book (1,310,720) instead. In a room of five Writers the creator's live journal keeps
// every row of the current and the two previous epochs; it grew past the cap (measured: 789,567
// bytes, 714 rows) while the book still fit, and the creator's next proof acquisition failed with
// an untyped "canonical value exceeds byte limit": the room stopped.
//
// Two paths reach it, one case each:
// - the creator moves in every epoch: its own move's maintenance quote is the first acquisition
//   past the cap;
// - the creator is silent: its close (the rollover's seal) is.
// Five Writers and the creator of a settlement-profile Grid zone room on genuine local libp2p, each
// page with the shipped rollover policy and successor delivery, one native storage host per peer.
// The creator rolls on the budget (CARRIER_MOVES moves of one author); a typed capacity refusal of a
// received or own move rolls it over too. Every move must be admitted.
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
const WRITERS = Number(env.CARRIER_WRITERS ?? 5);
// Moves per author per epoch (the budget). Under the Writers' 64-move undelivered bound.
const MOVES = Number(env.CARRIER_MOVES ?? 55);
// Rounds of MOVES per author: the journal keeps three epochs, so it crosses the cap in the third.
const ROUNDS = Number(env.CARRIER_ROUNDS ?? 4);
const SLOTS = 16;
const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

async function carrierRoom(label: string, creatorMoves: boolean) {
	const network = await nativePlayNetwork(5, WRITERS + 1);
	const ingressRefusals: string[] = [];
	const issueErrors: string[] = [];
	const errors: string[] = [];
	const policies: (V3RoomRolloverPolicy | undefined)[] = [];
	const deliveries: (V3RoomSuccessorDelivery | undefined)[] = [];
	const admitted = new Map<string, number>();
	const events: { epoch: number; trigger: string; moves: number }[] = [];
	let failure: unknown;
	try {
		const fixture = await creatorDeliveryRoom({
			profile: "settlement",
			network: network as never,
			peerIds: network.peerIds,
			writers: WRITERS,
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
		// A Writer's moves reach the creator batched (up to 16 per vertex): the budget counts every move
		// of a vertex (weight), not vertices.
		const movesOf = (vertex: { operation?: unknown }) => {
			const root = vertex.operation as { action?: string; batch?: { entries?: unknown[] } } | undefined;
			return root?.action === "applicationBatch" ? (root.batch?.entries?.length ?? 1) : 1;
		};
		const budget = Object.freeze({
			...GRID_ROLLOVER_BUDGET,
			movesPerAuthor: 1_000_000,
			idleMs: 3_600_000,
			weight: Object.freeze({ perAuthor: MOVES, of: movesOf }),
		});
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
			const room = peer.room;
			// HARNESS ARTIFACT GUARD (as realtime-scorecard-rate-native): in-process members share one
			// process-wide snapshot session bound; installs run one at a time.
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
		const started = performance.now();
		const epochs = () => peers.map((peer) => peer.room.authority()?.epoch ?? null);
		let creatorSeq = 0;
		// Each round, every Writer (and the creator, when it moves) issues MOVES moves, interleaved.
		for (let round = 0; round < ROUNDS; round++)
			for (let move = 0; move < MOVES; move++) {
				if (creatorMoves) {
					try {
						await required(policies[0]).issue({ action: "placeBlock", id: `c-${creatorSeq % SLOTS}`, kind: "stone", x: creatorSeq, y: 0 });
						creatorSeq++;
					} catch (error) {
						issueErrors.push(`creator round ${round} move ${move}: ${errorText(error)}`);
						throw error;
					}
				}
				for (let writer = 1; writer <= WRITERS; writer++) {
					const seq = round * MOVES + move;
					const id = `w${writer}-${seq % SLOTS}`;
					try {
						await required(policies[writer]).issue({ action: "placeBlock", id, kind: "stone", x: seq, y: writer });
					} catch (error) {
						issueErrors.push(`writer ${writer} round ${round} move ${move}: ${errorText(error)}`);
						throw error;
					}
					last.set(id, seq);
				}
			}
		const deadline = performance.now() + 180_000;
		const missing = () => [...last].filter(([id, x]) => (admitted.get(id) ?? -1) < x);
		while (missing().length > 0 && performance.now() < deadline) await sleep(100);
		await required(policies[0]).settled();
		process.stdout.write(
			`CARRIER_CAP ${JSON.stringify({
				label,
				writers: WRITERS,
				moves: MOVES,
				rounds: ROUNDS,
				seconds: Math.round((performance.now() - started) / 1000),
				rollovers: required(policies[0]).stats().rollovers,
				triggers: events.map((event) => event.trigger),
				ingressRefusals: ingressRefusals.length,
				epochs: epochs(),
				missing: missing().slice(0, 8),
				errors: errors.slice(0, 8),
			})}\n`
		);
		expect(errors.filter((error) => !error.includes("snapshot transfer session capacity is exhausted"))).toEqual([]);
		expect(ingressRefusals.every((reason) => reason.includes("ISSUANCE_CAPACITY_FORECAST_EXCEEDED"))).toBe(true);
		expect(required(policies[0]).stats().rollovers).toBeGreaterThanOrEqual(ROUNDS - 1);
		expect(missing(), "every Writer move reaches the creator").toEqual([]);
	} catch (error) {
		failure = error;
		process.stdout.write(
			`CARRIER_CAP_FAILED ${JSON.stringify({
				label,
				error: errorText(error).slice(0, 600),
				triggers: events.map((event) => event.trigger),
				ingressRefusals: ingressRefusals.length,
				issueErrors: issueErrors.slice(0, 4),
				errors: errors.slice(0, 8),
			})}\n`
		);
		throw error;
	} finally {
		for (const policy of policies) policy?.close();
		for (const delivery of deliveries) delivery?.close();
		const cleanup = [...(await closeFixtures()), ...(await network.close())];
		if (failure === undefined && cleanup.length > 0) throw new AggregateError(cleanup, "cleanup failed");
		directories.clear();
	}
}

it(
	"five Writers and a moving creator: the creator's own maintenance quote never meets a journal carrier past the close's cap",
	() => carrierRoom("creator-moves", true),
	1_800_000
);

it(
	"five Writers and a silent creator: the creator's close never meets a journal carrier past its cap",
	() => carrierRoom("creator-silent", false),
	1_800_000
);

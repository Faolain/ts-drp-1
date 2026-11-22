/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion -- Native fixture inference preserves the owners' signatures; optional room methods are checked before use. */
// fix/creator-material-session-bound at the application level: a settlement-profile Grid zone room
// with five, then eight, Writers. Every Writer installs every successor the creator publishes. Before,
// the creator's material server kept every member it had served for an epoch until that member
// disconnected and refused any requester beyond SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS (4): the fifth
// Writer's install expired after 120 s, again and again, and its moves waited in the closing until
// they failed. Now the bound is concurrent serving sessions, released when a member's pull completes.
//
// Genuine local libp2p (nativePlayNetwork), each page's own composition (the shipped rollover policy
// and successor delivery), one native storage host per peer. The creator rolls on the shipped budget
// trigger (movesPerAuthor), the idle trigger set too high to fire.
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
const ROLLOVERS = Number(env.MANY_WRITERS_ROLLOVERS ?? 3);
const MOVES_PER_EPOCH = Number(env.MANY_WRITERS_MOVES ?? 3);
// Every member installs a published successor within this bound (the install deadline is 120 s).
const INSTALL_BOUND_MS = Number(env.MANY_WRITERS_INSTALL_BOUND_MS ?? 90_000);
const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

async function manyWriters(writers: number) {
	const network = await nativePlayNetwork(5, writers + 1);
	const errors: string[] = [];
	const policies: (V3RoomRolloverPolicy | undefined)[] = [];
	const deliveries: (V3RoomSuccessorDelivery | undefined)[] = [];
	const rollovers: { epoch: number; successorEpoch: number; at: number }[] = [];
	const installedAt: (number | undefined)[][] = [];
	let failure: unknown;
	try {
		const fixture = await creatorDeliveryRoom({
			profile: "settlement",
			network: network as never,
			peerIds: network.peerIds,
			writers,
			separateStorage: true,
			onAccepted: (receiver, _digest, author, vertex) => {
				if (vertex !== undefined)
					policies[receiver]?.observe({ ...(vertex as object), author, epoch: vertex.epoch } as never);
			},
		});
		const peers: Awaited<ReturnType<typeof fixture.open>>[] = [];
		for (let index = 0; index <= writers; index++) peers.push(await fixture.open(index));
		const creatorPeer = required(peers[0]).peerId;
		// HARNESS ARTIFACT GUARD (as realtime-scorecard-rate-native): a member's snapshot pulls share one
		// process-wide session bound (SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS), so in-process members installing
		// the same successor at once refuse each other; separate devices never share it. Members install
		// one at a time, so the last member's install time here is the serialized sum.
		let installTail: Promise<void> = Promise.resolve();
		const budget = Object.freeze({ ...GRID_ROLLOVER_BUDGET, movesPerAuthor: MOVES_PER_EPOCH, idleMs: 3_600_000 });
		for (const [index, peer] of peers.entries()) {
			const role = index === 0 ? "creator" : "member";
			const delivery = createV3RoomSuccessorDelivery({
				role,
				objectId: fixture.objectId,
				creatorPeer,
				channel: createV3RoomSuccessorChannel(network.successorNode(peer.peerId), fixture.objectId),
				hooks: {
					onRefused: (error) => errors.push(`delivery ${index}: ${errorText(error)}`),
					onInstalled: (epoch) => {
						(installedAt[epoch] ??= [])[index] = performance.now();
					},
				},
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
						rollovers.push({ epoch: event.epoch, successorEpoch: event.successorEpoch, at: performance.now() }),
				},
			});
			policies[index] = policy;
			policy.bind(peer.room as never);
			const room = peer.room;
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
		const epochOf = (index: number) => peers[index]!.room.authority()?.epoch ?? 0;
		const lagging: number[][] = [];
		for (let round = 0; round < ROLLOVERS; round++) {
			const from = epochOf(0);
			// Every author's moves of this epoch; the creator rolls on the budget.
			for (let move = 0; move < MOVES_PER_EPOCH && epochOf(0) === from; move++)
				for (let index = 0; index <= writers && epochOf(0) === from; index++)
					await required(policies[index]).issue({
						action: "placeBlock",
						id: `p${index}-${move % 8}`,
						kind: "stone",
						x: round * 16 + move,
						y: index,
					});
			await required(policies[0]).settled();
			const target = epochOf(0);
			expect(target, "the creator rolled over on its budget").toBeGreaterThan(from);
			// Every member installs the published successor within the bound.
			const deadline = performance.now() + INSTALL_BOUND_MS;
			const behind = () => peers.map((_, index) => index).filter((index) => index > 0 && epochOf(index) < target);
			while (behind().length > 0 && performance.now() < deadline) await sleep(100);
			lagging.push(behind());
			if (behind().length > 0) break;
		}
		const lastInstallMs = rollovers.map((rollover) => {
			const times = (installedAt[rollover.successorEpoch] ?? []).filter((value): value is number => value !== undefined);
			return times.length === 0 ? null : Math.round(Math.max(...times) - rollover.at);
		});
		process.stdout.write(
			`MANY_WRITERS ${JSON.stringify({
				writers,
				rollovers: rollovers.map(({ epoch, successorEpoch }) => [epoch, successorEpoch]),
				installedPerEpoch: rollovers.map((rollover) => (installedAt[rollover.successorEpoch] ?? []).filter(Boolean).length),
				lastInstallMs,
				lagging,
				epochs: peers.map((_, index) => epochOf(index)),
				errors: errors.slice(0, 8),
			})}\n`
		);
		expect(lagging.every((behind) => behind.length === 0), "every member installed every successor").toBe(true);
		expect(rollovers.length).toBeGreaterThanOrEqual(ROLLOVERS);
		// HARNESS ARTIFACT: in-process members share one snapshot session bound; the delivery backs off and retries.
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
}

it("five Writers: every Writer installs every successor (the creator serves a fifth member)", () => manyWriters(5), 900_000);

it("eight Writers: every Writer installs every successor", () => manyWriters(8), 1_200_000);

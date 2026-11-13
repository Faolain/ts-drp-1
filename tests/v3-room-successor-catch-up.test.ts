import { encodeCanonical } from "@ts-drp/canonical";
import { afterEach, expect, it } from "vitest";

import {
	createV3RoomSuccessorDelivery,
	V3_ROOM_SUCCESSOR_CATCH_UP_GRACE_MS,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/successor-delivery.js";

// The creator serves its room's current successor, not only the one its policy last handed over
// (see tests/app-rollover-unpublished-adoption-native.test.ts for the native case). Fake rooms on an
// in-memory channel: the creator room adopts epoch 2 outside its policy (its own interrupted-close
// retry), and a member at epoch 1 pulls.

const deliveries: V3RoomSuccessorDelivery[] = [];
afterEach(() => {
	for (const delivery of deliveries.splice(0)) delivery.close();
});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function channelPair(): [V3RoomSuccessorChannel, V3RoomSuccessorChannel] {
	const listeners = [new Set<(sender: string, bytes: Uint8Array) => void>(), new Set<(sender: string, bytes: Uint8Array) => void>()];
	const ids = ["creator-peer", "member-peer"] as const;
	const channel = (index: 0 | 1): V3RoomSuccessorChannel => ({
		localPeerId: ids[index],
		peers: () => [ids[1 - index] as string],
		send: (_peer, bytes) => {
			const copy = Uint8Array.from(bytes);
			setTimeout(() => {
				for (const listener of listeners[1 - index]!) listener(ids[index], copy);
			}, 2);
			return Promise.resolve();
		},
		listen: (listener) => {
			listeners[index]!.add(listener);
			return () => listeners[index]!.delete(listener);
		},
		onPeerConnected: () => () => undefined,
		close: () => listeners[index]!.clear(),
	});
	return [channel(0), channel(1)];
}

const offerFor = (successorEpoch: number) =>
	Object.freeze({
		exactCanonicalCutValueBytes: encodeCanonical({ epoch: successorEpoch - 1 }),
		exactCanonicalCommitQcBytes: new Uint8Array([successorEpoch]),
		exactCanonicalTrustStateRecordBytes: encodeCanonical({ currentEpoch: successorEpoch }),
		exactCanonicalSnapshotManifestBytes: new Uint8Array([successorEpoch, 4]),
	});

/** A creator room at epoch 1 (its offer published) whose export is scripted, and a member at 1. */
async function pair(input: Readonly<{ exportFails?: number; pollMs?: number }> = {}) {
	const [creatorChannel, memberChannel] = channelPair();
	let creatorEpoch = 1;
	let memberEpoch = 1;
	let exportFails = input.exportFails ?? 0;
	const calls = { exports: 0, installs: [] as number[] };
	const creator = createV3RoomSuccessorDelivery({
		role: "creator",
		objectId: "creator-peer:catch-up",
		channel: creatorChannel,
		creatorPeer: "creator-peer",
	});
	const member = createV3RoomSuccessorDelivery({
		role: "member",
		objectId: "creator-peer:catch-up",
		channel: memberChannel,
		creatorPeer: "creator-peer",
		pollMs: input.pollMs ?? 500,
	});
	deliveries.push(creator, member);
	creator.bind({
		authority: () => ({ epoch: creatorEpoch }),
		connectedPeers: () => ["member-peer"],
		installCreatorSuccessor: () => Promise.reject(new Error("a creator never installs")),
		exportCreatorSuccessor: async () => {
			calls.exports++;
			if (exportFails > 0) {
				exportFails--;
				throw new TypeError("creator successor transport is unavailable");
			}
			return offerFor(creatorEpoch);
		},
	} as never);
	await creator.publish(offerFor(1), 1);
	member.bind({
		authority: () => ({ epoch: memberEpoch }),
		connectedPeers: () => ["creator-peer"],
		installCreatorSuccessor: async (request: { offer: ReturnType<typeof offerFor> }) => {
			const epoch = request.offer.exactCanonicalCommitQcBytes[0]!;
			calls.installs.push(epoch);
			memberEpoch = epoch;
		},
	} as never);
	return {
		creator,
		member,
		calls,
		adoptOutsidePolicy: () => {
			creatorEpoch++;
		},
		memberEpoch: () => memberEpoch,
		creatorEpoch: () => creatorEpoch,
	};
}

async function until(predicate: () => boolean, withinMs: number): Promise<number | undefined> {
	const started = performance.now();
	while (!predicate()) {
		if (performance.now() - started > withinMs) return undefined;
		await sleep(20);
	}
	return Math.round(performance.now() - started);
}

it("a member pulling behind a successor the room adopted outside its policy gets it, exported once, after the grace", async () => {
	const fixture = await pair();
	await sleep(50);
	fixture.adoptOutsidePolicy();
	const installedAfterMs = await until(() => fixture.memberEpoch() === 2, V3_ROOM_SUCCESSOR_CATCH_UP_GRACE_MS + 3_000);
	expect(installedAfterMs, "the member installed the room's own successor").toBeDefined();
	expect(installedAfterMs!).toBeGreaterThanOrEqual(V3_ROOM_SUCCESSOR_CATCH_UP_GRACE_MS - 100);
	expect(fixture.calls.exports, "one export for the member's pulls").toBe(1);
	expect(fixture.calls.installs).toEqual([2]);
	expect(fixture.creator.stats().caughtUp).toBe(1);
	// Current again: further pulls export nothing.
	await sleep(V3_ROOM_SUCCESSOR_CATCH_UP_GRACE_MS + 1_000);
	expect(fixture.calls.exports).toBe(1);
}, 20_000);

it("the policy's own publish within the grace is not duplicated", async () => {
	const fixture = await pair();
	await sleep(50);
	fixture.adoptOutsidePolicy();
	// The member pulls (its poll), then the policy's export lands and is published.
	await sleep(700);
	await fixture.creator.publish(offerFor(2), 2);
	expect(await until(() => fixture.memberEpoch() === 2, 3_000)).toBeDefined();
	await sleep(V3_ROOM_SUCCESSOR_CATCH_UP_GRACE_MS + 500);
	expect(fixture.calls.exports, "no catch-up export").toBe(0);
	expect(fixture.creator.stats().caughtUp).toBe(0);
}, 20_000);

it("a failed export is a typed error, retried on a later pull at the grace's pace, until the member installs", async () => {
	const fixture = await pair({ exportFails: 2 });
	await sleep(50);
	fixture.adoptOutsidePolicy();
	const installedAfterMs = await until(() => fixture.memberEpoch() === 2, 4 * V3_ROOM_SUCCESSOR_CATCH_UP_GRACE_MS + 3_000);
	expect(installedAfterMs, "the member installed after the export failures").toBeDefined();
	expect(fixture.calls.exports).toBe(3);
	expect(installedAfterMs!).toBeGreaterThanOrEqual(3 * V3_ROOM_SUCCESSOR_CATCH_UP_GRACE_MS - 100);
	expect(fixture.creator.stats().lastError).toContain("creator successor transport is unavailable");
}, 30_000);

it("a creator room with no successor past its published offer never exports, whatever members pull", async () => {
	const fixture = await pair();
	await sleep(V3_ROOM_SUCCESSOR_CATCH_UP_GRACE_MS + 1_500);
	expect(fixture.member.stats().requested).toBeGreaterThanOrEqual(2);
	expect(fixture.calls.exports).toBe(0);
}, 20_000);

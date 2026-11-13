/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { encodeCanonical } from "@ts-drp/canonical";
import { afterEach, expect, it } from "vitest";

import { createV3RoomRolloverPolicy, type V3RoomRolloverPolicy } from "../examples/v3-room/src/rollover.js";
import {
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/successor-delivery.js";

// A creator room that adopted a successor outside its rollover policy (its own retry of an
// interrupted close; see tests/app-rollover-unpublished-adoption-native.test.ts) has that successor
// published when a member pulls from behind it: the delivery reports the member (onMemberBehind),
// and the policy's publishCurrent exports and publishes it, once, never while a rollover of its
// own is in flight. Fake rooms on an in-memory channel.

const owners: { close(): void }[] = [];
afterEach(() => {
	for (const owner of owners.splice(0)) owner.close();
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

/** A creator room at epoch 1 whose seal, adoption and export are scripted. */
function creatorRoom(input: Readonly<{ exportEpochSkew?: number; sealMs?: number }> = {}) {
	let epoch = 1;
	const calls = { seals: 0, exports: [] as number[] };
	const room = {
		authority: () => ({ epoch }),
		connectedPeers: () => ["member-peer"],
		issue: () => Promise.resolve(),
		installCreatorSuccessor: () => Promise.reject(new Error("a creator never installs")),
		sealEpoch: async () => {
			calls.seals++;
			await sleep(input.sealMs ?? 0);
			return { epoch, successorEpoch: epoch + 1 };
		},
		adoptCreatorSuccessor: async () => {
			epoch++;
		},
		exportCreatorSuccessor: async () => {
			calls.exports.push(epoch);
			await sleep(20);
			return offerFor(epoch + (input.exportEpochSkew ?? 0));
		},
	};
	return {
		room,
		calls,
		/** The room's own close: its interrupted-close retry seals and adopts with no policy. */
		adoptOutsidePolicy: () => {
			epoch++;
		},
	};
}

function creatorPolicy(room: ReturnType<typeof creatorRoom>["room"], published: number[], errors: unknown[]) {
	const policy: V3RoomRolloverPolicy = createV3RoomRolloverPolicy({
		role: "creator",
		budget: { movesPerAuthor: 1_000, idleMs: 600_000 },
		hooks: {
			publishSuccessor: (_offer, epoch) => {
				published.push(epoch);
			},
			onError: (error) => errors.push(error),
		},
	});
	owners.push(policy);
	policy.bind(room as never);
	return policy;
}

it("publishCurrent exports and publishes each successor the room adopted with none published, once", async () => {
	const fixture = creatorRoom();
	const published: number[] = [];
	const errors: unknown[] = [];
	const policy = creatorPolicy(fixture.room, published, errors);
	// A reopened creator at epoch 1: no offer of this page announced it.
	await policy.publishCurrent();
	await policy.publishCurrent();
	fixture.adoptOutsidePolicy();
	await Promise.all([policy.publishCurrent(), policy.publishCurrent(), policy.publishCurrent()]);
	await policy.publishCurrent();
	expect(fixture.calls.exports, "one export per unpublished epoch, concurrent calls joined").toEqual([1, 2]);
	expect(published).toEqual([1, 2]);
	expect(errors).toEqual([]);
});

it("publishCurrent joins a rollover in flight instead of exporting its successor again", async () => {
	const fixture = creatorRoom({ sealMs: 200 });
	const published: number[] = [];
	const errors: unknown[] = [];
	const policy = creatorPolicy(fixture.room, published, errors);
	await policy.publishCurrent();
	// A move refused at a capacity a rollover clears starts the policy's own rollover.
	policy.refused("ISSUANCE_CAPACITY_FORECAST_EXCEEDED");
	await sleep(50);
	expect(fixture.calls.seals).toBe(1);
	await policy.publishCurrent();
	await policy.settled();
	await policy.publishCurrent();
	expect(fixture.calls.exports, "the rollover's own export only").toEqual([1, 2]);
	expect(published).toEqual([1, 2]);
	expect(errors).toEqual([]);
});

it("an export for another epoch is a typed error and publishes nothing", async () => {
	const fixture = creatorRoom({ exportEpochSkew: 1 });
	const published: number[] = [];
	const errors: unknown[] = [];
	const policy = creatorPolicy(fixture.room, published, errors);
	await policy.publishCurrent();
	expect(published).toEqual([]);
	expect(errors).toHaveLength(1);
	expect(errors[0]).toBeInstanceOf(TypeError);
	expect(String(errors[0])).toContain("v3 room successor export is for epoch 2, the room is at 1");
});

it("a member pulling from behind a successor its creator room adopted outside the policy installs it, with the creator idle", async () => {
	const [creatorChannel, memberChannel] = channelPair();
	const fixture = creatorRoom();
	const published: number[] = [];
	const errors: unknown[] = [];
	let policy: V3RoomRolloverPolicy | undefined;
	const creator: V3RoomSuccessorDelivery = createV3RoomSuccessorDelivery({
		role: "creator",
		objectId: "creator-peer:catch-up",
		channel: creatorChannel,
		creatorPeer: "creator-peer",
		hooks: { onMemberBehind: () => void policy?.publishCurrent(), onError: (error) => errors.push(error) },
	});
	owners.push(creator);
	policy = createV3RoomRolloverPolicy({
		role: "creator",
		budget: { movesPerAuthor: 1_000, idleMs: 600_000 },
		hooks: {
			publishSuccessor: (offer, epoch) => {
				published.push(epoch);
				return creator.publish(offer, epoch);
			},
			onError: (error) => errors.push(error),
		},
	});
	owners.push(policy);
	policy.bind(fixture.room as never);
	creator.bind(fixture.room as never);
	let memberEpoch = 1;
	const member = createV3RoomSuccessorDelivery({
		role: "member",
		objectId: "creator-peer:catch-up",
		channel: memberChannel,
		creatorPeer: "creator-peer",
		pollMs: 300,
	});
	owners.push(member);
	member.bind({
		authority: () => ({ epoch: memberEpoch }),
		connectedPeers: () => ["creator-peer"],
		installCreatorSuccessor: async (request: { offer: ReturnType<typeof offerFor> }) => {
			memberEpoch = request.offer.exactCanonicalCommitQcBytes[0]!;
		},
	} as never);
	await sleep(700);
	expect(creator.stats().behind, "a member at the creator's epoch is not behind").toBe(0);
	fixture.adoptOutsidePolicy();
	const started = performance.now();
	while (memberEpoch !== 2 && performance.now() - started < 5_000) await sleep(20);
	expect(memberEpoch, "the member installed the room's own successor").toBe(2);
	expect(Math.round(performance.now() - started), "within one member poll and an export").toBeLessThan(2_000);
	expect(fixture.calls.exports).toEqual([2]);
	expect(published).toEqual([2]);
	expect(creator.stats().behind).toBeGreaterThanOrEqual(1);
	// Current again: later pulls report nothing and export nothing.
	const behind = creator.stats().behind;
	await sleep(1_000);
	expect(creator.stats().behind).toBe(behind);
	expect(fixture.calls.exports).toEqual([2]);
	expect(errors).toEqual([]);
}, 20_000);

it("a successor the room reports adopting by itself (onAdopted) is published at once, with no member pull", async () => {
	const fixture = creatorRoom();
	const listeners = new Set<(adoption: { epoch: number; source: "retry" }) => void>();
	const room = {
		...fixture.room,
		onAdopted: (listener: (adoption: { epoch: number; source: "retry" }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const published: number[] = [];
	const errors: unknown[] = [];
	const policy = creatorPolicy(room as never, published, errors);
	expect(listeners.size, "the creator policy subscribes at bind").toBe(1);
	await policy.publishCurrent();
	fixture.adoptOutsidePolicy();
	const started = performance.now();
	for (const listener of listeners) listener({ epoch: 2, source: "retry" });
	await policy.settled();
	expect(published).toEqual([1, 2]);
	expect(performance.now() - started, "an export, no poll").toBeLessThan(500);
	expect(fixture.calls.exports).toEqual([1, 2]);
	policy.close();
	expect(listeners.size, "closing the policy unsubscribes").toBe(0);
	expect(errors).toEqual([]);
});

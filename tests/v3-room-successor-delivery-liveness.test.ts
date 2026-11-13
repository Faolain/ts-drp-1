import { afterEach, expect, it } from "vitest";

import {
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/successor-delivery.js";

// Successor-delivery liveness (browser Grid at a447a40c, .logs/realtime-resume-2026-11-10/browser-grid/fps-gbd1):
// the creator announced 33 successors over 34 adoptions, the member's delivery failed with "The dial
// request has no valid addresses for peer", and the member stayed one epoch behind for good. The creator
// went idle once play stopped, so no later announcement came. A member that missed an announcement
// pulls the creator's latest offer itself. That pull must survive a failed send and a creator missing
// from the channel's peer list, at a bounded pace, until the member installs: with the creator idle
// afterwards. A fake room and an in-memory channel.

const deliveries: V3RoomSuccessorDelivery[] = [];
afterEach(() => {
	for (const delivery of deliveries.splice(0)) delivery.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A typed dial refusal, as libp2p reports one (NoValidAddressesError). */
class NoValidAddressesError extends Error {
	constructor(peer: string) {
		super(`The dial request has no valid addresses for peer: ${peer}`);
		this.name = "NoValidAddressesError";
	}
}

type Link = {
	/** Member sends to refuse (a dial error), counted down. */
	failMemberSends: number;
	/** Creator sends to drop with a dial error, counted down (a missed announcement). */
	failCreatorSends: number;
	/** Whether the member's channel lists the creator as connected. */
	memberSeesCreator: boolean;
	memberSends: number;
};

/** Two channels joined in memory, with scripted send failures and peer visibility. */
function channelPair(link: Link): [V3RoomSuccessorChannel, V3RoomSuccessorChannel] {
	const listeners: [Set<(sender: string, bytes: Uint8Array) => void>, Set<(sender: string, bytes: Uint8Array) => void>] = [
		new Set(),
		new Set(),
	];
	const ids = ["creator-peer", "member-peer"] as const;
	const channel = (index: 0 | 1): V3RoomSuccessorChannel => ({
		localPeerId: ids[index],
		peers: () => (index === 1 && !link.memberSeesCreator ? [] : [ids[1 - index] as string]),
		send: (peer, bytes) => {
			if (index === 1) {
				link.memberSends++;
				if (link.failMemberSends > 0) {
					link.failMemberSends--;
					return Promise.reject(new NoValidAddressesError(peer));
				}
			} else if (link.failCreatorSends > 0) {
				link.failCreatorSends--;
				return Promise.reject(new NoValidAddressesError(peer));
			}
			const copy = Uint8Array.from(bytes);
			setTimeout(() => {
				for (const listener of listeners[1 - index]!) listener(ids[index], copy);
			}, 5);
			return Promise.resolve();
		},
		listen: (listener) => {
			listeners[index].add(listener);
			return () => listeners[index].delete(listener);
		},
		onPeerConnected: () => () => undefined,
		close: () => listeners[index].clear(),
	});
	return [channel(0), channel(1)];
}

const OFFER = Object.freeze({
	exactCanonicalCutValueBytes: new Uint8Array([1]),
	exactCanonicalCommitQcBytes: new Uint8Array([2]),
	exactCanonicalTrustStateRecordBytes: new Uint8Array([3]),
	exactCanonicalSnapshotManifestBytes: new Uint8Array([4]),
});

/**
 * A creator at epoch 1 that announced once (the announcement lost) and then stays idle, and a member
 * at epoch 0 whose first pulls fail. Returns how long the member took to install, or undefined.
 * @param link - The scripted link.
 * @param withinMs - How long to wait.
 * @returns The install time in ms, the member's stats and the link.
 */
async function strandedMember(link: Link, withinMs: number) {
	const [creatorChannel, memberChannel] = channelPair(link);
	const creator = createV3RoomSuccessorDelivery({
		role: "creator",
		objectId: "creator:liveness",
		channel: creatorChannel,
		creatorPeer: "creator-peer",
	});
	// The page's default slow poll: the member's only timer today.
	const member = createV3RoomSuccessorDelivery({
		role: "member",
		objectId: "creator:liveness",
		channel: memberChannel,
		creatorPeer: "creator-peer",
	});
	deliveries.push(creator, member);
	let epoch = 0;
	const room = {
		authority: () => ({ epoch }),
		connectedPeers: () => ["creator-peer"],
		installCreatorSuccessor: async () => {
			epoch = 1;
		},
	};
	creator.bind({ authority: () => ({ epoch: 1 }), connectedPeers: () => ["member-peer"] } as never);
	member.bind(room as never);
	// The announcement of epoch 1 is lost; the creator is idle from here on.
	await creator.publish(OFFER, 1);
	const started = performance.now();
	const deadline = started + withinMs;
	while (epoch !== 1 && performance.now() < deadline) await sleep(20);
	return { installedAfterMs: epoch === 1 ? Math.round(performance.now() - started) : undefined, stats: member.stats() };
}

it("a member whose pulls fail with a dial error still installs within a bounded time while the creator is idle", async () => {
	// The bind-time pull and the first retry fail; the announcement was lost.
	const link: Link = { failMemberSends: 2, failCreatorSends: 1, memberSeesCreator: true, memberSends: 0 };
	const result = await strandedMember(link, 8_000);
	console.log(`DELIVERY_LIVENESS dial-error ${JSON.stringify({ ...result, memberSends: link.memberSends })}`);
	expect(result.installedAfterMs, "the member installed the creator's successor").toBeDefined();
	expect(result.installedAfterMs!).toBeLessThan(8_000);
	// Bounded pace: a handful of attempts, not a tight loop.
	expect(link.memberSends).toBeLessThanOrEqual(6);
	expect(result.stats.lastError).toContain("no valid addresses");
}, 30_000);

it("a member whose channel does not list the creator still pulls, and installs once a send gets through", async () => {
	// The creator's direct connection is gone from the peer list (a relayed or lost connection); a
	// send can still dial it. Today the member skips every pull while the creator is not listed.
	const link: Link = { failMemberSends: 1, failCreatorSends: 1, memberSeesCreator: false, memberSends: 0 };
	const result = await strandedMember(link, 8_000);
	console.log(`DELIVERY_LIVENESS unlisted ${JSON.stringify({ ...result, memberSends: link.memberSends })}`);
	expect(result.installedAfterMs, "the member installed the creator's successor").toBeDefined();
	expect(link.memberSends).toBeLessThanOrEqual(6);
}, 30_000);

it("a member that keeps failing retries at a bounded pace: no more than one pull per second, backing off to the poll", async () => {
	const link: Link = { failMemberSends: 1_000, failCreatorSends: 1, memberSeesCreator: true, memberSends: 0 };
	const result = await strandedMember(link, 6_000);
	expect(result.installedAfterMs).toBeUndefined();
	// 1 s, 2 s, 4 s ... from the bind-time pull: at most 4 sends in 6 s, and at least 2 (it does retry).
	expect(link.memberSends).toBeGreaterThanOrEqual(2);
	expect(link.memberSends).toBeLessThanOrEqual(4);
}, 30_000);

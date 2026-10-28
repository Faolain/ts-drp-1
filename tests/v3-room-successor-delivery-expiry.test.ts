import { afterEach, expect, it } from "vitest";

import {
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/successor-delivery.js";

// Row 72, the owner's decision (2026-10-27): a member's install ends after a bounded total deadline
// over the material fetch with a typed refusal (V3RoomSuccessorInstallExpired, stage "material").
// The page's delivery then re-targets the newest offer at once, as it does for a stale refusal, and
// never gives up following: when the newest offer is the same one, it installs it again, with each
// refusal visible. It must not hold that offer in the forged/stale backoff (2, 5, 15, 30 s): the
// install already waited its whole deadline. A fake room and an in-memory channel; the room's
// install refuses with the expiry three times, then installs.

const deliveries: V3RoomSuccessorDelivery[] = [];
afterEach(() => {
	for (const delivery of deliveries.splice(0)) delivery.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Two channels joined in memory: what one sends, the other's listeners receive. */
function channelPair(): [V3RoomSuccessorChannel, V3RoomSuccessorChannel] {
	const listeners: [Set<(sender: string, bytes: Uint8Array) => void>, Set<(sender: string, bytes: Uint8Array) => void>] = [
		new Set(),
		new Set(),
	];
	const ids = ["creator-peer", "member-peer"] as const;
	const channel = (index: 0 | 1): V3RoomSuccessorChannel => ({
		localPeerId: ids[index],
		peers: () => [ids[1 - index] as string],
		send: (_peer, bytes) => {
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

class V3RoomSuccessorInstallExpired extends TypeError {
	readonly stage = "material" as const;
	constructor() {
		super("v3 room successor install expired: the material was not served within 120000 ms");
		this.name = "V3RoomSuccessorInstallExpired";
	}
}

it("an install that expires is retried at once from the newest offer, the same one included, until it installs", async () => {
	const [creatorChannel, memberChannel] = channelPair();
	const creator = createV3RoomSuccessorDelivery({
		role: "creator",
		objectId: "creator:expiry",
		channel: creatorChannel,
		creatorPeer: "creator-peer",
	});
	const refusals: unknown[] = [];
	const member = createV3RoomSuccessorDelivery({
		role: "member",
		objectId: "creator:expiry",
		channel: memberChannel,
		creatorPeer: "creator-peer",
		pollMs: 600_000,
		hooks: { onRefused: (error) => refusals.push(error) },
	});
	deliveries.push(creator, member);
	let epoch = 0;
	const attempts: number[] = [];
	const failures: number[] = [];
	const room = {
		authority: () => ({ epoch }),
		connectedPeers: () => ["creator-peer"],
		installCreatorSuccessor: async () => {
			attempts.push(performance.now());
			await sleep(20);
			if (attempts.length <= 3) {
				failures.push(performance.now());
				throw new V3RoomSuccessorInstallExpired();
			}
			epoch = 1;
		},
	};
	creator.bind({ authority: () => ({ epoch: 1 }), connectedPeers: () => ["member-peer"] } as never);
	await creator.publish(
		Object.freeze({
			exactCanonicalCutValueBytes: new Uint8Array([1]),
			exactCanonicalCommitQcBytes: new Uint8Array([2]),
			exactCanonicalTrustStateRecordBytes: new Uint8Array([3]),
			exactCanonicalSnapshotManifestBytes: new Uint8Array([4]),
		}),
		1
	);
	member.bind(room as never);
	const deadline = performance.now() + 20_000;
	while (epoch !== 1 && performance.now() < deadline) await sleep(20);
	const gaps = failures.map((at, index) => Math.round((attempts[index + 1] ?? Number.NaN) - at));
	console.log(`DELIVERY_EXPIRY ${JSON.stringify({ attempts: attempts.length, gaps, stats: member.stats() })}`);
	expect(epoch, "the member installed the offer").toBe(1);
	expect(attempts).toHaveLength(4);
	// Each re-install follows its refusal at the request pace (1 s), never the 2/5/15 s backoff.
	for (const gap of gaps) expect(gap).toBeLessThan(1_800);
	expect(refusals.map((error) => (error as Error).name)).toEqual([
		"V3RoomSuccessorInstallExpired",
		"V3RoomSuccessorInstallExpired",
		"V3RoomSuccessorInstallExpired",
	]);
	expect(member.stats().refused).toBe(3);
}, 60_000);

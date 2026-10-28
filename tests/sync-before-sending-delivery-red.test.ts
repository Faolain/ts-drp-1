/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles: inferred shapes. */
import { afterEach, expect, it } from "vitest";

import {
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/index.js";

// Owner decision B (sync before sending), page side: a member's successor delivery asks the
// creator when it binds; the creator, which defines the current epoch, answers a member already at
// its epoch with its currency statement (current epoch, anchor, admitted frontiers) instead of
// staying silent, and the member hands that statement, received from the creator's authenticated
// peer in answer to its own request, to its room (confirmCurrent). A member behind the creator's
// epoch still gets the creator's latest offer and installs it. In-memory channel and room doubles.

type Listener = (sender: string, bytes: Uint8Array) => void;
const deliveries = new Set<V3RoomSuccessorDelivery>();
afterEach(() => {
	for (const delivery of deliveries) delivery.close();
	deliveries.clear();
});

function network() {
	const listeners = new Map<string, Set<Listener>>();
	const channel = (localPeerId: string, peers: readonly string[]): V3RoomSuccessorChannel => ({
		localPeerId,
		peers: () => peers,
		send: async (peerId, bytes) => {
			await Promise.resolve();
			for (const listener of listeners.get(peerId) ?? []) listener(localPeerId, bytes);
		},
		listen: (listener) => {
			const set = listeners.get(localPeerId) ?? new Set();
			set.add(listener);
			listeners.set(localPeerId, set);
			return () => set.delete(listener);
		},
		onPeerConnected: () => () => undefined,
		close: () => undefined,
	});
	return { channel };
}

const statement = (epoch: number) =>
	Object.freeze({
		objectId: "creator:room",
		epoch,
		anchorDigest: "ab".repeat(32),
		frontiers: Object.freeze([Object.freeze(["b0".repeat(32), 4] as const)]),
	});

function creatorRoom(epoch: number) {
	return {
		authority: () => ({ epoch }) as never,
		connectedPeers: () => ["member"],
		installCreatorSuccessor: () => Promise.reject(new Error("creator does not install")),
		currencyStatement: () => statement(epoch),
	};
}

function memberRoom(epoch: number) {
	const confirmed: unknown[] = [];
	let current = false;
	return {
		confirmed,
		authority: () => (epoch === 0 ? null : ({ epoch } as never)),
		connectedPeers: () => ["creator"],
		installCreatorSuccessor: () => Promise.resolve(),
		localIssueCurrency: () => (current ? ("current" as const) : ("not-yet-current" as const)),
		confirmCurrent: async (value: unknown) => {
			confirmed.push(value);
			current = true;
			return "current" as const;
		},
	};
}

async function until(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function pair(creatorEpoch: number, memberEpoch: number) {
	const net = network();
	const creator = createV3RoomSuccessorDelivery({
		role: "creator",
		objectId: "creator:room",
		channel: net.channel("creator", ["member"]),
	});
	const member = createV3RoomSuccessorDelivery({
		role: "member",
		objectId: "creator:room",
		channel: net.channel("member", ["creator"]),
		pollMs: 60_000,
	});
	deliveries.add(creator);
	deliveries.add(member);
	const rooms = { creator: creatorRoom(creatorEpoch), member: memberRoom(memberEpoch) };
	creator.bind(rooms.creator);
	return { creator, member, rooms };
}

it("[RED] a member at the creator's epoch receives the creator's currency statement and confirms it", async () => {
	const { member, rooms } = pair(3, 3);
	member.bind(rooms.member);
	await until(() => rooms.member.confirmed.length > 0, "member confirmed the statement");
	expect(rooms.member.confirmed).toEqual([statement(3)]);
	expect(rooms.member.localIssueCurrency()).toBe("current");
});

it("[control] a member behind the creator's epoch does not confirm a statement for another epoch", async () => {
	const { member, rooms } = pair(3, 1);
	member.bind(rooms.member);
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(rooms.member.confirmed).toEqual([]);
	expect(member.stats()).toMatchObject({ requested: 1 });
});

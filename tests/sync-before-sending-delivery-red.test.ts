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

// Live install rule: a member behind the creator installs only with the creator's statement for
// the offered epoch. The creator answers a behind member's request with its statement and then the
// offer, in the same answer; the member installs with that statement (no extra round trip).
const offer = Object.freeze({
	exactCanonicalCutValueBytes: new Uint8Array([1]),
	exactCanonicalCommitQcBytes: new Uint8Array([2]),
	exactCanonicalTrustStateRecordBytes: new Uint8Array([3]),
	exactCanonicalSnapshotManifestBytes: new Uint8Array([4]),
});

function installingMember(epoch: number, refuseWithoutStatement = false) {
	const installs: { currency: unknown }[] = [];
	let installed = epoch;
	return {
		installs,
		authority: () => (installed === 0 ? null : ({ epoch: installed } as never)),
		connectedPeers: () => ["creator"],
		localIssueCurrency: () => "not-yet-current" as const,
		confirmCurrent: async () => "other-epoch" as const,
		installCreatorSuccessor: async (input: { currency?: unknown }) => {
			installs.push({ currency: input.currency });
			if (refuseWithoutStatement && input.currency === undefined)
				throw Object.assign(new TypeError("V3_ROOM_NOT_YET_CURRENT: statement-required"), { reason: "statement-required" });
			installed = 3;
		},
	};
}

it("a member behind the creator installs the answered offer with the creator's statement for that epoch", async () => {
	const { creator, member } = pair(3, 1);
	await creator.publish(offer as never, 3);
	const room = installingMember(1);
	member.bind(room as never);
	await until(() => room.installs.length > 0, "member installed");
	await member.idle();
	expect(room.installs).toEqual([{ currency: statement(3) }]);
	expect(creator.stats()).toMatchObject({ answered: 1, currencyAnswered: 1 });
});

it("an offer refused only for want of the statement installs as soon as the statement arrives", async () => {
	const net = network();
	const creatorChannel = net.channel("creator", ["member"]);
	const member = createV3RoomSuccessorDelivery({
		role: "member",
		objectId: "creator:room",
		channel: net.channel("member", ["creator"]),
		creatorPeer: "creator",
		pollMs: 60_000,
	});
	deliveries.add(member);
	const room = installingMember(1, true);
	member.bind(room as never);
	// The offer arrives first (out of order), then the statement.
	const { encodeCanonical } = await import("@ts-drp/canonical");
	const limits = { maxBytes: 1 << 20, maxDepth: 3, maxItems: 64 };
	await creatorChannel.send(
		"member",
		encodeCanonical(
			{ kind: "ts-drp-v3-successor-offer", version: 1, successorEpoch: 3, cut: new Uint8Array([1]), qc: new Uint8Array([2]),
				trust: new Uint8Array([3]), manifest: new Uint8Array([4]) },
			limits
		),
		new AbortController().signal
	);
	await until(() => room.installs.length === 1, "refused install");
	await member.idle();
	const value = statement(3);
	await creatorChannel.send(
		"member",
		encodeCanonical(
			{ kind: "ts-drp-v3-room-currency", version: 1, objectId: value.objectId, epoch: value.epoch,
				anchorDigest: value.anchorDigest, frontiers: value.frontiers.map(([author, through]) => [author, through]) },
			limits
		),
		new AbortController().signal
	);
	await until(() => room.installs.length === 2, "retried install");
	await member.idle();
	expect(room.installs).toEqual([{ currency: undefined }, { currency: statement(3) }]);
	expect(member.stats()).toMatchObject({ installed: 1, refused: 1 });
});

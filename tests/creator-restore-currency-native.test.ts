/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { encodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import {
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/index.js";
import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";

// Creator restore currency (user decision 2026-11-10). A creator device restored from an old
// backup still holds the room's creator key; the original device (or the room's members) moved
// on. Before it signs anything, a creator that reopened from storage asks the room's members for
// their view (the shipped successor delivery's member-view request) and waits a bounded time. A
// member answers with creator-signed material it holds: its current epoch anchor, and the highest
// creator vertex it accepted. If verified evidence shows a later epoch, or a creator vertex at or
// above the creator's local next sequence, the creator refuses (V3RoomNotYetCurrent
// "creator-superseded"), signs nothing, and stays refused for the session. With no member
// answering within the bound it proceeds (a lone creator must keep its room usable). Unsigned or
// forged evidence never locks the creator out. Native SQLite rooms, the genuine delivery over an
// in-memory channel.

afterEach(async () => {
	for (const delivery of deliveries) delivery.close();
	deliveries.clear();
	expect(await closeChatSharesRooms()).toEqual([]);
});

const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const settle = <T>(task: Promise<T>) =>
	task.then(
		() => "issued",
		(error: unknown) => String((error as Error)?.message ?? error)
	);
const CREATOR_PEER = "chat-creator";
const MEMBER_PEER = "chat-member-1";

type Listener = (sender: string, bytes: Uint8Array) => void;
const deliveries = new Set<V3RoomSuccessorDelivery>();

/** In-memory successor channels; `connected` lists the peers each peer sees. */
function network() {
	const listeners = new Map<string, Set<Listener>>();
	const connected = new Map<string, Set<string>>();
	const link = (left: string, right: string) => {
		(connected.get(left) ?? connected.set(left, new Set()).get(left)!).add(right);
		(connected.get(right) ?? connected.set(right, new Set()).get(right)!).add(left);
	};
	const channel = (localPeerId: string): V3RoomSuccessorChannel => ({
		localPeerId,
		peers: () => [...(connected.get(localPeerId) ?? [])],
		send: async (peerId, bytes) => {
			await Promise.resolve();
			if (!connected.get(localPeerId)?.has(peerId)) throw new Error("not connected");
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
	return { channel, link, listeners };
}

/** The creator-side delivery whose member view a reopened creator is opened with. */
function creatorDelivery(net: ReturnType<typeof network>, objectId: string) {
	const delivery = createV3RoomSuccessorDelivery({ role: "creator", objectId, channel: net.channel(CREATOR_PEER) });
	deliveries.add(delivery);
	return delivery;
}

/** A member's delivery bound to its open room: it answers the creator's member-view request. */
function memberDelivery(net: ReturnType<typeof network>, objectId: string, room: unknown) {
	const delivery = createV3RoomSuccessorDelivery({
		role: "member",
		objectId,
		creatorPeer: CREATOR_PEER,
		channel: net.channel(MEMBER_PEER),
		pollMs: 600_000,
	});
	deliveries.add(delivery);
	delivery.bind(room as never);
	return delivery;
}

const memberView = (delivery: V3RoomSuccessorDelivery) => Reflect.get(delivery, "creatorMemberView") as unknown;

// The node host names each store file sha256(JSON([family, name])); the floor is the fixture's own file.
const FAMILIES = ["ahe", "issuance", "journal", "snapshots", "signing", "room-head"];
const peerFile = (peer: number) => {
	const prefixes = FAMILIES.flatMap((family) =>
		[`peer-${peer}`, `peer-${peer}--ahe`].map((name) =>
			createHash("sha256").update(JSON.stringify([family, name])).digest("hex")
		)
	);
	return (file: string) => file.startsWith(`peer-${peer}-`) || prefixes.some((prefix) => file.startsWith(prefix));
};
const files = (directory: string) => readdirSync(directory).filter((file) => statSync(join(directory, file)).isFile());

async function room() {
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const net = network();
	return { f, net };
}

/**
 * The creator issues, is backed up (every file of its device, closed), reopens as the original
 * device and a member joins. Returns the backup's restore and the creator's signed rows.
 */
async function backedUpCreator() {
	const { f, net } = await room();
	let creator = await f.open(0);
	await creator.room.issue(message("creator-before-backup"));
	await f.stop(creator);
	const creatorFile = peerFile(0);
	const backed = files(f.directory).filter(creatorFile);
	expect(backed.length).toBeGreaterThan(0);
	const backup = join(f.directory, "creator-backup");
	mkdirSync(backup);
	for (const file of backed) copyFileSync(join(f.directory, file), join(backup, file));
	const backupRows = await f.issuedAfter(0, null);
	creator = await f.open(0, { reopen: true });
	const member = await f.open(1);
	/** Replaces the creator device's files with the backup (the original device is stopped). */
	const restore = () => {
		for (const file of files(f.directory).filter(creatorFile)) rmSync(join(f.directory, file));
		for (const file of backed) copyFileSync(join(backup, file), join(f.directory, file));
		// Every remaining file is the member's or the backup's: nothing of the original survived.
		expect(files(f.directory).filter((file) => !peerFile(1)(file) && !backed.includes(file))).toEqual([]);
	};
	return { f, net, creator, member, restore, backupNext: backupRows.length };
}

/** Every creator row now in the creator's outbox whose sequence the original signed with a different digest. */
async function conflictingWith(f: Awaited<ReturnType<typeof room>>["f"], original: readonly DurableIssuanceOutboxRecord[]) {
	const signed = new Map(original.map((row) => [row.commit.authorSequence, hex(row.commit.envelope.digest)]));
	return (await f.issuedAfter(0, null))
		.filter((row) => {
			const digest = signed.get(row.commit.authorSequence);
			return digest !== undefined && digest !== hex(row.commit.envelope.digest);
		})
		.map((row) => ({ authorSequence: row.commit.authorSequence, publishState: row.publishState }));
}

describe("creator restore currency: a restored creator checks the members' view before it signs", () => {
	it("[RED] a creator restored from a backup at epoch 0, reopened while a member is at epoch 2, refuses and signs nothing", async () => {
		const { f, net, creator, member, restore, backupNext } = await backedUpCreator();
		await creator.room.issue(message("original-after-backup"));
		for (let step = 0; step < 2; step++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		}
		await f.install(member);
		expect(member.room.authority()?.epoch).toBe(2);
		const original = await f.issuedAfter(0, null);
		expect(original.length).toBeGreaterThan(backupNext);
		await f.stop(creator);
		restore();
		memberDelivery(net, f.objectId, member.room);
		net.link(CREATOR_PEER, MEMBER_PEER);
		const view = creatorDelivery(net, f.objectId);
		const restored = await f.open(0, { reopen: true, creatorMemberView: memberView(view) });
		expect(restored.room.authority()?.epoch ?? 0).toBe(0);
		const attempted = await settle(restored.room.issue(message("restored-after-restore")));
		expect(await conflictingWith(f, original)).toEqual([]);
		expect(attempted).toMatch(/V3_ROOM_NOT_YET_CURRENT: creator-superseded/u);
		expect(Reflect.get(restored.room, "creatorCurrency")?.call(restored.room)).toBe("refused");
		// Sealing is signing too: refused, and the session stays readable.
		expect(await settle(restored.room.sealEpoch())).toMatch(/V3_ROOM_NOT_YET_CURRENT: creator-superseded/u);
		expect(restored.room.projection().messages.map((entry) => entry.clientOperationId)).toContain("creator-before-backup");
		// It stays refused: later moves are refused at once, never signed.
		expect(await settle(restored.room.issue(message("restored-later")))).toMatch(/creator-superseded/u);
		expect(await conflictingWith(f, original)).toEqual([]);
		expect((await f.issuedAfter(0, null)).length).toBe(backupNext);
	}, 300_000);

	it("[RED] same epoch: the original issued further moves after the backup; the restored copy refuses", async () => {
		const { f, net, creator, member, restore, backupNext } = await backedUpCreator();
		await creator.room.issue(message("original-after-backup-1"));
		await creator.room.issue(message("original-after-backup-2"));
		const original = await f.issuedAfter(0, null);
		expect(await member.receive(original, 0)).toBe(true);
		await f.stop(creator);
		restore();
		memberDelivery(net, f.objectId, member.room);
		net.link(CREATOR_PEER, MEMBER_PEER);
		const view = creatorDelivery(net, f.objectId);
		const restored = await f.open(0, { reopen: true, creatorMemberView: memberView(view) });
		const attempted = await settle(restored.room.issue(message("restored-after-restore")));
		expect(await conflictingWith(f, original)).toEqual([]);
		expect(attempted).toMatch(/V3_ROOM_NOT_YET_CURRENT: creator-superseded/u);
		expect((await f.issuedAfter(0, null)).length).toBe(backupNext);
	}, 300_000);

	it("[control] an ordinary creator reopen with a member at the same state proceeds as soon as the member answers", async () => {
		const { f, net } = await room();
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		const member = await f.open(1);
		expect(await member.receive(await f.issuedAfter(0, null), 0)).toBe(true);
		await f.stop(creator);
		memberDelivery(net, f.objectId, member.room);
		net.link(CREATOR_PEER, MEMBER_PEER);
		const view = creatorDelivery(net, f.objectId);
		const started = performance.now();
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyBoundMs: 60_000 });
		expect(await settle(creator.room.issue(message("creator-after-reopen")))).toBe("issued");
		const elapsed = Math.round(performance.now() - started);
		console.info("[creator currency] reopen with a member at the same state: open + first issue in", elapsed, "ms");
		// Far below the 60 s bound: it proceeded on the member's answer, not on the bound.
		expect(elapsed).toBeLessThan(45_000);
		expect(Reflect.get(creator.room, "creatorCurrency")?.call(creator.room) ?? "current").toBe("current");
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		expect(creator.room.authority()?.epoch).toBe(1);
	}, 300_000);

	it("[control] a creator reopening alone (no member answers) proceeds after the bound", async () => {
		const { f, net } = await room();
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		await f.stop(creator);
		const view = creatorDelivery(net, f.objectId);
		const started = performance.now();
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyBoundMs: 1_500 });
		expect(await settle(creator.room.issue(message("creator-alone")))).toBe("issued");
		console.info("[creator currency] lone reopen: open + first issue in", Math.round(performance.now() - started), "ms (bound 1500 ms)");
		expect(Reflect.get(creator.room, "creatorCurrency")?.call(creator.room) ?? "current").toBe("current");
		expect((await creator.room.sealEpoch()).ok).toBe(true);
	}, 300_000);

	it("[control] the bound counts from open: a lone creator's first move waits only the remainder", async () => {
		const bound = 6_000;
		const currency = (room: unknown): unknown => Reflect.get(room as object, "creatorCurrency")?.call(room) ?? "current";
		const { f, net } = await room();
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		await f.stop(creator);
		const view = creatorDelivery(net, f.objectId);
		const opened = performance.now();
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyBoundMs: bound });
		const openMs = performance.now() - opened;
		// No signature has been asked for: the check runs in the background from open.
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, bound - 1_000 - (performance.now() - opened))));
		const issueAt = performance.now() - opened;
		const stateAtIssue = currency(creator.room);
		const issueStarted = performance.now();
		expect(await settle(creator.room.issue(message("creator-late")))).toBe("issued");
		const issueMs = performance.now() - issueStarted;
		console.info(
			"[creator currency] bound from open:",
			JSON.stringify({ bound, openMs: Math.round(openMs), issueAt: Math.round(issueAt), stateAtIssue, issueMs: Math.round(issueMs) })
		);
		// Lazily started, the first move would wait the whole bound (>= 6 s); from open it waits about bound - issueAt.
		expect(issueMs).toBeLessThan(bound / 2);
		await f.stop(creator);
		// With no move at all, the check still decides once the bound has passed since open.
		const again = performance.now();
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyBoundMs: 1_500 });
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2_500 - (performance.now() - again))));
		expect(currency(creator.room)).toBe("current");
	}, 300_000);

	it("[control] a member presenting unsigned or forged newer evidence does not lock the creator out", async () => {
		const { f, net } = await room();
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		await f.stop(creator);
		const creatorAuthor = f.identities[0]!.author;
		const limits = { maxBytes: 120 * 1024, maxDepth: 4, maxItems: 64 };
		const forgedAnchor = encodeCanonical({
			kind: "drp-epoch-anchor", protocolMajor: 3, objectId: f.objectId, epoch: 99,
			previousAnchor: "00".repeat(32), cutDigest: "00".repeat(32), stateDigest: "00".repeat(32),
			aclDigest: "00".repeat(32), historyRoot: "00".repeat(32), historySize: 1, archiveIndexRoot: "00".repeat(32),
			blueprintDigest: "00".repeat(32), signerSetDigest: "00".repeat(32), parametersDigest: "00".repeat(32),
			profileDigest: "00".repeat(32), cryptoSuiteId: "ed25519-sha256-v3",
		});
		const forgedVertex = encodeCanonical({
			kind: "drp-vertex", protocolMajor: 3, objectId: f.objectId, epoch: 0, anchor: "00".repeat(32),
			author: creatorAuthor, authorSequence: 999, logicalTime: 9, dependencies: [], operation: { action: "x" },
		});
		const garbage = new Uint8Array(64).fill(7);
		// A forging peer: answers any request from the creator with forged evidence, and an unsigned
		// claim (a currency-like statement of a far later epoch).
		const forger = net.channel("chat-member-9");
		net.link(CREATOR_PEER, "chat-member-9");
		let requests = 0;
		forger.listen((sender) => {
			requests++;
			void forger.send(sender, encodeCanonical({ kind: "ts-drp-v3-room-creator-view", version: 1, objectId: f.objectId,
				anchor: [forgedAnchor, garbage], vertex: [forgedVertex, garbage] }, limits), new AbortController().signal);
			void forger.send(sender, encodeCanonical({ kind: "ts-drp-v3-room-currency", version: 1, objectId: f.objectId, epoch: 99,
				anchorDigest: "ab".repeat(32), frontiers: [[creatorAuthor, 999]] }, limits), new AbortController().signal);
		});
		const view = creatorDelivery(net, f.objectId);
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyBoundMs: 3_000 });
		expect(await settle(creator.room.issue(message("creator-after-forgery")))).toBe("issued");
		expect(Reflect.get(creator.room, "creatorCurrency")?.call(creator.room) ?? "current").toBe("current");
		console.info("[creator currency] forging peer asked", requests, "time(s)");
		expect((await creator.room.sealEpoch()).ok).toBe(true);
	}, 300_000);
});

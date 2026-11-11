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
// Connectivity-unresolved hold (2026-11-11): unless the stored roster names nobody else, the first
// move is held until a peer answers, the transport reports it reached nobody, or the hold passes
// from open; a peer connecting inside the hold is asked (and given its answer window) first.

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
// The shipped defaults (V3_ROOM_CREATOR_RESTORE_CURRENCY_BOUND_MS, V3_ROOM_CREATOR_RESTORE_ANSWER_BOUND_MS,
// V3_ROOM_CREATOR_RESTORE_HOLD_MS), restated so this file also loads where the hold does not exist yet.
const V3_ROOM_CREATOR_RESTORE_CURRENCY_BOUND_MS = 5_000;
const V3_ROOM_CREATOR_RESTORE_ANSWER_BOUND_MS = 1_000;
const V3_ROOM_CREATOR_RESTORE_HOLD_MS = 1_500;
const CREATOR_PEER = "chat-creator";
const MEMBER_PEER = "chat-member-1";

type Listener = (sender: string, bytes: Uint8Array) => void;
const deliveries = new Set<V3RoomSuccessorDelivery>();

/**
 * In-memory successor channels; `connected` lists the peers each peer sees. Linking two peers fires
 * both sides' connection events, as libp2p's connection:open does. `delays` holds a peer's send delay;
 * `reach` is what the creator's transport reports about its own first connection attempts.
 */
function network(options: { reach?: "reached" | "unreachable" | "none" } = {}) {
	const listeners = new Map<string, Set<Listener>>();
	const connected = new Map<string, Set<string>>();
	const connections = new Map<string, Set<(peerId: string) => void>>();
	const delays = new Map<string, number>();
	const link = (left: string, right: string) => {
		(connected.get(left) ?? connected.set(left, new Set()).get(left)!).add(right);
		(connected.get(right) ?? connected.set(right, new Set()).get(right)!).add(left);
		for (const listener of [...(connections.get(left) ?? [])]) listener(right);
		for (const listener of [...(connections.get(right) ?? [])]) listener(left);
	};
	const channel = (localPeerId: string): V3RoomSuccessorChannel => ({
		localPeerId,
		peers: () => [...(connected.get(localPeerId) ?? [])],
		send: async (peerId, bytes) => {
			await Promise.resolve();
			const delay = delays.get(localPeerId) ?? 0;
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			if (!connected.get(localPeerId)?.has(peerId)) throw new Error("not connected");
			for (const listener of listeners.get(peerId) ?? []) listener(localPeerId, bytes);
		},
		listen: (listener) => {
			const set = listeners.get(localPeerId) ?? new Set();
			set.add(listener);
			listeners.set(localPeerId, set);
			return () => set.delete(listener);
		},
		onPeerConnected: (listener) => {
			const set = connections.get(localPeerId) ?? new Set();
			set.add(listener);
			connections.set(localPeerId, set);
			return () => set.delete(listener);
		},
		...(options.reach === undefined ? {} : { initialReach: () => Promise.resolve(options.reach!) }),
		close: () => undefined,
	});
	return { channel, link, listeners, delays };
}

/** The creator-side delivery whose member view a reopened creator is opened with. */
function creatorDelivery(net: ReturnType<typeof network>, objectId: string) {
	const delivery = createV3RoomSuccessorDelivery({ role: "creator", objectId, channel: net.channel(CREATOR_PEER) });
	deliveries.add(delivery);
	return delivery;
}

/** A member's delivery bound to its open room: it answers the creator's member-view request. */
function memberDelivery(net: ReturnType<typeof network>, objectId: string, room: unknown, peer = MEMBER_PEER) {
	const delivery = createV3RoomSuccessorDelivery({
		role: "member",
		objectId,
		creatorPeer: CREATOR_PEER,
		channel: net.channel(peer),
		pollMs: 600_000,
	});
	deliveries.add(delivery);
	delivery.bind(room as never);
	return delivery;
}

const memberView = (delivery: V3RoomSuccessorDelivery) => Reflect.get(delivery, "creatorMemberView") as unknown;
const currency = (room: unknown): unknown => Reflect.get(room as object, "creatorCurrency")?.call(room) ?? "current";

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

async function room(options: { members?: readonly ("genesis" | "late")[]; reach?: "reached" | "unreachable" | "none" } = {}) {
	const f = await chatSharesRoomFixture({
		members: options.members ?? ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const net = network(options.reach === undefined ? {} : { reach: options.reach });
	return { f, net };
}

/**
 * The creator issues, is backed up (every file of its device, closed), reopens as the original
 * device and a member joins. Returns the backup's restore and the creator's signed rows.
 */
async function backedUpCreator(members: readonly "genesis"[] = ["genesis"]) {
	const { f, net } = await room({ members });
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
	const opened = [];
	for (let peer = 1; peer <= members.length; peer++) opened.push(await f.open(peer));
	const member = opened[0]!;
	/** Replaces the creator device's files with the backup (the original device is stopped). */
	const restore = () => {
		for (const file of files(f.directory).filter(creatorFile)) rmSync(join(f.directory, file));
		for (const file of backed) copyFileSync(join(backup, file), join(f.directory, file));
		// Every remaining file is a member's or the backup's: nothing of the original survived.
		const memberFile = (file: string) => opened.some((_, index) => peerFile(index + 1)(file));
		expect(files(f.directory).filter((file) => !memberFile(file) && !backed.includes(file))).toEqual([]);
	};
	return { f, net, creator, member, members: opened, restore, backupNext: backupRows.length };
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

	it("[RED-hold] a member with newer state that connects 300 ms after open: the restored creator signs nothing and is refused", async () => {
		const { f, net, creator, member, restore, backupNext } = await backedUpCreator();
		await creator.room.issue(message("original-after-backup-1"));
		await creator.room.issue(message("original-after-backup-2"));
		const original = await f.issuedAfter(0, null);
		expect(await member.receive(original, 0)).toBe(true);
		await f.stop(creator);
		restore();
		memberDelivery(net, f.objectId, member.room);
		const view = creatorDelivery(net, f.objectId);
		// Nobody connected at open; the stored roster names a member: connectivity is unresolved.
		const opened = performance.now();
		const restored = await f.open(0, { reopen: true, creatorMemberView: memberView(view) });
		const attempt = settle(restored.room.issue(message("restored-before-the-member-connects")));
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, 300 - (performance.now() - opened))));
		const stateBeforeConnect = currency(restored.room);
		const connectedAt = Math.round(performance.now() - opened);
		net.link(CREATOR_PEER, MEMBER_PEER);
		const outcome = await attempt;
		console.info("[creator currency] member connects 300 ms after open:", JSON.stringify({ stateBeforeConnect, connectedAt, outcome, decidedAt: Math.round(performance.now() - opened) }));
		expect(stateBeforeConnect).toBe("checking");
		expect(outcome).toMatch(/V3_ROOM_NOT_YET_CURRENT: creator-superseded/u);
		expect(currency(restored.room)).toBe("refused");
		// Zero creator signatures beyond the backup.
		expect(await conflictingWith(f, original)).toEqual([]);
		expect((await f.issuedAfter(0, null)).length).toBe(backupNext);
		expect(await settle(restored.room.sealEpoch())).toMatch(/V3_ROOM_NOT_YET_CURRENT: creator-superseded/u);
	}, 300_000);

	it("[control-hold] a reopen whose stored roster names nobody but the creator signs its first move at once", async () => {
		const { f, net } = await room({ members: [] });
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		await f.stop(creator);
		const view = creatorDelivery(net, f.objectId);
		const started = performance.now();
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view) });
		const opened = performance.now();
		expect(await settle(creator.room.issue(message("creator-solo")))).toBe("issued");
		const issueMs = Math.round(performance.now() - opened);
		const state = currency(creator.room);
		console.info("[creator currency] solo roster reopen:", JSON.stringify({ openMs: Math.round(opened - started), issueMs, state }));
		expect(issueMs).toBeLessThan(500);
		expect(state).toBe("provisional");
		// The finality key still waits for an attested view or the bound from open.
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		expect(Math.round(performance.now() - started)).toBeGreaterThanOrEqual(V3_ROOM_CREATOR_RESTORE_CURRENCY_BOUND_MS - 50);
	}, 300_000);

	it("[RED-hold] a roster with members and nobody reachable: the first move waits about the hold, not the 5 s bound", async () => {
		const { f, net } = await room();
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		await f.stop(creator);
		const view = creatorDelivery(net, f.objectId);
		const started = performance.now();
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view) });
		const opened = performance.now();
		expect(await settle(creator.room.issue(message("creator-alone")))).toBe("issued");
		const issuedAt = Math.round(performance.now() - started);
		const state = currency(creator.room);
		const sealStarted = performance.now();
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		const sealedAt = Math.round(performance.now() - started);
		console.info("[creator currency] roster with members, nobody reachable:", JSON.stringify({ openMs: Math.round(opened - started), issuedAt, state, sealMs: Math.round(performance.now() - sealStarted), sealedAt }));
		// Held while connectivity is unresolved (the hold counts from open, inside f.open) ...
		expect(issuedAt).toBeGreaterThanOrEqual(V3_ROOM_CREATOR_RESTORE_HOLD_MS - 50);
		// ... and not for the finality bound.
		expect(issuedAt).toBeLessThan(V3_ROOM_CREATOR_RESTORE_HOLD_MS + 1_000);
		expect(state).toBe("provisional");
		expect(sealedAt).toBeGreaterThanOrEqual(V3_ROOM_CREATOR_RESTORE_CURRENCY_BOUND_MS - 50);
		expect(currency(creator.room)).toBe("current");
	}, 300_000);

	it("[control-hold] a transport whose first connection attempts reached nobody ends the hold at once", async () => {
		const { f, net } = await room({ reach: "unreachable" });
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		await f.stop(creator);
		const view = creatorDelivery(net, f.objectId);
		const started = performance.now();
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view) });
		expect(await settle(creator.room.issue(message("creator-offline")))).toBe("issued");
		const issuedAt = Math.round(performance.now() - started);
		console.info("[creator currency] transport reached nobody:", JSON.stringify({ issuedAt, state: currency(creator.room) }));
		expect(issuedAt).toBeLessThan(V3_ROOM_CREATOR_RESTORE_HOLD_MS - 500);
		expect(currency(creator.room)).toBe("provisional");
	}, 300_000);

	it("[RED] three connected members, one with newer state answering last: the restored creator signs nothing and is refused", async () => {
		const { f, net, creator, members, restore, backupNext } = await backedUpCreator(["genesis", "genesis", "genesis"]);
		const atBackup = await f.issuedAfter(0, null);
		for (const member of members) expect(await member.receive(atBackup, 0)).toBe(true);
		await creator.room.issue(message("original-after-backup-1"));
		await creator.room.issue(message("original-after-backup-2"));
		const original = await f.issuedAfter(0, null);
		// Only member 3 received the original's moves after the backup.
		const atBackupSequences = new Set(atBackup.map((row) => row.commit.authorSequence));
		expect(await members[2]!.receive(original.filter((row) => !atBackupSequences.has(row.commit.authorSequence)), 0)).toBe(true);
		await f.stop(creator);
		restore();
		const peers = ["chat-member-1", "chat-member-2", "chat-member-3"];
		members.forEach((member, index) => memberDelivery(net, f.objectId, member.room, peers[index]));
		// The newer member is the slowest to answer (60 ms more than the others).
		net.delays.set("chat-member-3", 60);
		for (const peer of peers) net.link(CREATOR_PEER, peer);
		const view = creatorDelivery(net, f.objectId);
		const restored = await f.open(0, { reopen: true, creatorMemberView: memberView(view) });
		const outcome = await settle(restored.room.issue(message("restored-with-three-members")));
		console.info("[creator currency] three members, newer one last:", JSON.stringify({ outcome, state: currency(restored.room) }));
		expect(await conflictingWith(f, original)).toEqual([]);
		expect(outcome).toMatch(/V3_ROOM_NOT_YET_CURRENT: creator-superseded/u);
		expect((await f.issuedAfter(0, null)).length).toBe(backupNext);
	}, 300_000);

	it("[residual] a member with newer state that connects only after the hold refuses the creator from then on", async () => {
		const { f, net, creator, member, restore, backupNext } = await backedUpCreator();
		await creator.room.issue(message("original-after-backup-1"));
		await creator.room.issue(message("original-after-backup-2"));
		const original = await f.issuedAfter(0, null);
		expect(await member.receive(original, 0)).toBe(true);
		await f.stop(creator);
		restore();
		const view = creatorDelivery(net, f.objectId);
		// Nobody connected during the hold: the restored copy becomes provisional and signs a move.
		const restored = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyHoldMs: 200 });
		expect(await settle(restored.room.issue(message("restored-before-the-member-connects")))).toBe("issued");
		expect(currency(restored.room)).toBe("provisional");
		// The residual of not holding a lone creator forever: that move takes a sequence the original signed.
		expect((await conflictingWith(f, original)).length).toBe(1);
		// The member connects after the hold; the delivery asks it and its view refuses the creator.
		memberDelivery(net, f.objectId, member.room);
		net.link(CREATOR_PEER, MEMBER_PEER);
		for (const deadline = performance.now() + 10_000; currency(restored.room) !== "refused" && performance.now() < deadline; )
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(currency(restored.room)).toBe("refused");
		expect(await settle(restored.room.issue(message("restored-after-the-view")))).toMatch(/V3_ROOM_NOT_YET_CURRENT: creator-superseded/u);
		expect(await settle(restored.room.sealEpoch())).toMatch(/V3_ROOM_NOT_YET_CURRENT: creator-superseded/u);
		// Nothing after the view: only the one provisional move beyond the backup.
		expect((await f.issuedAfter(0, null)).length).toBe(backupNext + 1);
		expect(restored.room.projection().messages.map((entry) => entry.clientOperationId)).toContain("creator-before-backup");
	}, 300_000);

	it("[RED-wait] a connected peer that never answers holds the first move only for the hold and its answer window", async () => {
		const { f, net } = await room();
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		await f.stop(creator);
		// A connected peer that is not a room member: it never answers a view request.
		net.channel("chat-relay");
		net.link(CREATOR_PEER, "chat-relay");
		const view = creatorDelivery(net, f.objectId);
		const opened = performance.now();
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view) });
		const openMs = performance.now() - opened;
		const issueStarted = performance.now();
		expect(await settle(creator.room.issue(message("creator-with-a-silent-peer")))).toBe("issued");
		const issueMs = Math.round(performance.now() - issueStarted);
		console.info("[creator currency] silent connected peer:", JSON.stringify({ openMs: Math.round(openMs), issueMs, state: currency(creator.room) }));
		expect(issueMs + openMs).toBeLessThan(Math.max(V3_ROOM_CREATOR_RESTORE_HOLD_MS, V3_ROOM_CREATOR_RESTORE_ANSWER_BOUND_MS) + 1_000);
		expect(currency(creator.room)).toBe("provisional");
	}, 300_000);

	it("[control] a new room's creator never waits: it is current at open and never asks", async () => {
		const { f, net } = await room();
		const delivery = creatorDelivery(net, f.objectId);
		let asked = 0;
		const inner = memberView(delivery) as { ask(request: unknown): Promise<void> };
		const view = { ask: (request: unknown) => (asked++, inner.ask(request)) };
		const started = performance.now();
		const creator = await f.open(0, { creatorMemberView: view });
		expect(currency(creator.room)).toBe("current");
		expect(await settle(creator.room.issue(message("new-room-first")))).toBe("issued");
		console.info("[creator currency] new room: open + first issue in", Math.round(performance.now() - started), "ms");
		expect(asked).toBe(0);
	}, 300_000);

	it("[control] while the check waits, reads and member ingress are not held (only signing is)", async () => {
		const { f, net } = await room();
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		const member = await f.open(1);
		expect(await member.receive(await f.issuedAfter(0, null), 0)).toBe(true);
		await f.stop(creator);
		net.channel("chat-relay");
		net.link(CREATOR_PEER, "chat-relay");
		const view = creatorDelivery(net, f.objectId);
		// A silent connected peer and a long answer bound keep the check waiting for the whole test.
		creator = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyAnswerBoundMs: 60_000, creatorRestoreCurrencyBoundMs: 60_000 });
		expect(currency(creator.room)).toBe("checking");
		const held = settle(creator.room.issue(message("creator-held")));
		// Reads answer while it waits.
		expect(creator.room.projection().messages.map((entry) => entry.clientOperationId)).toContain("creator-1");
		expect(creator.room.authority()?.epoch ?? 0).toBe(0);
		// A member's move is received and admitted while it waits.
		await member.room.issue(message("member-while-creator-checks"));
		const started = performance.now();
		expect(await creator.receive(await f.issuedAfter(1, null), 1)).toBe(true);
		console.info("[creator currency] member move admitted while checking in", Math.round(performance.now() - started), "ms");
		expect(creator.room.projection().messages.map((entry) => entry.clientOperationId)).toContain("member-while-creator-checks");
		// Its own move is still held: nothing signed.
		expect(currency(creator.room)).toBe("checking");
		expect(await Promise.race([held, new Promise((resolve) => setTimeout(() => resolve("still-held"), 200))])).toBe("still-held");
		await f.stop(creator);
		expect(await held).toMatch(/closed|NOT_YET_CURRENT|hold/iu);
	}, 300_000);

	it("[control] the bound counts from open: a lone creator's first move waits at most the remainder", async () => {
		const bound = 6_000;
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
		// Forged material verifies under none of its keys: no answer, not an attested view (provisional).
		expect(["provisional", "current"]).toContain(currency(creator.room));
		console.info("[creator currency] forging peer asked", requests, "time(s)");
		expect((await creator.room.sealEpoch()).ok).toBe(true);
	}, 300_000);
});

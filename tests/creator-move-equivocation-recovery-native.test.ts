/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
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

// Creator move equivocation recovery (coordinator decision 2026-11-11): see the rule below the
// helpers. Helpers from creator-restore-currency-native.test.ts: the shipped successor delivery's
// member view over in-memory channels, native SQLite rooms, and a creator device backup/restore.

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

const texts = (peer: { room: unknown }) =>
	(Reflect.get(peer.room as object, "projection") as () => { messages: { clientOperationId: string }[] })
		.call(peer.room)
		.messages.map((entry) => entry.clientOperationId);

// Recovery rule (creator-move-equivocation-recovery.qnt; creator-restore-currency.qnt amended): a
// stale restored creator R and the original O both signed creator moves from the backup's restore
// point. Members hold both copies and agree within the epoch. The closing creator's finality-signed
// cut is the only arbiter every member applies identically, so:
//   R1 a creator never indexes or parks a vertex under its own key that it did not sign: it keeps it
//      as superseded-incarnation evidence (no permanent pending-ingress wedge) and reports
//      creatorSupersession() "awaiting-resume" with the evidence summary; it signs nothing more.
//   R2 room.resumeAfterSupersession(), called by the operator only after the original device is
//      retired, re-issues the original's operations on R's own chain (same operation bytes); then
//      R is current again.
//   R3 R's next close cuts its own graph; members install it and converge.
//   R4 a live original that sees a vertex under its own key it did not sign halts the same way.
// An epoch-level supersession (the original sealed a later epoch) stays refused: the operator must
// retire this storage.

type Supersession = Readonly<{ state: string; highestSequence: number; epoch: number; staged: number }>;
const supersession = (room: unknown): Supersession | undefined =>
	(Reflect.get(room as object, "creatorSupersession") as undefined | (() => Supersession | undefined))?.call(room);
const resumeAfterSupersession = (room: unknown): Promise<unknown> => {
	const resume = Reflect.get(room as object, "resumeAfterSupersession") as undefined | (() => Promise<unknown>);
	return resume === undefined ? Promise.reject(new TypeError("resumeAfterSupersession is not implemented")) : resume.call(room);
};
const refusal = (task: Promise<unknown>) =>
	task.then(
		() => ({ reason: "issued", message: "" }),
		(error: unknown) => ({ reason: String(Reflect.get(error as object, "reason") ?? "untyped"), message: String((error as Error)?.message) })
	);
const within = <T>(task: Promise<T>, ms: number, fallback: T) =>
	Promise.race([task, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 10_000) => {
	for (const deadline = performance.now() + ms; !condition() && performance.now() < deadline; ) await sleep(20);
	return condition();
};
const once = (values: readonly string[], value: string) => values.filter((entry) => entry === value).length;

/**
 * The equivocation: O signs o-3, o-4 (only m1 receives them) and stops; R reopens from the backup and
 * signs r-3 (and r-4, r-5 when `rAhead`) before any member is reachable; both members receive R's
 * rows, m2 also O's rows, and m2 moves on top of what it holds (m1 receives that move).
 */
async function equivocation(options: { rAhead?: boolean } = {}) {
	const { f, net, creator, members, restore } = await backedUpCreator(["genesis", "genesis"]);
	const [m1, m2] = members as [(typeof members)[0], (typeof members)[0]];
	const atBackup = await f.issuedAfter(0, null);
	for (const member of members) expect(await member.receive(atBackup, 0)).toBe(true);
	await creator.room.issue(message("o-3"));
	await creator.room.issue(message("o-4"));
	const backupSequences = new Set(atBackup.map((row) => row.commit.authorSequence));
	const originalNew = (await f.issuedAfter(0, null)).filter((row) => !backupSequences.has(row.commit.authorSequence));
	expect(await m1.receive(originalNew, 0)).toBe(true);
	await f.stop(creator);
	restore();
	const view = creatorDelivery(net, f.objectId);
	const restored = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyHoldMs: 200 });
	for (const text of options.rAhead === true ? ["r-3", "r-4", "r-5"] : ["r-3"])
		expect(await settle(restored.room.issue(message(text)))).toBe("issued");
	const restoredNew = (await f.issuedAfter(0, null)).filter((row) => !backupSequences.has(row.commit.authorSequence));
	expect(await m2.receive(restoredNew, 0)).toBe(true);
	expect(await m1.receive(restoredNew, 0)).toBe(true);
	expect(await m2.receive(originalNew, 0)).toBe(true);
	await m2.room.issue(message("m2-on-original"));
	// Members exchange their own moves as they would over gossip.
	expect(await m1.receive(await f.issuedAfter(2, null), 2)).toBe(true);
	const originalHighest = Math.max(...originalNew.map((row) => row.commit.authorSequence));
	return { f, net, restored, m1, m2, originalNew, restoredNew, originalHighest };
}

/** m1 (holding O's rows) reaches R: R's member view sees O's highest vertex. */
function reachM1(scenario: Awaited<ReturnType<typeof equivocation>>) {
	memberDelivery(scenario.net, scenario.f.objectId, scenario.m1.room);
	scenario.net.link(CREATOR_PEER, MEMBER_PEER);
}

/** Delivers O's rows to R through its ingress (nothing is admitted; the outcome is R's supersession). */
async function deliverOriginal(scenario: Awaited<ReturnType<typeof equivocation>>) {
	await within(scenario.restored.receive(scenario.originalNew, 1, 1_500), 2_000, false);
	return until(() => (supersession(scenario.restored.room)?.staged ?? 0) >= scenario.originalNew.length, 5_000);
}

describe("creator move equivocation recovery", () => {
	it("6: with no confirmation the superseded creator signs nothing, refuses with its typed state, and members converge on the original's copies", async () => {
		const scenario = await equivocation();
		const { f, restored, m1, m2 } = scenario;
		reachM1(scenario);
		expect(await until(() => currency(restored.room) === "refused")).toBe(true);
		expect(await deliverOriginal(scenario)).toBe(true);
		expect(supersession(restored.room)).toMatchObject({
			state: "awaiting-resume",
			highestSequence: scenario.originalHighest,
			epoch: 0,
			staged: scenario.originalNew.length,
		});
		const rowsBefore = (await f.issuedAfter(0, null)).length;
		const refused = await refusal(restored.room.issue(message("r-while-awaiting")));
		expect(refused.reason).toBe("creator-superseded");
		expect(refused.message).not.toMatch(/unresolved ingress/u);
		expect((await refusal(restored.room.sealEpoch() as Promise<unknown>)).reason).toBe("creator-superseded");
		await sleep(1_000);
		expect((await f.issuedAfter(0, null)).length).toBe(rowsBefore);
		expect(supersession(restored.room)?.state).toBe("awaiting-resume");
		// Members keep converging on the original's copies (and R's provisional one).
		expect(texts(m1)).toEqual(texts(m2));
		for (const text of ["o-3", "o-4", "r-3"]) expect(once(texts(m1), text)).toBe(1);
	}, 300_000);

	it("6b: a creator that signed past the original's copies (the gate does not refuse) is superseded by them, not wedged in its own pending ingress", async () => {
		const scenario = await equivocation({ rAhead: true });
		const { restored } = scenario;
		reachM1(scenario);
		await sleep(1_500);
		expect(await deliverOriginal(scenario)).toBe(true);
		expect(supersession(restored.room)).toMatchObject({ state: "awaiting-resume", highestSequence: scenario.originalHighest });
		const refused = await refusal(restored.room.issue(message("r-after-original")));
		expect(refused.reason).toBe("creator-superseded");
		expect(refused.message).not.toMatch(/unresolved ingress/u);
	}, 300_000);

	it("1: after the operator confirms, the creator re-issues the original's moves, closes the next epoch and every member converges", async () => {
		const scenario = await equivocation();
		const { f, restored, m1, m2 } = scenario;
		reachM1(scenario);
		expect(await until(() => currency(restored.room) === "refused")).toBe(true);
		expect(await deliverOriginal(scenario)).toBe(true);
		// m2's move built on the original's copy never enters R's graph.
		expect(await within(restored.receive(await f.issuedAfter(2, null), 2, 1_500), 2_000, false)).toBe(false);
		const before = (await f.issuedAfter(0, null)).length;
		await resumeAfterSupersession(restored.room);
		expect(supersession(restored.room)?.state).toBe("resumed");
		expect(currency(restored.room)).toBe("current");
		const reissued = (await f.issuedAfter(0, null)).slice(before);
		expect(reissued.length).toBe(scenario.originalNew.length);
		for (const text of ["creator-before-backup", "r-3", "o-3", "o-4"]) expect(once(texts(restored), text)).toBe(1);
		for (const member of [m1, m2]) expect(await member.receive(reissued, 0)).toBe(true);
		const sealed = await restored.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await restored.room.adoptCreatorSuccessor();
		const m2Before = (await f.issuedAfter(2, null)).length;
		for (const member of [m1, m2]) {
			await f.install(member);
			expect(member.room.authority()?.epoch).toBe(1);
		}
		// Work conservation: m2's move built on the original's copy was outside the cut; m2 re-offers it
		// in the new epoch (the displaced-move settlement), and the room converges with it.
		for (const deadline = performance.now() + 30_000; performance.now() < deadline; await sleep(200))
			if ((await f.issuedAfter(2, null)).length > m2Before) break;
		const reoffered = (await f.issuedAfter(2, null)).slice(m2Before);
		expect(reoffered.length).toBeGreaterThan(0);
		expect(await restored.receive(reoffered, 2)).toBe(true);
		expect(await m1.receive(reoffered, 2)).toBe(true);
		expect(texts(m1)).toEqual(texts(restored));
		expect(texts(m2)).toEqual(texts(restored));
		expect(m1.stateBytes()).toEqual(restored.stateBytes());
		expect(m2.stateBytes()).toEqual(restored.stateBytes());
		for (const text of ["creator-before-backup", "r-3", "o-3", "o-4", "m2-on-original"]) expect(once(texts(m1), text)).toBe(1);
	}, 300_000);

	it("2: the resumed creator continues issuing above the original's slots, and members accept it", async () => {
		const scenario = await equivocation();
		const { f, restored, m1, m2 } = scenario;
		reachM1(scenario);
		expect(await until(() => currency(restored.room) === "refused")).toBe(true);
		expect(await deliverOriginal(scenario)).toBe(true);
		await resumeAfterSupersession(restored.room);
		const before = (await f.issuedAfter(0, null)).length;
		expect(await settle(restored.room.issue(message("r-after-resume")))).toBe("issued");
		const next = (await f.issuedAfter(0, null)).slice(before);
		expect(next.length).toBe(1);
		expect(next[0]!.commit.authorSequence).toBeGreaterThan(scenario.originalHighest);
		const all = (await f.issuedAfter(0, null)).filter((row) => row.commit.authorSequence > 2);
		for (const member of [m1, m2]) expect(await member.receive(all, 0)).toBe(true);
		expect(texts(m1)).toEqual(texts(m2));
		expect(once(texts(m2), "r-after-resume")).toBe(1);
		expect(currency(restored.room)).toBe("current");
	}, 300_000);

	it("3: a forged or unsigned copy under the creator's key changes nothing", async () => {
		const { f, net, creator, members, restore } = await backedUpCreator(["genesis"]);
		void members;
		void net;
		await creator.room.issue(message("o-3"));
		const original = await f.issuedAfter(0, null);
		await f.stop(creator);
		restore();
		const restored = await f.open(0, { reopen: true });
		const row = original.at(-1)!;
		const signature = new Uint8Array(row.commit.envelope.signature);
		signature[0] = signature[0]! ^ 0xff;
		const forged = { ...row, commit: { ...row.commit, envelope: { ...row.commit.envelope, signature } } } as typeof row;
		await within(restored.receive([forged], 1, 1_000), 1_500, false);
		await sleep(500);
		expect(supersession(restored.room)).toBeUndefined();
		expect(await settle(restored.room.issue(message("r-3")))).toBe("issued");
	}, 300_000);

	it("4: a live original halts on seeing a vertex under its key that it did not sign", async () => {
		const { f, creator, members, restore } = await backedUpCreator(["genesis"]);
		void members;
		await creator.room.issue(message("o-3"));
		await f.stop(creator);
		// Keep the original device's files, run the stale restore once to obtain its conflicting row,
		// then bring the original back (a second device would do the same concurrently).
		const creatorFile = peerFile(0);
		const kept = join(f.directory, "original-device");
		mkdirSync(kept);
		for (const file of files(f.directory).filter(creatorFile)) copyFileSync(join(f.directory, file), join(kept, file));
		const backupRows = new Set((await f.issuedAfter(0, null)).map((row) => hex(row.commit.envelope.digest)));
		restore();
		const stale = await f.open(0, { reopen: true });
		expect(await settle(stale.room.issue(message("r-3")))).toBe("issued");
		const staleRows = (await f.issuedAfter(0, null)).filter((row) => !backupRows.has(hex(row.commit.envelope.digest)));
		await f.stop(stale);
		for (const file of files(f.directory).filter(creatorFile)) rmSync(join(f.directory, file));
		for (const file of readdirSync(kept)) copyFileSync(join(kept, file), join(f.directory, file));
		const original = await f.open(0, { reopen: true });
		await within(original.receive(staleRows, 1, 1_500), 2_000, false);
		expect(await until(() => supersession(original.room) !== undefined, 5_000)).toBe(true);
		expect(supersession(original.room)?.state).toBe("awaiting-resume");
		expect((await refusal(original.room.issue(message("o-after-stale")))).reason).toBe("creator-superseded");
		expect((await refusal(original.room.sealEpoch() as Promise<unknown>)).reason).toBe("creator-superseded");
	}, 300_000);

	it("5: an epoch-level supersession stays refused and names the operator's action", async () => {
		const { f, net, creator, member, restore } = await backedUpCreator(["genesis"]);
		const atBackup = await f.issuedAfter(0, null);
		expect(await member.receive(atBackup, 0)).toBe(true);
		await creator.room.issue(message("o-3"));
		expect(await member.receive(await f.issuedAfter(0, null), 0)).toBe(true);
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await f.install(member);
		expect(member.room.authority()?.epoch).toBe(1);
		await f.stop(creator);
		restore();
		const view = creatorDelivery(net, f.objectId);
		const restored = await f.open(0, { reopen: true, creatorMemberView: memberView(view), creatorRestoreCurrencyHoldMs: 200 });
		memberDelivery(net, f.objectId, member.room);
		net.link(CREATOR_PEER, MEMBER_PEER);
		expect(await until(() => currency(restored.room) === "refused")).toBe(true);
		expect(supersession(restored.room)).toMatchObject({ state: "epoch-superseded", epoch: 1 });
		const resumed = await refusal(resumeAfterSupersession(restored.room));
		expect(resumed.reason).toBe("creator-superseded");
		expect(resumed.message).toMatch(/retire/u);
		expect(currency(restored.room)).toBe("refused");
	}, 300_000);
});

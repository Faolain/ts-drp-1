/* eslint-disable @typescript-eslint/explicit-function-return-type -- Measurement helpers: inferred fixture shapes. */
import { afterEach, describe, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import {
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/index.js";
import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";

// Creator restore currency timing (measurement, CREATOR_CURRENCY_TIMING=1). How long a creator waits
// before its first signature: a new room, a lone reopen, and a reopen with 1 or 3 connected members.
// The member view is wrapped to time the ask, each member answer and the ask's settle; the check's
// decision is read from creatorCurrency(). Native SQLite rooms, the genuine delivery over an in-memory
// channel (so the answer time is the members' evidence read plus the creator's verification, with no
// network latency unless CREATOR_CURRENCY_TIMING_DELAY_MS sets a one-way delay). Prints one JSON line
// per sample: "[creator currency timing] {...}". Connectivity-unresolved hold scenarios: a solo stored
// roster, a roster with members and nobody reachable, and a member at the same state connecting
// CREATOR_CURRENCY_TIMING_LATE_MS (default 300) after open.
const enabled = process.env.CREATOR_CURRENCY_TIMING === "1";
const SAMPLES = Number(process.env.CREATOR_CURRENCY_TIMING_SAMPLES ?? 10);
const LONE_SAMPLES = Number(process.env.CREATOR_CURRENCY_TIMING_LONE_SAMPLES ?? 3);
const DELAY_MS = Number(process.env.CREATOR_CURRENCY_TIMING_DELAY_MS ?? 0);
const LATE_MS = Number(process.env.CREATOR_CURRENCY_TIMING_LATE_MS ?? 300);

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
const CREATOR_PEER = "chat-creator";
type Listener = (sender: string, bytes: Uint8Array) => void;
const deliveries = new Set<V3RoomSuccessorDelivery>();
const now = () => performance.now();
const ms = (value: number | undefined) => (value === undefined ? null : Math.round(value * 10) / 10);

function network() {
	const listeners = new Map<string, Set<Listener>>();
	const connected = new Map<string, Set<string>>();
	const connections = new Map<string, Set<(peerId: string) => void>>();
	const link = (left: string, right: string) => {
		(connected.get(left) ?? connected.set(left, new Set()).get(left)!).add(right);
		(connected.get(right) ?? connected.set(right, new Set()).get(right)!).add(left);
		for (const listener of [...(connections.get(left) ?? [])]) listener(right);
		for (const listener of [...(connections.get(right) ?? [])]) listener(left);
	};
	const disconnect = (left: string, right: string) => {
		connected.get(left)?.delete(right);
		connected.get(right)?.delete(left);
	};
	const channel = (localPeerId: string): V3RoomSuccessorChannel => ({
		localPeerId,
		peers: () => [...(connected.get(localPeerId) ?? [])],
		send: async (peerId, bytes) => {
			await Promise.resolve();
			if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
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
		close: () => undefined,
	});
	return { channel, link, disconnect };
}

type Marks = { ask?: number; answers: number[]; settled?: number };
/** The creator delivery's member view, wrapped to time the ask, every answer and the settle (relative to `origin`). */
function timedView(delivery: V3RoomSuccessorDelivery, marks: Marks, origin: () => number) {
	const inner = Reflect.get(delivery, "creatorMemberView") as {
		ask(request: { objectId: string; signal: AbortSignal; answer(evidence: unknown): void }): Promise<void>;
	};
	return {
		ask: (request: { objectId: string; signal: AbortSignal; answer(evidence: unknown): void }) => {
			marks.ask = now() - origin();
			return inner
				.ask({
					...request,
					answer: (evidence) => {
						marks.answers.push(now() - origin());
						request.answer(evidence);
					},
				})
				.finally(() => {
					marks.settled = now() - origin();
				});
		},
	};
}

/** Resolves when the room's creator check is no longer "checking" (1 ms polling), with that time. */
async function decided(room: unknown, origin: number): Promise<number> {
	for (;;) {
		const state = Reflect.get(room as object, "creatorCurrency")?.call(room) ?? "current";
		if (state !== "checking") return now() - origin;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

async function measuredReopen(
	f: Awaited<ReturnType<typeof chatSharesRoomFixture>>,
	creatorDelivery: V3RoomSuccessorDelivery,
	scenario: string,
	sample: number,
	bound?: number,
	afterOpenStarted?: () => void
) {
	const marks: Marks = { answers: [] };
	let origin = 0;
	const view = timedView(creatorDelivery, marks, () => origin);
	origin = now();
	afterOpenStarted?.();
	const creator = await f.open(0, {
		reopen: true,
		creatorMemberView: view,
		...(bound === undefined ? {} : { creatorRestoreCurrencyBoundMs: bound }),
	});
	const opened = now() - origin;
	const decision = decided(creator.room, origin);
	const issueStart = now();
	await creator.room.issue(message(`${scenario}-${sample}`));
	const issued = now();
	const decidedAt = await decision;
	const line = {
		scenario,
		sample,
		openMs: ms(opened),
		askAtMs: ms(marks.ask),
		firstAnswerMs: ms(marks.answers[0] === undefined ? undefined : marks.answers[0] - (marks.ask ?? 0)),
		lastAnswerMs: ms(marks.answers.at(-1) === undefined ? undefined : marks.answers.at(-1)! - (marks.ask ?? 0)),
		answers: marks.answers.length,
		askSettledMs: ms(marks.settled === undefined ? undefined : marks.settled - (marks.ask ?? 0)),
		decidedMs: ms(decidedAt - (marks.ask ?? 0)),
		firstIssueMs: ms(issued - issueStart),
		openToFirstSignatureMs: ms(issued - origin),
	};
	console.info("[creator currency timing]", JSON.stringify(line));
	return creator;
}

async function roomWith(members: number) {
	const f = await chatSharesRoomFixture({
		members: Array.from({ length: members }, () => "genesis" as const),
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	return { f, net: network() };
}

describe.skipIf(!enabled)("creator restore currency timing (measurement)", () => {
	it("a new room: the creator's open and first issue (no check: fresh lineage)", async () => {
		for (let sample = 0; sample < LONE_SAMPLES; sample++) {
			const { f, net } = await roomWith(1);
			const delivery = createV3RoomSuccessorDelivery({ role: "creator", objectId: f.objectId, channel: net.channel(CREATOR_PEER) });
			deliveries.add(delivery);
			const marks: Marks = { answers: [] };
			const origin = now();
			const creator = await f.open(0, { creatorMemberView: timedView(delivery, marks, () => origin) });
			const opened = now() - origin;
			const state = Reflect.get(creator.room, "creatorCurrency")?.call(creator.room) ?? "current";
			const issueStart = now();
			await creator.room.issue(message(`new-${sample}`));
			console.info(
				"[creator currency timing]",
				JSON.stringify({ scenario: "new-room", sample, openMs: ms(opened), stateAtOpen: state, asked: marks.ask !== undefined, firstIssueMs: ms(now() - issueStart), openToFirstSignatureMs: ms(now() - origin) })
			);
			await f.stop(creator);
		}
	}, 600_000);

	it("a solo stored roster (nobody but the creator in the ACL): no hold", async () => {
		const { f, net } = await roomWith(0);
		let creator = await f.open(0);
		await creator.room.issue(message("before"));
		await f.stop(creator);
		const delivery = createV3RoomSuccessorDelivery({ role: "creator", objectId: f.objectId, channel: net.channel(CREATOR_PEER) });
		deliveries.add(delivery);
		for (let sample = 0; sample < LONE_SAMPLES; sample++) {
			creator = await measuredReopen(f, delivery, "solo-roster", sample);
			await f.stop(creator);
		}
	}, 600_000);

	it(`a member at the same state connecting ${LATE_MS} ms after open`, async () => {
		const { f, net } = await roomWith(1);
		let creator = await f.open(0);
		await creator.room.issue(message("before"));
		const member = await f.open(1);
		expect(await member.receive(await f.issuedAfter(0, null), 0)).toBe(true);
		await f.stop(creator);
		const memberDelivery = createV3RoomSuccessorDelivery({
			role: "member",
			objectId: f.objectId,
			creatorPeer: CREATOR_PEER,
			channel: net.channel("chat-member-1"),
			pollMs: 600_000,
		});
		deliveries.add(memberDelivery);
		memberDelivery.bind(member.room as never);
		const delivery = createV3RoomSuccessorDelivery({ role: "creator", objectId: f.objectId, channel: net.channel(CREATOR_PEER) });
		deliveries.add(delivery);
		for (let sample = 0; sample < SAMPLES; sample++) {
			net.disconnect(CREATOR_PEER, "chat-member-1");
			await new Promise((resolve) => setTimeout(resolve, 600));
			let timer: ReturnType<typeof setTimeout> | undefined;
			creator = await measuredReopen(f, delivery, `member-late-${LATE_MS}`, sample, undefined, () => {
				timer = setTimeout(() => net.link(CREATOR_PEER, "chat-member-1"), LATE_MS);
			});
			clearTimeout(timer);
			expect(await member.receive(await f.issuedAfter(0, null), 0)).toBe(true);
			await f.stop(creator);
		}
	}, 600_000);

	it("a lone reopen (no member connected): the first signature waits the bound", async () => {
		const { f, net } = await roomWith(1);
		let creator = await f.open(0);
		await creator.room.issue(message("before"));
		await f.stop(creator);
		const delivery = createV3RoomSuccessorDelivery({ role: "creator", objectId: f.objectId, channel: net.channel(CREATOR_PEER) });
		deliveries.add(delivery);
		for (let sample = 0; sample < LONE_SAMPLES; sample++) {
			creator = await measuredReopen(f, delivery, "lone", sample);
			await f.stop(creator);
		}
	}, 600_000);

	for (const members of [1, 3]) {
		it(`a reopen with ${members} connected member(s) at the same state`, async () => {
			const { f, net } = await roomWith(members);
			let creator = await f.open(0);
			await creator.room.issue(message("before"));
			const rooms = [];
			for (let peer = 1; peer <= members; peer++) {
				const member = await f.open(peer);
				expect(await member.receive(await f.issuedAfter(0, null), 0)).toBe(true);
				rooms.push(member);
			}
			await f.stop(creator);
			for (let peer = 1; peer <= members; peer++) {
				const peerId = `chat-member-${peer}`;
				const delivery = createV3RoomSuccessorDelivery({
					role: "member",
					objectId: f.objectId,
					creatorPeer: CREATOR_PEER,
					channel: net.channel(peerId),
					pollMs: 600_000,
				});
				deliveries.add(delivery);
				delivery.bind(rooms[peer - 1]!.room as never);
				net.link(CREATOR_PEER, peerId);
			}
			const delivery = createV3RoomSuccessorDelivery({ role: "creator", objectId: f.objectId, channel: net.channel(CREATOR_PEER) });
			deliveries.add(delivery);
			for (let sample = 0; sample < SAMPLES; sample++) {
				// Members answer each requester at most every 500 ms (ANSWER_MIN_INTERVAL_MS).
				await new Promise((resolve) => setTimeout(resolve, 600));
				creator = await measuredReopen(f, delivery, `members-${members}`, sample);
				await f.stop(creator);
			}
		}, 600_000);
	}
});

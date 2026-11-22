/* eslint-disable @typescript-eslint/explicit-function-return-type -- Opt-in measurement: inferred fixture shapes. */
// Real-time scorecard: how long the creator restore currency gate (v3-room.ts
// V3_ROOM_CREATOR_RESTORE_CURRENCY_BOUND_MS, successor-delivery V3_ROOM_CREATOR_VIEW_GRACE_MS) holds a reopened
// creator's first move. Native SQLite chat rooms (the fixture the restore-currency tests use), the shipped
// successor delivery over an in-memory channel with a configurable one-way delay. Connected: a member at the
// same state answers. Lone: nobody is connected, so the gate runs to its bound. Measurement only: the
// creator's member view is wrapped to timestamp the ask, each answer and the ask's end.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import {
	createV3RoomSuccessorDelivery,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
} from "../examples/v3-room/src/index.js";

const enabled = process.env.SCORECARD === "1" && process.env.SCORECARD_RESTORE === "1";
const output = process.env.SCORECARD_OUT ?? join(tmpdir(), `scorecard-restore-${Date.now()}`);
const connectedRuns = Number(process.env.SCORECARD_RESTORE_RUNS ?? 12);
const loneRuns = Number(process.env.SCORECARD_RESTORE_LONE_RUNS ?? 3);
const delayMs = Number(process.env.SCORECARD_RESTORE_DELAY_MS ?? 20);
const CREATOR_PEER = "chat-creator";
const MEMBER_PEER = "chat-member-1";
const deliveries = new Set<V3RoomSuccessorDelivery>();
type Listener = (sender: string, bytes: Uint8Array) => void;

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

function network() {
	const listeners = new Map<string, Set<Listener>>();
	const connected = new Map<string, Set<string>>();
	const link = (left: string, right: string) => {
		for (const [from, to] of [
			[left, right],
			[right, left],
		] as const) {
			let set = connected.get(from);
			if (set === undefined) connected.set(from, (set = new Set()));
			set.add(to);
		}
	};
	const unlink = () => connected.clear();
	const channel = (localPeerId: string): V3RoomSuccessorChannel => ({
		localPeerId,
		peers: () => [...(connected.get(localPeerId) ?? [])],
		send: async (peerId, bytes) => {
			if (!connected.get(localPeerId)?.has(peerId)) throw new Error("not connected");
			await new Promise((resolve) => setTimeout(resolve, delayMs));
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
	return { channel, link, unlink };
}

const pct = (values: readonly number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
	return { n: sorted.length, min: sorted[0] ?? null, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
};

it.skipIf(!enabled)(
	"realtime scorecard: creator restore currency wait, connected vs lone",
	async () => {
		mkdirSync(output, { recursive: true });
		const f = await chatSharesRoomFixture({
			members: ["genesis"],
			format: "window",
			genesisStateBytes: createShippingChatWindowGenesisStateBytes,
		});
		const net = network();
		let creator = await f.open(0);
		await creator.room.issue(message("creator-1"));
		const member = await f.open(1);
		expect(await member.receive(await f.issuedAfter(0, null), 0)).toBe(true);
		const memberDelivery = createV3RoomSuccessorDelivery({
			role: "member",
			objectId: f.objectId,
			creatorPeer: CREATOR_PEER,
			channel: net.channel(MEMBER_PEER),
			pollMs: 600_000,
		});
		deliveries.add(memberDelivery);
		memberDelivery.bind(member.room as never);
		const results: Record<string, unknown>[] = [];
		const reopen = async (mode: "connected" | "lone", run: number) => {
			await f.stop(creator);
			if (mode === "connected") net.link(CREATOR_PEER, MEMBER_PEER);
			else net.unlink();
			const view = createV3RoomSuccessorDelivery({
				role: "creator",
				objectId: f.objectId,
				channel: net.channel(CREATOR_PEER),
			});
			deliveries.add(view);
			const original = Reflect.get(view, "creatorMemberView") as {
				ask(request: { answer(evidence: unknown): void } & Record<string, unknown>): Promise<void>;
			};
			const marks: Record<string, number> = {};
			const started = performance.now();
			const wrapped = Object.freeze({
				ask: (request: { answer(evidence: unknown): void } & Record<string, unknown>) => {
					marks.askAt = performance.now() - started;
					return original
						.ask({
							...request,
							answer: (evidence: unknown) => {
								marks.firstAnswerAt ??= performance.now() - started;
								request.answer(evidence);
							},
						})
						.finally(() => {
							marks.askDoneAt = performance.now() - started;
						});
				},
			});
			creator = await f.open(0, { reopen: true, creatorMemberView: wrapped });
			marks.openedAt = performance.now() - started;
			await creator.room.issue(message(`creator-${mode}-${run}`));
			marks.firstIssueAt = performance.now() - started;
			view.close();
			deliveries.delete(view);
			const value = { mode, run, delayMs, ...marks };
			results.push(value);
			appendFileSync(join(output, "restore.jsonl"), JSON.stringify(value) + "\n");
			console.info("[scorecard restore]", JSON.stringify(value));
			// The member receives the creator's new row so the next reopen is again at the same state.
			if (mode === "connected") expect(await member.receive(await f.issuedAfter(0, null), 0)).toBe(true);
		};
		for (let run = 0; run < connectedRuns; run++) await reopen("connected", run);
		for (let run = 0; run < loneRuns; run++) await reopen("lone", run);
		const pick = (mode: string, key: string) =>
			results
				.filter((value) => value.mode === mode && typeof value[key] === "number")
				.map((value) => value[key] as number);
		const summary = Object.fromEntries(
			["connected", "lone"].map((mode) => [
				mode,
				Object.fromEntries(
					["askAt", "firstAnswerAt", "askDoneAt", "openedAt", "firstIssueAt"].map((key) => [key, pct(pick(mode, key))])
				),
			])
		);
		writeFileSync(join(output, "restore-summary.json"), JSON.stringify({ delayMs, summary, results }, null, 2));
		await f.stop(creator);
	},
	600_000
);

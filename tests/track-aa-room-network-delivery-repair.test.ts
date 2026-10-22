/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test helpers keep their inferred shapes. */
import { type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { historyRequestMessage } from "./fixtures/track-aa/creator-delivery-room.js";
import { required } from "./fixtures/track-m/room-retention-fixture.js";
import { NodeEphemeralAdapter } from "../packages/node/src/ephemeral.js";
import {
	type NodeRoomDeliveryGap,
	type NodeRoomDeliveryRepairCapacity,
	NodeRoomNetworkAdapter,
} from "../packages/node/src/room-network.js";

// Track AA: the creator's delivery repair scheduler (room-network.ts `#requestDeliveryRepair`)
// under deterministic time. The live plane reports a refused or missing copy and the peer that
// sent it; the creator asks that peer (HISTORY_REQUEST, direct) once the plane has room. Each
// bound the RESULT proposes to the owner is exercised here: remembered peers and their bytes,
// identity admission, sends in flight and their deadline, per-room spacing, per-peer interval
// and backoff, capacity gating, fairness, and cancellation on close and plane replacement.

afterEach(() => {
	vi.useRealTimers();
});

const ROOM = "creator:00112233445566778899aabbccddeeff";
const HISTORY_REQUEST = new TextEncoder().encode("ts-drp-room-history-request-v1");
const ENTRY_BYTES = 64;
const MAX_PEERS = 64;
const MAX_ID_BYTES = 128;

interface Sent {
	readonly peer: string;
	readonly message: Message;
	readonly signal: AbortSignal | undefined;
}

function openRoom(
	options: {
		local?: string;
		peers?: Iterable<string>;
		send?(peer: string): Promise<void> | undefined;
	} = {}
) {
	const local = options.local ?? "creator";
	const network = fakeNetwork(local, false);
	const connected = new Set(options.peers ?? ["writer-1", "writer-2", "writer-3"]);
	const sent: Sent[] = [];
	Object.assign(network, {
		getAllPeers: () => [...connected],
		sendMessage: (peer: string, message: Message, sendOptions?: { signal?: AbortSignal }) => {
			sent.push({ peer, message, signal: sendOptions?.signal });
			return options.send?.(peer) ?? Promise.resolve();
		},
	});
	const adapter = new NodeRoomNetworkAdapter(network, new NodeEphemeralAdapter(network, null));
	const port = adapter.open(
		ROOM,
		"creator",
		() => Promise.resolve(),
		() => undefined
	);
	const published: (string | undefined)[] = [];
	port.setRetainedPublisher((target) => {
		published.push(target);
		return Promise.resolve();
	});
	const census = () => required(adapter.readDeliveryRepairCensus(ROOM));
	return { network: network as DRPNetworkNode, adapter, port, connected, sent, published, census };
}

function plane(initial: NodeRoomDeliveryRepairCapacity = "ready") {
	let state = initial;
	let probes = 0;
	const capacity = (): NodeRoomDeliveryRepairCapacity => {
		probes++;
		return state;
	};
	return {
		capacity,
		set: (next: NodeRoomDeliveryRepairCapacity) => {
			state = next;
		},
		probes: () => probes,
		refused: (peerId: string): NodeRoomDeliveryGap => ({ kind: "refused", peerId, capacity }),
		missing: (peerId: string): NodeRoomDeliveryGap => ({ kind: "missing", peerId, capacity }),
		ready: (): NodeRoomDeliveryGap => ({ kind: "capacity", capacity }),
		retired: (): NodeRoomDeliveryGap => ({ kind: "retired", capacity }),
	};
}

const peersOf = (sent: readonly Sent[]) => sent.map((entry) => entry.peer);

describe("Track AA: the creator's delivery repair scheduler", () => {
	it("is a no-op on every peer but the creator", async () => {
		vi.useFakeTimers();
		const { port, sent, census } = openRoom({ local: "writer-1" });
		const p = plane();
		for (let i = 0; i < 1_000; i++) {
			port.requestDeliveryRepair(p.refused("writer-2"));
			port.requestDeliveryRepair(p.missing("writer-2"));
		}
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sent).toEqual([]);
		expect(p.probes()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(census()).toMatchObject({ peers: 0, signals: 0, timers: 0, planeBound: 0 });
		await port.close();
	});

	it("asks the refused copy's sender with HISTORY_REQUEST once, then at most once per second", async () => {
		vi.useFakeTimers();
		const { port, sent, census } = openRoom();
		const p = plane("ready");
		for (let i = 0; i < 1_000; i++) port.requestDeliveryRepair(p.refused("writer-1"));
		await vi.advanceTimersByTimeAsync(0);
		expect(peersOf(sent)).toEqual(["writer-1"]);
		const request = required(sent[0]).message;
		expect(request.type).toBe(MessageType.MESSAGE_TYPE_CUSTOM);
		expect(request.data).toEqual(HISTORY_REQUEST);
		expect(request.sender).toBe("creator");
		expect(request.objectId).toBe(historyRequestMessage(ROOM, "creator").objectId);
		expect(census()).toMatchObject({ peers: 1, peerBytes: ENTRY_BYTES + "writer-1".length, sends: 0 });
		// More refusals of the same peer within its interval: one more request at the interval.
		for (let i = 0; i < 1_000; i++) port.requestDeliveryRepair(p.refused("writer-1"));
		await vi.advanceTimersByTimeAsync(999);
		expect(sent).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent).toHaveLength(2);
		// Nobody refused again: nothing more, and no timer.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(sent).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
		expect(census()).toMatchObject({ duePeers: 0, sends: 0, timers: 0, requestsSent: 2, sendFailures: 0 });
		await port.close();
	});

	it("waits while the plane is busy: no request, one probe per second, then asks on its capacity signal", async () => {
		vi.useFakeTimers();
		const { port, sent, census } = openRoom();
		const p = plane("busy");
		port.requestDeliveryRepair(p.refused("writer-1"));
		expect(p.probes()).toBe(1);
		expect(census()).toMatchObject({ waitingForCapacity: 1, duePeers: 1, timers: 1, busyProbes: 1 });
		for (let i = 0; i < 10_000; i++) port.requestDeliveryRepair(p.refused("writer-1"));
		expect(p.probes()).toBe(1);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(p.probes()).toBe(4);
		expect(sent).toEqual([]);
		expect(vi.getTimerCount()).toBe(1);
		p.set("ready");
		port.requestDeliveryRepair(p.ready());
		await vi.advanceTimersByTimeAsync(0);
		expect(peersOf(sent)).toEqual(["writer-1"]);
		expect(census()).toMatchObject({ waitingForCapacity: 0, duePeers: 0 });
		await port.close();
	});

	it("remembers at most 64 connected peers, charged 64 B plus the id; an authenticated row may evict", async () => {
		vi.useFakeTimers();
		const flood = Array.from({ length: 10_000 }, (_, index) => `sybil-${index}`);
		const { port, sent, census } = openRoom({ peers: [...flood, "writer-1"] });
		const p = plane("busy");
		for (const peerId of flood) port.requestDeliveryRepair(p.refused(peerId));
		const full = census();
		expect(full.peers).toBe(MAX_PEERS);
		expect(full.peerBytes).toBeLessThanOrEqual(MAX_PEERS * (ENTRY_BYTES + MAX_ID_BYTES));
		expect(full.peerBytes).toBe(flood.slice(0, MAX_PEERS).reduce((sum, id) => sum + ENTRY_BYTES + id.length, 0));
		expect(full.refusedPeers).toBe(flood.length - MAX_PEERS);
		expect(full.timers).toBeLessThanOrEqual(1);
		// A 65th peer named only by a refused copy is refused; one named by an authenticated
		// (held) row replaces an unauthenticated entry, and is asked first.
		port.requestDeliveryRepair(p.refused("writer-1"));
		expect(census()).toMatchObject({ peers: MAX_PEERS, refusedPeers: flood.length - MAX_PEERS + 1, evictedPeers: 0 });
		port.requestDeliveryRepair(p.missing("writer-1"));
		expect(census()).toMatchObject({ peers: MAX_PEERS, evictedPeers: 1 });
		p.set("ready");
		port.requestDeliveryRepair(p.ready());
		await vi.advanceTimersByTimeAsync(0);
		expect(peersOf(sent)).toEqual(["writer-1"]);
		// Spacing: at most one request per 250 ms per room, however many peers are due.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sent).toHaveLength(5);
		expect(census().sends).toBe(0);
		const closing = port.close();
		expect(census()).toMatchObject({ peers: 0, peerBytes: 0, sends: 0, timers: 0 });
		await closing;
	});

	it("refuses spoofed, oversized, self and unconnected identities, and malformed reports", async () => {
		vi.useFakeTimers();
		const { port, sent, census } = openRoom({ peers: ["writer-1"] });
		const p = plane("ready");
		const multiByte = "é".repeat(65); // 65 characters, 130 UTF-8 bytes
		for (const peerId of ["", "x".repeat(MAX_ID_BYTES + 1), multiByte, "creator"])
			port.requestDeliveryRepair(p.refused(peerId));
		port.requestDeliveryRepair({ kind: "refused", peerId: 42 as unknown as string, capacity: p.capacity });
		port.requestDeliveryRepair(p.refused("x".repeat(MAX_ID_BYTES))); // exactly 128 bytes, not connected
		port.requestDeliveryRepair(p.refused("not-connected"));
		expect(census()).toMatchObject({ peers: 0, refusedPeers: 5, unreachablePeers: 2 });
		const signals = census().signals;
		for (const gap of [
			null,
			{},
			{ kind: "bogus", peerId: "writer-1", capacity: p.capacity },
			{ kind: "refused", peerId: "writer-1", capacity: "ready" },
			{
				get kind(): string {
					throw new Error("hostile getter");
				},
			},
		])
			expect(() => port.requestDeliveryRepair(gap as unknown as NodeRoomDeliveryGap)).not.toThrow();
		expect(census().signals).toBe(signals);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sent).toEqual([]);
		await port.close();
	});

	it("asks peers named by authenticated rows first, then the rest in round robin", async () => {
		vi.useFakeTimers();
		const { port, sent } = openRoom();
		const p = plane("busy");
		port.requestDeliveryRepair(p.refused("writer-1"));
		port.requestDeliveryRepair(p.refused("writer-2"));
		port.requestDeliveryRepair(p.missing("writer-3"));
		p.set("ready");
		port.requestDeliveryRepair(p.ready());
		await vi.advanceTimersByTimeAsync(600);
		expect(peersOf(sent)).toEqual(["writer-3", "writer-1", "writer-2"]);
		// All three refused again: each is asked again once its own interval has passed, and
		// the room still spaces its requests.
		for (const peerId of ["writer-2", "writer-1"]) port.requestDeliveryRepair(p.refused(peerId));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(peersOf(sent)).toEqual(["writer-3", "writer-1", "writer-2", "writer-1", "writer-2"]);
		await port.close();
	});

	it("aborts a send at its deadline, keeps that peer due with backoff, and keeps serving others", async () => {
		vi.useFakeTimers();
		const stalled = ["stall-1", "stall-2", "stall-3", "stall-4", "stall-5"];
		const { port, sent, census } = openRoom({
			peers: [...stalled, "writer-1"],
			send: (peer) => (peer.startsWith("stall-") ? new Promise<void>(() => undefined) : undefined),
		});
		const p = plane("busy");
		for (const peerId of [...stalled, "writer-1"]) port.requestDeliveryRepair(p.refused(peerId));
		p.set("ready");
		port.requestDeliveryRepair(p.ready());
		await vi.advanceTimersByTimeAsync(2_000);
		// At most four requests in flight, one per peer.
		expect(peersOf(sent)).toEqual(stalled.slice(0, 4));
		expect(census()).toMatchObject({ sends: 4, sendBytes: 4 * 256, timers: 4 });
		await vi.advanceTimersByTimeAsync(8_000); // the first deadline (10 s) elapses
		expect(required(sent[0]).signal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(250);
		// The freed slots go to the next due peers in round robin: writer-1 is asked 10.25 s
		// after the capacity signal, behind four stalled peers.
		expect(peersOf(sent).slice(4, 6)).toEqual(["stall-5", "writer-1"]);
		expect(census().sendFailures).toBeGreaterThanOrEqual(1);
		// writer-1's request completes; the stalled peers stay due and back off (2 s, 4 s, ...
		// up to 32 s after each ask), so each is asked a bounded number of times.
		const asked = (peer: string) => peersOf(sent).filter((entry) => entry === peer).length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(asked("writer-1")).toBe(1);
		for (const peer of stalled) expect(asked(peer), peer).toBeLessThanOrEqual(6);
		expect(census().sends).toBeLessThanOrEqual(4);
		expect(census().peers).toBeLessThanOrEqual(6);
		await port.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("close cancels its timer and in-flight requests, and joins them", async () => {
		vi.useFakeTimers();
		const { port, sent, census } = openRoom({
			send: (peer) => (peer === "writer-1" ? new Promise<void>(() => undefined) : undefined),
		});
		const p = plane("ready");
		port.requestDeliveryRepair(p.refused("writer-1"));
		port.requestDeliveryRepair(p.refused("writer-2"));
		expect(census()).toMatchObject({ sends: 1, timers: 2 });
		const closing = port.close();
		expect(required(sent[0]).signal?.aborted).toBe(true);
		expect(census()).toMatchObject({ peers: 0, sends: 0, timers: 0, planeBound: 0 });
		expect(vi.getTimerCount()).toBe(0);
		await closing;
		port.requestDeliveryRepair(p.refused("writer-3"));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(peersOf(sent)).toEqual(["writer-1"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a successor plane replaces the replaced plane's hints; retirement ends them", async () => {
		vi.useFakeTimers();
		const { port, sent, census } = openRoom({
			send: (peer) => (peer === "writer-2" ? new Promise<void>(() => undefined) : undefined),
		});
		const first = plane("busy");
		port.requestDeliveryRepair(first.refused("writer-1"));
		port.requestDeliveryRepair(first.refused("writer-2"));
		expect(census()).toMatchObject({ peers: 2, planeBound: 1 });
		const second = plane("ready");
		port.requestDeliveryRepair(second.refused("writer-2"));
		expect(census()).toMatchObject({ peers: 1, clears: 1, sends: 1 });
		expect(peersOf(sent)).toEqual(["writer-2"]);
		// The replaced plane's retirement concerns nothing this room still tracks.
		port.requestDeliveryRepair(first.retired());
		expect(census()).toMatchObject({ peers: 1, sends: 1, planeBound: 1 });
		port.requestDeliveryRepair(second.retired());
		expect(required(sent[0]).signal?.aborted).toBe(true);
		expect(census()).toMatchObject({ peers: 0, sends: 0, timers: 0, planeBound: 0, clears: 2 });
		// A probe that reports retirement (or throws) ends the hints the same way.
		const third = plane("retired");
		port.requestDeliveryRepair(third.refused("writer-3"));
		expect(census()).toMatchObject({ peers: 0, planeBound: 0 });
		const throwing: NodeRoomDeliveryGap = {
			kind: "refused",
			peerId: "writer-3",
			capacity: () => {
				throw new Error("probe failed");
			},
		};
		port.requestDeliveryRepair(throwing);
		expect(census()).toMatchObject({ peers: 0, planeBound: 0 });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(peersOf(sent)).toEqual(["writer-2"]);
		expect(vi.getTimerCount()).toBe(0);
		await port.close();
	});

	it("inbound HISTORY_REQUEST streams are served as before and never enter the repair", async () => {
		vi.useFakeTimers();
		const { adapter, port, sent, published, census } = openRoom();
		for (let i = 0; i < 1_000; i++)
			expect(adapter.route(Message.create(historyRequestMessage(ROOM, "writer-1")))).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(published).toHaveLength(1_000);
		expect(new Set(published)).toEqual(new Set(["writer-1"]));
		expect(sent).toEqual([]);
		expect(census()).toMatchObject({ peers: 0, sends: 0, timers: 0, signals: 0 });
		await port.close();
	});
});

import { afterEach, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { NodeEphemeralAdapter } from "../packages/node/src/ephemeral.js";
import { NodeRoomNetworkAdapter, type NodeRoomNetworkPort } from "../packages/node/src/room-network.js";

// Track X: the room transport's request for a missing dependency is bounded (G21): one
// request at once, then at most one trailing request per interval however often the room
// asks; one timer per room; nothing after close; nothing on the creator, which has no one to
// ask. Local scheduler evidence under deterministic time, as r9-room-network-repair-admission.

afterEach(() => {
	vi.useRealTimers();
});

const ROOM = "creator:00112233445566778899aabbccddeeff";

function open(
	localPeerId: string,
	creatorPeerId: string
): { port: NodeRoomNetworkPort; sent: string[]; published: (string | undefined)[] } {
	const network = fakeNetwork(localPeerId, false);
	const sent: string[] = [];
	Object.assign(network, {
		sendMessage: (peer: string) => {
			sent.push(peer);
			return Promise.resolve();
		},
	});
	const adapter = new NodeRoomNetworkAdapter(network, new NodeEphemeralAdapter(network, null));
	const port = adapter.open(
		ROOM,
		creatorPeerId,
		() => Promise.resolve(),
		() => undefined
	);
	const published: (string | undefined)[] = [];
	port.setRetainedPublisher((target) => {
		published.push(target);
		return Promise.resolve();
	});
	return { port, sent, published };
}

it("asks the creator at once, then at most once more per interval, with one timer", async () => {
	vi.useFakeTimers();
	const { port, sent, published } = open("recipient", "creator");
	for (let i = 0; i < 1_000; i++) port.requestMissingRetainedHistory();
	await vi.advanceTimersByTimeAsync(0);
	expect(sent).toEqual(["creator"]);
	expect(published).toEqual(["creator"]);
	expect(vi.getTimerCount()).toBe(1);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(sent).toEqual(["creator", "creator"]); // the one trailing request
	expect(vi.getTimerCount()).toBe(1);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(sent).toHaveLength(2); // nobody asked again: nothing more, no timer left
	expect(vi.getTimerCount()).toBe(0);
	port.requestMissingRetainedHistory();
	await vi.advanceTimersByTimeAsync(0);
	expect(sent).toHaveLength(3);
	await port.close();
	expect(vi.getTimerCount()).toBe(0);
	expect(() => port.requestMissingRetainedHistory()).not.toThrow();
	await vi.advanceTimersByTimeAsync(5_000);
	expect(sent).toHaveLength(3);
});

it("close cancels a trailing request", async () => {
	vi.useFakeTimers();
	const { port, sent } = open("recipient", "creator");
	port.requestMissingRetainedHistory();
	port.requestMissingRetainedHistory();
	await vi.advanceTimersByTimeAsync(0);
	expect(sent).toHaveLength(1);
	await port.close();
	await vi.advanceTimersByTimeAsync(5_000);
	expect(sent).toHaveLength(1);
	expect(vi.getTimerCount()).toBe(0);
});

it("is a no-op on the creator and leaves the open-time schedule unchanged", async () => {
	vi.useFakeTimers();
	const { port, sent, published } = open("creator", "creator");
	for (let i = 0; i < 10; i++) port.requestMissingRetainedHistory();
	await vi.advanceTimersByTimeAsync(5_000);
	expect(sent).toEqual([]);
	expect(published).toEqual([]);
	expect(vi.getTimerCount()).toBe(0);
	port.requestRetainedHistory();
	expect(vi.getTimerCount()).toBe(7);
	await vi.advanceTimersByTimeAsync(15_000);
	expect(published.length).toBeGreaterThan(0);
	await port.close();
});

import { afterEach, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { NodeEphemeralAdapter } from "../packages/node/src/ephemeral.js";
import { NodeRoomNetworkAdapter } from "../packages/node/src/room-network.js";

// Execute the real transport scheduler under deterministic time. This is local
// queue/lifetime evidence, not cryptographic, SQLite or distributed convergence.
afterEach(() => {
	vi.useRealTimers();
});

it("retained repair scheduler refuses extra fresh schedules and retains capacity until entered requests join", async () => {
	vi.useFakeTimers();
	const network = fakeNetwork("repair-local", false);
	const adapter = new NodeRoomNetworkAdapter(network, new NodeEphemeralAdapter(network, () => undefined, null));
	const port = adapter.open(
		"repair:00112233445566778899aabbccddeeff",
		undefined,
		() => Promise.resolve(),
		() => undefined
	);
	let release!: () => void,
		requests = 0;
	const joined = new Promise<void>((resolve) => {
		release = resolve;
	});
	port.setRetainedPublisher(async () => {
		requests++;
		await joined;
	});
	try {
		for (let i = 0; i < 32; i++) port.requestRetainedHistory();
		expect(vi.getTimerCount()).toBe(224);
		expect(() => port.requestRetainedHistory()).toThrow("capacity exhausted");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(requests).toBe(1); // Existing idempotent transport retry, not another room owner.
		expect(vi.getTimerCount()).toBe(0);
		expect(() => port.requestRetainedHistory()).toThrow("capacity exhausted");
	} finally {
		release();
	}
	await vi.advanceTimersByTimeAsync(0);
	expect(() => port.requestRetainedHistory()).not.toThrow();
	expect(vi.getTimerCount()).toBe(7);
	port.close();
	expect(vi.getTimerCount()).toBe(0);
	expect(() => port.requestRetainedHistory()).toThrow("closed");
});

it("retained repair close revokes schedules and a reopened transport receives fresh capacity", () => {
	vi.useFakeTimers();
	const network = fakeNetwork("repair-reopen", false);
	const adapter = new NodeRoomNetworkAdapter(network, new NodeEphemeralAdapter(network, () => undefined, null));
	const id = "repair:00112233445566778899aabbccddeeff";
	const port = adapter.open(
		id,
		undefined,
		() => Promise.resolve(),
		() => undefined
	);
	for (let i = 0; i < 32; i++) port.requestRetainedHistory();
	port.close();
	expect(vi.getTimerCount()).toBe(0);
	expect(() => port.requestRetainedHistory()).toThrow("closed");
	const reopened = adapter.open(
		id,
		undefined,
		() => Promise.resolve(),
		() => undefined
	);
	for (let i = 0; i < 32; i++) reopened.requestRetainedHistory();
	expect(vi.getTimerCount()).toBe(224);
	expect(() => reopened.requestRetainedHistory()).toThrow("capacity exhausted");
	reopened.close();
	expect(vi.getTimerCount()).toBe(0);
});

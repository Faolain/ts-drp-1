import { afterEach, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";

afterEach(() => vi.restoreAllMocks());

it("preserves default network mock recording and topic behavior", async () => {
	const network = fakeNetwork("recorded-peer");
	for (const value of Object.values(network)) {
		if (typeof value === "function") expect(vi.isMockFunction(value)).toBe(true);
	}
	await network.subscribe("room");
	expect(network.getSubscribedTopics()).toEqual(["room"]);
	expect(network.subscribe).toHaveBeenCalledExactlyOnceWith("room");
	await network.unsubscribe("room");
	expect(network.getSubscribedTopics()).toEqual([]);
	expect(network.unsubscribe).toHaveBeenCalledExactlyOnceWith("room");
});

it("uses the same network behavior without globally registered call-recording stubs", async () => {
	const network = fakeNetwork("unrecorded-peer", false);
	for (const value of Object.values(network)) {
		if (typeof value === "function") expect(vi.isMockFunction(value)).toBe(false);
	}
	expect(network.peerId).toBe("unrecorded-peer");
	await network.subscribe("room");
	expect(network.getSubscribedTopics()).toEqual(["room"]);
	await network.unsubscribe("room");
	expect(network.getSubscribedTopics()).toEqual([]);
	await expect(network.start()).resolves.toBeUndefined();
	await expect(network.stop()).resolves.toBeUndefined();
});

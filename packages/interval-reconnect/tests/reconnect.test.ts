import { type DRPIntervalReconnectOptions, type DRPNetworkNode } from "@ts-drp/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createDRPReconnectBootstrap, type DRPIntervalReconnectBootstrap } from "../src/index.js";

type MockedDRPNetworkNode = {
	[K in keyof DRPNetworkNode]: DRPNetworkNode[K] extends (...args: unknown[]) => unknown
		? ReturnType<typeof vi.fn>
		: DRPNetworkNode[K];
};

describe("DRPIntervalReconnect Unit Tests", () => {
	let mockNetworkNode: MockedDRPNetworkNode;
	let reconnectInstance: DRPIntervalReconnectBootstrap;
	const testId = "test-reconnect";

	beforeEach(() => {
		mockNetworkNode = {
			peerId: { toString: () => "test-peer-id" },
			getAllPeers: vi.fn().mockReturnValue([]),
			getBootstrapNodes: vi.fn().mockReturnValue([]),
			getGroupPeers: vi.fn().mockReturnValue([]),
			broadcastMessage: vi.fn(),
			connect: vi.fn(),
			disconnect: vi.fn(),
			sendMessage: vi.fn(),
			getPeerMultiaddrs: vi.fn(),
			connectToBootstraps: vi.fn(),
			getMultiaddrs: vi.fn(),
		} as unknown as MockedDRPNetworkNode;

		const options: DRPIntervalReconnectOptions = {
			id: testId,
			networkNode: mockNetworkNode,
			interval: 1000,
			logConfig: { level: "silent" },
		};
		reconnectInstance = createDRPReconnectBootstrap(options);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("Constructor", () => {
		test("should initialize with default interval if not provided", () => {
			const instance = createDRPReconnectBootstrap({
				id: testId,
				networkNode: mockNetworkNode,
				logConfig: { level: "silent" },
			});
			expect(instance.interval).toBe(10_000); // 10 seconds
		});

		test("should expose id", () => {
			expect(reconnectInstance.id).toBe(testId);
		});
	});

	describe("Reconnect Process", () => {
		test("delegates an interval tick to the bootstrap redial mechanism without identity classification", async () => {
			await reconnectInstance["_runDRPReconnect"]();
			expect(mockNetworkNode.connectToBootstraps).toHaveBeenCalledOnce();
			expect(mockNetworkNode.getAllPeers).not.toHaveBeenCalled();
			expect(mockNetworkNode.getBootstrapNodes).not.toHaveBeenCalled();
		});
	});
});

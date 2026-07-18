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
	const bootstrapPeerId = "16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK";
	const nonBootstrapPeerId = "16Uiu2HAmGjAVQyzgTCumpB9TuojKT4LZTBC5HRiZyuwGG9VHodLC";
	const bootstrapAddr = `/dns4/bootstrap.test/tcp/443/wss/p2p/${bootstrapPeerId}`;

	beforeEach(() => {
		mockNetworkNode = {
			peerId: { toString: () => "test-peer-id" },
			getAllPeers: vi.fn().mockReturnValue([]),
			getBootstrapNodes: vi.fn().mockReturnValue([bootstrapAddr]),
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
		/*
		 * getAllPeers() is the public DRPNetworkNode accessor backed by libp2p.getPeers(),
		 * so it describes active peer connections. getMultiaddrs() describes only this
		 * node's listen addresses and can remain populated while the node is isolated.
		 */
		test("skips redial when connected to a bootstrap peer", async () => {
			mockNetworkNode.getAllPeers.mockReturnValue([bootstrapPeerId]);
			await reconnectInstance["_runDRPReconnect"]();
			expect(mockNetworkNode.connectToBootstraps).not.toHaveBeenCalled();
		});

		test("redials when connected only to a non-bootstrap peer", async () => {
			mockNetworkNode.getAllPeers.mockReturnValue([nonBootstrapPeerId]);
			await reconnectInstance["_runDRPReconnect"]();
			expect(mockNetworkNode.connectToBootstraps).toHaveBeenCalledOnce();
		});

		test("redials when no peers are connected", async () => {
			mockNetworkNode.getAllPeers.mockReturnValue([]);
			await reconnectInstance["_runDRPReconnect"]();
			expect(mockNetworkNode.connectToBootstraps).toHaveBeenCalledOnce();
		});
	});
});

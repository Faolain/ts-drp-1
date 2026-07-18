import type { Libp2p } from "@libp2p/interface";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import { BOOTSTRAP_NODES, DRPNetworkNode } from "@ts-drp/network";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const BOOTSTRAP_ADDR = "/ip4/127.0.0.1/tcp/54321/ws/p2p/16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK";

/*
 * Startup bootstrap retry contract: five total attempts, with 1s, 2s, 4s,
 * and 8s delays between them. The bounded schedule lets start() settle after
 * at most 15s even when the bootstrap remains unavailable.
 */
describe("DRPNetworkNode startup bootstrap healing", () => {
	let node: DRPNetworkNode | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		if (node?.["_node"]?.status !== "stopped") await node?.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("retries with growing backoff and succeeds when the bootstrap becomes reachable", async () => {
		const safeDial = vi
			.spyOn(DRPNetworkNode.prototype, "safeDial")
			.mockRejectedValueOnce(new Error("bootstrap is starting"))
			.mockRejectedValueOnce(new Error("bootstrap is still starting"))
			.mockResolvedValueOnce(undefined);
		node = new DRPNetworkNode({
			bootstrap_peers: [BOOTSTRAP_ADDR],
			listen_addresses: [],
			log_config: { level: "silent" },
		});

		const startPromise = node.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(safeDial).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(999);
		expect(safeDial).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(safeDial).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(1_999);
		expect(safeDial).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(safeDial).toHaveBeenCalledTimes(3);
		await expect(startPromise).resolves.toBeUndefined();
	});

	test("bounds failed startup dials and resolves start when the bootstrap stays down", async () => {
		const startedAt = Date.now();
		const dialTimes: number[] = [];
		const safeDial = vi.spyOn(DRPNetworkNode.prototype, "safeDial").mockImplementation(() => {
			dialTimes.push(Date.now() - startedAt);
			return Promise.reject(new Error("bootstrap unavailable"));
		});
		node = new DRPNetworkNode({
			bootstrap_peers: [BOOTSTRAP_ADDR],
			listen_addresses: [],
			log_config: { level: "silent" },
		});

		const startPromise = node.start();
		await vi.advanceTimersByTimeAsync(15_000);
		await expect(startPromise).resolves.toBeUndefined();
		expect(safeDial).toHaveBeenCalledTimes(5);
		expect(dialTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000]);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(safeDial).toHaveBeenCalledTimes(5);
	});

	test("cancels a pending bootstrap backoff when stopped", async () => {
		const scheduleTimeout = globalThis.setTimeout;
		const unref = vi.fn();
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
			const timeout = scheduleTimeout(...args);
			(timeout as ReturnType<typeof setTimeout> & { unref?(): void }).unref = unref;
			return timeout;
		}) as typeof setTimeout);
		const safeDial = vi
			.spyOn(DRPNetworkNode.prototype, "safeDial")
			.mockRejectedValue(new Error("bootstrap unavailable"));
		node = new DRPNetworkNode({
			bootstrap_peers: [BOOTSTRAP_ADDR],
			log_config: { level: "silent" },
		});
		const capturedNode = {
			status: "started",
			stop: vi.fn(() => {
				capturedNode.status = "stopped";
				return Promise.resolve();
			}),
		} as unknown as Libp2p;
		const retryController = new AbortController();
		node["_node"] = capturedNode;
		(node as unknown as { _bootstrapRetryController: AbortController })._bootstrapRetryController = retryController;
		const dialWithRetry = node["_dialBootstrapWithRetry"] as unknown as (
			addr: Multiaddr,
			libp2p: Libp2p,
			signal: AbortSignal
		) => Promise<void>;

		const retry = dialWithRetry.call(node, multiaddr(BOOTSTRAP_ADDR), capturedNode, retryController.signal);
		await vi.advanceTimersByTimeAsync(0);
		expect(safeDial).toHaveBeenCalledTimes(1);
		expect(unref).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);

		await node.stop();
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(15_000);
		await retry;
		expect(safeDial).toHaveBeenCalledTimes(1);
	});

	test("binds every retry dial to the libp2p instance that started the chain", async () => {
		node = new DRPNetworkNode({ bootstrap_peers: [], log_config: { level: "silent" } });
		const capturedNode = { status: "started", stop: vi.fn() } as unknown as Libp2p;
		const replacementNode = { status: "started", stop: vi.fn() } as unknown as Libp2p;
		let nodeReads = 0;
		Object.defineProperty(node, "_node", {
			configurable: true,
			get: () => (nodeReads++ === 0 ? capturedNode : replacementNode),
		});
		const safeDial = vi.spyOn(node, "safeDial").mockResolvedValue(undefined);
		const dialWithRetry = node["_dialBootstrapWithRetry"] as unknown as (
			addr: Multiaddr,
			libp2p: Libp2p,
			signal: AbortSignal
		) => Promise<void>;
		const addr = multiaddr(BOOTSTRAP_ADDR);

		await dialWithRetry.call(node, addr, capturedNode, new AbortController().signal);

		expect(safeDial).toHaveBeenCalledWith(addr, capturedNode);
	});

	test("starts retry chains for the default bootstrap list", async () => {
		const safeDial = vi
			.spyOn(DRPNetworkNode.prototype, "safeDial")
			.mockRejectedValue(new Error("bootstrap unavailable"));
		node = new DRPNetworkNode({ listen_addresses: [], log_config: { level: "silent" } });

		await node.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(safeDial.mock.calls.map(([addr]) => addr.toString())).toEqual(BOOTSTRAP_NODES);
	});
});

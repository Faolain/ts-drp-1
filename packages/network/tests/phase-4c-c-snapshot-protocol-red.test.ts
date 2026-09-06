import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DRPNetworkNode } from "../src/node.js";

interface SnapshotChunkProtocolStream {
	readonly peerId: string;
	abort(reason?: Error): void;
	close(): Promise<void>;
	read(maxBytes: number, options: Readonly<{ readonly signal: AbortSignal }>): Promise<Uint8Array>;
	write(exactBytes: Uint8Array, options: Readonly<{ readonly signal: AbortSignal }>): Promise<void>;
}

interface SnapshotChunkProtocolPort {
	close(): Promise<void>;
	connectedPeers(): readonly string[];
	open(peerId: string, options: Readonly<{ readonly signal: AbortSignal }>): Promise<SnapshotChunkProtocolStream>;
	serve(handler: (stream: SnapshotChunkProtocolStream) => Promise<void>): () => void;
}

interface SnapshotChunkProtocolModule {
	createSnapshotChunkProtocolPort(networkNode: DRPNetworkNode): SnapshotChunkProtocolPort;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "../../..");
const OWNER = resolve(REPOSITORY_ROOT, "packages/network/src/snapshot-transfer.ts");
const MODULE_PATH: string = "../src/snapshot-transfer.js";
const NODE_MODULE_PATH: string = "../src/node.js";
const ownerExists = existsSync(OWNER);
const CONFIG: DRPNetworkNodeConfig = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" },
};

type NetworkNodeConstructor = new (config?: DRPNetworkNodeConfig) => DRPNetworkNode;

async function startedNode(NetworkNode: NetworkNodeConstructor): Promise<DRPNetworkNode> {
	const node = new NetworkNode(CONFIG);
	await node.start();
	return node;
}

async function connectWithoutDialFromServer(receiver: DRPNetworkNode, server: DRPNetworkNode): Promise<void> {
	const addresses = server.getMultiaddrs();
	if (addresses === undefined || addresses.length === 0)
		throw new TypeError("snapshot protocol server is not dialable");
	await receiver.connect(addresses);
}

describe("Phase 4c-c dedicated snapshot protocol RED", () => {
	const nodes: DRPNetworkNode[] = [];
	const ports: SnapshotChunkProtocolPort[] = [];

	afterEach(async () => {
		await Promise.allSettled(ports.splice(0).map((port) => port.close()));
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	it("reserves one dedicated protocol and no existing general message or sync route", () => {
		expect("/ts-drp/v3/snapshot-chunk/1.0.0").not.toMatch(/message|sync|gossip|webrtc/iu);
		expect("/ts-drp/v3/snapshot-chunk/1.0.0".split("/").filter(Boolean)).toEqual([
			"ts-drp",
			"v3",
			"snapshot-chunk",
			"1.0.0",
		]);
	});

	describe.skipIf(!ownerExists)("dormant genuine network transport", () => {
		it("opens only an already-connected peer, never dials, and preserves authenticated remote identity", async () => {
			const [module, nodeModule] = await Promise.all([
				import(MODULE_PATH) as Promise<SnapshotChunkProtocolModule>,
				import(NODE_MODULE_PATH),
			]);
			const receiver = await startedNode(nodeModule.DRPNetworkNode);
			const server = await startedNode(nodeModule.DRPNetworkNode);
			nodes.push(receiver, server);
			await connectWithoutDialFromServer(receiver, server);
			const receiverPort = module.createSnapshotChunkProtocolPort(receiver);
			const serverPort = module.createSnapshotChunkProtocolPort(server);
			ports.push(receiverPort, serverPort);
			const observedPeers: string[] = [];
			serverPort.serve(async (stream) => {
				observedPeers.push(stream.peerId);
				const request = await stream.read(64, { signal: new AbortController().signal });
				await stream.write(new Uint8Array(request).reverse(), { signal: new AbortController().signal });
				await stream.close();
			});
			const dial = vi.spyOn(receiver, "safeDial");
			const stream = await receiverPort.open(server.peerId, { signal: new AbortController().signal });
			await stream.write(Uint8Array.of(1, 2, 3, 4), { signal: new AbortController().signal });
			await expect(stream.read(64, { signal: new AbortController().signal })).resolves.toEqual(
				Uint8Array.of(4, 3, 2, 1)
			);
			expect(observedPeers).toEqual([receiver.peerId]);
			expect(dial).not.toHaveBeenCalled();
			await expect(
				receiverPort.open("12D3KooWNotConnectedSnapshotPeer", { signal: new AbortController().signal })
			).rejects.toMatchObject({ code: "connection-unavailable" });
			expect(dial).not.toHaveBeenCalled();
		});

		it("rejects a live oversized frame at the production read boundary", async () => {
			const [module, nodeModule] = await Promise.all([
				import(MODULE_PATH) as Promise<SnapshotChunkProtocolModule>,
				import(NODE_MODULE_PATH),
			]);
			const receiver = await startedNode(nodeModule.DRPNetworkNode);
			const server = await startedNode(nodeModule.DRPNetworkNode);
			nodes.push(receiver, server);
			await connectWithoutDialFromServer(receiver, server);
			const receiverPort = module.createSnapshotChunkProtocolPort(receiver);
			const serverPort = module.createSnapshotChunkProtocolPort(server);
			ports.push(receiverPort, serverPort);
			serverPort.serve(async (stream) => {
				await stream.read(64, { signal: new AbortController().signal });
				await stream.write(new Uint8Array(65), { signal: new AbortController().signal });
			});
			const stream = await receiverPort.open(server.peerId, { signal: new AbortController().signal });
			await stream.write(Uint8Array.of(7), { signal: new AbortController().signal });
			await expect(stream.read(64, { signal: new AbortController().signal })).rejects.toMatchObject({
				code: "protocol-violation",
			});
		});

		it("aborts the exact stream without accepting a later in-bound frame", async () => {
			const [module, nodeModule] = await Promise.all([
				import(MODULE_PATH) as Promise<SnapshotChunkProtocolModule>,
				import(NODE_MODULE_PATH),
			]);
			const receiver = await startedNode(nodeModule.DRPNetworkNode);
			const server = await startedNode(nodeModule.DRPNetworkNode);
			nodes.push(receiver, server);
			await connectWithoutDialFromServer(receiver, server);
			const receiverPort = module.createSnapshotChunkProtocolPort(receiver);
			const serverPort = module.createSnapshotChunkProtocolPort(server);
			ports.push(receiverPort, serverPort);
			let serverWriteSettled = false;
			serverPort.serve(async (stream) => {
				await stream.read(64, { signal: new AbortController().signal });
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
				await stream.write(Uint8Array.of(9), { signal: new AbortController().signal });
				serverWriteSettled = true;
			});
			const controller = new AbortController();
			const stream = await receiverPort.open(server.peerId, { signal: controller.signal });
			await stream.write(Uint8Array.of(7), { signal: controller.signal });
			const pending = stream.read(64, { signal: controller.signal });
			controller.abort(new Error("snapshot-test-abort"));
			await expect(pending).rejects.toMatchObject({ code: "aborted" });
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
			expect(serverWriteSettled).toBe(false);
		});
	});
});

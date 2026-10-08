import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { describe, expect, test } from "vitest";

interface CampaignSnapshot {
	readonly budget: number;
	readonly charged: number;
	readonly denied: number;
	readonly dependencyDialQueue: number;
	readonly live: number;
	readonly queued: number;
	readonly selected: number;
	readonly upgrade: number;
}

interface T3CampaignNode {
	getPeerSelectionSnapshot(): CampaignSnapshot;
	readonly _node?: EventTarget;
	start(): Promise<void>;
	stop(): Promise<void>;
}

interface NetworkNodeConstructor {
	new (config: unknown): T3CampaignNode;
	readonly prototype: object;
}

const networkSourceModuleUrl = new URL("../../network/src/node.ts", import.meta.url).href;

function peer(index: number): PeerId {
	const bytes = new Uint8Array(32);
	bytes[0] = 0x49;
	new DataView(bytes.buffer).setUint32(28, index + 1, false);
	return peerIdFromPublicKey(privateKeyFromRaw(bytes).publicKey);
}

async function runCampaign(
	DRPNetworkNode: NetworkNodeConstructor,
	maxConnections: number,
	maxParallelDials: number
): Promise<CampaignSnapshot> {
	const node = new DRPNetworkNode({
		bootstrap_peers: [],
		connection_budget: { max_connections: maxConnections, max_parallel_dials: maxParallelDials },
		control_plane: { peer_selection: { expected_replicas: 1_000 } },
		listen_addresses: [],
		log_config: { level: "silent" },
	} as never) as T3CampaignNode;
	await node.start();
	try {
		const host = node["_node"];
		if (host === undefined) throw new Error("expected campaign host");
		for (let index = 0; index < 1_000; index += 1) {
			const id = peer(index + 10_000);
			host.dispatchEvent(
				new CustomEvent("peer:discovery", {
					detail: {
						id,
						multiaddrs: [multiaddr(`/ip4/127.0.0.1/tcp/${20_000 + index}/p2p/${id}`)],
						protocols: [],
					},
				})
			);
		}
		return node.getPeerSelectionSnapshot();
	} finally {
		await node.stop();
	}
}

describe("D.93.49 1,000-peer T3 production campaigns", () => {
	test("runs 1,000 unique records through the genuine browser and node budgets without asynchronous settling", async (context) => {
		const { DRPNetworkNode } = (await import(networkSourceModuleUrl)) as {
			DRPNetworkNode: NetworkNodeConstructor;
		};
		if (
			typeof Object.getOwnPropertyDescriptor(DRPNetworkNode.prototype, "getPeerSelectionSnapshot")?.value !== "function"
		) {
			context.skip();
			return;
		}
		const browser = await runCampaign(DRPNetworkNode, 48, 6);
		const node = await runCampaign(DRPNetworkNode, 300, 100);

		expect(browser).toMatchObject({ budget: 48, charged: 0, denied: 958, selected: 42 });
		expect(node).toMatchObject({ budget: 300, charged: 0, denied: 800, selected: 200 });
		for (const snapshot of [browser, node]) {
			const occupied = snapshot.queued + snapshot.selected + snapshot.charged + snapshot.upgrade + snapshot.live;
			expect(occupied).toBeLessThanOrEqual(snapshot.budget);
			expect(snapshot.dependencyDialQueue).toBeLessThanOrEqual(snapshot.budget);
		}
	});
});

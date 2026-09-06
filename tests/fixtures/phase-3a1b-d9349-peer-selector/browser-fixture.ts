import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";

import { DRPNetworkNode } from "../../../packages/network/src/node.js";

interface Snapshot {
	readonly budget: number;
	readonly charged: number;
	readonly denied: number;
	readonly dependencyDialQueue: number;
	readonly expectedReplicas: number | undefined;
	readonly globalDiscovery: boolean;
	readonly live: number;
	readonly queued: number;
	readonly selected: number;
	readonly upgrade: number;
}

interface T3BrowserNode extends DRPNetworkNode {
	getPeerSelectionSnapshot(): Snapshot;
}

function peer(index: number): PeerId {
	const bytes = new Uint8Array(32);
	bytes[0] = 0x49;
	new DataView(bytes.buffer).setUint32(28, index + 1, false);
	return peerIdFromPublicKey(privateKeyFromRaw(bytes).publicKey);
}

function occupied(snapshot: Snapshot): number {
	return snapshot.queued + snapshot.selected + snapshot.charged + snapshot.upgrade + snapshot.live;
}

/** @returns Whether the production node exposes the installed T3 owner. */
export function hasPeerSelectorRuntime(): boolean {
	return (
		typeof Object.getOwnPropertyDescriptor(DRPNetworkNode.prototype, "getPeerSelectionSnapshot")?.value === "function"
	);
}

/**
 * Run one genuine browser node through the fixed T3 ceiling.
 * @returns Detached discovery and explicit-headroom evidence.
 */
export async function runBrowserPeerSelectorCeiling(): Promise<{
	afterDiscovery: Snapshot;
	afterExplicit: Snapshot;
	seventhExplicitDenied: boolean;
}> {
	const node = new DRPNetworkNode({
		bootstrap_peers: [],
		connection_budget: { max_connections: 48, max_parallel_dials: 6 },
		control_plane: { peer_selection: { expected_replicas: 50 } },
		listen_addresses: [],
		log_config: { level: "silent" },
	} as never) as T3BrowserNode;
	await node.start();
	try {
		const host = node["_node"];
		if (host === undefined) throw new Error("browser selector host was not created");
		for (let index = 0; index < 49; index += 1) {
			const id = peer(index + 1_000);
			host.dispatchEvent(
				new CustomEvent("peer:discovery", {
					detail: {
						id,
						multiaddrs: [multiaddr(`/ip4/127.0.0.1/tcp/${50_000 + index}/p2p/${id}`)],
						protocols: [],
					},
				})
			);
		}
		const afterDiscovery = node.getPeerSelectionSnapshot();
		if (occupied(afterDiscovery) > afterDiscovery.budget) throw new Error("browser discovery exceeded budget");

		for (let index = 0; index < 6; index += 1) {
			await node
				.safeDial(
					multiaddr(`/ip4/127.0.0.1/tcp/${60_000 + index}/p2p/${peer(index + 2_000)}`),
					undefined,
					AbortSignal.timeout(500)
				)
				.catch(() => undefined);
		}
		const beforeSeventh = node.getPeerSelectionSnapshot();
		await node
			.safeDial(multiaddr(`/ip4/127.0.0.1/tcp/${60_006}/p2p/${peer(2_006)}`), undefined, AbortSignal.timeout(500))
			.catch(() => undefined);
		const afterExplicit = node.getPeerSelectionSnapshot();
		const seventhExplicitDenied =
			afterExplicit.denied === beforeSeventh.denied + 1 &&
			afterExplicit.charged === beforeSeventh.charged &&
			occupied(afterExplicit) === afterExplicit.budget;

		return { afterDiscovery, afterExplicit, seventhExplicitDenied };
	} finally {
		await node.stop();
	}
}

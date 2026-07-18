/**
 * Multi-node spawn harness: boots one in-process bootstrap/relay
 * DRPNetworkNode plus N real DRPNode instances (real libp2p, gossipsub,
 * websockets on loopback), meshes them with direct WS connections, and
 * creates the same DRPObject on every node.
 *
 * Cheapest working pattern found in this repo (derived from
 * packages/node/tests/handlers.test.ts and async-drp.test.ts):
 *   - bootstrap: DRPNetworkNode({ bootstrap: true, listen /ip4/.../tcp/0/ws })
 *   - each node: explicit ws listen address (default listen is
 *     /p2p-circuit + /webrtc, which is NOT directly dialable in-process
 *     without relay round-trips) + bootstrap_peers -> the local bootstrap
 *   - explicit pairwise dial instead of waiting for pubsub peer discovery
 *
 * This helper stays under node tests because spawning a cluster necessarily
 * depends on @ts-drp/node. Moving it into @ts-drp/test-utils would invert the
 * dependency direction and create a node -> test-utils -> node cycle.
 */
import { type Libp2p } from "@libp2p/interface";
import { DRPNetworkNode } from "@ts-drp/network";
import { createACL, type DRPObject, type HashGraph } from "@ts-drp/object";
import { BoxGame2D } from "@ts-drp/test-utils";
import { type IACL, NodeEventName } from "@ts-drp/types";

import { DRPNode } from "../../src/index.js";

/* ------------------------------------------------------------------ */
/* Cluster                                                             */
/* ------------------------------------------------------------------ */

export interface ClusterNode {
	index: number;
	node: DRPNode;
	peerId: string;
	obj: DRPObject<BoxGame2D>;
	/** per-node counts of DRP protocol events observed */
	events: Record<string, number>;
}

export interface ClusterTimings {
	bootstrapMs: number;
	nodeStartMs: number;
	meshConnectMs: number;
	objectSetupMs: number;
	totalMs: number;
}

export interface Cluster {
	bootstrap: DRPNetworkNode;
	nodes: ClusterNode[];
	objectId: string;
	timings: ClusterTimings;
	/** how many explicit bootstrap redials were needed (0 = startup dials all worked) */
	bootstrapRedials: number;
	stop(): Promise<void>;
}

export async function waitFor(
	cond: () => boolean,
	timeoutMs: number,
	what: string,
	pollMs = 100,
	detail?: () => string
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	if (cond()) return;
	throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}${detail ? `\n  detail: ${detail()}` : ""}`);
}

function libp2pOf(node: DRPNode): Libp2p {
	return node.networkNode["_node"] as Libp2p;
}

function trackEvents(entry: ClusterNode): void {
	for (const name of Object.values(NodeEventName)) {
		entry.events[name] = 0;
		(entry.node as unknown as EventTarget).addEventListener(name, () => {
			entry.events[name] = (entry.events[name] ?? 0) + 1;
		});
	}
}

/**
 * identically-constructed ACL for every node: all peers admins, keys set
 * @param peers
 */
function buildACL(peers: { peerId: string; blsPublicKey: string }[]): IACL {
	const acl = createACL({ admins: peers.map((p) => p.peerId) });
	for (const p of peers) {
		acl.context = { caller: p.peerId };
		acl.setKey(p.blsPublicKey);
	}
	return acl;
}

let spawnCounter = 0;

export async function spawnCluster(n: number, objectId = "proptest-multinode"): Promise<Cluster> {
	const t0 = performance.now();
	const silent = { level: "silent" as const };
	// unique keychain seeds per cluster: reusing seeds (= reusing libp2p peer
	// ids) across sequential clusters in one process makes redials flaky
	const clusterTag = `cluster${spawnCounter++}`;

	// 1. bootstrap/relay node
	const bootstrap = new DRPNetworkNode({
		bootstrap: true,
		listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
		bootstrap_peers: [],
		log_config: silent,
	});
	await bootstrap.start();
	const tBootstrap = performance.now();

	// 2. N nodes, each with its own directly-dialable ws listen address
	const nodes: DRPNode[] = Array.from(
		{ length: n },
		(_, i) =>
			new DRPNode({
				network_config: {
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					bootstrap_peers: bootstrap.getMultiaddrs(),
					log_config: silent,
				},
				keychain_config: { private_key_seed: `proptest-${clusterTag}-node-${i}` },
				log_config: silent,
			})
	);
	await Promise.all(nodes.map((nd) => nd.start()));

	// Every node dials the bootstrap exactly once inside start(); that dial
	// can fail silently (error only logged). KEY FINDING: the reconnect
	// interval does NOT recover from this — DRPIntervalReconnectBootstrap
	// skips reconnecting whenever the node still has its own listen address
	// (it checks networkNode.getMultiaddrs().length, not connectivity), so an
	// isolated node stays isolated forever. We compensate with explicit
	// retries and count how often that was needed.
	const btLibp2p = bootstrap["_node"] as Libp2p;
	const btPeerId = btLibp2p.peerId.toString();
	let bootstrapRedials = 0;
	for (let attempt = 0; attempt < 20; attempt++) {
		const isolated = nodes.filter(
			(nd) =>
				!libp2pOf(nd)
					.getConnections()
					.some((c) => c.remotePeer.toString() === btPeerId)
		);
		if (isolated.length === 0 && new Set(btLibp2p.getConnections().map((c) => c.remotePeer.toString())).size >= n) {
			break;
		}
		for (const nd of isolated) {
			try {
				bootstrapRedials++;
				await nd.networkNode.connect(bootstrap.getMultiaddrs());
			} catch {
				// retried next attempt
			}
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	await waitFor(
		() => new Set(btLibp2p.getConnections().map((c) => c.remotePeer.toString())).size >= n,
		15_000,
		"bootstrap to see all nodes",
		100,
		() => {
			const seen = new Set(btLibp2p.getConnections().map((c) => c.remotePeer.toString()));
			const nodeViews = nodes.map(
				(nd, i) =>
					`node${i}(${nd.networkNode.peerId.slice(-6)}): [${libp2pOf(nd)
						.getConnections()
						.map((c) => c.remotePeer.toString().slice(-6))
						.join(",")}]`
			);
			return `bt sees ${seen.size}/${n}: [${[...seen].map((p) => p.slice(-6)).join(",")}]\n  ${nodeViews.join("\n  ")}`;
		}
	);
	const tStart = performance.now();

	// 3. explicit full mesh: dial every pair over ws (no discovery wait),
	// retrying missing pairs — single-shot dials are not reliable enough
	const hasDirect = (a: DRPNode, b: DRPNode): boolean =>
		libp2pOf(a)
			.getConnections()
			.some((c) => c.limits === undefined && c.remotePeer.toString() === b.networkNode.peerId);
	for (let attempt = 0; attempt < 20; attempt++) {
		const missing: [number, number][] = [];
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				if (!hasDirect(nodes[i], nodes[j]) || !hasDirect(nodes[j], nodes[i])) missing.push([i, j]);
			}
		}
		if (missing.length === 0) break;
		for (const [i, j] of missing) {
			const addrs = libp2pOf(nodes[j])
				.getMultiaddrs()
				.filter((a) => a.toString().includes("/ws"));
			try {
				await nodes[i].networkNode.connect(addrs);
			} catch {
				// retried next attempt
			}
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	await waitFor(
		() =>
			nodes.every((nd) => {
				const connected = new Set(
					libp2pOf(nd)
						.getConnections()
						.filter((c) => c.limits === undefined)
						.map((c) => c.remotePeer.toString())
				);
				return nodes.every((other) => other === nd || connected.has(other.networkNode.peerId));
			}),
		15_000,
		"full direct mesh"
	);
	const tMesh = performance.now();

	// 4. identical object on every node (shared id, identically-built ACL)
	const peerInfos = nodes.map((nd) => ({ peerId: nd.networkNode.peerId, blsPublicKey: nd.keychain.blsPublicKey }));
	const cluster: ClusterNode[] = [];
	for (const [i, nd] of nodes.entries()) {
		const obj = await nd.createObject({ drp: new BoxGame2D(), acl: buildACL(peerInfos), id: objectId });
		const entry: ClusterNode = { index: i, node: nd, peerId: nd.networkNode.peerId, obj, events: {} };
		trackEvents(entry);
		cluster.push(entry);
	}

	// 5. wait for the gossipsub topic mesh: every node sees every other
	await waitFor(
		() => cluster.every((c) => c.node.networkNode.getGroupPeers(objectId).length >= n - 1),
		15_000,
		"gossipsub topic subscription propagation"
	);
	const tObj = performance.now();

	return {
		bootstrap,
		nodes: cluster,
		objectId,
		bootstrapRedials,
		timings: {
			bootstrapMs: tBootstrap - t0,
			nodeStartMs: tStart - tBootstrap,
			meshConnectMs: tMesh - tStart,
			objectSetupMs: tObj - tMesh,
			totalMs: tObj - t0,
		},
		stop: async (): Promise<void> => {
			await Promise.all([...nodes.map((nd) => nd.stop()), bootstrap.stop()]);
		},
	};
}

/* ------------------------------------------------------------------ */
/* Convergence checks & diagnostics                                    */
/* ------------------------------------------------------------------ */

export function hashGraphOf(c: ClusterNode): HashGraph {
	return c.obj["hashGraph"] as unknown as HashGraph;
}

export function stateFingerprint(c: ClusterNode): string {
	const drp = c.obj.drp;
	if (!drp) return "null";
	return JSON.stringify({ positions: drp.query_positions(), log: drp.query_log() });
}

export function sortedFrontier(c: ClusterNode): string[] {
	return hashGraphOf(c).getFrontier().sort();
}

export function vertexHashes(c: ClusterNode): string[] {
	return c.obj.vertices.map((v) => v.hash).sort();
}

export function clusterConverged(nodes: ClusterNode[]): boolean {
	const ref = nodes[0];
	const refState = stateFingerprint(ref);
	const refFrontier = JSON.stringify(sortedFrontier(ref));
	const refVertices = JSON.stringify(vertexHashes(ref));
	return nodes.every(
		(c) =>
			stateFingerprint(c) === refState &&
			JSON.stringify(sortedFrontier(c)) === refFrontier &&
			JSON.stringify(vertexHashes(c)) === refVertices
	);
}

const short = (h: string): string => h.slice(0, 8);

export function clusterReport(nodes: ClusterNode[]): string {
	const union = new Set<string>();
	for (const c of nodes) for (const h of vertexHashes(c)) union.add(h);
	const lines: string[] = [];
	for (const c of nodes) {
		const have = new Set(vertexHashes(c));
		const missing = [...union].filter((h) => !have.has(h)).map(short);
		lines.push(
			`  node${c.index} (${short(c.peerId)}): vertices=${have.size}/${union.size}` +
				` frontier=[${sortedFrontier(c).map(short).join(",")}]` +
				` missing=[${missing.join(",")}]` +
				` events=${JSON.stringify(c.events)}`
		);
	}
	for (const c of nodes) lines.push(`  node${c.index} state=${stateFingerprint(c)}`);
	return lines.join("\n");
}

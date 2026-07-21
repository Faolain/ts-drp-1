/**
 * End-to-end regression for clock-skew convergence over real libp2p transports.
 * Three nodes share a position-map DRP, then one node mints updates exactly one
 * future-tolerance window ahead of its peers.
 */
import { type IdentifyResult, type Libp2p } from "@libp2p/interface";
import { DRPNetworkNode } from "@ts-drp/network";
import {
	ActionType,
	type IDRP,
	type IDRPObject,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { raceEvent } from "race-event";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { DRPNode } from "../../src/index.js";

/** Tiny 2D position map DRP: each user moves their own box (grid example shape). */
class PosMapDRP implements IDRP {
	semanticsType: SemanticsType = SemanticsType.pair;
	positions: Map<string, { x: number; y: number }> = new Map();

	move(user: string, x: number, y: number): void {
		this.positions.set(user, { x, y });
	}

	query_pos(user: string): { x: number; y: number } | undefined {
		return this.positions.get(user);
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

const OBJ_ID = "e2e-sync-lockup-grid";
const sortedHashes = (o: IDRPObject<PosMapDRP>): string => [...o.vertices.map((v) => v.hash)].sort().join("|");

describe("e2e: clock-skewed peers remain synchronized", () => {
	vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

	const realNow = Date.now.bind(Date);
	let skewMs = 0;
	// The public validation contract accepts this exact boundary.
	const SKEW = 60_000;

	let bootstrapNode: DRPNetworkNode;
	let node1: DRPNode;
	let node2: DRPNode;
	let node3: DRPNode;
	let obj1: IDRPObject<PosMapDRP>;
	let obj2: IDRPObject<PosMapDRP>;
	let obj3: IDRPObject<PosMapDRP>;

	function onSkewedClock<T>(fn: () => T): T {
		skewMs = SKEW;
		try {
			return fn();
		} finally {
			skewMs = 0;
		}
	}

	const createNewNode = (privateKeySeed: string): DRPNode =>
		new DRPNode({
			network_config: {
				bootstrap_peers: bootstrapNode.getMultiaddrs(),
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
				pubsub: { peer_discovery_interval: 500 },
			},
			keychain_config: { private_key_seed: privateKeySeed },
			log_config: { level: "silent" },
		});

	beforeAll(async () => {
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);

		bootstrapNode = new DRPNetworkNode({
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			bootstrap_peers: [],
			log_config: { level: "silent" },
			relay_service: { enabled: true },
			seed: true,
		});
		await bootstrapNode.start();
		const btLibp2p = bootstrapNode["_node"] as Libp2p;

		node1 = createNewNode("e2e-lockup-1");
		node2 = createNewNode("e2e-lockup-2");
		node3 = createNewNode("e2e-lockup-3");

		const controller = new AbortController();
		for (const node of [node1, node2, node3]) {
			const identified = raceEvent(btLibp2p, "peer:identify", controller.signal, {
				filter: (event: CustomEvent<IdentifyResult>) => event.detail.listenAddrs.length > 0,
			});
			await node.start();
			await identified;
		}

		// wait for a full mesh between the three nodes (pubsub peer discovery)
		const peerIds = [node1, node2, node3].map((n) => n.networkNode.peerId);
		await vi.waitFor(
			() => {
				for (const node of [node1, node2, node3]) {
					const peers = node.networkNode.getAllPeers();
					for (const other of peerIds) {
						if (other === node.networkNode.peerId) continue;
						expect(peers).toContain(other);
					}
				}
			},
			{ timeout: 30_000, interval: 250 }
		);

		obj1 = await node1.createObject({ id: OBJ_ID, drp: new PosMapDRP() });
		obj2 = await node2.connectObject({
			id: OBJ_ID,
			drp: new PosMapDRP(),
			sync: { peerId: node1.networkNode.peerId },
		});
		obj3 = await node3.connectObject({
			id: OBJ_ID,
			drp: new PosMapDRP(),
			sync: { peerId: node1.networkNode.peerId },
		});

		// wait until every node sees the two others subscribed to the object topic
		await vi.waitFor(
			() => {
				for (const node of [node1, node2, node3]) {
					expect(node.networkNode.getGroupPeers(OBJ_ID).length).toBeGreaterThanOrEqual(2);
				}
			},
			{ timeout: 30_000, interval: 250 }
		);
	});

	afterAll(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled([node1?.stop(), node2?.stop(), node3?.stop(), bootstrapNode?.stop()]);
	});

	test("phase 1: healthy nodes converge under concurrent updates", async () => {
		const nodes = [node1, node2, node3];
		const objs = [obj1, obj2, obj3];

		for (let round = 1; round <= 3; round++) {
			// all three users move their boxes concurrently
			for (let i = 0; i < nodes.length; i++) {
				objs[i].drp?.move(`user${i + 1}`, round, i);
			}
			await vi.waitFor(
				() => {
					expect(sortedHashes(obj1)).toEqual(sortedHashes(obj2));
					expect(sortedHashes(obj2)).toEqual(sortedHashes(obj3));
				},
				{ timeout: 20_000, interval: 200 }
			);
		}

		for (let i = 0; i < objs.length; i++) {
			expect(obj1.drp?.query_pos(`user${i + 1}`)).toEqual({ x: 3, y: i });
			expect(obj2.drp?.query_pos(`user${i + 1}`)).toEqual({ x: 3, y: i });
			expect(obj3.drp?.query_pos(`user${i + 1}`)).toEqual({ x: 3, y: i });
		}
	});

	test("phase 2: updates at the future-tolerance boundary converge", async () => {
		for (let i = 1; i <= 3; i++) {
			onSkewedClock(() => obj3.drp?.move("user3", 100 + i, 100 + i));
		}

		await vi.waitFor(
			() => {
				for (const object of [obj1, obj2, obj3]) {
					expect(object.drp?.query_pos("user3")).toEqual({ x: 103, y: 103 });
				}
				expect(sortedHashes(obj1)).toEqual(sortedHashes(obj2));
				expect(sortedHashes(obj2)).toEqual(sortedHashes(obj3));
			},
			{ timeout: 20_000, interval: 200 }
		);

		obj1.drp?.move("user1", 50, 50);
		obj2.drp?.move("user2", 60, 60);
		await vi.waitFor(
			() => {
				for (const object of [obj1, obj2, obj3]) {
					expect(object.drp?.query_pos("user1")).toEqual({ x: 50, y: 50 });
					expect(object.drp?.query_pos("user2")).toEqual({ x: 60, y: 60 });
				}
				expect(sortedHashes(obj1)).toEqual(sortedHashes(obj2));
				expect(sortedHashes(obj2)).toEqual(sortedHashes(obj3));
			},
			{ timeout: 20_000, interval: 200 }
		);

		onSkewedClock(() => obj3.drp?.move("user3", 111, 111));
		await vi.waitFor(
			() => {
				for (const object of [obj1, obj2, obj3]) {
					expect(object.drp?.query_pos("user3")).toEqual({ x: 111, y: 111 });
				}
				expect(sortedHashes(obj1)).toEqual(sortedHashes(obj2));
				expect(sortedHashes(obj2)).toEqual(sortedHashes(obj3));
			},
			{ timeout: 20_000, interval: 200 }
		);
	});
});

/**
 * Phase 1o-a RED: authenticated sync knowledge is useful evidence, not an
 * unlimited egress entitlement. The handler only records graph-known hashes
 * through these state seams; this owner pins bounded shared-cut selection
 * without weakening the existing wire ceiling or promising that every old cut
 * remains selected. Internal retention/storage bounds remain a distinct Phase
 * 1o obligation because this behavioral owner intentionally does not inspect
 * private state.
 */
import { DRP_HEADS_CHUNK_PROTOCOL, SYNC_HEADS_FIELD_HASH_CAP } from "@ts-drp/network";
import { type IDRP, type Message, SemanticsType, Sync } from "@ts-drp/types";
import { afterEach, describe, expect, test } from "vitest";

import { DRPNode } from "../src/index.js";
import { buildSyncPayloadForProtocol } from "../src/sync-codec.js";
import { recordBranchCuts, recordSharedHeads, sharedHashes } from "../src/sync-state.js";

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value++;
	}
}

function makeNode(seed: string): DRPNode {
	return new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		log_config: { level: "silent" },
	});
}

function buildHeadsPayload(node: DRPNode, objectId: string, peerId: string): Message {
	return buildSyncPayloadForProtocol(node, {
		objectId,
		peerId,
		protocol: DRP_HEADS_CHUNK_PROTOCOL,
		purpose: "scheduled-probe",
	});
}

describe("Phase 1o-a bounded per-object/peer shared-cut egress", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("bounds historical cut selection while retaining the current verified shared frontier", async () => {
		const owner = makeNode("phase-1o-a-ledger-owner");
		const remote = makeNode("phase-1o-a-ledger-remote");
		nodes.push(owner, remote);
		await Promise.all(nodes.map((node) => node.start()));
		const object = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		for (let index = 0; index < SYNC_HEADS_FIELD_HASH_CAP + 16; index++) object.drp?.increment();

		const knownHistory = object.vertices.filter(({ hash }) => hash !== object.vertices[0]?.hash);
		const currentSharedHead = object.getHistoryHeads()[0];
		if (currentSharedHead === undefined) throw new Error("Expected one current history head");
		const historicalCuts = knownHistory.map(({ hash }) => hash).filter((hash) => hash !== currentSharedHead);
		expect(historicalCuts.length).toBeGreaterThan(SYNC_HEADS_FIELD_HASH_CAP);

		// These are all locally graph-known hashes, matching the authenticated and
		// verified inputs passed by the production handlers into this state owner.
		recordBranchCuts(owner, object.id, remote.networkNode.peerId, historicalCuts);
		recordSharedHeads(owner, object.id, remote.networkNode.peerId, [currentSharedHead]);

		const selected = sharedHashes(owner, object.id, remote.networkNode.peerId);
		expect
			.soft(selected.length, "one peer/object selection stays inside its egress field entitlement")
			.toBeLessThanOrEqual(SYNC_HEADS_FIELD_HASH_CAP);
		expect
			.soft(selected, "the current frontier outranks historical cuts in bounded egress")
			.toContain(currentSharedHead);

		let payload: Message | undefined;
		let failure: unknown;
		try {
			payload = buildHeadsPayload(owner, object.id, remote.networkNode.peerId);
		} catch (error) {
			failure = error;
		}
		expect.soft(failure, "bounded local state must not self-trigger the unchanged wire cap").toBeUndefined();
		if (payload !== undefined) {
			const wire = Sync.decode(payload.data);
			expect.soft(wire.sharedHeads.length).toBeLessThanOrEqual(SYNC_HEADS_FIELD_HASH_CAP);
			expect.soft(wire.sharedHeads).toContain(currentSharedHead);
		}
	});

	test("a wide cut history cannot starve another peer or contaminate another object's egress", async () => {
		const owner = makeNode("phase-1o-a-isolation-owner");
		const abusivePeer = makeNode("phase-1o-a-isolation-abusive");
		const honestPeer = makeNode("phase-1o-a-isolation-honest");
		nodes.push(owner, abusivePeer, honestPeer);
		await Promise.all(nodes.map((node) => node.start()));
		const attacked = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const independent = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		for (let index = 0; index < SYNC_HEADS_FIELD_HASH_CAP + 8; index++) attacked.drp?.increment();
		independent.drp?.increment();

		const attackedKnown = attacked.vertices.map(({ hash }) => hash);
		const attackedRoot = attacked.vertices[0]?.hash;
		const independentRoot = independent.vertices[0]?.hash;
		if (attackedRoot === undefined || independentRoot === undefined) throw new Error("Expected root vertices");
		recordBranchCuts(owner, attacked.id, abusivePeer.networkNode.peerId, attackedKnown);
		recordSharedHeads(owner, attacked.id, honestPeer.networkNode.peerId, [attackedRoot]);
		recordSharedHeads(owner, independent.id, abusivePeer.networkNode.peerId, [independentRoot]);

		const honestWire = Sync.decode(buildHeadsPayload(owner, attacked.id, honestPeer.networkNode.peerId).data);
		const independentWire = Sync.decode(buildHeadsPayload(owner, independent.id, abusivePeer.networkNode.peerId).data);

		expect(honestWire.sharedHeads).toEqual([attackedRoot]);
		expect(independentWire.sharedHeads).toEqual([independentRoot]);
		expect(sharedHashes(owner, attacked.id, honestPeer.networkNode.peerId)).toEqual(honestWire.sharedHeads);
		expect(sharedHashes(owner, independent.id, abusivePeer.networkNode.peerId)).toEqual(independentWire.sharedHeads);
	});
});

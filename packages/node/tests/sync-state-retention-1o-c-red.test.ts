/**
 * Phase 1o-c RED: observing or completing absent sync state must not retain an
 * empty `(object, peer)` entry. The public unsubscribe lifecycle is the cost seam:
 * its current cleanup decodes every retained tuple key, so absent no-op calls
 * must not make that synchronous work grow. This test does not inspect private
 * fields or prescribe a storage representation, eviction policy, or quota.
 */
import { HashGraph } from "@ts-drp/object";
import { type IDRP, SemanticsType } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNode } from "../src/index.js";
import {
	advertisedTheseHeads,
	completePresentExactRequests,
	previewSyncSend,
	recordBranchCuts,
	recordSharedHeads,
	sharedHashes,
} from "../src/sync-state.js";

const ABSENT_PAIR_READS = 128;

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

describe("Phase 1o-c sync-state retention and lifecycle reclamation", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("absent-pair reads and no-op completion add no retained keys or unsubscribe cleanup work", async () => {
		const owner = makeNode("phase-1o-c-read-retention-owner");
		nodes.push(owner);
		await owner.start();
		const attacked = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const independent = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const attackedPeer = "phase-1o-c-mutated-attacked-peer";
		const independentPeer = "phase-1o-c-mutated-independent-peer";

		for (let index = 0; index < ABSENT_PAIR_READS; index++) {
			expect(sharedHashes(owner, attacked.id, `shared-read-${index}`)).toEqual([]);
			expect(advertisedTheseHeads(owner, attacked.id, `advertised-read-${index}`, [])).toBe(true);
			expect(previewSyncSend(owner, attacked.id, `preview-read-${index}`, "scheduled-probe")).toEqual({
				requestedHashes: [],
				send: true,
			});
			completePresentExactRequests(owner, attacked.id, `completion-read-${index}`, () => {
				throw new Error("an absent exact-request lifecycle has nothing to inspect");
			});
		}

		// Keep one genuinely mutated pair for each object. Those entries are
		// legitimate cleanup work and make the isolation assertion meaningful.
		recordBranchCuts(owner, attacked.id, attackedPeer, [HashGraph.rootHash]);
		recordSharedHeads(owner, independent.id, independentPeer, [HashGraph.rootHash]);
		expect(sharedHashes(owner, attacked.id, attackedPeer)).toEqual([HashGraph.rootHash]);
		expect(sharedHashes(owner, independent.id, independentPeer)).toEqual([HashGraph.rootHash]);

		const parse = vi.spyOn(JSON, "parse");
		const callsBeforeUnsubscribe = parse.mock.calls.length;
		owner.unsubscribeObject(attacked.id);
		const cleanupKeyVisits = parse.mock.calls.length - callsBeforeUnsubscribe;

		expect
			.soft(
				cleanupKeyVisits,
				"absent reads and no-op completion must not retain keys later visited by public object cleanup"
			)
			.toBeLessThanOrEqual(2);
		expect.soft(sharedHashes(owner, attacked.id, attackedPeer), "unsubscribed object state is reclaimed").toEqual([]);
		expect
			.soft(sharedHashes(owner, independent.id, independentPeer), "another object's real peer state remains isolated")
			.toEqual([HashGraph.rootHash]);
	});

	test("stop reclaims real sync state for every object and peer", async () => {
		const owner = makeNode("phase-1o-c-stop-reclamation-owner");
		nodes.push(owner);
		await owner.start();
		const first = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const second = await owner.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });

		recordBranchCuts(owner, first.id, "phase-1o-c-stop-peer-a", [HashGraph.rootHash]);
		recordSharedHeads(owner, second.id, "phase-1o-c-stop-peer-b", [HashGraph.rootHash]);
		expect(sharedHashes(owner, first.id, "phase-1o-c-stop-peer-a")).toEqual([HashGraph.rootHash]);
		expect(sharedHashes(owner, second.id, "phase-1o-c-stop-peer-b")).toEqual([HashGraph.rootHash]);

		await owner.stop();

		expect(sharedHashes(owner, first.id, "phase-1o-c-stop-peer-a")).toEqual([]);
		expect(sharedHashes(owner, second.id, "phase-1o-c-stop-peer-b")).toEqual([]);
	});
});

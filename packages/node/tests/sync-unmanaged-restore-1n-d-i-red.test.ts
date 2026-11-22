/**
 * Phase 1n-d(i) corrective RED: a public-put object has no local acquisition
 * provenance, but restart must still restore ordinary anti-entropy without
 * treating a creator-bound, other-peer-shaped id as connected provenance.
 */
import { DRP_HEADS_CHUNK_PROTOCOL, type NegotiatedSyncSender, type SelectedSyncProtocol } from "@ts-drp/network";
import { createPermissionlessACL, DRPObject } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	type Message,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPNode, INITIAL_SYNC_RETRY_INTERVAL_MS } from "../src/index.js";

const ANTI_ENTROPY_INTERVAL_MS = 60_000;
const HEADS_SELECTION = Object.freeze({
	mode: "heads-chunk",
	protocol: DRP_HEADS_CHUNK_PROTOCOL,
} satisfies SelectedSyncProtocol);

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value += 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

interface SyncAttempt {
	readonly at: number;
	readonly message: Message;
}

class TimestampedSyncSender implements NegotiatedSyncSender {
	readonly attempts: SyncAttempt[] = [];

	async sendSyncMessage(
		_peerId: string,
		payloadFactory: (selection: SelectedSyncProtocol) => Message | Promise<Message>
	): Promise<void> {
		this.attempts.push({ at: Date.now(), message: await payloadFactory(HEADS_SELECTION) });
	}

	sendSyncResponseMessage(): Promise<void> {
		return Promise.resolve();
	}

	forObject(id: string): SyncAttempt[] {
		return this.attempts.filter(({ message }) => message.objectId === id);
	}

	clear(): void {
		this.attempts.length = 0;
	}
}

interface NodeHarness {
	readonly node: DRPNode;
	readonly sender: TimestampedSyncSender;
	setPeers(id: string, peers: readonly string[]): void;
}

let harnessIndex = 0;

async function makeHarness(seed: string): Promise<NodeHarness> {
	const peersByObject = new Map<string, readonly string[]>();
	const sender = new TimestampedSyncSender();
	const node = new DRPNode(
		{
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
			keychain_config: { private_key_seed: `${seed}-${harnessIndex++}` },
			interval_sync_options: { interval: ANTI_ENTROPY_INTERVAL_MS },
			log_config: { level: "silent" },
		},
		{ syncSender: sender }
	);
	await node.start();
	vi.spyOn(node.networkNode, "getGroupPeers").mockImplementation((id: string) => [...(peersByObject.get(id) ?? [])]);
	vi.spyOn(node.networkNode, "sendGroupMessageRandomPeer").mockResolvedValue();
	return {
		node,
		sender,
		setPeers(id, peers): void {
			peersByObject.set(id, [...peers]);
		},
	};
}

async function restartTrace(harness: NodeHarness, id: string, elapsed: number): Promise<number[]> {
	await harness.node.stop();
	harness.sender.clear();
	const restartBaseline = Date.now();
	await harness.node.start();
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(elapsed);
	return harness.sender.forObject(id).map(({ at }) => at - restartBaseline);
}

describe("unmanaged public-put anti-entropy restore", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("public put restores unmanaged periodic Sync without id-shaped fast retry and preserves explicit provenance", async () => {
		const idOwner = await makeHarness("unmanaged-restore-id-owner");
		const replica = await makeHarness("unmanaged-restore-replica");
		nodes.push(idOwner.node, replica.node);
		const unmanagedSource = await idOwner.node.createObject({ drp: new CounterDRP() });
		const controlledSource = await idOwner.node.createObject({ drp: new CounterDRP() });
		const syncPeer = "negotiated-sync-peer";
		for (const id of [unmanagedSource.id, controlledSource.id]) replica.setPeers(id, [syncPeer]);

		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));

		// A node.put replacement does not erase the truthful connected role.
		const connecting = replica.node.connectObject({
			id: controlledSource.id,
			drp: new CounterDRP(),
			acl: createPermissionlessACL(),
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await connecting;
		replica.node.put(
			controlledSource.id,
			new DRPObject({
				peerId: replica.node.networkNode.peerId,
				id: controlledSource.id,
				drp: new CounterDRP(),
				acl: createPermissionlessACL(),
			})
		);
		expect(await restartTrace(replica, controlledSource.id, INITIAL_SYNC_RETRY_INTERVAL_MS * 5)).toEqual([
			0, 1_000, 2_000, 3_000, 4_000, 5_000,
		]);

		// A fresh explicit-ACL acquisition may truthfully overwrite that role.
		await replica.node.createObject({
			id: controlledSource.id,
			drp: new CounterDRP(),
			acl: createPermissionlessACL(),
		});
		expect(await restartTrace(replica, controlledSource.id, INITIAL_SYNC_RETRY_INTERVAL_MS * 5)).toEqual([0]);

		// The creator-bound id was generated by another peer, but public put is
		// the only acquisition. Explicit ACL construction keeps this away from
		// every legacy/custom-id fallback and leaves provenance genuinely absent.
		replica.node.put(
			unmanagedSource.id,
			new DRPObject({
				peerId: replica.node.networkNode.peerId,
				id: unmanagedSource.id,
				drp: new CounterDRP(),
				acl: createPermissionlessACL(),
			})
		);
		expect(await restartTrace(replica, unmanagedSource.id, ANTI_ENTROPY_INTERVAL_MS)).toEqual([
			0,
			ANTI_ENTROPY_INTERVAL_MS,
		]);
	}, 30_000);
});

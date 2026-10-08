/**
 * Phase 1n-d(i) RED: public object acquisition records the local replica role,
 * and the tracked DRPIntervalSync is the only scheduled Sync owner. Connected
 * replicas retry at one second without leaking typed failures; created replicas
 * wait for periodic anti-entropy regardless of object-id shape.
 */
import {
	DRP_HEADS_CHUNK_PROTOCOL,
	type NegotiatedSyncSender,
	type SelectedSyncProtocol,
	SyncTransportError,
} from "@ts-drp/network";
import { createPermissionlessACL, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	DRPStateOtherTheWire,
	FetchStateResponse,
	type IDRP,
	type Message,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage, signGeneratedVertices } from "../src/handlers.js";
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
	readonly message: Message;
	readonly peerId: string;
}

class ScriptedSyncSender implements NegotiatedSyncSender {
	readonly attempts: SyncAttempt[] = [];
	failuresRemaining = 0;
	rejectEverySend = false;

	async sendSyncMessage(
		peerId: string,
		payloadFactory: (selection: SelectedSyncProtocol) => Message | Promise<Message>
	): Promise<void> {
		const message = await payloadFactory(HEADS_SELECTION);
		this.attempts.push({ message, peerId });
		if (this.rejectEverySend || this.failuresRemaining > 0) {
			this.failuresRemaining = Math.max(0, this.failuresRemaining - 1);
			throw new SyncTransportError("SYNC_DIAL_FAILED", `controlled failure for ${peerId}`);
		}
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
	readonly sender: ScriptedSyncSender;
	setPeers(id: string, peers: readonly string[]): void;
}

let harnessIndex = 0;

async function makeHarness(seed: string): Promise<NodeHarness> {
	const peersByObject = new Map<string, readonly string[]>();
	const sender = new ScriptedSyncSender();
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

async function acknowledgeRootFetch(node: DRPNode, objectId: string, sender: string): Promise<void> {
	await handleMessage(node, {
		sender,
		type: MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE,
		objectId,
		data: FetchStateResponse.encode(
			FetchStateResponse.create({
				vertexHash: HashGraph.rootHash,
				drpState: DRPStateOtherTheWire.create(),
			})
		).finish(),
	} as Message);
}

async function connectAfterFetch(
	node: DRPNode,
	options: Parameters<DRPNode["connectObject"]>[0],
	responder: string
): ReturnType<DRPNode["connectObject"]> {
	const connecting = node.connectObject(options);
	await acknowledgeRootFetch(node, options.id, responder);
	return connecting;
}

describe("single scheduled Sync owner and acquisition provenance", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("connectObject has one contained scheduled owner with exact sorted five-attempt rotation", async () => {
		const creator = await makeHarness("retry-owner-creator");
		const joiner = await makeHarness("retry-owner-joiner");
		nodes.push(creator.node, joiner.node);
		const creatorObject = await creator.node.createObject({ drp: new CounterDRP() });
		const peers = ["peer-c", "peer-a", "peer-b"];
		joiner.setPeers(creatorObject.id, peers);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.useFakeTimers();

		const unhandled: unknown[] = [];
		const recordUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", recordUnhandled);
		try {
			joiner.sender.failuresRemaining = 3;
			await connectAfterFetch(
				joiner.node,
				{ id: creatorObject.id, drp: new CounterDRP() },
				creator.node.networkNode.peerId
			);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 10);
			await new Promise(process.nextTick);

			const scheduled = joiner.sender.forObject(creatorObject.id);
			expect.soft(unhandled, "scheduled typed errors stay owned by the tracked runner").toEqual([]);
			expect.soft(scheduled, "one immediate probe plus exactly five fast retries").toHaveLength(6);
			expect
				.soft(
					scheduled.map(({ peerId }) => peerId),
					"one sorted rotation owner advances exactly once per tick"
				)
				.toEqual(["peer-a", "peer-b", "peer-c", "peer-a", "peer-b", "peer-c"]);

			const afterBudget = scheduled.length;
			await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 5);
			expect.soft(joiner.sender.forObject(creatorObject.id)).toHaveLength(afterBudget);

			joiner.sender.rejectEverySend = true;
			await expect(joiner.node.syncObject(creatorObject.id, "direct-peer")).rejects.toMatchObject({
				code: "SYNC_DIAL_FAILED",
				name: "SyncTransportError",
			});
		} finally {
			process.off("unhandledRejection", recordUnhandled);
		}
	}, 20_000);

	test("remote history stops fast retry while stop and unsubscribe cancel later attempts", async () => {
		const creator = await makeHarness("retry-cancellation-creator");
		const historyReplica = await makeHarness("retry-cancellation-history");
		const stoppedReplica = await makeHarness("retry-cancellation-stop");
		const unsubscribedReplica = await makeHarness("retry-cancellation-unsubscribe");
		nodes.push(creator.node, historyReplica.node, stoppedReplica.node, unsubscribedReplica.node);

		const creatorObject = await creator.node.createObject({ drp: new CounterDRP() });
		creatorObject.acl.setKey(creator.node.keychain.blsPublicKey);
		creatorObject.drp?.increment();
		await signGeneratedVertices(creator.node, creatorObject.vertices);
		const stoppedId = "explicit-stop-connected-room";
		const unsubscribedId = "explicit-unsubscribe-connected-room";
		const peer = "remote-sync-peer";
		historyReplica.setPeers(creatorObject.id, [peer]);
		stoppedReplica.setPeers(stoppedId, [peer]);
		unsubscribedReplica.setPeers(unsubscribedId, [peer]);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.useFakeTimers();

		const historyObject = await connectAfterFetch(
			historyReplica.node,
			{ id: creatorObject.id, drp: new CounterDRP() },
			creator.node.networkNode.peerId
		);
		await connectAfterFetch(
			stoppedReplica.node,
			{ id: stoppedId, drp: new CounterDRP(), acl: createPermissionlessACL() },
			peer
		);
		await connectAfterFetch(
			unsubscribedReplica.node,
			{ id: unsubscribedId, drp: new CounterDRP(), acl: createPermissionlessACL() },
			peer
		);
		await vi.advanceTimersByTimeAsync(0);
		historyReplica.sender.clear();
		stoppedReplica.sender.clear();
		unsubscribedReplica.sender.clear();

		await expect(historyObject.merge(creatorObject.vertices)).resolves.toEqual([true, [], []]);
		await stoppedReplica.node.stop();
		nodes.splice(nodes.indexOf(stoppedReplica.node), 1);
		unsubscribedReplica.node.unsubscribeObject(unsubscribedId);

		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 3);

		expect.soft(historyReplica.sender.forObject(creatorObject.id), "remote history alone ends fast retry").toEqual([]);
		expect.soft(stoppedReplica.sender.forObject(stoppedId), "stop cancels every scheduled owner").toEqual([]);
		expect
			.soft(unsubscribedReplica.sender.forObject(unsubscribedId), "unsubscribe cancels every scheduled owner")
			.toEqual([]);
	}, 20_000);

	test("public create and connect roles survive restart and purge without id-shape inference", async () => {
		const creator = await makeHarness("retry-provenance-creator");
		const replica = await makeHarness("retry-provenance-replica");
		nodes.push(creator.node, replica.node);
		const remoteObject = await creator.node.createObject({ drp: new CounterDRP() });
		const separatorCreatedId = "explicit-authority:created-room";
		const plainConnectedId = "explicit-plain-connected-room";
		const peer = "provenance-peer";

		await expect(replica.node.createObject({ id: "plain-created-without-acl", drp: new CounterDRP() })).rejects.toThrow(
			"A custom object id must be creator-bound when acl is omitted"
		);
		await expect(
			replica.node.connectObject({ id: "plain-connected-without-acl", drp: new CounterDRP() })
		).rejects.toThrow("A creator-bound object id must be provided when acl is omitted");

		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.useFakeTimers();
		const generatedCreated = await replica.node.createObject({ drp: new CounterDRP() });
		await replica.node.createObject({
			id: separatorCreatedId,
			drp: new CounterDRP(),
			acl: createPermissionlessACL(),
		});
		for (const id of [generatedCreated.id, separatorCreatedId, remoteObject.id, plainConnectedId]) {
			replica.setPeers(id, [peer]);
		}
		await connectAfterFetch(
			replica.node,
			{ id: remoteObject.id, drp: new CounterDRP() },
			creator.node.networkNode.peerId
		);
		await connectAfterFetch(
			replica.node,
			{ id: plainConnectedId, drp: new CounterDRP(), acl: createPermissionlessACL() },
			peer
		);
		await vi.advanceTimersByTimeAsync(0);
		replica.sender.clear();
		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 5);

		const expectAuthoritativeRoles = (label: string): void => {
			expect
				.soft(replica.sender.forObject(generatedCreated.id), `${label}: generated create is created`)
				.toHaveLength(0);
			expect
				.soft(replica.sender.forObject(separatorCreatedId), `${label}: separator custom create is created`)
				.toHaveLength(0);
			expect
				.soft(replica.sender.forObject(remoteObject.id), `${label}: generated connect is connected`)
				.toHaveLength(5);
			expect
				.soft(replica.sender.forObject(plainConnectedId), `${label}: plain explicit-ACL connect is connected`)
				.toHaveLength(5);
		};
		expectAuthoritativeRoles("initial acquisition");

		await replica.node.stop();
		replica.sender.clear();
		await replica.node.start();
		await vi.advanceTimersByTimeAsync(0);
		replica.sender.clear();
		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 5);
		expectAuthoritativeRoles("same-instance restart");

		replica.node.unsubscribeObject(plainConnectedId, true);
		replica.node.unsubscribeObject(separatorCreatedId, true);
		replica.sender.clear();
		await replica.node.createObject({
			id: plainConnectedId,
			drp: new CounterDRP(),
			acl: createPermissionlessACL(),
		});
		await connectAfterFetch(
			replica.node,
			{ id: separatorCreatedId, drp: new CounterDRP(), acl: createPermissionlessACL() },
			peer
		);
		await vi.advanceTimersByTimeAsync(0);
		replica.sender.clear();
		await vi.advanceTimersByTimeAsync(INITIAL_SYNC_RETRY_INTERVAL_MS * 5);

		expect
			.soft(replica.sender.forObject(plainConnectedId), "purged connected role does not taint recreate")
			.toHaveLength(0);
		expect
			.soft(replica.sender.forObject(separatorCreatedId), "purged created role does not taint reconnect")
			.toHaveLength(5);
	}, 30_000);
});

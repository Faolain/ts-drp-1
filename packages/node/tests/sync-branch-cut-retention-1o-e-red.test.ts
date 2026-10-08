/**
 * Phase 1o-e RED: verified historical branch cuts have a bounded, deterministic
 * retained lifetime per `(node, object, peer)`. The public `sharedHashes` seam
 * exposes FIFO order by leaving one historical slot after the replaceable
 * current frontier consumes the rest of the wire budget.
 */
import {
	DRP_HEADS_CHUNK_PROTOCOL,
	type NegotiatedSyncSender,
	type SelectedSyncProtocol,
	SYNC_HEADS_FIELD_HASH_CAP,
} from "@ts-drp/network";
import { createACL, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	SyncReject,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage, signGeneratedVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";
import { recordBranchCuts, recordSharedHeads, sharedHashes } from "../src/sync-state.js";

const RETAINED_BRANCH_CUT_CAP = 32;

interface Outbound {
	message: Message;
	to: string;
}

const HEADS_SELECTION = Object.freeze({
	mode: "heads-chunk",
	protocol: DRP_HEADS_CHUNK_PROTOCOL,
} satisfies SelectedSyncProtocol);

const outboundByNode = new WeakMap<DRPNode, Outbound[]>();

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

function syncSender(node: () => DRPNode): NegotiatedSyncSender {
	return {
		async sendSyncMessage(to, payloadFactory): Promise<void> {
			const outbound = outboundByNode.get(node());
			if (outbound === undefined) throw new Error("Expected outbound capture");
			outbound.push({ message: await payloadFactory(HEADS_SELECTION), to });
		},
		sendSyncResponseMessage(to, message): Promise<void> {
			const outbound = outboundByNode.get(node());
			if (outbound === undefined) throw new Error("Expected outbound capture");
			outbound.push({ message, to });
			return Promise.resolve();
		},
	};
}

function makeUnstartedNode(seed: string): DRPNode {
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

async function makeRuntimeNode(seed: string): Promise<DRPNode> {
	const runtime: { node?: DRPNode } = {};
	const node = new DRPNode(
		{
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
		},
		{
			syncSender: syncSender(() => {
				if (runtime.node === undefined) throw new Error("Expected initialized runtime node");
				return runtime.node;
			}),
		}
	);
	runtime.node = node;
	await node.start();
	return node;
}

function captureOutbound(node: DRPNode, outbound: Outbound[]): void {
	outboundByNode.set(node, outbound);
	vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
}

function coordinatedACL(nodes: readonly DRPNode[]): ReturnType<typeof createACL> {
	const acl = createACL({ admins: nodes.map(({ networkNode }) => networkNode.peerId) });
	for (const node of nodes) {
		acl.context = { caller: node.networkNode.peerId };
		acl.setKey(node.keychain.blsPublicKey);
	}
	acl.context = { caller: "" };
	return acl;
}

async function makeFullReplicas(nodes: readonly DRPNode[]): Promise<IDRPObject<CounterDRP>[]> {
	const creatorNode = nodes[0];
	if (creatorNode === undefined) throw new Error("Expected a replica creator");
	const creator = await creatorNode.createObject({ acl: coordinatedACL(nodes), drp: new CounterDRP() });
	const replicas = [creator];
	for (const node of nodes.slice(1)) {
		replicas.push(
			await node.createObject({
				acl: coordinatedACL(nodes),
				drp: new CounterDRP(),
				id: creator.id,
			})
		);
	}
	return replicas;
}

function nonRoot(vertices: readonly Vertex[]): Vertex[] {
	return vertices.filter(({ hash }) => hash !== HashGraph.rootHash);
}

async function deliverAll(outbound: Outbound[], nodes: readonly DRPNode[], limit = 64): Promise<void> {
	const byPeer = new Map(nodes.map((node) => [node.networkNode.peerId, node]));
	let delivered = 0;
	while (outbound.length !== 0) {
		if (delivered++ >= limit) throw new Error(`Message delivery exceeded ${limit} steps`);
		const entry = outbound.shift();
		if (entry === undefined) break;
		const recipient = byPeer.get(entry.to);
		if (recipient === undefined) throw new Error(`Unknown recipient ${entry.to}`);
		await handleMessage(recipient, Message.decode(Message.encode(entry.message).finish()), HEADS_SELECTION);
	}
}

function expectSameHeads(left: IDRPObject<CounterDRP>, right: IDRPObject<CounterDRP>): void {
	expect(new Set(left.getHistoryHeads())).toEqual(new Set(right.getHistoryHeads()));
}

function exposeOldestRetainedCut(node: DRPNode, objectId: string, peerId: string): string | undefined {
	const currentSharedHeads = Array.from(
		{ length: SYNC_HEADS_FIELD_HASH_CAP - 1 },
		(_, index) => `phase-1o-e-current-shared-head-${index}`
	);
	recordSharedHeads(node, objectId, peerId, currentSharedHeads);
	const projected = sharedHashes(node, objectId, peerId);
	expect(projected.slice(0, currentSharedHeads.length)).toEqual(currentSharedHeads);
	expect(projected).toHaveLength(SYNC_HEADS_FIELD_HASH_CAP);
	return projected.at(-1);
}

describe("Phase 1o-e bounded branch-cut retention", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("retains exactly 32 distinct cuts in oldest-distinct FIFO order per node/object/peer", () => {
		const owner = makeUnstartedNode("phase-1o-e-fifo-retention-owner");
		nodes.push(owner);
		const objectId = "phase-1o-e-object-primary";
		const peerId = "phase-1o-e-peer-primary";
		const cuts = Array.from({ length: RETAINED_BRANCH_CUT_CAP + 2 }, (_, index) => `phase-1o-e-cut-${index}`);
		const [cut0, cut1, , cut3] = cuts;
		const cut32 = cuts[RETAINED_BRANCH_CUT_CAP];
		const cut33 = cuts[RETAINED_BRANCH_CUT_CAP + 1];
		if (cut0 === undefined || cut1 === undefined || cut3 === undefined || cut32 === undefined || cut33 === undefined) {
			throw new Error("Expected complete branch-cut fixtures");
		}

		recordBranchCuts(owner, objectId, peerId, cuts.slice(0, RETAINED_BRANCH_CUT_CAP));
		recordBranchCuts(owner, objectId, peerId, [cut0]);
		recordBranchCuts(owner, objectId, peerId, [cut32]);

		expect
			.soft(
				exposeOldestRetainedCut(owner, objectId, peerId),
				"the 33rd distinct admission evicts cut 0; reconfirming cut 0 must not refresh it"
			)
			.toBe(cut1);

		recordBranchCuts(owner, objectId, peerId, [cut0]);
		recordBranchCuts(owner, objectId, peerId, [cut33]);
		expect
			.soft(
				exposeOldestRetainedCut(owner, objectId, peerId),
				"re-adding the evicted cut evicts cut 1, then the next distinct cut evicts cut 2"
			)
			.toBe(cut3);

		const isolatedPeer = "phase-1o-e-peer-isolated";
		const isolatedObject = "phase-1o-e-object-isolated";
		recordBranchCuts(owner, objectId, isolatedPeer, [cut0]);
		recordBranchCuts(owner, isolatedObject, peerId, [cut1]);
		expect(exposeOldestRetainedCut(owner, objectId, isolatedPeer)).toBe(cut0);
		expect(exposeOldestRetainedCut(owner, isolatedObject, peerId)).toBe(cut1);
	});

	test("recovers an old full-history branch after more than 32 shared cuts evict its fork point", async () => {
		const left = await makeRuntimeNode("phase-1o-e-full-left");
		const right = await makeRuntimeNode("phase-1o-e-full-right");
		const oldBranch = await makeRuntimeNode("phase-1o-e-full-old-branch-author");
		nodes.push(left, right, oldBranch);
		const outbound: Outbound[] = [];
		for (const node of nodes) captureOutbound(node, outbound);
		const replicas = await makeFullReplicas(nodes);
		const [leftObject, rightObject, oldBranchObject] = replicas;
		if (leftObject === undefined || rightObject === undefined || oldBranchObject === undefined) {
			throw new Error("Expected three full-history replicas");
		}

		for (let index = 0; index < RETAINED_BRANCH_CUT_CAP + 2; index++) leftObject.drp?.increment();
		await signGeneratedVertices(left, leftObject.vertices);
		const common = nonRoot(leftObject.vertices);
		await expect(rightObject.merge(common)).resolves.toEqual([true, [], []]);
		await expect(oldBranchObject.merge(common.slice(0, 1))).resolves.toEqual([true, [], []]);

		recordBranchCuts(
			left,
			leftObject.id,
			right.networkNode.peerId,
			common.map(({ hash }) => hash)
		);
		expect
			.soft(sharedHashes(left, leftObject.id, right.networkNode.peerId), "only the newest 32 full-history cuts remain")
			.toEqual(common.slice(-RETAINED_BRANCH_CUT_CAP).map(({ hash }) => hash));
		expectSameHeads(leftObject, rightObject);

		oldBranchObject.drp?.increment();
		await signGeneratedVertices(oldBranch, oldBranchObject.vertices);
		const injected = oldBranchObject.vertices.at(-1);
		if (injected === undefined) throw new Error("Expected an old-branch vertex");
		await expect(rightObject.merge([injected])).resolves.toEqual([true, [], []]);
		expect(leftObject.getVertex(injected.hash)).toBeUndefined();

		await left.syncObject(leftObject.id, right.networkNode.peerId);
		await deliverAll(outbound, nodes);

		expect(leftObject.getVertex(injected.hash)).toBeDefined();
		expectSameHeads(leftObject, rightObject);
	}, 20_000);

	test("recovers from a full peer after an over-cap compact peer reports the old branch unavailable", async () => {
		vi.stubEnv("TS_DRP_CHECKPOINT_SUFFIX_SIZE", "2");
		const writer = await makeRuntimeNode("phase-1o-e-compact-writer");
		const observer = await makeRuntimeNode("phase-1o-e-compact-observer");
		const oldBranch = await makeRuntimeNode("phase-1o-e-compact-old-branch-author");
		nodes.push(writer, observer, oldBranch);
		const outbound: Outbound[] = [];
		for (const node of nodes) captureOutbound(node, outbound);

		const aclOwners = [writer, oldBranch];
		const writerObject = await writer.createObject({ acl: coordinatedACL(aclOwners), drp: new CounterDRP() });
		const observerObject = await observer.createObject({
			acl: coordinatedACL(aclOwners),
			drp: new CounterDRP(),
			history_storage: "compact",
			id: writerObject.id,
			replica_mode: "observer",
		});
		const oldBranchObject = await oldBranch.createObject({
			acl: coordinatedACL(aclOwners),
			drp: new CounterDRP(),
			id: writerObject.id,
		});

		writerObject.drp?.increment();
		await signGeneratedVertices(writer, writerObject.vertices);
		const evictedFork = nonRoot(writerObject.vertices)[0];
		if (evictedFork === undefined) throw new Error("Expected a compact old-branch fork point");
		await expect(oldBranchObject.merge([evictedFork])).resolves.toEqual([true, [], []]);

		oldBranchObject.drp?.increment();
		oldBranchObject.drp?.increment();
		oldBranchObject.drp?.increment();
		await signGeneratedVertices(oldBranch, oldBranchObject.vertices);
		const oldBranchVertices = nonRoot(oldBranchObject.vertices).slice(1);
		const injected = oldBranchVertices[0];
		const injectedTip = oldBranchVertices.at(-1);
		if (injected === undefined || injectedTip === undefined) throw new Error("Expected compact old-branch vertices");

		for (let index = 1; index < RETAINED_BRANCH_CUT_CAP + 2; index++) writerObject.drp?.increment();
		await signGeneratedVertices(writer, writerObject.vertices);
		const common = nonRoot(writerObject.vertices);
		// The 1i-b fixture admits the complete authenticated graph in one batch,
		// then compacts it. Both old branches are therefore known even though their
		// payloads are unavailable by the time this sync recovery begins.
		await expect(observerObject.applyVertices([...common, ...oldBranchVertices])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(oldBranchObject.merge(common.slice(1))).resolves.toEqual([true, [], []]);
		expect(observerObject.getVertexPayload(evictedFork.hash)).toEqual({
			missingHashes: [evictedFork.hash],
			status: "history-unavailable",
		});
		expect(observerObject.getVertexPayload(injected.hash)).toEqual({
			missingHashes: [injected.hash],
			status: "history-unavailable",
		});
		expect(observerObject.getVertexPayload(injectedTip.hash).status).toBe("available");

		recordBranchCuts(
			writer,
			writerObject.id,
			observer.networkNode.peerId,
			common.map(({ hash }) => hash)
		);
		expect
			.soft(
				sharedHashes(writer, writerObject.id, observer.networkNode.peerId),
				"only the newest 32 compact-history cuts remain"
			)
			.toEqual(common.slice(-RETAINED_BRANCH_CUT_CAP).map(({ hash }) => hash));

		await writer.syncObject(writerObject.id, observer.networkNode.peerId);
		const compactProbe = outbound.shift();
		if (compactProbe === undefined) throw new Error("Expected a compact-history probe");
		await handleMessage(observer, Message.decode(Message.encode(compactProbe.message).finish()), HEADS_SELECTION);
		const unavailable = outbound.shift();
		if (unavailable === undefined) throw new Error("Expected a compact-history unavailable response");
		expect(unavailable.message.type).toBe(MessageType.MESSAGE_TYPE_SYNC_REJECT);
		const rejection = SyncReject.decode(unavailable.message.data);
		expect(rejection.reason).toBe("history-unavailable");
		expect(rejection.missingHashes.length).toBeGreaterThan(0);
		expect(
			rejection.missingHashes.every((hash) => observerObject.getVertexPayload(hash).status === "history-unavailable")
		).toBe(true);
		await handleMessage(writer, Message.decode(Message.encode(unavailable.message).finish()), HEADS_SELECTION);
		expect(writerObject.getVertex(injected.hash)).toBeUndefined();

		for (let attempt = 0; attempt < 4 && writerObject.getVertex(injectedTip.hash) === undefined; attempt++) {
			await writer.syncObject(writerObject.id, oldBranch.networkNode.peerId);
			await deliverAll(outbound, nodes);
		}

		expect(writerObject.getVertex(injected.hash)).toBeDefined();
		expect(writerObject.getVertex(injectedTip.hash)).toBeDefined();
		expectSameHeads(writerObject, oldBranchObject);
		expect(observerObject.historyStorage).toBe("compact");
		expect(observerObject.getVertexPayload(evictedFork.hash).status).toBe("history-unavailable");
	}, 20_000);
});

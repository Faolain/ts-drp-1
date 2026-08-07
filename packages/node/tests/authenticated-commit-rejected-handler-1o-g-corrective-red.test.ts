/**
 * Phase 1o-g corrective RED: the rejected UPDATE owner must consume the same
 * object-owned authenticated-commit registry that produced the boundary error.
 */
import { AdoptionCommitExhaustedError, createPermissionlessACL, createVertex, HashGraph } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	Message,
	MessageType,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";
import * as syncState from "../src/sync-state.js";

interface FairnessInternals {
	installSyncStateCapacity(
		node: DRPNode,
		capacity: { readonly perNode: number; readonly perObject: number },
		policy?: { readonly maxNoProgressStrikes: number }
	): void;
}

interface PrivateApplier {
	tryCommitPreparedVertex(...arguments_: unknown[]): "committed" | "duplicate" | "retry";
}

const { prepareSyncSend, previewSyncSend, queueExactRequests, recordSharedHeads, sharedHashes } = syncState;

class AppendLogDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: string[] = [];

	append(value: string): void {
		this.values.push(value);
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
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

function installOneStrikeCapacity(node: DRPNode): void {
	(syncState as unknown as FairnessInternals).installSyncStateCapacity(
		node,
		{ perNode: 1, perObject: 1 },
		{ maxNoProgressStrikes: 1 }
	);
}

function hash(index: number): string {
	return index.toString(16).padStart(64, "0");
}

function peer(index: number): string {
	return `12D3KooW${index.toString(36).padStart(45, "c")}`;
}

function chargeStrike(node: DRPNode, objectId: string, peerId: string): void {
	for (let attempt = 0; attempt < 3; attempt++) {
		expect(prepareSyncSend(node, objectId, peerId, "scheduled-probe").send).toBe(true);
	}
	expect(prepareSyncSend(node, objectId, peerId, "scheduled-probe").send).toBe(false);
}

function retained(node: DRPNode, objectId: string, peerId: string): readonly string[] {
	return previewSyncSend(node, objectId, peerId, "scheduled-probe").requestedHashes;
}

async function signedVertex(
	sender: DRPNode,
	value: string,
	timestamp: number,
	dependencies: readonly string[] = [HashGraph.rootHash]
): Promise<Vertex> {
	const vertex = createVertex(
		sender.networkNode.peerId,
		Operation.create({ opType: "append", value: [value] }),
		[...dependencies],
		timestamp
	);
	vertex.signature = await sender.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

function updateMessage(objectId: string, sender: string, vertices: readonly Vertex[]): Message {
	return Message.create({
		data: Update.encode(Update.create({ vertices: [...vertices] })).finish(),
		objectId,
		sender,
		type: MessageType.MESSAGE_TYPE_UPDATE,
	});
}

async function rejectedUpdate(
	receiver: DRPNode,
	object: Awaited<ReturnType<DRPNode["createObject"]>>,
	sender: DRPNode,
	vertices: readonly Vertex[],
	mode: "after-first-commit" | "always"
): Promise<unknown> {
	const applier = (object as unknown as { _applier: PrivateApplier })._applier;
	const original = applier.tryCommitPreparedVertex;
	let committed = false;
	applier.tryCommitPreparedVertex = function (...arguments_: unknown[]): "committed" | "duplicate" | "retry" {
		if (mode === "always" || committed) return "retry";
		const outcome = original.apply(this, arguments_);
		if (outcome === "committed") committed = true;
		return outcome;
	};
	try {
		await handleMessage(receiver, updateMessage(object.id, sender.networkNode.peerId, vertices));
		return undefined;
	} catch (error) {
		return error;
	} finally {
		applier.tryCommitPreparedVertex = original;
	}
}

describe("Phase 1o-g rejected-boundary handler commit credit", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("resets only for the exact rejected call's earlier physical commit, never authentication or post-state", async () => {
		const senderA = makeNode("phase-1o-g-corrective-handler-a");
		const senderB = makeNode("phase-1o-g-corrective-handler-b");
		const productiveReceiver = makeNode("phase-1o-g-corrective-handler-productive");
		const unproductiveReceiver = makeNode("phase-1o-g-corrective-handler-unproductive");
		nodes.push(senderA, senderB, productiveReceiver, unproductiveReceiver);
		await Promise.all(nodes.map((node) => node.start()));
		for (const node of nodes) vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();

		installOneStrikeCapacity(productiveReceiver);
		const productiveObject = await productiveReceiver.createObject({
			acl: createPermissionlessACL(),
			drp: new AppendLogDRP(),
			finality_config: { enabled: false },
		});
		expect(productiveObject.id).toMatch(new RegExp(`^${productiveReceiver.networkNode.peerId}:`));
		const now = Date.now();
		const committed = await signedVertex(senderA, "same-call-commit", now);
		const poison = await signedVertex(senderA, "same-call-poison", now + 1, [committed.hash]);
		const survivor = hash(901);
		queueExactRequests(productiveReceiver, productiveObject.id, senderA.networkNode.peerId, [
			committed.hash,
			poison.hash,
			survivor,
		]);
		chargeStrike(productiveReceiver, productiveObject.id, senderA.networkNode.peerId);

		const productiveError = await rejectedUpdate(
			productiveReceiver,
			productiveObject,
			senderA,
			[committed, poison],
			"after-first-commit"
		);
		expect(productiveError).toBeInstanceOf(AdoptionCommitExhaustedError);
		expect(
			productiveObject.getVertex(committed.hash),
			"the rejected call physically committed its earlier H"
		).toBeDefined();
		expect(retained(productiveReceiver, productiveObject.id, senderA.networkNode.peerId)).toEqual([survivor]);
		recordSharedHeads(productiveReceiver, productiveObject.id, peer(902), [hash(902)]);
		expect(
			sharedHashes(productiveReceiver, productiveObject.id, peer(902)),
			"the real handler and object boundary share one registry, so the commit clears the prior strike"
		).toEqual([]);
		expect(retained(productiveReceiver, productiveObject.id, senderA.networkNode.peerId)).toEqual([survivor]);

		installOneStrikeCapacity(unproductiveReceiver);
		const unproductiveObject = await unproductiveReceiver.createObject({
			acl: createPermissionlessACL(),
			drp: new AppendLogDRP(),
			finality_config: { enabled: false },
		});
		const preexisting = await signedVertex(senderB, "third-party-preexisting", now + 10);
		await expect(unproductiveObject.applyVertices([preexisting])).resolves.toMatchObject({
			applied: true,
			invalid: [],
			missing: [],
		});
		const uncommittedPoison = await signedVertex(senderA, "authenticated-only-poison", now + 11, [preexisting.hash]);
		const negativeSurvivor = hash(911);
		queueExactRequests(unproductiveReceiver, unproductiveObject.id, senderA.networkNode.peerId, [
			preexisting.hash,
			uncommittedPoison.hash,
			negativeSurvivor,
		]);
		chargeStrike(unproductiveReceiver, unproductiveObject.id, senderA.networkNode.peerId);

		const unproductiveError = await rejectedUpdate(
			unproductiveReceiver,
			unproductiveObject,
			senderA,
			[preexisting, uncommittedPoison],
			"always"
		);
		expect(unproductiveError).toBeInstanceOf(AdoptionCommitExhaustedError);
		expect(
			unproductiveObject.getVertex(preexisting.hash),
			"negative control: the peer authenticated and offered a hash already present due to B"
		).toBeDefined();
		expect(retained(unproductiveReceiver, unproductiveObject.id, senderA.networkNode.peerId)).toEqual([
			negativeSurvivor,
		]);
		recordSharedHeads(unproductiveReceiver, unproductiveObject.id, peer(912), [hash(912)]);
		expect(
			sharedHashes(unproductiveReceiver, unproductiveObject.id, peer(912)),
			"authentication and third-party post-state cannot counterfeit rejected-call credit"
		).toEqual([hash(912)]);
		expect(retained(unproductiveReceiver, unproductiveObject.id, senderA.networkNode.peerId)).toEqual([]);
	});
});

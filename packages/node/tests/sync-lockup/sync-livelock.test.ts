/**
 * Handler-level clock-skew regressions. Outbound messages are captured and
 * delivered directly so convergence and sync requests are deterministic.
 */
import { createACL } from "@ts-drp/object";
import {
	ActionType,
	type IDRP,
	type MergeResult,
	Message,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { handleMessage } from "../../src/handlers.js";
import { DRPNode } from "../../src/index.js";

/** Tiny 2D position map DRP, like the grid/canvas examples (one box per user). */
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

interface Outbox {
	direct: { to: string; msg: Message }[];
	broadcast: { topic: string; msg: Message }[];
}

function captureOutbound(node: DRPNode): Outbox {
	const out: Outbox = { direct: [], broadcast: [] };
	vi.spyOn(node.networkNode, "sendMessage").mockImplementation((peerId: string, message: Message) => {
		out.direct.push({ to: peerId, msg: message });
		return Promise.resolve();
	});
	vi.spyOn(node.networkNode, "broadcastMessage").mockImplementation((topic: string, message: Message) => {
		out.broadcast.push({ topic, msg: message });
		return Promise.resolve();
	});
	return out;
}

const updatesOf = (out: Outbox): Message[] =>
	out.broadcast.filter((m) => m.msg.type === MessageType.MESSAGE_TYPE_UPDATE).map((m) => m.msg);
const directsOf = (out: Outbox, type: MessageType): Message[] =>
	out.direct.filter((m) => m.msg.type === type).map((m) => m.msg);

function combineUpdates(messages: Message[]): Message {
	const updates = messages.map((message) => Update.decode(message.data));
	return Message.create({
		sender: messages[0].sender,
		type: MessageType.MESSAGE_TYPE_UPDATE,
		objectId: messages[0].objectId,
		data: Update.encode(
			Update.create({
				vertices: updates.flatMap((update) => update.vertices),
				attestations: updates.flatMap((update) => update.attestations),
			})
		).finish(),
	});
}

async function makeNode(seed: string): Promise<DRPNode> {
	const node = new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		log_config: { level: "silent" },
	});
	await node.start();
	return node;
}

describe("sync livelock (deterministic, handler-driven)", () => {
	// Per-"machine" clock emulation: Date.now() returns real time + skewMs.
	// We only enable the skew synchronously around the skewed node's local
	// operations (the callFn pipeline is synchronous for a sync DRP), which
	// emulates that node's wall clock being ahead of the other machines.
	const realNow = Date.now.bind(Date);
	let skewMs = 0;
	const WITHIN_TOLERANCE_SKEW = 5_000;
	const BEYOND_TOLERANCE_SKEW = 120_000;

	let nodeA: DRPNode; // healthy receiver
	let nodeB: DRPNode; // clock-ahead sender

	beforeAll(async () => {
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
		nodeA = await makeNode("sync-livelock-A");
		nodeB = await makeNode("sync-livelock-B");
	}, 30_000);

	afterAll(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled([nodeA?.stop(), nodeB?.stop()]);
	});

	// Runs fn with node B's skewed clock.
	function onSkewedClock<T>(fn: () => T, skew = WITHIN_TOLERANCE_SKEW): T {
		skewMs = skew;
		try {
			return fn();
		} finally {
			skewMs = 0;
		}
	}

	test("control: a dropped UPDATE heals through SYNC/SYNC_ACCEPT when timestamps are sane", async () => {
		const OBJ = "control-object";
		const outA = captureOutbound(nodeA);
		const outB = captureOutbound(nodeB);
		const objA = await nodeA.createObject({ id: OBJ, drp: new PosMapDRP() });
		const objB = await nodeB.createObject({ id: OBJ, drp: new PosMapDRP() });

		// B moves twice; the first UPDATE is dropped by the network (simulated),
		// the second is delivered out of order.
		objB.drp?.move("B", 1, 1);
		await vi.waitFor(() => expect(updatesOf(outB).length).toBe(1));
		objB.drp?.move("B", 2, 2);
		await vi.waitFor(() => expect(updatesOf(outB).length).toBe(2));

		const [_dropped, u2] = updatesOf(outB);
		await handleMessage(nodeA, u2); // missing dependency -> merge fails -> A sends SYNC to B

		const syncs = directsOf(outA, MessageType.MESSAGE_TYPE_SYNC);
		expect(syncs.length).toBe(1);

		await handleMessage(nodeB, syncs[0]); // B answers with SYNC_ACCEPT
		const accepts = directsOf(outB, MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
		expect(accepts.length).toBe(1);

		await handleMessage(nodeA, accepts[0]); // A merges the missing vertices

		// healed: A converged to B's state
		expect(objA.drp?.query_pos("B")).toEqual({ x: 2, y: 2 });
		expect(new Set(objA.vertices.map((v) => v.hash))).toEqual(new Set(objB.vertices.map((v) => v.hash)));
	}, 20_000);

	test("updates from a peer within the clock tolerance converge without SYNC", async () => {
		const OBJ = "skew-object";
		const outA = captureOutbound(nodeA);
		const outB = captureOutbound(nodeB);
		const objA = await nodeA.createObject({ id: OBJ, drp: new PosMapDRP() });
		const objB = await nodeB.createObject({ id: OBJ, drp: new PosMapDRP() });

		const ROUNDS = 5;
		for (let round = 1; round <= ROUNDS; round++) {
			// B's machine clock is ahead, but remains within the accepted tolerance.
			onSkewedClock(() => objB.drp?.move("B", round, round));
			await vi.waitFor(() => expect(updatesOf(outB).length).toBe(round));

			const update = updatesOf(outB)[round - 1];
			await handleMessage(nodeA, update);
			expect(directsOf(outA, MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);
			expect(objA.drp?.query_pos("B")).toEqual({ x: round, y: round });
		}

		objA.drp?.move("A", 9, 9);
		await vi.waitFor(() => expect(updatesOf(outA).length).toBeGreaterThanOrEqual(1));
		await handleMessage(nodeB, updatesOf(outA)[0]);
		expect(objB.drp?.query_pos("A")).toEqual({ x: 9, y: 9 });
		expect(new Set(objA.vertices.map((v) => v.hash))).toEqual(new Set(objB.vertices.map((v) => v.hash)));
	}, 30_000);

	test("a backward clock step within tolerance does not lock local operations", async () => {
		const OBJ = "backward-clock-object";
		captureOutbound(nodeB);
		const objB = await nodeB.createObject({ id: OBJ, drp: new PosMapDRP() });

		onSkewedClock(() => objB.drp?.move("B", 1, 1));
		expect(() => objB.drp?.move("B", 2, 2)).not.toThrow();
		expect(objB.drp?.query_pos("B")).toEqual({ x: 2, y: 2 });
	}, 20_000);

	test("an invalid beyond-tolerance update does not trigger a repeating SYNC storm", async () => {
		const OBJ = "invalid-skew-object";
		const outA = captureOutbound(nodeA);
		const outB = captureOutbound(nodeB);
		const objA = await nodeA.createObject({ id: OBJ, drp: new PosMapDRP() });
		const objB = await nodeB.createObject({ id: OBJ, drp: new PosMapDRP() });

		onSkewedClock(() => objB.drp?.move("B", 1, 1), BEYOND_TOLERANCE_SKEW);
		await vi.waitFor(() => expect(updatesOf(outB).filter((message) => message.objectId === OBJ)).toHaveLength(1));

		const invalidUpdate = updatesOf(outB).find((message) => message.objectId === OBJ);
		if (!invalidUpdate) throw new Error("Invalid clock-skew update was not broadcast");
		for (let delivery = 0; delivery < 3; delivery++) {
			await handleMessage(nodeA, invalidUpdate);
		}

		expect(objA.drp?.query_pos("B")).toBeUndefined();
		expect(objA.vertices).toHaveLength(1);
		expect(directsOf(outA, MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);
	}, 20_000);

	test("descendants of an invalid beyond-tolerance vertex remain invalid without a SYNC storm", async () => {
		const OBJ = "invalid-skew-cascade-object";
		const outA = captureOutbound(nodeA);
		const outB = captureOutbound(nodeB);
		const objA = await nodeA.createObject({ id: OBJ, drp: new PosMapDRP() });
		const objB = await nodeB.createObject({ id: OBJ, drp: new PosMapDRP() });
		const mergeResults: MergeResult[] = [];
		const merge = objA.merge.bind(objA);
		vi.spyOn(objA, "merge").mockImplementation(async (vertices) => {
			const result = await merge(vertices);
			mergeResults.push(result);
			return result;
		});

		onSkewedClock(() => {
			objB.drp?.move("B", 1, 1);
			objB.drp?.move("B", 2, 2);
			objB.drp?.move("B", 3, 3);
		}, BEYOND_TOLERANCE_SKEW);
		await vi.waitFor(() => expect(updatesOf(outB).filter((message) => message.objectId === OBJ)).toHaveLength(3));

		const decodedUpdates = updatesOf(outB)
			.filter((message) => message.objectId === OBJ)
			.map((message) => {
				const vertices = Update.decode(message.data).vertices;
				if (vertices.length !== 1) throw new Error("Expected each captured UPDATE to contain one vertex");
				return { message, vertex: vertices[0] };
			});
		const capturedHashes = new Set(decodedUpdates.map(({ vertex }) => vertex.hash));
		const rootChild = decodedUpdates.find(({ vertex }) =>
			vertex.dependencies.every((dependency) => !capturedHashes.has(dependency))
		);
		if (!rootChild) throw new Error("Could not identify the root child in the captured update chain");
		const middle = decodedUpdates.find(({ vertex }) => vertex.dependencies.includes(rootChild.vertex.hash));
		if (!middle) throw new Error("Could not identify the middle vertex in the captured update chain");
		const leaf = decodedUpdates.find(({ vertex }) => vertex.dependencies.includes(middle.vertex.hash));
		if (!leaf) throw new Error("Could not identify the leaf vertex in the captured update chain");
		const parentAndMiddleUpdate = combineUpdates([rootChild.message, middle.message]);

		for (let delivery = 0; delivery < 3; delivery++) {
			await handleMessage(nodeA, parentAndMiddleUpdate);
		}
		await handleMessage(nodeA, leaf.message);

		for (const result of mergeResults.slice(0, 3)) {
			expect(result[1]).toHaveLength(0);
			expect(result[2]).toEqual(expect.arrayContaining([rootChild.vertex.hash, middle.vertex.hash]));
		}
		expect(mergeResults[3][1]).toHaveLength(0);
		expect(mergeResults[3][2]).toContain(leaf.vertex.hash);
		expect(directsOf(outA, MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);
	}, 20_000);

	test("a mixed valid and invalid update still handles finality for the applied vertex without syncing", async () => {
		const OBJ = "mixed-finality-object";
		const outA = captureOutbound(nodeA);
		const outB = captureOutbound(nodeB);
		const syncObject = vi.spyOn(nodeA, "syncObject");
		const acl = createACL({ admins: [nodeA.networkNode.peerId, nodeB.networkNode.peerId] });
		acl.context = { caller: nodeA.networkNode.peerId };
		acl.setKey(nodeA.keychain.blsPublicKey);
		acl.context = { caller: nodeB.networkNode.peerId };
		acl.setKey(nodeB.keychain.blsPublicKey);
		const objA = await nodeA.createObject({ id: OBJ, acl, drp: new PosMapDRP() });
		const objB = await nodeB.createObject({ id: OBJ, acl, drp: new PosMapDRP() });

		objB.drp?.move("B", 1, 1);
		await vi.waitFor(() => expect(updatesOf(outB).filter((message) => message.objectId === OBJ)).toHaveLength(1));
		onSkewedClock(() => objB.drp?.move("B", 2, 2), BEYOND_TOLERANCE_SKEW);
		await vi.waitFor(() => expect(updatesOf(outB).filter((message) => message.objectId === OBJ)).toHaveLength(2));

		const [validUpdate, invalidUpdate] = updatesOf(outB).filter((message) => message.objectId === OBJ);
		const validVertex = Update.decode(validUpdate.data).vertices[0];
		await handleMessage(nodeA, combineUpdates([validUpdate, invalidUpdate]));

		expect(objA.finalityStore.signed(nodeB.networkNode.peerId, validVertex.hash)).toBe(true);
		expect(objA.finalityStore.signed(nodeA.networkNode.peerId, validVertex.hash)).toBe(true);
		expect(syncObject).not.toHaveBeenCalled();
		expect(directsOf(outA, MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(0);
	}, 20_000);
});

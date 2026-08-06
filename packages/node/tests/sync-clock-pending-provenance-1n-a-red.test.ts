/**
 * Phase 1n-a keeps finite receiver-clock-future vertices pending without
 * confusing them with absent dependencies at any node recovery call site.
 */
import {
	ApplyInvariantError,
	createPermissionlessACL,
	createVertex,
	HashGraph,
	mergeAuthenticatedVertices,
} from "@ts-drp/object";
import {
	ActionType,
	type ApplyResult,
	DrpType,
	type IDRP,
	Message,
	MessageType,
	NodeEventName,
	Operation,
	type ResolveConflictsType,
	SemanticsType,
	SyncAccept,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { DRP_VERTEX_FUTURE_TOLERANCE_MS } from "@ts-drp/validation";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

type Surface = "SYNC_ACCEPT" | "UPDATE";

interface ClockPendingMergeOutcome {
	readonly clockPending: readonly string[];
}

interface PrivateObject {
	readonly _applier: {
		readonly knownInvalidVertexHashes: { has(hash: string): boolean };
	};
}

interface Outbound {
	readonly message: Message;
	readonly peerId: string;
}

class CounterDRP implements IDRP {
	semanticsType: SemanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value++;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

function node(seed: string): DRPNode {
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

function message(surface: Surface, objectId: string, sender: string, vertices: readonly Vertex[]): Message {
	return Message.create({
		objectId,
		sender,
		type: surface === "UPDATE" ? MessageType.MESSAGE_TYPE_UPDATE : MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		data:
			surface === "UPDATE"
				? Update.encode(Update.create({ vertices: [...vertices] })).finish()
				: SyncAccept.encode(SyncAccept.create({ requested: [...vertices] })).finish(),
	});
}

function directTypes(outbound: readonly Outbound[]): MessageType[] {
	return outbound.map(({ message: outboundMessage }) => outboundMessage.type);
}

describe("Phase 1n-a clock-pending recovery provenance", () => {
	const sender = node("phase-1n-a-pending-sender");
	const receiver = node("phase-1n-a-pending-receiver");
	const objectIds: string[] = [];
	let sequence = 0;

	beforeAll(async () => {
		await Promise.all([sender.start(), receiver.start()]);
	}, 30_000);

	afterEach(() => {
		vi.restoreAllMocks();
		for (const objectId of objectIds.splice(0)) receiver.unsubscribeObject(objectId);
	});

	afterAll(async () => {
		await Promise.allSettled([sender.stop(), receiver.stop()]);
	});

	async function receiverObject(label: string): Promise<Awaited<ReturnType<typeof receiver.createObject<CounterDRP>>>> {
		const objectId = `phase-1n-a-${label}-${sequence++}`;
		objectIds.push(objectId);
		return receiver.createObject({
			acl: createPermissionlessACL(),
			drp: new CounterDRP(),
			id: objectId,
		});
	}

	async function signedVertex(label: string, dependencies: readonly string[], timestamp: number): Promise<Vertex> {
		const vertex = createVertex(
			sender.networkNode.peerId,
			Operation.create({ drpType: DrpType.DRP, opType: "increment", value: [label] }),
			[...dependencies],
			timestamp
		);
		vertex.signature = await sender.keychain.signWithSecp256k1(vertex.hash);
		return vertex;
	}

	function captureOutbound(): Outbound[] {
		const outbound: Outbound[] = [];
		vi.spyOn(receiver.networkNode, "sendMessage").mockImplementation((peerId, outboundMessage) => {
			outbound.push({ message: outboundMessage, peerId });
			return Promise.resolve();
		});
		vi.spyOn(receiver.networkNode, "broadcastMessage").mockResolvedValue();
		return outbound;
	}

	it("carries clock-pending hashes beside the unchanged legacy merge tuple", async () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const object = await receiverObject("outcome-seam");
		const pending = await signedVertex("outcome-seam", [HashGraph.rootHash], now + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1);

		const outcome = await mergeAuthenticatedVertices(object, [pending]);

		expect(outcome.result).toEqual([false, [pending.hash], []]);
		expect((outcome as typeof outcome & ClockPendingMergeOutcome).clockPending).toEqual([pending.hash]);
		expect((object as unknown as PrivateObject)._applier.knownInvalidVertexHashes.has(pending.hash)).toBe(false);
	});

	it.each(["UPDATE", "SYNC_ACCEPT"] as const)(
		"%s keeps pending-only authenticated input outside missing recovery and invalid-peer accounting",
		async (surface) => {
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now);
			const object = await receiverObject(`normal-${surface.toLowerCase()}`);
			const pending = await signedVertex(
				`normal-${surface}`,
				[HashGraph.rootHash],
				now + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1
			);
			const outbound = captureOutbound();
			const syncObject = vi.spyOn(receiver, "syncObject");
			const disconnect = vi.spyOn(receiver.networkNode, "disconnect").mockResolvedValue();

			await handleMessage(receiver, message(surface, object.id, sender.networkNode.peerId, [pending]));

			expect.soft(syncObject.mock.calls.length, "pending must not call syncObject").toBe(0);
			expect.soft(directTypes(outbound)).not.toContain(MessageType.MESSAGE_TYPE_SYNC);
			expect.soft(directTypes(outbound)).not.toContain(MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
			expect.soft(disconnect).not.toHaveBeenCalled();
			expect.soft(object.vertices.map(({ hash }) => hash)).toEqual([HashGraph.rootHash]);
			expect.soft(object.drp?.value).toBe(0);
			expect.soft((object as unknown as PrivateObject)._applier.knownInvalidVertexHashes.has(pending.hash)).toBe(false);
		}
	);

	it.each(["UPDATE", "SYNC_ACCEPT"] as const)(
		"%s rejected-boundary recovery preserves pending provenance without replacing the primary failure",
		async (surface) => {
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now);
			const object = await receiverObject(`boundary-${surface.toLowerCase()}`);
			const pending = await signedVertex(
				`boundary-${surface}`,
				[HashGraph.rootHash],
				now + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1
			);
			const partialResult: ApplyResult = { applied: false, invalid: [], missing: [pending.hash] };
			const primary = new ApplyInvariantError([new Error("controlled Phase 1n-a boundary")]);
			primary.partialResult = partialResult;
			Object.defineProperty(primary, "clockPending", {
				configurable: false,
				enumerable: false,
				value: [pending.hash],
			});
			vi.spyOn(object, "merge").mockRejectedValue(primary);
			const outbound = captureOutbound();
			const syncObject = vi.spyOn(receiver, "syncObject");

			await expect(
				handleMessage(receiver, message(surface, object.id, sender.networkNode.peerId, [pending]))
			).rejects.toBe(primary);
			expect.soft(syncObject.mock.calls.length, "pending boundary must not call syncObject").toBe(0);
			expect.soft(directTypes(outbound)).not.toContain(MessageType.MESSAGE_TYPE_SYNC);
			expect.soft(directTypes(outbound)).not.toContain(MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
			expect.soft(object.vertices.map(({ hash }) => hash)).toEqual([HashGraph.rootHash]);
			expect.soft(object.drp?.value).toBe(0);
		}
	);

	it("pending-only rounds neither consume nor reset a true-missing retry/cooldown episode", async () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const object = await receiverObject("retry-accounting");
		const missing = await signedVertex("missing", ["phase-1n-a-absent-parent"], now);
		const pending = await signedVertex("pending", [HashGraph.rootHash], now + DRP_VERTEX_FUTURE_TOLERANCE_MS + 1);
		const missingMessage = message("SYNC_ACCEPT", object.id, sender.networkNode.peerId, [missing]);
		const pendingMessage = message("SYNC_ACCEPT", object.id, sender.networkNode.peerId, [pending]);
		const outbound = captureOutbound();
		const syncObject = vi.spyOn(receiver, "syncObject");
		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		try {
			await handleMessage(receiver, missingMessage);
			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length).toBe(2);

			await handleMessage(receiver, pendingMessage);
			expect.soft(syncObject.mock.calls.length, "pending must not consume retry three").toBe(2);
			expect.soft(rejected.mock.calls.length).toBe(0);

			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length).toBe(3);
			expect.soft(rejected.mock.calls.length).toBe(0);

			await handleMessage(receiver, pendingMessage);
			expect.soft(syncObject.mock.calls.length, "pending at the limit must not open cooldown").toBe(3);
			expect.soft(rejected.mock.calls.length).toBe(0);

			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length).toBe(3);
			expect.soft(rejected.mock.calls.length).toBe(1);

			await handleMessage(receiver, pendingMessage);
			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length, "pending must not reset an active cooldown").toBe(3);
			expect.soft(rejected.mock.calls.length).toBe(1);
			expect.soft(directTypes(outbound).filter((type) => type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(3);
			expect.soft((object as unknown as PrivateObject)._applier.knownInvalidVertexHashes.has(pending.hash)).toBe(false);
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	});
});

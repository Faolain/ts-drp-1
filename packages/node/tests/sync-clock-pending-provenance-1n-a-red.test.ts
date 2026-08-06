/**
 * Phase 1n-a keeps finite receiver-clock-future vertices pending without
 * confusing them with absent dependencies at any node recovery call site.
 */
import {
	AdoptionCommitExhaustedError,
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
	type MergeResult,
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
		tryCommitPreparedVertex(...arguments_: unknown[]): "committed" | "duplicate" | "retry";
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
			const rejected = await signedVertex(`boundary-rejected-${surface}`, [HashGraph.rootHash], now);
			const applier = (object as unknown as PrivateObject)._applier;
			const originalTryCommit = applier.tryCommitPreparedVertex;
			applier.tryCommitPreparedVertex = (): "retry" => "retry";
			const originalMerge = object.merge.bind(object);
			let objectBoundaryError: unknown;
			let objectBoundaryPartialResult: ApplyResult | undefined;
			vi.spyOn(object, "merge").mockImplementation(async (vertices) => {
				try {
					return await originalMerge(vertices);
				} catch (error) {
					objectBoundaryError = error;
					if (error instanceof AdoptionCommitExhaustedError) objectBoundaryPartialResult = error.partialResult;
					throw error;
				}
			});
			const outbound = captureOutbound();
			const syncObject = vi.spyOn(receiver, "syncObject");
			let primary: unknown;

			try {
				await handleMessage(receiver, message(surface, object.id, sender.networkNode.peerId, [pending, rejected]));
			} catch (error) {
				primary = error;
			} finally {
				applier.tryCommitPreparedVertex = originalTryCommit;
			}

			expect.soft(primary).toBe(objectBoundaryError);
			expect.soft(primary).toBeInstanceOf(AdoptionCommitExhaustedError);
			if (primary instanceof AdoptionCommitExhaustedError) {
				expect.soft(primary.vertexHash).toBe(rejected.hash);
				expect.soft(primary.attempts).toBe(3);
				expect.soft(primary.partialResult).toBe(objectBoundaryPartialResult);
				expect.soft(primary.partialResult).toEqual({
					applied: false,
					invalid: [],
					missing: [pending.hash],
					quarantined: [rejected.hash],
				});
			}
			expect.soft(syncObject.mock.calls.length, "authenticated pending boundary must not call syncObject").toBe(0);
			expect.soft(directTypes(outbound)).not.toContain(MessageType.MESSAGE_TYPE_SYNC);
			expect.soft(directTypes(outbound)).not.toContain(MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
			expect.soft(object.vertices.map(({ hash }) => hash)).toEqual([HashGraph.rootHash]);
			expect.soft(object.drp?.value).toBe(0);
		}
	);

	it("a genuinely clean applied SYNC_ACCEPT resets recovery before the next incomplete round", async () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const object = await receiverObject("clean-round-reset");
		const missing = await signedVertex("clean-round-missing", ["phase-1n-a-clean-round-absent-parent"], now);
		const clean = await signedVertex("clean-round-applied", [HashGraph.rootHash], now);
		const missingMessage = message("SYNC_ACCEPT", object.id, sender.networkNode.peerId, [missing]);
		const cleanMessage = message("SYNC_ACCEPT", object.id, sender.networkNode.peerId, [clean]);
		const outbound = captureOutbound();
		const syncObject = vi.spyOn(receiver, "syncObject");
		const disconnect = vi.spyOn(receiver.networkNode, "disconnect").mockResolvedValue();
		const accepted = vi.fn();
		const rejected = vi.fn();
		const mergeResults: MergeResult[] = [];
		const merge = object.merge.bind(object);
		vi.spyOn(object, "merge").mockImplementation(async (vertices) => {
			const result = await merge(vertices);
			mergeResults.push(result);
			return result;
		});
		receiver.addEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		try {
			for (let round = 0; round < 3; round++) await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length).toBe(3);
			expect.soft(directTypes(outbound).filter((type) => type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(3);
			expect.soft(rejected).not.toHaveBeenCalled();
			expect.soft(accepted).not.toHaveBeenCalled();
			expect.soft(object.vertices.map(({ hash }) => hash)).toEqual([HashGraph.rootHash]);
			expect.soft(object.drp?.value).toBe(0);

			await handleMessage(receiver, cleanMessage);
			expect.soft(mergeResults.at(-1)).toEqual([true, [], []]);
			expect.soft(accepted).toHaveBeenCalledTimes(1);
			expect.soft(accepted.mock.calls[0]?.[0].detail).toEqual({ id: object.id });
			expect.soft(rejected).not.toHaveBeenCalled();
			expect.soft(object.vertices.map(({ hash }) => hash)).toEqual([HashGraph.rootHash, clean.hash]);
			expect.soft(object.drp?.value).toBe(1);

			// A reset makes this retry one of a new episode. Three new incomplete
			// rounds must all recover before the fourth opens a fresh cooldown.
			for (let round = 0; round < 3; round++) await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length, "post-clean recovery must restart at retry one").toBe(6);
			expect.soft(directTypes(outbound).filter((type) => type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(6);
			expect.soft(rejected.mock.calls.length, "the clean round must discard the earlier retry count").toBe(0);

			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length).toBe(6);
			expect.soft(rejected).toHaveBeenCalledTimes(1);
			expect.soft(rejected.mock.calls[0]?.[0].detail).toEqual({
				id: object.id,
				peerId: sender.networkNode.peerId,
				retries: 3,
			});
			expect.soft(accepted).toHaveBeenCalledTimes(1);
			expect.soft(disconnect).not.toHaveBeenCalled();
			expect.soft((object as unknown as PrivateObject)._applier.knownInvalidVertexHashes.has(missing.hash)).toBe(false);
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	});

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
		const accepted = vi.fn();
		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		try {
			await handleMessage(receiver, missingMessage);
			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length).toBe(2);

			await handleMessage(receiver, pendingMessage);
			expect.soft(syncObject.mock.calls.length, "pending must not consume retry three").toBe(2);
			expect.soft(rejected.mock.calls.length).toBe(0);
			expect.soft(accepted.mock.calls.length, "pending-only input is not an accepted sync").toBe(0);

			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length).toBe(3);
			expect.soft(rejected.mock.calls.length).toBe(0);

			await handleMessage(receiver, pendingMessage);
			expect.soft(syncObject.mock.calls.length, "pending at the limit must not open cooldown").toBe(3);
			expect.soft(rejected.mock.calls.length).toBe(0);
			expect.soft(accepted.mock.calls.length, "pending-only input must not reset or report convergence").toBe(0);

			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length).toBe(3);
			expect.soft(rejected.mock.calls.length).toBe(1);

			await handleMessage(receiver, pendingMessage);
			await handleMessage(receiver, missingMessage);
			expect.soft(syncObject.mock.calls.length, "pending must not reset an active cooldown").toBe(3);
			expect.soft(rejected.mock.calls.length).toBe(1);
			expect.soft(accepted.mock.calls.length, "pending-only input in cooldown remains unaccepted").toBe(0);
			expect.soft(directTypes(outbound).filter((type) => type === MessageType.MESSAGE_TYPE_SYNC)).toHaveLength(3);
			expect.soft((object as unknown as PrivateObject)._applier.knownInvalidVertexHashes.has(pending.hash)).toBe(false);

			const clean = await signedVertex("retry-accounting-clean", [HashGraph.rootHash], now);
			await handleMessage(receiver, message("SYNC_ACCEPT", object.id, sender.networkNode.peerId, [clean]));
			expect
				.soft(accepted.mock.calls.length, "one genuinely applied clean round reports acceptance exactly once")
				.toBe(1);
			expect.soft(accepted.mock.calls[0]?.[0].detail).toEqual({ id: object.id });
			expect.soft(object.vertices.map(({ hash }) => hash)).toEqual([HashGraph.rootHash, clean.hash]);
			expect.soft(object.drp?.value).toBe(1);
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	});
});

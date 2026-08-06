/**
 * Phase 1n-a corrective RED: only a genuinely applied clean SYNC_ACCEPT may
 * reset recovery or report acceptance. Trusted-only offers make no progress.
 */
import { createPermissionlessACL, createVertex, HashGraph } from "@ts-drp/object";
import {
	ActionType,
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
	Vertex,
} from "@ts-drp/types";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

const INVALID_VERTEX_CAPACITY = 10_000;
const UPDATE_BATCH_LIMIT = 32;

interface Outbound {
	readonly message: Message;
	readonly peerId: string;
}

interface PrivateObject {
	readonly _applier: {
		readonly knownInvalidVertexHashes: { has(hash: string): boolean };
	};
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

function syncAccept(objectId: string, sender: string, vertices: readonly Vertex[]): Message {
	return Message.create({
		data: SyncAccept.encode(SyncAccept.create({ requested: [...vertices] })).finish(),
		objectId,
		sender,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
	});
}

function update(objectId: string, sender: string, vertices: readonly Vertex[]): Message {
	return Message.create({
		data: Update.encode(Update.create({ vertices: [...vertices] })).finish(),
		objectId,
		sender,
		type: MessageType.MESSAGE_TYPE_UPDATE,
	});
}

function directSyncCount(outbound: readonly Outbound[]): number {
	return outbound.filter(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC).length;
}

describe("Phase 1n-a trusted-only/no-progress correction", () => {
	const sender = node("phase-1n-a-no-progress-sender");
	const receiver = node("phase-1n-a-no-progress-receiver");
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

	async function receiverObject(
		label: string,
		compact = false
	): Promise<Awaited<ReturnType<typeof receiver.createObject<CounterDRP>>>> {
		const objectId = `phase-1n-a-no-progress-${label}-${sequence++}`;
		objectIds.push(objectId);
		const common = {
			acl: createPermissionlessACL(),
			drp: new CounterDRP(),
			finality_config: { enabled: false },
			id: objectId,
		};
		return compact
			? receiver.createObject({ ...common, history_storage: "compact", replica_mode: "observer" })
			: receiver.createObject(common);
	}

	async function signedVertex(label: string, dependencies: readonly string[]): Promise<Vertex> {
		const vertex = createVertex(
			sender.networkNode.peerId,
			Operation.create({ drpType: DrpType.DRP, opType: "increment", value: [label] }),
			[...dependencies],
			Date.now()
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

	it.each([{ kind: "raw unsigned root-shaped offer" as const }, { kind: "already-present duplicate offer" as const }])(
		"$kind neither resets a recovery episode nor reports acceptance",
		async ({ kind }) => {
			const object = await receiverObject(kind === "raw unsigned root-shaped offer" ? "root" : "duplicate");
			let noProgress: Vertex;
			if (kind === "raw unsigned root-shaped offer") {
				noProgress = Vertex.create({ hash: HashGraph.rootHash });
			} else {
				noProgress = await signedVertex("stored-duplicate", [HashGraph.rootHash]);
				await handleMessage(receiver, syncAccept(object.id, sender.networkNode.peerId, [noProgress]));
			}

			const missing = await signedVertex(`${kind}-missing`, [`phase-1n-a-${kind}-absent-parent`]);
			const missingMessage = syncAccept(object.id, sender.networkNode.peerId, [missing]);
			const noProgressMessage = syncAccept(object.id, sender.networkNode.peerId, [noProgress]);
			const outbound = captureOutbound();
			const syncObject = vi.spyOn(receiver, "syncObject");
			const disconnect = vi.spyOn(receiver.networkNode, "disconnect").mockResolvedValue();
			const accepted = vi.fn();
			const rejected = vi.fn();
			receiver.addEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
			receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

			try {
				await handleMessage(receiver, missingMessage);
				await receiver.syncObject(object.id, sender.networkNode.peerId);
				await receiver.syncObject(object.id, sender.networkNode.peerId);
				expect.soft(syncObject.mock.calls.length).toBe(3);
				expect.soft(directSyncCount(outbound)).toBe(3);
				expect.soft(rejected.mock.calls.length).toBe(0);

				const hashesBefore = object.vertices.map(({ hash }) => hash);
				const valueBefore = object.drp?.value;
				const merge = vi.spyOn(object, "merge");
				await handleMessage(receiver, noProgressMessage);

				expect.soft(merge.mock.calls.length, "trusted-only input must not reach object.merge").toBe(0);
				expect.soft(syncObject.mock.calls.length, "trusted-only input must not recover").toBe(3);
				expect.soft(directSyncCount(outbound), "trusted-only input must send no SYNC").toBe(3);
				expect.soft(outbound.some(({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT)).toBe(false);
				expect.soft(object.vertices.map(({ hash }) => hash)).toEqual(hashesBefore);
				expect.soft(object.drp?.value).toBe(valueBefore);
				expect
					.soft((object as unknown as PrivateObject)._applier.knownInvalidVertexHashes.has(noProgress.hash))
					.toBe(false);
				expect.soft(disconnect.mock.calls.length).toBe(0);
				expect.soft(accepted.mock.calls.length, "no-progress input is not an accepted sync").toBe(0);

				await receiver.syncObject(object.id, sender.networkNode.peerId);
				expect
					.soft(syncObject.mock.calls.length, "the retained episode must reject retry four without recovery")
					.toBe(4);
				expect.soft(directSyncCount(outbound)).toBe(3);
				expect.soft(rejected.mock.calls.length).toBe(1);
				expect.soft(rejected.mock.calls[0]?.[0].detail).toEqual({
					id: object.id,
					peerId: sender.networkNode.peerId,
					retries: 3,
				});
				expect.soft(accepted.mock.calls.length).toBe(0);
				expect.soft(disconnect.mock.calls.length).toBe(0);
				expect.soft(object.vertices.map(({ hash }) => hash)).toEqual(hashesBefore);
				expect.soft(object.drp?.value).toBe(valueBefore);
				expect
					.soft((object as unknown as PrivateObject)._applier.knownInvalidVertexHashes.has(missing.hash))
					.toBe(false);
			} finally {
				receiver.removeEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
				receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
			}
		}
	);

	it("a compact observer's genuinely applied clean round resets and emits exactly once", async () => {
		const object = await receiverObject("compact-clean", true);
		const clean = await signedVertex("compact-clean", [HashGraph.rootHash]);
		const missing = await signedVertex("compact-missing", [clean.hash]);
		const nextMissing = await signedVertex("compact-next-missing", ["phase-1n-a-compact-next-parent"]);
		const missingMessage = syncAccept(object.id, sender.networkNode.peerId, [missing]);
		const nextMissingMessage = syncAccept(object.id, sender.networkNode.peerId, [nextMissing]);
		const outbound = captureOutbound();
		const syncObject = vi.spyOn(receiver, "syncObject");
		const disconnect = vi.spyOn(receiver.networkNode, "disconnect").mockResolvedValue();
		const accepted = vi.fn();
		const rejected = vi.fn();
		const merge = vi.spyOn(object, "merge");
		receiver.addEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);

		try {
			await handleMessage(receiver, missingMessage);
			await receiver.syncObject(object.id, sender.networkNode.peerId);
			await receiver.syncObject(object.id, sender.networkNode.peerId);
			expect.soft(syncObject.mock.calls.length).toBe(3);
			expect.soft(accepted.mock.calls.length).toBe(0);

			await handleMessage(receiver, syncAccept(object.id, sender.networkNode.peerId, [clean]));
			expect.soft(merge.mock.results.at(-1)?.type).toBe("return");
			expect.soft(object.historyStorage).toBe("compact");
			expect.soft(object.replicaMode).toBe("observer");
			expect.soft(object.historyInventory.knownHashes).toContain(clean.hash);
			expect.soft(object.getVertex(clean.hash)).toEqual(clean);
			expect.soft(object.drp?.value).toBe(1);
			expect.soft(accepted.mock.calls.length).toBe(1);
			expect.soft(accepted.mock.calls[0]?.[0].detail).toEqual({ id: object.id });

			await handleMessage(receiver, nextMissingMessage);
			expect.soft(syncObject.mock.calls.length, "the compact clean commit starts a fresh episode").toBe(4);
			expect.soft(directSyncCount(outbound)).toBe(4);
			expect.soft(rejected.mock.calls.length).toBe(0);
			expect.soft(accepted.mock.calls.length).toBe(1);
			expect.soft(disconnect.mock.calls.length).toBe(0);
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	});

	it("exact-cap raw-empty exhaustion disconnects without DRP_SYNC_ACCEPTED", async () => {
		const object = await receiverObject("invalid-cap");
		const duplicate = await signedVertex("invalid-cap-stored", [HashGraph.rootHash]);
		const rawRoot = Vertex.create({ hash: HashGraph.rootHash });
		await handleMessage(receiver, syncAccept(object.id, sender.networkNode.peerId, [duplicate]));

		const outbound = captureOutbound();
		const syncObject = vi.spyOn(receiver, "syncObject");
		const disconnect = vi.spyOn(receiver.networkNode, "disconnect").mockResolvedValue();
		await handleMessage(receiver, syncAccept(object.id, sender.networkNode.peerId, [rawRoot]));
		await handleMessage(receiver, syncAccept(object.id, sender.networkNode.peerId, [duplicate]));

		const forged = Array.from({ length: INVALID_VERTEX_CAPACITY }, (_, index) =>
			Vertex.create({
				dependencies: [HashGraph.rootHash],
				hash: `phase-1n-a-invalid-cap-${index}`,
				operation: Operation.create({ drpType: DrpType.DRP, opType: "increment", value: [index] }),
				peerId: sender.networkNode.peerId,
				timestamp: 1_710_200_000_000 + index,
			})
		);
		for (let offset = 0; offset < forged.length - 1; offset += UPDATE_BATCH_LIMIT) {
			await handleMessage(
				receiver,
				update(
					object.id,
					sender.networkNode.peerId,
					forged.slice(offset, Math.min(offset + UPDATE_BATCH_LIMIT, forged.length - 1))
				)
			);
		}
		expect.soft(disconnect.mock.calls.length, "trusted-only rounds consume no invalid-peer budget").toBe(0);

		const hashesBefore = object.vertices.map(({ hash }) => hash);
		const valueBefore = object.drp?.value;
		const accepted = vi.fn();
		const merge = vi.spyOn(object, "merge");
		receiver.addEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
		try {
			const finalInvalid = forged.at(-1);
			if (finalInvalid === undefined) throw new Error("Exact-cap fixture is empty");
			await handleMessage(receiver, syncAccept(object.id, sender.networkNode.peerId, [finalInvalid, rawRoot]));

			expect.soft(merge.mock.calls.length, "invalid plus trusted-only input must not reach object.merge").toBe(0);
			expect.soft(disconnect.mock.calls.length).toBe(1);
			expect.soft(disconnect.mock.calls.map(([peerId]) => String(peerId))).toEqual([String(sender.networkNode.peerId)]);
			expect.soft(syncObject.mock.calls.length).toBe(0);
			expect.soft(directSyncCount(outbound)).toBe(0);
			expect.soft(object.vertices.map(({ hash }) => hash)).toEqual(hashesBefore);
			expect.soft(object.drp?.value).toBe(valueBefore);
			expect
				.soft((object as unknown as PrivateObject)._applier.knownInvalidVertexHashes.has(finalInvalid.hash))
				.toBe(false);
			expect.soft(accepted.mock.calls.length, "an exhausted peer cannot report sync acceptance").toBe(0);
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_ACCEPTED, accepted);
		}
	}, 60_000);
});

/**
 * Phase 1o-d RED: only canonical vertex-hash strings may cross a wire-derived
 * boundary into exact-request retention. The internal queue remains permissive
 * for trusted callers; validation belongs to the wire-to-retention boundary.
 */
import {
	DRP_HEADS_CHUNK_PROTOCOL,
	type NegotiatedSyncSender,
	type SelectedSyncProtocol,
	validateNegotiatedSync,
} from "@ts-drp/network";
import { AdoptionCommitExhaustedError, createPermissionlessACL, createVertex, HashGraph } from "@ts-drp/object";
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
	Sync,
	SyncAccept,
	Update,
	type Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";
import { previewSyncSend, queueExactRequests } from "../src/sync-state.js";

interface Outbound {
	readonly message: Message;
	readonly peerId: string;
}

type VertexSurface = "SYNC_ACCEPT" | "UPDATE";

const HEADS_SELECTION = Object.freeze({
	mode: "heads-chunk",
	protocol: DRP_HEADS_CHUNK_PROTOCOL,
} satisfies SelectedSyncProtocol);

const MALFORMED_HASHES = [
	{ bytes: 63, characters: 63, hash: "a".repeat(63), label: "short" },
	{ bytes: 65, characters: 65, hash: "b".repeat(65), label: "long" },
	{ bytes: 64, characters: 64, hash: "g".repeat(64), label: "non-hex" },
	{ bytes: 64, characters: 64, hash: "A".repeat(64), label: "uppercase" },
	{ bytes: 128, characters: 64, hash: "é".repeat(64), label: "multibyte amplification" },
] as const;

const outboundByNode = new WeakMap<DRPNode, Outbound[]>();

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value++;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

function syncSender(node: () => DRPNode): NegotiatedSyncSender {
	function outbound(): Outbound[] {
		const capture = outboundByNode.get(node());
		if (capture === undefined) throw new Error("Expected outbound capture");
		return capture;
	}
	return {
		async sendSyncMessage(peerId, payloadFactory): Promise<void> {
			outbound().push({ message: await payloadFactory(HEADS_SELECTION), peerId });
		},
		sendSyncResponseMessage(peerId, message): Promise<void> {
			outbound().push({ message, peerId });
			return Promise.resolve();
		},
	};
}

function makeNode(seed: string): DRPNode {
	const node: DRPNode = new DRPNode(
		{
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
		},
		{ syncSender: syncSender(() => node) }
	);
	return node;
}

function captureOutbound(node: DRPNode): Outbound[] {
	const outbound: Outbound[] = [];
	outboundByNode.set(node, outbound);
	vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
	return outbound;
}

function roundTrip(message: Message): Message {
	return Message.decode(Message.encode(message).finish());
}

function headsMessage(sender: DRPNode, objectId: string, hashes: readonly string[]): Message {
	return Message.create({
		data: Sync.encode(Sync.create({ heads: [...hashes] })).finish(),
		objectId,
		sender: sender.networkNode.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC,
	});
}

async function deliverAdmittedHeads(receiver: DRPNode, message: Message): Promise<"handled" | "rejected"> {
	const encoded = Message.encode(message).finish();
	const decoded = Message.decode(encoded);
	try {
		validateNegotiatedSync(decoded, DRP_HEADS_CHUNK_PROTOCOL, encoded.byteLength);
	} catch {
		return "rejected";
	}
	await handleMessage(receiver, decoded, HEADS_SELECTION);
	return "handled";
}

async function signedVertex(
	signer: DRPNode,
	label: string,
	dependencies: readonly string[],
	timestamp = Date.now()
): Promise<Vertex> {
	const vertex = createVertex(
		signer.networkNode.peerId,
		Operation.create({ drpType: DrpType.DRP, opType: "increment", value: [label] }),
		[...dependencies],
		timestamp
	);
	vertex.signature = await signer.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

function vertexMessage(
	surface: VertexSurface,
	sender: DRPNode,
	objectId: string,
	vertices: readonly Vertex[]
): Message {
	return Message.create({
		data:
			surface === "UPDATE"
				? Update.encode(Update.create({ vertices: [...vertices] })).finish()
				: SyncAccept.encode(SyncAccept.create({ requested: [...vertices] })).finish(),
		objectId,
		sender: sender.networkNode.peerId,
		type: surface === "UPDATE" ? MessageType.MESSAGE_TYPE_UPDATE : MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
	});
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

describe("Phase 1o-d exact retained-hash wire ingress", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	async function pair(label: string): Promise<{ receiver: DRPNode; sender: DRPNode }> {
		const receiver = makeNode(`phase-1o-d-${label}-receiver`);
		const sender = makeNode(`phase-1o-d-${label}-sender`);
		nodes.push(receiver, sender);
		await Promise.all([receiver.start(), sender.start()]);
		captureOutbound(receiver);
		captureOutbound(sender);
		return { receiver, sender };
	}

	test("negotiated heads reject the complete malformed shape table before allocation, retention, or response work", async () => {
		const { receiver, sender } = await pair("heads-table");
		const attacked = await receiver.createObject({
			acl: createPermissionlessACL(),
			drp: new CounterDRP(),
			finality_config: { enabled: false },
		});
		const honest = await receiver.createObject({
			acl: createPermissionlessACL(),
			drp: new CounterDRP(),
			finality_config: { enabled: false },
		});
		const honestVertex = await signedVertex(sender, "honest-boundary", [HashGraph.rootHash]);
		expect(honestVertex.hash).toMatch(/^[0-9a-f]{64}$/);
		for (const malformed of MALFORMED_HASHES) {
			expect(malformed.hash).toHaveLength(malformed.characters);
			expect(utf8Bytes(malformed.hash)).toBe(malformed.bytes);
		}

		const syncObject = vi.spyOn(receiver, "syncObject").mockResolvedValue();
		for (const { hash } of MALFORMED_HASHES) {
			await deliverAdmittedHeads(receiver, headsMessage(sender, attacked.id, [hash]));
		}
		await deliverAdmittedHeads(receiver, headsMessage(sender, honest.id, [honestVertex.hash]));

		for (const { hash, label } of MALFORMED_HASHES) {
			expect
				.soft(
					previewSyncSend(receiver, attacked.id, sender.networkNode.peerId, "scheduled-probe").requestedHashes,
					`${label} input must not poison exact retention`
				)
				.not.toContain(hash);
		}
		expect.soft(previewSyncSend(receiver, attacked.id, sender.networkNode.peerId, "scheduled-probe")).toEqual({
			requestedHashes: [],
			send: true,
		});
		expect
			.soft(previewSyncSend(receiver, honest.id, sender.networkNode.peerId, "scheduled-probe").requestedHashes)
			.toEqual([honestVertex.hash]);
		expect.soft(syncObject, "only the valid boundary starts response work").toHaveBeenCalledTimes(1);
		expect.soft(syncObject).toHaveBeenCalledWith(honest.id, sender.networkNode.peerId);

		const parse = vi.spyOn(JSON, "parse");
		const beforeCleanup = parse.mock.calls.length;
		receiver.unsubscribeObject(attacked.id);
		const retainedTupleKeyVisits = parse.mock.calls.length - beforeCleanup;
		expect
			.soft(retainedTupleKeyVisits, "malformed-only traffic must allocate no retained tuple key")
			.toBeLessThanOrEqual(1);
		expect
			.soft(previewSyncSend(receiver, honest.id, sender.networkNode.peerId, "scheduled-probe").requestedHashes)
			.toEqual([honestVertex.hash]);
	});

	test.each(["UPDATE", "SYNC_ACCEPT"] as const)(
		"authenticated %s dependencies cannot smuggle a non-canonical hash into exact retention",
		async (surface) => {
			const { receiver, sender } = await pair(`authenticated-${surface.toLowerCase()}`);
			const object = await receiver.createObject({
				acl: createPermissionlessACL(),
				drp: new CounterDRP(),
				finality_config: { enabled: false },
			});
			const malformedDependency = "g".repeat(64);
			const child = await signedVertex(sender, `${surface}-malformed-dependency`, [malformedDependency]);
			const syncObject = vi.spyOn(receiver, "syncObject").mockResolvedValue();

			await handleMessage(receiver, roundTrip(vertexMessage(surface, sender, object.id, [child])), HEADS_SELECTION);

			expect.soft(object.getVertex(child.hash)).toBeUndefined();
			expect.soft(object.drp?.value).toBe(0);
			expect.soft(previewSyncSend(receiver, object.id, sender.networkNode.peerId, "scheduled-probe")).toEqual({
				requestedHashes: [],
				send: true,
			});
			expect
				.soft(syncObject, "malformed dependency rejection performs no recovery response work")
				.not.toHaveBeenCalled();
		}
	);

	test("rejected-boundary recovery also filters authenticated malformed dependencies", async () => {
		const { receiver, sender } = await pair("rejected-boundary");
		const object = await receiver.createObject({
			acl: createPermissionlessACL(),
			drp: new CounterDRP(),
			finality_config: { enabled: false },
		});
		const malformedDependency = "é".repeat(64);
		const missing = await signedVertex(sender, "boundary-missing", [malformedDependency]);
		const forcedRetry = await signedVertex(sender, "boundary-forced-retry", [HashGraph.rootHash]);
		const applier = Reflect.get(object as object, "_applier") as object;
		const originalTryCommit = Reflect.get(applier, "tryCommitPreparedVertex");
		Reflect.set(applier, "tryCommitPreparedVertex", (): "retry" => "retry");
		const syncObject = vi.spyOn(receiver, "syncObject").mockResolvedValue();
		let primary: unknown;

		try {
			await handleMessage(
				receiver,
				roundTrip(vertexMessage("UPDATE", sender, object.id, [missing, forcedRetry])),
				HEADS_SELECTION
			);
		} catch (error) {
			primary = error;
		} finally {
			Reflect.set(applier, "tryCommitPreparedVertex", originalTryCommit);
		}

		expect.soft(primary).toBeInstanceOf(AdoptionCommitExhaustedError);
		expect.soft(previewSyncSend(receiver, object.id, sender.networkNode.peerId, "scheduled-probe")).toEqual({
			requestedHashes: [],
			send: true,
		});
		expect.soft(syncObject, "rejected-boundary filtering performs no recovery response work").not.toHaveBeenCalled();
	});

	test("malformed ingress cannot reset a canonical request cooldown and later same-hash recovery still closes it", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const { receiver, sender } = await pair("lifecycle");
		const outbound = outboundByNode.get(receiver);
		if (outbound === undefined) throw new Error("Expected receiver outbound capture");
		const object = await receiver.createObject({
			acl: createPermissionlessACL(),
			drp: new CounterDRP(),
			finality_config: { enabled: false },
		});
		const canonical = await signedVertex(sender, "later-same-hash", [HashGraph.rootHash], now);
		expect(canonical.hash).toMatch(/^[0-9a-f]{64}$/);

		await deliverAdmittedHeads(receiver, headsMessage(sender, object.id, [canonical.hash]));
		const retained = previewSyncSend(receiver, object.id, sender.networkNode.peerId, "scheduled-probe").requestedHashes;
		const tupleKey = JSON.stringify([object.id, sender.networkNode.peerId]);
		const expectedTupleKeyCharacters = receiver.networkNode.peerId.length + 33 + sender.networkNode.peerId.length + 7;
		const census = {
			entries: retained.length,
			hashStringCharacters: retained.reduce((total, hash) => total + hash.length, 0),
			hashUtf8Bytes: retained.reduce((total, hash) => total + utf8Bytes(hash), 0),
			note: "string payload/key bytes only; JS heap/container characterization is deferred to Phase 1o-f",
			tupleKeyCharacters: tupleKey.length,
			tupleKeyUtf8Bytes: utf8Bytes(tupleKey),
		};
		expect(census).toEqual({
			entries: 1,
			hashStringCharacters: 64,
			hashUtf8Bytes: 64,
			note: "string payload/key bytes only; JS heap/container characterization is deferred to Phase 1o-f",
			tupleKeyCharacters: expectedTupleKeyCharacters,
			tupleKeyUtf8Bytes: expectedTupleKeyCharacters,
		});
		process.stdout.write(`${JSON.stringify({ gate: "phase-1o-d-retained-byte-census", ...census })}\n`);

		await receiver.syncObject(object.id, sender.networkNode.peerId);
		await receiver.syncObject(object.id, sender.networkNode.peerId);
		const rejected = vi.fn();
		receiver.addEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		try {
			await receiver.syncObject(object.id, sender.networkNode.peerId);
			expect.soft(rejected).toHaveBeenCalledTimes(1);
			const outboundAtCooldown = outbound.length;

			await deliverAdmittedHeads(receiver, headsMessage(sender, object.id, ["A".repeat(64)]));

			expect.soft(outbound, "malformed ingress must not restart outbound work").toHaveLength(outboundAtCooldown);
			expect
				.soft(rejected, "malformed ingress must not replace the existing cooldown episode")
				.toHaveBeenCalledTimes(1);
			expect.soft(previewSyncSend(receiver, object.id, sender.networkNode.peerId, "scheduled-probe")).toEqual({
				requestedHashes: [],
				send: false,
			});

			vi.mocked(Date.now).mockReturnValue(now + 30_001);
			await handleMessage(
				receiver,
				roundTrip(vertexMessage("SYNC_ACCEPT", sender, object.id, [canonical])),
				HEADS_SELECTION
			);
			expect.soft(object.getVertex(canonical.hash)?.hash).toBe(canonical.hash);
			expect.soft(object.drp?.value).toBe(1);
			expect.soft(previewSyncSend(receiver, object.id, sender.networkNode.peerId, "scheduled-probe")).toEqual({
				requestedHashes: [],
				send: true,
			});
		} finally {
			receiver.removeEventListener(NodeEventName.DRP_SYNC_REJECTED, rejected);
		}
	});

	test("trusted direct queue callers retain their intentionally permissive internal contract", async () => {
		const { receiver, sender } = await pair("direct-control");
		const object = await receiver.createObject({ drp: new CounterDRP(), finality_config: { enabled: false } });
		const inputs = MALFORMED_HASHES.map(({ hash }) => hash);

		expect(queueExactRequests(receiver, object.id, sender.networkNode.peerId, inputs)).toBe(true);
		expect(previewSyncSend(receiver, object.id, sender.networkNode.peerId, "scheduled-probe")).toEqual({
			requestedHashes: inputs,
			send: true,
		});
	});
});

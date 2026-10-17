import type { Stream } from "@libp2p/interface";
import { ed25519 } from "@noble/curves/ed25519.js";
import { DRP_MESSAGE_PROTOCOL, DRPNetworkNode, uint8ArrayToStream } from "@ts-drp/network";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	createGenuinePreparedV3Fixture,
	type GenuinePreparedV3Fixture,
} from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { DRPNode } from "../packages/node/src/index.js";

// Prospective R9.3/R6d.1 causal RED, not retirement acceptance. Genuine local
// libp2p streams execute the existing parser and DRPNode ingress. Queue/room
// callbacks are reached effect tripwires, not substitute application authority.
// The signed type-11 control proves transport preservation, not live admission.
const config = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" as const },
};
function network(): DRPNetworkNode {
	return new DRPNetworkNode(config, {
		hostPolicy: {
			bootstrapDiscovery: false,
			coldStartPubsubDiscovery: false,
			gossipSubPeerExchange: false,
		},
	});
}
function join(...parts: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}
function varint(value: number): Uint8Array {
	const result: number[] = [];
	do {
		const next = value & 127;
		value = Math.floor(value / 128);
		result.push(next | (value > 0 ? 128 : 0));
	} while (value > 0);
	return Uint8Array.from(result);
}
function field(number: number, bytes: Uint8Array): Uint8Array {
	return join(varint(number * 8 + 2), varint(bytes.byteLength), bytes);
}
function outer(types: readonly number[], data: readonly Uint8Array[], objectId: string): Uint8Array {
	return join(
		...types.map((type) => join(Uint8Array.of(16), varint(type))),
		...data.map((bytes) => field(3, bytes)),
		field(4, new TextEncoder().encode(objectId))
	);
}
async function streamOutcome(stream: Stream): Promise<string> {
	if (["closed", "reset", "aborted"].includes(stream.status)) return stream.status;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			new Promise<string>((resolve) => {
				stream.addEventListener("close", () => resolve(stream.status), { once: true });
			}),
			new Promise<string>((resolve) => {
				timer = setTimeout(() => resolve("deadline"), 2_000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
const contextualFields = [
	{ name: "absent", bytes: new Uint8Array() },
	{ name: "empty length-delimited", bytes: Uint8Array.of(18, 0) },
	{ name: "wrong varint wire", bytes: Uint8Array.of(16, 0) },
	{ name: "wrong fixed64 wire", bytes: Uint8Array.of(17, 0, 0, 0, 0, 0, 0, 0, 0) },
	{ name: "wrong fixed32 wire", bytes: Uint8Array.of(21, 0, 0, 0, 0) },
] as const;

describe("raw retired wire causal native ingress", () => {
	let sender: DRPNetworkNode;
	let receiver: DRPNode;
	let prepared: GenuinePreparedV3Fixture;
	let signedData: Uint8Array;
	let signedVertex: ReturnType<GenuinePreparedV3Fixture["createRecoveryVertex"]>;
	const rawOwners: (() => void)[] = [];
	let sequence = 0;
	beforeAll(async () => {
		sender = network();
		const receiverNetwork = network();
		receiver = new DRPNode(
			{ network_config: config, log_config: { level: "silent" } },
			{ networkNode: receiverNetwork, reconnect: false }
		);
		await Promise.all([sender.start(), receiver.start()]);
		await sender.connect(receiverNetwork.getMultiaddrs());
		prepared = await createGenuinePreparedV3Fixture({ authorizationMode: "latched-acl" });
		signedVertex = prepared.createRecoveryVertex(0, [prepared.anchorDigest]);
		expect(ed25519.verify(signedVertex.signature, signedVertex.digest, prepared.authorPublicKey)).toBe(true);
		signedData = V3Envelope.encode({
			canonicalPreimage: signedVertex.canonicalPreimageBytes,
			signature: signedVertex.signature,
		}).finish();
	}, 30_000);
	afterAll(async () => {
		for (const close of rawOwners.splice(0)) close();
		await Promise.allSettled([receiver?.stop(), sender?.stop(), prepared?.close()]);
	});
	async function sendRaw(bytes: Uint8Array): Promise<string> {
		const host = sender["_node"];
		if (host === undefined) throw new Error("missing genuine started sender host");
		const connection = host.getConnections().find((peer) => peer.remotePeer.toString() === receiver.networkNode.peerId);
		if (connection === undefined) throw new Error("missing authenticated loopback connection");
		const stream = await connection.newStream(DRP_MESSAGE_PROTOCOL);
		const outcome = streamOutcome(stream);
		try {
			await uint8ArrayToStream(stream, bytes);
		} catch {
			// Terminal receiver refusal can also reject the local frame write.
		}
		return outcome;
	}
	async function barrier(): Promise<void> {
		const objectId = `raw-wire-barrier-${sequence++}`;
		let seen = false;
		receiver.messageQueueManager.subscribe(objectId, () => {
			seen = true;
		});
		await sender.sendMessage(
			receiver.networkNode.peerId,
			Message.create({ type: MessageType.MESSAGE_TYPE_CUSTOM, objectId })
		);
		await expect.poll(() => seen, { timeout: 5_000, interval: 10 }).toBe(true);
	}
	function objectTripwire(objectId: string): { readonly effects: Message[] } {
		const effects: Message[] = [];
		receiver.messageQueueManager.subscribe(objectId, (message) => {
			effects.push(message);
		});
		return { effects };
	}
	function retainedTripwire(): { readonly ingressId: string; readonly effects: Message[] } {
		const objectId = `${sender.peerId}:${(sequence++).toString(16).padStart(32, "0")}`;
		const port = receiver.openRoomNetwork(objectId);
		rawOwners.push(() => port.close());
		const ingressId = `raw-wire-v3-${sequence++}`;
		const effects: Message[] = [];
		port.setIngressHandler(
			ingressId,
			() => undefined,
			(message) => {
				effects.push(message);
			}
		);
		return { ingressId, effects };
	}
	function boundNetwork(): DRPNetworkNode {
		const value = receiver.networkNode;
		if (!(value instanceof DRPNetworkNode)) throw new Error("missing genuine bound network");
		return value;
	}
	it("outbound retired wire standalone negative-control sender still selects sync and builds old traffic", async () => {
		const dial = vi.spyOn(sender, "safeDial");
		const factory = vi.fn(() => Message.create({ type: MessageType.MESSAGE_TYPE_SYNC }));
		try {
			// The product receiver refuses the frame; the unbound native sender must
			// still reach real protocol selection and its existing payload factory.
			await sender
				.sendSyncMessage(receiver.networkNode.peerId, factory, { signal: AbortSignal.timeout(2_000) })
				.catch(() => undefined);
			expect(dial).toHaveBeenCalledTimes(1);
			expect(factory).toHaveBeenCalledTimes(1);
			await barrier();
		} finally {
			dial.mockRestore();
		}
	});
	it("outbound retired wire direct families refuse before native dial without signal", async () => {
		const bound = boundNetwork();
		const dial = vi.spyOn(bound, "safeDial");
		try {
			for (const type of [1, 2, 3, 4, 5, 6, 7]) {
				await expect(bound.sendMessage(sender.peerId, Message.create({ type }))).rejects.toMatchObject({
					name: "V3ProductWireRefusal",
					code: "RETIRED_OBJECT_PROTOCOL",
				});
			}
			expect(dial).not.toHaveBeenCalled();
		} finally {
			dial.mockRestore();
		}
	});
	it.each(["broadcast", "publish", "random-group"] as const)(
		"outbound retired wire %s refuses before readiness or peer selection",
		async (route) => {
			const bound = boundNetwork();
			const pubsub = bound["_pubsub"];
			if (pubsub === undefined) throw new Error("missing genuine pubsub");
			const subscribers = vi.spyOn(pubsub, "getSubscribers");
			const peers = vi.spyOn(bound, "getGroupPeers");
			const publish = vi.spyOn(pubsub, "publish");
			try {
				const message = Message.create({ type: MessageType.MESSAGE_TYPE_UPDATE });
				const result =
					route === "broadcast"
						? bound.broadcastMessage("outbound-retired", message)
						: route === "publish"
							? bound.publishMessage("outbound-retired", message)
							: bound.sendGroupMessageRandomPeer("outbound-retired", message);
				await expect(result).rejects.toMatchObject({ name: "V3ProductWireRefusal", code: "RETIRED_OBJECT_PROTOCOL" });
				expect(subscribers).not.toHaveBeenCalled();
				expect(peers).not.toHaveBeenCalled();
				expect(publish).not.toHaveBeenCalled();
			} finally {
				subscribers.mockRestore();
				peers.mockRestore();
				publish.mockRestore();
			}
		}
	);
	it("outbound retired wire negotiated sync refuses before factory dial or admission", async () => {
		const bound = boundNetwork();
		const dial = vi.spyOn(bound, "safeDial");
		const factory = vi.fn(() => Message.create({ type: MessageType.MESSAGE_TYPE_SYNC }));
		try {
			await expect(
				bound.sendSyncMessage(sender.peerId, factory, { signal: AbortSignal.timeout(2_000) })
			).rejects.toMatchObject({
				name: "V3ProductWireRefusal",
				code: "RETIRED_OBJECT_PROTOCOL",
			});
			for (const type of [MessageType.MESSAGE_TYPE_SYNC_ACCEPT, MessageType.MESSAGE_TYPE_SYNC_REJECT]) {
				await expect(bound.sendSyncResponseMessage(sender.peerId, Message.create({ type }))).rejects.toMatchObject({
					name: "V3ProductWireRefusal",
					code: "RETIRED_OBJECT_PROTOCOL",
				});
			}
			expect(factory).not.toHaveBeenCalled();
			expect(dial).not.toHaveBeenCalled();
		} finally {
			dial.mockRestore();
		}
	});
	it("outbound retired wire current native sends preserve signed bytes and detached encoding", async () => {
		const bound = boundNetwork();
		const received: Message[] = [];
		const objectId = `outbound-current-${sequence++}`;
		sender.subscribeToMessageQueue((message) => {
			if (message.objectId === objectId) received.push(message);
		});
		for (const type of [8, 9, 10, 11]) {
			const data = type === 11 ? signedData : Uint8Array.of(16, 7, 18, 0);
			const message = Message.create({ type, objectId, data });
			const encoded = Message.encode(message).finish();
			const original = bound.safeDial.bind(bound);
			const dial = vi.spyOn(bound, "safeDial").mockImplementation((...args) => {
				message.type = MessageType.MESSAGE_TYPE_FETCH_STATE;
				message.data = Uint8Array.of(0);
				return original(...args);
			});
			try {
				await bound.sendMessage(sender.peerId, message, { signal: AbortSignal.timeout(5_000) });
			} finally {
				dial.mockRestore();
			}
			await expect.poll(() => received.length, { timeout: 5_000 }).toBe(type - 7);
			const delivered = received.at(-1);
			if (delivered === undefined) throw new Error("missing genuine current delivery");
			expect(Message.encode({ ...delivered, sender: "" }).finish()).toEqual(encoded);
			expect(delivered.sender).toBe(bound.peerId);
			expect(bound.rawMessageStructureFor(message)).toBeUndefined();
			if (type === 11) {
				const envelope = V3Envelope.decode(delivered.data);
				expect(ed25519.verify(envelope.signature, signedVertex.digest, prepared.authorPublicKey)).toBe(true);
			}
		}
	});
	it("outbound retired wire current publication and mesh sends preserve native signed payloads", async () => {
		const bound = boundNetwork();
		const topic = `outbound-current-topic-${sequence++}`;
		const received: Message[] = [];
		sender.subscribeToMessageQueue((message) => {
			if (message.objectId.startsWith(topic)) received.push(message);
		});
		sender.subscribe(topic);
		bound.subscribe(topic);
		try {
			await expect.poll(() => bound.getGroupPeers(topic, "mesh"), { timeout: 5_000 }).toContain(sender.peerId);
			const messages = [
				Message.create({
					type: MessageType.MESSAGE_TYPE_CUSTOM,
					objectId: topic + "-broadcast",
					data: Uint8Array.of(16, 7, 18, 0),
				}),
				Message.create({ type: MessageType.MESSAGE_TYPE_V3_ENVELOPE, objectId: topic + "-publish", data: signedData }),
				Message.create({
					type: MessageType.MESSAGE_TYPE_CUSTOM,
					objectId: topic + "-mesh",
					data: Uint8Array.of(18, 0, 16, 7),
				}),
			];
			await bound.broadcastMessage(topic, messages[0]);
			expect(await bound.publishMessage(topic, messages[1])).toBe(true);
			await bound.sendGroupMessageRandomPeer(topic, messages[2]);
			await expect.poll(() => received.length, { timeout: 5_000 }).toBe(3);
			for (const message of messages) {
				const delivered = received.find((item) => item.objectId === message.objectId);
				if (delivered === undefined) throw new Error("missing actual current publication");
				expect(delivered.sender).toBe(bound.peerId);
				expect(delivered.data).toEqual(message.data);
				expect(sender.rawMessageStructureFor(delivered)?.typeMask).toBe(1 << message.type);
			}
			const envelope = V3Envelope.decode(received.find((message) => message.type === 11)?.data ?? new Uint8Array());
			expect(ed25519.verify(envelope.signature, signedVertex.digest, prepared.authorPublicKey)).toBe(true);
		} finally {
			sender.unsubscribe(topic);
			bound.unsubscribe(topic);
		}
	}, 15_000);
	it("raw retired wire controls preserve type11 signature slot and required authenticated message transport", async () => {
		const target = retainedTripwire();
		const outcome = await sendRaw(outer([11], [signedData], target.ingressId));
		await barrier();
		expect(outcome).toBe("closed");
		expect(target.effects).toHaveLength(1);
		const accepted = target.effects[0];
		if (accepted === undefined) throw new Error("missing type11 transport control");
		expect(accepted.sender).toBe(sender.peerId);
		expect(accepted.data).toEqual(signedData);
		const envelope = V3Envelope.decode(accepted.data);
		expect(envelope.signature).toEqual(signedVertex.signature);
		expect(envelope.canonicalPreimage).toEqual(signedVertex.canonicalPreimageBytes);
		expect(ed25519.verify(envelope.signature, signedVertex.digest, prepared.authorPublicKey)).toBe(true);
	});
	it("raw retired wire controls keep CUSTOM opaque and discovery noncreating", async () => {
		const objectId = `raw-wire-custom-${sequence++}`;
		const opaque = objectTripwire(objectId);
		// These apparent type7/tag18 bytes have no protobuf meaning inside CUSTOM.
		const data = Uint8Array.of(16, 7, 18, 0, 16, 11);
		expect(await sendRaw(outer([8], [data], objectId))).toBe("closed");
		await barrier();
		expect(opaque.effects.map((message) => message.data)).toEqual([data]);
		const discovery = vi.spyOn(receiver.messageQueueManager, "enqueue");
		for (const type of [9, 10]) {
			const id = `raw-wire-discovery-${sequence++}`;
			expect(await sendRaw(outer([type], [new Uint8Array()], id))).toBe("closed");
			await barrier();
			expect(receiver.get(id)).toBeUndefined();
		}
		expect(discovery.mock.calls.filter(([, message]) => [9, 10].includes(message.type))).toHaveLength(2);
		discovery.mockRestore();
	});
	it("raw retired wire direct normalized copies and fabricated structural properties refuse before effects", async () => {
		const target = retainedTripwire();
		const normalized = Message.decode(outer([7, 11], [signedData], target.ingressId));
		Reflect.set(
			normalized,
			"structure",
			Object.freeze({
				kind: "drp-message-wire-structure-v1",
				typeOccurrences: 1,
				dataOccurrences: 1,
				typeMask: 1 << 11,
				outsideKnownTypes: false,
				conflictingTypes: false,
				invalidCriticalWire: false,
				malformed: false,
				contextualField2Present: false,
			})
		);
		await expect(receiver.dispatchMessage(normalized)).rejects.toMatchObject({
			code: "MESSAGE_RAW_PROVENANCE_REQUIRED",
		});
		await expect(
			receiver.dispatchMessage(Message.create({ type: 7, objectId: target.ingressId }))
		).rejects.toMatchObject({ code: "RETIRED_OBJECT_PROTOCOL" });
		expect(target.effects).toHaveLength(0);
	});
	it.each([
		{
			name: "outer type wrong wire",
			bytes: (id: string): Uint8Array =>
				join(field(2, Uint8Array.of(11)), field(3, signedData), field(4, new TextEncoder().encode(id))),
		},
		{
			name: "outer data wrong wire",
			bytes: (id: string): Uint8Array => join(outer([11], [], id), Uint8Array.of(24, 0)),
		},
		{
			name: "malformed tag zero",
			bytes: (id: string): Uint8Array => join(outer([11], [signedData], id), Uint8Array.of(0)),
		},
		{
			name: "malformed field zero length-delimited",
			bytes: (id: string): Uint8Array => join(outer([11], [signedData], id), Uint8Array.of(2, 0)),
		},
		{
			name: "truncated data length",
			bytes: (id: string): Uint8Array => join(outer([11], [], id), Uint8Array.of(26, 127)),
		},
	])("raw retired wire refuses $name before generated normalization and effects", async ({ bytes }) => {
		const target = retainedTripwire();
		const outcome = await sendRaw(bytes(target.ingressId));
		await barrier();
		expect({ outcome, retainedEffects: target.effects.length }).toEqual({ outcome: "reset", retainedEffects: 0 });
	});
	it.each([
		{ name: "retired type7 then11", types: [7, 11] },
		{ name: "type11 then retired7 then11", types: [11, 7, 11] },
		{ name: "retired type3 then11", types: [3, 11] },
		{ name: "duplicate identical type11", types: [11, 11] },
	])("raw retired wire refuses $name before normalized retained delivery", async ({ types }) => {
		const target = retainedTripwire();
		const raw = outer(types, [signedData], target.ingressId);
		expect(Message.decode(raw).type).toBe(11); // Reached generated laundering precondition.
		const outcome = await sendRaw(raw);
		await barrier();
		expect({ outcome, retainedEffects: target.effects.length }).toEqual({ outcome: "reset", retainedEffects: 0 });
	});
	it.each([
		{
			name: "discarded contextual retired payload then valid envelope",
			payloads: (): Uint8Array[] => [Uint8Array.of(18, 0), signedData],
		},
		{ name: "duplicate identical data", payloads: (): Uint8Array[] => [signedData, signedData] },
	])("raw retired wire refuses $name before data normalization", async ({ payloads }) => {
		const target = retainedTripwire();
		const raw = outer([11], payloads(), target.ingressId);
		expect(Message.decode(raw).data).toEqual(signedData);
		const outcome = await sendRaw(raw);
		await barrier();
		expect({ outcome, retainedEffects: target.effects.length }).toEqual({ outcome: "reset", retainedEffects: 0 });
	});
	it.each([1, 2, 3, 4, 5, 6, 7])(
		"raw retired wire refuses old family type%s before object queue effects",
		async (type) => {
			const objectId = `raw-wire-retired-${sequence++}`;
			const target = objectTripwire(objectId);
			const outcome = await sendRaw(outer([type], [new Uint8Array()], objectId));
			await barrier();
			expect({ outcome, objectEffects: target.effects.length }).toEqual({ outcome: "reset", objectEffects: 0 });
		}
	);
	for (const type of [3, 5]) {
		it.each(contextualFields)(
			`raw retired wire refuses type${type} contextual field2 $name before object queue effects`,
			async ({ bytes }) => {
				const objectId = `raw-wire-context-${sequence++}`;
				const target = objectTripwire(objectId);
				const raw = outer([type], [bytes], objectId);
				expect(Message.decode(raw).data).toEqual(bytes);
				const outcome = await sendRaw(raw);
				await barrier();
				expect({ outcome, objectEffects: target.effects.length }).toEqual({ outcome: "reset", objectEffects: 0 });
			}
		);
	}
	it("raw retired wire immutable eligibility owner survives joined stop and native restart", async () => {
		const genuine = receiver.networkNode;
		if (!(genuine instanceof DRPNetworkNode)) throw new Error("missing genuine network owner");
		expect(() => genuine.installMessageStructuralAdmission(() => undefined)).toThrow("different owner");
		await receiver.stop();
		expect(() => genuine.installMessageStructuralAdmission(() => undefined)).toThrow("different owner");
		await receiver.start();
		await sender.connect(genuine.getMultiaddrs());
		const target = retainedTripwire();
		expect(await sendRaw(outer([11], [signedData], target.ingressId))).toBe("closed");
		await barrier();
		expect(target.effects).toHaveLength(1);
		expect(await sendRaw(outer([7, 11], [signedData], target.ingressId))).toBe("reset");
		await barrier();
		expect(target.effects).toHaveLength(1);
	}, 30_000);
});

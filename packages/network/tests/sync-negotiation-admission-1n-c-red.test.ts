/**
 * Phase 1n-c amended RED: sync payloads are built only after real libp2p
 * multistream selection, on the stream that carries the selected payload.
 *
 * The only fallback manipulation below is `Libp2p.unhandle` of the additive
 * production protocol. The real DRP fallback handler remains registered; this
 * is an authentically unsupported peer, not a test negotiator or emulator.
 */
import { type GossipSub } from "@libp2p/gossipsub";
import { type Stream } from "@libp2p/interface";
import { Message, MessageType, Sync } from "@ts-drp/types";
import { type Libp2p } from "libp2p";
import { afterEach, describe, expect, test } from "vitest";

import { DRP_MESSAGE_PROTOCOL, DRPNetworkNode, uint8ArrayToStream } from "../src/node.js";

const HEADS_CHUNK_PROTOCOL = "/drp/message/1.0.0/heads-chunk";
const PROTOCOL_PREFERENCE = [HEADS_CHUNK_PROTOCOL, DRP_MESSAGE_PROTOCOL] as const;

interface SelectedSyncProtocol {
	readonly mode: "fallback" | "heads-chunk";
	readonly protocol: (typeof PROTOCOL_PREFERENCE)[number];
}

interface DirectSyncIngress {
	readonly message: Message;
	readonly peerId: string;
	readonly protocol: (typeof PROTOCOL_PREFERENCE)[number];
	readonly transport: "direct";
}

interface NegotiatedSyncNetwork {
	sendSyncMessage(
		peerId: string,
		payloadFactory: (selection: SelectedSyncProtocol) => Message | Promise<Message>,
		options?: { readonly signal?: AbortSignal }
	): Promise<void>;
}

const config = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" as const },
};

function makeNode(): DRPNetworkNode {
	return new DRPNetworkNode(config, {
		hostPolicy: {
			bootstrapDiscovery: false,
			coldStartPubsubDiscovery: false,
			gossipSubPeerExchange: false,
		},
	});
}

function host(node: DRPNetworkNode): Libp2p {
	const value = node["_node"];
	if (value === undefined) throw new Error("Expected a started production libp2p host");
	return value;
}

function negotiated(node: DRPNetworkNode): NegotiatedSyncNetwork {
	return node as unknown as NegotiatedSyncNetwork;
}

function subscribeToIngress(node: DRPNetworkNode, received: DirectSyncIngress[]): void {
	const productionQueue = node as unknown as {
		subscribeToMessageQueue(handler: (ingress: DirectSyncIngress) => void): void;
	};
	productionQueue.subscribeToMessageQueue((ingress) => received.push(ingress));
}

function syncMessage(objectId: string, selection: SelectedSyncProtocol): Message {
	const sync =
		selection.mode === "heads-chunk"
			? Sync.create({ heads: [`${objectId}-head`] })
			: Sync.create({ vertexHashes: [`${objectId}-fallback`] });
	return Message.create({
		data: Sync.encode(sync).finish(),
		objectId,
		type: MessageType.MESSAGE_TYPE_SYNC,
	});
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
	await expect.poll(check, { interval: 10, timeout: 10_000, message: description }).toBe(true);
}

async function remoteStreamOutcome(stream: Stream): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			new Promise<string>((resolve) => {
				stream.addEventListener("close", () => resolve(stream.status), { once: true });
			}),
			new Promise<string>((resolve) => {
				timer = setTimeout(() => resolve("deadline"), 750);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

describe("Phase 1n-c real sync negotiation and provenance", () => {
	const running: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
	});

	test("registers one canonical preference and selects heads-chunk mutually in both directions", async () => {
		const left = makeNode();
		const right = makeNode();
		running.push(left, right);
		await Promise.all(running.map((node) => node.start()));
		await left.connect(right.getMultiaddrs());

		expect(host(left).getProtocols()).toContain(HEADS_CHUNK_PROTOCOL);
		expect(host(right).getProtocols()).toContain(HEADS_CHUNK_PROTOCOL);
		const leftIngress: DirectSyncIngress[] = [];
		const rightIngress: DirectSyncIngress[] = [];
		subscribeToIngress(left, leftIngress);
		subscribeToIngress(right, rightIngress);
		const factorySelections: Array<[string, SelectedSyncProtocol]> = [];

		await negotiated(left).sendSyncMessage(right.peerId, (selection) => {
			factorySelections.push(["left", selection]);
			return syncMessage(`${left.peerId}:${"11".repeat(16)}`, selection);
		});
		await negotiated(right).sendSyncMessage(left.peerId, (selection) => {
			factorySelections.push(["right", selection]);
			return syncMessage(`${right.peerId}:${"12".repeat(16)}`, selection);
		});
		await waitFor(() => leftIngress.length === 1 && rightIngress.length === 1, "mutual direct ingress");

		expect(factorySelections).toEqual([
			["left", { mode: "heads-chunk", protocol: HEADS_CHUNK_PROTOCOL }],
			["right", { mode: "heads-chunk", protocol: HEADS_CHUNK_PROTOCOL }],
		]);
		expect(rightIngress[0]).toMatchObject({
			peerId: left.peerId,
			protocol: HEADS_CHUNK_PROTOCOL,
			transport: "direct",
		});
		expect(leftIngress[0]).toMatchObject({
			peerId: right.peerId,
			protocol: HEADS_CHUNK_PROTOCOL,
			transport: "direct",
		});
	});

	test("selects the real fallback before invoking the factory and never advertises heads", async () => {
		const sender = makeNode();
		const fallback = makeNode();
		running.push(sender, fallback);
		await Promise.all(running.map((node) => node.start()));
		if (host(fallback).getProtocols().includes(HEADS_CHUNK_PROTOCOL)) {
			await host(fallback).unhandle(HEADS_CHUNK_PROTOCOL);
		}
		expect(host(fallback).getProtocols()).toContain(DRP_MESSAGE_PROTOCOL);
		expect(host(fallback).getProtocols()).not.toContain(HEADS_CHUNK_PROTOCOL);
		await sender.connect(fallback.getMultiaddrs());
		const received: DirectSyncIngress[] = [];
		subscribeToIngress(fallback, received);
		const selections: SelectedSyncProtocol[] = [];

		await negotiated(sender).sendSyncMessage(fallback.peerId, (selection) => {
			selections.push(selection);
			return syncMessage(`${sender.peerId}:${"13".repeat(16)}`, selection);
		});
		await waitFor(() => received.length === 1, "fallback ingress");

		expect(selections).toEqual([{ mode: "fallback", protocol: DRP_MESSAGE_PROTOCOL }]);
		const payload = Sync.decode(received[0].message.data);
		expect(payload.vertexHashes).toEqual([`${sender.peerId}:${"13".repeat(16)}-fallback`]);
		expect(payload.heads).toEqual([]);
		expect(payload.sharedHeads).toEqual([]);
		expect(payload.requestedHashes).toEqual([]);
	});

	test("attaches authenticated direct provenance selected by the live stream", async () => {
		const sender = makeNode();
		const receiver = makeNode();
		running.push(sender, receiver);
		await Promise.all(running.map((node) => node.start()));
		await sender.connect(receiver.getMultiaddrs());
		const received: DirectSyncIngress[] = [];
		subscribeToIngress(receiver, received);
		const connection = host(sender)
			.getConnections()
			.find((candidate) => candidate.remotePeer.toString() === receiver.peerId);
		if (connection === undefined) throw new Error("Expected the real sender/receiver connection");
		const stream = await connection.newStream(DRP_MESSAGE_PROTOCOL);
		const forged = syncMessage(`${sender.peerId}:${"14".repeat(16)}`, {
			mode: "fallback",
			protocol: DRP_MESSAGE_PROTOCOL,
		});
		forged.sender = "not-the-transport-peer";

		await uint8ArrayToStream(stream, Message.encode(forged).finish());
		await waitFor(() => received.length === 1, "attributed direct ingress");

		expect(received[0]).toMatchObject({
			peerId: sender.peerId,
			protocol: DRP_MESSAGE_PROTOCOL,
			transport: "direct",
		});
		expect(received[0].message.sender).toBe(sender.peerId);
	});

	test("resets negotiated protocol contradictions and actual request cap violations before queue ingress", async () => {
		const sender = makeNode();
		const additiveReceiver = makeNode();
		const fallbackReceiver = makeNode();
		running.push(sender, additiveReceiver, fallbackReceiver);
		await Promise.all(running.map((node) => node.start()));
		if (host(fallbackReceiver).getProtocols().includes(HEADS_CHUNK_PROTOCOL)) {
			await host(fallbackReceiver).unhandle(HEADS_CHUNK_PROTOCOL);
		}
		await sender.connect(additiveReceiver.getMultiaddrs());
		await sender.connect(fallbackReceiver.getMultiaddrs());
		const additiveIngress: DirectSyncIngress[] = [];
		const fallbackIngress: DirectSyncIngress[] = [];
		subscribeToIngress(additiveReceiver, additiveIngress);
		subscribeToIngress(fallbackReceiver, fallbackIngress);
		const longHash = "x".repeat(2_050);
		const cases = [
			{
				code: "SYNC_PROTOCOL_VIOLATION",
				peer: fallbackReceiver,
				sync: Sync.create({ heads: ["head-on-fallback"], vertexHashes: ["fallback"] }),
			},
			{
				code: "SYNC_PROTOCOL_VIOLATION",
				peer: additiveReceiver,
				sync: Sync.create({ heads: ["head"], vertexHashes: ["field-one-on-heads"] }),
			},
			{
				code: "SYNC_REQUEST_LIMIT",
				peer: additiveReceiver,
				sync: Sync.create({ heads: Array.from({ length: 33 }, (_, index) => `head-${index}`) }),
			},
			{
				code: "SYNC_REQUEST_LIMIT",
				peer: additiveReceiver,
				sync: Sync.create({ sharedHeads: Array.from({ length: 33 }, (_, index) => `shared-${index}`) }),
			},
			{
				code: "SYNC_REQUEST_LIMIT",
				peer: additiveReceiver,
				sync: Sync.create({ requestedHashes: Array.from({ length: 33 }, (_, index) => `request-${index}`) }),
			},
			{
				code: "SYNC_REQUEST_LIMIT",
				peer: additiveReceiver,
				sync: Sync.create({
					heads: Array.from({ length: 22 }, (_, index) => `head-${index}`),
					requestedHashes: Array.from({ length: 22 }, (_, index) => `request-${index}`),
					sharedHeads: Array.from({ length: 21 }, (_, index) => `shared-${index}`),
				}),
			},
			{
				code: "SYNC_REQUEST_LIMIT",
				peer: additiveReceiver,
				sync: Sync.create({ requestedHashes: Array.from({ length: 32 }, () => longHash) }),
			},
			{
				code: "SYNC_FALLBACK_LIMIT",
				peer: fallbackReceiver,
				sync: Sync.create({ vertexHashes: Array.from({ length: 513 }, (_, index) => `fallback-${index}`) }),
			},
			{
				code: "SYNC_FALLBACK_LIMIT",
				peer: fallbackReceiver,
				sync: Sync.create({ vertexHashes: Array.from({ length: 32 }, () => longHash) }),
			},
		] as const;
		expect(Sync.encode(cases[6].sync).finish().byteLength).toBeGreaterThan(65_536);
		expect(Sync.encode(cases[8].sync).finish().byteLength).toBeGreaterThan(65_536);

		const creatorBoundObjectId = `${sender.peerId}:${"01".repeat(16)}`;
		for (const fixture of cases) {
			let factoryCalls = 0;
			await expect(
				negotiated(sender).sendSyncMessage(fixture.peer.peerId, () => {
					factoryCalls++;
					return Message.create({
						data: Sync.encode(fixture.sync).finish(),
						objectId: creatorBoundObjectId,
						type: MessageType.MESSAGE_TYPE_SYNC,
					});
				})
			).rejects.toMatchObject({ code: fixture.code });
			expect(factoryCalls).toBe(1);
		}
		expect(additiveIngress).toEqual([]);
		expect(fallbackIngress).toEqual([]);
	});

	test("resets a raw real-stream contradiction at the receiver before central queue admission", async () => {
		const sender = makeNode();
		const receiver = makeNode();
		running.push(sender, receiver);
		await Promise.all(running.map((node) => node.start()));
		await sender.connect(receiver.getMultiaddrs());
		const received: DirectSyncIngress[] = [];
		subscribeToIngress(receiver, received);
		const connection = host(sender)
			.getConnections()
			.find((candidate) => candidate.remotePeer.toString() === receiver.peerId);
		if (connection === undefined) throw new Error("Expected the real contradiction connection");
		const stream = await connection.newStream([...PROTOCOL_PREFERENCE]);
		expect(stream.protocol).toBe(HEADS_CHUNK_PROTOCOL);
		const outcome = remoteStreamOutcome(stream);
		const contradiction = Message.create({
			data: Sync.encode(Sync.create({ heads: ["head"], vertexHashes: ["fallback"] })).finish(),
			objectId: `${sender.peerId}:${"02".repeat(16)}`,
			type: MessageType.MESSAGE_TYPE_SYNC,
		});

		await uint8ArrayToStream(stream, Message.encode(contradiction).finish());

		expect(await outcome).toBe("reset");
		expect(received).toEqual([]);
	});

	test("drops pubsub Sync because it has no negotiated direct provenance", async () => {
		const sender = makeNode();
		const receiver = makeNode();
		running.push(sender, receiver);
		await Promise.all(running.map((node) => node.start()));
		await sender.connect(receiver.getMultiaddrs());
		const topic = `${sender.peerId}:${"03".repeat(16)}`;
		sender.subscribe(topic);
		receiver.subscribe(topic);
		await waitFor(() => sender.getGroupPeers(topic).includes(receiver.peerId), "pubsub sync membership");
		const received: DirectSyncIngress[] = [];
		subscribeToIngress(receiver, received);
		const pubsub = receiver["_pubsub"] as GossipSub;
		const observed = new Promise<void>((resolve) => {
			pubsub.addEventListener(
				"gossipsub:message",
				(event) => {
					if (event.detail.msg.topic === topic) resolve();
				},
				{ once: true }
			);
		});

		await sender.broadcastMessage(
			topic,
			Message.create({
				data: Sync.encode(Sync.create({ heads: ["pubsub-head"] })).finish(),
				objectId: topic,
				type: MessageType.MESSAGE_TYPE_SYNC,
			})
		);
		await observed;
		await new Promise(process.nextTick);
		await new Promise(process.nextTick);

		expect(received).toEqual([]);
	});
});

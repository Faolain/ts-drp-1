/**
 * Phase 1n-c literal-wire corrective RED: generated protobuf decoding drops
 * unknown fields, so receiver caps must use the exact transmitted frame length
 * rather than the smaller decoded/re-encoded projection.
 *
 * The appended field is syntactically valid length-delimited protobuf padding
 * and deliberately malformed resource input. It asserts no identity or unknown-
 * field compatibility. Requests cover both mode-specific validator branches;
 * responses use heads-chunk because protocol mode does not alter either of the
 * distinct SyncAccept and SyncReject response branches.
 */
import { type Stream } from "@libp2p/interface";
import { Message, MessageType, Sync, SyncAccept, SyncReject } from "@ts-drp/types";
import { type Libp2p } from "libp2p";
import { afterEach, describe, expect, test } from "vitest";

import {
	DRP_HEADS_CHUNK_PROTOCOL,
	DRP_MESSAGE_PROTOCOL,
	DRPNetworkNode,
	SYNC_REQUEST_BYTE_CAP,
	SYNC_RESPONSE_BYTE_CAP,
	uint8ArrayToStream,
} from "../src/node.js";

interface DirectSyncIngress {
	readonly message: Message;
	readonly peerId: string;
	readonly protocol: string;
	readonly transport: "direct";
}

interface FrameFixture {
	readonly name: string;
	readonly protocol: typeof DRP_HEADS_CHUNK_PROTOCOL | typeof DRP_MESSAGE_PROTOCOL;
	readonly type: MessageType;
	readonly wireCap: number;
}

const config = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" as const },
};

const requestFixtures = [
	{
		name: "heads request",
		protocol: DRP_HEADS_CHUNK_PROTOCOL,
		type: MessageType.MESSAGE_TYPE_SYNC,
		wireCap: SYNC_REQUEST_BYTE_CAP,
	},
	{
		name: "fallback request",
		protocol: DRP_MESSAGE_PROTOCOL,
		type: MessageType.MESSAGE_TYPE_SYNC,
		wireCap: SYNC_REQUEST_BYTE_CAP,
	},
] as const satisfies readonly FrameFixture[];

const responseFixtures = [
	{
		name: "SYNC_ACCEPT response",
		protocol: DRP_HEADS_CHUNK_PROTOCOL,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		wireCap: SYNC_RESPONSE_BYTE_CAP,
	},
	{
		name: "SYNC_REJECT response",
		protocol: DRP_HEADS_CHUNK_PROTOCOL,
		type: MessageType.MESSAGE_TYPE_SYNC_REJECT,
		wireCap: SYNC_RESPONSE_BYTE_CAP,
	},
] as const satisfies readonly FrameFixture[];

const fixtures = [...requestFixtures, ...responseFixtures] as const;

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

function subscribeToAdmission(node: DRPNetworkNode, admissions: DirectSyncIngress[]): void {
	const productionQueue = node as unknown as {
		subscribeToMessageQueue(handler: (ingress: DirectSyncIngress) => void): void;
	};
	productionQueue.subscribeToMessageQueue((ingress) => admissions.push(ingress));
}

function canonicalMessage(fixture: FrameFixture, objectId: string): Message {
	let data: Uint8Array;
	if (fixture.type === MessageType.MESSAGE_TYPE_SYNC) {
		const sync =
			fixture.protocol === DRP_HEADS_CHUNK_PROTOCOL
				? Sync.create({ heads: ["ordinary-head"] })
				: Sync.create({ vertexHashes: ["ordinary-fallback-hash"] });
		data = Sync.encode(sync).finish();
	} else if (fixture.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT) {
		data = SyncAccept.encode(SyncAccept.create({ requesting: ["ordinary-request"] })).finish();
	} else {
		data = SyncReject.encode(SyncReject.create({ reason: "ordinary rejection" })).finish();
	}
	return Message.create({ data, objectId, type: fixture.type });
}

function encodeVarint(value: number): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	do {
		const low = remaining % 128;
		remaining = Math.floor(remaining / 128);
		bytes.push(remaining === 0 ? low : low | 0x80);
	} while (remaining !== 0);
	return Uint8Array.from(bytes);
}

function appendUnknownLengthDelimitedField(canonical: Uint8Array, payloadLength: number): Uint8Array {
	// Unknown field 15, wire type 2 (length-delimited).
	const tag = encodeVarint((15 << 3) | 2);
	const length = encodeVarint(payloadLength);
	const raw = new Uint8Array(canonical.byteLength + tag.byteLength + length.byteLength + payloadLength);
	raw.set(canonical);
	raw.set(tag, canonical.byteLength);
	raw.set(length, canonical.byteLength + tag.byteLength);
	return raw;
}

async function openRawStream(sender: DRPNetworkNode, receiver: DRPNetworkNode, protocol: string): Promise<Stream> {
	const connection = host(sender)
		.getConnections()
		.find((candidate) => candidate.remotePeer.toString() === receiver.peerId);
	if (connection === undefined) throw new Error("Expected the real sender/receiver connection");
	return connection.newStream(protocol);
}

async function remoteStreamOutcome(stream: Stream): Promise<string> {
	if (stream.status === "closed" || stream.status === "reset" || stream.status === "aborted") return stream.status;
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

async function waitForAdmission(admissions: DirectSyncIngress[]): Promise<void> {
	await expect
		.poll(() => admissions.length, { interval: 10, timeout: 10_000, message: "causal central admission" })
		.toBe(1);
}

describe("Phase 1n-c literal transmitted sync frame caps", () => {
	const running: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
	});

	test.each(fixtures)("resets an over-cap $name before central admission", async (fixture) => {
		const sender = makeNode();
		const receiver = makeNode();
		running.push(sender, receiver);
		await Promise.all(running.map((node) => node.start()));
		await sender.connect(receiver.getMultiaddrs());
		const admissions: DirectSyncIngress[] = [];
		subscribeToAdmission(receiver, admissions);
		const message = canonicalMessage(fixture, `${sender.peerId}:${"05".repeat(16)}`);
		const canonical = Message.encode(message).finish();
		const raw = appendUnknownLengthDelimitedField(canonical, fixture.wireCap);
		const decoded = Message.decode(raw);
		const projected = Message.encode(decoded).finish();

		expect(raw.byteLength).toBeGreaterThan(fixture.wireCap);
		expect(projected.byteLength).toBeLessThanOrEqual(fixture.wireCap);
		expect(decoded).toEqual(message);

		const stream = await openRawStream(sender, receiver, fixture.protocol);
		const outcomePromise = remoteStreamOutcome(stream);
		try {
			await uint8ArrayToStream(stream, raw);
		} catch {
			// A receiver-side reset may reject the writer as well as closing it.
		}
		const outcome = await outcomePromise;
		if (outcome === "closed") await waitForAdmission(admissions);
		else {
			await new Promise(process.nextTick);
			await new Promise(process.nextTick);
		}

		expect(
			{
				admissionCalls: admissions.length,
				canonicalBytes: projected.byteLength,
				outcome,
				rawBytes: raw.byteLength,
			},
			`${fixture.name}: raw=${raw.byteLength}, canonical=${projected.byteLength}`
		).toEqual({
			admissionCalls: 0,
			canonicalBytes: expect.any(Number),
			outcome: "reset",
			rawBytes: expect.any(Number),
		});
	});

	test.each(fixtures)("admits an ordinary within-cap $name", async (fixture) => {
		const sender = makeNode();
		const receiver = makeNode();
		running.push(sender, receiver);
		await Promise.all(running.map((node) => node.start()));
		await sender.connect(receiver.getMultiaddrs());
		const admissions: DirectSyncIngress[] = [];
		subscribeToAdmission(receiver, admissions);
		const message = canonicalMessage(fixture, `${sender.peerId}:${"06".repeat(16)}`);
		const raw = Message.encode(message).finish();
		expect(raw.byteLength).toBeLessThanOrEqual(fixture.wireCap);

		const stream = await openRawStream(sender, receiver, fixture.protocol);
		const outcomePromise = remoteStreamOutcome(stream);
		await uint8ArrayToStream(stream, raw);
		await waitForAdmission(admissions);

		expect(await outcomePromise).toBe("closed");
		expect(admissions).toHaveLength(1);
		expect(admissions[0]).toMatchObject({
			message: { type: fixture.type },
			peerId: sender.peerId,
			protocol: fixture.protocol,
			transport: "direct",
		});
	});
});

import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { DRPNetworkNode } from "@ts-drp/network";
import { Message, MessageType } from "@ts-drp/types";
import { afterEach, expect, it, vi } from "vitest";

import { DRPNode } from "../packages/node/src/index.js";
import type {
	NodeRoomNetworkPort,
	NodeRoomSettlementSourceAuthorizer,
	NodeRoomSettlementSourceRequest,
} from "../packages/node/src/room-network.js";

// Native local libp2p/Keychain controls. These transport refusals/custody tests
// grant no source authority; actual shared-policy acceptance is a separate case.
const REQUEST = new TextEncoder().encode("ts-drp-room-settlement-selection-request-v1\u0000");
const RESPONSE = new TextEncoder().encode("ts-drp-room-settlement-selection-response-v1\u0000");
const DOMAIN = "ts-drp/settlement-source-selection/v1";
const nodes = new Set<DRPNode>();
const ports = new Set<NodeRoomNetworkPort>();
const releases = new Set<() => void>();
let ordinal = 0;
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}
function deferred(): { readonly promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function proposal(bytes = encodeCanonical({ mechanismOnly: true })): NodeRoomSettlementSourceRequest {
	return { exactCanonicalSelectionBytes: bytes, digest: hashDomain(DOMAIN, bytes) };
}
function genuine(node: DRPNode): DRPNetworkNode {
	if (!(node.networkNode instanceof DRPNetworkNode)) throw new Error("missing actual native network");
	return node.networkNode;
}
async function startNode(): Promise<DRPNode> {
	const config = {
		bootstrap_peers: [],
		listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
		log_config: { level: "silent" as const },
	};
	const node = new DRPNode(
		{
			keychain_config: { private_key_seed: `r9-creator-control-${ordinal++}` },
			network_config: config,
			log_config: { level: "silent" },
		},
		{
			networkNode: new DRPNetworkNode(config, {
				hostPolicy: { bootstrapDiscovery: false, coldStartPubsubDiscovery: false, gossipSubPeerExchange: false },
			}),
			reconnect: false,
		}
	);
	nodes.add(node);
	await node.start();
	return node;
}
async function fixture(): Promise<
	Readonly<{
		objectId: string;
		creator: DRPNode;
		recipient: DRPNode;
		creatorPort: NodeRoomNetworkPort;
		recipientPort: NodeRoomNetworkPort;
	}>
> {
	const creator = await startNode(),
		recipient = await startNode();
	await recipient.networkNode.connect(creator.networkNode.getMultiaddrs());
	await expect.poll(() => creator.networkNode.getAllPeers()).toContain(recipient.networkNode.peerId);
	const objectId = `${creator.networkNode.peerId}:${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
	const creatorPort = creator.openRoomNetwork(objectId),
		recipientPort = recipient.openRoomNetwork(objectId);
	ports.add(creatorPort);
	ports.add(recipientPort);
	// Prove the genuine current CUSTOM transport/Node dispatcher before controls.
	let seen = false;
	const barrierId = `selection-control-ready-${ordinal++}`;
	creator.messageQueueManager.subscribe(barrierId, () => {
		seen = true;
	});
	await recipient.networkNode.sendMessage(
		creator.networkNode.peerId,
		Message.create({ type: MessageType.MESSAGE_TYPE_CUSTOM, objectId: barrierId })
	);
	await expect.poll(() => seen).toBe(true);
	return { objectId, creator, recipient, creatorPort, recipientPort };
}
afterEach(async () => {
	for (const release of releases) release();
	releases.clear();
	await Promise.allSettled([...ports].map((port) => port.close()));
	ports.clear();
	await Promise.allSettled([...nodes].map((node) => node.stop()));
	nodes.clear();
	vi.restoreAllMocks();
});

it("native creator selection missing policy explicitly refuses without signing", async () => {
	const f = await fixture();
	const signing = vi.spyOn(f.creator.keychain, "signWithLocalAuthor");
	const sender = vi.spyOn(genuine(f.recipient), "sendMessage");
	await expect(f.recipientPort.requestSettlementSourceAuthorization(proposal())).rejects.toThrow(
		/approval.*refused|approval.*unavailable/
	);
	expect(
		sender.mock.calls.filter(([, message]) =>
			message.data.subarray(0, REQUEST.byteLength).every((byte, index) => byte === REQUEST[index])
		)
	).toHaveLength(1);
	expect(signing).not.toHaveBeenCalled();
}, 20_000);

it("native creator selection fresh aggregate admission cancels delivery but joins entered sends before key shutdown", async () => {
	const f = await fixture(),
		gate = deferred();
	releases.add(gate.resolve);
	const original = genuine(f.recipient).sendMessage.bind(genuine(f.recipient));
	let entered = 0;
	vi.spyOn(genuine(f.recipient), "sendMessage").mockImplementation(async (...args) => {
		entered++;
		await gate.promise;
		return original(...args);
	});
	const stopSigning = vi.spyOn(f.recipient.keychain, "stop");
	const attempts = Array.from({ length: 32 }, (_, index) =>
		f.recipientPort.requestSettlementSourceAuthorization(proposal(encodeCanonical({ fresh: index }))).then(
			() => "unexpected approval",
			() => "unavailable"
		)
	);
	await expect.poll(() => entered).toBe(1);
	await expect(f.recipientPort.requestSettlementSourceAuthorization(proposal())).rejects.toThrow("capacity exhausted");
	let joined = false;
	const shutdown = f.recipient.stop().then(() => {
		joined = true;
	});
	await Promise.all(attempts);
	expect(joined).toBe(false);
	expect(stopSigning).not.toHaveBeenCalled();
	await expect(f.recipientPort.requestSettlementSourceAuthorization(proposal())).rejects.toThrow("closed");
	gate.resolve();
	releases.delete(gate.resolve);
	await shutdown;
	expect(joined).toBe(true);
	expect(stopSigning).toHaveBeenCalledTimes(1);
	expect(entered).toBe(1); // Queued fresh calls are revoked, never coalesced into a send.
}, 20_000);

it("native creator selection detached-byte admission refuses before the count ceiling", async () => {
	const f = await fixture(),
		gate = deferred();
	releases.add(gate.resolve);
	const original = genuine(f.recipient).sendMessage.bind(genuine(f.recipient));
	let entered = 0;
	vi.spyOn(genuine(f.recipient), "sendMessage").mockImplementation(async (...args) => {
		entered++;
		await gate.promise;
		return original(...args);
	});
	const bytes = new Uint8Array(320_000),
		request = proposal(bytes);
	const attempts: Promise<string>[] = [];
	let refused = false;
	for (let index = 0; index < 32; index++) {
		const result = f.recipientPort.requestSettlementSourceAuthorization(request);
		let immediate: string | undefined;
		const observed = result.then(
			() => "unexpected approval",
			(error: unknown) => {
				if (error instanceof Error && error.message.includes("capacity exhausted")) immediate = "capacity";
				return "unavailable";
			}
		);
		await Promise.resolve();
		if (immediate === "capacity") {
			refused = true;
			await observed;
			break;
		}
		attempts.push(observed);
	}
	expect(refused).toBe(true);
	expect(attempts.length).toBeGreaterThan(0);
	expect(attempts.length).toBeLessThan(32);
	await expect.poll(() => entered).toBe(1);
	const close = f.recipientPort.close();
	await Promise.all(attempts);
	gate.resolve();
	releases.delete(gate.resolve);
	await close;
	expect(entered).toBe(1);
}, 20_000);

it("native creator selection refuses fabricated provenance gossip and foreign response before approval", async () => {
	const f = await fixture();
	const authorizer = vi.fn<NodeRoomSettlementSourceAuthorizer>(() =>
		Promise.reject(new TypeError("explicit creator policy refused"))
	);
	f.creatorPort.setSettlementSourceAuthorizer(authorizer);
	const controlId = f.creator.networkNode
		.getSubscribedTopics()
		.find((topic) => topic.startsWith("/ts-drp/room-history/1/"));
	if (controlId === undefined) throw new Error("missing actual room control identity");
	const request = proposal(),
		requestId = "a".repeat(32);
	const data = concatBytes(REQUEST, encodeCanonical({ ...request, requestId }));
	await expect(
		f.creator.dispatchMessage(
			Message.create({
				type: MessageType.MESSAGE_TYPE_CUSTOM,
				objectId: controlId,
				sender: f.recipient.networkNode.peerId,
				data,
			})
		)
	).rejects.toMatchObject({ code: "MESSAGE_RAW_PROVENANCE_REQUIRED" });
	expect(authorizer).not.toHaveBeenCalled();
	let gossipReached = false;
	const actualClaim = genuine(f.creator).claimIngressEvidence.bind(genuine(f.creator));
	vi.spyOn(genuine(f.creator), "claimIngressEvidence").mockImplementation((message) => {
		const evidence = actualClaim(message);
		if (message.objectId === controlId && evidence?.transport.kind === "signed-gossip") gossipReached = true;
		return evidence;
	});
	await genuine(f.recipient).publishMessage(
		controlId,
		Message.create({ type: MessageType.MESSAGE_TYPE_CUSTOM, objectId: controlId, data })
	);
	await expect.poll(() => gossipReached, { timeout: 5_000 }).toBe(true);
	expect(authorizer).not.toHaveBeenCalled();
	await expect(f.recipientPort.requestSettlementSourceAuthorization(request)).rejects.toThrow("refused");
	expect(authorizer).toHaveBeenCalledTimes(1);
	expect(authorizer.mock.calls[0]?.[0]).toMatchObject({
		digest: request.digest,
		exactCanonicalSelectionBytes: request.exactCanonicalSelectionBytes,
		authenticatedRequesterPeerId: f.recipient.networkNode.peerId,
	});
	// A third actual peer cannot answer even an exact echoed request/digest.
	const foreign = await startNode();
	await foreign.networkNode.connect(f.recipient.networkNode.getMultiaddrs());
	const wire: Message[] = [];
	const originalSend = genuine(f.recipient).sendMessage.bind(genuine(f.recipient));
	vi.spyOn(genuine(f.recipient), "sendMessage").mockImplementation((...args) => {
		if (args[1].data.byteLength >= REQUEST.byteLength && REQUEST.every((byte, index) => args[1].data[index] === byte))
			wire.push(args[1]);
		return originalSend(...args);
	});
	// Close the real creator endpoint: only a forged foreign response can arrive.
	await f.creatorPort.close();
	const pending = f.recipientPort.requestSettlementSourceAuthorization(request, { signal: AbortSignal.timeout(500) });
	void pending.catch(() => undefined);
	await expect.poll(() => wire.length).toBe(1);
	const first = wire[0];
	if (first === undefined) throw new Error("missing genuine fresh request");
	const body = decodeCanonical(first.data.subarray(REQUEST.byteLength)) as { requestId: string; digest: Uint8Array };
	await foreign.networkNode.sendMessage(
		f.recipient.networkNode.peerId,
		Message.create({
			type: MessageType.MESSAGE_TYPE_CUSTOM,
			objectId: controlId,
			data: concatBytes(
				RESPONSE,
				encodeCanonical({ requestId: body.requestId, digest: body.digest, signature: new Uint8Array(64) })
			),
		})
	);
	await expect(pending).rejects.toThrow("approval unavailable");
	expect(authorizer).toHaveBeenCalledTimes(1);
}, 20_000);

it("native creator selection remote saturation is bounded unavailable and creator close joins cancellation", async () => {
	const f = await fixture(),
		gate = deferred();
	releases.add(gate.resolve);
	let entered = 0,
		cancelled = false;
	f.creatorPort.setSettlementSourceAuthorizer(async (request) => {
		entered++;
		request.signal.addEventListener(
			"abort",
			() => {
				cancelled = true;
			},
			{ once: true }
		);
		await gate.promise;
		throw new TypeError("explicit policy refused; no authority granted");
	});
	const signing = vi.spyOn(f.creator.keychain, "signWithLocalAuthor"),
		stopSigning = vi.spyOn(f.creator.keychain, "stop");
	const originalDispatch = f.creator.dispatchMessage.bind(f.creator);
	let admitted = 0,
		overflow = 0;
	vi.spyOn(f.creator, "dispatchMessage").mockImplementation(async (message) => {
		const selection =
			message.data.byteLength >= REQUEST.byteLength && REQUEST.every((byte, index) => message.data[index] === byte);
		try {
			await originalDispatch(message);
			if (selection) admitted++;
		} catch (error) {
			if (selection && error instanceof Error && error.message.includes("capacity exhausted")) overflow++;
			throw error;
		}
	});
	const attempts = Array.from({ length: 32 }, (_, index) =>
		f.recipientPort.requestSettlementSourceAuthorization(proposal(encodeCanonical({ fresh: index }))).then(
			() => "unexpected approval",
			() => "unavailable"
		)
	);
	await expect.poll(() => admitted, { timeout: 5_000 }).toBe(32);
	expect(entered).toBe(1);
	const other = await startNode();
	await other.networkNode.connect(f.creator.networkNode.getMultiaddrs());
	const otherPort = other.openRoomNetwork(f.objectId);
	ports.add(otherPort);
	await expect(
		otherPort.requestSettlementSourceAuthorization(proposal(), { signal: AbortSignal.timeout(500) })
	).rejects.toThrow("approval unavailable");
	expect(overflow).toBe(1);
	expect(admitted).toBe(32);
	expect(entered).toBe(1);
	expect(signing).not.toHaveBeenCalled();
	let joined = false;
	const stop = f.creator.stop().then(() => {
		joined = true;
	});
	expect(cancelled).toBe(true);
	await f.recipientPort.close();
	await Promise.all(attempts);
	expect(joined).toBe(false);
	expect(stopSigning).not.toHaveBeenCalled();
	gate.resolve();
	releases.delete(gate.resolve);
	await stop;
	expect(stopSigning).toHaveBeenCalledTimes(1);
	expect(signing).not.toHaveBeenCalled();
	expect(entered).toBe(1);
}, 20_000);

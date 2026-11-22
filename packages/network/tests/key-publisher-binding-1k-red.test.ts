/**
 * Phase 1k corrective RED: StrictSign verifies a supplied non-inline public key,
 * but gossipsub 16.0.4 does not bind that key to a SHA-256 `from` peer ID.
 * The production event boundary must therefore perform that binding before it
 * attributes and queues the message.
 */
import { generateKeyPair, generateKeyPairFromSeed, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import { type GossipSub, type GossipsubMessage, type SignedMessage, StrictSign } from "@libp2p/gossipsub";
import { RPC } from "@libp2p/gossipsub/message";
import { type PeerId, type PrivateKey } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { type DRPNetworkNodeConfig, Message, MessageType } from "@ts-drp/types";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import {
	SignPrefix,
	validateToRawMessage,
} from "../../../node_modules/.pnpm/@libp2p+gossipsub@16.0.4/node_modules/@libp2p/gossipsub/dist/src/utils/buildRawMessage.js";
import { type DRPNetworkHostFactory, DRPNetworkNode } from "../src/node.js";

const config: DRPNetworkNodeConfig = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" },
};

const topic = "phase-1k-key-publisher-binding";
let sequenceNumber = BigInt(0);
let rsaSigner: PrivateKey;
let rsaSignerId: PeerId;
let rsaGhostId: PeerId;
let inlineSigner: PrivateKey;
let inlineSignerId: PeerId;

function appMessage(objectId: string): Uint8Array {
	return Message.encode(
		Message.create({
			data: new TextEncoder().encode(objectId),
			objectId,
			sender: "untrusted-envelope-sender",
			type: MessageType.MESSAGE_TYPE_CUSTOM,
		})
	).finish();
}

function nextSeqno(): Uint8Array {
	const seqno = new Uint8Array(8);
	new DataView(seqno.buffer).setBigUint64(0, ++sequenceNumber, false);
	return seqno;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
	const result = new Uint8Array(left.length + right.length);
	result.set(left);
	result.set(right, left.length);
	return result;
}

async function signedRawMessage(signer: PrivateKey, from: PeerId, objectId: string): Promise<RPC.Message> {
	const unsigned: RPC.Message = {
		from: from.toMultihash().bytes,
		data: appMessage(objectId),
		seqno: nextSeqno(),
		topic,
	};
	return {
		...unsigned,
		key: publicKeyToProtobuf(signer.publicKey),
		signature: await signer.sign(concat(SignPrefix, RPC.Message.encode(unsigned))),
	};
}

async function validatedMessage(signer: PrivateKey, from: PeerId, objectId: string): Promise<SignedMessage> {
	const result = await validateToRawMessage(StrictSign, await signedRawMessage(signer, from, objectId));
	expect(result.valid).toBe(true);
	if (!result.valid) throw new Error(`StrictSign rejected ${objectId}: ${result.error}`);
	if (result.message.type !== "signed") throw new Error(`StrictSign returned unsigned ${objectId}`);
	return result.message;
}

async function makeStartedReceiver(): Promise<{ node: DRPNetworkNode; pubsub: GossipSub }> {
	let capturedPubsub: GossipSub | undefined;
	const hostFactory: DRPNetworkHostFactory = async ({ createHost }) => {
		const host = await createHost();
		capturedPubsub = host.services.pubsub as GossipSub;
		return host;
	};
	const node = new DRPNetworkNode(config, {
		hostFactory,
		hostPolicy: {
			bootstrapDiscovery: false,
			coldStartPubsubDiscovery: false,
			gossipSubPeerExchange: false,
		},
	});
	await node.start();
	if (capturedPubsub === undefined) throw new Error("production host did not expose its gossipsub service");
	return { node, pubsub: capturedPubsub };
}

function dispatchValidated(pubsub: GossipSub, message: SignedMessage, propagationSource: PeerId): void {
	pubsub.dispatchEvent(
		new CustomEvent<GossipsubMessage>("gossipsub:message", {
			detail: {
				msg: message,
				msgId: `phase-1k-${message.sequenceNumber}`,
				propagationSource,
			},
		})
	);
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

describe("Phase 1k non-inline gossipsub key/publisher binding", () => {
	const running: DRPNetworkNode[] = [];

	beforeAll(async () => {
		rsaSigner = await generateKeyPair("RSA", 2048);
		rsaSignerId = peerIdFromPublicKey(rsaSigner.publicKey);
		rsaGhostId = peerIdFromPublicKey((await generateKeyPair("RSA", 2048)).publicKey);
		inlineSigner = await generateKeyPairFromSeed("Ed25519", new Uint8Array(32).fill(0x1a));
		inlineSignerId = peerIdFromPublicKey(inlineSigner.publicKey);
	});

	afterEach(async () => {
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
	});

	test("drops a StrictSign-admitted RSA message whose key does not derive its non-inline from ID", async () => {
		const { node, pubsub } = await makeStartedReceiver();
		running.push(node);
		const received: Message[] = [];
		node.subscribeToMessageQueue((message) => {
			received.push(message);
		});

		// The first result proves the installed validator admits the mismatch. The
		// matched sentinel proves the same production event/queue path has drained.
		const mismatch = await validatedMessage(rsaSigner, rsaGhostId, "phase-1k-rsa-ghost");
		const sentinel = await validatedMessage(rsaSigner, rsaSignerId, "phase-1k-rsa-sentinel");
		dispatchValidated(pubsub, mismatch, rsaSignerId);
		dispatchValidated(pubsub, sentinel, rsaSignerId);
		await waitFor(
			() => received.some(({ objectId }) => objectId === "phase-1k-rsa-sentinel"),
			"the matched RSA sentinel"
		);

		expect(received.map(({ objectId, sender }) => [objectId, sender])).toEqual([
			["phase-1k-rsa-sentinel", rsaSignerId.toString()],
		]);
	});

	test("accepts and attributes a matched non-inline RSA key/from pair", async () => {
		const { node, pubsub } = await makeStartedReceiver();
		running.push(node);
		const received: Message[] = [];
		node.subscribeToMessageQueue((message) => {
			received.push(message);
		});

		const matched = await validatedMessage(rsaSigner, rsaSignerId, "phase-1k-rsa-matched");
		dispatchValidated(pubsub, matched, rsaSignerId);
		await waitFor(() => received.length === 1, "the matched RSA message");

		expect(received.map(({ objectId, sender }) => [objectId, sender])).toEqual([
			["phase-1k-rsa-matched", rsaSignerId.toString()],
		]);
	});

	test("retains the matched inline Ed25519 StrictSign path", async () => {
		const { node, pubsub } = await makeStartedReceiver();
		running.push(node);
		const received: Message[] = [];
		node.subscribeToMessageQueue((message) => {
			received.push(message);
		});

		const matched = await validatedMessage(inlineSigner, inlineSignerId, "phase-1k-ed25519-matched");
		dispatchValidated(pubsub, matched, inlineSignerId);
		await waitFor(() => received.length === 1, "the matched Ed25519 message");

		expect(received.map(({ objectId, sender }) => [objectId, sender])).toEqual([
			["phase-1k-ed25519-matched", inlineSignerId.toString()],
		]);
	});
});

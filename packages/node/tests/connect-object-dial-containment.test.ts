import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	type AddressFilteredDrpRecord,
	RecordSigner,
	type RendezvousBootstrapSelection,
	type RendezvousEnsemble,
	roomNamespace,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import type { DRPNetworkNode, DRPNodeConfig } from "@ts-drp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

const NAMESPACE = `drp-network:v1:${"d".repeat(43)}`;

describe("_connectObjectCreator per-dial containment", () => {
	const nodes: DRPNode[] = [];
	let unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown): void => {
		unhandledRejections.push(reason);
	};

	beforeEach(() => {
		unhandledRejections = [];
		process.on("unhandledRejection", onUnhandledRejection);
	});

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
		await flushMicrotasks();
		process.off("unhandledRejection", onUnhandledRejection);
		expect(unhandledRejections).toEqual([]);
		vi.restoreAllMocks();
	});

	it("continues targeted creator dialing after the first address set rejects", async () => {
		const now = Date.now();
		const first = await signedRecord(1, now, NAMESPACE, 4901);
		const second = await signedRecord(1, now + 1, NAMESPACE, 4902, 2);
		const id = `${first.peerId}:targeted-containment`;
		const fixture = await startedNode(directory(new Map([[NAMESPACE, [filtered(first), filtered(second)]]])));
		nodes.push(fixture.node);
		fixture.connect.mockRejectedValueOnce(new Error("first targeted dial failed")).mockResolvedValueOnce(undefined);

		await fixture.node["_connectObjectCreator"](id);

		expect(fixture.connect).toHaveBeenCalledTimes(2);
		expect(fixture.connect).toHaveBeenNthCalledWith(1, [...first.addresses]);
		expect(fixture.connect).toHaveBeenNthCalledWith(2, [...second.addresses]);
	});

	it("continues room fallback dialing after the first replica rejects", async () => {
		const now = Date.now();
		const id = "room-fallback-containment";
		const namespace = roomNamespace(id);
		const first = await signedRecord(2, now, namespace, 4903);
		const second = await signedRecord(3, now, namespace, 4904);
		const fixture = await startedNode(directory(new Map([[namespace, [filtered(first), filtered(second)]]])));
		nodes.push(fixture.node);
		fixture.connect.mockRejectedValueOnce(new Error("first room dial failed")).mockResolvedValueOnce(undefined);

		await fixture.node["_connectObjectCreator"](id);

		expect(fixture.connect).toHaveBeenCalledTimes(2);
		expect(fixture.connect).toHaveBeenNthCalledWith(1, [...first.addresses]);
		expect(fixture.connect).toHaveBeenNthCalledWith(2, [...second.addresses]);
	});
});

function directory(records: ReadonlyMap<string, readonly AddressFilteredDrpRecord[]>): RendezvousEnsemble {
	return {
		bootstrap: async function* (
			namespace: string,
			signal: AbortSignal,
			_selection?: RendezvousBootstrapSelection
		): AsyncIterable<AddressFilteredDrpRecord> {
			await Promise.resolve();
			for (const record of records.get(namespace) ?? []) {
				signal.throwIfAborted();
				yield record;
			}
		},
		discover: (): Promise<readonly []> => Promise.resolve([]),
		lastTrace: undefined,
		register: (
			record
		): Promise<{
			readonly acceptedEndpointIds: readonly string[];
			readonly attempts: readonly [];
			readonly sequence: number;
		}> =>
			Promise.resolve({
				acceptedEndpointIds: ["dial-containment"],
				attempts: [],
				sequence: record.sequence,
			}),
	};
}

async function startedNode(rendezvous: RendezvousEnsemble): Promise<{
	readonly connect: ReturnType<typeof vi.fn>;
	readonly node: DRPNode;
}> {
	const connect = vi.fn((): Promise<void> => Promise.resolve());
	const node = new DRPNode(nodeConfig(), { networkNode: fakeNetwork(connect), reconnect: false });
	await node.start();
	node["_rendezvous"] = rendezvous;
	return { connect, node };
}

function nodeConfig(): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: "dial-containment" },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				rendezvous: {
					namespace: NAMESPACE,
					publish: false,
				},
			},
		},
	} as DRPNodeConfig;
}

function fakeNetwork(connect: ReturnType<typeof vi.fn>): DRPNetworkNode {
	return {
		broadcastMessage: vi.fn((): Promise<void> => Promise.resolve()),
		changeTopicScoreParams: vi.fn(),
		connect,
		connectToBootstraps: vi.fn((): Promise<void> => Promise.resolve()),
		disconnect: vi.fn((): Promise<void> => Promise.resolve()),
		getAllPeers: vi.fn((): string[] => []),
		getBootstrapNodes: vi.fn((): string[] => []),
		getGroupPeers: vi.fn((): string[] => []),
		getMultiaddrs: vi.fn((): string[] => []),
		getPeerMultiaddrs: vi.fn((_peerId: PeerId | string): Promise<Address[]> => Promise.resolve([])),
		getSubscribedTopics: vi.fn((): string[] => []),
		isDialable: vi.fn((): Promise<boolean> => Promise.resolve(false)),
		membershipVerifier: undefined,
		peerId: "dial-containment-reader",
		removeTopicScoreParams: vi.fn(),
		restart: vi.fn((): Promise<void> => Promise.resolve()),
		sendGroupMessageRandomPeer: vi.fn((): Promise<void> => Promise.resolve()),
		sendMessage: vi.fn((): Promise<void> => Promise.resolve()),
		start: vi.fn((): Promise<void> => Promise.resolve()),
		stop: vi.fn((): Promise<void> => Promise.resolve()),
		subscribe: vi.fn(),
		subscribeToGroupPeerChanges: vi.fn((): (() => void) => (): void => undefined),
		subscribeToMessageQueue: vi.fn(),
		unsubscribe: vi.fn(),
	} satisfies DRPNetworkNode;
}

async function signedRecord(
	index: number,
	now: number,
	namespace: string,
	port: number,
	sequence = 1
): Promise<SignedDrpRecordV1> {
	const key = await generateKeyPairFromSeed(
		"Ed25519",
		Uint8Array.from({ length: 32 }, (_, offset) => (index * 29 + offset * 7) % 256)
	);
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	return new RecordSigner(key).sign({
		addresses: [`/ip4/93.184.216.34/tcp/${port}/p2p/${peerId}`],
		capabilities: ["drp-gossipsub"],
		expiresAtMs: now + 60_000,
		issuedAtMs: now,
		namespace,
		sequence,
	});
}

function filtered(record: SignedDrpRecordV1): AddressFilteredDrpRecord {
	return {
		acceptedAddresses: record.addresses,
		admissionMode: "open",
		record,
		sourceEndpointId: "dial-containment",
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

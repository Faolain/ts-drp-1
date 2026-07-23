import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { DEFAULT_RECORD_LIMITS, RecordValidator, type SignedDrpRecordV1 } from "@ts-drp/rendezvous";
import type { DRPNetworkNode, DRPNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

const NAMESPACE = `drp-network:v1:${"p".repeat(43)}`;
const RELAY_PEER_ID = "16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK";

afterEach((): void => {
	vi.unstubAllGlobals();
});

describe("DRPNode rendezvous publishing RED contracts", () => {
	it("bounds published addresses while retaining circuit and WebRTC reachability", async () => {
		const networkNode = createFakeNetwork();
		const producedRecords: SignedDrpRecordV1[] = [];
		const node = new DRPNode(rendezvousConfig(NAMESPACE), { networkNode, reconnect: false });
		node["_registerRendezvousRecord"] = async (producer): Promise<boolean> => {
			producedRecords.push(await producer.refresh());
			return false;
		};
		stubEmptyRegistries();

		try {
			await node.start();
			await vi.waitFor((): void => expect(producedRecords).toHaveLength(1));
			const record = producedRecords[0];
			if (record === undefined) throw new Error("record producer fixture did not run");

			expect.soft(record.addresses.length).toBeLessThanOrEqual(DEFAULT_RECORD_LIMITS.maxAddresses);
			expect.soft(record.addresses.some((address) => address.includes("/webrtc"))).toBe(true);
			expect
				.soft(record.addresses.some((address) => address.includes("/p2p-circuit") && !address.includes("/webrtc")))
				.toBe(true);
			expect.soft(record.addresses.every((address) => address.includes("/p2p-circuit"))).toBe(true);

			const validation = await new RecordValidator({
				addressPolicyOptions: { allowLoopback: true },
				resolver: { resolve: (): Promise<string[]> => Promise.resolve(["127.0.0.1"]) },
			}).validate(record, {
				admission: { accepted: true, mode: "open" },
				expectedNamespace: NAMESPACE,
				signal: new AbortController().signal,
			});
			expect(validation).toMatchObject({ accepted: true });
		} finally {
			await node.stop();
		}
	});

	it("rejects an invalid configured rendezvous namespace during start", async () => {
		const node = new DRPNode(rendezvousConfig("drp-network:v1:tooshort"), {
			networkNode: createFakeNetwork(),
			reconnect: false,
		});
		stubEmptyRegistries();

		try {
			await expect(node.start()).rejects.toThrow(/control_plane\.rendezvous\.namespace|22\.\.86|base64url/iu);
		} finally {
			await node.stop();
		}
	});
});

function rendezvousConfig(namespace: string): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: "rendezvous-publishing-red" },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				rollout: { public_components: { public_rendezvous: { enabled: true } } },
				rendezvous: {
					allow_insecure_loopback_fixture: true,
					endpoints: ["http://127.0.0.1:1/first", "http://127.0.0.1:2/second"],
					namespace,
					publish: true,
					record_ttl_ms: 60_000,
					refresh_interval_ms: 1_000,
				},
			},
		},
	} as unknown as DRPNodeConfig;
}

function createFakeNetwork(): DRPNetworkNode {
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start: vi.fn((rawPrivateKey?: Uint8Array): Promise<void> => {
			if (rawPrivateKey === undefined) return Promise.reject(new Error("fixture identity key is required"));
			networkNode.peerId = peerIdFromPublicKey(privateKeyFromRaw(rawPrivateKey).publicKey).toString();
			return Promise.resolve();
		}),
		stop: vi.fn((): Promise<void> => Promise.resolve()),
		restart: vi.fn((): Promise<void> => Promise.resolve()),
		isDialable: vi.fn((): Promise<boolean> => Promise.resolve(false)),
		changeTopicScoreParams: vi.fn((): void => undefined),
		removeTopicScoreParams: vi.fn((): void => undefined),
		subscribe: vi.fn((): void => undefined),
		unsubscribe: vi.fn((): void => undefined),
		connectToBootstraps: vi.fn((): Promise<void> => Promise.resolve()),
		connect: vi.fn((): Promise<void> => Promise.resolve()),
		disconnect: vi.fn((): Promise<void> => Promise.resolve()),
		getPeerMultiaddrs: vi.fn((_peerId: PeerId | string): Promise<Address[]> => Promise.resolve([])),
		getBootstrapNodes: vi.fn((): string[] => []),
		getSubscribedTopics: vi.fn((): string[] => []),
		getMultiaddrs: vi.fn((): string[] => publishedAddresses(networkNode.peerId)),
		getAllPeers: vi.fn((): string[] => []),
		getGroupPeers: vi.fn((): string[] => []),
		broadcastMessage: vi.fn((): Promise<void> => Promise.resolve()),
		sendMessage: vi.fn((): Promise<void> => Promise.resolve()),
		sendGroupMessageRandomPeer: vi.fn((): Promise<void> => Promise.resolve()),
		subscribeToMessageQueue: vi.fn((): void => undefined),
		subscribeToGroupPeerChanges: vi.fn((): (() => void) => (): void => undefined),
	} satisfies DRPNetworkNode;
	return networkNode;
}

function publishedAddresses(peerId: string): string[] {
	const relayBases = Array.from(
		{ length: DEFAULT_RECORD_LIMITS.maxAddresses },
		(_, index) => `/ip4/127.0.0.1/tcp/${4100 + index}/p2p/${RELAY_PEER_ID}`
	);
	const plainCircuitAddresses = relayBases.map((relay) => `${relay}/p2p-circuit/p2p/${peerId}`);
	const webrtcAddresses = relayBases.map((relay) => `${relay}/p2p-circuit/webrtc/p2p/${peerId}`);
	return [...plainCircuitAddresses, ...webrtcAddresses];
}

function stubEmptyRegistries(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(
				new Response(JSON.stringify({ endpointId: "empty-registry", records: [] }), {
					headers: { "content-type": "application/json" },
					status: 200,
				})
			)
		)
	);
}

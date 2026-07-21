import type { DRPNetworkHostFactory } from "@ts-drp/network";
import { DRPNetworkNode } from "@ts-drp/network";
import { DRPNode } from "@ts-drp/node";
import {
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	Libp2pRelayClient,
	type RelayCandidate,
	RelayPolicy,
	type RelayPolicyResult,
} from "@ts-drp/relay-policy";
import { attachNodeRouting, createAminoHostExtensions, createNodeRouting } from "@ts-drp/routing-node";
import { ActionType, type IDRP, type ResolveConflictsType, SemanticsType, type Vertex } from "@ts-drp/types";
import type { Libp2p } from "libp2p";
import { describe, expect, it } from "vitest";

import {
	PublicOnlyNodePublisher,
	type PublicOnlyNodePublisherError,
	type PublicOnlyNodePublisherOptions,
} from "../src/public-only/node.js";

const SELF = "12D3KooWPublisherIdentity";
const CIRCUIT = `/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelay/p2p-circuit/p2p/${SELF}`;

describe("PublicOnlyNodePublisher", () => {
	it("enforces one identity and the fixed relay-before-grid-before-provide order", async () => {
		const events: string[] = [];
		const publisher = new PublicOnlyNodePublisher(options(events));
		const result = await publisher.start("opaque-public-room", "opaque-public-grid", AbortSignal.timeout(2_000));
		expect(result.peerId).toBe(SELF);
		expect(result.circuitAddress).toBe(CIRCUIT);
		expect(result.milestones).toEqual([
			"drp-started",
			"amino-attached",
			"routing-table-ready",
			"relay-reserved",
			"circuit-address-ready",
			"grid-created",
			"provider-published",
			"provider-independently-visible",
		]);
		expect(events.slice(0, 8)).toEqual([
			"node:start",
			"routing:attach",
			"routing:ready",
			"relay:reserve",
			"node:grid:opaque-public-grid",
			"routing:provide",
			"lookup",
			"lookup:yield",
		]);
		await publisher.stop();
		expect(events).toEqual(expect.arrayContaining(["routing:cancel", "relay:stop", "node:stop"]));
	});

	it("fails closed when the routing adapter belongs to a helper identity", async () => {
		const events: string[] = [];
		const base = options(events);
		const publisher = new PublicOnlyNodePublisher({
			...base,
			attachRouting: async (): ReturnType<PublicOnlyNodePublisherOptions["attachRouting"]> => ({
				...(await base.attachRouting()),
				peerId: "helper-peer",
			}),
		});
		await expect(
			publisher.start("opaque-public-room", "opaque-public-grid", AbortSignal.timeout(2_000))
		).rejects.toEqual(
			expect.objectContaining<Partial<PublicOnlyNodePublisherError>>({ terminal: "identity-mismatch" })
		);
		expect(events).not.toContain("relay:reserve");
		expect(events).toContain("node:stop");
	});

	it("returns a no-go and cleans up when independent routing omits the circuit address", async () => {
		const events: string[] = [];
		const base = options(events);
		const publisher = new PublicOnlyNodePublisher({
			...base,
			lookupProviders: async function* (): AsyncGenerator<{ addresses: string[]; peerId: string }> {
				await Promise.resolve();
				yield { addresses: ["/ip4/203.0.113.1/tcp/4001"], peerId: SELF };
			},
		});
		await expect(
			publisher.start("opaque-public-room", "opaque-public-grid", AbortSignal.timeout(2_000))
		).rejects.toEqual(
			expect.objectContaining<Partial<PublicOnlyNodePublisherError>>({ terminal: "provider-address-omitted" })
		);
		expect(events).toEqual(expect.arrayContaining(["routing:provide", "routing:cancel", "relay:stop", "node:stop"]));
	});
});

it("proves one real DRP identity owns local Amino publication, a real relay listener, and the grid", async () => {
	const dhtServer = await createNodeRouting({ allowInsecureWebSocketFixture: true, mode: "server", network: "local" });
	const relayNode = new DRPNode({
		keychain_config: { private_key_seed: "public-only-publisher-relay" },
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			relay_service: { enabled: true },
			seed: true,
		},
	});
	let host: Libp2p | undefined;
	const hostFactory: DRPNetworkHostFactory = async (context) => {
		host = await context.createHost(createAminoHostExtensions({ network: "local" }));
		return host;
	};
	const networkConfig = {
		bootstrap_peers: [],
		listen_addresses: ["/ip4/127.0.0.1/tcp/0"],
		log_config: { level: "silent" as const },
	};
	const network = new DRPNetworkNode(networkConfig, { hostFactory });
	const drp = new DRPNode(
		{ log_config: { level: "silent" }, network_config: networkConfig },
		{ networkNode: network, reconnect: false }
	);
	let relayClient: Libp2pRelayClient | undefined;
	let relayPolicy: RelayPolicy | undefined;
	const providerObservations: Array<{ addresses: readonly string[]; peerId: string }> = [];
	await relayNode.start();
	try {
		const relayNetwork = relayNode.networkNode;
		if (relayNetwork === undefined) throw new Error("relay network missing after start");
		const serverStatus = await dhtServer.status(AbortSignal.timeout(3_000));
		const serverAddress = serverStatus.addresses.find(({ decision }) => decision.dialable)?.address;
		const relayAddress = (relayNetwork.getMultiaddrs?.() ?? []).find((address) => address.includes("/ws"));
		if (serverAddress === undefined || relayAddress === undefined) throw new Error("local topology address missing");
		const relayPeerId = relayNetwork.peerId;
		const completeRelayAddress = relayAddress.includes("/p2p/") ? relayAddress : `${relayAddress}/p2p/${relayPeerId}`;
		const publisher = new PublicOnlyNodePublisher({
			attachRouting: async (): ReturnType<PublicOnlyNodePublisherOptions["attachRouting"]> => {
				if (host === undefined) throw new Error("publisher host missing");
				const routing = await attachNodeRouting(network, host, {
					allowInsecureWebSocketFixture: true,
					network: "local",
				});
				await routing.connect(
					serverAddress.includes("/p2p/") ? serverAddress : `${serverAddress}/p2p/${dhtServer.peerId}`,
					AbortSignal.timeout(3_000)
				);
				return routing;
			},
			getCircuitAddresses: (): readonly string[] => network.getMultiaddrs(),
			lookupProviders: async function* (cid, signal): ReturnType<PublicOnlyNodePublisherOptions["lookupProviders"]> {
				for await (const provider of dhtServer.findProviders(cid, signal)) {
					providerObservations.push(provider);
					yield provider;
				}
			},
			node: {
				createGrid: async (objectId): Promise<void> => {
					await drp.createObject({ drp: new PublisherGrid(), id: objectId });
				},
				get peerId(): string {
					return network.peerId;
				},
				start: (): Promise<void> => drp.start(),
				stop: (): Promise<void> => drp.stop(),
			},
			reserveRelay: async (queryKey, signal): ReturnType<PublicOnlyNodePublisherOptions["reserveRelay"]> => {
				if (host === undefined) throw new Error("publisher host missing");
				relayClient = new Libp2pRelayClient({
					connect: (address): Promise<void> => network.connect(address),
					disconnect: (peerId): Promise<void> => network.disconnect(peerId),
					host: host as never,
				});
				const candidate = localRelayCandidate(relayPeerId, completeRelayAddress);
				relayPolicy = new RelayPolicy({
					allowInsecureWebSocketFixture: true,
					fallback: { acquire: (): Promise<{ status: "empty" }> => Promise.resolve({ status: "empty" }) },
					inspector: relayClient,
					limits: {
						maxCandidates: 1,
						maxConcurrentReservations: 1,
						maxPerOperatorGroup: 1,
						maxQueuedCandidates: 1,
						perCandidateDeadlineMs: 3_000,
						requiredOperatorGroups: 1,
						requiredReservations: 1,
						totalDeadlineMs: 4_000,
					},
					reservationClient: relayClient,
					source: {
						async *getCandidates(): AsyncGenerator<RelayCandidate> {
							await Promise.resolve();
							yield candidate;
						},
					},
				});
				return relayPolicy.acquire(queryKey, signal);
			},
			stopRelay: async (): Promise<void> => {
				await Promise.allSettled([relayPolicy?.stop(), relayClient?.stop()]);
			},
		});
		const result = await publisher.start(
			"local-public-only-room",
			"local-public-only-grid",
			AbortSignal.timeout(12_000)
		);
		expect(result.peerId).toBe(network.peerId);
		expect(result.circuitAddress).toContain(`/p2p/${relayPeerId}/p2p-circuit`);
		expect(result.relay.reservations).toHaveLength(1);
		expect(providerObservations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					addresses: expect.arrayContaining([result.circuitAddress]),
					peerId: network.peerId,
				}),
			])
		);
		await publisher.stop();
	} finally {
		await Promise.allSettled([drp.stop(), relayNode.stop(), dhtServer.stop(), relayClient?.stop()]);
	}
}, 20_000);

function options(events: string[]): PublicOnlyNodePublisherOptions {
	return {
		attachRouting: (): ReturnType<PublicOnlyNodePublisherOptions["attachRouting"]> => {
			events.push("routing:attach");
			return Promise.resolve({
				cancelReprovide: (): Promise<void> => {
					events.push("routing:cancel");
					return Promise.resolve();
				},
				peerId: SELF,
				provide: (cid) => {
					events.push("routing:provide");
					return Promise.resolve({ cid: cid.toString() });
				},
				waitForRoutingTable: (): Promise<void> => {
					events.push("routing:ready");
					return Promise.resolve();
				},
			});
		},
		getCircuitAddresses: () => [CIRCUIT],
		lookupProviders: async function* (): AsyncGenerator<{ addresses: string[]; peerId: string }> {
			await Promise.resolve();
			events.push("lookup");
			events.push("lookup:yield");
			yield { addresses: [CIRCUIT], peerId: SELF };
		},
		node: {
			createGrid: (objectId): Promise<void> => {
				events.push(`node:grid:${objectId}`);
				return Promise.resolve();
			},
			peerId: SELF,
			start: (): Promise<void> => {
				events.push("node:start");
				return Promise.resolve();
			},
			stop: (): Promise<void> => {
				events.push("node:stop");
				return Promise.resolve();
			},
		},
		reserveRelay: (): Promise<RelayPolicyResult> => {
			events.push("relay:reserve");
			return Promise.resolve({
				attempts: [],
				candidatesObserved: 1,
				durationMs: 1,
				operatorGroups: ["fixture"],
				reservations: [{}],
				terminal: "reserved",
			} as unknown as RelayPolicyResult);
		},
		stopRelay: (): Promise<void> => {
			events.push("relay:stop");
			return Promise.resolve();
		},
	};
}

function localRelayCandidate(peerId: string, address: string): RelayCandidate {
	return {
		addresses: [address],
		operatorGroup: "local-real-relay",
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		provenance: {
			origin: "node-closest-peers",
			queryDigest: "local-fixture",
			resultIndex: 0,
			routingSource: "public-dht",
		},
	};
}

class PublisherGrid implements IDRP {
	semanticsType = SemanticsType.pair;

	resolveConflicts(_vertices: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

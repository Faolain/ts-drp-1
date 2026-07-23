import {
	AdmissionPolicy,
	RecordValidator,
	type RegistryDiscoveryReceipt,
	RegistryServer,
	type SignedDrpRecordV1,
	type ValidatedDrpRecord,
} from "@ts-drp/rendezvous";
import type { ControlPlaneEvent, DRPNodeConfig } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

interface RegistryHttpService {
	readonly url: string;
	close(): Promise<void>;
}

interface RegistryServiceModule {
	createRegistryHttpService(options: {
		readonly host?: string;
		readonly port?: number;
		readonly server: Pick<RegistryServer, "discover" | "register">;
	}): Promise<RegistryHttpService> | RegistryHttpService;
}

interface NodeRendezvous {
	discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
}

type RendezvousNode = DRPNode & { readonly rendezvous: NodeRendezvous | undefined };

const INVITE = "phase-four-node-fixture-token";
const NAMESPACE = `drp-network:v1:${"n".repeat(43)}`;

describe("Phase 4a DRPNode HTTP rendezvous integration", () => {
	it("publishes live records, refreshes through a partial outage, and exposes sanitized outcomes", async () => {
		const serviceModule = await loadServiceModule();
		if (serviceModule === undefined) return;
		const servers = [registryServer("registry-a"), registryServer("registry-b")] as const;
		const services: RegistryHttpService[] = [];
		const nodes: RendezvousNode[] = [];
		try {
			for (const server of servers) {
				services.push(await serviceModule.createRegistryHttpService({ host: "127.0.0.1", port: 0, server }));
			}
			const events: ControlPlaneEvent[] = [];
			const publisher = new DRPNode(nodeConfig("publisher", services, events, true)) as RendezvousNode;
			nodes.push(publisher);
			await publisher.start();
			expect(publisher.rendezvous, "DRPNode must expose its configured rendezvous ensemble").toBeDefined();

			const first = await waitForRecord(servers[0], publisher.networkNode.peerId, 4_000);
			const replica = await waitForRecord(servers[1], publisher.networkNode.peerId, 4_000);
			expect(replica.sequence).toBe(first.sequence);
			expect(new Set(first.capabilities)).toEqual(
				new Set(["drp-gossipsub", "webrtc", "relay-client", "relay-hop-v2-service"])
			);

			await services[0]?.close();
			services.shift();
			const refreshed = await waitForRecord(servers[1], publisher.networkNode.peerId, 4_000, first.sequence + 1);
			expect(refreshed.sequence).toBeGreaterThan(first.sequence);

			if (publisher.rendezvous === undefined) return;
			const discovered = await publisher.rendezvous.discover(NAMESPACE, AbortSignal.timeout(2_000));
			expect(discovered.map(({ record }) => record.peerId)).toContain(publisher.networkNode.peerId);

			await vi.waitFor(
				() =>
					expect(events).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ kind: "rendezvous-registration", outcome: "accepted" }),
							expect.objectContaining({ kind: "rendezvous-registration", outcome: "partial" }),
						])
					),
				{ timeout: 4_000 }
			);
			const serializedEvents = JSON.stringify(events);
			expect(serializedEvents).not.toContain(NAMESPACE);
			expect(serializedEvents).not.toContain(publisher.networkNode.peerId);
			for (const address of refreshed.addresses) expect(serializedEvents).not.toContain(address);
		} finally {
			await Promise.allSettled(nodes.reverse().map((node) => node.stop()));
			await Promise.allSettled(services.map((service) => service.close()));
		}
	}, 20_000);

	it("does not crash start on total registration failure and stops retrying after stop", async () => {
		const events: ControlPlaneEvent[] = [];
		const node = new DRPNode(
			nodeConfig("outage", [], events, true, [
				"http://127.0.0.1:1/closed-registry",
				"http://127.0.0.1:2/closed-registry",
			])
		);
		try {
			await expect(node.start()).resolves.toBeUndefined();
			await vi.waitFor(
				() =>
					expect(events).toEqual(
						expect.arrayContaining([expect.objectContaining({ kind: "rendezvous-registration", outcome: "failed" })])
					),
				{ timeout: 2_500 }
			);
		} finally {
			await node.stop();
		}
		const eventCountAfterStop = events.length;
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(events).toHaveLength(eventCountAfterStop);
	}, 8_000);
});

async function loadServiceModule(): Promise<RegistryServiceModule | undefined> {
	let loaded: Partial<RegistryServiceModule> = {};
	try {
		loaded = (await import(
			/* @vite-ignore */ new URL("../../rendezvous/src/service.ts", import.meta.url).href
		)) as Partial<RegistryServiceModule>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/service\.ts|load url|does the file exist/iu.test(message)) throw error;
	}
	expect(loaded.createRegistryHttpService, "the Node-only registry service export is missing").toBeTypeOf("function");
	return loaded.createRegistryHttpService === undefined ? undefined : (loaded as RegistryServiceModule);
}

function nodeConfig(
	seed: string,
	services: readonly RegistryHttpService[],
	events: ControlPlaneEvent[],
	publish: boolean,
	endpointOverride?: readonly string[]
): DRPNodeConfig {
	return {
		interval_reconnect_options: { interval: 60_000 },
		keychain_config: { private_key_seed: `phase-four-${seed}` },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				address_policy: {
					allowInsecureWebSocket: true,
					allowLoopback: true,
					target: "node",
				},
				membership: { invite: { inviteToken: INVITE }, mode: "invite" },
				observability: { sink: (event: ControlPlaneEvent): void => void events.push(event) },
				rollout: { public_components: { public_rendezvous: { enabled: true } } },
				rendezvous: {
					allow_insecure_loopback_fixture: true,
					endpoints: endpointOverride ?? services.map(({ url }) => url),
					namespace: NAMESPACE,
					publish,
					record_ttl_ms: 60_000,
					refresh_interval_ms: 1_000,
				},
			},
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws", "/webrtc"],
			log_config: { level: "silent" },
			relay_service: { enabled: true, max_reservations: 4 },
		},
	} as unknown as DRPNodeConfig;
}

function registryServer(endpointId: string): RegistryServer {
	return new RegistryServer({
		endpointId,
		limits: { maxRequestsPerNamespaceWindow: 1_000, maxRequestsPerWindow: 1_000 },
		policy: new AdmissionPolicy({ inviteToken: INVITE }),
		validator: new RecordValidator({
			addressPolicyOptions: { allowInsecureWebSocket: true, allowLoopback: true },
			resolver: { resolve: () => Promise.resolve(["127.0.0.1"]) },
		}),
	});
}

async function waitForRecord(
	server: RegistryServer,
	peerId: string,
	timeoutMs: number,
	minimumSequence = 0
): Promise<SignedDrpRecordV1> {
	let record: SignedDrpRecordV1 | undefined;
	await vi.waitFor(
		async () => {
			const result = await server.discover({
				clientId: `reader-${Math.random().toString(36).slice(2, 10)}`,
				namespace: NAMESPACE,
				signal: AbortSignal.timeout(250),
			});
			if (!("records" in result)) throw new Error(result.code);
			record = result.records.find((candidate) => candidate.record.peerId === peerId)?.record;
			expect(record?.sequence).toBeGreaterThanOrEqual(minimumSequence);
		},
		{ interval: 50, timeout: timeoutMs }
	);
	if (record === undefined) throw new Error("publisher record was not stored");
	return record;
}

type _DiscoveryReceipt = RegistryDiscoveryReceipt;
const _discoveryReceipt: _DiscoveryReceipt | undefined = undefined;
void _discoveryReceipt;

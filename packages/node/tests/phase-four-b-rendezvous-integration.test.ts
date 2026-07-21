import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import type { PrivateKey } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	AdmissionPolicy,
	RecordSigner,
	RecordValidator,
	type RegistryDiscoveryReceipt,
	RegistryServer,
	type SignedDrpRecordV1,
	type ValidatedDrpRecord,
} from "@ts-drp/rendezvous";
import type { ControlPlaneEvent, DRPNodeConfig } from "@ts-drp/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface PeerCacheLike {
	list(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
}

interface BootstrapRendezvous {
	bootstrap(namespace: string, signal: AbortSignal): AsyncIterable<ValidatedDrpRecord>;
	discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
}

type PhaseFourNode = DRPNode & {
	readonly rendezvous: BootstrapRendezvous | undefined;
	readonly rendezvousCache: PeerCacheLike | undefined;
};

interface InvitePayloadV1 {
	readonly contacts: readonly SignedDrpRecordV1[];
	readonly expiresAtMs: number;
	readonly issuedAtMs: number;
	readonly membershipCapability: string;
	readonly namespace: string;
	readonly registryEndpoints: readonly string[];
}

interface InviteModule {
	encodeInvite(payload: InvitePayloadV1, signer: Pick<PrivateKey, "publicKey" | "sign">): Promise<string>;
}

const INVITE_TOKEN = "phase-four-b-membership-token";
const NAMESPACE = `drp-network:v1:${"b".repeat(43)}`;

describe("Phase 4b DRPNode rendezvous restart integration", () => {
	it("warms a Node fs cache from a loopback registry and finds the publisher after registry loss and restart", async () => {
		const serviceModule = await loadServiceModule();
		if (serviceModule === undefined) return;
		const cacheDirectory = await mkdtemp(join(tmpdir(), "ts-drp-node-cache-"));
		const servers = [registryServer("registry-cache-restart-a"), registryServer("registry-cache-restart-b")] as const;
		const services: RegistryHttpService[] = [];
		const nodes: PhaseFourNode[] = [];
		try {
			for (const server of servers) {
				services.push(await serviceModule.createRegistryHttpService({ host: "127.0.0.1", port: 0, server }));
			}
			const publisher = new DRPNode(
				nodeConfig(
					"publisher",
					services.map(({ url }) => url),
					[],
					true
				)
			) as PhaseFourNode;
			nodes.push(publisher);
			await publisher.start();
			await waitForRecord(servers[0], publisher.networkNode.peerId, 5_000);

			const events: ControlPlaneEvent[] = [];
			const reader = new DRPNode(
				nodeConfig(
					"reader",
					services.map(({ url }) => url),
					events,
					false,
					{
						enabled: true,
						max: 16,
						path: join(cacheDirectory, "authenticated-peers.json"),
						persistence: "node-fs",
					}
				)
			) as PhaseFourNode;
			nodes.push(reader);
			await reader.start();
			expect(reader.rendezvousCache, "DRPNode must expose its configured peer cache").toBeDefined();
			await vi.waitFor(
				async () => {
					const records = await reader.rendezvousCache?.list(NAMESPACE, AbortSignal.timeout(250));
					expect(records?.map(({ record }) => record.peerId)).toContain(publisher.networkNode.peerId);
				},
				{ interval: 50, timeout: 5_000 }
			);

			await Promise.all(services.splice(0).map((service) => service.close()));
			await reader.restart();
			expect(await firstBootstrapRecord(reader)).toMatchObject({ record: { peerId: publisher.networkNode.peerId } });
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "rendezvous-cache", outcome: "write" }),
					expect.objectContaining({ kind: "rendezvous-cache", outcome: "hit" }),
				])
			);
			assertSanitized(events, publisher.networkNode.peerId);
		} finally {
			await Promise.allSettled(nodes.reverse().map((node) => node.stop()));
			await Promise.allSettled(services.map((service) => service.close()));
			await rm(cacheDirectory, { force: true, recursive: true });
		}
	}, 30_000);

	it("bootstraps from signed invite contacts while its configured registry is down", async () => {
		const inviteModule = await loadInviteModule();
		if (inviteModule === undefined) return;
		const now = Date.now();
		const contactKey = await generateKeyPairFromSeed("Ed25519", new Uint8Array(32).fill(81));
		const contactPeerId = peerIdFromPublicKey(contactKey.publicKey).toString();
		const contact = await new RecordSigner(contactKey).sign({
			addresses: [`/ip4/93.184.216.34/tcp/443/wss/p2p/${contactPeerId}`],
			capabilities: ["drp-gossipsub"],
			expiresAtMs: now + 60_000,
			issuedAtMs: now,
			namespace: NAMESPACE,
			sequence: 1,
		});
		const issuer = await generateKeyPairFromSeed("Ed25519", new Uint8Array(32).fill(82));
		const invite = await inviteModule.encodeInvite(
			{
				contacts: [contact],
				expiresAtMs: now + 120_000,
				issuedAtMs: now,
				membershipCapability: INVITE_TOKEN,
				namespace: NAMESPACE,
				registryEndpoints: ["https://registry-from-invite.example/v1"],
			},
			issuer
		);
		const events: ControlPlaneEvent[] = [];
		const fetchImpl = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetchImpl);
		const node = new DRPNode(
			nodeConfig(
				"invite-reader",
				["http://127.0.0.1:1/offline", "http://127.0.0.1:2/offline"],
				events,
				false,
				{
					enabled: true,
					max: 8,
					persistence: "memory",
				},
				invite,
				false
			)
		) as PhaseFourNode;
		try {
			await node.start();
			expect(await firstBootstrapRecord(node)).toMatchObject({ record: { peerId: contact.peerId } });
			expect(
				fetchImpl,
				"public registry rendezvous must remain off while signed invite fallback stays live"
			).not.toHaveBeenCalled();
			expect(events).toEqual(
				expect.arrayContaining([expect.objectContaining({ kind: "rendezvous-invite", outcome: "accepted" })])
			);
			assertSanitized(events, contact.peerId);
		} finally {
			await node.stop();
			vi.unstubAllGlobals();
		}
	}, 20_000);
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
	expect(loaded.createRegistryHttpService).toBeTypeOf("function");
	return loaded.createRegistryHttpService === undefined ? undefined : (loaded as RegistryServiceModule);
}

async function loadInviteModule(): Promise<InviteModule | undefined> {
	const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<InviteModule>;
	expect(loaded.encodeInvite, "Phase 4b must export encodeInvite for node invite wiring").toBeTypeOf("function");
	return loaded.encodeInvite === undefined ? undefined : (loaded as InviteModule);
}

function nodeConfig(
	seed: string,
	endpoints: readonly string[],
	events: ControlPlaneEvent[],
	publish: boolean,
	cache: Record<string, unknown> = { enabled: false, max: 16, persistence: "memory" },
	invite?: string,
	publicRendezvousEnabled = true
): DRPNodeConfig {
	return {
		interval_reconnect_options: { interval: 60_000 },
		keychain_config: { private_key_seed: `phase-four-b-${seed}` },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				address_policy: {
					allowInsecureWebSocket: true,
					allowLoopback: true,
					target: "node",
				},
				membership: { invite: { inviteToken: INVITE_TOKEN }, mode: "invite" },
				observability: { sink: (event: ControlPlaneEvent): void => void events.push(event) },
				rollout: {
					public_components: { public_rendezvous: { enabled: publicRendezvousEnabled } },
				},
				rendezvous: {
					allow_insecure_loopback_fixture: true,
					cache,
					endpoints,
					invite,
					namespace: NAMESPACE,
					publish,
					record_ttl_ms: 60_000,
					refresh_interval_ms: 1_000,
				},
			},
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws", "/webrtc"],
			log_config: { level: "silent" },
		},
	} as unknown as DRPNodeConfig;
}

function registryServer(endpointId: string): RegistryServer {
	return new RegistryServer({
		endpointId,
		limits: { maxRequestsPerNamespaceWindow: 1_000, maxRequestsPerWindow: 1_000 },
		policy: new AdmissionPolicy({ inviteToken: INVITE_TOKEN }),
		validator: new RecordValidator({
			addressPolicyOptions: { allowInsecureWebSocket: true, allowLoopback: true },
			resolver: { resolve: () => Promise.resolve(["127.0.0.1"]) },
		}),
	});
}

async function waitForRecord(server: RegistryServer, peerId: string, timeoutMs: number): Promise<void> {
	await vi.waitFor(
		async () => {
			const result = await server.discover({
				clientId: `reader-${Math.random().toString(36).slice(2, 10)}`,
				namespace: NAMESPACE,
				signal: AbortSignal.timeout(250),
			});
			if (!("records" in result)) throw new Error(result.code);
			expect(result.records.map(({ record }) => record.peerId)).toContain(peerId);
		},
		{ interval: 50, timeout: timeoutMs }
	);
}

async function firstBootstrapRecord(node: PhaseFourNode): Promise<ValidatedDrpRecord> {
	expect(node.rendezvous, "DRPNode must keep discover and add bootstrap on its rendezvous accessor").toBeDefined();
	if (node.rendezvous === undefined) throw new Error("rendezvous unavailable");
	const controller = new AbortController();
	const iterator = node.rendezvous.bootstrap(NAMESPACE, controller.signal)[Symbol.asyncIterator]();
	const first = await iterator.next();
	controller.abort(new Error("one integration result collected"));
	await iterator.return?.();
	if (first.done) throw new Error("bootstrap returned no contacts");
	return first.value;
}

function assertSanitized(events: readonly ControlPlaneEvent[], peerId: string): void {
	const serialized = JSON.stringify(events);
	expect(serialized).not.toContain(peerId);
	expect(serialized).not.toContain(NAMESPACE);
	expect(serialized).not.toContain("93.184.216.34");
	expect(serialized).not.toContain(INVITE_TOKEN);
}

type _DiscoveryReceipt = RegistryDiscoveryReceipt;
const _discoveryReceipt: _DiscoveryReceipt | undefined = undefined;
void _discoveryReceipt;

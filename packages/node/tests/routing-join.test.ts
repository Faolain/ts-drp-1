import type { ControlPlaneEvent, DRPNodeConfig } from "@ts-drp/types";
import { expect, it, vi } from "vitest";

import type { DRPNode } from "../src/index.js";

interface PhaseThreeConfig extends Omit<DRPNodeConfig, "network_config"> {
	readonly network_config: NonNullable<DRPNodeConfig["network_config"]> & {
		readonly control_plane: NonNullable<NonNullable<DRPNodeConfig["network_config"]>["control_plane"]> & {
			readonly routing: {
				readonly node: {
					readonly bootstrappers: readonly string[];
					readonly enabled: true;
					readonly network: "local";
				};
			};
		};
	};
}

interface RuntimeResult {
	node: DRPNode;
	routing: NodeRouting | undefined;
}

interface RoutingPeer {
	addresses: string[];
	addressDecisions: Array<{ dialable: boolean }>;
	peerId: string;
}

interface NodeRouting {
	readonly peerId: string;
	findProviders(cid: unknown, signal: AbortSignal): AsyncIterable<RoutingPeer>;
	provide(cid: unknown, signal: AbortSignal): Promise<unknown>;
	status(signal: AbortSignal): Promise<{
		addresses: Array<{ address: string; decision: { dialable: boolean } }>;
	}>;
	stop(): Promise<void>;
	waitForRoutingTable(minimumPeers: number, signal: AbortSignal): Promise<void>;
}

interface RoutingNodeModule {
	createNodeRouting(options: { mode: "server"; network: "local" }): Promise<NodeRouting>;
	namespaceCid(namespace: string): Promise<unknown>;
}

interface RuntimeModule {
	createNodeRuntime(config: DRPNodeConfig): Promise<RuntimeResult>;
}

it("feeds DHT providers through the address-policy dial path without treating membership as authorization", async () => {
	const { createNodeRuntime } = await loadRuntime();
	const { createNodeRouting, namespaceCid } = await loadNodeRouting();
	const server = await createNodeRouting({ mode: "server", network: "local" });
	const runtimes: RuntimeResult[] = [];
	try {
		const serverStatus = await server.status(AbortSignal.timeout(3_000));
		const serverAddress = serverStatus.addresses.find(({ decision }) => decision.dialable)?.address;
		if (serverAddress === undefined) throw new Error("local DHT server has no dialable address");
		const bootstrapper = withPeerId(serverAddress, server.peerId);

		const publisher = await createNodeRuntime(runtimeConfig("publisher", bootstrapper) as DRPNodeConfig);
		runtimes.push(publisher);
		const publisherRouting = requireRouting(publisher);
		await publisherRouting.waitForRoutingTable(1, AbortSignal.timeout(6_000));
		const cid = await namespaceCid("drp-network:v1:phase-three-routing-join");
		await publisherRouting.provide(cid, AbortSignal.timeout(4_000));

		for (const fixture of [
			{ membership: false, name: "plain-joiner" },
			{ membership: true, name: "membership-non-interference" },
		] as const) {
			const events: ControlPlaneEvent[] = [];
			const joiner = await createNodeRuntime(
				runtimeConfig(fixture.name, bootstrapper, events, fixture.membership) as DRPNodeConfig
			);
			runtimes.push(joiner);
			const joinerRouting = requireRouting(joiner);
			await joinerRouting.waitForRoutingTable(1, AbortSignal.timeout(6_000));
			expect(joiner.node.networkNode.getBootstrapNodes()).toEqual([bootstrapper]);
			expect(new Set(joiner.node.networkNode.getAllPeers())).toEqual(new Set([server.peerId]));
			events.length = 0;
			const providers = await collect(joinerRouting.findProviders(cid, AbortSignal.timeout(5_000)));
			const publisherCandidate = providers.find(({ peerId }) => peerId === publisher.node.networkNode.peerId);
			expect(publisherCandidate).toBeDefined();
			if (publisherCandidate === undefined) throw new Error("DHT did not return the publisher candidate");
			expect(publisherCandidate.addressDecisions.every(({ dialable }) => dialable)).toBe(true);

			const deniedCandidate = "/ip4/127.0.0.1/tcp/4100/ws/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
			const providerDialEventStart = events.length;
			await joiner.node.networkNode.connect([...publisherCandidate.addresses, deniedCandidate]);
			await vi.waitFor(
				() => expect(joiner.node.networkNode.getAllPeers()).toContain(publisher.node.networkNode.peerId),
				{ timeout: 4_000 }
			);
			const providerDialEvents = events.slice(providerDialEventStart);
			expect(providerDialEvents).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "address-admission", outcome: "accepted" }),
					expect.objectContaining({
						kind: "address-admission",
						outcome: "denied",
						reason: "insecure-websocket",
					}),
				])
			);
			if (fixture.membership) {
				expect(joiner.node.networkNode.membershipVerifier).toBeDefined();
				expect(joiner.node.networkNode.getAllPeers()).toContain(publisher.node.networkNode.peerId);
			}
		}
	} finally {
		await Promise.allSettled([...runtimes.reverse().map(({ node }) => node.stop()), server.stop()]);
	}
}, 25_000);

function runtimeConfig(
	name: string,
	bootstrapper: string,
	events: ControlPlaneEvent[] = [],
	withMembership = false
): PhaseThreeConfig {
	return {
		keychain_config: { private_key_seed: `phase-three-${name}` },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: [],
			control_plane: {
				address_policy: { allowLoopback: true, allowPrivate: true, target: "node" },
				...(withMembership
					? {
							membership: {
								allowlist: { allowedPeerIds: ["12D3KooWDefinitelyNotThePublisher"] },
								mode: "allowlist" as const,
							},
						}
					: {}),
				observability: { sink: (event): void => void events.push(event) },
				rendezvous: {
					endpoints: ["http://127.0.0.1:1/nonexistent-registry"],
					namespace: "phase-three-routing-join",
				},
				routing: { node: { bootstrappers: [bootstrapper], enabled: true, network: "local" } },
			},
			listen_addresses: ["/ip4/127.0.0.1/tcp/0"],
			log_config: { level: "silent" },
		},
	};
}

function requireRouting(runtime: RuntimeResult): NodeRouting {
	expect(runtime.routing).toBeDefined();
	if (runtime.routing === undefined) throw new Error("node runtime routing is missing");
	expect(runtime.routing.peerId).toBe(runtime.node.networkNode.peerId);
	return runtime.routing;
}

async function loadRuntime(): Promise<RuntimeModule> {
	const runtimeUrl = new URL("../src/runtime.ts", import.meta.url).href;
	let loaded: Partial<RuntimeModule> = {};
	try {
		loaded = (await import(/* @vite-ignore */ runtimeUrl)) as Partial<RuntimeModule>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("runtime.ts") || !message.includes("Does the file exist")) throw error;
	}
	expect(loaded.createNodeRuntime).toBeTypeOf("function");
	if (typeof loaded.createNodeRuntime !== "function") throw new Error("createNodeRuntime export is missing");
	return loaded as RuntimeModule;
}

async function loadNodeRouting(): Promise<RoutingNodeModule> {
	const moduleUrl = new URL("../../routing-node/src/index.ts", import.meta.url).href;
	return (await import(/* @vite-ignore */ moduleUrl)) as RoutingNodeModule;
}

function withPeerId(address: string, peerId: string): string {
	return address.includes("/p2p/") ? address : `${address}/p2p/${peerId}`;
}

async function collect(source: AsyncIterable<RoutingPeer>): Promise<RoutingPeer[]> {
	const values: RoutingPeer[] = [];
	for await (const value of source) values.push(value);
	return values;
}

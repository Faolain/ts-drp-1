import {
	kadDHT,
	type KadDHTComponents,
	passthroughMapper,
	removePrivateAddressesMapper,
	type SingleKadDHT,
} from "@libp2p/kad-dht";
import { peerIdFromString } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import { type DRPNetworkHostExtensions, type DRPNetworkHostFactory, DRPNetworkNode } from "@ts-drp/network";
import {
	type AddressDecision,
	AddressPolicy,
	type AddressScope,
	RequestBudget,
	type Resolver,
} from "@ts-drp/rendezvous";
import type { Libp2p } from "libp2p";
import { CID } from "multiformats/cid";
import { lookup } from "node:dns/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";

export { OFFICIAL_AMINO_BOOTSTRAPPERS } from "./constants.js";
export { namespaceCid } from "@ts-drp/rendezvous";

export const AMINO_DHT_PROTOCOL = "/ipfs/kad/1.0.0";
export const PUBLIC_NETWORK_ACKNOWLEDGEMENT = "I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC";
const DEFAULT_LIMITS: NodeRoutingLimits = {
	maxAddressesPerPeer: 16,
	maxNetworkRequests: 128,
	maxOperations: 128,
	maxResults: 32,
};
const MAX_LIMIT = 128;
const OPERATION_TIMEOUT_MS = 10_000;

export interface NodeRoutingLimits {
	maxAddressesPerPeer: number;
	maxNetworkRequests: number;
	maxOperations: number;
	maxResults: number;
}

export interface NodeRoutingOptions {
	readonly allowInsecureWebSocketFixture?: boolean;
	bootstrapPeers?: readonly string[];
	limits?: Partial<NodeRoutingLimits>;
	listenAddresses?: readonly string[];
	mode?: "client" | "server";
	network?: "local" | "public";
	resolver?: Resolver;
}

export interface AminoAttachmentOptions {
	readonly allowInsecureWebSocketFixture?: boolean;
	readonly limits?: Partial<NodeRoutingLimits>;
	readonly mode?: "client" | "server";
	readonly network?: "local" | "public";
	readonly resolver?: Resolver;
}

export interface RoutingPeer {
	addresses: string[];
	addressDecisions: AddressDecision[];
	inputAddressCount: number;
	peerId: string;
	truncatedAddressCount: number;
}

export interface RoutingMeasurement {
	connectionCount: number;
	cpuSystemMicros: number;
	cpuUserMicros: number;
	durationMs: number;
	logicalReceivedBytes: number;
	logicalSentBytes: number;
	networkRequestsConsumed: number;
	operation:
		| "bootstrap"
		| "cancelReprovide"
		| "connect"
		| "findPeer"
		| "findProviders"
		| "getClosestPeers"
		| "provide"
		| "refresh";
	rssAfterBytes: number;
	rssBeforeBytes: number;
	transportBytes: {
		reason: "not-exposed-by-libp2p-public-api";
		status: "unavailable";
	};
}

export interface ReachabilityObservation {
	atMs: number;
	autonat: "available" | "unavailable";
	basis: "verified-address-set";
	dialable: boolean;
	observedAddressScopes: AddressScope[];
	source: "initial" | "self-peer-update";
	status: "private" | "public" | "unknown";
}

export interface PublicationReceipt {
	cid: string;
}

export interface RoutingTableStatus {
	addresses: Array<{ address: string; decision: AddressDecision }>;
	connectionCount: number;
	dhtMode: "client" | "server";
	dialable: boolean;
	peerId: string;
	protocol: typeof AMINO_DHT_PROTOCOL;
	protocols: string[];
	reachability: ReachabilityObservation;
	routingTableSize: number;
}

type RoutingHostServices = Record<string, unknown> & { aminoDHT: SingleKadDHT };

type RoutingHost = Libp2p<RoutingHostServices>;

/**
 * A bounded Node-only Amino DHT adapter attached to the production DRP host.
 *
 * Transport-byte counters are intentionally reported as unavailable: js-libp2p
 * does not expose them on its public connection API. Logical request/response
 * bytes remain measurable without reaching into transport internals.
 */
export class NodeRouting {
	readonly #dht: SingleKadDHT;
	readonly #host: RoutingHost;
	readonly #limits: Readonly<NodeRoutingLimits>;
	readonly #networkNode: DRPNetworkNode;
	readonly #policy: AddressPolicy;
	readonly #requestBudget: RequestBudget;
	readonly #resolver: Resolver;
	readonly #measurements: RoutingMeasurement[] = [];
	readonly #reachability: ReachabilityObservation[] = [];
	readonly #onSelfPeerUpdate = (): void => {
		this.#reachabilityQueue = this.#reachabilityQueue
			.then(() => this.#recordReachability("self-peer-update"))
			.catch(() => undefined);
	};
	#operations = 0;
	#reachabilityQueue: Promise<void> = Promise.resolve();
	#stopPromise?: Promise<void>;
	#stopped = false;

	/**
	 * Creates an adapter around one already-started production DRP host.
	 * @param networkNode - Production owner used for coordinated shutdown
	 * @param host - Exact host built through the production extension seam
	 * @param options - Frozen routing policy dependencies
	 * @param options.limits - Operation, request, result, and address caps
	 * @param options.network - Whether public-only address filtering is required
	 * @param options.resolver - DNS resolver used by the address policy
	 * @param options.allowInsecureWebSocketFixture
	 */
	constructor(
		networkNode: DRPNetworkNode,
		host: RoutingHost,
		options: {
			allowInsecureWebSocketFixture?: boolean;
			limits: NodeRoutingLimits;
			network: "local" | "public";
			resolver: Resolver;
		}
	) {
		this.#networkNode = networkNode;
		this.#host = host;
		this.#dht = host.services.aminoDHT;
		this.#limits = Object.freeze({ ...options.limits });
		this.#resolver = options.resolver;
		this.#requestBudget = new RequestBudget(options.limits.maxNetworkRequests);
		this.#policy = new AddressPolicy({
			allowInsecureWebSocket: options.allowInsecureWebSocketFixture,
			allowLoopback: options.network === "local",
			allowPrivate: options.network === "local",
			target: "node",
		});
		this.#host.addEventListener("self:peer:update", this.#onSelfPeerUpdate);
	}

	/**
	 * @returns Local peer ID of the production host
	 */
	get peerId(): string {
		return this.#host.peerId.toString();
	}

	/**
	 * @returns Immutable snapshots of completed operation measurements
	 */
	get measurements(): readonly RoutingMeasurement[] {
		return this.#measurements.map((measurement) => ({
			...measurement,
			transportBytes: { ...measurement.transportBytes },
		}));
	}

	/**
	 * @returns Immutable AutoNAT/address-manager reachability observations
	 */
	get reachabilityObservations(): readonly ReachabilityObservation[] {
		return this.#reachability.map((observation) => ({
			...observation,
			observedAddressScopes: [...observation.observedAddressScopes],
		}));
	}

	/**
	 * Records the initial verified-address state after the host has started.
	 */
	async initialize(): Promise<void> {
		await this.#recordReachability("initial");
	}

	/**
	 * Opens a bounded connection through the production host.
	 * @param address - Complete remote multiaddr
	 * @param signal - Optional caller cancellation
	 * @returns Measured connection result
	 */
	async connect(address: string, signal?: AbortSignal): Promise<void> {
		return this.#measure("connect", new TextEncoder().encode(address).byteLength, signal, async (boundedSignal) => {
			await this.#host.dial(multiaddr(address), { signal: boundedSignal });
		});
	}

	/**
	 * Waits for a minimum routing-table population within the normal bounded
	 * operation guard. This makes cold bootstrap part of the measured contract.
	 * @param minimumPeers - Minimum routing-table population
	 * @param signal - Optional caller cancellation
	 * @returns When the requested routing-table population is observed
	 */
	async waitForRoutingTable(minimumPeers = 1, signal?: AbortSignal): Promise<void> {
		if (!Number.isInteger(minimumPeers) || minimumPeers < 1 || minimumPeers > this.#limits.maxResults) {
			throw new Error(`minimumPeers must be an integer within 1..${this.#limits.maxResults}`);
		}
		return this.#measure("bootstrap", 0, signal, async (boundedSignal) => {
			while (this.#dht.routingTable.size < minimumPeers) {
				if (boundedSignal.aborted) throw boundedSignal.reason;
				await abortableDelay(50, boundedSignal);
			}
		});
	}

	/**
	 * Resolves one peer through Amino peer routing.
	 * @param peerId - Remote peer ID
	 * @param signal - Optional caller cancellation
	 * @returns Policy-filtered peer and operation measurement
	 */
	async findPeer(peerId: string, signal?: AbortSignal): Promise<RoutingPeer> {
		return this.#measure("findPeer", new TextEncoder().encode(peerId).byteLength, signal, async (boundedSignal) => {
			const peer = await this.#host.peerRouting.findPeer(peerIdFromString(peerId), {
				onProgress: (event) => this.#recordNetworkRequest(event.type),
				signal: boundedSignal,
			});
			return this.#sanitizePeer(peer.id.toString(), peer.multiaddrs.map(String), boundedSignal);
		});
	}

	/**
	 * Finds a capped list of peers closest to a binary key.
	 * @param key - Binary routing key
	 * @param signal - Optional caller cancellation
	 * @yields Policy-filtered peers up to the configured result cap
	 */
	async *getClosestPeers(key: Uint8Array, signal?: AbortSignal): AsyncIterable<RoutingPeer> {
		const peers = await this.#measure("getClosestPeers", key.byteLength, signal, async (boundedSignal) => {
			const peers: RoutingPeer[] = [];
			for await (const peer of this.#host.peerRouting.getClosestPeers(key, {
				onProgress: (event) => this.#recordNetworkRequest(event.type),
				signal: boundedSignal,
			})) {
				peers.push(await this.#sanitizePeer(peer.id.toString(), peer.multiaddrs.map(String), boundedSignal));
				if (peers.length >= this.#limits.maxResults) break;
			}
			return peers;
		});
		yield* peers;
	}

	/**
	 * Publishes this host as a provider and activates DHT reprovide ownership.
	 * @param cid - Content identifier or canonical CID string
	 * @param signal - Optional caller cancellation
	 * @returns Published CID and operation measurement
	 */
	async provide(cid: CID | string, signal?: AbortSignal): Promise<PublicationReceipt> {
		const parsed = parseCid(cid);
		return this.#measure("provide", parsed.bytes.byteLength, signal, async (boundedSignal) => {
			await this.#host.contentRouting.provide(parsed, {
				onProgress: (event) => this.#recordNetworkRequest(event.type),
				signal: boundedSignal,
			});
			return { cid: parsed.toString() };
		});
	}

	/**
	 * Stops future reprovide work for a previously provided CID.
	 * @param cid - Content identifier or canonical CID string
	 * @param signal - Optional caller cancellation
	 * @returns Measured cancellation result
	 */
	async cancelReprovide(cid: CID | string, signal?: AbortSignal): Promise<void> {
		const parsed = parseCid(cid);
		return this.#measure("cancelReprovide", parsed.bytes.byteLength, signal, async (boundedSignal) => {
			await this.#host.contentRouting.cancelReprovide(parsed, { signal: boundedSignal });
		});
	}

	/**
	 * Finds a capped list of providers for a CID.
	 * @param cid - Content identifier or canonical CID string
	 * @param signal - Optional caller cancellation
	 * @yields Policy-filtered providers up to the configured result cap
	 */
	async *findProviders(cid: CID | string, signal?: AbortSignal): AsyncIterable<RoutingPeer> {
		const parsed = parseCid(cid);
		const providers = await this.#measure("findProviders", parsed.bytes.byteLength, signal, async (boundedSignal) => {
			const providers: RoutingPeer[] = [];
			for await (const provider of this.#host.contentRouting.findProviders(parsed, {
				onProgress: (event) => this.#recordNetworkRequest(event.type),
				signal: boundedSignal,
			})) {
				providers.push(
					await this.#sanitizePeer(provider.id.toString(), provider.multiaddrs.map(String), boundedSignal)
				);
				if (providers.length >= this.#limits.maxResults) break;
			}
			return providers;
		});
		yield* providers;
	}

	/**
	 * Forces a bounded routing-table refresh.
	 * @param signal - Optional caller cancellation
	 * @returns Measured refresh result
	 */
	async refresh(signal?: AbortSignal): Promise<void> {
		return this.#measure("refresh", 0, signal, async (boundedSignal) => {
			await this.#dht.refreshRoutingTable({ signal: boundedSignal });
		});
	}

	/**
	 * Samples public routing-table, address-policy, and dialability state.
	 * @param signal - Optional caller cancellation
	 * @returns Current bounded routing status
	 */
	async status(signal?: AbortSignal): Promise<RoutingTableStatus> {
		this.#assertRunning();
		const guard = operationGuard(signal);
		try {
			const addresses = await Promise.all(
				this.#host
					.getMultiaddrs()
					.slice(0, this.#limits.maxAddressesPerPeer)
					.map(async (address) => ({
						address: address.toString(),
						decision: await this.#policy.evaluate(address.toString(), this.#resolver, guard.signal),
					}))
			);
			const dialable = await this.#host.isDialable(this.#host.getMultiaddrs());
			return {
				addresses,
				connectionCount: this.#host.getConnections().length,
				dhtMode: this.#dht.getMode(),
				dialable,
				peerId: this.peerId,
				protocol: AMINO_DHT_PROTOCOL,
				protocols: this.#host.getProtocols().slice(0, 64),
				reachability:
					this.#reachability.at(-1) ??
					this.#createReachabilityObservation("initial", guard.signal, addresses, dialable),
				routingTableSize: this.#dht.routingTable.size,
			};
		} finally {
			guard.dispose();
		}
	}

	/**
	 * Stops the production network owner exactly once.
	 * @returns Shared shutdown promise
	 */
	async stop(): Promise<void> {
		if (this.#stopPromise !== undefined) return this.#stopPromise;
		this.#host.removeEventListener("self:peer:update", this.#onSelfPeerUpdate);
		this.#stopPromise = this.#reachabilityQueue
			.then(() => this.#networkNode.stop())
			.then(() => {
				this.#stopped = true;
			});
		return this.#stopPromise;
	}

	async #measure<Value>(
		operationName: RoutingMeasurement["operation"],
		logicalSentBytes: number,
		callerSignal: AbortSignal | undefined,
		operation: (signal: AbortSignal) => Promise<Value>
	): Promise<Value> {
		this.#assertRunning();
		this.#operations += 1;
		if (this.#operations > this.#limits.maxOperations) {
			throw new Error(`node routing operation cap exceeded (${this.#limits.maxOperations})`);
		}
		const startedAt = performance.now();
		const cpuBefore = process.cpuUsage();
		const rssBeforeBytes = process.memoryUsage.rss();
		const guard = operationGuard(callerSignal);
		try {
			const value = await operation(guard.signal);
			const cpu = process.cpuUsage(cpuBefore);
			const rssAfterBytes = process.memoryUsage.rss();
			this.#measurements.push({
				connectionCount: this.#host.getConnections().length,
				cpuSystemMicros: cpu.system,
				cpuUserMicros: cpu.user,
				durationMs: Math.max(0, performance.now() - startedAt),
				logicalReceivedBytes: logicalSize(value),
				logicalSentBytes,
				networkRequestsConsumed: this.#requestBudget.consumed,
				operation: operationName,
				rssAfterBytes,
				rssBeforeBytes,
				transportBytes: {
					reason: "not-exposed-by-libp2p-public-api",
					status: "unavailable",
				},
			});
			return value;
		} finally {
			guard.dispose();
		}
	}

	async #sanitizePeer(peerId: string, addresses: string[], signal: AbortSignal): Promise<RoutingPeer> {
		const boundedAddresses = addresses.slice(0, this.#limits.maxAddressesPerPeer);
		const decisions = await Promise.all(
			boundedAddresses.map((address) => this.#policy.evaluate(address, this.#resolver, signal))
		);
		return {
			addresses: boundedAddresses.filter((_, index) => decisions[index]?.dialable === true),
			addressDecisions: decisions,
			inputAddressCount: addresses.length,
			peerId,
			truncatedAddressCount: Math.max(0, addresses.length - boundedAddresses.length),
		};
	}

	async #recordReachability(source: ReachabilityObservation["source"]): Promise<void> {
		if (this.#stopped || this.#host.status !== "started") return;
		const guard = operationGuard();
		try {
			const addresses = await Promise.all(
				this.#host
					.getMultiaddrs()
					.slice(0, this.#limits.maxAddressesPerPeer)
					.map(async (address) => ({
						address: address.toString(),
						decision: await this.#policy.evaluate(address.toString(), this.#resolver, guard.signal),
					}))
			);
			const dialable = await this.#host.isDialable(this.#host.getMultiaddrs());
			const observation = this.#createReachabilityObservation(source, guard.signal, addresses, dialable);
			const previous = this.#reachability.at(-1);
			if (
				previous === undefined ||
				previous.status !== observation.status ||
				previous.dialable !== observation.dialable ||
				previous.autonat !== observation.autonat ||
				previous.observedAddressScopes.join(",") !== observation.observedAddressScopes.join(",")
			) {
				this.#reachability.push(observation);
			}
		} finally {
			guard.dispose();
		}
	}

	#createReachabilityObservation(
		source: ReachabilityObservation["source"],
		signal: AbortSignal,
		addresses: RoutingTableStatus["addresses"],
		dialable: boolean
	): ReachabilityObservation {
		if (signal.aborted) throw signal.reason;
		const scopes = [...new Set(addresses.map(({ decision }) => decision.scope))].sort();
		const autonatService: unknown = Reflect.get(this.#host.services, "autonat");
		const autonat =
			typeof autonatService === "object" &&
			autonatService !== null &&
			"isStarted" in autonatService &&
			typeof autonatService.isStarted === "function" &&
			autonatService.isStarted()
				? "available"
				: "unavailable";
		const status =
			autonat === "unavailable" || scopes.length === 0 ? "unknown" : scopes.includes("public") ? "public" : "private";
		return {
			atMs: Date.now(),
			autonat,
			basis: "verified-address-set",
			dialable,
			observedAddressScopes: scopes,
			source,
			status,
		};
	}

	#assertRunning(): void {
		if (this.#stopped || this.#host.status !== "started") {
			throw new Error("node routing host is stopped");
		}
	}

	#recordNetworkRequest(eventType: string): void {
		if (eventType === "kad-dht:query:send-query") {
			this.#requestBudget.consume();
		}
	}
}

/**
 * Starts a Node-only Amino service through the additive production host seam.
 * @param options - Network mode, bootstrap peers, listen addresses, limits, and resolver
 * @returns Started bounded routing adapter
 */
export async function createNodeRouting(options: NodeRoutingOptions = {}): Promise<NodeRouting> {
	const network = options.network ?? "local";
	let host: RoutingHost | undefined;
	const hostFactory: DRPNetworkHostFactory = async (context) => {
		const built = await context.createHost(createAminoHostExtensions({ mode: options.mode, network }));
		assertRoutingHost(built);
		host = built;
		return built;
	};
	const networkNode = new DRPNetworkNode(
		{
			autonat: true,
			bootstrap_peers: [...(options.bootstrapPeers ?? [])],
			listen_addresses: [...(options.listenAddresses ?? ["/ip4/127.0.0.1/tcp/0"])],
			log_config: { level: "silent" },
		},
		{ hostFactory }
	);
	let networkStarted = false;
	try {
		await networkNode.start();
		networkStarted = true;
		if (host === undefined) throw new Error("production host factory did not expose the routing host");
		return await attachNodeRouting(networkNode, host, options);
	} catch (error) {
		try {
			if (networkStarted) {
				await networkNode.stop();
			} else if (host?.status === "started") {
				await host.stop();
			}
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "node routing startup and cleanup both failed", {
				cause: error,
			});
		}
		throw error;
	}
}

/**
 * Builds the additive Amino DHT and TCP extension for an existing production DRP host factory.
 * @param options - Local/public mapper and client/server DHT mode.
 * @returns Additive extensions that do not replace any DRP-owned service.
 */
export function createAminoHostExtensions(
	options: Pick<AminoAttachmentOptions, "mode" | "network"> = {}
): DRPNetworkHostExtensions {
	const network = options.network ?? "local";
	const mode = options.mode ?? "client";
	const aminoDhtFactory = kadDHT({
		alpha: network === "public" ? 1 : undefined,
		allowQueryWithZeroPeers: true,
		clientMode: mode === "client",
		datastorePrefix: `/drp-amino-${network}`,
		disjointPaths: network === "public" ? 1 : undefined,
		initialQuerySelfInterval: network === "public" ? 24 * 60 * 60 * 1_000 : undefined,
		logPrefix: `drp:amino:${network}`,
		metricsPrefix: `drp_amino_${network}`,
		peerInfoMapper: network === "public" ? removePrivateAddressesMapper : passthroughMapper,
		protocol: AMINO_DHT_PROTOCOL,
		querySelfInterval: network === "public" ? 24 * 60 * 60 * 1_000 : undefined,
		reprovide: { concurrency: 1, interval: 60 * 60 * 1_000, maxQueueSize: 64 },
	});
	return {
		services: {
			aminoDHT: (components): ReturnType<typeof aminoDhtFactory> => {
				assertKadDHTComponents(components);
				return aminoDhtFactory(components);
			},
		},
		transports: [tcp()],
	};
}

/**
 * Attaches the bounded routing adapter to the exact already-started DRP host.
 * @param networkNode - DRP network owner sharing the host identity.
 * @param host - Host created by the DRP production extension seam.
 * @param options - Routing limits, network policy, resolver, and DHT mode.
 * @returns Initialized routing adapter whose peer ID equals the DRP host peer ID.
 */
export async function attachNodeRouting(
	networkNode: DRPNetworkNode,
	host: Libp2p,
	options: AminoAttachmentOptions = {}
): Promise<NodeRouting> {
	assertRoutingHost(host);
	const routing = new NodeRouting(networkNode, host, {
		allowInsecureWebSocketFixture: options.allowInsecureWebSocketFixture,
		limits: parseLimits(options.limits),
		network: options.network ?? "local",
		resolver: options.resolver ?? systemResolver,
	});
	if ((options.mode ?? "client") === "server") await host.services.aminoDHT.setMode("server", { force: true });
	await routing.initialize();
	return routing;
}

function assertRoutingHost(host: Libp2p): asserts host is RoutingHost {
	const service = host.services.aminoDHT;
	if (
		typeof service !== "object" ||
		service === null ||
		!("routingTable" in service) ||
		!("getMode" in service) ||
		typeof service.getMode !== "function"
	) {
		throw new Error("Amino DHT service was not attached to the production host");
	}
}

function assertKadDHTComponents(components: object): asserts components is typeof components & KadDHTComponents {
	const pingService: unknown = Reflect.get(components, "ping");
	if (
		typeof pingService !== "object" ||
		pingService === null ||
		!("ping" in pingService) ||
		typeof pingService.ping !== "function"
	) {
		throw new Error("Amino DHT requires the production ping service");
	}
}

function parseCid(value: CID | string): CID {
	return typeof value === "string" ? CID.parse(value) : value;
}

function parseLimits(input: Partial<NodeRoutingLimits> | undefined): NodeRoutingLimits {
	const limits = { ...DEFAULT_LIMITS, ...input };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
			throw new Error(`${name} must be an integer within 1..${MAX_LIMIT}`);
		}
	}
	return limits;
}

const systemResolver: Resolver = {
	async resolve(hostname, signal): Promise<string[]> {
		if (signal.aborted) throw signal.reason;
		let onAbort: (() => void) | undefined;
		const abort = new Promise<never>((_, reject) => {
			onAbort = (): void => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), abort]);
			return addresses.map(({ address }) => address);
		} finally {
			if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
		}
	},
};

function logicalSize(value: unknown): number {
	if (value === undefined) return 0;
	if (value instanceof Uint8Array) return value.byteLength;
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function operationGuard(callerSignal?: AbortSignal): {
	dispose(): void;
	signal: AbortSignal;
} {
	const controller = new AbortController();
	const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
	callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
	if (callerSignal?.aborted === true) onCallerAbort();
	const timeout = setTimeout(
		() => controller.abort(new Error(`node routing operation exceeded ${OPERATION_TIMEOUT_MS}ms`)),
		OPERATION_TIMEOUT_MS
	);
	timeout.unref();
	return {
		dispose(): void {
			clearTimeout(timeout);
			callerSignal?.removeEventListener("abort", onCallerAbort);
		},
		signal: controller.signal,
	};
}

async function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, durationMs);
		const onAbort = (): void => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

export type { AddressScope };

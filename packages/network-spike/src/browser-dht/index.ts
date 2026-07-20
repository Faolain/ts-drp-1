import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { type Identify, identify } from "@libp2p/identify";
import type { PeerInfo } from "@libp2p/interface";
import { type KadDHT, kadDHT, passthroughMapper, type QueryEvent } from "@libp2p/kad-dht";
import { peerIdFromString } from "@libp2p/peer-id";
import { ping, type Ping } from "@libp2p/ping";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const RAW_CODEC = 0x55;
const DEFAULT_TIMEOUT_MS = 8_000;
const DHT_PROTOCOL = "/ipfs/kad/1.0.0";

export const BROWSER_DHT_PACKAGE_VERSIONS = Object.freeze({
	kadDht: "16.3.4",
	libp2p: "3.3.5",
	noise: "17.0.0",
	webSockets: "10.1.16",
	yamux: "8.0.1",
});

export type BrowserDhtRejectionReason =
	| "browser-provider-has-no-dialable-address"
	| "construction-failed"
	| "fixture-unreachable"
	| "lookup-failed"
	| "provider-query-failed"
	| "publication-failed";

export interface BrowserDhtResourceReport {
	cpu: { status: "proxy"; longTaskDurationMs: number; note: string } | { status: "unavailable"; reason: string };
	heap:
		| { status: "measured"; beforeBytes: number; afterBytes: number; deltaBytes: number }
		| { status: "unavailable"; reason: string };
	loadedTransferBytes: number;
	wallTimeMs: number;
}

export interface BrowserDhtCheckReport {
	bootstrapConnected: boolean;
	construction: boolean;
	peerLookup: boolean;
	providerObserved: boolean;
	providerQueryCompleted: boolean;
	providerRpcCompleted: boolean;
}

export interface BrowserDhtTransportReport {
	browserListenAddresses: string[];
	constraint: "outbound-websocket-only";
	dialableProviderAddresses: string[];
	fixtureAddress: string;
	providerAddresses: string[];
}

export interface BrowserDhtVerdictBase {
	browser: string;
	checks: BrowserDhtCheckReport;
	dhtMode: "client";
	packageVersions: typeof BROWSER_DHT_PACKAGE_VERSIONS;
	resources: BrowserDhtResourceReport;
	run: {
		finishedAt: string;
		fixtureClass: "local-loopback-websocket";
		id: string;
		startedAt: string;
		timeoutMs: number;
		steps: Array<{
			atMs: number;
			detail: string;
			kind:
				| "bootstrap-connected"
				| "error"
				| "hosts-constructed"
				| "hosts-stopped"
				| "peer-lookup"
				| "provider-query"
				| "provider-rpc"
				| "routing-ready";
		}>;
	};
	routingTable: {
		observerPeers: number;
		publisherPeers: number;
	};
	transport: BrowserDhtTransportReport;
}

export interface BrowserDhtSupportedVerdict extends BrowserDhtVerdictBase {
	status: "supported";
}

export interface BrowserDhtRejectedVerdict extends BrowserDhtVerdictBase {
	detail: string;
	reason: BrowserDhtRejectionReason;
	status: "rejected";
}

export type BrowserDhtVerdict = BrowserDhtSupportedVerdict | BrowserDhtRejectedVerdict;

export interface BrowserDhtExperimentOptions {
	fixtureAddress: string;
	namespace?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

type BrowserDhtServices = {
	[key: string]: unknown;
	aminoDHT: KadDHT;
	identify: Identify;
	ping: Ping;
};

interface RuntimeObservation {
	bootstrapConnected: boolean;
	construction: boolean;
	error?: unknown;
	peerLookup: boolean;
	providerObserved: boolean;
	providerQueryCompleted: boolean;
	providerRpcCompleted: boolean;
	providerPeer?: PeerInfo;
	routingTable: BrowserDhtVerdictBase["routingTable"];
}

interface MemoryPerformance extends Performance {
	memory?: {
		usedJSHeapSize: number;
	};
}

/**
 * Run the isolated browser Amino DHT feasibility experiment against a local
 * WebSocket fixture. The result is evidence, not a production routing API.
 * @param options Local fixture, timeout, and cancellation controls.
 * @returns The typed, run-bound feasibility verdict.
 */
export async function runBrowserDhtExperiment(options: BrowserDhtExperimentOptions): Promise<BrowserDhtVerdict> {
	const startedAt = performance.now();
	const startedAtIso = new Date().toISOString();
	const runId = `dht-${startedAtIso.replaceAll(/[-:.TZ]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
	const beforeHeap = readHeapBytes();
	const longTasks = observeLongTasks();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const steps: BrowserDhtVerdictBase["run"]["steps"] = [];
	const mark = (kind: BrowserDhtVerdictBase["run"]["steps"][number]["kind"], detail: string): void => {
		steps.push({
			atMs: Math.round((performance.now() - startedAt) * 10) / 10,
			detail,
			kind,
		});
	};
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
	const browser = navigator.userAgent;
	let publisher: Libp2p<BrowserDhtServices> | undefined;
	let observer: Libp2p<BrowserDhtServices> | undefined;
	let browserListenAddresses: string[] = [];
	const observation: RuntimeObservation = {
		bootstrapConnected: false,
		construction: false,
		peerLookup: false,
		providerObserved: false,
		providerQueryCompleted: false,
		providerRpcCompleted: false,
		routingTable: { observerPeers: 0, publisherPeers: 0 },
	};

	try {
		// Construct sequentially so `finally` can stop the first host if creating
		// the second one fails. A Promise.all assignment would lose that handle.
		publisher = await createBrowserDhtHost();
		observer = await createBrowserDhtHost();
		browserListenAddresses = publisher.getMultiaddrs().map(String);
		observation.construction = true;
		mark(
			"hosts-constructed",
			`publisher=${publisher.peerId.toString()}; observer=${observer.peerId.toString()}; listenAddresses=${browserListenAddresses.length}`
		);
		const fixture = multiaddr(options.fixtureAddress);
		await Promise.all([publisher.dial(fixture, { signal }), observer.dial(fixture, { signal })]);
		observation.bootstrapConnected = true;
		mark(
			"bootstrap-connected",
			`actors=publisher+observer; transport=/ip4/127.0.0.1/tcp/4176/ws; fixturePeer=${fixture.getComponents().find((component) => component.name === "p2p")?.value ?? "missing"}`
		);
		await Promise.all([
			waitForRoutingPeer(publisher.services.aminoDHT, signal),
			waitForRoutingPeer(observer.services.aminoDHT, signal),
		]);
		mark(
			"routing-ready",
			`publisherPeers=${routingTableSize(publisher.services.aminoDHT)}; observerPeers=${routingTableSize(observer.services.aminoDHT)}`
		);
		const fixturePeer = fixture.getComponents().find((component) => component.name === "p2p")?.value;
		if (fixturePeer === undefined) throw new Error("fixture address must include a peer id");
		observation.peerLookup = await queryHasFinalPeer(
			observer.services.aminoDHT.findPeer(peerIdFromString(fixturePeer), { signal })
		);
		mark("peer-lookup", `actor=observer; fixturePeer=${fixturePeer}; finalPeer=${String(observation.peerLookup)}`);
		const cid = await namespaceCid(options.namespace ?? "phase-03b-browser-provider");
		let provideEvents = 0;
		for await (const event of publisher.services.aminoDHT.provide(cid, { signal })) {
			provideEvents++;
			if (event.name === "PEER_RESPONSE" && event.messageName === "ADD_PROVIDER") {
				observation.providerRpcCompleted = true;
			}
		}
		mark(
			"provider-rpc",
			`actor=publisher; cid=${cid.toString()}; provideQueryEvents=${provideEvents}; responseObserved=${String(observation.providerRpcCompleted)}; advertisedAddresses=${browserListenAddresses.length}`
		);
		let providerQueryEvents = 0;
		let providerEvents = 0;
		for await (const event of observer.services.aminoDHT.findProviders(cid, { signal })) {
			providerQueryEvents++;
			if (event.name !== "PROVIDER") continue;
			providerEvents++;
			const provider = event.providers.find((candidate) => candidate.id.equals(publisher?.peerId));
			if (provider !== undefined) {
				observation.providerObserved = true;
				observation.providerPeer = provider;
				break;
			}
		}
		observation.providerQueryCompleted = true;
		mark(
			"provider-query",
			`actor=observer; cid=${cid.toString()}; findProvidersQueryEvents=${providerQueryEvents}; providerEvents=${providerEvents}; publisherObserved=${String(observation.providerObserved)}`
		);
	} catch (error) {
		observation.error = error;
		mark("error", describeError(error, "unknown experiment error"));
	} finally {
		observation.routingTable = {
			observerPeers: routingTableSize(observer?.services.aminoDHT),
			publisherPeers: routingTableSize(publisher?.services.aminoDHT),
		};
		const constructedHosts = Number(publisher !== undefined) + Number(observer !== undefined);
		await Promise.allSettled([publisher?.stop(), observer?.stop()]);
		mark("hosts-stopped", `${constructedHosts}/2 constructed host stop operations settled`);
	}

	const providerAddresses = observation.providerPeer?.multiaddrs.map(String) ?? [];
	const dialableProviderAddresses = providerAddresses.filter(isBrowserDialableAddress);
	const afterHeap = readHeapBytes();
	const base: BrowserDhtVerdictBase = {
		browser,
		checks: {
			bootstrapConnected: observation.bootstrapConnected,
			construction: observation.construction,
			peerLookup: observation.peerLookup,
			providerObserved: observation.providerObserved,
			providerQueryCompleted: observation.providerQueryCompleted,
			providerRpcCompleted: observation.providerRpcCompleted,
		},
		dhtMode: "client",
		packageVersions: BROWSER_DHT_PACKAGE_VERSIONS,
		resources: {
			cpu: longTasks.finish(),
			heap:
				beforeHeap === undefined || afterHeap === undefined
					? {
							status: "unavailable",
							reason: "performance.memory is not exposed by this browser",
						}
					: {
							afterBytes: afterHeap,
							beforeBytes: beforeHeap,
							deltaBytes: afterHeap - beforeHeap,
							status: "measured",
						},
			loadedTransferBytes: performance
				.getEntriesByType("resource")
				.reduce((total, entry) => total + (entry instanceof PerformanceResourceTiming ? entry.transferSize : 0), 0),
			wallTimeMs: Math.round((performance.now() - startedAt) * 10) / 10,
		},
		run: {
			finishedAt: new Date().toISOString(),
			fixtureClass: "local-loopback-websocket",
			id: runId,
			startedAt: startedAtIso,
			steps,
			timeoutMs,
		},
		routingTable: observation.routingTable,
		transport: {
			browserListenAddresses,
			constraint: "outbound-websocket-only",
			dialableProviderAddresses,
			fixtureAddress: options.fixtureAddress,
			providerAddresses,
		},
	};
	return assessBrowserDhtObservation(base, observation.error);
}

/**
 * Turn observed protocol and address facts into the feasibility verdict.
 * @param base Fully measured browser-DHT facts.
 * @param error Optional protocol error captured during the run.
 * @returns A supported or reasoned rejected verdict.
 */
export function assessBrowserDhtObservation(base: BrowserDhtVerdictBase, error?: unknown): BrowserDhtVerdict {
	if (!base.checks.construction) {
		return rejected(base, "construction-failed", describeError(error, "browser libp2p host construction failed"));
	}
	if (!base.checks.bootstrapConnected) {
		return rejected(base, "fixture-unreachable", describeError(error, "local WebSocket DHT fixture was unreachable"));
	}
	if (!base.checks.peerLookup) {
		return rejected(base, "lookup-failed", describeError(error, "Amino DHT peer lookup did not complete"));
	}
	if (!base.checks.providerRpcCompleted) {
		return rejected(base, "publication-failed", describeError(error, "provider publication RPC did not complete"));
	}
	if (!base.checks.providerQueryCompleted) {
		return rejected(base, "provider-query-failed", describeError(error, "provider lookup did not complete"));
	}
	if (!base.checks.providerObserved || base.transport.dialableProviderAddresses.length === 0) {
		return rejected(
			base,
			"browser-provider-has-no-dialable-address",
			"the browser can dial the DHT over WebSocket, but it has no inbound listen address; kad-dht ignores provider records with zero multiaddrs"
		);
	}
	return { ...base, status: "supported" };
}

async function createBrowserDhtHost(): Promise<Libp2p<BrowserDhtServices>> {
	return createLibp2p<BrowserDhtServices>({
		addresses: { listen: [] },
		connectionEncrypters: [noise()],
		connectionGater: {
			denyDialMultiaddr: () => false,
		},
		services: {
			aminoDHT: browserKadDHT(),
			identify: identify(),
			ping: ping(),
		},
		streamMuxers: [yamux()],
		transports: [webSockets()],
	});
}

function browserKadDHT(): ReturnType<typeof kadDHT> {
	return kadDHT({
		allowQueryWithZeroPeers: false,
		alpha: 1,
		clientMode: true,
		disjointPaths: 1,
		initialQuerySelfInterval: 0,
		kBucketSize: 1,
		peerInfoMapper: passthroughMapper,
		protocol: DHT_PROTOCOL,
		querySelfInterval: 24 * 60 * 60 * 1_000,
		reprovide: { interval: 24 * 60 * 60 * 1_000 },
	});
}

async function waitForRoutingPeer(dht: KadDHT, signal: AbortSignal): Promise<void> {
	while (routingTableSize(dht) === 0) {
		await new Promise<void>((resolve, reject) => {
			signal.throwIfAborted();
			const onAbort = (): void => {
				clearTimeout(handle);
				reject(signal.reason);
			};
			const handle = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, 10);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

function routingTableSize(dht: KadDHT | undefined): number {
	if (dht === undefined || !("routingTable" in dht)) return 0;
	const routingTable = Reflect.get(dht, "routingTable");
	if (typeof routingTable !== "object" || routingTable === null) return 0;
	const size = Reflect.get(routingTable, "size");
	return typeof size === "number" ? size : 0;
}

async function queryHasFinalPeer(events: AsyncIterable<QueryEvent>): Promise<boolean> {
	for await (const event of events) {
		if (event.name === "FINAL_PEER") return true;
	}
	return false;
}

async function namespaceCid(namespace: string): Promise<CID> {
	return CID.createV1(RAW_CODEC, await sha256.digest(new TextEncoder().encode(namespace)));
}

function isBrowserDialableAddress(address: string): boolean {
	return address.includes("/ws") || address.includes("/wss") || address.includes("/webrtc");
}

function rejected(
	base: BrowserDhtVerdictBase,
	reason: BrowserDhtRejectionReason,
	detail: string
): BrowserDhtRejectedVerdict {
	return { ...base, detail, reason, status: "rejected" };
}

function describeError(error: unknown, fallback: string): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : fallback;
}

function readHeapBytes(): number | undefined {
	return (performance as MemoryPerformance).memory?.usedJSHeapSize;
}

function observeLongTasks(): {
	finish(): BrowserDhtResourceReport["cpu"];
} {
	if (typeof PerformanceObserver === "undefined") {
		return {
			finish: () => ({ reason: "PerformanceObserver is not exposed by this browser", status: "unavailable" }),
		};
	}
	const supported = PerformanceObserver.supportedEntryTypes.includes("longtask");
	if (!supported) {
		return {
			finish: () => ({ reason: "the Long Tasks API is not supported by this browser", status: "unavailable" }),
		};
	}
	let duration = 0;
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) duration += entry.duration;
	});
	observer.observe({ entryTypes: ["longtask"] });
	return {
		finish(): BrowserDhtResourceReport["cpu"] {
			observer.disconnect();
			return {
				longTaskDurationMs: Math.round(duration * 10) / 10,
				note: "main-thread long-task duration is a portable CPU-pressure proxy, not process CPU time",
				status: "proxy",
			};
		},
	};
}

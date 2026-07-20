import type { CID } from "multiformats/cid";
import { createHash } from "node:crypto";
import process from "node:process";

import { createNodeRouting, namespaceCid, type NodeRouting, type RoutingMeasurement } from "./index.js";
import { AddressPolicy } from "../probe/address-policy.js";
import { type ProbeEvent, probeEventToJsonLine } from "../probe/events.js";
import {
	type Probe,
	type ProbeExecution,
	ProbeRunner,
	type ProbeRunnerDependencies,
	type ProbeRunResult,
	SeededRandom,
	SystemClock,
} from "../probe/kernel.js";

export interface LocalAminoFixtureSummary {
	autonatAvailable: boolean;
	bootstrapCpuSystemMicros: number;
	bootstrapCpuUserMicros: number;
	bootstrapDurationMs: number;
	bootstrapRssDeltaBytes: number;
	closestPeerCount: number;
	findPeerSucceeded: boolean;
	logicalReceivedBytes: number;
	logicalSentBytes: number;
	observedAddressScopes: string[];
	providerVisible: boolean;
	providerLatencyMs: number;
	routingTableSize: number;
	transportBytesMeasured: false;
}

export interface LocalAminoFixture {
	events: readonly ProbeEvent[];
	jsonl: string;
	result: ProbeRunResult<LocalAminoFixtureSummary>;
}

/**
 * Runs a private loopback Amino topology through the production host seam.
 * @returns Replayable typed evidence and the terminal fixture result
 */
export async function runLocalAminoFixture(): Promise<LocalAminoFixture> {
	const events: ProbeEvent[] = [];
	const clock = new SystemClock();
	const dependencies: ProbeRunnerDependencies = {
		addressPolicy: new AddressPolicy({ allowLoopback: true, allowPrivate: true, target: "node" }),
		clock,
		dialer: {
			dial: () => Promise.reject(new Error("fixture routes through the production libp2p host")),
		},
		fetch: () => Promise.reject(new Error("local Amino fixture performs no HTTP requests")),
		random: new SeededRandom(2),
		resolver: {
			resolve: () => Promise.resolve(["127.0.0.1"]),
		},
		resourceSampler: {
			sample: () => {
				const resources = process.getActiveResourcesInfo();
				return {
					activeTimers: resources.filter((resource) => resource === "Timeout").length,
					heapBytes: process.memoryUsage().heapUsed,
					openHandles: resources.length,
				};
			},
		},
		sink: {
			record: (event) => events.push(event),
		},
	};
	const runner = new ProbeRunner(dependencies, {
		cleanupTimeoutMs: 5_000,
		parentTimeoutMs: 30_000,
		runId: "fixture-amino-local",
	});
	const result = await runner.run(createLocalAminoProbe());
	return {
		events: result.events,
		jsonl: result.events.map((event) => probeEventToJsonLine(event)).join(""),
		result,
	};
}

function createLocalAminoProbe(): Probe<LocalAminoFixtureSummary> {
	return {
		id: "amino-local",
		async run(context): Promise<ProbeExecution<LocalAminoFixtureSummary>> {
			const nodes: NodeRouting[] = [];
			context.defer(async () => {
				await Promise.allSettled(nodes.reverse().map((node) => node.stop()));
				await waitForResourceQuiescence();
			});
			try {
				const server = await createNodeRouting({
					limits: { maxResults: 1 },
					mode: "server",
					network: "local",
				});
				nodes.push(server);
				const serverStatus = await server.status(context.signal);
				const bootstrapAddress = serverStatus.addresses.find(({ decision }) => decision.dialable)?.address;
				if (bootstrapAddress === undefined) throw new Error("local DHT server has no dialable address");

				const publisher = await createNodeRouting({
					bootstrapPeers: [],
					mode: "client",
					network: "local",
				});
				nodes.push(publisher);
				await publisher.connect(withPeerId(bootstrapAddress, server.peerId), context.signal);
				await publisher.waitForRoutingTable(1, context.signal);

				context.emit("identify-protocols", {
					protocols: serverStatus.protocols,
				});
				for (const observation of publisher.reachabilityObservations) {
					context.emit("autonat-reachability", { status: observation.status });
				}
				for (const { decision } of serverStatus.addresses) {
					context.emit("address-family", { count: 1, family: decision.family });
				}

				context.emit("routing-query", { method: "find-peer" });
				const found = await publisher.findPeer(server.peerId, context.signal);
				context.emit("routing-result-count", { count: 1 });

				const key = new TextEncoder().encode("drp-local-closest-peer");
				context.emit("routing-query", { method: "get-closest-peers" });
				const closest = await collect(publisher.getClosestPeers(key, context.signal));
				context.emit("routing-result-count", { count: closest.length });

				const cid = await namespaceCid("drp/phase-02/local-provider");
				context.emit("routing-query", { method: "provide" });
				await publisher.provide(cid, context.signal);
				context.emit("routing-result-count", { count: 1 });

				context.emit("routing-query", { method: "find-providers" });
				const providers = await collect(server.findProviders(cid, context.signal));
				context.emit("routing-result-count", { count: providers.length });
				await publisher.cancelReprovide(cid, context.signal);

				const measurements = [...publisher.measurements, ...server.measurements];
				const logicalSentBytes = sum(measurements, (item) => item.logicalSentBytes);
				const logicalReceivedBytes = sum(measurements, (item) => item.logicalReceivedBytes);
				context.emit("traffic-by-path", {
					path: "direct",
					receivedBytes: logicalReceivedBytes,
					sentBytes: logicalSentBytes,
				});
				const providerVisible = providers.some((provider) => provider.peerId === publisher.peerId);
				const finalStatus = await publisher.status(context.signal);
				const bootstrap = requiredMeasurement(publisher.measurements, "bootstrap");
				const provide = requiredMeasurement(publisher.measurements, "provide");
				return {
					status: "success",
					value: {
						autonatAvailable: finalStatus.reachability.autonat === "available",
						bootstrapCpuSystemMicros: bootstrap.cpuSystemMicros,
						bootstrapCpuUserMicros: bootstrap.cpuUserMicros,
						bootstrapDurationMs: bootstrap.durationMs,
						bootstrapRssDeltaBytes: bootstrap.rssAfterBytes - bootstrap.rssBeforeBytes,
						closestPeerCount: closest.length,
						findPeerSucceeded: found.peerId === server.peerId,
						logicalReceivedBytes,
						logicalSentBytes,
						observedAddressScopes: finalStatus.reachability.observedAddressScopes,
						providerVisible,
						providerLatencyMs: provide.durationMs,
						routingTableSize: finalStatus.routingTableSize,
						transportBytesMeasured: false,
					},
				};
			} catch (error) {
				return {
					failure: {
						code: "amino-fixture-failed",
						message: error instanceof Error ? error.message : String(error),
						retryable: false,
					},
					status: "failure",
				};
			}
		},
	};
}

function withPeerId(address: string, peerId: string): string {
	return address.includes("/p2p/") ? address : `${address}/p2p/${peerId}`;
}

async function waitForResourceQuiescence(): Promise<void> {
	const deadline = Date.now() + 2_500;
	while (Date.now() < deadline) {
		const ownedResources = process
			.getActiveResourcesInfo()
			.filter((resource) => resource !== "PipeWrap" && resource !== "TTYWrap");
		if (ownedResources.length === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function sum(results: readonly RoutingMeasurement[], select: (result: RoutingMeasurement) => number): number {
	return results.reduce((total, result) => total + select(result), 0);
}

function requiredMeasurement(
	measurements: readonly RoutingMeasurement[],
	operation: RoutingMeasurement["operation"]
): RoutingMeasurement {
	const measurement = measurements.find((candidate) => candidate.operation === operation);
	if (measurement === undefined) throw new Error(`missing ${operation} measurement`);
	return measurement;
}

async function collect<Value>(source: AsyncIterable<Value>): Promise<Value[]> {
	const values: Value[] = [];
	for await (const value of source) values.push(value);
	return values;
}

/**
 * Produces a stable redaction-safe fixture peer label.
 * @param peerId - Ephemeral raw peer ID
 * @returns Twelve-hex pseudonym
 */
export function fixturePeerPseudonym(peerId: string): string {
	return `peer_${createHash("sha256").update(peerId).digest("hex").slice(0, 12)}`;
}

export type { CID };

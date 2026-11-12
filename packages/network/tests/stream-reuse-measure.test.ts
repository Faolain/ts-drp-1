/* eslint-disable @typescript-eslint/explicit-function-return-type -- Opt-in measurement harness. */
// MEASUREMENT ONLY (track 46): what one libp2p stream per direct message costs against one long-lived
// length-prefixed stream, between two genuine DRPNetworkNodes on localhost WebSocket (the transport of
// the native Grid harnesses). Runs only with NETREUSE_MEASURE=1; writes NETREUSE_OUT (JSON).
//
// Phases (each message is a MESSAGE_TYPE_CUSTOM of NETREUSE_BYTES payload with a unique objectId):
//   seq      - sendMessage, awaited one at a time (fresh stream each);
//   paced    - sendMessage fired at NETREUSE_HZ without awaiting (movement-like);
//   burst    - NETREUSE_BURST concurrent sendMessage calls to one peer, repeated;
//   reuse-*  - the same three patterns over ONE stream of a probe protocol, one varint-length-prefixed
//              frame per message (the shape of the proposed design, without its queue/policy).
// Latency is sender call -> receiver decoded the message (same process, same clock). CPU is the
// process's user+system time per message (both peers share the process).
import type { Libp2p, Stream } from "@libp2p/interface";
import { lpStream } from "@libp2p/utils";
import { Message, MessageType } from "@ts-drp/types";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DRPNetworkNode } from "../src/node.js";
import { flushStreamDiagnostics } from "../src/stream-diagnostics.js";

const enabled = process.env.NETREUSE_MEASURE === "1";
const out = process.env.NETREUSE_OUT ?? "";
const count = Number(process.env.NETREUSE_N ?? 400);
const bytes = Number(process.env.NETREUSE_BYTES ?? 700);
const hz = Number(process.env.NETREUSE_HZ ?? 30);
const burst = Number(process.env.NETREUSE_BURST ?? 8);
const PROBE = "/drp/netreuse-probe/0.0.1";

type Arrivals = Map<string, number>;

function quantiles(values: readonly number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
	const round = (value: number) => Math.round(value * 1000) / 1000;
	return {
		n: sorted.length,
		p50: round(at(0.5)),
		p95: round(at(0.95)),
		p99: round(at(0.99)),
		max: round(sorted.at(-1) ?? NaN),
		mean: round(sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)),
	};
}

function message(id: string) {
	return Message.create({
		type: MessageType.MESSAGE_TYPE_CUSTOM,
		objectId: id,
		data: new Uint8Array(bytes).fill(7),
	});
}

async function waitFor(arrivals: Arrivals, ids: readonly string[], timeoutMs = 10_000) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline && ids.some((id) => !arrivals.has(id)))
		await new Promise((resolve) => setTimeout(resolve, 2));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)("measure: per-message stream open vs one long-lived stream", () => {
	it("records latency, CPU and delivery for both shapes", { timeout: 600_000 }, async () => {
		const nodes = [0, 1].map(
			() =>
				new DRPNetworkNode(
					{ bootstrap_peers: [], listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"], log_config: { level: "silent" } },
					{ hostPolicy: { bootstrapDiscovery: false, coldStartPubsubDiscovery: false, gossipSubPeerExchange: false } }
				)
		);
		const [sender, receiver] = nodes;
		await Promise.all(nodes.map((node) => node.start()));
		const results: Record<string, unknown> = {
			config: { count, bytes, hz, burst, node: process.version, diagnostics: process.env.DRP_STREAM_DIAGNOSTICS === "1" },
		};
		try {
			await sender.connect(receiver.getMultiaddrs());
			const arrivals: Arrivals = new Map();
			receiver.subscribeToMessageQueue((received: Message) => {
				arrivals.set(received.objectId, performance.now());
			});
			// Probe protocol: one long-lived stream, one varint-length-prefixed Message per frame.
			const receiverHost = (receiver as unknown as { _node: Libp2p })._node;
			const senderHost = (sender as unknown as { _node: Libp2p })._node;
			await receiverHost.handle(PROBE, async (stream: Stream) => {
				const lp = lpStream(stream, { maxDataLength: 4 * 1024 * 1024 });
				try {
					for (;;) {
						const frame = await lp.read();
						const decoded = Message.decode(frame.subarray());
						arrivals.set(decoded.objectId, performance.now());
					}
				} catch {
					/* stream ended */
				}
			});

			const run = async (name: string, ids: string[], send: (id: string) => Promise<unknown>, pattern: string) => {
				const starts = new Map<string, number>();
				const resolved: number[] = [];
				const cpu0 = process.cpuUsage();
				const wall0 = performance.now();
				if (pattern === "seq") {
					for (const id of ids) {
						const t0 = performance.now();
						starts.set(id, t0);
						await send(id);
						resolved.push(performance.now() - t0);
						await waitFor(arrivals, [id]);
					}
				} else if (pattern === "paced") {
					const pending: Promise<unknown>[] = [];
					for (const id of ids) {
						const t0 = performance.now();
						starts.set(id, t0);
						pending.push(send(id).then(() => resolved.push(performance.now() - t0)));
						await sleep(1000 / hz);
					}
					await Promise.allSettled(pending);
					await waitFor(arrivals, ids);
				} else {
					for (let offset = 0; offset < ids.length; offset += burst) {
						const group = ids.slice(offset, offset + burst);
						const t0 = performance.now();
						await Promise.allSettled(
							group.map((id) => {
								starts.set(id, t0);
								return send(id).then(() => resolved.push(performance.now() - t0));
							})
						);
						await waitFor(arrivals, group, 3_000);
						await sleep(50);
					}
				}
				const cpu = process.cpuUsage(cpu0);
				const latency = ids.flatMap((id) => {
					const at = arrivals.get(id);
					const t0 = starts.get(id);
					return at === undefined || t0 === undefined ? [] : [at - t0];
				});
				results[name] = {
					delivered: latency.length,
					offered: ids.length,
					latencyMs: quantiles(latency),
					resolveMs: quantiles(resolved),
					cpuUsPerMessage: Math.round((cpu.user + cpu.system) / ids.length),
					wallMs: Math.round(performance.now() - wall0),
				};
			};

			const ids = (prefix: string, n = count) => Array.from({ length: n }, (_, index) => `${prefix}-${index}`);
			const fresh = (id: string) => sender.sendMessage(receiver.peerId, message(id));
			// warm both paths
			await run("warm-fresh", ids("wf", 20), fresh, "seq");
			const probeStream = await (await senderHost.dial(receiverHost.peerId)).newStream(PROBE);
			const probe = lpStream(probeStream);
			const reuse = (id: string) => probe.write(Message.encode(message(id)).finish());
			await run("warm-reuse", ids("wr", 20), reuse, "seq");

			for (const round of [1, 2]) {
				await run(`fresh-seq-${round}`, ids(`fs${round}`), fresh, "seq");
				await run(`reuse-seq-${round}`, ids(`rs${round}`), reuse, "seq");
				await run(`fresh-paced-${round}`, ids(`fp${round}`), fresh, "paced");
				await run(`reuse-paced-${round}`, ids(`rp${round}`), reuse, "paced");
				await run(`fresh-burst-${round}`, ids(`fb${round}`, burst * 25), fresh, "burst");
				await run(`reuse-burst-${round}`, ids(`rb${round}`, burst * 25), reuse, "burst");
			}
			flushStreamDiagnostics();
			const diag = (globalThis as { __drpStreamDiagnostics?: { opens: Record<string, number>; sends: unknown[] } })
				.__drpStreamDiagnostics;
			if (diag !== undefined) results.diagnostics = { opens: diag.opens, sends: diag.sends, receives: (diag as unknown as { receives: unknown[] }).receives, openSamples: (diag as unknown as { openSamples: unknown[] }).openSamples };
			if (out !== "") writeFileSync(out, JSON.stringify(results, null, 1));
			console.log(JSON.stringify(Object.fromEntries(Object.entries(results).filter(([key]) => key !== "diagnostics")), null, 1));
			expect((results["fresh-seq-1"] as { delivered: number }).delivered).toBeGreaterThan(0);
		} finally {
			await Promise.allSettled(nodes.map((node) => node.stop()));
		}
	});
});

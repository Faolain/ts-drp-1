import type { DRPNetworkHostFactory } from "@ts-drp/network";
import { DRPNetworkNode } from "@ts-drp/network";
import { createAminoHostExtensions } from "@ts-drp/routing-node";
import type { Libp2p } from "libp2p";
import { describe, expect, it } from "vitest";

// LIVE public-infrastructure probe — OPT-IN ONLY (`RUN_PUBLIC_LIVE=true`), never a CI gate.
// It sends real traffic to the canonical public Amino bootstrappers and depends on ephemeral
// third-party circuit relays, so it is skipped by default (like the object perf benchmarks).
// Run it with: `pnpm test:public-relay-live`.
//
// What it proves: the CONNECTIVITY half of "boot on public infra with no DRP-operated relay"
// works at the NODE level — a DRP node, connecting only to public bootstrappers, obtains a
// reservation on a REAL public Circuit Relay v2 node via the warm connected-peer HOP harvest
// (no DHT walk; phase-08 measured ~3.6 s, reproduced here in ~1.8 s). It does NOT assert the
// granted relay is browser-usable: the native store takes the first HOP grant, which is often
// tcp/quic-only — preferring a browser-usable relay needs a transport filter (phase-08 §116).
const RUN_LIVE = process.env.RUN_PUBLIC_LIVE === "true";
const describeLive = RUN_LIVE ? describe : describe.skip;

const OFFICIAL_AMINO_BOOTSTRAPPERS = [
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
	"/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
	"/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
	"/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
] as const;

const RESERVE_DEADLINE_MS = 45_000;
const BROWSER_USABLE = /\/wss|\/tls\/ws|\/webrtc-direct|\/webtransport/u;

describeLive("live public-infra connectivity (opt-in: RUN_PUBLIC_LIVE=true)", () => {
	it(
		"reserves a real public circuit relay via the warm connected-peer HOP harvest",
		async () => {
			let host: Libp2p | undefined;
			const hostFactory: DRPNetworkHostFactory = async (context) => {
				host = await context.createHost(createAminoHostExtensions({ mode: "client", network: "public" }));
				return host;
			};
			const node = new DRPNetworkNode(
				{
					bootstrap_peers: [...OFFICIAL_AMINO_BOOTSTRAPPERS],
					// A single generic `/p2p-circuit` listen arms native discovery for exactly one reservation.
					listen_addresses: ["/p2p-circuit"],
					log_config: { level: "silent" },
				},
				{ hostFactory }
			);

			const startedAt = Date.now();
			try {
				await node.start();

				let circuit: string[] = [];
				const deadline = Date.now() + RESERVE_DEADLINE_MS;
				while (Date.now() < deadline) {
					circuit = (node.getMultiaddrs?.() ?? []).map(String).filter((address) => address.includes("/p2p-circuit"));
					if (circuit.length > 0) break;
					await new Promise((resolve) => setTimeout(resolve, 250));
				}

				const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
				const browserUsable = circuit.some((address) => BROWSER_USABLE.test(address));
				console.log(
					`[public-relay-live] reserved ${circuit.length} circuit addr(s) in ${elapsedSeconds}s ` +
						`(browser-usable relay: ${browserUsable ? "yes" : "no — node-usable only"})`
				);
				for (const address of circuit) {
					console.log(`  ${address}`);
				}

				// The load-bearing assertion: a live public relay granted this node a reservation.
				expect(circuit.length).toBeGreaterThan(0);
			} finally {
				await node.stop();
			}
		},
		RESERVE_DEADLINE_MS + 20_000
	);
});

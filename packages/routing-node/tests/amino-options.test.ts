import type * as KadDhtModule from "@libp2p/kad-dht";
import { afterEach, describe, expect, it, vi } from "vitest";

const capturedDhtOptions = vi.hoisted((): KadDhtModule.KadDHTInit[] => []);

vi.mock("@libp2p/kad-dht", async (importOriginal) => {
	const actual = await importOriginal<typeof KadDhtModule>();
	return {
		...actual,
		kadDHT: (options: KadDhtModule.KadDHTInit = {}): ReturnType<typeof actual.kadDHT> => {
			capturedDhtOptions.push(options);
			return actual.kadDHT(options);
		},
	};
});

import { createAminoHostExtensions, createNodeRouting } from "../src/index.js";

describe("Amino DHT query tuning", () => {
	afterEach(() => {
		capturedDhtOptions.length = 0;
	});

	it("keeps conservative alpha and disjoint paths for the shared public anchor DHT", () => {
		createAminoHostExtensions({ mode: "client", network: "public" });

		expect(capturedDhtOptions).toHaveLength(1);
		expect(capturedDhtOptions[0]).toMatchObject({ allowQueryWithZeroPeers: false, clientMode: true });
		expect(capturedDhtOptions[0]?.alpha).toBe(1);
		expect(capturedDhtOptions[0]?.disjointPaths).toBe(1);
		expect(capturedDhtOptions[0]?.initialQuerySelfInterval).toBeUndefined();
		expect(capturedDhtOptions[0]?.querySelfInterval).toBe(24 * 60 * 60 * 1_000);
	});

	it("lets a cold local host answer zero-peer queries immediately instead of parking forever", () => {
		// On the PUBLIC path allowQueryWithZeroPeers:false parks empty-table queries so the
		// circuit-relay RandomWalk (libp2p random-walk.js `while (walkers > 0)`, no backoff) cannot
		// spin on instantly-empty getClosestPeers at cold start (phase-08: event-loop starvation).
		// On LOCAL/PRIVATE it must be true: a DHT server whose only neighbours are kad clients has a
		// permanently empty routing table (clients are never added to routing tables), so parking would
		// turn locally-answerable provide/findProviders into guard timeouts — the exact hang that broke
		// public-only-node-publisher.test.ts (phase-09 addendum). The busy-loop is not armed on the
		// local test topologies (they pass explicit listen_addresses, no `/p2p-circuit`).
		createAminoHostExtensions({ mode: "client", network: "local" });

		expect(capturedDhtOptions).toHaveLength(1);
		expect(capturedDhtOptions[0]?.allowQueryWithZeroPeers).toBe(true);
	});

	it("forwards explicitly bounded concurrency for an overflow-discovery routing instance", async () => {
		const routing = await createNodeRouting({
			alpha: 2,
			bootstrapPeers: [],
			disjointPaths: 3,
			mode: "client",
			network: "public",
		});
		try {
			expect(capturedDhtOptions.at(-1)?.alpha).toBe(2);
			expect(capturedDhtOptions.at(-1)?.disjointPaths).toBe(3);
		} finally {
			await routing.stop();
		}
	});

	it("rejects invalid Amino concurrency before creating a DHT", () => {
		expect(() => createAminoHostExtensions({ alpha: 0, network: "public" })).toThrow(/alpha/u);
		expect(() => createAminoHostExtensions({ disjointPaths: 9, network: "public" })).toThrow(/disjointPaths/u);
	});
});

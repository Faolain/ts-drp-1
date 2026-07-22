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

	it("does not arm an instantly-empty zero-peer query loop on a cold local host either", () => {
		createAminoHostExtensions({ mode: "client", network: "local" });

		expect(capturedDhtOptions).toHaveLength(1);
		expect(capturedDhtOptions[0]?.allowQueryWithZeroPeers).toBe(false);
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

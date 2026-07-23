import { AMINO_DHT_PROTOCOL, type RoutingMeasurement } from "@ts-drp/routing-node";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runLocalAminoFixture } from "../src/node-routing/fixture.js";
import { assertSanitizedEvidenceOutputRoot, createPublicCanaryArtifacts } from "../src/node-routing/public-evidence.js";
import { parseProbeJsonLines, type ProbeEvent } from "../src/probe/index.js";

const TEST_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";

describe("Node routing spike fixtures", () => {
	it("proves local client-mode routing through the campaign evidence harness", async () => {
		const fixture = await runLocalAminoFixture();
		expect(fixture.result).toMatchObject({
			status: "success",
			value: {
				autonatAvailable: true,
				closestPeerCount: 1,
				findPeerSucceeded: true,
				observedAddressScopes: ["loopback"],
				providerVisible: true,
				routingTableSize: 1,
				transportBytesMeasured: false,
			},
		});
		expect(parseProbeJsonLines(fixture.jsonl)).toEqual(fixture.events);
		expect(fixture.jsonl).not.toMatch(/12D3Koo|Qm[1-9A-HJ-NP-Za-km-z]{40}/u);
		expect(fixture.events.filter(({ kind }) => kind === "routing-query")).toHaveLength(4);
		expect(fixture.events.filter(({ kind }) => kind === "autonat-reachability")).toContainEqual(
			expect.objectContaining({ details: { status: "private" } })
		);
		expect(fixture.events.filter(({ kind }) => kind === "identify-protocols")).toContainEqual(
			expect.objectContaining({
				details: { protocols: expect.arrayContaining([AMINO_DHT_PROTOCOL, "/ipfs/id/1.0.0"]) },
			})
		);
		const resourceSamples = fixture.events.filter(
			(event): event is Extract<ProbeEvent, { kind: "resource-sample" }> => event.kind === "resource-sample"
		);
		const initialOpenHandles = resourceSamples[0]?.details.openHandles ?? Number.POSITIVE_INFINITY;
		expect(fixture.events.at(-2)).toMatchObject({ details: { activeTimers: 0 }, kind: "resource-sample" });
		expect(resourceSamples.at(-1)?.details.openHandles).toBeLessThanOrEqual(initialOpenHandles);
		expect(fixture.events.at(-1)).toMatchObject({
			details: { reason: "completed", status: "success" },
			kind: "terminal",
		});
	}, 10_000);

	it("builds Phase 00-bound redacted public artifacts and rejects unsafe durable paths", async () => {
		const artifacts = await createPublicCanaryArtifacts({
			addressScopes: ["public"],
			closestPeerIds: [TEST_PEER_ID],
			dhtRequestBudget: 2,
			dialable: true,
			finishedAt: "2026-07-20T08:00:01.000Z",
			measurements: [measurement()],
			namespace: "drp/private-node-canary",
			reachabilityObservations: [
				{
					atMs: 1,
					autonat: "available",
					basis: "verified-address-set",
					dialable: true,
					observedAddressScopes: ["public"],
					source: "self-peer-update",
					status: "public",
				},
			],
			routingTableSize: 1,
			runId: "phase02-fixture",
			salt: new Uint8Array(32).fill(7),
			startedAt: "2026-07-20T08:00:00.000Z",
		});
		expect(artifacts.manifest.target).toBe("node");
		expect(artifacts.manifest.evidenceChecksums).toHaveProperty("node-routing-evidence.json");
		expect(artifacts.evidence.peerPseudonyms).toEqual([expect.stringMatching(/^peer_[a-f0-9]{12}$/u)]);
		expect(JSON.stringify(artifacts)).not.toContain(TEST_PEER_ID);
		expect(() => assertSanitizedEvidenceOutputRoot("../evidence")).toThrow(/must remain beneath/u);
		expect(() => assertSanitizedEvidenceOutputRoot("/tmp/evidence")).toThrow(/must remain beneath/u);
		expect(assertSanitizedEvidenceOutputRoot("specs/done/public-network-spike/evidence")).toMatch(
			/specs\/done\/public-network-spike\/evidence$/u
		);
	});
});

describe("network-spike browser bundle firewall", () => {
	it("keeps the universal entry free of Node routing", async () => {
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, unknown>;
		};
		expect(packageJson.exports["./node-routing"]).toBeUndefined();
		const bundle = await build({
			bundle: true,
			entryPoints: [`${packageRoot}/src/index.ts`],
			metafile: true,
			platform: "browser",
			external: ["node:*"],
			write: false,
		});
		const inputs = Object.keys(bundle.metafile?.inputs ?? {});
		expect(inputs.some((input) => input.includes("@libp2p+kad-dht"))).toBe(false);
		expect(inputs.some((input) => input.includes("@libp2p+tcp"))).toBe(false);
		expect(inputs.some((input) => input.includes("/routing-node/src/index.ts"))).toBe(false);
	});
});

function measurement(): RoutingMeasurement {
	return {
		connectionCount: 1,
		cpuSystemMicros: 20,
		cpuUserMicros: 30,
		durationMs: 100,
		logicalReceivedBytes: 40,
		logicalSentBytes: 50,
		networkRequestsConsumed: 1,
		operation: "getClosestPeers",
		rssAfterBytes: 1_100,
		rssBeforeBytes: 1_000,
		transportBytes: {
			reason: "not-exposed-by-libp2p-public-api",
			status: "unavailable",
		},
	};
}

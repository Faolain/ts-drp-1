import { describe, expect, it } from "vitest";

import {
	assessBrowserDhtObservation,
	BROWSER_DHT_PACKAGE_VERSIONS,
	type BrowserDhtVerdictBase,
} from "../src/browser-dht/index.js";

describe("browser full-DHT feasibility assessment", () => {
	it("rejects a completed provider RPC when the browser has no dialable provider address", () => {
		const verdict = assessBrowserDhtObservation(base());

		expect(verdict).toMatchObject({
			reason: "browser-provider-has-no-dialable-address",
			status: "rejected",
		});
	});

	it("rejects a construction failure before transport checks", () => {
		const observation = base();
		observation.checks.construction = false;

		expect(assessBrowserDhtObservation(observation, new Error("unsupported crypto"))).toMatchObject({
			detail: "Error: unsupported crypto",
			reason: "construction-failed",
			status: "rejected",
		});
	});

	it("returns supported only when publication is observed with a browser-dialable address", () => {
		const observation = base();
		observation.checks.providerObserved = true;
		observation.transport.providerAddresses = ["/dns4/provider.test/tcp/443/wss"];
		observation.transport.dialableProviderAddresses = ["/dns4/provider.test/tcp/443/wss"];

		expect(assessBrowserDhtObservation(observation)).toMatchObject({ status: "supported" });
	});

	it("does not misclassify an interrupted provider query as an address rejection", () => {
		const observation = base();
		observation.checks.providerQueryCompleted = false;

		expect(assessBrowserDhtObservation(observation, new Error("query deadline"))).toMatchObject({
			detail: "Error: query deadline",
			reason: "provider-query-failed",
			status: "rejected",
		});
	});
});

function base(): BrowserDhtVerdictBase {
	return {
		browser: "test-browser",
		checks: {
			bootstrapConnected: true,
			construction: true,
			peerLookup: true,
			providerObserved: false,
			providerQueryCompleted: true,
			providerRpcCompleted: true,
		},
		dhtMode: "client",
		packageVersions: BROWSER_DHT_PACKAGE_VERSIONS,
		resources: {
			cpu: { reason: "test", status: "unavailable" },
			heap: { reason: "test", status: "unavailable" },
			loadedTransferBytes: 0,
			wallTimeMs: 1,
		},
		run: {
			finishedAt: "2026-07-20T12:00:00.001Z",
			fixtureClass: "local-loopback-websocket",
			id: "dht-test",
			startedAt: "2026-07-20T12:00:00.000Z",
			steps: [],
			timeoutMs: 8_000,
		},
		routingTable: { observerPeers: 1, publisherPeers: 1 },
		transport: {
			browserListenAddresses: [],
			constraint: "outbound-websocket-only",
			dialableProviderAddresses: [],
			fixtureAddress: "/ip4/127.0.0.1/tcp/4176/ws/p2p/test",
			providerAddresses: [],
		},
	};
}

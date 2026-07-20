import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { GridBrowserTrace } from "@ts-drp/network-spike/grid/fixture";
import { createRegistryFixture } from "@ts-drp/network-spike/registry/fixture";

test.describe("Phase 07 two-page grid success", () => {
	// Browser startup and teardown share the outer envelope; protocol-specific
	// reservation/recovery deadlines remain asserted independently below.
	test.describe.configure({ timeout: 60_000 });
	for (let repetition = 1; repetition <= 5; repetition += 1) {
		test(`repetition ${repetition}: independent pages rendezvous, synchronize, upgrade, and recover`, async ({
			context,
			page,
		}) => {
			const creator = await openCreator(page, "success", repetition);
			expect(creator.role).toBe("creator");
			expect(creator.record.expiresAtMs - creator.record.issuedAtMs).toBe(60_000);
			expect(creator.readiness).toBe("signed-relay-record-registered");

			const { joiner, joinerPage } = await openJoiner(context, page);
			expect(joiner).toMatchObject({
				antiCheat: {
					preAuthPxCandidates: 0,
					topologyDialAttempts: 0,
					topologyGaterRejections: 2,
				},
				bootstrapPeers: [],
				creatorPeerInputFields: 0,
				hostSnapshot: {
					bootstrapDiscovery: false,
					bootstrapPeerCount: 0,
					coldStartPubsubDiscovery: false,
					gossipSubPeerExchange: false,
					outboundAddressPolicy: "injected",
					peerDiscoveryModules: [],
				},
				provenance: [
					"rendezvous register",
					"discover",
					"validate",
					"routing-backed relay candidate",
					"reservation",
					"dial",
				],
				recordValidation: "accepted",
				relayReservations: 1,
				role: "joiner",
				terminal: "success",
			});
			expect(joiner.movements.length).toBeGreaterThanOrEqual(5);
			expect(new Set(joiner.movements.map(({ actor }) => actor))).toEqual(new Set(["creator", "joiner"]));
			expect(joiner.positions.creator).toEqual({ x: 1, y: 1 });
			expect(joiner.positions.joiner).toEqual({ x: 0, y: -1 });
			expect(joiner.direct).toMatchObject({
				correlation: "runtime-observed",
				correlationBasis: "unique-libp2p-webrtc-connection-and-init-datachannel",
				dataChannelOpen: true,
				libp2pTransport: "webrtc",
				transport: "webrtc",
			});
			expect(joiner.direct?.libp2pAddress).toContain("/webrtc");
			expect(joiner.direct?.iceCandidateTypes).toHaveLength(2);
			expect(joiner.direct?.iceCandidateTypes).not.toContain("relay");
			expect(joiner.direct?.directBytesSent).toBeGreaterThan(0);
			expect(joiner.direct?.directBytesReceived).toBeGreaterThan(0);
			expect(joiner.direct?.relayedBytesSent).toBeGreaterThan(0);
			expect(joiner.direct?.relayedBytesReceived).toBeGreaterThan(0);
			expect(joiner.direct?.connectionId).toBeTruthy();
			expect(joiner.direct?.rtcPeerConnectionId).toBeTruthy();
			expect(joiner.relayRouting).toMatchObject({
				operation: "get-closest-peers",
				resultCount: 2,
				terminal: "success",
			});
			expect(joiner.relayRouting?.attempts[0]).toMatchObject({
				endpointId: "grid-primary",
				status: "success",
			});
			expect(joiner.relayAttempts).toHaveLength(1);
			expect(joiner.relayAttempts[0]).toMatchObject({
				hopAdvertised: true,
				reservationStatus: 100,
				status: "reserved",
			});
			expect(joiner.relayAttempts[0]?.candidate.provenance).toMatchObject({
				origin: "browser-closest-peers",
				resultIndex: 1,
				routingSource: "delegated-routing",
			});
			expect(joiner.recovery).toMatchObject({
				directRetained: true,
				postRemovalConverged: true,
				replacementPeerId: "16Uiu2HAmT72TapomemeWskZbmzd4hZcakAzYnTwLtbdsvdaSUvXU",
				selectedRelayRemoved: true,
			});
			expect(joiner.recovery?.durationMs).toBeLessThanOrEqual(5_000);
			expect(joiner.assertions.every(({ passed }) => passed)).toBe(true);

			await expect
				.poll(async () => (await readTrace(page)).positions.joiner, { timeout: 5_000 })
				.toEqual({ x: 0, y: -1 });
			await expect(page.locator("[data-grid-ready]")).toHaveAttribute("data-role", "creator");
			await joinerPage.close();
		});
	}
});

test.describe("Phase 07 relay exhaustion", () => {
	for (let repetition = 1; repetition <= 5; repetition += 1) {
		test(`repetition ${repetition}: real bounded policy reaches typed exhaustion without WebRTC`, async ({
			context,
			page,
		}) => {
			await openCreator(page, "exhaustion", repetition);
			const { joiner, joinerPage } = await openJoiner(context, page);

			expect(joiner).toMatchObject({
				bootstrapPeers: [],
				creatorPeerInputFields: 0,
				provenance: ["rendezvous register", "discover", "validate", "routing-backed relay candidate"],
				relayReservations: 0,
				role: "joiner",
				terminal: "exhausted",
			});
			expect(joiner.direct).toBeUndefined();
			expect(joiner.fallbackInitiatedAtMs).toBeLessThanOrEqual(5_000);
			expect(joiner.relayRouting).toMatchObject({
				operation: "get-closest-peers",
				resultCount: 2,
				terminal: "success",
			});
			expect(joiner.relayAttempts).toHaveLength(2);
			expect(joiner.relayAttempts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						connectionId: expect.any(String),
						hopAdvertised: true,
						reservationStatus: 200,
						status: "refused",
					}),
					expect.objectContaining({
						connectionId: expect.any(String),
						hopAdvertised: true,
						reservationStatus: 200,
						status: "refused",
					}),
				])
			);
			expect(joiner.movements).toEqual([]);
			expect(joiner.assertions.every(({ passed }) => passed)).toBe(true);
			await joinerPage.close();
		});
	}
});

test("Phase 07 labeled Node-creator DHT-anchor case advertises only the configured Node", async () => {
	const evidence = await createRegistryFixture();
	const semantics = evidence.cases.find(({ label }) => label === "Anchor semantics");
	const publisher = evidence.cases.find(({ label }) => label === "Anchor publishes itself");
	expect(semantics).toMatchObject({ actual: "configured-node-anchor-only", passed: true });
	expect(publisher).toMatchObject({ actual: "anchor-A", passed: true });
	expect(evidence.comparison.find(({ path }) => path === "dht-anchor")?.discoveryResult).toBe(
		"1 Node anchor; browser publisher is not advertised"
	);
});

async function openCreator(
	page: Page,
	scenario: "exhaustion" | "success",
	repetition: number
): Promise<GridBrowserTrace> {
	await page.goto(`/grid/creator?scenario=${scenario}&run=${repetition}`);
	await expect(page.locator("[data-grid-ready]")).toHaveAttribute("data-role", "creator", { timeout: 30_000 });
	await expect(page.locator("[data-join-url]")).toHaveAttribute("href", /namespace=.*object=/u);
	return readTrace(page);
}

async function openJoiner(
	context: BrowserContext,
	creatorPage: Page
): Promise<{ readonly joiner: GridBrowserTrace; readonly joinerPage: Page }> {
	const joinUrl = await creatorPage.locator("[data-join-url]").getAttribute("href");
	if (joinUrl === null) throw new Error("creator page omitted join URL");
	expect(joinUrl).not.toContain("peerId=");
	expect(joinUrl).not.toContain("peer=");
	expect(joinUrl).not.toContain("record=");
	const joinerPage = await context.newPage();
	await joinerPage.goto(joinUrl);
	await expect(joinerPage.locator("[data-grid-ready]")).toHaveAttribute("data-role", "joiner", { timeout: 30_000 });
	return { joiner: await readTrace(joinerPage), joinerPage };
}

async function readTrace(page: Page): Promise<GridBrowserTrace> {
	const raw = await page.locator("[data-trace-json]").textContent();
	if (raw === null) throw new Error("grid trace missing");
	return JSON.parse(raw) as GridBrowserTrace;
}

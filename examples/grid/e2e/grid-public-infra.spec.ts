import { expect, type Page, test } from "@playwright/test";

// End-to-end proof of the infra-independent discovery path: two real browsers cold-start
// with NO HTTP registry (VITE_RENDEZVOUS_ENDPOINTS is empty) and NO fixed bootstrap seeds,
// discover each other purely through the Nostr rendezvous backend (a local `ws` relay
// fixture standing in for a public relay), connect through a Circuit Relay v2 relay, join
// the same grid, and converge shared state. Because the only configured rendezvous source
// is Nostr, mutual discovery is itself the proof the Nostr path carried it.

interface PublicInfraSnapshot {
	readonly bootstrapPeers: readonly string[];
	readonly connections: readonly { readonly multiaddr: string; readonly transport: string }[];
	readonly controlPlaneEvents: readonly { readonly kind: string; readonly outcome?: string }[];
	readonly membershipMode: string;
	readonly peerId: string;
	readonly relayReservations: readonly { readonly operatorGroup: string; readonly peerId: string }[];
	readonly rendezvous?: {
		readonly sources: readonly { readonly id: string; readonly status: string }[];
	};
}

test.beforeEach(async ({ request }, testInfo) => {
	test.skip(testInfo.config.metadata.gridNetworkMode !== "public-infra", "requires the public-infra grid harness");
	await Promise.all([request.post("http://127.0.0.1:51000/start"), request.post("http://127.0.0.1:51002/start")]);
	// Clear the local Nostr fixture so sequential browser projects (chromium→firefox→webkit) never
	// discover a prior project's stale records. Best-effort: a no-op against real public relays.
	await request.post("http://127.0.0.1:4180/reset").catch(() => undefined);
});

test.afterEach(async ({ request }, testInfo) => {
	if (testInfo.config.metadata.gridNetworkMode !== "public-infra") return;
	await request.post("http://127.0.0.1:4180/reset").catch(() => undefined);
});

test("two browsers discover each other over Nostr and converge with no HTTP registry", async ({ browser }) => {
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	try {
		const creatorPage = await creatorContext.newPage();
		await openGrid(creatorPage);

		const creatorStart = await readSnapshot(creatorPage);
		expect(creatorStart.bootstrapPeers).toEqual([]);
		expect(creatorStart.membershipMode).toBe("invite");

		// Creator reserves a relay and publishes its signed record to the Nostr relay. The first
		// registration can lose a startup race (relay address / socket not yet ready); the refresh
		// loop re-registers, so poll the MOST RECENT registration outcome.
		await expect.poll(async () => (await readSnapshot(creatorPage)).relayReservations.length).toBe(1);
		await expect
			.poll(async () => latestRegistrationOutcome(await readSnapshot(creatorPage)))
			.toMatch(/accepted|partial/u);

		const joinerPage = await joinerContext.newPage();
		await openGrid(joinerPage);
		await expect.poll(async () => (await readSnapshot(joinerPage)).relayReservations.length).toBe(1);

		// The joiner's only rendezvous source is Nostr; a "succeeded" source proves discovery
		// flowed through the Nostr relay (there is no HTTP registry configured).
		await expect
			.poll(async () => (await readSnapshot(joinerPage)).rendezvous?.sources.some((s) => s.status === "succeeded"))
			.toBe(true);

		const joinerStart = await readSnapshot(joinerPage);
		expect(joinerStart.bootstrapPeers).toEqual([]);

		await creatorPage.click("#createGrid");
		await expect(creatorPage.locator("#gridId")).not.toBeEmpty();
		const gridId = (await creatorPage.locator("#gridId").textContent())?.trim();
		if (gridId === undefined || gridId === "") throw new Error("creator did not expose a grid ID");
		await joinerPage.fill("#gridInput", gridId);
		await joinerPage.click("#joinGrid");

		// Mutual peer presence: each browser found the other only via Nostr discovery.
		await expect(creatorPage.locator("#objectPeers")).toContainText(joinerStart.peerId);
		await expect(joinerPage.locator("#objectPeers")).toContainText(creatorStart.peerId);

		// Shared state converges: the creator's dot is visible on the joiner and moves live.
		const creatorDot = joinerPage.locator(`[data-glowing-peer-id="${creatorStart.peerId}"]`);
		await expect(creatorDot).toBeVisible();
		const beforeMove = await creatorDot.getAttribute("style");
		await creatorPage.keyboard.press("w");
		await expect.poll(async () => creatorDot.getAttribute("style")).not.toBe(beforeMove);

		// A live connection exists — direct WebRTC where the network allows, relayed otherwise.
		const joined = await readSnapshot(joinerPage);
		const connected = joined.connections.some(
			(c) => c.transport === "webrtc" || c.transport === "relay" || c.multiaddr.includes("/p2p-circuit")
		);
		expect(connected).toBe(true);
	} finally {
		await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
	}
});

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() =>
		Boolean((window as typeof window & { __TS_DRP_GRID_SESSION__?: unknown }).__TS_DRP_GRID_SESSION__)
	);
	await expect(page.locator("#loadingMessage")).toBeHidden();
}

async function readSnapshot(page: Page): Promise<PublicInfraSnapshot> {
	return page.evaluate(() => {
		const session = (window as typeof window & { __TS_DRP_GRID_SESSION__?: { snapshot(): PublicInfraSnapshot } })
			.__TS_DRP_GRID_SESSION__;
		if (session === undefined) throw new Error("public-infra grid session is not ready");
		return session.snapshot();
	});
}

function latestRegistrationOutcome(snapshot: PublicInfraSnapshot): string | undefined {
	return snapshot.controlPlaneEvents.filter((event) => event.kind === "rendezvous-registration").at(-1)?.outcome;
}

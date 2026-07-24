import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { createHash } from "node:crypto";

const PRIMARY_RELAY_ID = "16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5";
const REPLACEMENT_RELAY_ID = "16Uiu2HAmT72TapomemeWskZbmzd4hZcakAzYnTwLtbdsvdaSUvXU";

interface ModularSnapshot {
	readonly bootstrapPeers: readonly string[];
	readonly connections: readonly { readonly multiaddr: string; readonly peerId: string; readonly transport: string }[];
	readonly controlPlaneEvents: readonly {
		readonly kind: string;
		readonly outcome?: string;
	}[];
	readonly membershipMode: string;
	readonly peerId: string;
	readonly relayPolicy?: {
		readonly attempts: readonly {
			readonly candidate: {
				readonly provenance: { readonly origin: string; readonly routingSource: string };
			};
			readonly status: string;
		}[];
		readonly terminal: string;
	};
	readonly relayReservations: readonly {
		readonly operatorGroup: string;
		readonly peerId: string;
	}[];
	readonly rendezvous?: {
		readonly recordRejectedCount: number;
		readonly sources: readonly { readonly id: string; readonly status: string }[];
	};
	readonly routing?: { readonly resultCount: number; readonly terminal: string };
}

test.beforeEach(async ({ request }, testInfo) => {
	test.skip(testInfo.config.metadata.gridNetworkMode !== "modular", "requires the dedicated modular grid harness");
	// Clear any records left by a prior run (browser projects share these fixtures) so a joiner never
	// discovers a previous run's stale, higher-sequence creator record. reset also marks both registries up.
	await request.post("http://127.0.0.1:4175/grid-control/registry/reset");
	await Promise.all([request.post("http://127.0.0.1:51000/start"), request.post("http://127.0.0.1:51002/start")]);
});

test.afterEach(async ({ request }, testInfo) => {
	if (testInfo.config.metadata.gridNetworkMode !== "modular") return;
	await Promise.allSettled([
		request.post("http://127.0.0.1:4175/grid-control/registry/reset"),
		request.post("http://127.0.0.1:51000/start"),
		request.post("http://127.0.0.1:51002/start"),
	]);
});

test("cold-starts, authenticates, converges, and recovers without fixed bootstrap peers", async ({
	browser,
	request,
}) => {
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	try {
		const creatorPage = await creatorContext.newPage();
		await openModularGrid(creatorPage);
		await expect.poll(async () => (await readSnapshot(creatorPage)).relayReservations.length).toBe(1);
		await expect.poll(async () => registrationOutcome(await readSnapshot(creatorPage))).toMatch(/accepted|partial/u);

		const creatorBeforeOutage = await readSnapshot(creatorPage);
		expect(creatorBeforeOutage.bootstrapPeers).toEqual([]);
		expect(creatorBeforeOutage.membershipMode).toBe("invite");
		expect(creatorBeforeOutage.relayPolicy?.terminal).toBe("reserved");

		await request.post("http://127.0.0.1:4175/grid-control/registry/primary/down");
		const joinerPage = await joinerContext.newPage();
		await openModularGrid(joinerPage);
		await expect.poll(async () => registrationOutcome(await readSnapshot(joinerPage))).toBe("partial");
		await expect.poll(async () => (await readSnapshot(joinerPage)).relayReservations.length).toBe(1);
		await expect.poll(async () => (await readSnapshot(joinerPage)).routing?.terminal).toBe("success");
		await expect
			.poll(async () =>
				(await readSnapshot(joinerPage)).relayPolicy?.attempts.some(
					(attempt) =>
						attempt.status === "reserved" &&
						attempt.candidate.provenance.origin === "browser-closest-peers" &&
						attempt.candidate.provenance.routingSource === "delegated-routing"
				)
			)
			.toBe(true);
		const joinerColdStart = await readSnapshot(joinerPage);
		expect(joinerColdStart.bootstrapPeers).toEqual([]);
		expect(joinerColdStart.membershipMode).toBe("invite");

		await creatorPage.click("#createGrid");
		await expect(creatorPage.locator("#gridId")).not.toBeEmpty();
		const gridId = (await creatorPage.locator("#gridId").textContent())?.trim();
		if (gridId === undefined || gridId === "") throw new Error("creator did not expose a grid ID");
		await joinerPage.fill("#gridInput", gridId);
		await joinerPage.click("#joinGrid");
		// An idle browser is healthy without peers, so peer dialing only starts once the join subscribes
		// an object. The rendezvous source trace now reflects whichever join-time bootstrap ran last
		// (the room-namespace fallback is legitimately "empty" here), so registry discovery with the
		// primary down is proven by the registration "partial" above plus this successful dial and the
		// convergence assertions below — not by polling the last-writer-racy trace.
		await expect
			.poll(async () =>
				(await readSnapshot(joinerPage)).controlPlaneEvents.some(
					(event) => event.kind === "dial-attempt" && event.outcome === "ok"
				)
			)
			.toBe(true);

		await expect(creatorPage.locator("#objectPeers")).toContainText(joinerColdStart.peerId);
		await expect(joinerPage.locator("#objectPeers")).toContainText(creatorBeforeOutage.peerId);
		const creatorDot = joinerPage.locator(`[data-glowing-peer-id="${creatorBeforeOutage.peerId}"]`);
		await expect(creatorDot).toBeVisible();
		const beforeRegistryOutageMove = await creatorDot.getAttribute("style");
		await creatorPage.keyboard.press("w");
		await expect.poll(async () => creatorDot.getAttribute("style")).not.toBe(beforeRegistryOutageMove);

		const joinedSnapshot = await readSnapshot(joinerPage);
		const hasDirectWebRtc = joinedSnapshot.connections.some(
			(connection) => connection.transport === "webrtc" && !connection.multiaddr.includes("/p2p-circuit")
		);
		const hasRelayedPath = joinedSnapshot.connections.some(
			(connection) => connection.transport === "relay" || connection.multiaddr.includes("/p2p-circuit")
		);
		expect(hasDirectWebRtc || hasRelayedPath).toBe(true);

		const selected = joinedSnapshot.relayReservations[0];
		if (selected === undefined) throw new Error("joiner did not retain a relay reservation");
		const selectedControlPort = selected.peerId === PRIMARY_RELAY_ID ? 51000 : 51002;
		expect([PRIMARY_RELAY_ID, REPLACEMENT_RELAY_ID]).toContain(selected.peerId);
		await request.post(`http://127.0.0.1:${selectedControlPort}/stop`);
		await expect
			.poll(async () => (await readSnapshot(joinerPage)).relayReservations[0]?.peerId, { timeout: 10_000 })
			.not.toBe(selected.peerId);

		const recovered = await readSnapshot(joinerPage);
		expect(recovered.bootstrapPeers).toEqual([]);
		expect(recovered.relayReservations[0]?.operatorGroup).not.toBe(selected.operatorGroup);
		// Relay loss is telemetered either as a relay-policy "replaced" or as the coordinator releasing the
		// lost reservation and acquiring a new one; both represent the same recovery. The substantive
		// "different operator group" guarantee is asserted above.
		expect(
			recovered.controlPlaneEvents.some(
				(event) => event.kind === "relay-reservation" && (event.outcome === "replaced" || event.outcome === "released")
			)
		).toBe(true);
		const beforeRelayLossMove = await creatorDot.getAttribute("style");
		await creatorPage.keyboard.press("d");
		await expect.poll(async () => creatorDot.getAttribute("style")).not.toBe(beforeRelayLossMove);
	} finally {
		await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
	}
});

test("keeps a room joinable through a surviving replica after the creator leaves", async ({ browser, request }) => {
	const creatorContext = await browser.newContext();
	const replicaContext = await browser.newContext();
	const lateJoinerContext = await browser.newContext();
	try {
		const creatorPage = await creatorContext.newPage();
		await openModularGrid(creatorPage);
		await expect.poll(async () => (await readSnapshot(creatorPage)).relayReservations.length).toBe(1);
		await expect.poll(async () => registrationOutcome(await readSnapshot(creatorPage))).toMatch(/accepted|partial/u);
		const creatorPeerId = (await readSnapshot(creatorPage)).peerId;

		await creatorPage.click("#createGrid");
		await expect(creatorPage.locator("#gridId")).not.toBeEmpty();
		const gridId = (await creatorPage.locator("#gridId").textContent())?.trim();
		if (gridId === undefined || gridId === "") throw new Error("creator did not expose a grid ID");

		const replicaPage = await replicaContext.newPage();
		await openModularGrid(replicaPage);
		await expect.poll(async () => (await readSnapshot(replicaPage)).relayReservations.length).toBe(1);
		await expect.poll(async () => registrationOutcome(await readSnapshot(replicaPage))).toMatch(/accepted|partial/u);
		const replicaPeerId = (await readSnapshot(replicaPage)).peerId;
		await replicaPage.fill("#gridInput", gridId);
		await replicaPage.click("#joinGrid");
		await expect(creatorPage.locator("#objectPeers")).toContainText(replicaPeerId);
		await expect(replicaPage.locator("#objectPeers")).toContainText(creatorPeerId);

		// The surviving replica must be discoverable through the ROOM namespace itself
		// before the creator leaves — in this two-node fixture the app-wide namespace
		// would also connect a late joiner, so the room record is asserted explicitly.
		const namespace = roomNamespaceFor(gridId);
		await expect
			.poll(async () => discoveredPeers(request, namespace), { intervals: [1_000], timeout: 20_000 })
			.toContain(replicaPeerId);

		// Creator leaves; its registry records stay live until TTL, so the late joiner
		// exercises the realistic path: stale creator record first, room fallback after.
		await creatorContext.close();

		const lateJoinerPage = await lateJoinerContext.newPage();
		await openModularGrid(lateJoinerPage);
		await expect.poll(async () => (await readSnapshot(lateJoinerPage)).relayReservations.length).toBe(1);
		await expect.poll(async () => registrationOutcome(await readSnapshot(lateJoinerPage))).toMatch(/accepted|partial/u);
		const lateJoinerPeerId = (await readSnapshot(lateJoinerPage)).peerId;
		await lateJoinerPage.fill("#gridInput", gridId);
		await lateJoinerPage.click("#joinGrid");

		await expect(lateJoinerPage.locator("#objectPeers")).toContainText(replicaPeerId, { timeout: 30_000 });
		await expect(replicaPage.locator("#objectPeers")).toContainText(lateJoinerPeerId, { timeout: 30_000 });

		// The synced history still contains the departed creator's presence, and live
		// edits made by the surviving replica reach the late joiner. Idle browsers no
		// longer pre-dial strangers, so the join-time circuit dial + WebRTC upgrade +
		// state sync all happen inside this window — match the 30s join budget above.
		await expect(lateJoinerPage.locator(`[data-glowing-peer-id="${creatorPeerId}"]`)).toBeVisible({
			timeout: 30_000,
		});
		const replicaDotOnLateJoiner = lateJoinerPage.locator(`[data-glowing-peer-id="${replicaPeerId}"]`);
		await expect(replicaDotOnLateJoiner).toBeVisible({ timeout: 30_000 });
		const beforeReplicaMove = await replicaDotOnLateJoiner.getAttribute("style");
		await replicaPage.keyboard.press("d");
		await expect.poll(async () => replicaDotOnLateJoiner.getAttribute("style")).not.toBe(beforeReplicaMove);
	} finally {
		await Promise.allSettled([creatorContext.close(), replicaContext.close(), lateJoinerContext.close()]);
	}
});

function roomNamespaceFor(objectId: string): string {
	return `drp-room:v1:${createHash("sha256").update(objectId).digest("base64url")}`;
}

async function discoveredPeers(request: APIRequestContext, namespace: string): Promise<string> {
	// Alternate registries per call to stay under each one's per-namespace rate window.
	const registries = ["primary", "secondary"];
	const registry = registries[discoverPollCount++ % registries.length];
	const response = await request.post(`http://127.0.0.1:4175/grid-registry/${registry}/v1/discover`, {
		data: { namespace },
	});
	return JSON.stringify(await response.json());
}

let discoverPollCount = 0;

async function openModularGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => {
		return Boolean(
			(window as typeof window & { __TS_DRP_GRID_SESSION__?: { snapshot(): unknown } }).__TS_DRP_GRID_SESSION__
		);
	});
	await expect(page.locator("#loadingMessage")).toBeHidden();
}

async function readSnapshot(page: Page): Promise<ModularSnapshot> {
	return page.evaluate(() => {
		const session = (
			window as typeof window & {
				__TS_DRP_GRID_SESSION__?: { snapshot(): ModularSnapshot };
			}
		).__TS_DRP_GRID_SESSION__;
		if (session === undefined) throw new Error("modular grid session is not ready");
		return session.snapshot();
	});
}

function registrationOutcome(snapshot: ModularSnapshot): string | undefined {
	return snapshot.controlPlaneEvents.find((event) => event.kind === "rendezvous-registration")?.outcome;
}

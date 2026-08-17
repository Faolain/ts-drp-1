import { expect, type Page, test } from "@playwright/test";

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

test("cold-starts, authenticates, and replaces a failed relay without fixed bootstrap peers", async ({
	browser,
	request,
}) => {
	test.setTimeout(180_000);
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	try {
		const creatorPage = await creatorContext.newPage();
		await openModularGrid(creatorPage);
		await expect.poll(async () => (await readSnapshot(creatorPage)).relayReservations.length).toBe(1);
		await expect.poll(async () => registrationOutcome(await readSnapshot(creatorPage))).toMatch(/accepted|partial/u);

		const creatorReady = await readSnapshot(creatorPage);
		expect(creatorReady.bootstrapPeers).toEqual([]);
		expect(creatorReady.membershipMode).toBe("invite");
		expect(creatorReady.relayPolicy?.terminal).toBe("reserved");

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

		const selected = joinerColdStart.relayReservations[0];
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
	} finally {
		await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
	}
});

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

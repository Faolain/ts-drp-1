import { expect, type Page, test } from "@playwright/test";
import { appendFileSync } from "node:fs";

// Fully-public browser convergence — two browsers converge a grid using ONLY public
// infrastructure, no DRP-operated infra at all: discovery via real public Nostr relays,
// connectivity candidates via real public delegated routing (delegated-ipfs.dev
// `/routing/v1/dht/closest/peers`, which surfaces browser-usable AutoTLS relays). OPT-IN and
// flaky by nature (live third-party relays + ephemeral AutoTLS relays); run via
// `pnpm e2e-test:fully-public`. Every hop's evidence (routing trace, relay-policy attempts,
// reservations, the `rendezvous-registration` reason, browser console) is logged to stdout so a
// failed hop is pinpointed, not guessed; set FULLY_PUBLIC_LOG=<path> to also tee it to a file.

const FILE_LOG = process.env.FULLY_PUBLIC_LOG;

function log(line: string): void {
	const entry = `${new Date().toISOString()} ${line}`;

	console.log(entry);
	if (FILE_LOG !== undefined) appendFileSync(FILE_LOG, `${entry}\n`);
}

interface Snapshot {
	readonly bootstrapPeers: readonly string[];
	readonly connections: readonly { readonly multiaddr: string; readonly transport: string }[];
	readonly controlPlaneEvents: readonly {
		readonly kind: string;
		readonly outcome?: string;
		readonly [k: string]: unknown;
	}[];
	readonly peerId: string;
	readonly relayPolicy?: {
		readonly attempts: readonly Record<string, unknown>[];
		readonly candidatesObserved: number;
		readonly operatorGroups: readonly string[];
		readonly reservations: readonly Record<string, unknown>[];
		readonly terminal: string;
	};
	readonly relayReservations: readonly { readonly operatorGroup: string; readonly peerId: string }[];
	readonly rendezvous?: { readonly sources: readonly { readonly id: string; readonly status: string }[] };
	readonly routing?: Record<string, unknown>;
}

// Playwright requires the first beforeEach arg to be an object-destructuring pattern.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
	test.skip(testInfo.config.metadata.gridNetworkMode !== "fully-public", "requires the fully-public harness");
});

test("two browsers converge using only public infrastructure", async ({ browser }, testInfo) => {
	log(`===== RUN START (${testInfo.project.name}) =====`);
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	try {
		const creatorPage = await creatorContext.newPage();
		wireConsole(creatorPage, "creator");
		await openGrid(creatorPage, "creator");

		const creatorStart = await readSnapshot(creatorPage);
		log(`creator peerId=${creatorStart.peerId} bootstrapPeers=${JSON.stringify(creatorStart.bootstrapPeers)}`);

		// HOP 1: does the browser's delegated_closest_peers path reserve a PUBLIC relay?
		const creatorReserved = await pollFor(
			creatorPage,
			"creator relay reservation",
			async () => {
				const snap = await readSnapshot(creatorPage);
				const circuitConn = snap.connections.some((c) => c.multiaddr.includes("/p2p-circuit"));
				return snap.relayReservations.length > 0 || circuitConn;
			},
			90_000
		);
		await dumpRelayEvidence(creatorPage, "creator");
		if (!creatorReserved) {
			log("VERDICT-HOP: creator obtained NO public relay reservation — dumping evidence and failing");
			expect(creatorReserved, "creator reserved a public relay").toBe(true);
		}

		// HOP 2: creator publishes to public Nostr.
		const creatorPublished = await pollFor(
			creatorPage,
			"creator Nostr registration",
			async () => {
				const s = await readSnapshot(creatorPage);
				const latest = s.controlPlaneEvents.filter((e) => e.kind === "rendezvous-registration").at(-1)?.outcome;
				return latest === "accepted" || latest === "partial";
			},
			90_000
		);
		log(`creator Nostr registration ok=${creatorPublished}`);
		if (!creatorPublished) {
			const s = await readSnapshot(creatorPage);
			const regEvents = s.controlPlaneEvents.filter((e) => e.kind === "rendezvous-registration");
			log(`[creator] registration events (${regEvents.length}): ${JSON.stringify(regEvents.slice(-8))}`);
			log(`[creator] rendezvous trace: ${JSON.stringify(s.rendezvous ?? {}).slice(0, 2000)}`);
		}
		expect(creatorPublished, "creator registered on public Nostr").toBe(true);

		// HOP 3: joiner boots, reserves, discovers creator via public Nostr.
		const joinerPage = await joinerContext.newPage();
		wireConsole(joinerPage, "joiner");
		await openGrid(joinerPage, "joiner");
		const joinerStart = await readSnapshot(joinerPage);
		log(`joiner peerId=${joinerStart.peerId}`);

		const joinerReserved = await pollFor(
			joinerPage,
			"joiner relay reservation",
			async () => (await readSnapshot(joinerPage)).relayReservations.length > 0,
			120_000
		);
		await dumpRelayEvidence(joinerPage, "joiner");
		expect(joinerReserved, "joiner reserved a public relay").toBe(true);

		const joinerDiscovered = await pollFor(
			joinerPage,
			"joiner Nostr discovery success",
			async () => {
				const s = await readSnapshot(joinerPage);
				return s.rendezvous?.sources.some((src) => src.status === "succeeded") === true;
			},
			90_000
		);
		log(`joiner Nostr discovery succeeded=${joinerDiscovered}`);
		expect(joinerDiscovered, "joiner discovered via public Nostr").toBe(true);

		// HOP 4: create grid, join, converge THROUGH public relay.
		await creatorPage.click("#createGrid");
		await expect(creatorPage.locator("#gridId")).not.toBeEmpty();
		const gridId = (await creatorPage.locator("#gridId").textContent())?.trim();
		if (gridId === undefined || gridId === "") throw new Error("creator did not expose a grid ID");
		log(`gridId=${gridId}; joiner joining`);
		await joinerPage.fill("#gridInput", gridId);
		await joinerPage.click("#joinGrid");

		const mutual = await pollFor(
			joinerPage,
			"mutual peer presence",
			async () => {
				const c = await creatorPage.locator("#objectPeers").textContent();
				const j = await joinerPage.locator("#objectPeers").textContent();
				return (c ?? "").includes(joinerStart.peerId) && (j ?? "").includes(creatorStart.peerId);
			},
			120_000
		);
		log(`mutual presence=${mutual}`);
		if (!mutual) {
			await dumpConnections(creatorPage, "creator");
			await dumpConnections(joinerPage, "joiner");
		}
		expect(mutual, "browsers found each other").toBe(true);

		const creatorDot = joinerPage.locator(`[data-glowing-peer-id="${creatorStart.peerId}"]`);
		await expect(creatorDot).toBeVisible({ timeout: 60_000 });
		const beforeMove = await creatorDot.getAttribute("style");
		await creatorPage.keyboard.press("w");
		await expect.poll(async () => creatorDot.getAttribute("style"), { timeout: 30_000 }).not.toBe(beforeMove);
		log("CONVERGED: creator movement visible on joiner");

		await dumpConnections(creatorPage, "creator");
		await dumpConnections(joinerPage, "joiner");
	} finally {
		log(`===== RUN END (${testInfo.project.name}) =====`);
		await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
	}
});

function wireConsole(page: Page, label: string): void {
	page.on("console", (message) => {
		const text = message.text();
		// circuit-relay-v2 grant/refuse traces + relay policy; damus 503 spam only is dropped.
		if (text.includes("relay.damus.io")) return;
		if (
			/circuit-relay|reservation|RESERVATION|hop|reserv|relay:|discover|dial|not-enough|found-enough|error|fail/iu.test(
				text
			)
		) {
			log(`[${label}:${message.type()}] ${text.slice(0, 500)}`);
		}
	});
	page.on("pageerror", (error) => log(`[${label}:pageerror] ${error.message.slice(0, 300)}`));
}

async function openGrid(page: Page, label: string): Promise<void> {
	// Turn on libp2p circuit-relay-v2 debug so grant/refuse per HOP peer surfaces in the console.
	await page.addInitScript(() => {
		try {
			window.localStorage.setItem("debug", "libp2p:circuit-relay*,libp2p:circuit-relay:transport:reservation-store*");
		} catch {
			/* ignore */
		}
	});
	await page.goto("/");
	await page.waitForFunction(
		() => Boolean((window as typeof window & { __TS_DRP_GRID_SESSION__?: unknown }).__TS_DRP_GRID_SESSION__),
		undefined,
		{ timeout: 60_000 }
	);
	await expect(page.locator("#loadingMessage")).toBeHidden({ timeout: 60_000 });
	log(`${label} grid session ready`);
}

async function readSnapshot(page: Page): Promise<Snapshot> {
	return page.evaluate(() => {
		const session = (window as typeof window & { __TS_DRP_GRID_SESSION__?: { snapshot(): Snapshot } })
			.__TS_DRP_GRID_SESSION__;
		if (session === undefined) throw new Error("grid session is not ready");
		return JSON.parse(JSON.stringify(session.snapshot())) as Snapshot;
	});
}

async function pollFor(
	page: Page,
	what: string,
	predicate: () => Promise<boolean>,
	timeoutMs: number
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (await predicate()) {
				log(`OK: ${what}`);
				return true;
			}
		} catch (error) {
			log(`poll error (${what}): ${String(error).slice(0, 300)}`);
		}
		await page.waitForTimeout(1_000);
	}
	log(`TIMEOUT: ${what} after ${timeoutMs}ms`);
	return false;
}

async function dumpRelayEvidence(page: Page, label: string): Promise<void> {
	const s = await readSnapshot(page);
	log(`[${label}] relayReservations=${JSON.stringify(s.relayReservations)}`);
	log(
		`[${label}] relayPolicy.terminal=${s.relayPolicy?.terminal} candidatesObserved=${s.relayPolicy?.candidatesObserved}`
	);
	for (const attempt of s.relayPolicy?.attempts ?? []) {
		const a = attempt as { candidate?: { peerId?: string; addresses?: string[] }; [k: string]: unknown };
		const { candidate, ...rest } = a;
		log(
			`[${label}] relay attempt peer=${candidate?.peerId} addrs=${JSON.stringify(candidate?.addresses)} outcome=${JSON.stringify(rest)}`
		);
	}
	log(`[${label}] routing trace: ${JSON.stringify(s.routing ?? {}).slice(0, 1500)}`);
	log(`[${label}] live connections (${s.connections.length}):`);
	for (const c of s.connections) log(`[${label}]   conn transport=${c.transport} ${c.multiaddr.slice(0, 160)}`);
	const relayEvents = s.controlPlaneEvents.filter((e) => e.kind === "relay-reservation");
	for (const event of relayEvents.slice(-10)) {
		log(`[${label}] relay-reservation event: ${JSON.stringify(event)}`);
	}
	const admissionEvents = s.controlPlaneEvents.filter((e) => e.kind === "address-admission");
	log(`[${label}] address-admission events: ${admissionEvents.length} total`);
	for (const event of admissionEvents.slice(-25)) {
		log(`[${label}] address-admission: ${JSON.stringify(event)}`);
	}
}

async function dumpConnections(page: Page, label: string): Promise<void> {
	const s = await readSnapshot(page);
	for (const c of s.connections) {
		log(`[${label}] connection: transport=${c.transport} ${c.multiaddr.slice(0, 200)}`);
	}
}

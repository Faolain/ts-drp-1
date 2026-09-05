import { expect, type Page, test } from "@playwright/test";

import { type Phase3a0DServer, startPhase3a0DServer } from "./fixtures/phase-3a0-d-server.js";

type Scenario = "combined" | "creator";
type Summary = Readonly<Record<string, unknown>>;

declare global {
	interface Window {
		phase3a0D: Readonly<{
			cleanup(databaseName: string): Promise<void>;
			failClosed(databaseName: string): Promise<unknown>;
			inspect(databaseName: string): Promise<unknown>;
			install(databaseName: string, scenario: Scenario): Promise<unknown>;
			reopen(databaseName: string): Promise<unknown>;
		}>;
	}
}

const ENGINES = ["chromium", "firefox", "webkit"] as const;
const expectedAuthority = Object.freeze({
	anchorDigest: "5c58b2d49d152365fd594fbaf9d7754dc8b1310ec11268046b5f2542e9e4fc7d",
	blueprintDigest: "4".repeat(64),
	epoch: 0,
	objectId: `creator:${"a".repeat(32)}`,
	parametersDigest: "6".repeat(64),
	profileDigest: "2d27ece4f107e7363ae474f5933a1ed57321d261a16317b8186ef458362f7d25",
	signerSetDigest: "55d13115ea6165d5e75678fed441b2c6ecd37f0c0c8ed8f1ef0c87fc83698e64",
});
let server: Phase3a0DServer;

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_3A0_D_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("Phase 3a0-D assets are absent");
	server = await startPhase3a0DServer(assetDirectory);
});

test.afterAll(async () => server.close());

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactAuthority(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.authentication) || !isRecord(value.authentication.provenance)) return false;
	if (!isRecord(value.authorityContext) || !isRecord(value.capability) || !isRecord(value.head)) return false;
	return (
		value.authentication.ok === true &&
		JSON.stringify(value.authentication.provenance) === JSON.stringify(expectedAuthority) &&
		value.authorityContext.expectedObjectId === expectedAuthority.objectId &&
		value.authorityContext.pinnedGenesisAnchorDigest === expectedAuthority.anchorDigest &&
		value.capability.frozen === true &&
		JSON.stringify(value.capability.ownKeys) ===
			JSON.stringify(["currentAnchorDigest", "currentEpoch", "genesisAnchorDigest", "objectId", "profileId"]) &&
		value.strictDurability === true &&
		typeof value.trustRecordBytesHex === "string" &&
		isRecord(value.trustRef) &&
		value.head.kind === "present"
	);
}

function classify(actual: unknown, old: unknown, exactNew: unknown): "new" | "old" | undefined {
	const actualOld = JSON.stringify(actual) === JSON.stringify(old);
	const actualNew = JSON.stringify(actual) === JSON.stringify(exactNew);
	if (actualOld === actualNew) return undefined;
	if (actualNew && exactAuthority(actual) && exactAuthority(exactNew)) return "new";
	if (
		actualOld &&
		(isRecord(old) && old.kind === "absent" ? isRecord(actual) && actual.kind === "absent" : exactAuthority(actual))
	)
		return "old";
	return undefined;
}

async function openHarness(page: Page): Promise<string> {
	const url = server.issue();
	await page.goto(url, { waitUntil: "load" });
	await page.waitForFunction(() => "phase3a0D" in globalThis);
	return url;
}

async function install(page: Page, databaseName: string, scenario: Scenario): Promise<Summary> {
	return page.evaluate(([name, selected]) => window.phase3a0D.install(name, selected), [
		databaseName,
		scenario,
	] as const) as Promise<Summary>;
}

async function reopen(page: Page, databaseName: string): Promise<Summary> {
	return page.evaluate((name) => window.phase3a0D.reopen(name), databaseName) as Promise<Summary>;
}

async function cleanup(page: Page, ...databaseNames: readonly string[]): Promise<void> {
	for (const databaseName of databaseNames) await page.evaluate((name) => window.phase3a0D.cleanup(name), databaseName);
}

test("creator trust reopens as byte-identical authority after a real browser reload", async ({ page }, testInfo) => {
	expect(ENGINES).toContain(testInfo.project.name);
	const url = await openHarness(page);
	const oldDatabase = `phase-3a0-d-creator-old-${crypto.randomUUID()}`;
	const newDatabase = `phase-3a0-d-creator-new-${crypto.randomUUID()}`;
	try {
		const oldControl = (await page.evaluate((name) => window.phase3a0D.inspect(name), oldDatabase)) as Summary;
		const newControl = await install(page, newDatabase, "creator");
		expect(exactAuthority(newControl)).toBe(true);
		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => "phase3a0D" in globalThis);
		const oldReloaded = await reopen(page, oldDatabase);
		const newReloaded = await reopen(page, newDatabase);
		expect(oldReloaded).toEqual(oldControl);
		expect(newReloaded).toEqual(newControl);
		expect(classify(newReloaded, oldControl, newControl)).toBe("new");
		expect(
			classify({ ...newReloaded, trustRef: { byteLength: 1, digest: "0".repeat(64) } }, oldControl, newControl)
		).toBeUndefined();
		expect(
			classify({ ...newReloaded, authentication: { ok: false, reason: "invalid-signature" } }, oldControl, {
				...newControl,
				authentication: { ok: false, reason: "invalid-signature" },
			})
		).toBeUndefined();
	} finally {
		await cleanup(page, oldDatabase, newDatabase);
		server.revoke(url);
	}
});

test("combined closure preserves the exact creator record and trust ref across reload", async ({ page }, testInfo) => {
	expect(ENGINES).toContain(testInfo.project.name);
	const url = await openHarness(page);
	const oldDatabase = `phase-3a0-d-combined-old-${crypto.randomUUID()}`;
	const newDatabase = `phase-3a0-d-combined-new-${crypto.randomUUID()}`;
	try {
		const oldControl = await install(page, oldDatabase, "creator");
		const newControl = await install(page, newDatabase, "combined");
		await page.reload({ waitUntil: "load" });
		await page.waitForFunction(() => "phase3a0D" in globalThis);
		const oldReloaded = await reopen(page, oldDatabase);
		const newReloaded = await reopen(page, newDatabase);
		expect(oldReloaded).toEqual(oldControl);
		expect(newReloaded).toEqual(newControl);
		expect(newReloaded.trustRecordBytesHex).toBe(oldReloaded.trustRecordBytesHex);
		expect(newReloaded.trustRef).toEqual(oldReloaded.trustRef);
		expect(classify(newReloaded, oldControl, newControl)).toBe("new");
		expect((newReloaded.recovery as { references: readonly unknown[] }).references).toHaveLength(2);
	} finally {
		await cleanup(page, oldDatabase, newDatabase);
		server.revoke(url);
	}
});

test("strict IndexedDB durability fails closed before any creator-trust write", async ({ page }, testInfo) => {
	expect(ENGINES).toContain(testInfo.project.name);
	const url = await openHarness(page);
	const databaseName = `phase-3a0-d-strict-${crypto.randomUUID()}`;
	try {
		await expect(page.evaluate((name) => window.phase3a0D.failClosed(name), databaseName)).resolves.toEqual({
			head: { kind: "none", objectId: expectedAuthority.objectId },
			observed: "default",
			requested: "strict",
			result: { ok: false, reason: "store-failed" },
			writes: [],
		});
	} finally {
		await cleanup(page, databaseName);
		server.revoke(url);
	}
});

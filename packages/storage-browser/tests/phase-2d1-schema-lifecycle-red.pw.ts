import { expect, type Page, test } from "@playwright/test";

interface Phase2dSchemaHarness {
	runBlockedUpgrade(): Promise<unknown>;
	runCooperativeVersionchange(): Promise<unknown>;
	runDecisionMismatch(): Promise<unknown>;
	runExistingCorrectSchema(): Promise<unknown>;
	runFreshSchema(): Promise<unknown>;
	runLifecyclePositiveControl(): Promise<unknown>;
	runNativeCompoundPositiveControl(): Promise<unknown>;
	runPromotionCompoundPositiveControl(): Promise<unknown>;
	runUnexpectedPrivateV1Schemas(): Promise<unknown>;
	runUnexpectedSchemaAndVersion(): Promise<unknown>;
}

const EXPECTED_EXACT_SCHEMA = Object.freeze({
	kind: "opened",
	stores: [
		{ autoIncrement: false, indexes: [], keyPath: "digest", name: "blobs" },
		{
			autoIncrement: false,
			indexes: [],
			keyPath: ["objectId", "generationId"],
			name: "generations",
		},
		{ autoIncrement: false, indexes: [], keyPath: "objectId", name: "objects" },
		{
			autoIncrement: false,
			indexes: [],
			keyPath: ["objectId", "generationId", "digest"],
			name: "promotions",
		},
		{
			autoIncrement: false,
			indexes: [
				{
					keyPath: ["objectId", "epoch"],
					multiEntry: false,
					name: "by-object-epoch",
					unique: false,
				},
			],
			keyPath: null,
			name: "votes",
		},
	],
	version: 1,
});

async function runHarness(page: Page, method: keyof Phase2dSchemaHarness): Promise<unknown> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2dSchemaHarness" in globalThis);
	return page.evaluate(async (scenarioMethod) => {
		const harness = (globalThis as unknown as { readonly phase2dSchemaHarness: Phase2dSchemaHarness })
			.phase2dSchemaHarness;
		return harness[scenarioMethod]();
	}, method);
}

async function runStrictAdapterEvidence(page: Page): Promise<unknown> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2d2aAdapterHarness" in globalThis);
	return page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2d2aAdapterHarness") as Record<string, () => Promise<unknown>>;
		return harness.runStrictDurabilityEvidence?.();
	});
}

test("positive control: Chromium preserves native compound keys and distinct embedded-NUL tuples", async ({ page }) => {
	await expect(runHarness(page, "runNativeCompoundPositiveControl")).resolves.toEqual({
		count: 2,
		generationKeyPath: ["objectId", "generationId"],
		voteIndexKeyPath: ["objectId", "epoch"],
	});
});

test("positive control: Chromium keeps colliding three-part promotion tuples distinct", async ({ page }) => {
	await expect(runHarness(page, "runPromotionCompoundPositiveControl")).resolves.toEqual({
		count: 2,
		promotionKeyPath: ["objectId", "generationId", "digest"],
	});
});

test("positive control: Chromium exposes cooperative versionchange and a genuine blocked upgrade", async ({ page }) => {
	await expect(runHarness(page, "runLifecyclePositiveControl")).resolves.toEqual({
		blockedObserved: true,
		cooperativeBlocked: false,
		versionchangeObserved: true,
	});
});

test("production opening consumes the selected decision digest before creating a database", async ({ page }) => {
	await expect(runHarness(page, "runDecisionMismatch")).resolves.toEqual({
		databaseCreated: false,
		error: {
			code: "STORAGE_DECISION_MISMATCH",
			message: "Phase 2d requires the accepted idb-strict decision link",
			name: "BrowserStorageCapabilityError",
		},
	});
});

test("fresh production opening creates the plan-owned native compound schema shell", async ({ page }) => {
	await expect(runHarness(page, "runFreshSchema")).resolves.toEqual(EXPECTED_EXACT_SCHEMA);
});

test("production validation accepts an independently created exact private-v1 schema", async ({ page }) => {
	await expect(runHarness(page, "runExistingCorrectSchema")).resolves.toEqual(EXPECTED_EXACT_SCHEMA);
});

test("historical, missing, extra and malformed private-v1 schemas all fail closed", async ({ page }) => {
	await expect(runHarness(page, "runUnexpectedPrivateV1Schemas")).resolves.toEqual({
		accepted: [],
		rejected: [
			"historical-two-store",
			"missing-objects",
			"missing-generations",
			"missing-blobs",
			"missing-promotions",
			"missing-votes",
			"extra-store",
			"wrong-objects-key",
			"wrong-generations-key",
			"wrong-blobs-key",
			"wrong-promotions-key",
			"wrong-votes-key",
			"swapped-generations-key-order",
			"swapped-promotions-key-order",
			"objects-auto-increment",
			"blobs-auto-increment",
			"votes-auto-increment",
			"objects-extra-index",
			"generations-extra-index",
			"blobs-extra-index",
			"promotions-extra-index",
			"votes-missing-index",
			"votes-extra-index",
			"votes-wrong-index-key",
			"swapped-votes-index-key-order",
			"votes-unique-index",
			"votes-multi-entry-index",
		],
	});
});

test("real adapter mutations reject downgraded observations without writes and commit once under strict", async ({
	page,
}) => {
	await expect(runStrictAdapterEvidence(page)).resolves.toEqual([
		{
			cause: { code: "NON_STRICT_DURABILITY", name: "StrictDurabilityCapabilityError" },
			generationRows: 0,
			observed: "default",
			reason: "SUBSTRATE_FAILURE",
			requested: "strict",
			writes: [],
		},
		{
			cause: { code: "NON_STRICT_DURABILITY", name: "StrictDurabilityCapabilityError" },
			generationRows: 0,
			observed: "relaxed",
			reason: "SUBSTRATE_FAILURE",
			requested: "strict",
			writes: [],
		},
		{
			cause: null,
			generationRows: 1,
			observed: "strict",
			reason: "OK",
			requested: "strict",
			writes: ["put:generations"],
		},
	]);
});

test("a production connection cooperatively closes on versionchange", async ({ page }) => {
	await expect(runHarness(page, "runCooperativeVersionchange")).resolves.toEqual({
		blocked: false,
		kind: "upgraded",
	});
});

test("a genuinely noncooperative blocked upgrade is surfaced within the configured bound", async ({ page }) => {
	const result = (await runHarness(page, "runBlockedUpgrade")) as {
		readonly elapsedMilliseconds: number;
		readonly error: unknown;
	};
	expect(result.error).toEqual({
		code: "UPGRADE_BLOCKED",
		message: "browser storage schema upgrade blocked by another connection",
		name: "BrowserStorageBlockedError",
	});
	expect(result.elapsedMilliseconds).toBeGreaterThanOrEqual(200);
	expect(result.elapsedMilliseconds).toBeLessThan(1_000);
});

test("unexpected required schema and future versions reject with one frozen reason", async ({ page }) => {
	await expect(runHarness(page, "runUnexpectedSchemaAndVersion")).resolves.toEqual({
		errors: [
			{
				code: "UNEXPECTED_SCHEMA_VERSION",
				message: "unexpected browser storage schema/version",
				name: "BrowserStorageSchemaError",
			},
			{
				code: "UNEXPECTED_SCHEMA_VERSION",
				message: "unexpected browser storage schema/version",
				name: "BrowserStorageSchemaError",
			},
		],
		expectedReason: "unexpected browser storage schema/version",
	});
});

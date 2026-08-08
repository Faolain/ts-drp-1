import { expect, type Page, test } from "@playwright/test";

interface Phase2dSchemaHarness {
	runBlockedUpgrade(): Promise<unknown>;
	runCooperativeVersionchange(): Promise<unknown>;
	runDecisionMismatch(): Promise<unknown>;
	runFreshSchema(): Promise<unknown>;
	runLifecyclePositiveControl(): Promise<unknown>;
	runNativeCompoundPositiveControl(): Promise<unknown>;
	runStrictMutation(observedDurability: IDBTransactionDurability): Promise<unknown>;
	runUnexpectedSchemaAndVersion(): Promise<unknown>;
}

async function runHarness(
	page: Page,
	method: keyof Phase2dSchemaHarness,
	argument?: IDBTransactionDurability
): Promise<unknown> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2dSchemaHarness" in globalThis);
	return page.evaluate(
		async ({ argument: scenarioArgument, method: scenarioMethod }) => {
			const harness = (globalThis as unknown as { readonly phase2dSchemaHarness: Phase2dSchemaHarness })
				.phase2dSchemaHarness;
			if (scenarioMethod === "runStrictMutation") {
				if (scenarioArgument === undefined) throw new TypeError("strict mutation requires an observation");
				return harness.runStrictMutation(scenarioArgument);
			}
			return harness[scenarioMethod]();
		},
		{ argument, method }
	);
}

test("positive control: Chromium preserves native compound keys and distinct embedded-NUL tuples", async ({ page }) => {
	await expect(runHarness(page, "runNativeCompoundPositiveControl")).resolves.toEqual({
		count: 2,
		generationKeyPath: ["objectId", "generationId"],
		voteIndexKeyPath: ["objectId", "epoch"],
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
	await expect(runHarness(page, "runFreshSchema")).resolves.toEqual({
		generationKeyPath: ["objectId", "generationId"],
		kind: "opened",
		version: 1,
		voteIndexKeyPath: ["objectId", "epoch"],
	});
});

test("all non-strict live mutation observations fail fatally and commit zero writes", async ({ page }) => {
	const observations = [];
	for (const observedDurability of ["default", "relaxed"] as const) {
		observations.push(await runHarness(page, "runStrictMutation", observedDurability));
	}
	observations.push(await runHarness(page, "runStrictMutation", "strict"));
	expect(observations).toEqual([
		{
			committedRecords: 0,
			error: {
				code: "NON_STRICT_DURABILITY",
				message: "strict IndexedDB durability is required",
				name: "StrictDurabilityCapabilityError",
			},
			result: null,
		},
		{
			committedRecords: 0,
			error: {
				code: "NON_STRICT_DURABILITY",
				message: "strict IndexedDB durability is required",
				name: "StrictDurabilityCapabilityError",
			},
			result: null,
		},
		{
			committedRecords: 1,
			error: null,
			result: { committed: true, observedDurability: "strict" },
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

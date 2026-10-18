import { expect, type Page, test } from "@playwright/test";

async function run(
	page: Page,
	method: "runPhase2e2Controls" | "runPhase2e2OpenFailure" | "runPhase2e2PoisonLifecycle" | "runPhase2e2TaxonomyMatrix"
): Promise<unknown> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2d2aAdapterHarness" in globalThis);
	return page.evaluate(async (selected) => {
		const harness = Reflect.get(globalThis, "phase2d2aAdapterHarness") as Record<string, () => Promise<unknown>>;
		return harness[selected]?.();
	}, method);
}

test("real Chromium classifies every persisted recovery contradiction and writes nothing", async ({ page }) => {
	await expect(run(page, "runPhase2e2TaxonomyMatrix")).resolves.toEqual(
		[
			["unsupported-generation", "UNSUPPORTED_STORAGE_SCHEMA"],
			["unsupported-head", "UNSUPPORTED_STORAGE_SCHEMA"],
			["malformed-generation", "NON_CANONICAL_RECORD"],
			["malformed-head", "NON_CANONICAL_RECORD"],
			["absent-head-target", "NON_CANONICAL_RECORD"],
			["non-adopted-head-target", "NON_CANONICAL_RECORD"],
			["closure-mismatch", "NON_CANONICAL_RECORD"],
			["multiple-adopted", "NON_CANONICAL_RECORD"],
			["physical-key-mismatch", "NON_CANONICAL_RECORD"],
		].map(([corruption, expected]) => ({ corruption, expected, reason: expected, zeroWrites: true }))
	);
});

test("real Chromium latches poison before queued work and close then outranks it", async ({ page }) => {
	await expect(run(page, "runPhase2e2PoisonLifecycle")).resolves.toEqual({
		afterClose: "STORE_CLOSED",
		first: "NON_CANONICAL_RECORD",
		later: "STORE_POISONED",
		queued: "STORE_POISONED",
		zeroWrites: true,
	});
});

test("real Chromium rejects incompatible schema at open without returning a handle", async ({ page }) => {
	await expect(run(page, "runPhase2e2OpenFailure")).resolves.toEqual({
		handleReturned: false,
		reason: "UNSUPPORTED_STORAGE_SCHEMA",
	});
});

test("real Chromium preserves caller and substrate classifications with zero writes", async ({ page }) => {
	await expect(run(page, "runPhase2e2Controls")).resolves.toEqual({
		invalid: "INVALID_ARGUMENT",
		invalidZeroWrites: true,
		substrate: "SUBSTRATE_FAILURE",
		substrateZeroWrites: true,
		valid: "OK",
	});
});

import { expect, type Page, test } from "@playwright/test";

type Method = "runPhase2e4CloseAndPoisonQueue" | "runPhase2e4LifecycleMatrix" | "runPhase2e4PhysicalDamageMatrix";

async function run(page: Page, method: Method): Promise<Record<string, unknown>> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2d2aAdapterHarness" in globalThis);
	return page.evaluate(async (selected) => {
		const harness = Reflect.get(globalThis, "phase2d2aAdapterHarness") as Record<string, () => Promise<unknown>>;
		return harness[selected]?.() as Promise<Record<string, unknown>>;
	}, method);
}

test("real Chromium freezes explicit recovery, reopen, stale-certificate, completion, and substrate lifecycle", async ({
	page,
}) => {
	const result = await run(page, "runPhase2e4LifecycleMatrix");
	expect.soft(result.explicit).toEqual({
		closed: "STORE_CLOSED",
		initial: "OK",
		poisoned: "STORE_POISONED",
		reopenedRoot: "ADOPTED_BLOB_CORRUPT",
		repaired: "OK",
		unchangedHeadRoot: "ADOPTED_BLOB_CORRUPT",
	});
	expect.soft(result.concurrent).toEqual({
		later: "STORE_POISONED",
		reason: "ADOPTED_BLOB_UNPROMOTED",
		recoveryPages: expect.any(Number),
		zeroWrites: true,
		writes: [],
	});
	expect((result.concurrent as { recoveryPages: number }).recoveryPages).toBeGreaterThanOrEqual(1);
	expect.soft(result.completion).toEqual({
		afterPromotion: "OK",
		beforePromotion: "BLOB_UNPROMOTED",
		promoted: "OK",
	});
	expect.soft(result.substrate).toEqual({
		failure: "SUBSTRATE_FAILURE",
		later: "OK",
		recoveryPages: expect.any(Number),
		retry: "OK",
	});
	expect((result.substrate as { recoveryPages: number }).recoveryPages).toBeGreaterThanOrEqual(1);
});

test("real Chromium re-verifies physical swap evidence and keeps backend taxonomy aligned", async ({ page }) => {
	const result = await run(page, "runPhase2e4PhysicalDamageMatrix");
	expect.soft(result.swaps).toEqual(
		[
			["unpromoted", "BLOB_UNPROMOTED"],
			["missing", "BLOB_MISSING"],
			["corrupt", "BLOB_CORRUPT"],
		].map(([damage, expected]) => ({
			damage,
			expected,
			later: "OK",
			reason: expected,
			retry: "OK",
			zeroWrites: true,
		}))
	);
	expect.soft(result.wrongTypes).toEqual({
		adopted: "ADOPTED_BLOB_CORRUPT",
		adoptedLater: "STORE_POISONED",
		candidate: "BLOB_CORRUPT",
		candidateLater: "OK",
	});
	expect.soft(result.nullRows).toEqual({
		empty: "OK",
		orphanLater: "STORE_POISONED",
		survivingAdopted: "NON_CANONICAL_RECORD",
	});
});

test("real Chromium closes behind active recovery and suppresses queued poison work before another scan", async ({
	page,
}) => {
	const result = await run(page, "runPhase2e4CloseAndPoisonQueue");
	expect.soft(result.close).toEqual({
		firstSettlement: "transaction-terminal",
		later: "STORE_CLOSED",
		operation: "OK",
		queued: "STORE_CLOSED",
	});
	expect.soft(result.poison).toMatchObject({
		authoritativeScans: 2,
		later: "STORE_POISONED",
		results: ["ADOPTED_BLOB_UNPROMOTED", "STORE_POISONED"],
		writes: [],
	});
});

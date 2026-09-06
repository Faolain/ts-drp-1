import { expect, type Page, test } from "@playwright/test";

type Method =
	| "runPhase2e3AuthorityGap"
	| "runPhase2e3MultiPageRecovery"
	| "runPhase2e3RecoveryShapes"
	| "runPhase2e3VerifierMatrix";

async function run(page: Page, method: Method): Promise<unknown> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2d2aAdapterHarness" in globalThis);
	return page.evaluate(async (selected) => {
		const harness = Reflect.get(globalThis, "phase2d2aAdapterHarness") as Record<string, () => Promise<unknown>>;
		return harness[selected]?.();
	}, method);
}

test("real Chromium returns exact detached empty and active recovery metadata", async ({ page }) => {
	const result = (await run(page, "runPhase2e3RecoveryShapes")) as Record<string, unknown>;
	const expected = result.expected as Record<string, unknown>;
	expect(result.empty).toEqual({
		ok: true,
		value: {
			kind: "empty",
			head: { kind: "none", objectId: `phase-2d2a-a:${"a".repeat(32)}` },
			adoptedGeneration: null,
			recomputedClosureDigest: null,
			references: [],
		},
	});
	const exactActive = {
		ok: true,
		value: {
			kind: "active",
			head: expected.head,
			adoptedGeneration: expected.adopted,
			recomputedClosureDigest: Reflect.get(expected.adopted as object, "closureDigest"),
			references: Reflect.get(expected.adopted as object, "closure"),
		},
	};
	expect(result.first).toEqual(exactActive);
	expect(result.second).toEqual(exactActive);
});

test("real Chromium cursor-walks more than 128 rows in one strict bounded recovery transaction", async ({ page }) => {
	const result = (await run(page, "runPhase2e3MultiPageRecovery")) as Record<string, unknown>;
	expect(result.result).toMatchObject({ ok: true, value: { kind: "empty" } });
	const reads = result.generationReads as Array<Record<string, unknown>>;
	expect(reads.length).toBeGreaterThanOrEqual(2);
	expect(reads.every(({ method, count }) => method === "getAll" && count === 129)).toBe(true);
	expect(result.transactions).toEqual([
		{
			durability: "strict",
			mode: "readwrite",
			operation: "recoverActiveGeneration",
			stores: ["blobs", "generations", "objects", "promotions"],
		},
	]);
});

test("real Chromium gates the G1-rev5 head-deletion swap before any write", async ({ page }) => {
	const result = (await run(page, "runPhase2e3AuthorityGap")) as Record<string, unknown>;
	expect(result).toMatchObject({
		afterRoot: "STORE_POISONED",
		blobReads: 0,
		reason: "NON_CANONICAL_RECORD",
		writes: [],
		zeroWrites: true,
	});
	expect(result.boundedGenerationReads).toBeGreaterThanOrEqual(1);
	expect(result.transactions).toEqual([
		{
			durability: "strict",
			mode: "readwrite",
			operation: "swapHead-authority-gap",
			stores: ["blobs", "generations", "objects", "promotions"],
		},
	]);
});

test("real Chromium incrementally reverifies promoted candidate bytes without poisoning", async ({ page }) => {
	const result = (await run(page, "runPhase2e3VerifierMatrix")) as Record<string, unknown>;
	expect.soft(result.candidate).toEqual(
		[
			["missing", "BLOB_MISSING"],
			["wrong-length", "BLOB_CORRUPT"],
			["wrong-digest", "BLOB_CORRUPT"],
			["wrong-type", "BLOB_CORRUPT"],
		].map(([damage, expected]) => ({
			blobReads: 1,
			damage,
			expected,
			later: "OK",
			reason: expected,
			zeroWrites: true,
		}))
	);
	expect.soft(result.adopted).toEqual(
		[
			["unpromoted", "ADOPTED_BLOB_UNPROMOTED"],
			["missing", "ADOPTED_BLOB_MISSING"],
			["corrupt", "ADOPTED_BLOB_CORRUPT"],
		].map(([damage, expected]) => ({
			afterClose: "STORE_CLOSED",
			damage,
			expected,
			first: expected,
			later: "STORE_POISONED",
			zeroWrites: true,
		}))
	);
	const incremental = result.incremental as Record<string, unknown>;
	expect.soft(incremental.blobKeys).toEqual(incremental.expectedKeys);
	expect.soft(incremental).toEqual({
		blobKeys: incremental.expectedKeys,
		expectedKeys: incremental.expectedKeys,
		mutantPeak: 2,
		peak: 1,
		reason: "BLOB_MISSING",
		writes: [],
	});
});

test("positive control calibrates the peak-request probe against a batched mutant", async ({ page }) => {
	const result = (await run(page, "runPhase2e3VerifierMatrix")) as Record<string, unknown>;
	const incremental = result.incremental as Record<string, unknown>;
	expect(incremental.mutantPeak).toBe(2);
});

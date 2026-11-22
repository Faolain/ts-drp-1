import { expect, type Page, test } from "@playwright/test";

type HarnessMethod =
	| "runAtomicRollback"
	| "runBoundedCompletionTrace"
	| "runClosureIntegrity"
	| "runCompetingCas"
	| "runImmutableAndIdempotent"
	| "runPersistenceAndCopies"
	| "runSameDigestDifferentBytes"
	| "runSharedContract";

async function run(page: Page, method: HarnessMethod): Promise<unknown> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2d2aAdapterHarness" in globalThis);
	return page.evaluate(async (selected) => {
		const harness = Reflect.get(globalThis, "phase2d2aAdapterHarness") as Record<string, () => Promise<unknown>>;
		return harness[selected]?.();
	}, method);
}

test("real Chromium IndexedDB passes the shared strict AheDurableStore contract", async ({ page }) => {
	await expect(run(page, "runSharedContract")).resolves.toEqual({
		capabilities: { durability: "strict", signingEligibility: "backend-capability-required" },
		ok: true,
	});
});

test("whole canonical rows and exact blobs survive reopen with detached outputs", async ({ page }) => {
	await expect(run(page, "runPersistenceAndCopies")).resolves.toEqual({
		blobDetached: true,
		generationCanonical: true,
		headCanonical: true,
		reopened: true,
		stateDetached: true,
		swap: "OK",
	});
});

test("promoteReference owns missing and corrupt closure bytes without mutating journal state", async ({ page }) => {
	await expect(run(page, "runClosureIntegrity")).resolves.toEqual({
		corrupt: "BLOB_CORRUPT",
		missing: "BLOB_MISSING",
		states: ["Staged", "Staged"],
	});
});

test("completion incrementally reverifies every promotion and blob in one strict bounded transaction", async ({
	page,
}) => {
	await expect(run(page, "runBoundedCompletionTrace")).resolves.toEqual({
		blobReads: 2,
		peakOutstandingBlobGets: 1,
		promotionReads: 2,
		result: { reason: "OK", state: "Complete" },
		transactions: [
			{
				durability: "strict",
				mode: "readwrite",
				operation: "completeGeneration",
				stores: ["blobs", "generations", "objects", "promotions"],
			},
		],
		unboundedGenerationReads: 0,
		writes: [{ method: "put", operation: "completeGeneration", store: "generations" }],
	});
});

test("same-byte blob insertion and promotion are idempotent across global/object scopes", async ({ page }) => {
	const result = (await run(page, "runImmutableAndIdempotent")) as {
		promotionCount?: number;
		promotions?: unknown[];
		repeat?: unknown;
		same?: Array<{ inserted?: boolean }>;
	};
	expect(result.promotionCount).toBe(1);
	expect(result.promotions).toEqual(["OK", "OK"]);
	expect(result.repeat).toEqual({ inserted: false });
	expect(result.same?.map(({ inserted }) => inserted).sort()).toEqual([false, true]);
});

test("same digest with different bytes has one insert winner and one immutable loser", async ({ page }) => {
	await expect(run(page, "runSameDigestDifferentBytes")).resolves.toEqual({
		immutableConflicts: 1,
		insertions: 1,
		storedIsWinner: true,
	});
});

test("concurrent expected-head swaps linearize to one adoption and one stable conflict", async ({ page }) => {
	await expect(run(page, "runCompetingCas")).resolves.toEqual({
		adopted: 1,
		complete: 1,
		outcomes: ["HEAD_CONFLICT", "OK"],
		revision: 1,
	});
});

test("a second-write failure aborts the entire strict transaction and permits an exact retry", async ({ page }) => {
	await expect(run(page, "runAtomicRollback")).resolves.toEqual({
		afterRetry: {
			generationState: "Adopted",
			head: "present",
			objectRows: 1,
			reason: "OK",
			revision: 1,
		},
		beforeRetry: {
			generationState: "Complete",
			head: "none",
			objectRows: 0,
			reason: "SUBSTRATE_FAILURE",
		},
	});
});

import { expect, type Page, test } from "@playwright/test";

const OBJECT_A = `phase-2d2a-a:${"a".repeat(32)}`;

function generationRange(
	operation: string,
	count?: number
): Readonly<{
	count?: number;
	operation: string;
	query: Readonly<{
		lower: readonly string[];
		lowerOpen: false;
		upper: readonly [string, readonly []];
		upperOpen: false;
	}>;
	store: "generations";
}> {
	return {
		...(count === undefined ? {} : { count }),
		operation,
		query: { lower: [OBJECT_A], lowerOpen: false, upper: [OBJECT_A, []], upperOpen: false },
		store: "generations",
	};
}

type HarnessMethod =
	| "runAtomicRollback"
	| "runBoundedCompletionTrace"
	| "runClosureIntegrity"
	| "runCompetingCas"
	| "runImmutableAndIdempotent"
	| "runOwnershipTrace"
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

test("completion loads every promotion but zero blob values in one strict generation-write transaction", async ({
	page,
}) => {
	await expect(run(page, "runBoundedCompletionTrace")).resolves.toEqual({
		reads: [
			{ method: "get", operation: "completeGeneration", store: "objects" },
			{ method: "getAll", ...generationRange("completeGeneration") },
			{ method: "get", operation: "completeGeneration", store: "promotions" },
			{ method: "get", operation: "completeGeneration", store: "promotions" },
		],
		result: { reason: "OK", state: "Complete" },
		transactions: [
			{
				durability: "strict",
				mode: "readwrite",
				operation: "completeGeneration",
				stores: ["generations", "objects", "promotions"],
			},
		],
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

test("adapter requirements execute against their real store owners in strict bounded transactions", async ({
	page,
}) => {
	await expect(run(page, "runOwnershipTrace")).resolves.toEqual({
		ranges: [
			generationRange("readGenerationPage", 129),
			generationRange("beginGeneration"),
			generationRange("putCachedBlob"),
			generationRange("promoteReference"),
			generationRange("completeGeneration"),
			generationRange("swapHead"),
			generationRange("discardGeneration"),
		],
		reads: [
			{ method: "get", operation: "readHead", store: "objects" },
			{ method: "getAll", operation: "readGenerationPage", store: "generations" },
			{ method: "get", operation: "getBlob", store: "blobs" },
			{ method: "get", operation: "beginGeneration", store: "objects" },
			{ method: "getAll", operation: "beginGeneration", store: "generations" },
			{ method: "get", operation: "putCachedBlob", store: "objects" },
			{ method: "getAll", operation: "putCachedBlob", store: "generations" },
			{ method: "get", operation: "putCachedBlob", store: "blobs" },
			{ method: "get", operation: "promoteReference", store: "objects" },
			{ method: "getAll", operation: "promoteReference", store: "generations" },
			{ method: "get", operation: "promoteReference", store: "blobs" },
			{ method: "get", operation: "promoteReference", store: "promotions" },
			{ method: "get", operation: "completeGeneration", store: "objects" },
			{ method: "getAll", operation: "completeGeneration", store: "generations" },
			{ method: "get", operation: "completeGeneration", store: "promotions" },
			{ method: "get", operation: "swapHead", store: "objects" },
			{ method: "getAll", operation: "swapHead", store: "generations" },
			{ method: "get", operation: "discardGeneration", store: "objects" },
			{ method: "getAll", operation: "discardGeneration", store: "generations" },
		],
		transactions: [
			{
				durability: "default",
				mode: "readonly",
				operation: "readHead",
				stores: ["objects"],
			},
			{
				durability: "default",
				mode: "readonly",
				operation: "readGenerationPage",
				stores: ["generations"],
			},
			{ durability: "default", mode: "readonly", operation: "getBlob", stores: ["blobs"] },
			{
				durability: "strict",
				mode: "readwrite",
				operation: "beginGeneration",
				stores: ["generations", "objects"],
			},
			{
				durability: "strict",
				mode: "readwrite",
				operation: "putCachedBlob",
				stores: ["blobs", "generations", "objects"],
			},
			{
				durability: "strict",
				mode: "readwrite",
				operation: "promoteReference",
				stores: ["blobs", "generations", "objects", "promotions"],
			},
			{
				durability: "strict",
				mode: "readwrite",
				operation: "completeGeneration",
				stores: ["generations", "objects", "promotions"],
			},
			{
				durability: "strict",
				mode: "readwrite",
				operation: "swapHead",
				stores: ["generations", "objects"],
			},
			{
				durability: "strict",
				mode: "readwrite",
				operation: "discardGeneration",
				stores: ["generations", "objects"],
			},
		],
		writes: [
			{ method: "put", operation: "beginGeneration", store: "generations" },
			{ method: "add", operation: "putCachedBlob", store: "blobs" },
			{ method: "add", operation: "promoteReference", store: "promotions" },
			{ method: "put", operation: "completeGeneration", store: "generations" },
			{ method: "put", operation: "swapHead", store: "generations" },
			{ method: "put", operation: "swapHead", store: "objects" },
			{ method: "put", operation: "discardGeneration", store: "generations" },
		],
	});
});

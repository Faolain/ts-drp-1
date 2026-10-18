import { expect, type Page, test } from "@playwright/test";

type HarnessMethod = "runCloseQuiescence" | "runSupersedingSwap" | "runVersionchangeClosure";

const OBJECT_A = `phase-2d2a-a:${"a".repeat(32)}`;
const GENERATION_A = "a".repeat(64);
const GENERATION_B = "b".repeat(64);
const CLOSED = Array.from({ length: 9 }, () => "STORE_CLOSED");

async function run(page: Page, method: HarnessMethod): Promise<unknown> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2d2aAdapterHarness" in globalThis);
	return page.evaluate(async (selected) => {
		const harness = Reflect.get(globalThis, "phase2d2aAdapterHarness") as Record<string, () => Promise<unknown>>;
		return harness[selected]?.();
	}, method);
}

test("close rejects later work but waits for an already-started real transaction to settle", async ({ page }) => {
	await expect(run(page, "runCloseQuiescence")).resolves.toEqual({
		firstSettlement: "transaction-terminal",
		operation: "OK",
		postClose: CLOSED,
		settlementOrder: ["operation", "close"],
	});
});

test("versionchange closes the adapter and all nine later operations report STORE_CLOSED", async ({ page }) => {
	await expect(run(page, "runVersionchangeClosure")).resolves.toEqual({ postVersionchange: CLOSED });
});

test("a successful second head adoption supersedes revision 1 with exactly three strict writes", async ({ page }) => {
	await expect(run(page, "runSupersedingSwap")).resolves.toEqual({
		generations: [
			{ generationId: GENERATION_A, state: "Superseded" },
			{ generationId: GENERATION_B, state: "Adopted" },
		],
		head: { generationId: GENERATION_B, revision: 2 },
		result: { reason: "OK", supersededGenerationId: GENERATION_A },
		transactions: [
			{
				durability: "strict",
				mode: "readwrite",
				operation: "swapHeadRevision2",
				stores: ["blobs", "generations", "objects", "promotions"],
			},
		],
		writes: [
			{ method: "put", operation: "swapHeadRevision2", store: "generations" },
			{ method: "put", operation: "swapHeadRevision2", store: "generations" },
			{ method: "put", operation: "swapHeadRevision2", store: "objects" },
		],
	});
});

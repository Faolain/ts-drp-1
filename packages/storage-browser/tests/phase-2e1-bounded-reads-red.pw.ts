import { expect, type Page, test } from "@playwright/test";

const OBJECT_A = `phase-2d2a-a:${"a".repeat(32)}`;
const GENERATION_A = "a".repeat(64);
const GENERATION_B = "b".repeat(64);
const GENERATION_C = "c".repeat(64);

async function run(page: Page, method: "runPhase2e1BoundedReads" | "runPhase2e1BroadInvariant"): Promise<unknown> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2d2aAdapterHarness" in globalThis);
	return page.evaluate(async (selected) => {
		const harness = Reflect.get(globalThis, "phase2d2aAdapterHarness") as Record<string, () => Promise<unknown>>;
		return harness[selected]?.();
	}, method);
}

test("real Chromium exposes detached head and bounded exclusive pages with pre-I/O validation", async ({ page }) => {
	const result = (await run(page, "runPhase2e1BoundedReads")) as Record<string, unknown>;
	expect(result).toMatchObject({
		detachedHeadRevision: 1,
		detachedPageState: "Adopted",
		emptyHead: { ok: true, value: { kind: "none", objectId: OBJECT_A } },
		emptyPage: { ok: true, value: { generations: [], nextCursor: null } },
		finalPage: {
			ok: true,
			value: { generations: [{ generationId: GENERATION_C, state: "Staged" }], nextCursor: null },
		},
		firstHead: { ok: true, value: { generationId: GENERATION_A, kind: "present", revision: 99 } },
		firstPage: {
			ok: true,
			value: { generations: [{ generationId: GENERATION_A }, { generationId: GENERATION_B }] },
		},
		invalidBackendCalls: 0,
		invalidReasons: Array(6).fill("INVALID_ARGUMENT"),
	});
	expect(typeof Reflect.get(Reflect.get(result.firstPage as object, "value") as object, "nextCursor")).toBe("string");
});

test("real Chromium retains broad missing-head/surviving-Adopted rejection before 2e3", async ({ page }) => {
	await expect(run(page, "runPhase2e1BroadInvariant")).resolves.toEqual({
		generationRows: 1,
		headRows: 1,
		reason: "INVALID_ARGUMENT",
	});
});

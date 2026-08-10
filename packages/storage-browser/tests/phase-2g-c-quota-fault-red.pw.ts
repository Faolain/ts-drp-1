import { expect, type Page, test } from "@playwright/test";

import {
	type Phase2e5ObservedRow,
	PHASE_2E5_BROWSER_REQUEST_INVENTORY,
} from "./fixtures/phase-2e5-browser-request-inventory.js";
import {
	derivePhase2gQuotaEdges,
	phase2gEngineQuotaErrors,
	phase2gQuotaInventoryErrors,
} from "./fixtures/phase-2g-c-quota-fault-contract.js";

const SELECTED = new Set([
	"begin-generation-empty",
	"begin-generation-certificate-match",
	"put-cached-blob-staged",
	"promote-reference-staged",
	"complete-generation-empty-recovery",
	"swap-head-certificate-match",
	"swap-head-fresh-recovery",
	"discard-generation-staged",
]);

async function quotaHarness(page: Page, method: string): Promise<unknown> {
	await page.goto("/quota");
	await page.waitForFunction(() => "phase2gCQuotaFaultHarness" in globalThis);
	return page.evaluate(async (selected) => {
		const harness = Reflect.get(globalThis, "phase2gCQuotaFaultHarness") as Record<string, () => Promise<unknown>>;
		return harness[selected]?.();
	}, method);
}

test("observes the frozen eight transactions plus the real present-head supersession trace", async ({ page }) => {
	await page.goto("/inventory");
	await page.waitForFunction(() => "phase2e5BrowserInventoryHarness" in globalThis);
	const historical = (await page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2e5BrowserInventoryHarness") as Record<
			string,
			() => Promise<unknown>
		>;
		return harness.runPhase2e5BrowserInventory?.();
	})) as readonly Phase2e5ObservedRow[];
	const selected = PHASE_2E5_BROWSER_REQUEST_INVENTORY.flatMap(({ id }) => {
		if (!SELECTED.has(id)) return [];
		const row = historical.find((candidate) => candidate.id === id);
		if (row === undefined) throw new Error(`missing real historical trace: ${id}`);
		return [row];
	});
	const present = (await quotaHarness(page, "runPresentHeadTrace")) as Phase2e5ObservedRow;
	const observed = [...selected, present];
	expect(phase2gQuotaInventoryErrors(observed), JSON.stringify(observed, null, 2)).toEqual([]);
	const edges = derivePhase2gQuotaEdges(observed);
	expect({
		edges: edges.length,
		transactions: observed.length,
		writes: observed.flatMap(({ requests }) => requests).filter(({ kind }) => kind === "add" || kind === "put").length,
	}).toEqual({
		edges: 35,
		transactions: 9,
		writes: 13,
	});
});

test("runs all trace-derived full-image quota cases through the tests-only instrument", async ({ page }) => {
	const result = (await quotaHarness(page, "runDeterministicMatrix")) as {
		readonly cases: readonly unknown[];
		readonly errors: readonly string[];
		readonly testInstrumentPresent: boolean;
	};
	expect(result.testInstrumentPresent, "Phase 2g-c trace/fault/whole-image test instrument is absent").toBe(true);
	expect(result.errors).toEqual([]);
	expect(result.cases).toHaveLength(35);
});

test("produces one bounded engine-generated Chromium quota fault without skipping", async ({ context, page }) => {
	await page.goto("/quota");
	await page.waitForFunction(() => "phase2gCQuotaFaultHarness" in globalThis);
	await page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2gCQuotaFaultHarness") as Record<string, () => Promise<unknown>>;
		await harness.prepareEngineGeneratedControl?.();
	});
	const session = await context.newCDPSession(page);
	let engineResult: unknown;
	let supportedOverrideAttempted = false;
	try {
		await session.send("Storage.overrideQuotaForOrigin", { origin: new URL(page.url()).origin, quotaSize: 1 });
		supportedOverrideAttempted = true;
		engineResult = await page.evaluate(async (attempted) => {
			const harness = Reflect.get(globalThis, "phase2gCQuotaFaultHarness") as Record<
				string,
				(value: boolean) => Promise<unknown>
			>;
			return harness.runEngineGeneratedControl?.(attempted);
		}, supportedOverrideAttempted);
	} finally {
		await session.send("Storage.overrideQuotaForOrigin", { origin: new URL(page.url()).origin });
		await session.detach();
	}
	const result = engineResult as {
		readonly engineControlPresent: boolean;
		readonly evidence?: Parameters<typeof phase2gEngineQuotaErrors>[0];
	};
	expect(result.engineControlPresent, "Phase 2g-c bounded engine-generated quota control is absent").toBe(true);
	expect(result.evidence).toBeDefined();
	expect(phase2gEngineQuotaErrors(result.evidence as Parameters<typeof phase2gEngineQuotaErrors>[0])).toEqual([]);
});

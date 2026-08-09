import { expect, type Page, test } from "@playwright/test";

import {
	phase2e5InventoryErrors,
	type Phase2e5ObservedRow,
	phase2e6Edges,
	PHASE_2E5_BROWSER_REQUEST_INVENTORY,
} from "./fixtures/phase-2e5-browser-request-inventory.js";

async function observe(page: Page): Promise<readonly Phase2e5ObservedRow[]> {
	await page.goto("/");
	await page.waitForFunction(() => "phase2e5BrowserInventoryHarness" in globalThis);
	return page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2e5BrowserInventoryHarness") as Record<
			string,
			() => Promise<unknown>
		>;
		return harness.runPhase2e5BrowserInventory?.();
	}) as Promise<readonly Phase2e5ObservedRow[]>;
}

function declaredControl(): Phase2e5ObservedRow[] {
	return PHASE_2E5_BROWSER_REQUEST_INVENTORY.map((row) => ({
		id: row.id,
		requests: row.requests.map((request) => ({ ...request, transaction: 0 })),
		result: row.result,
		transactions: row.transaction === null ? [] : [{ ...row.transaction, id: 0 }],
	}));
}

function first<T>(values: readonly T[], label: string): T {
	const value = values[0];
	if (value === undefined) throw new Error(`missing ${label}`);
	return value;
}

test("the real adapter request and transaction inventory equals its finite declaration", async ({ page }) => {
	const observed = await observe(page);
	const errors = phase2e5InventoryErrors(PHASE_2E5_BROWSER_REQUEST_INVENTORY, observed);
	expect(errors, JSON.stringify(observed, null, 2)).toEqual([]);
});

test("the inventory covers every adapter operation, recovery path, write set, and terminal kind", () => {
	const operations = new Set(PHASE_2E5_BROWSER_REQUEST_INVENTORY.map(({ operation }) => operation));
	expect([...operations].sort()).toEqual(
		[
			"beginGeneration",
			"close",
			"completeGeneration",
			"discardGeneration",
			"getBlob",
			"promoteReference",
			"putCachedBlob",
			"readGenerationPage",
			"readHead",
			"recoverActiveGeneration",
			"swapHead",
		].sort()
	);
	expect(PHASE_2E5_BROWSER_REQUEST_INVENTORY.filter(({ path }) => path === "mutation-recovery")).toHaveLength(3);
	expect(PHASE_2E5_BROWSER_REQUEST_INVENTORY.filter(({ path }) => path === "explicit-recovery")).toHaveLength(2);
	expect(PHASE_2E5_BROWSER_REQUEST_INVENTORY.filter(({ path }) => path === "queued-poison")).toHaveLength(1);
	expect(PHASE_2E5_BROWSER_REQUEST_INVENTORY.some(({ transaction }) => transaction?.terminal === "abort")).toBe(true);
	expect(PHASE_2E5_BROWSER_REQUEST_INVENTORY.some(({ transaction }) => transaction?.terminal === "complete")).toBe(
		true
	);
	for (const row of PHASE_2E5_BROWSER_REQUEST_INVENTORY) {
		expect(row.writes).toEqual(row.requests.filter(({ kind }) => kind === "add" || kind === "put"));
	}
});

test("Phase 2e6 request and terminal edge IDs derive bijectively from this same inventory", () => {
	const edges = phase2e6Edges(PHASE_2E5_BROWSER_REQUEST_INVENTORY);
	expect(edges.length).toBeGreaterThan(0);
	expect(new Set(edges.map(({ id }) => id)).size).toBe(edges.length);
	for (const row of PHASE_2E5_BROWSER_REQUEST_INVENTORY) {
		const scenarioEdges = edges.filter(({ scenarioId }) => scenarioId === row.id);
		expect(scenarioEdges).toHaveLength(row.transaction === null ? 0 : (row.requests.length + 2) * 2);
	}
});

test("causal request and transaction mutants cannot satisfy declared-equals-observed", () => {
	const control = declaredControl();
	expect(phase2e5InventoryErrors(PHASE_2E5_BROWSER_REQUEST_INVENTORY, control)).toEqual([]);

	const mutate = (id: string, update: (row: Phase2e5ObservedRow) => Phase2e5ObservedRow): Phase2e5ObservedRow[] =>
		control.map((row) => (row.id === id ? update(row) : row));
	const beginId = "begin-generation-empty";
	const extra = mutate(beginId, (row) => ({
		...row,
		requests: [...row.requests, { kind: "get", store: "objects", transaction: 0 }],
	}));
	const omitted = mutate(beginId, (row) => ({ ...row, requests: row.requests.slice(0, -1) }));
	const duplicated = mutate(beginId, (row) => ({
		...row,
		requests: [...row.requests, first(row.requests, "request mutant seed")],
	}));
	const reordered = mutate(beginId, (row) => ({ ...row, requests: [...row.requests].reverse() }));
	const terminal = mutate(beginId, (row) => ({
		...row,
		transactions: row.transactions.map((transaction) => ({ ...transaction, terminal: "abort" })),
	}));
	const omittedTransaction = mutate(beginId, (row) => ({ ...row, transactions: [] }));
	const extraTransaction = mutate(beginId, (row) => ({
		...row,
		transactions: [...row.transactions, { ...first(row.transactions, "transaction mutant seed"), id: 1 }],
	}));

	for (const mutant of [extra, omitted, duplicated, reordered, terminal, omittedTransaction, extraTransaction]) {
		expect(phase2e5InventoryErrors(PHASE_2E5_BROWSER_REQUEST_INVENTORY, mutant)).not.toEqual([]);
	}
});

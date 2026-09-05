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

test("Phase 2e6 derives only write-success and committed-publication kill edges", () => {
	type InventoryRow = (typeof PHASE_2E5_BROWSER_REQUEST_INVENTORY)[number];
	type InventoryEdges = ReturnType<typeof phase2e6Edges>;
	const selected = (row: InventoryRow): boolean =>
		row.transaction?.mode === "readwrite" && row.transaction.terminal === "complete" && row.writes.length > 0;
	const expectedEdges = (inventory: readonly InventoryRow[]): InventoryEdges =>
		inventory.filter(selected).flatMap((row) => [
			...row.requests.flatMap((request, index) =>
				request.kind === "add" || request.kind === "put"
					? [
							{
								edge: "after" as const,
								id: `${row.id}/request-${String(index).padStart(2, "0")}-${request.kind}-${request.store}/after`,
								scenarioId: row.id,
								target: "request" as const,
							},
						]
					: []
			),
			{
				edge: "after" as const,
				id: `${row.id}/transaction-terminal-complete/after`,
				scenarioId: row.id,
				target: "transaction-terminal" as const,
			},
		]);
	const mutate = (id: string, update: (row: InventoryRow) => InventoryRow): readonly InventoryRow[] =>
		PHASE_2E5_BROWSER_REQUEST_INVENTORY.map((row) => (row.id === id ? update(row) : row));
	const selectedIds = PHASE_2E5_BROWSER_REQUEST_INVENTORY.filter(selected).map(({ id }) => id);
	expect(selectedIds).toEqual([
		"begin-generation-empty",
		"begin-generation-certificate-match",
		"put-cached-blob-staged",
		"promote-reference-staged",
		"complete-generation-empty-recovery",
		"swap-head-certificate-match",
		"swap-head-fresh-recovery",
		"discard-generation-staged",
	]);
	expect(PHASE_2E5_BROWSER_REQUEST_INVENTORY.filter(selected).every(({ result }) => result === "OK")).toBe(true);
	const expected = expectedEdges(PHASE_2E5_BROWSER_REQUEST_INVENTORY);
	expect(expected).toHaveLength(18);
	expect(expected.filter(({ target }) => target === "request")).toHaveLength(10);
	expect(expected.filter(({ target }) => target === "transaction-terminal")).toHaveLength(8);
	expect(new Set(expected.map(({ id }) => id)).size).toBe(18);

	const twoWriteId = "swap-head-certificate-match";
	const withoutOneWrite = mutate(twoWriteId, (row) => ({
		...row,
		requests: row.requests.slice(0, -1),
		writes: row.writes.slice(0, -1),
	}));
	const selectedId = "begin-generation-empty";
	const aborted = mutate(selectedId, (row) => ({
		...row,
		transaction: row.transaction === null ? null : { ...row.transaction, terminal: "abort" },
	}));
	const readonly = mutate(selectedId, (row) => ({
		...row,
		transaction: row.transaction === null ? null : { ...row.transaction, mode: "readonly" },
	}));
	const zeroWrite = mutate(selectedId, (row) => ({ ...row, writes: [] }));
	const cases = [
		{
			expected: expectedEdges(PHASE_2E5_BROWSER_REQUEST_INVENTORY),
			input: PHASE_2E5_BROWSER_REQUEST_INVENTORY,
			label: "control",
		},
		{ expected: expectedEdges(withoutOneWrite), input: withoutOneWrite, label: "one write removed" },
		{ expected: expectedEdges(aborted), input: aborted, label: "selected row aborts" },
		{ expected: expectedEdges(readonly), input: readonly, label: "selected row becomes readonly" },
		{ expected: expectedEdges(zeroWrite), input: zeroWrite, label: "selected row declares zero writes" },
	] as const;
	expect(cases.map(({ expected: values }) => values.length)).toEqual([18, 17, 16, 16, 16]);
	const mismatches = cases.flatMap(({ expected: wanted, input, label }) => {
		const actual = phase2e6Edges(input);
		return JSON.stringify(actual) === JSON.stringify(wanted)
			? []
			: [`${label}: expected ${wanted.length} exact edges, received ${actual.length}`];
	});
	expect(mismatches).toEqual([]);
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

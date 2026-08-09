export type Phase2e5RequestKind = "add" | "get" | "getAll" | "put";
export type Phase2e5TerminalKind = "abort" | "complete";

export interface Phase2e5DeclaredRequest {
	readonly count?: number;
	readonly kind: Phase2e5RequestKind;
	readonly store: "blobs" | "generations" | "objects" | "promotions";
}

export interface Phase2e5DeclaredTransaction {
	readonly durability: "default" | "strict";
	readonly mode: "readonly" | "readwrite";
	readonly requestedDurability: "strict" | null;
	readonly stores: readonly ("blobs" | "generations" | "objects" | "promotions")[];
	readonly terminal: Phase2e5TerminalKind;
}

export interface Phase2e5InventoryRow {
	readonly authorityScope: "operation" | "recovery-capable" | "none";
	readonly id: string;
	readonly operation:
		| "beginGeneration"
		| "close"
		| "completeGeneration"
		| "discardGeneration"
		| "getBlob"
		| "promoteReference"
		| "putCachedBlob"
		| "readGenerationPage"
		| "readHead"
		| "recoverActiveGeneration"
		| "swapHead";
	readonly path: "ordinary" | "explicit-recovery" | "mutation-recovery" | "queued-poison" | "lifecycle";
	readonly requests: readonly Phase2e5DeclaredRequest[];
	readonly result: string | readonly string[];
	readonly transaction: Phase2e5DeclaredTransaction | null;
	readonly writes: readonly Phase2e5DeclaredRequest[];
}

const OBJECTS = ["objects"] as const;
const GENERATIONS = ["generations"] as const;
const BLOBS = ["blobs"] as const;
const GENERATIONS_OBJECTS = ["generations", "objects"] as const;
const BLOBS_GENERATIONS_OBJECTS = ["blobs", "generations", "objects"] as const;
const ALL_AUTHORITY = ["blobs", "generations", "objects", "promotions"] as const;

const readTransaction = (stores: Phase2e5DeclaredTransaction["stores"]): Phase2e5DeclaredTransaction => ({
	durability: "default",
	mode: "readonly",
	requestedDurability: null,
	stores,
	terminal: "complete",
});

const strictTransaction = (
	stores: Phase2e5DeclaredTransaction["stores"],
	terminal: Phase2e5TerminalKind = "complete"
): Phase2e5DeclaredTransaction => ({
	durability: "strict",
	mode: "readwrite",
	requestedDurability: "strict",
	stores,
	terminal,
});

const request = (
	kind: Phase2e5RequestKind,
	store: Phase2e5DeclaredRequest["store"],
	count?: number
): Phase2e5DeclaredRequest => (count === undefined ? { kind, store } : { count, kind, store });

const head = request("get", "objects");
const generation = request("get", "generations");
const generationScan = request("getAll", "generations", 129);
const blob = request("get", "blobs");
const promotion = request("get", "promotions");
const putGeneration = request("put", "generations");
const putHead = request("put", "objects");
const addBlob = request("add", "blobs");
const addPromotion = request("add", "promotions");

/**
 * Phase 2e5's sole finite source of truth. Exact array order is authoritative;
 * no request kind, count, store, duplicate, write, or terminal event is open.
 * A recovery-capable scope is intentionally broad because the same atomic
 * transaction may need adopted-closure recovery after its first head read.
 */
export const PHASE_2E5_BROWSER_REQUEST_INVENTORY: readonly Phase2e5InventoryRow[] = Object.freeze([
	{
		authorityScope: "operation",
		id: "read-head-empty",
		operation: "readHead",
		path: "ordinary",
		requests: [head],
		result: "OK",
		transaction: readTransaction(OBJECTS),
		writes: [],
	},
	{
		authorityScope: "operation",
		id: "read-generation-page-empty",
		operation: "readGenerationPage",
		path: "ordinary",
		requests: [request("getAll", "generations", 3)],
		result: "OK",
		transaction: readTransaction(GENERATIONS),
		writes: [],
	},
	{
		authorityScope: "operation",
		id: "get-blob-missing",
		operation: "getBlob",
		path: "ordinary",
		requests: [blob],
		result: "OK",
		transaction: readTransaction(BLOBS),
		writes: [],
	},
	{
		authorityScope: "operation",
		id: "begin-generation-empty",
		operation: "beginGeneration",
		path: "ordinary",
		requests: [head, generation, putGeneration],
		result: "OK",
		transaction: strictTransaction(GENERATIONS_OBJECTS),
		writes: [putGeneration],
	},
	{
		authorityScope: "recovery-capable",
		id: "begin-generation-certificate-match",
		operation: "beginGeneration",
		path: "ordinary",
		requests: [head, generation, putGeneration],
		result: "OK",
		transaction: strictTransaction(ALL_AUTHORITY),
		writes: [putGeneration],
	},
	{
		authorityScope: "operation",
		id: "put-cached-blob-staged",
		operation: "putCachedBlob",
		path: "ordinary",
		requests: [head, generation, blob, addBlob],
		result: "OK",
		transaction: strictTransaction(BLOBS_GENERATIONS_OBJECTS),
		writes: [addBlob],
	},
	{
		authorityScope: "operation",
		id: "promote-reference-staged",
		operation: "promoteReference",
		path: "ordinary",
		requests: [head, generation, blob, promotion, addPromotion],
		result: "OK",
		transaction: strictTransaction(ALL_AUTHORITY),
		writes: [addPromotion],
	},
	{
		authorityScope: "recovery-capable",
		id: "complete-generation-empty-recovery",
		operation: "completeGeneration",
		path: "mutation-recovery",
		requests: [head, generationScan, generation, promotion, blob, putGeneration],
		result: "OK",
		transaction: strictTransaction(ALL_AUTHORITY),
		writes: [putGeneration],
	},
	{
		authorityScope: "recovery-capable",
		id: "swap-head-certificate-match",
		operation: "swapHead",
		path: "ordinary",
		requests: [head, generation, promotion, blob, putGeneration, putHead],
		result: "OK",
		transaction: strictTransaction(ALL_AUTHORITY),
		writes: [putGeneration, putHead],
	},
	{
		authorityScope: "recovery-capable",
		id: "swap-head-fresh-recovery",
		operation: "swapHead",
		path: "mutation-recovery",
		requests: [head, generationScan, generation, promotion, blob, putGeneration, putHead],
		result: "OK",
		transaction: strictTransaction(ALL_AUTHORITY),
		writes: [putGeneration, putHead],
	},
	{
		authorityScope: "operation",
		id: "discard-generation-staged",
		operation: "discardGeneration",
		path: "ordinary",
		requests: [head, generation, putGeneration],
		result: "OK",
		transaction: strictTransaction(GENERATIONS_OBJECTS),
		writes: [putGeneration],
	},
	{
		authorityScope: "recovery-capable",
		id: "recover-active-empty",
		operation: "recoverActiveGeneration",
		path: "explicit-recovery",
		requests: [head, generationScan],
		result: "OK",
		transaction: strictTransaction(ALL_AUTHORITY),
		writes: [],
	},
	{
		authorityScope: "recovery-capable",
		id: "recover-active-adopted",
		operation: "recoverActiveGeneration",
		path: "explicit-recovery",
		requests: [head, generationScan, promotion, blob],
		result: "OK",
		transaction: strictTransaction(ALL_AUTHORITY),
		writes: [],
	},
	{
		authorityScope: "recovery-capable",
		id: "begin-generation-stale-certificate-recovery",
		operation: "beginGeneration",
		path: "mutation-recovery",
		requests: [head, generationScan, promotion],
		result: "ADOPTED_BLOB_UNPROMOTED",
		transaction: strictTransaction(ALL_AUTHORITY, "abort"),
		writes: [],
	},
	{
		authorityScope: "recovery-capable",
		id: "recover-active-queued-poison",
		operation: "recoverActiveGeneration",
		path: "queued-poison",
		requests: [head, generationScan, promotion],
		result: ["ADOPTED_BLOB_UNPROMOTED", "STORE_POISONED"],
		transaction: strictTransaction(ALL_AUTHORITY, "abort"),
		writes: [],
	},
	{
		authorityScope: "none",
		id: "close-idle",
		operation: "close",
		path: "lifecycle",
		requests: [],
		result: "OK",
		transaction: null,
		writes: [],
	},
]);

export interface Phase2e5ObservedRow {
	readonly id: string;
	readonly requests: readonly (Phase2e5DeclaredRequest & Readonly<{ transaction: number }>)[];
	readonly result: string | readonly string[];
	readonly transactions: readonly (Phase2e5DeclaredTransaction & Readonly<{ id: number }>)[];
}

export interface Phase2e6InventoryEdge {
	readonly edge: "after" | "before";
	readonly id: string;
	readonly scenarioId: string;
	readonly target: "request" | "transaction-open" | "transaction-terminal";
}

/**
 * Derives the exact later kill edges from the ratified request inventory.
 * @param inventory - Finite Phase 2e5 declaration.
 * @returns Stable before/after request and transaction edges for Phase 2e6.
 */
export function phase2e6Edges(inventory: readonly Phase2e5InventoryRow[]): readonly Phase2e6InventoryEdge[] {
	return inventory.flatMap((row) => {
		if (row.transaction === null) return [];
		const targets = [
			{ id: "transaction-open", target: "transaction-open" as const },
			...row.requests.map((value, index) => ({
				id: `request-${String(index).padStart(2, "0")}-${value.kind}-${value.store}`,
				target: "request" as const,
			})),
			{ id: `transaction-terminal-${row.transaction.terminal}`, target: "transaction-terminal" as const },
		];
		return targets.flatMap(({ id, target }) =>
			(["before", "after"] as const).map((edge) => ({
				edge,
				id: `${row.id}/${id}/${edge}`,
				scenarioId: row.id,
				target,
			}))
		);
	});
}

function comparableDeclared(row: Phase2e5InventoryRow): Phase2e5ObservedRow {
	return {
		id: row.id,
		requests: row.requests.map((value) => ({ ...value, transaction: 0 })),
		result: row.result,
		transactions: row.transaction === null ? [] : [{ ...row.transaction, id: 0 }],
	};
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, nested) => {
		if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return nested;
		return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
	});
}

/**
 * Returns every exact declared-equals-observed mismatch without broadening.
 * @param inventory - Finite declared request inventory.
 * @param observed - Real browser adapter traces.
 * @returns Every exact mismatch.
 */
export function phase2e5InventoryErrors(
	inventory: readonly Phase2e5InventoryRow[],
	observed: readonly Phase2e5ObservedRow[]
): readonly string[] {
	const errors: string[] = [];
	const declaredIds = inventory.map(({ id }) => id);
	const observedIds = observed.map(({ id }) => id);
	if (new Set(declaredIds).size !== declaredIds.length) errors.push("declared scenario id is duplicated");
	if (new Set(observedIds).size !== observedIds.length) errors.push("observed scenario id is duplicated");
	if (stableJson(observedIds) !== stableJson(declaredIds)) errors.push("scenario order/set mismatch");
	for (const row of inventory) {
		const actual = observed.find(({ id }) => id === row.id);
		if (actual === undefined) {
			errors.push(`${row.id}: missing observation`);
			continue;
		}
		const expected = comparableDeclared(row);
		if (stableJson(actual.requests) !== stableJson(expected.requests))
			errors.push(
				`${row.id}: request trace mismatch declared=${stableJson(expected.requests)} observed=${stableJson(actual.requests)}`
			);
		if (stableJson(actual.transactions) !== stableJson(expected.transactions))
			errors.push(`${row.id}: transaction trace mismatch`);
		if (stableJson(actual.result) !== stableJson(expected.result)) errors.push(`${row.id}: result mismatch`);
		const actualWrites = actual.requests
			.filter(({ kind }) => kind === "add" || kind === "put")
			.map(({ transaction: _, ...value }) => value);
		if (stableJson(actualWrites) !== stableJson(row.writes)) errors.push(`${row.id}: write-set mismatch`);
	}
	for (const row of observed) if (!declaredIds.includes(row.id)) errors.push(`${row.id}: undeclared observation`);
	return Object.freeze(errors);
}

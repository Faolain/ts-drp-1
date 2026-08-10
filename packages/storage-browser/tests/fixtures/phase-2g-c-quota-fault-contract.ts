import type { StorageRejectionReason } from "@ts-drp/storage";

import {
	phase2e5InventoryErrors,
	type Phase2e5InventoryRow,
	type Phase2e5ObservedRow,
	PHASE_2E5_BROWSER_REQUEST_INVENTORY,
} from "./phase-2e5-browser-request-inventory.js";

const REJECTED_INPUT_REASONS = new Set<string>([
	"INVALID_ARGUMENT",
	"GENERATION_EXISTS",
] as const satisfies readonly StorageRejectionReason[]);

const HISTORICAL_IDS = Object.freeze([
	"begin-generation-empty",
	"begin-generation-certificate-match",
	"put-cached-blob-staged",
	"promote-reference-staged",
	"complete-generation-empty-recovery",
	"swap-head-certificate-match",
	"swap-head-fresh-recovery",
	"discard-generation-staged",
] as const);

const PRESENT_HEAD_ROW: Phase2e5InventoryRow = Object.freeze({
	authorityScope: "recovery-capable",
	id: "swap-head-present-supersession",
	operation: "swapHead",
	path: "ordinary",
	requests: Object.freeze([
		Object.freeze({ kind: "get" as const, store: "objects" as const }),
		Object.freeze({ kind: "get" as const, store: "generations" as const }),
		Object.freeze({ kind: "get" as const, store: "generations" as const }),
		Object.freeze({ kind: "get" as const, store: "promotions" as const }),
		Object.freeze({ kind: "get" as const, store: "blobs" as const }),
		Object.freeze({ kind: "put" as const, store: "generations" as const }),
		Object.freeze({ kind: "put" as const, store: "generations" as const }),
		Object.freeze({ kind: "put" as const, store: "objects" as const }),
	]),
	result: "OK",
	transaction: Object.freeze({
		durability: "strict",
		mode: "readwrite",
		requestedDurability: "strict",
		stores: Object.freeze(["blobs", "generations", "objects", "promotions"] as const),
		terminal: "complete",
	}),
	writes: Object.freeze([
		Object.freeze({ kind: "put" as const, store: "generations" as const }),
		Object.freeze({ kind: "put" as const, store: "generations" as const }),
		Object.freeze({ kind: "put" as const, store: "objects" as const }),
	]),
});

function historicalRows(): readonly Phase2e5InventoryRow[] {
	return HISTORICAL_IDS.map((id) => {
		const row = PHASE_2E5_BROWSER_REQUEST_INVENTORY.find((candidate) => candidate.id === id);
		if (row === undefined) throw new Error(`Phase 2g-c historical row disappeared: ${id}`);
		return row;
	});
}

/** The finite quota inventory extends, but never edits, the frozen Phase 2e5 declaration. */
export const PHASE_2G_QUOTA_REQUEST_INVENTORY: readonly Phase2e5InventoryRow[] = Object.freeze([
	...historicalRows(),
	PRESENT_HEAD_ROW,
]);

export type Phase2gQuotaEdgeTarget = "creation" | "settlement" | "terminal";

export interface Phase2gQuotaEdge {
	readonly id: string;
	readonly requestIndex?: number;
	readonly scenarioId: string;
	readonly target: Phase2gQuotaEdgeTarget;
}

/**
 * Derives occurrence-sensitive creation/settlement/terminal cases from real traces.
 * @param observed - Real declared-equals-observed browser traces.
 * @returns The exact derived quota edges.
 */
export function derivePhase2gQuotaEdges(observed: readonly Phase2e5ObservedRow[]): readonly Phase2gQuotaEdge[] {
	return Object.freeze(
		observed.flatMap((row) => {
			const transaction = row.transactions[0];
			if (transaction?.mode !== "readwrite" || transaction.terminal !== "complete") return [];
			const writes = row.requests.flatMap((request, requestIndex) =>
				request.kind === "add" || request.kind === "put" ? [{ request, requestIndex }] : []
			);
			if (writes.length === 0) return [];
			return [
				...writes.flatMap(({ request, requestIndex }) => {
					const base = `${row.id}/request-${String(requestIndex).padStart(2, "0")}-${request.kind}-${request.store}`;
					return [
						{ id: `${base}/creation`, requestIndex, scenarioId: row.id, target: "creation" as const },
						{ id: `${base}/settlement`, requestIndex, scenarioId: row.id, target: "settlement" as const },
					];
				}),
				{ id: `${row.id}/transaction-terminal/quota-abort`, scenarioId: row.id, target: "terminal" as const },
			];
		})
	);
}

/**
 * Builds the exact declaration-shaped control observations.
 * @returns Frozen observations matching the finite declaration.
 */
export function declaredPhase2gObservations(): readonly Phase2e5ObservedRow[] {
	return PHASE_2G_QUOTA_REQUEST_INVENTORY.map((row) => ({
		id: row.id,
		requests: row.requests.map((request) => ({ ...request, transaction: 0 })),
		result: row.result,
		transactions: row.transaction === null ? [] : [{ ...row.transaction, id: 0 }],
	}));
}

/**
 * Checks declaration equality and the 9/13/35 drift checks.
 * @param observed - Real browser observations.
 * @returns Every finite inventory mismatch.
 */
export function phase2gQuotaInventoryErrors(observed: readonly Phase2e5ObservedRow[]): readonly string[] {
	const errors = [...phase2e5InventoryErrors(PHASE_2G_QUOTA_REQUEST_INVENTORY, observed)];
	const edges = derivePhase2gQuotaEdges(observed);
	const writes = observed.flatMap(({ requests }) => requests).filter(({ kind }) => kind === "add" || kind === "put");
	if (observed.length !== 9) errors.push(`quota inventory transaction count is ${observed.length}, expected 9`);
	if (writes.length !== 13) errors.push(`quota inventory write count is ${writes.length}, expected 13`);
	if (edges.length !== 35) errors.push(`quota inventory edge count is ${edges.length}, expected 35`);
	if (edges.filter(({ target }) => target === "creation").length !== 13) errors.push("creation edge count drifted");
	if (edges.filter(({ target }) => target === "settlement").length !== 13) errors.push("settlement edge count drifted");
	if (edges.filter(({ target }) => target === "terminal").length !== 9) errors.push("terminal edge count drifted");
	return Object.freeze(errors);
}

export interface Phase2gPhysicalRow {
	readonly keyBytesHex: string;
	readonly valueBytesHex: string;
}

export interface Phase2gWholeImage {
	readonly schemaVersion: number;
	readonly storeCensus: readonly string[];
	readonly stores: Readonly<Record<"blobs" | "generations" | "objects" | "promotions", readonly Phase2gPhysicalRow[]>>;
}

export interface Phase2gQuotaCaseEvidence {
	readonly afterReopen: Phase2gWholeImage;
	readonly before: Phase2gWholeImage;
	readonly causeIsSameObject: boolean;
	readonly causeIsSameRealmDOMException: boolean;
	readonly causeName: string;
	readonly edgeId: string;
	readonly expectedNew: Phase2gWholeImage;
	readonly faultsFired: number;
	readonly operationReturnedAfterTerminal: boolean;
	readonly quotaReasonAbsent: boolean;
	readonly resultReason: string;
	readonly retry: Phase2gWholeImage;
	readonly retryResult: string;
	readonly selectedOccurrenceInTrace: boolean;
	readonly staleRecoveryCertificateCleared: boolean;
	readonly storeRemainedOpenAndUnpoisoned: boolean;
}

export interface Phase2gRejectedInputEvidence {
	readonly faultArmed: boolean;
	readonly faultsFired: number;
	readonly resultReason: string;
	readonly writesObserved: number;
}

export interface Phase2gEngineQuotaEvidence {
	readonly capBytes: number;
	readonly elapsedMilliseconds: number;
	readonly engineGenerated: boolean;
	readonly faultProduced: boolean;
	readonly name: string;
	readonly supportedOverrideAttempted: boolean;
	readonly timeoutMilliseconds: number;
}

function stable(value: unknown): string {
	return JSON.stringify(value, (_key, nested) => {
		if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return nested;
		return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
	});
}

function imageErrors(image: Phase2gWholeImage, label: string): string[] {
	const errors: string[] = [];
	if (image.schemaVersion !== 1) errors.push(`${label}: schema version is not 1`);
	if (stable(image.storeCensus) !== stable(["blobs", "generations", "objects", "promotions"]))
		errors.push(`${label}: four-store census mismatch`);
	if (stable(Object.keys(image.stores).sort()) !== stable(["blobs", "generations", "objects", "promotions"]))
		errors.push(`${label}: whole-image store payload is incomplete`);
	for (const [store, rows] of Object.entries(image.stores)) {
		for (const row of rows) {
			if (!/^(?:[0-9a-f]{2})*$/u.test(row.keyBytesHex) || !/^(?:[0-9a-f]{2})*$/u.test(row.valueBytesHex))
				errors.push(`${label}: ${store} row lacks exact key/value bytes`);
		}
	}
	return errors;
}

/**
 * Checks one derived quota edge's cause, lifecycle and whole-image evidence.
 * @param edge - Exact trace-derived edge.
 * @param evidence - Browser evidence for the injected edge.
 * @returns Every acceptance mismatch.
 */
export function phase2gQuotaCaseErrors(edge: Phase2gQuotaEdge, evidence: Phase2gQuotaCaseEvidence): readonly string[] {
	const errors = [
		...imageErrors(evidence.before, "before"),
		...imageErrors(evidence.afterReopen, "afterReopen"),
		...imageErrors(evidence.expectedNew, "expectedNew"),
		...imageErrors(evidence.retry, "retry"),
	];
	if (evidence.edgeId !== edge.id) errors.push("wrong quota edge");
	if (!evidence.selectedOccurrenceInTrace) errors.push("fault is outside the observed trace");
	if (evidence.faultsFired !== 1) errors.push("fault did not fire exactly once");
	if (evidence.resultReason !== "SUBSTRATE_FAILURE") errors.push("quota changed the rejection taxonomy");
	if (!evidence.quotaReasonAbsent) errors.push("QUOTA_EXCEEDED entered the rejection taxonomy");
	if (!evidence.causeIsSameRealmDOMException || evidence.causeName !== "QuotaExceededError")
		errors.push("cause is not a genuine same-realm QuotaExceededError DOMException");
	if (!evidence.causeIsSameObject) errors.push("quota cause was swallowed or replaced");
	if (!evidence.operationReturnedAfterTerminal) errors.push("success/failure published before transaction terminal");
	if (!evidence.storeRemainedOpenAndUnpoisoned) errors.push("quota poisoned or closed the store");
	if (!evidence.staleRecoveryCertificateCleared) errors.push("stale recovery certificate survived quota failure");
	if (evidence.retryResult !== "OK") errors.push("unfaulted retry did not succeed");
	if (stable(evidence.before) === stable(evidence.expectedNew)) errors.push("scenario is observationally hollow");
	if (stable(evidence.afterReopen) !== stable(evidence.before)) errors.push("fault changed the physical old image");
	if (stable(evidence.retry) !== stable(evidence.expectedNew))
		errors.push("retry differs from isolated complete-new image");
	return Object.freeze(errors);
}

/**
 * Checks an armed structural or semantic rejection remains pre-write.
 * @param evidence - Rejected-input counters and result.
 * @returns Every zero-write/zero-fault mismatch.
 */
export function phase2gRejectedInputErrors(evidence: Phase2gRejectedInputEvidence): readonly string[] {
	const errors: string[] = [];
	if (!evidence.faultArmed) errors.push("rejected-input fault was not armed");
	if (evidence.writesObserved !== 0) errors.push("rejected input issued a write");
	if (evidence.faultsFired !== 0) errors.push("rejected input fired a fault");
	if (!REJECTED_INPUT_REASONS.has(evidence.resultReason)) errors.push("rejected input lost its existing result");
	return Object.freeze(errors);
}

/**
 * Checks the bounded engine-generated Chromium quota control.
 * @param evidence - Browser-engine quota evidence.
 * @returns Every engine-control mismatch.
 */
export function phase2gEngineQuotaErrors(evidence: Phase2gEngineQuotaEvidence): readonly string[] {
	const errors: string[] = [];
	if (!evidence.supportedOverrideAttempted) errors.push("supported Chromium quota override was not attempted");
	if (!evidence.engineGenerated) errors.push("quota cause was supplied by the harness");
	if (!evidence.faultProduced || evidence.name !== "QuotaExceededError")
		errors.push("engine quota fault was not produced");
	if (evidence.timeoutMilliseconds > 15_000 || evidence.elapsedMilliseconds > 15_000)
		errors.push("engine quota fallback exceeded 15 seconds");
	if (evidence.capBytes > 16 * 1024 * 1024) errors.push("engine quota fallback exceeded 16 MiB");
	return Object.freeze(errors);
}

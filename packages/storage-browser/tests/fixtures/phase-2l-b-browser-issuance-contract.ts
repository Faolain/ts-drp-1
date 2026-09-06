export const PHASE_2L_B_SCHEMA = Object.freeze({
	databaseVersion: 1,
	stores: Object.freeze([
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "author", "authorSequence"]),
			name: "issuanceOutbox",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "author", "authorSequence"]),
			name: "issuedRecords",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "author"]),
			name: "lineages",
		}),
	]),
});

export const PHASE_2L_B_SETTLEMENT_SCHEMA = Object.freeze({
	databaseVersion: 2,
	stores: Object.freeze([
		...PHASE_2L_B_SCHEMA.stores,
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "author"]),
			name: "settlementPlans",
		}),
	]),
});

export interface Phase2lBScope {
	readonly author: string;
	readonly objectId: string;
}

export interface Phase2lBEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

export interface Phase2lBCommit {
	readonly authorSequence: number;
	readonly envelope: Phase2lBEnvelope;
	readonly issuedRecord: Readonly<{ authorSequence: number; envelope: Phase2lBEnvelope; scope: Phase2lBScope }>;
	readonly outboxEntry: Readonly<{ authorSequence: number; envelope: Phase2lBEnvelope; scope: Phase2lBScope }>;
}

export interface Phase2lBStore {
	transactIssue(
		scope: Phase2lBScope,
		build: (authorSequence: number) => Promise<Phase2lBCommit>
	): Promise<Phase2lBCommit>;
	readIssued(scope: Phase2lBScope, authorSequence: number): Promise<Phase2lBCommit | null>;
	readLineage(scope: Phase2lBScope): Promise<Readonly<{ exhausted: boolean; next: number }>>;
	readOutboxPage(input?: {
		readonly afterKey?: readonly [string, string, number] | null;
		readonly limit?: number;
		readonly scope?: Phase2lBScope;
	}): Promise<readonly Readonly<{ commit: Phase2lBCommit; publishState: "pending" | "published" }>[]>;
	readSettlementPlan(scope: Phase2lBScope): Promise<unknown>;
	transactWriteSettlementPlan(input: unknown): Promise<unknown>;
	close(): Promise<void>;
}

export const PHASE_2L_B_SCENARIOS = Object.freeze(["fresh", "existing-lineage"] as const);
export const PHASE_2L_B_EDGES = Object.freeze([
	"suspended-build",
	"postbuild",
	"state-get",
	"lineage-write",
	"issued-add",
	"outbox-add",
	"abort",
	"complete",
] as const);

export type Phase2lBScenario = (typeof PHASE_2L_B_SCENARIOS)[number];
export type Phase2lBEdge = (typeof PHASE_2L_B_EDGES)[number];

export interface Phase2lBDeathTuple {
	readonly edge: Phase2lBEdge;
	readonly id: string;
	readonly nativeRequest: Readonly<{ method: "add" | "get" | "put"; store: string }> | null;
	readonly scenario: Phase2lBScenario;
	readonly terminalFate: "exact-new" | "old" | "old-xor-exact-new";
}

const PHASE_2L_B_TRANSACTION_STORES = Object.freeze(["issuanceOutbox", "issuedRecords", "lineages"] as const);

const PHASE_2L_B_SETTLEMENT_TRANSACTION_STORES = Object.freeze([
	...PHASE_2L_B_TRANSACTION_STORES,
	"settlementPlans",
] as const);

interface Phase2lBTraceEvent {
	readonly kind: string;
	readonly method?: string;
	readonly mode?: string;
	readonly requestId?: string;
	readonly store?: string;
	readonly stores?: readonly string[];
	readonly transactionId?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`invalid Phase 2l-b ${label}`);
	}
	return value as Record<string, unknown>;
}

function traceEvent(value: unknown): Phase2lBTraceEvent {
	return record(value, "trace event") as unknown as Phase2lBTraceEvent;
}

function exactStores(value: unknown, expectedStores: readonly string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expectedStores.length &&
		value.every((store, index) => store === expectedStores[index])
	);
}

function assertPhase2lBDeathArmEvidenceForStores(
	tuple: Phase2lBDeathTuple,
	value: unknown,
	expectedStores: readonly string[]
): void {
	const evidence = record(value, "death-arm evidence");
	if (evidence.edgeId !== tuple.id) throw new TypeError("wrong Phase 2l-b edge label");
	if (!Array.isArray(evidence.trace)) throw new TypeError("missing Phase 2l-b native trace");
	const trace = evidence.trace.map(traceEvent);
	const armIndexes = trace.flatMap((event, index) => (event.kind === "arm" ? [index] : []));
	const armIndex = armIndexes[0];
	if (armIndexes.length !== 1 || armIndex === undefined || armIndex !== trace.length - 1) {
		throw new TypeError("Phase 2l-b trace must contain one terminal arm");
	}
	const trigger = traceEvent(evidence.trigger);
	const target = evidence.targetTransaction === null ? null : traceEvent(evidence.targetTransaction);

	if (tuple.nativeRequest === null) {
		if (trigger.kind !== tuple.edge) throw new TypeError("wrong Phase 2l-b non-request trigger");
		if (tuple.edge === "abort" || tuple.edge === "complete") {
			if (
				target === null ||
				target.mode !== "readwrite" ||
				!exactStores(target.stores, expectedStores) ||
				trigger.transactionId !== target.transactionId
			)
				throw new TypeError("terminal event did not belong to the issuance mutation transaction");
		}
		return;
	}

	if (
		target === null ||
		target.mode !== "readwrite" ||
		!exactStores(target.stores, expectedStores) ||
		typeof target.transactionId !== "string"
	)
		throw new TypeError("missing exact Phase 2l-b mutation transaction");
	if (
		trigger.kind !== "request-success" ||
		trigger.method !== tuple.nativeRequest.method ||
		trigger.store !== tuple.nativeRequest.store ||
		typeof trigger.requestId !== "string" ||
		trigger.transactionId !== target.transactionId
	)
		throw new TypeError("death arm did not come from the declared mutation request");

	const transactionIndex = trace.findIndex(
		(event) => event.kind === "transaction-created" && event.transactionId === target.transactionId
	);
	const requestIndex = trace.findIndex(
		(event) =>
			event.kind === "request-created" &&
			event.requestId === trigger.requestId &&
			event.transactionId === target.transactionId
	);
	const successIndex = trace.findIndex(
		(event) =>
			event.kind === "request-success" &&
			event.requestId === trigger.requestId &&
			event.transactionId === target.transactionId
	);
	if (
		!(
			transactionIndex >= 0 &&
			transactionIndex < requestIndex &&
			requestIndex < successIndex &&
			successIndex < armIndex
		)
	) {
		throw new TypeError("Phase 2l-b native trace is out of order");
	}

	if (tuple.edge === "state-get") {
		const earlierSnapshot = trace.findIndex(
			(event, index) =>
				index < transactionIndex &&
				event.kind === "request-success" &&
				event.method === "get" &&
				event.store === "lineages" &&
				event.mode === "readonly" &&
				exactStores(event.stores, expectedStores)
		);
		if (earlierSnapshot < 0) throw new TypeError("missing unarmed pre-build lineage snapshot control");
	}
}

/**
 * Validates that a death arm was caused by the declared native event rather
 * than by a worker-supplied semantic label.
 * @param tuple - Frozen tuple whose physical edge must be demonstrated.
 * @param value - Untrusted evidence relayed from the killed browser worker.
 */
export function assertPhase2lBDeathArmEvidence(tuple: Phase2lBDeathTuple, value: unknown): void {
	assertPhase2lBDeathArmEvidenceForStores(tuple, value, PHASE_2L_B_TRANSACTION_STORES);
}

/**
 * Validates the settlement-plan death arm against the four-store transaction.
 * @param tuple - Frozen tuple whose physical edge must be demonstrated.
 * @param value - Untrusted evidence relayed from the killed browser worker.
 */
export function assertPhase2lBSettlementDeathArmEvidence(tuple: Phase2lBDeathTuple, value: unknown): void {
	assertPhase2lBDeathArmEvidenceForStores(tuple, value, PHASE_2L_B_SETTLEMENT_TRANSACTION_STORES);
}

function nativeRequest(scenario: Phase2lBScenario, edge: Phase2lBEdge): Phase2lBDeathTuple["nativeRequest"] {
	switch (edge) {
		case "state-get":
			return Object.freeze({ method: "get", store: "lineages" });
		case "lineage-write":
			return Object.freeze({ method: scenario === "fresh" ? "add" : "put", store: "lineages" });
		case "issued-add":
			return Object.freeze({ method: "add", store: "issuedRecords" });
		case "outbox-add":
			return Object.freeze({ method: "add", store: "issuanceOutbox" });
		default:
			return null;
	}
}

export const PHASE_2L_B_DEATH_TUPLES: readonly Phase2lBDeathTuple[] = Object.freeze(
	PHASE_2L_B_SCENARIOS.flatMap((scenario) =>
		PHASE_2L_B_EDGES.map((edge) =>
			Object.freeze({
				edge,
				id: `${scenario}/${edge}`,
				nativeRequest: nativeRequest(scenario, edge),
				scenario,
				terminalFate: edge === "abort" ? "old" : edge === "complete" ? "exact-new" : "old-xor-exact-new",
			})
		)
	)
);

export const PHASE_2L_B_AMBIGUITY_CASES = Object.freeze([
	"exact-pair",
	"absent-old",
	"foreign-pair",
	"torn-or-inconsistent",
	"unreadable",
] as const);

export const PHASE_2L_B_FAST_CASES = Object.freeze([
	"surface-options-identity",
	"primary-opacity-schema-admission",
	"v1-upgrade-preserves-committed-rows",
	"issue-read-copy-paging",
	"same-scope-race-and-cross-scope-progress",
	"close-versionchange-and-max",
	"collision-poison-and-ambiguity",
] as const);

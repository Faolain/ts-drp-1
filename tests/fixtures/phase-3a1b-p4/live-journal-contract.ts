import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

export const LIVE_JOURNAL_METHODS = Object.freeze([
	"appendAccepted",
	"close",
	"installGenesis",
	"readiness",
	"readPage",
] as const);

export const LIVE_JOURNAL_FAILURE_KINDS = Object.freeze([
	"malformed-input",
	"store-poisoned",
	"store-closed",
	"unsupported-schema",
	"durability-unavailable",
	"not-installed",
	"wrong-scope",
	"genesis-conflict",
	"noncanonical-preimage",
	"digest-mismatch",
	"evidence-conflict",
	"stale-snapshot",
	"substrate-failure",
	"outcome-unknown",
	"internal-invariant",
] as const);

export const LIVE_JOURNAL_DOMAINS = Object.freeze({
	order: "ts-drp/live-journal-order/v1",
	row: "ts-drp/live-journal-row/v1",
	snapshot: "ts-drp/live-journal-snapshot/v1",
});

export const LIVE_JOURNAL_SCOPE_KEYS = Object.freeze(["anchorDigest", "epoch", "objectId"] as const);
export const LIVE_JOURNAL_INSTALL_KEYS = Object.freeze([
	"detachedAnchorSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalParametersCarrierBytes",
	"objectId",
] as const);
export const LIVE_JOURNAL_RECEIVED_KEYS = Object.freeze([
	"detachedSignature",
	"exactCanonicalPreimageBytes",
	"scope",
	"sourceKind",
	"vertexDigest",
] as const);
export const LIVE_JOURNAL_LOCAL_KEYS = Object.freeze([
	"author",
	"authorSequence",
	"scope",
	"sourceKind",
	"vertexDigest",
] as const);

export const NODE_SCHEMA = Object.freeze({
	acceptedEntries:
		"CREATE TABLE accepted_entries (\n  object_id TEXT NOT NULL,\n  epoch INTEGER NOT NULL,\n  anchor_digest TEXT NOT NULL,\n  journal_sequence INTEGER NOT NULL,\n  source_kind TEXT NOT NULL,\n  vertex_digest TEXT NOT NULL,\n  received_preimage BLOB,\n  received_signature BLOB,\n  local_author TEXT,\n  local_author_sequence INTEGER,\n  PRIMARY KEY (object_id, epoch, anchor_digest, journal_sequence),\n  UNIQUE (object_id, epoch, anchor_digest, vertex_digest),\n  UNIQUE (object_id, epoch, anchor_digest, local_author, local_author_sequence),\n  CHECK (source_kind IN ('received', 'local-issued')),\n  CHECK (\n    (source_kind = 'received' AND received_preimage IS NOT NULL AND received_signature IS NOT NULL AND local_author IS NULL AND local_author_sequence IS NULL)\n    OR\n    (source_kind = 'local-issued' AND received_preimage IS NULL AND received_signature IS NULL AND local_author IS NOT NULL AND local_author_sequence IS NOT NULL)\n  )\n) WITHOUT ROWID",
	scopes:
		"CREATE TABLE scopes (\n  object_id TEXT NOT NULL,\n  epoch INTEGER NOT NULL,\n  anchor_digest TEXT NOT NULL,\n  next_journal_sequence INTEGER NOT NULL,\n  exact_anchor_preimage BLOB NOT NULL,\n  detached_anchor_signature BLOB NOT NULL,\n  parameters_digest TEXT NOT NULL,\n  exact_parameters_carrier BLOB NOT NULL,\n  PRIMARY KEY (object_id, epoch, anchor_digest)\n) WITHOUT ROWID",
});

export const NODE_SQLITE_CATALOG = Object.freeze([
	Object.freeze({
		name: "sqlite_autoindex_accepted_entries_2",
		sql: null,
		tbl_name: "accepted_entries",
		type: "index",
	}),
	Object.freeze({
		name: "sqlite_autoindex_accepted_entries_3",
		sql: null,
		tbl_name: "accepted_entries",
		type: "index",
	}),
	Object.freeze({
		name: "accepted_entries",
		sql: NODE_SCHEMA.acceptedEntries,
		tbl_name: "accepted_entries",
		type: "table",
	}),
	Object.freeze({ name: "scopes", sql: NODE_SCHEMA.scopes, tbl_name: "scopes", type: "table" }),
] as const);

export const BROWSER_SCHEMA = Object.freeze({
	acceptedEntriesKeyPath: Object.freeze(["objectId", "epoch", "anchorDigest", "journalSequence"]),
	digestUniq: Object.freeze(["objectId", "epoch", "anchorDigest", "vertexDigest"]),
	localRefUniq: Object.freeze(["objectId", "epoch", "anchorDigest", "localAuthor", "localAuthorSequence"]),
	scopesKeyPath: Object.freeze(["objectId", "epoch", "anchorDigest"]),
});

export const NODE_DEATH_EDGES = Object.freeze([
	"before-begin",
	"after-begin",
	"after-scope-read",
	"after-row-write",
	"after-commit",
	"during-readback",
] as const);
export const BROWSER_DEATH_EDGES = Object.freeze([
	"before-transaction",
	"after-transaction",
	"after-scope-read",
	"after-row-add",
	"transaction-complete",
	"during-readback",
] as const);
export const DEATH_SCENARIOS = Object.freeze(["install-genesis", "append-received", "append-local"] as const);
export const DEATH_SCOPE_SCENARIOS = Object.freeze(["single-scope", "two-scopes"] as const);
export const NO_WRITE_DEATH_SCENARIOS = Object.freeze([
	"idempotent-genesis",
	"received-repeat",
	"local-repeat",
	"cross-kind-race",
	"local-ref-race",
] as const);

export const NO_WRITE_DEATH_TUPLES = Object.freeze(
	NO_WRITE_DEATH_SCENARIOS.map((scenario) =>
		Object.freeze({ edge: "after-scope-read", id: `no-write/${scenario}`, scenario, scopeScenario: "single-scope" })
	)
);

export interface DeathTuple {
	readonly edge: string;
	readonly id: string;
	readonly scenario: string;
	readonly scopeScenario: (typeof DEATH_SCOPE_SCENARIOS)[number];
	readonly terminalFate: "exact-new" | "old-or-exact-new" | "old";
}

function deathFate(edge: string): DeathTuple["terminalFate"] {
	if (edge === "after-commit" || edge === "transaction-complete" || edge === "during-readback") return "exact-new";
	return "old";
}

export const NODE_DEATH_TUPLES: readonly DeathTuple[] = Object.freeze(
	DEATH_SCENARIOS.flatMap((scenario) =>
		DEATH_SCOPE_SCENARIOS.flatMap((scopeScenario) =>
			NODE_DEATH_EDGES.map((edge) =>
				Object.freeze({
					edge,
					id: `${scopeScenario}/${scenario}/${edge}`,
					scenario,
					scopeScenario,
					terminalFate: deathFate(edge),
				})
			)
		)
	)
);
export const BROWSER_DEATH_TUPLES: readonly DeathTuple[] = Object.freeze(
	DEATH_SCENARIOS.flatMap((scenario) =>
		DEATH_SCOPE_SCENARIOS.flatMap((scopeScenario) =>
			BROWSER_DEATH_EDGES.map((edge) =>
				Object.freeze({
					edge,
					id: `${scopeScenario}/${scenario}/${edge}`,
					scenario,
					scopeScenario,
					terminalFate: deathFate(edge),
				})
			)
		)
	)
);

export type ExistingRow =
	| Readonly<{ readonly digest: string; readonly kind: "received"; readonly ref: null }>
	| Readonly<{ readonly digest: string; readonly kind: "local-issued"; readonly ref: string }>;

export type DuplicateDecision =
	| Readonly<{ readonly action: "append" }>
	| Readonly<{ readonly action: "conflict" }>
	| Readonly<{ readonly action: "idempotent"; readonly retainedKind: ExistingRow["kind"] }>;

export interface LocalDuplicateProbe {
	readonly candidateDigest: string;
	readonly candidateRef: string;
	readonly digestRow: ExistingRow | null;
	readonly refRow: ExistingRow | null;
}

/**
 * Applies the frozen local-reference/digest precedence table.
 * @param input - Candidate and existing point-check observations.
 * @returns The sole permitted append/idempotent/conflict decision.
 */
export function decideLocalDuplicate(input: LocalDuplicateProbe): DuplicateDecision {
	const { candidateDigest, candidateRef, digestRow, refRow } = input;
	if (refRow !== null && refRow.digest !== candidateDigest) return { action: "conflict" };
	if (digestRow !== null && refRow !== null && digestRow !== refRow) return { action: "conflict" };
	if (refRow !== null && refRow.ref !== candidateRef) return { action: "conflict" };
	if (digestRow === null && refRow === null) return { action: "append" };
	if (digestRow?.kind === "received" && refRow === null) {
		return { action: "idempotent", retainedKind: "received" };
	}
	if (digestRow?.kind === "local-issued" && digestRow.ref !== candidateRef) return { action: "conflict" };
	if (digestRow?.kind === "local-issued" && refRow === digestRow) {
		return { action: "idempotent", retainedKind: "local-issued" };
	}
	return { action: "conflict" };
}

export const DUPLICATE_MATRIX = Object.freeze([
	Object.freeze({ digest: null, expected: "append", id: "both-absent", ref: null }),
	Object.freeze({
		digest: "same-local",
		expected: "idempotent-local-issued",
		id: "both-same-local",
		ref: "same-local",
	}),
	Object.freeze({ digest: "other-row", expected: "conflict", id: "digest-and-ref-distinct", ref: "same-local" }),
	Object.freeze({ digest: null, expected: "conflict", id: "only-ref", ref: "same-local" }),
	Object.freeze({ digest: "received", expected: "idempotent-received", id: "only-digest-received", ref: null }),
	Object.freeze({ digest: "other-local-ref", expected: "conflict", id: "only-digest-local-other-ref", ref: null }),
	Object.freeze({
		digest: "other-row",
		expected: "conflict",
		id: "ref-different-digest-wins",
		ref: "different-digest",
	}),
] as const);

function lowerHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

export interface LiveJournalMaterial {
	readonly anchorDigest: string;
	readonly anchorBytes: Uint8Array;
	readonly objectId: string;
	readonly parametersBytes: Uint8Array;
	readonly parametersDigest: string;
	readonly signature: Uint8Array;
	readonly vertexBytes: Uint8Array;
	readonly vertexDigest: string;
}

export interface RegistryConstraintMutation {
	readonly bytes: Uint8Array;
	readonly carrier: "anchor" | "parameters" | "received";
	readonly expectedKind: "noncanonical-preimage" | "wrong-scope";
	readonly id: string;
}

/** @returns One valid registry-v1 parameters record. */
function validParameters(): Readonly<Record<string, number>> {
	return {
		maxEpochVertices: 64,
		maxEpochBytes: 1_048_576,
		maxDependencies: 8,
		snapshotChunkBytes: 65_536,
		maxSnapshotBytes: 1_048_576,
		maxPendingEntries: 64,
		maxPendingBytes: 1_048_576,
	};
}

function validAnchor(parametersDigest: string, objectId: string): Readonly<Record<string, unknown>> {
	const zero = "0".repeat(64);
	return {
		kind: "drp-epoch-anchor",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		previousAnchor: zero,
		cutDigest: zero,
		stateDigest: zero,
		aclDigest: zero,
		historyRoot: zero,
		historySize: 0,
		archiveIndexRoot: zero,
		blueprintDigest: "2".repeat(64),
		signerSetDigest: "3".repeat(64),
		parametersDigest,
		profileDigest: "4".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
	};
}

function validVertex(anchorDigest: string, objectId: string): Readonly<Record<string, unknown>> {
	return {
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		anchor: anchorDigest,
		author: "creator",
		authorSequence: 0,
		logicalTime: 1,
		dependencies: ["5".repeat(64)],
		operation: { arguments: { value: 1 }, type: "append" },
	};
}

/**
 * Builds one executable mutant for every registry-v1 field constraint owned by p4.
 * Digest-field rows are deliberately per-field so a selective validator cannot pass.
 * @returns The closed executable mutation roster.
 */
export function createRegistryConstraintMutations(): readonly RegistryConstraintMutation[] {
	const material = createLiveJournalMaterial();
	const parameters = validParameters();
	const anchor = validAnchor(material.parametersDigest, material.objectId);
	const vertex = validVertex(material.anchorDigest, material.objectId);
	const mutations: RegistryConstraintMutation[] = [];
	const push = (
		carrier: RegistryConstraintMutation["carrier"],
		id: string,
		value: Readonly<Record<string, unknown>>,
		expectedKind: RegistryConstraintMutation["expectedKind"] = "noncanonical-preimage"
	): void => mutations.push(Object.freeze({ bytes: encodeCanonical(value), carrier, expectedKind, id }));
	const missing = (value: Readonly<Record<string, unknown>>, field: string): Readonly<Record<string, unknown>> => {
		const copy = { ...value };
		delete copy[field];
		return copy;
	};
	const anchorFields = Object.keys(anchor);
	const parameterFields = Object.keys(parameters);
	const vertexFields = Object.keys(vertex);
	for (const field of anchorFields) {
		push("anchor", `anchor-missing-${field}`, missing(anchor, field));
		push("anchor", `anchor-wrong-type-${field}`, { ...anchor, [field]: null });
	}
	for (const field of parameterFields) {
		push("parameters", `parameters-missing-${field}`, missing(parameters, field));
		push("parameters", `parameters-wrong-type-${field}`, { ...parameters, [field]: "64" });
	}
	for (const field of vertexFields) {
		push("received", `vertex-missing-${field}`, missing(vertex, field));
		push("received", `vertex-wrong-type-${field}`, { ...vertex, [field]: null });
	}
	push("anchor", "anchor-extra", { ...anchor, extra: true });
	push("parameters", "parameters-extra", { ...parameters, extra: true });
	push("received", "vertex-extra", { ...vertex, extra: true });

	for (const [id, field, value] of [
		["anchor-kind", "kind", "drp-epoch-anchor-x"],
		["anchor-protocol", "protocolMajor", 4],
		["anchor-object-empty", "objectId", ""],
		["anchor-object-long", "objectId", "x".repeat(1025)],
		["anchor-epoch-negative", "epoch", -1],
		["anchor-history-size-negative", "historySize", -1],
		["anchor-suite-reserved", "cryptoSuiteId", "p256-sha256-v3"],
	] as const)
		push("anchor", id, { ...anchor, [field]: value });
	for (const field of ["protocolMajor", "epoch", "historySize"] as const) {
		push("anchor", `anchor-${field}-fractional`, { ...anchor, [field]: Number(anchor[field]) + 0.5 });
	}
	for (const field of [
		"previousAnchor",
		"cutDigest",
		"stateDigest",
		"aclDigest",
		"historyRoot",
		"archiveIndexRoot",
		"blueprintDigest",
		"signerSetDigest",
		"parametersDigest",
		"profileDigest",
	] as const) {
		push("anchor", `anchor-${field}-digest-charset`, { ...anchor, [field]: "g".repeat(64) });
		push("anchor", `anchor-${field}-digest-case`, { ...anchor, [field]: "A".repeat(64) });
		push("anchor", `anchor-${field}-digest-length`, { ...anchor, [field]: "a".repeat(62) });
	}
	push("anchor", "anchor-creator-previous-nonzero", { ...anchor, previousAnchor: "1".repeat(64) });
	push("anchor", "anchor-creator-cut-nonzero", { ...anchor, cutDigest: "1".repeat(64) });
	push("anchor", "anchor-creator-history-nonzero", { ...anchor, historySize: 1 });
	push("anchor", "anchor-foreign-object", { ...anchor, objectId: `creator:${"9".repeat(32)}` }, "wrong-scope");

	const parameterBounds = [
		["maxEpochVertices", 32, 1_000_000],
		["maxEpochBytes", 65_536, 1_073_741_824],
		["maxDependencies", 1, 256],
		["snapshotChunkBytes", 16_384, 1_048_576],
		["maxSnapshotBytes", 1_048_576, 4_294_967_296],
		["maxPendingEntries", 1, 1_000_000],
		["maxPendingBytes", 65_536, 1_073_741_824],
	] as const;
	for (const [field, minimum, maximum] of parameterBounds) {
		push("parameters", `parameters-${field}-below`, { ...parameters, [field]: minimum - 1 });
		push("parameters", `parameters-${field}-above`, { ...parameters, [field]: maximum + 1 });
		push("parameters", `parameters-${field}-fractional`, { ...parameters, [field]: minimum + 0.5 });
	}

	for (const [id, field, value] of [
		["vertex-kind", "kind", "drp-vertex-x"],
		["vertex-protocol", "protocolMajor", 4],
		["vertex-object-empty", "objectId", ""],
		["vertex-object-long", "objectId", "x".repeat(1025)],
		["vertex-epoch-negative", "epoch", -1],
		["vertex-anchor-digest", "anchor", "g".repeat(64)],
		["vertex-author-empty", "author", ""],
		["vertex-author-long", "author", "x".repeat(1025)],
		["vertex-author-sequence-negative", "authorSequence", -1],
		["vertex-logical-time-zero", "logicalTime", 0],
		["vertex-dependencies-empty", "dependencies", []],
		["vertex-dependencies-duplicate", "dependencies", ["5".repeat(64), "5".repeat(64)]],
		["vertex-dependencies-unsorted", "dependencies", ["6".repeat(64), "5".repeat(64)]],
		["vertex-dependency-digest", "dependencies", ["g".repeat(64)]],
		["vertex-operation-not-object", "operation", []],
	] as const)
		push("received", id, { ...vertex, [field]: value });
	for (const field of ["protocolMajor", "epoch", "authorSequence", "logicalTime"] as const) {
		push("received", `vertex-${field}-fractional`, { ...vertex, [field]: Number(vertex[field]) + 0.5 });
	}
	push("received", "vertex-anchor-digest-case", { ...vertex, anchor: "A".repeat(64) });
	push("received", "vertex-anchor-digest-length", { ...vertex, anchor: "a".repeat(62) });
	push("received", "vertex-dependency-digest-case", { ...vertex, dependencies: ["A".repeat(64)] });
	push("received", "vertex-dependency-digest-length", { ...vertex, dependencies: ["a".repeat(62)] });
	push("received", "vertex-foreign-object", { ...vertex, objectId: `creator:${"9".repeat(32)}` }, "wrong-scope");
	push("received", "vertex-foreign-epoch", { ...vertex, epoch: 1 }, "wrong-scope");
	push("received", "vertex-foreign-anchor", { ...vertex, anchor: "9".repeat(64) }, "wrong-scope");
	return Object.freeze(mutations);
}

/**
 * Builds one independently canonicalized creator-genesis and received vertex.
 * @returns Detached exact carriers used by all p4 adapter tests.
 */
export function createLiveJournalMaterial(): LiveJournalMaterial {
	const objectId = `creator:${"1".repeat(32)}`;
	const parametersBytes = encodeCanonical(validParameters());
	const parametersDigest = lowerHex(hashDomain("ts-drp/parameters/v3", parametersBytes));
	const anchorBytes = encodeCanonical(validAnchor(parametersDigest, objectId));
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const vertexBytes = encodeCanonical(validVertex(anchorDigest, objectId));
	return Object.freeze({
		anchorDigest,
		anchorBytes,
		objectId,
		parametersBytes,
		parametersDigest,
		signature: new Uint8Array(64).fill(7),
		vertexBytes,
		vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", vertexBytes)),
	});
}

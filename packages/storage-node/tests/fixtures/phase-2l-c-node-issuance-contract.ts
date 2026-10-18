import { encodeCanonical } from "../../../canonical/dist/src/index.js";
import type { DurableIssuanceStore, DurableIssueCommit } from "../../../issuance-store/dist/src/index.js";

export const PHASE_2L_C_SUFFIX = ".drp-issuance-v1.sqlite";

export const PHASE_2L_C_V1_LINEAGES_DDL =
	"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID";

export const PHASE_2L_C_DDL = Object.freeze({
	lineages:
		"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  pruned_through_author_sequence INTEGER CHECK(pruned_through_author_sequence IS NULL OR pruned_through_author_sequence BETWEEN 0 AND 9007199254740991),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID",
	issued_records:
		"CREATE TABLE issued_records (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  canonical_preimage BLOB NOT NULL CHECK(typeof(canonical_preimage) = 'blob' AND length(canonical_preimage) > 0),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  signature BLOB NOT NULL CHECK(typeof(signature) = 'blob' AND length(signature) > 0),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID",
	issuance_outbox:
		"CREATE TABLE issuance_outbox (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  publish_state TEXT NOT NULL CHECK(publish_state IN ('pending','published')),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID",
} as const);

export const PHASE_2L_C_V3_DDL = Object.freeze({
	...PHASE_2L_C_DDL,
	settlement_plans:
		"CREATE TABLE settlement_plans (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),\n  fence_sequence INTEGER CHECK(fence_sequence IS NULL OR fence_sequence BETWEEN 0 AND 9007199254740991),\n  entries_json TEXT NOT NULL CHECK(typeof(entries_json) = 'text' AND length(entries_json) > 0),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID",
} as const);

export const PHASE_2L_C_SCENARIOS = Object.freeze(["fresh", "existing-lineage"] as const);
export const PHASE_2L_C_EDGES = Object.freeze([
	"suspended-build",
	"postbuild",
	"begin",
	"state-select",
	"lineage-write",
	"issued-insert",
	"outbox-insert",
	"rollback",
	"commit",
] as const);
export const PHASE_2L_C_AMBIGUITY_CASES = Object.freeze([
	"exact-pair",
	"absent-old",
	"foreign-pair",
	"torn-or-inconsistent",
	"unreadable",
] as const);

export type Phase2lCScenario = (typeof PHASE_2L_C_SCENARIOS)[number];
export type Phase2lCEdge = (typeof PHASE_2L_C_EDGES)[number];

export interface Phase2lCDeathTuple {
	readonly edge: Phase2lCEdge;
	readonly id: string;
	readonly scenario: Phase2lCScenario;
	readonly terminalFate: "exact-new" | "old";
}

export const PHASE_2L_C_DEATH_TUPLES: readonly Phase2lCDeathTuple[] = Object.freeze(
	PHASE_2L_C_SCENARIOS.flatMap((scenario) =>
		PHASE_2L_C_EDGES.map((edge) =>
			Object.freeze({
				edge,
				id: `${scenario}/${edge}`,
				scenario,
				terminalFate: edge === "commit" ? "exact-new" : "old",
			})
		)
	)
);

export const PHASE_2L_C_SCOPE = Object.freeze({ author: "alice", objectId: "room:alpha" });

/**
 * Builds one valid closed test commit.
 * @param authorSequence - Selected issuance ordinal.
 * @param seed - First byte used to distinguish candidate ownership.
 * @returns A valid detached issuance closure.
 */
export function phase2lCCommit(authorSequence: number, seed = 7): DurableIssueCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...PHASE_2L_C_SCOPE, authorSequence }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope: PHASE_2L_C_SCOPE },
		outboxEntry: { authorSequence, envelope, scope: PHASE_2L_C_SCOPE },
	};
}

export interface Phase2lCNodeModule {
	createNodeDurableIssuanceStore(options: { readonly primaryFilename: string }): DurableIssuanceStore;
}

/**
 * Loads either the built Node candidate or an explicit test-only mutant.
 * @returns The narrowed Phase 2l-c module surface.
 */
export async function loadPhase2lCNodeModule(): Promise<Phase2lCNodeModule> {
	const override = process.env.PHASE_2L_C_CANDIDATE_MODULE;
	const candidate = override ?? new URL("../../dist/src/issuance.js", import.meta.url).href;
	const namespace = (await import(candidate)) as Partial<Phase2lCNodeModule>;
	if (typeof namespace.createNodeDurableIssuanceStore !== "function") {
		throw new TypeError("Phase 2l-c candidate does not export createNodeDurableIssuanceStore");
	}
	return namespace as Phase2lCNodeModule;
}

/**
 * Derives the exact sibling issuance filename.
 * @param primaryFilename - Opaque primary store filename.
 * @returns The exact Node issuance filename.
 */
export function derivedFilename(primaryFilename: string): string {
	return `${primaryFilename}${PHASE_2L_C_SUFFIX}`;
}

/**
 * Projects one error to its closed observable taxonomy.
 * @param error - Unknown thrown value.
 * @returns Only the public error discriminator fields.
 */
export function errorShape(error: unknown): Record<string, unknown> {
	if (typeof error !== "object" || error === null) return { code: "NON_OBJECT" };
	return {
		code: Reflect.get(error, "code"),
		name: Reflect.get(error, "name"),
		retryClass: Reflect.get(error, "retryClass"),
	};
}

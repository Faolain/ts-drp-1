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
	"issue-read-copy-paging",
	"same-scope-race-and-cross-scope-progress",
	"close-versionchange-and-max",
	"collision-poison-and-ambiguity",
] as const);

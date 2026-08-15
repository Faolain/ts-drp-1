export const P4_NODE_METHODS = Object.freeze([
	"appendAccepted",
	"close",
	"installGenesis",
	"readiness",
	"readPage",
] as const);

export const P4_NODE_SCHEMA = Object.freeze({
	acceptedEntries:
		"CREATE TABLE accepted_entries (\n  object_id TEXT NOT NULL,\n  epoch INTEGER NOT NULL,\n  anchor_digest TEXT NOT NULL,\n  journal_sequence INTEGER NOT NULL,\n  source_kind TEXT NOT NULL,\n  vertex_digest TEXT NOT NULL,\n  received_preimage BLOB,\n  received_signature BLOB,\n  local_author TEXT,\n  local_author_sequence INTEGER,\n  PRIMARY KEY (object_id, epoch, anchor_digest, journal_sequence),\n  UNIQUE (object_id, epoch, anchor_digest, vertex_digest),\n  UNIQUE (object_id, epoch, anchor_digest, local_author, local_author_sequence),\n  CHECK (source_kind IN ('received', 'local-issued')),\n  CHECK (\n    (source_kind = 'received' AND received_preimage IS NOT NULL AND received_signature IS NOT NULL AND local_author IS NULL AND local_author_sequence IS NULL)\n    OR\n    (source_kind = 'local-issued' AND received_preimage IS NULL AND received_signature IS NULL AND local_author IS NOT NULL AND local_author_sequence IS NOT NULL)\n  )\n) WITHOUT ROWID",
	scopes:
		"CREATE TABLE scopes (\n  object_id TEXT NOT NULL,\n  epoch INTEGER NOT NULL,\n  anchor_digest TEXT NOT NULL,\n  next_journal_sequence INTEGER NOT NULL,\n  exact_anchor_preimage BLOB NOT NULL,\n  detached_anchor_signature BLOB NOT NULL,\n  parameters_digest TEXT NOT NULL,\n  exact_parameters_carrier BLOB NOT NULL,\n  PRIMARY KEY (object_id, epoch, anchor_digest)\n) WITHOUT ROWID",
});

export const P4_NODE_SQLITE_CATALOG = Object.freeze([
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
		sql: P4_NODE_SCHEMA.acceptedEntries,
		tbl_name: "accepted_entries",
		type: "table",
	}),
	Object.freeze({ name: "scopes", sql: P4_NODE_SCHEMA.scopes, tbl_name: "scopes", type: "table" }),
] as const);

const EDGES = [
	"before-begin",
	"after-begin",
	"after-scope-read",
	"after-row-write",
	"after-commit",
	"during-readback",
] as const;
const OPERATIONS = ["install-genesis", "append-received", "append-local"] as const;
const SCOPES = ["single-scope", "two-scopes"] as const;

export interface P4NodeDeathTuple {
	readonly edge: (typeof EDGES)[number];
	readonly id: string;
	readonly scenario: (typeof OPERATIONS)[number];
	readonly scopeScenario: (typeof SCOPES)[number];
	readonly terminalFate: "exact-new" | "old";
}

export const P4_NODE_DEATH_TUPLES: readonly P4NodeDeathTuple[] = Object.freeze(
	OPERATIONS.flatMap((scenario) =>
		SCOPES.flatMap((scopeScenario) =>
			EDGES.map((edge) =>
				Object.freeze({
					edge,
					id: `${scopeScenario}/${scenario}/${edge}`,
					scenario,
					scopeScenario,
					terminalFate: edge === "after-commit" || edge === "during-readback" ? "exact-new" : "old",
				})
			)
		)
	)
);

export const P4_NODE_NO_WRITE_DEATH_TUPLES = Object.freeze(
	["idempotent-genesis", "received-repeat", "local-repeat", "cross-kind-race", "local-ref-race"].map((scenario) =>
		Object.freeze({ edge: "after-scope-read", id: `no-write/${scenario}`, scenario, scopeScenario: "single-scope" })
	)
);

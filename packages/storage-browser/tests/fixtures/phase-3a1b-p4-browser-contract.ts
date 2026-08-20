export const P4_BROWSER_METHODS = Object.freeze([
	"appendAccepted",
	"close",
	"installGenesis",
	"readiness",
	"readPage",
] as const);

export const P4_BROWSER_SCHEMA = Object.freeze({
	acceptedEntriesKeyPath: Object.freeze(["objectId", "epoch", "anchorDigest", "journalSequence"]),
	digestUniq: Object.freeze(["objectId", "epoch", "anchorDigest", "vertexDigest"]),
	localRefUniq: Object.freeze(["objectId", "epoch", "anchorDigest", "localAuthor", "localAuthorSequence"]),
	scopesKeyPath: Object.freeze(["objectId", "epoch", "anchorDigest"]),
});

const EDGES = [
	"before-transaction",
	"after-transaction",
	"after-scope-read",
	"after-row-add",
	"transaction-complete",
	"during-readback",
] as const;
const OPERATIONS = ["install-genesis", "append-received", "append-local"] as const;
const SCOPES = ["single-scope", "two-scopes"] as const;

export interface P4BrowserDeathTuple {
	readonly edge: (typeof EDGES)[number];
	readonly id: string;
	readonly scenario: (typeof OPERATIONS)[number];
	readonly scopeScenario: (typeof SCOPES)[number];
	readonly terminalFate: "exact-new" | "old";
}

export const P4_BROWSER_DEATH_TUPLES: readonly P4BrowserDeathTuple[] = Object.freeze(
	OPERATIONS.flatMap((scenario) =>
		SCOPES.flatMap((scopeScenario) =>
			EDGES.map((edge) =>
				Object.freeze({
					edge,
					id: `${scopeScenario}/${scenario}/${edge}`,
					scenario,
					scopeScenario,
					terminalFate: edge === "transaction-complete" || edge === "during-readback" ? "exact-new" : "old",
				})
			)
		)
	)
);

export const P4_BROWSER_NO_WRITE_DEATH_TUPLES = Object.freeze(
	["idempotent-genesis", "received-repeat", "local-repeat", "cross-kind-race", "local-ref-race"].map((scenario) =>
		Object.freeze({ edge: "after-scope-read", id: `no-write/${scenario}`, scenario, scopeScenario: "single-scope" })
	)
);

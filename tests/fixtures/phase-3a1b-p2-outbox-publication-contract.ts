import { encodeCanonical } from "../../packages/canonical/dist/src/index.js";
import type {
	DurableIssuanceStore as ActualDurableIssuanceStore,
	DurableOutboxPublicationTransitionInput as ActualPublicationInput,
} from "../../packages/issuance-store/src/types.js";

type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;

type ExpectedPublicationInput = {
	readonly authorSequence: number;
	readonly digest: Uint8Array;
	readonly scope: { readonly author: string; readonly objectId: string };
};

export const PHASE_3A1B_P2_TYPE_PINS: readonly [
	Equal<ActualPublicationInput, ExpectedPublicationInput>,
	Equal<ReturnType<ActualDurableIssuanceStore["compareAndMarkOutboxPublished"]>, Promise<void>>,
] = [true, true];

export const PHASE_3A1B_P2_METHODS = Object.freeze([
	"close",
	"compareAndMarkOutboxPublished",
	"readIssued",
	"readLineage",
	"readOutboxPage",
	"transactIssue",
] as const);

export const PHASE_3A1B_P2_NODE_TRACE = Object.freeze([
	"begin-immediate",
	"lineage-select",
	"issued-read",
	"outbox-read",
	"outbox-update",
	"mutation-commit",
	"readonly-begin",
	"lineage-select",
	"issued-read",
	"outbox-read",
	"readonly-commit",
] as const);

export const PHASE_3A1B_P2_SCENARIOS = Object.freeze(["single-row", "two-rows"] as const);
export const PHASE_3A1B_P2_MUTATION_EDGES = Object.freeze([
	"pre-begin",
	"begin",
	"closure-read",
	"outbox-update",
	"commit",
	"readback",
] as const);
export const PHASE_3A1B_P2_PUBLISHED_EDGES = Object.freeze([
	"already-published-read",
	"already-published-commit",
] as const);
export const PHASE_3A1B_P2_BROWSER_MUTATION_EDGES = Object.freeze([
	"pre-transaction",
	"transaction-created",
	"closure-read",
	"outbox-put",
	"complete",
	"readback",
] as const);
export const PHASE_3A1B_P2_BROWSER_PUBLISHED_EDGES = Object.freeze([
	"already-published-read",
	"already-published-complete",
] as const);

export type Phase3a1bP2Scenario = (typeof PHASE_3A1B_P2_SCENARIOS)[number];
export type Phase3a1bP2MutationEdge = (typeof PHASE_3A1B_P2_MUTATION_EDGES)[number];
export type Phase3a1bP2PublishedEdge = (typeof PHASE_3A1B_P2_PUBLISHED_EDGES)[number];

export interface Phase3a1bP2DeathTuple {
	readonly edge: Phase3a1bP2MutationEdge | Phase3a1bP2PublishedEdge;
	readonly id: string;
	readonly scenario: Phase3a1bP2Scenario | "already-published";
	readonly terminalFate: "exact-new" | "old";
}

export interface Phase3a1bP2BrowserDeathTuple {
	readonly edge:
		| (typeof PHASE_3A1B_P2_BROWSER_MUTATION_EDGES)[number]
		| (typeof PHASE_3A1B_P2_BROWSER_PUBLISHED_EDGES)[number];
	readonly id: string;
	readonly scenario: Phase3a1bP2Scenario | "already-published";
	readonly terminalFate: "exact-new" | "old";
}

export const PHASE_3A1B_P2_DEATH_TUPLES: readonly Phase3a1bP2DeathTuple[] = Object.freeze([
	...PHASE_3A1B_P2_SCENARIOS.flatMap((scenario) =>
		PHASE_3A1B_P2_MUTATION_EDGES.map((edge) =>
			Object.freeze({
				edge,
				id: `${scenario}/${edge}`,
				scenario,
				terminalFate: edge === "commit" || edge === "readback" ? ("exact-new" as const) : ("old" as const),
			})
		)
	),
	...PHASE_3A1B_P2_PUBLISHED_EDGES.map((edge) =>
		Object.freeze({
			edge,
			id: `already-published/${edge}`,
			scenario: "already-published" as const,
			terminalFate: "exact-new" as const,
		})
	),
]);

export const PHASE_3A1B_P2_BROWSER_DEATH_TUPLES: readonly Phase3a1bP2BrowserDeathTuple[] = Object.freeze([
	...PHASE_3A1B_P2_SCENARIOS.flatMap((scenario) =>
		PHASE_3A1B_P2_BROWSER_MUTATION_EDGES.map((edge) =>
			Object.freeze({
				edge,
				id: `${scenario}/${edge}`,
				scenario,
				terminalFate: edge === "complete" || edge === "readback" ? ("exact-new" as const) : ("old" as const),
			})
		)
	),
	...PHASE_3A1B_P2_BROWSER_PUBLISHED_EDGES.map((edge) =>
		Object.freeze({
			edge,
			id: `already-published/${edge}`,
			scenario: "already-published" as const,
			terminalFate: "exact-new" as const,
		})
	),
]);

export interface Phase3a1bP2Scope {
	readonly author: string;
	readonly objectId: string;
}

export interface Phase3a1bP2Envelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

export interface Phase3a1bP2Commit {
	readonly authorSequence: number;
	readonly envelope: Phase3a1bP2Envelope;
	readonly issuedRecord: {
		readonly authorSequence: number;
		readonly envelope: Phase3a1bP2Envelope;
		readonly scope: Phase3a1bP2Scope;
	};
	readonly outboxEntry: {
		readonly authorSequence: number;
		readonly envelope: Phase3a1bP2Envelope;
		readonly scope: Phase3a1bP2Scope;
	};
}

export interface Phase3a1bP2OutboxRecord {
	readonly commit: Phase3a1bP2Commit;
	readonly publishState: "pending" | "published";
}

export interface Phase3a1bP2Store {
	close(): Promise<void>;
	compareAndMarkOutboxPublished(input: {
		readonly authorSequence: number;
		readonly digest: Uint8Array;
		readonly scope: Phase3a1bP2Scope;
	}): Promise<void>;
	readIssued(scope: Phase3a1bP2Scope, authorSequence: number): Promise<Phase3a1bP2Commit | null>;
	readLineage(scope: Phase3a1bP2Scope): Promise<{ readonly exhausted: boolean; readonly next: number }>;
	readOutboxPage(input?: {
		readonly afterKey?: readonly [string, string, number] | null;
		readonly limit?: number;
		readonly scope?: Phase3a1bP2Scope;
	}): Promise<readonly Phase3a1bP2OutboxRecord[]>;
	transactIssue(
		scope: Phase3a1bP2Scope,
		buildAndSign: (authorSequence: number) => Promise<Phase3a1bP2Commit>
	): Promise<Phase3a1bP2Commit>;
}

export interface Phase3a1bP2PublicationSnapshot {
	readonly issued: readonly Readonly<{
		authorSequence: number;
		digest: readonly number[];
		preimage: readonly number[];
		scope: Phase3a1bP2Scope;
		signature: readonly number[];
	}>[];
	readonly lineages: readonly Readonly<{
		exhausted: boolean;
		next: number;
		scope: Phase3a1bP2Scope;
	}>[];
	readonly outbox: readonly Readonly<{
		authorSequence: number;
		digest: readonly number[];
		preimage: readonly number[];
		publishState: "pending" | "published";
		scope: Phase3a1bP2Scope;
		signature: readonly number[];
	}>[];
}

export const PHASE_3A1B_P2_SCOPE = Object.freeze({ author: "alice", objectId: "room:publication" });
export const PHASE_3A1B_P2_OTHER_SCOPE = Object.freeze({ author: "bob", objectId: "room:unaddressed" });

function deathCommit(scope: Phase3a1bP2Scope, seed: number): Phase3a1bP2Commit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence: 0 }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence: 0,
		envelope,
		issuedRecord: { authorSequence: 0, envelope, scope },
		outboxEntry: { authorSequence: 0, envelope, scope },
	};
}

function snapshotRow(
	commit: Phase3a1bP2Commit
): Omit<Phase3a1bP2PublicationSnapshot["outbox"][number], "publishState"> {
	return {
		authorSequence: commit.authorSequence,
		digest: [...commit.envelope.digest],
		preimage: [...commit.envelope.canonicalPreimageBytes],
		scope: { ...commit.outboxEntry.scope },
		signature: [...commit.envelope.signature],
	};
}

/**
 * Captures every durable fact Seam 2 death recovery must preserve.
 * @param store - Freshly reopened durable issuance authority.
 * @param scopes - Independently seeded exact scope inventory.
 * @returns Exact lineages, issued closures and outbox rows.
 */
export async function snapshotPhase3a1bP2Store(
	store: Phase3a1bP2Store,
	scopes: readonly Phase3a1bP2Scope[]
): Promise<Phase3a1bP2PublicationSnapshot> {
	const rows = await store.readOutboxPage();
	if (rows.length !== scopes.length) throw new TypeError("Seam 2 recovery has extra or missing outbox rows");
	const issued = await Promise.all(scopes.map((scope) => store.readIssued(scope, 0)));
	if (issued.some((commit) => commit === null)) throw new TypeError("Seam 2 recovery is missing one issued closure");
	return {
		issued: issued.map((commit) => snapshotRow(requiredCommit(commit))),
		lineages: await Promise.all(
			scopes.map(async (scope) => ({ ...(await store.readLineage(scope)), scope: { ...scope } }))
		),
		outbox: rows.map(({ commit, publishState }) => ({ ...snapshotRow(commit), publishState })),
	};
}

function requiredCommit(commit: Phase3a1bP2Commit | null): Phase3a1bP2Commit {
	if (commit === null) throw new TypeError("Seam 2 recovery is missing one issued closure");
	return commit;
}

/**
 * Builds the exact deterministic post-crash snapshot for one registered tuple.
 * @param scenario - Seeded death-campaign scenario.
 * @param terminalFate - Frozen old-or-new terminal state.
 * @returns Complete expected durable snapshot.
 */
export function expectedPhase3a1bP2Snapshot(
	scenario: Phase3a1bP2Scenario | "already-published",
	terminalFate: "exact-new" | "old"
): Phase3a1bP2PublicationSnapshot {
	const commits = [deathCommit(PHASE_3A1B_P2_SCOPE, 41)];
	if (scenario !== "single-row") commits.push(deathCommit(PHASE_3A1B_P2_OTHER_SCOPE, 73));
	const published = scenario === "already-published" || terminalFate === "exact-new";
	return {
		issued: commits.map(snapshotRow),
		lineages: commits.map((commit) => ({ exhausted: false, next: 1, scope: { ...commit.outboxEntry.scope } })),
		outbox: commits.map((commit, index) => ({
			...snapshotRow(commit),
			publishState: index === 0 && published ? "published" : "pending",
		})),
	};
}

/**
 * Builds one deterministic valid issuance closure.
 * @param scope - Exact durable issuance scope.
 * @param authorSequence - Selected author ordinal.
 * @param seed - Distinguishing envelope byte.
 * @returns A detached valid closure.
 */
export function phase3a1bP2Commit(
	scope: Phase3a1bP2Scope,
	authorSequence: number,
	seed = authorSequence + 17
): Phase3a1bP2Commit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ author: scope.author, authorSequence, objectId: scope.objectId }),
		digest: Uint8Array.of(seed & 0xff, 0xd1),
		signature: Uint8Array.of(seed & 0xff, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope: { ...scope } },
		outboxEntry: { authorSequence, envelope, scope: { ...scope } },
	};
}

/**
 * Projects an error to the closed public taxonomy.
 * @param error - Unknown rejection value.
 * @returns Only public discriminator fields.
 */
export function errorShape(error: unknown): Readonly<Record<string, unknown>> {
	if (typeof error !== "object" || error === null) return Object.freeze({ code: "NON_OBJECT" });
	return Object.freeze({
		code: Reflect.get(error, "code"),
		name: Reflect.get(error, "name"),
		retryClass: Reflect.get(error, "retryClass"),
		scope: Reflect.get(error, "scope"),
	});
}

/** Verifies both exact fourteen-tuple death registries. */
export function assertExactDeathRegistry(): void {
	if (PHASE_3A1B_P2_DEATH_TUPLES.length !== 14)
		throw new TypeError("Seam 2 death registry must contain fourteen tuples");
	const ids = new Set(PHASE_3A1B_P2_DEATH_TUPLES.map(({ id }) => id));
	if (ids.size !== 14) throw new TypeError("Seam 2 death tuple ids must be unique");
	for (const tuple of PHASE_3A1B_P2_DEATH_TUPLES) {
		const expected =
			tuple.edge === "commit" ||
			tuple.edge === "readback" ||
			tuple.edge === "already-published-read" ||
			tuple.edge === "already-published-commit"
				? "exact-new"
				: "old";
		if (tuple.terminalFate !== expected) throw new TypeError(`wrong deterministic fate for ${tuple.id}`);
	}
	if (PHASE_3A1B_P2_BROWSER_DEATH_TUPLES.length !== 14) {
		throw new TypeError("Seam 2 browser death registry must contain fourteen tuples");
	}
	if (new Set(PHASE_3A1B_P2_BROWSER_DEATH_TUPLES.map(({ id }) => id)).size !== 14) {
		throw new TypeError("Seam 2 browser death tuple ids must be unique");
	}
}

export const DURABLE_ISSUANCE_ERROR_CODES = Object.freeze([
	"ISSUANCE_INVALID_ARGUMENT",
	"ISSUANCE_EXHAUSTED",
	"ISSUANCE_COMMIT_INVALID",
	"ISSUANCE_RETRY_REQUIRED",
	"ISSUANCE_STORE_CLOSED",
	"ISSUANCE_UNSUPPORTED_SCHEMA",
	"ISSUANCE_DURABILITY_UNAVAILABLE",
	"ISSUANCE_SUBSTRATE_FAILURE",
	"ISSUANCE_RECOVERY_CORRUPT",
	"ISSUANCE_RECORD_PRUNED",
	"ISSUANCE_OUTCOME_UNKNOWN",
] as const);

export const DURABLE_ISSUANCE_RETRY_CLASSES = Object.freeze(["transient", "resource-exhausted", "permanent"] as const);

export const DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT = 64;
export const MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT = 128;
export const MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS = 1024;

export type DurableIssuanceErrorCode = (typeof DURABLE_ISSUANCE_ERROR_CODES)[number];
export type DurableIssuanceRetryClass = (typeof DURABLE_ISSUANCE_RETRY_CLASSES)[number];
export type DurableIssuancePublishState = "pending" | "published";

export interface DurableIssueScope {
	readonly author: string;
	readonly objectId: string;
}

export interface DurableSignedEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

export interface DurableIssuedRecord {
	readonly authorSequence: number;
	readonly envelope: DurableSignedEnvelope;
	readonly scope: DurableIssueScope;
}

export interface DurableIssuanceOutboxEntry {
	readonly authorSequence: number;
	readonly envelope: DurableSignedEnvelope;
	readonly scope: DurableIssueScope;
}

export type SettlementDisposition = "expire" | "rebase" | "transform" | "manual-review" | "inherited" | "committed";

export const SETTLEMENT_REPLACEMENT_MAX_INTENTS = 16;
export const SETTLEMENT_REPLACEMENT_DIGEST_LIMITS = Object.freeze({
	maxBytes: 1_048_640,
	maxDepth: 9,
	maxItems: 1_024,
});

export interface SettlementReplacementChunk {
	readonly replacementSequence: number;
	readonly throughIntent: number;
	readonly lastLogicalTime: number;
}

export interface SettlementReplacementProgress {
	readonly version: 1;
	readonly intentCount: number;
	readonly intentDigest: Uint8Array;
	readonly chunks: readonly SettlementReplacementChunk[];
}

/** Exact retained reference; authentication belongs to the shared migration owner. */
export interface SettlementInheritance {
	readonly sourceObjectId: string;
	readonly targetObjectId: string;
	readonly targetAuthor: string;
	readonly targetAuthorSequence: number;
	readonly targetVertexDigest: Uint8Array;
}

export interface SettlementTransformRefusal {
	readonly version: 1;
	readonly kind: "admission-refused";
	readonly proposedIntentDigest: Uint8Array;
	readonly reason: "capacity" | "identity-conflict" | "encoding";
}

export interface SettlementPlanEntry {
	/** Original external native source; shared held migration custody authenticates it. */
	readonly sourceObjectId?: string;
	/** Mechanical reference to exact historical authentication bytes; the node re-verifies their authority. */
	readonly sourceContextDigest?: Uint8Array;
	/** Exact retained resolution evidence; only the original Node proof owner authenticates it. */
	readonly sourceResolutionDigest?: Uint8Array;
	/**
	 * "frontier": the resolution was decided on the creator's signed settlement frontier, which proves
	 * the source committed or never admitted in its closed epoch (an `expire` with the author's signed
	 * receipt). Unlike a local-author abandonment it may follow publication. Absent: the original
	 * resolution kinds. Older readers refuse the field (closed record).
	 * "replacement" (only with sourceResolutionScope "replaced-source"): the replaced source is released
	 * because its replacement is committed: the resolution names the replacement's own completion proof
	 * (the creator-signed Cut membership already stored on the replacement's `committed` entry). No new
	 * signature; Node proves the replacement link from signed content on every install.
	 */
	readonly sourceResolutionKind?: "frontier" | "replacement";
	/**
	 * "replaced-source": the frontier resolution sits on a completed replacement entry (`rebase` or
	 * `transform`, its replacement issued), not on an expiry: the author's signed receipt that the
	 * creator's signed frontier proves the replaced source settled (the frontier passed it, or it is
	 * displaced, fence-guarded and past the settlement window). The move stays with the replacement; the
	 * receipt only lets retirement stop protecting the source without the plan's current fence. It
	 * arrives once, after the replacement, and never changes. Older readers refuse the field (closed
	 * record): a downgrade after a release fails closed on first open.
	 */
	readonly sourceResolutionScope?: "replaced-source";
	readonly sourceSequence: number;
	readonly sourceDigest: Uint8Array;
	readonly disposition: SettlementDisposition;
	readonly replacementSequence: number | null;
	readonly replacementProgress?: SettlementReplacementProgress;
	readonly inheritance?: SettlementInheritance;
	readonly transformRefusal?: SettlementTransformRefusal;
}

/** Shared exact bytes, retained for as long as any settlement source refers to them. */
export interface SettlementSourceContext {
	readonly digest: Uint8Array;
	readonly exactCanonicalContextBytes: Uint8Array;
}

/**
 * Bounds on a plan's hand-back records (all records, consumed or not): an unconsumed record is an
 * application move held for the application, so their number and bytes are capped. A move whose
 * records do not fit is not given back yet: the writer keeps it live (it is not expired) until records
 * are free, and refuses new local moves while its backlog fills the record bound (V3RoomLocalBacklogFull).
 */
export const SETTLEMENT_HAND_BACK_LIMITS = Object.freeze({
	maxRecords: 64,
	maxOperationBytes: 16_384,
});

/**
 * One operation the settlement window (or the creator's signed frontier) gave back to the application:
 * the exact canonical operation of intent `intent` of the resolved own row `sourceSequence`. Written in
 * the same plan write as that resolution, so it outlives the row's retirement; consumed by the issuance
 * transaction of the row that offers the move again (plan effect `hand-back`), which sets
 * `reissueSequence`. Plan writes never drop or alter an unconsumed record. Older readers refuse the
 * field (closed record).
 */
export interface SettlementHandBack {
	readonly sourceSequence: number;
	readonly sourceDigest: Uint8Array;
	readonly sourceEpoch: number;
	readonly intent: number;
	readonly exactCanonicalOperationBytes: Uint8Array;
	readonly reissueSequence: number | null;
}

export interface SettlementPlan {
	readonly scope: DurableIssueScope;
	readonly revision: number;
	readonly fenceSequence: number | null;
	readonly entries: readonly SettlementPlanEntry[];
	readonly sourceContexts?: readonly SettlementSourceContext[];
	/** Sorted by (sourceSequence, intent); absent when empty. */
	readonly handBacks?: readonly SettlementHandBack[];
	/**
	 * The author's last-member frontier: the creator-signed settlement statement the author held at its
	 * last install as a member (verbatim signed bytes; Node opens and re-verifies them on every open).
	 * Written once, at the close that removes the author; never changed or cleared. Its digest uses the
	 * source-context domain. Older readers refuse the field (closed record).
	 */
	readonly memberFrontier?: SettlementSourceContext;
	/**
	 * Present (true) once a close of a still-authorized author took custody of a completed replacement
	 * entry's source (its displaced-plane context on a `rebase`/`transform` entry whose replacement was
	 * not committed in that close: the replacement may be lost too). Readers before that custody rule
	 * cannot authenticate such a source and refuse the field (closed record) at open, before any write.
	 * Written once; never changed or cleared.
	 */
	readonly completedSourceCustody?: true;
}

/** Byte ceiling of a plan's last-member frontier record (anchor, settlement record, Cut, commit QC). */
export const SETTLEMENT_MEMBER_FRONTIER_MAX_BYTES = 131_072;

export interface DurableIssueCommit {
	readonly authorSequence: number;
	readonly envelope: DurableSignedEnvelope;
	readonly issuedRecord: DurableIssuedRecord;
	readonly outboxEntry: DurableIssuanceOutboxEntry;
	readonly planEffect?:
		| Readonly<{ readonly kind: "fence" }>
		| Readonly<{ readonly kind: "replacement"; readonly sourceSequence: number }>
		| Readonly<{
				readonly fromIntent: number;
				readonly intentDigest: Uint8Array;
				readonly kind: "replacement";
				readonly sourceSequence: number;
				readonly throughIntent: number;
		  }>
		| Readonly<{ readonly intent: number; readonly kind: "hand-back"; readonly sourceSequence: number }>;
}

export interface DurableIssueSignContext {
	readonly planEffect?: NonNullable<DurableIssueCommit["planEffect"]>;
	/** Mechanical currency from the same bounded capture; not quote authority. */
	readonly expectedIssuanceImageDigest?: string;
	readonly expectedIssuanceControlBytes?: Uint8Array | null;
	/**
	 * A settlement-profile Writer's own new move: admit it only if the store could still hold one
	 * settlement replacement (issued + outbox rows, plan entry, dependency slack) for every own row
	 * of this move's epoch, this one included, plus the next settlement's fence pair and plan row.
	 * The creator closes the epoch without any of them it did not accept, and the Writer must then
	 * replace each one at its successor's install; a move that would leave no room for that is
	 * refused here, typed, instead of deadlocking the install. Settlement work (fence, replacement)
	 * never carries it.
	 */
	readonly settlementReplacementReserve?: Readonly<{ readonly maxDependencies: number }>;
}

export type DurableUnsignedVertexSignAdmission = (
	exactCanonicalUnsignedVertexBytes: Uint8Array,
	sign: () => Promise<Uint8Array>,
	/** Existing settlement effect, captured before crypto by the original issuer. */
	context?: DurableIssueSignContext
) => Promise<Uint8Array>;
export type DurableBuildAndSign = (
	authorSequence: number,
	nativeSignAdmission?: DurableUnsignedVertexSignAdmission
) => Promise<DurableIssueCommit>;
export type DurableTransactIssue = (
	scope: DurableIssueScope,
	buildAndSign: DurableBuildAndSign
) => Promise<DurableIssueCommit>;

export interface DurableLineage {
	readonly exhausted: boolean;
	readonly next: number;
}

export interface DurableIssuanceOutboxRecord {
	readonly commit: DurableIssueCommit;
	readonly publishState: DurableIssuancePublishState;
}

export interface DurableOutboxPageInput {
	readonly afterKey?: readonly [string, string, number] | null;
	readonly limit?: number;
	readonly scope?: DurableIssueScope;
}

export interface DurableOutboxPublicationTransitionInput {
	readonly authorSequence: number;
	readonly digest: Uint8Array;
	readonly scope: DurableIssueScope;
}

export interface DurableIssuanceStore {
	readonly transactIssue: DurableTransactIssue;
	compareAndMarkOutboxPublished(input: DurableOutboxPublicationTransitionInput): Promise<void>;
	readIssued(scope: DurableIssueScope, authorSequence: number): Promise<DurableIssueCommit | null>;
	readOutboxPage(input?: DurableOutboxPageInput): Promise<readonly DurableIssuanceOutboxRecord[]>;
	readLineage(scope: DurableIssueScope): Promise<DurableLineage>;
	readSettlementPlan(scope: DurableIssueScope): Promise<SettlementPlan | null>;
	transactWriteSettlementPlan(input: {
		readonly expectedRevision: number | null;
		readonly plan: SettlementPlan;
		readonly scope: DurableIssueScope;
	}): Promise<SettlementPlan>;
	close(): Promise<void>;
}

export interface DurableIssuanceError extends Error {
	readonly code: DurableIssuanceErrorCode;
	readonly retryClass?: DurableIssuanceRetryClass;
	readonly scope?: DurableIssueScope;
}

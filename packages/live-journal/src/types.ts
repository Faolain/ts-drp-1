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
} as const);

export type LiveJournalFailureKind = (typeof LIVE_JOURNAL_FAILURE_KINDS)[number];

export interface LiveJournalScope {
	readonly objectId: string;
	readonly epoch: 0;
	readonly anchorDigest: string;
}

export interface InstallLiveJournalGenesisInput {
	readonly objectId: string;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedAnchorSignature: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
}

export type AppendAcceptedVertexInput =
	| Readonly<{
			readonly scope: LiveJournalScope;
			readonly sourceKind: "received";
			readonly vertexDigest: string;
			readonly exactCanonicalPreimageBytes: Uint8Array;
			readonly detachedSignature: Uint8Array;
	  }>
	| Readonly<{
			readonly scope: LiveJournalScope;
			readonly sourceKind: "local-issued";
			readonly vertexDigest: string;
			readonly author: string;
			readonly authorSequence: number;
	  }>;

export type LiveJournalAcceptedRow =
	| Readonly<{
			readonly scope: LiveJournalScope;
			readonly journalSequence: number;
			readonly sourceKind: "received";
			readonly vertexDigest: string;
			readonly exactCanonicalPreimageBytes: Uint8Array;
			readonly detachedSignature: Uint8Array;
	  }>
	| Readonly<{
			readonly scope: LiveJournalScope;
			readonly journalSequence: number;
			readonly sourceKind: "local-issued";
			readonly vertexDigest: string;
			readonly author: string;
			readonly authorSequence: number;
	  }>;

type Failure = Readonly<{ readonly ok: false; readonly kind: LiveJournalFailureKind }>;

export type InstallLiveJournalGenesisResult =
	| Readonly<{
			readonly ok: true;
			readonly scope: LiveJournalScope;
			readonly parametersDigest: string;
			readonly idempotent: boolean;
	  }>
	| Failure;

export type AppendAcceptedVertexResult =
	| Readonly<{
			readonly ok: true;
			readonly scope: LiveJournalScope;
			readonly journalSequence: number;
			readonly vertexDigest: string;
			readonly sourceKind: "received" | "local-issued";
			readonly idempotent: boolean;
	  }>
	| Failure;

export interface LiveJournalReadinessInput {
	readonly scope: LiveJournalScope;
}

export interface LiveJournalSnapshotToken {
	readonly kind: "v3-live-journal-snapshot-token-1";
	readonly scope: LiveJournalScope;
	readonly highWatermark: number;
	readonly genesisDigest: string;
	readonly parametersDigest: string;
	readonly orderedRowDigest: string;
	readonly snapshotDigest: string;
}

export type LiveJournalReadinessResult =
	| Readonly<{
			readonly ok: true;
			readonly ready: true;
			readonly scope: LiveJournalScope;
			readonly snapshot: LiveJournalSnapshotToken;
			readonly rowCount: number;
	  }>
	| Readonly<{ readonly ok: true; readonly ready: false; readonly kind: "not-installed" }>
	| Failure;

export interface LiveJournalPageInput {
	readonly scope: LiveJournalScope;
	readonly snapshot: LiveJournalSnapshotToken;
	readonly afterSequence?: number | null;
	readonly limit?: number;
}

export type LiveJournalPageResult =
	| Readonly<{
			readonly ok: true;
			readonly scope: LiveJournalScope;
			readonly snapshot: LiveJournalSnapshotToken;
			readonly rows: readonly LiveJournalAcceptedRow[];
			readonly nextSequence: number | null;
	  }>
	| Failure;

export interface DurableLiveJournalStore {
	installGenesis(input: InstallLiveJournalGenesisInput): Promise<InstallLiveJournalGenesisResult>;
	appendAccepted(input: AppendAcceptedVertexInput): Promise<AppendAcceptedVertexResult>;
	readiness(input: LiveJournalReadinessInput): Promise<LiveJournalReadinessResult>;
	readPage(input: LiveJournalPageInput): Promise<LiveJournalPageResult>;
	close(): Promise<void>;
}

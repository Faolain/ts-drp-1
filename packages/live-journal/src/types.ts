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
	"retirement-fenced",
	"retirement-stale",
	"retirement-released",
	"retirement-transition",
	"retirement-exhausted",
] as const);

export const LIVE_JOURNAL_DOMAINS = Object.freeze({
	order: "ts-drp/live-journal-order/v1",
	row: "ts-drp/live-journal-row/v1",
	snapshot: "ts-drp/live-journal-snapshot/v1",
} as const);

export type LiveJournalFailureKind = (typeof LIVE_JOURNAL_FAILURE_KINDS)[number];

export interface LiveJournalScope {
	readonly objectId: string;
	readonly epoch: number;
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
			/** Exact bounded native source checkpoint; mechanical currency, not authorization. */
			readonly expectedNativeImage?: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }>;
	  }>
	| Readonly<{
			readonly scope: LiveJournalScope;
			readonly sourceKind: "local-issued";
			readonly vertexDigest: string;
			readonly author: string;
			readonly authorSequence: number;
			/** Exact bounded native source checkpoint; mechanical currency, not authorization. */
			readonly expectedNativeImage?: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }>;
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
			/** Original writer's exact verified postimage, present only for a source-bound append. */
			readonly nativeImage?: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }>;
	  }>
	| Failure;

export interface LiveJournalReadinessInput {
	readonly scope: LiveJournalScope;
}

export const LIVE_JOURNAL_ANCHOR_READ_MAX_BYTES = 8192 as const;

export interface LiveJournalAnchorReadInput {
	readonly scope: LiveJournalScope;
	readonly maxBytes: number;
}

export type LiveJournalAnchorReadFailureKind = LiveJournalFailureKind | "read-budget-exceeded";

export type LiveJournalAnchorReadResult =
	| Readonly<{ readonly ok: true; readonly kind: "missing" }>
	| Readonly<{
			readonly ok: true;
			readonly kind: "present";
			readonly scope: LiveJournalScope;
			readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	  }>
	| Readonly<{ readonly ok: false; readonly kind: LiveJournalAnchorReadFailureKind }>;

export interface LiveJournalSignedAnchorReadInput {
	readonly scope: LiveJournalScope;
	readonly maxBytes: number;
}

export type LiveJournalSignedAnchorReadResult =
	| Readonly<{ readonly ok: true; readonly kind: "missing" }>
	| Readonly<{
			readonly ok: true;
			readonly kind: "present";
			readonly scope: LiveJournalScope;
			readonly parametersDigest: string;
			readonly envelope: InstallLiveJournalGenesisInput;
	  }>
	| Readonly<{ readonly ok: false; readonly kind: LiveJournalAnchorReadFailureKind }>;

export interface LiveJournalHistoricalAnchorImportInput {
	readonly envelope: InstallLiveJournalGenesisInput;
	readonly maxBytes: number;
}

export type LiveJournalHistoricalAnchorImportResult =
	| Extract<InstallLiveJournalGenesisResult, { readonly ok: true }>
	| Readonly<{
			readonly ok: false;
			readonly kind: LiveJournalAnchorReadFailureKind | "import-populated";
	  }>;

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
	/** Noncreating, bounded point read of opaque evidence; the caller authenticates the Cut. */
	readClosedMembership?(input: LiveJournalClosedMembershipReadInput): Promise<LiveJournalClosedMembershipReadResult>;
	/** Opaque exact close-owner evidence; native CAS/custody, never protocol authorization. */
	recordClosedMembership?(
		input: Readonly<{
			scope: LiveJournalScope;
			exactCanonicalMembershipBytes: Uint8Array;
			expectedNativeImage: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }>;
		}>
	): Promise<
		LiveJournalRetirementResult<
			Readonly<{
				idempotent: boolean;
				imageDigest: string;
				controlBytes: Uint8Array | null;
			}>
		>
	>;
	/** Noncreating point observation through original native RO; never custody or eligibility. */
	readRetirementImage?: LiveJournalRetirementImageReader;
	/** Mechanical native participant only; the protocol coordinator must supply genuine eligibility. */
	acquireRetirementControl?(
		input: Readonly<{ objectId: string }>
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementControlRead>>;
	installGenesis(input: InstallLiveJournalGenesisInput): Promise<InstallLiveJournalGenesisResult>;
	installEpochAnchor(input: InstallLiveJournalGenesisInput): Promise<InstallLiveJournalGenesisResult>;
	appendAccepted(input: AppendAcceptedVertexInput): Promise<AppendAcceptedVertexResult>;
	readiness(input: LiveJournalReadinessInput): Promise<LiveJournalReadinessResult>;
	readAnchorPreimage(input: LiveJournalAnchorReadInput): Promise<LiveJournalAnchorReadResult>;
	readSignedAnchorEnvelope(input: LiveJournalSignedAnchorReadInput): Promise<LiveJournalSignedAnchorReadResult>;
	importHistoricalAnchor(
		input: LiveJournalHistoricalAnchorImportInput
	): Promise<LiveJournalHistoricalAnchorImportResult>;
	readPage(input: LiveJournalPageInput): Promise<LiveJournalPageResult>;
	close(): Promise<void>;
}

export interface LiveJournalClosedMembershipReadInput {
	readonly scope: LiveJournalScope;
	readonly maxBytes: number;
}

export type LiveJournalClosedMembershipReadResult =
	| Readonly<{ readonly ok: true; readonly kind: "missing" }>
	| Readonly<{ readonly ok: true; readonly kind: "present"; readonly scope: LiveJournalScope;
		readonly exactCanonicalMembershipBytes: Uint8Array }>
	| Readonly<{ readonly ok: false; readonly kind: LiveJournalAnchorReadFailureKind }>;

/** One bounded object checkpoint. No field grants application or deletion authority. */
export interface LiveJournalRetirementPreparation {
	readonly decisionDigest: string;
	readonly sourceProofDigest: string;
	readonly throughEpoch: number;
	readonly protectedScopes: readonly LiveJournalScope[];
}
export interface LiveJournalRetirementControl {
	readonly kind: "v3-live-journal-retirement-control-1" | "v3-live-journal-retirement-control-2";
	readonly objectId: string;
	readonly incarnation: string;
	readonly revision: number;
	readonly sequence: number;
	readonly active: null | Readonly<{ sequence: number; preparation: LiveJournalRetirementPreparation }>;
	readonly completed: null | LiveJournalRetirementPreparation;
	/** Version2 only. One bounded native checkpoint, not a second retirement owner. */
	readonly drain?: LiveJournalRetirementDrainState | null;
}

/** Mechanical exact native-prefix description; only the original caller authenticates eligibility. */
export interface LiveJournalRetirementLocalPrefix {
	readonly scope: LiveJournalScope;
	readonly highWatermark: number;
	readonly rows: readonly Readonly<{
		journalSequence: number;
		vertexDigest: string;
		author: string;
		authorSequence: number;
		nativeFrameDigest: string;
		/** Received detail only: complete original adapter-native accepted row frame.
		 * Restoration evidence, never protocol admission or deletion authority. */
		exactCanonicalNativeFrameBytes?: Uint8Array;
	}>[];
}
export interface LiveJournalRetirementDrainPlan {
	/** Exact completed pre-drain control. Any prior drain must already be cleared. */
	readonly baseControl: LiveJournalRetirementControl;
	readonly sourceImage: LiveJournalRetirementImage;
	readonly prefixes: readonly LiveJournalRetirementLocalPrefix[];
	/** Exact empty native headers selected by the fresh authenticated owner, never age alone. */
	readonly retiredEmptyHeaders?: readonly Readonly<{ scope: LiveJournalScope; exactCanonicalNativeFrameBytes: Uint8Array }>[];
	/** Complete authenticated header-consumer union; distinct from detail-floor holes. */
	readonly protectedHeaderScopes?: readonly LiveJournalScope[];
}
export interface LiveJournalRetirementDrainState {
	readonly plan: LiveJournalRetirementDrainPlan;
	readonly cursor: number;
	readonly batches: number;
	readonly residualImageDigest: string;
}
/** Reconstructed original native metadata/detail, distinct from the actual residual native image.
 * This is not authentication; the original consumer must reauthenticate every descriptor. */
export interface LiveJournalRetirementDrainSource {
	readonly control: LiveJournalRetirementControl;
	readonly image: LiveJournalRetirementImage;
	readonly canonicalRows: readonly Uint8Array[];
}
export type LiveJournalRetirementResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; kind: LiveJournalFailureKind }>;
export interface LiveJournalRetirementImage {
	readonly imageDigest: string;
	readonly scopeCount: number;
	readonly rowCount: number;
	readonly byteCharge: number;
}
/** Detached data from one bounded native capture; the original caller owns authentication and currency. */
export interface LiveJournalRetirementImageObservation {
	readonly control: LiveJournalRetirementControl | null;
	/** Complete detached actual native progress and optional immutable-plan carriers. */
	readonly exactCanonicalControlCarriers: readonly Uint8Array[];
	readonly image: LiveJournalRetirementImage;
	readonly canonicalRows: readonly Uint8Array[];
	readonly drainSource?: LiveJournalRetirementDrainSource;
}
/** Same original native readonly basis only. This is currency, not a data
 * observation, authentication, retirement grant, or reusable proof credit. */
export interface LiveJournalRetirementImageCurrentProbe {
	checkCurrent(this: LiveJournalRetirementImageCurrentProbe): Promise<LiveJournalRetirementResult<null>>;
}
export interface LiveJournalRetirementImageReader {
	(input: Readonly<{objectId: string}>): Promise<LiveJournalRetirementResult<LiveJournalRetirementImageObservation>>;
	/** Optional genuine owner port on the ORIGINAL frozen read function. It
	 * accepts only its exact returned observation under the current held book.
	 * Undefined is unsupported/unavailable optimization, never current truth. */
	captureCurrentProbe?(this: LiveJournalRetirementImageReader, observation: LiveJournalRetirementImageObservation):
		LiveJournalRetirementImageCurrentProbe | undefined;
}
export interface LiveJournalRetirementControlRead {
	readonly control: LiveJournalRetirementControl;
	readonly exactCanonicalControlCarriers: readonly Uint8Array[];
	readonly image: LiveJournalRetirementImage;
	readonly drainSource?: LiveJournalRetirementDrainSource;
	/** Exact current native control plus image commitment, not transferable authority. */
	readonly domainDigest: string;
	/** Detached bounded [native table, primary key, exact row] frames; not authentication. */
	readExactCanonicalRows(): readonly Uint8Array[];
	prepareFence(
		input: LiveJournalRetirementPreparation
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>>;
	abortPrepared(): Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>>;
	/** Installs ONLY the journal-local permanent frontier; never all-store commit or deletion. */
	commitPrepared(): Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>>;
	/** Requires the exact already completed local preparation and original point image. */
	beginDrain(input: LiveJournalRetirementDrainPlan): Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>>;
	/** Deletes only the next fixed-size prefix batch, atomically with the durable cursor. */
	drainBatch(): Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>>;
	/** Metadata-only local acknowledgement after a complete drain. Preserves the
	 * exact data image and permanent frontier; the protocol owner must first join
	 * all cross-store recovery/readback obligations that need the original plan. */
	acknowledgeCompletedDrain(): Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>>;
	release(): Promise<void>;
}

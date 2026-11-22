export const PHASE3_EXIT_SCHEDULE_FAMILIES = Object.freeze([
	"delivery",
	"accepted-duplicate",
	"pending-duplicate",
	"pending-crash",
	"post-append-crash",
] as const);

export type Phase3ExitScheduleFamily = (typeof PHASE3_EXIT_SCHEDULE_FAMILIES)[number];

export type Phase3ExitAction =
	| readonly ["deliver", number, "normal" | "commit-then-throw"]
	| readonly ["redeliver", number]
	| readonly ["crash-restart"]
	| readonly ["query-commitment"];

export type Phase3ExitSchedule = readonly [
	dependencies: readonly (readonly number[])[],
	family: Phase3ExitScheduleFamily,
	actions: readonly Phase3ExitAction[],
];

export interface Phase3ExitModelLimits {
	readonly anchorAcceptedByteCharge: number;
	readonly maxAcceptedBytes: number;
	readonly maxAcceptedVertices: number;
	readonly maxPendingBytes: number;
	readonly maxPendingEntries: number;
}

export interface Phase3ExitModelVertex {
	readonly acceptedByteCharge: number;
	readonly authorized: boolean;
	readonly canonicalPreimageByteCharge: number;
	readonly dependencies: readonly number[];
	readonly digest: string;
	readonly label: number;
	readonly malformed: boolean;
	readonly pendingWireByteCharge: number;
	readonly scopeCurrent: boolean;
}

export interface Phase3ExitModelInput {
	readonly actions: readonly Phase3ExitAction[];
	readonly bootstrapLabel: number;
	readonly limits: Phase3ExitModelLimits;
	readonly vertices: ReadonlyMap<number, Phase3ExitModelVertex>;
}

export type Phase3ExitModelFault =
	| "charge-pending-from-canonical"
	| "count-pending-as-accepted"
	| "drain-in-insertion-order"
	| "omit-post-restart-redelivery"
	| "retain-pending-across-restart"
	| "skip-pending-drain"
	| "subtract-no-pending-bytes"
	| "wave-capacity-check-once";

export type Phase3ExitOutcomeProjection = readonly [
	admittedAscending: readonly number[],
	journalAppendOrder: readonly number[],
	pendingAscending: readonly number[],
	callbackEmissionOrder: readonly number[],
	recoveredAscending: readonly number[],
	tipsAscending: readonly number[],
];

export interface Phase3ExitModelResult {
	readonly acceptedByteCharge: number;
	readonly acceptedVertexCount: number;
	readonly droppedAscending: readonly number[];
	readonly pendingByteCharge: number;
	readonly projection: Phase3ExitOutcomeProjection;
}

export const PHASE3_EXIT_REAL_SCENARIOS = Object.freeze([
	"ready-forward",
	"complete-reverse",
	"sibling-permutation",
	"duplicate-before-release",
	"duplicate-after-acceptance",
	"volatile-pending-crash",
	"post-journal-append-crash",
	"post-issuance-commit-crash",
	"local-issue-release",
	"accepted-capacity",
	"pending-entry-capacity",
	"wrong-scope-author-signature",
	"multi-member-commitment",
] as const);

export type Phase3ExitRealScenario = (typeof PHASE3_EXIT_REAL_SCENARIOS)[number];

export type Phase3ExitObservedAction =
	| readonly ["crash-restart"]
	| readonly ["deliver", digest: string, mode: "normal" | "commit-then-throw"]
	| readonly ["issue-local", digest: string]
	| readonly ["query-commitment"]
	| readonly ["redeliver", digest: string];

export interface Phase3ExitAcceptedVertexEvidence {
	readonly authenticatedCanonicalPreimageByteLength: number;
	readonly detachedSignature: Uint8Array;
	readonly digest: string;
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly source: "local-issued-journal" | "received-journal";
}

export interface Phase3ExitIssuedVertexEvidence {
	readonly author: string;
	readonly authorSequence: number;
	readonly detachedSignature: Uint8Array;
	readonly digest: string;
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly journalDigest: string;
	readonly outboxDigest: string;
	readonly publishState: "pending" | "published";
}

export interface Phase3ExitOutboxVertexEvidence {
	readonly author: string;
	readonly authorSequence: number;
	readonly detachedSignature: Uint8Array;
	readonly digest: string;
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly publishState: "pending" | "published";
}

export type Phase3ExitLocalEffectKind =
	| "issuance-committed"
	| "outbox-observed"
	| "journal-appended"
	| "accepted-observed"
	| "callback-observed";

export interface Phase3ExitLocalEffectEvidence {
	readonly digest: string;
	readonly kind: Phase3ExitLocalEffectKind;
	readonly sequence: number;
}

export interface Phase3ExitLocalIssueEvidence {
	readonly actualDigest: string;
	readonly author: string;
	readonly authorSequence: number;
	readonly effectEvents: readonly Phase3ExitLocalEffectEvidence[];
	readonly logicalTime: number;
	readonly operation: Readonly<{ readonly action: "add"; readonly value: number }>;
	readonly preflightSignerDigests: readonly string[];
	readonly releasedChildDigest: string;
}

export interface Phase3ExitCapacityRejectionEvidence {
	readonly acceptedByteChargeBefore: number;
	readonly acceptedVertexCountBefore: number;
	readonly candidateByteCharge: number;
	readonly detachedSignature: Uint8Array;
	readonly digest: string;
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly kind: "accepted-count";
}

export interface Phase3ExitIssuanceCrashEvidence {
	readonly postRecoveryJournalDigests: readonly string[];
	readonly preCrashCallbackDigests: readonly string[];
	readonly preCrashJournalDigests: readonly string[];
	readonly preCrashOutboxVertices: readonly Phase3ExitOutboxVertexEvidence[];
}

export type Phase3ExitRejectionClass =
	| "malformed-signature"
	| "unauthorized-author"
	| "wrong-anchor"
	| "wrong-epoch"
	| "wrong-object"
	| "wrong-protocol";

export interface Phase3ExitRejectedVertexEvidence {
	readonly classification: Phase3ExitRejectionClass;
	readonly detachedSignature: Uint8Array;
	readonly digest: string;
	readonly exactCanonicalPreimageBytes: Uint8Array;
}

export interface Phase3ExitRealObservation {
	readonly acceptedVertices: readonly Phase3ExitAcceptedVertexEvidence[];
	readonly actionTrace: readonly Phase3ExitObservedAction[];
	readonly anchorDigest: string;
	readonly anchorSignerPublicKey: Uint8Array;
	readonly attemptedDigests: readonly string[];
	readonly authorizedAuthors: readonly string[];
	readonly callbackDigests: readonly string[];
	readonly capacityRejections: readonly Phase3ExitCapacityRejectionEvidence[];
	readonly droppedDigests: readonly string[];
	readonly detachedAnchorSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly issuanceCrash: Phase3ExitIssuanceCrashEvidence | undefined;
	readonly issuedVertices: readonly Phase3ExitIssuedVertexEvidence[];
	readonly journalDigests: readonly string[];
	readonly localIssue: Phase3ExitLocalIssueEvidence | undefined;
	readonly replicaJournalDigests: readonly (readonly string[])[];
	readonly recoveredDigests: readonly string[];
	readonly redeliveredDigests: readonly string[];
	readonly rejections: readonly Phase3ExitRejectedVertexEvidence[];
	readonly scenario: Phase3ExitRealScenario;
}

export interface Phase3ExitDriverResult {
	readonly observations: readonly Phase3ExitRealObservation[];
	readonly parameters: Readonly<{
		readonly maxDependencies: 16;
		readonly maxEpochBytes: 8_388_608;
		readonly maxEpochVertices: 8192;
		readonly maxPendingBytes: 16_777_216;
		readonly maxPendingEntries: 4096;
	}>;
}

export interface Phase3ExitDriverModule {
	runPhase3ExitDriver(): Promise<Phase3ExitDriverResult>;
}

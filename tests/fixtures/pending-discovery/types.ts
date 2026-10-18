import type { AheDurableStore, PresentHead } from "../../../packages/storage/dist/src/index.js";
import type {
	SnapshotQuarantineScopeKey,
	SnapshotRecoveryStore,
	SnapshotVerificationReceipt,
} from "../../../packages/storage/dist/src/snapshot-transfer.js";
import type { NativeOwners as SetupOwners } from "../cold-discovery/types.js";
export type NativeOwners = SetupOwners;
export type CandidateFault = (bootstrap: RestartBootstrap, mode: RecoveryCase) => Promise<void>;
export interface RecoveryOwners {
	ahe: AheDurableStore;
	snapshot: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	close(): Promise<void>;
}
export interface RoomHead {
	currentAnchorDigest: string;
	epoch: number;
	objectId: string;
}
export interface RestartBootstrap {
	identity: string;
	catalogDigest: string;
	detachedSignature: string;
	exactCanonicalAnchorPreimageBytes: string;
	exactCanonicalParametersCarrierBytes: string;
	pinnedGenesisAnchorDigest: string;
	expectedPreviousRoomHead: RoomHead;
	expectedNextRoomHead: RoomHead;
}
export interface SetupReport {
	bootstrap: RestartBootstrap;
	oracle: {
		expectedState: number;
		states: number[];
		closeEpochs: number[];
		lookupScope: SnapshotQuarantineScopeKey;
		competingScope: SnapshotQuarantineScopeKey;
		pendingGenerationId: string;
		proposedHead: unknown;
		pendingHead: unknown;
		intendedPublicationHead: PresentHead | null;
		intendedUnrelatedHead: PresentHead | null;
		preparedCandidates: {
			generationId: string;
			closureDigest: string;
			role: "intended" | "discarded" | "incomplete" | "unmatched-base";
			state: string;
		}[];
		snapshotChunks: { count: number; indices: number[]; allPreloaded: true };
	};
}
export const ownerCases = [
	"verified",
	"open",
	"missing-metadata",
	"poisoned",
	"lookup-rejected",
	"narrow-store",
	"same-triple-conflict",
	"missing-chunk",
	"corrupt-chunk",
	"delete-after-lookup",
	"replace-after-lookup",
	"identical-replacement",
	"expired-temporary",
	"expired-recovery",
	"legacy-open",
	"legacy-verified",
	"expired-temporary-legacy-elsewhere",
	"open-legacy-elsewhere",
	"expiry-after-acquisition",
] as const;
export type OwnerCase = (typeof ownerCases)[number];
export const recoveryCases = [
	...ownerCases,
	"retained-key",
	"retained-undefined",
	"missing-key",
	"extra-key",
	"accessor",
	"symbol",
	"non-plain",
	"invalid-previous",
	"invalid-next",
	"invalid-object",
	"wrong-previous",
	"wrong-next",
	"wrong-profile",
	"nonconsecutive",
	"mutate-heads",
	"storage-failed",
	"lineage-failed",
	"unexpected-read",
	"catalog-rejected",
	"parameters-rejected",
	"retry",
	"retry-active",
	"mixed-unavailable",
	"divergent-mixed-unavailable",
	"fork",
	"fork-active",
	"incomplete",
	"unmatched",
	"duplicate-id",
	"stale-base",
	"lost-cas",
	"failed-cas",
	"reread-failed",
	"reread-unrelated",
	"bad-trust",
	"bad-cut",
	"bad-qc",
	"storage-corrupt-trust",
	"storage-corrupt-cut",
	"storage-corrupt-qc",
	"bad-pre-transition",
	"bad-projection",
	"bad-acl",
	"bad-settlement",
] as const;
export type RecoveryCase = (typeof recoveryCases)[number];
export interface Trace {
	candidate: string | null;
	site: string;
	ok?: boolean;
	reason?: string;
	scope?: SnapshotQuarantineScopeKey;
	state?: string;
	retention?: string;
	application?: number;
	stateDigest?: string;
	payloadDigest?: string;
	payloadBytes?: number;
	kind?: string;
	code?: string;
}
export interface Effects {
	traces: Trace[];
	lookups: number;
	nativeLookups: number;
	accesses: number;
	acquisitions: number;
	nativeAcquisitions: number;
	reads: number;
	completes: number;
	swaps: string[];
	rereads: number;
	mutations: number;
}
export interface RecoveryReport {
	mode: RecoveryCase;
	classification: "REACHED" | "MASKED_BY_ENVELOPE_REJECTION" | "OBSOLETE_DIAGNOSTIC_KEY_REFUSAL";
	result: Readonly<Record<string, unknown>>;
	effects: Effects;
	durableBefore: PresentHead | null;
	durableAfter: PresentHead | null;
	executedAssertions?: {
		id: number;
		method: string;
		status: "passed" | "failed";
		scope: "envelope-causality" | "recovery";
		message?: string;
	}[];
	downstreamAssertions?: "MASKED_BY_ENVELOPE_REJECTION" | "EXECUTED_AS_LISTED";
	allAvailable?: RecoveryReport;
	expectedObservations?: unknown;
}
export interface NativeMutations {
	before(mode: OwnerCase, bootstrap: RestartBootstrap): Promise<number>;
	after(mode: OwnerCase, scope: SnapshotQuarantineScopeKey): Promise<number>;
}
export interface ProbeInput {
	bootstrap: RestartBootstrap;
	scope: SnapshotQuarantineScopeKey;
	competingScope: SnapshotQuarantineScopeKey;
}
export interface ProbeReport {
	mode: OwnerCase;
	effects: Effects;
	observation?: { kind: string; state?: string; retention?: string };
	competing: boolean;
	acquired: boolean;
	verified: boolean;
	bytes: number;
	application?: number;
	stateDigest?: string;
	payloadDigest?: string;
	failure?: string;
	failureCode?: string;
	availability?: { effects: Effects; firstRejected: boolean; secondAvailable: boolean };
}

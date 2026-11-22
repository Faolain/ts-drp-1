import type { AuthEvent } from "./auth-observer.js";
import type { DurableIssuanceStore } from "../../../packages/issuance-store/dist/src/index.js";
import type { DurableLiveJournalStore } from "../../../packages/live-journal/dist/src/index.js";
import type { AheDurableStore } from "../../../packages/storage/dist/src/index.js";
import type {
	SnapshotQuarantineScopeKey,
	SnapshotRecoveryStore,
	SnapshotVerificationReceipt,
} from "../../../packages/storage/dist/src/snapshot-transfer.js";

export interface RestartBootstrap {
	identity: string;
	author: string;
	catalogDigest: string;
	detachedSignature: string;
	exactCanonicalAnchorPreimageBytes: string;
	exactCanonicalParametersCarrierBytes: string;
	exactCanonicalPinnedGenesisBootstrapOperationBytes: string;
	pinnedGenesisAnchorDigest: string;
	expectedRoomHead: { currentAnchorDigest: string; epoch: number; objectId: string };
}
export interface NativeOwners {
	ahe: AheDurableStore;
	issuance: DurableIssuanceStore;
	journal: DurableLiveJournalStore;
	snapshot: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	close(): Promise<void>;
}
export interface SetupReport {
	bootstrap: RestartBootstrap;
	oracle: { expectedState: number; lookupScope: SnapshotQuarantineScopeKey; closeEpochs: number[]; states: number[] };
}
export const cases = [
	"success",
	"open",
	"competing-scope",
	"old-key",
	"missing-floor",
	"missing-floor-old-key",
	"invalid-floor",
	"invalid-object",
	"wrong-floor",
	"mutate-floor",
	"bad-trust",
	"bad-cut",
	"bad-qc",
	"storage-corrupt-trust",
	"storage-corrupt-cut",
	"storage-corrupt-qc",
	"rehash-noop",
	"narrow-store",
	"missing-metadata",
	"poisoned",
	"lookup-rejected",
	"same-triple-conflict",
	"missing-chunk",
	"corrupt-chunk",
	"delete-after-lookup",
	"replace-after-lookup",
	"identical-replacement",
	"legacy",
] as const;
export type RecoveryCase = (typeof cases)[number];
export interface AuthMutationReceipt {
	mode: string;
	kind: "storage-corrupt" | "digest-consistent";
	faultApplications: number;
	oldRef: { digest: string; byteLength: number };
	newRef: { digest: string; byteLength: number };
	changedClosures: number;
	changedBases: number;
	promotionChanges: number;
	originalBlobCount: number;
}
export interface Effects {
	lookupScopes: SnapshotQuarantineScopeKey[];
	lookupStates: string[];
	lookupRetentions: string[];
	acquisitions: number;
	reads: number;
	completes: number;
	recoverObjects: string[];
	recoverResults: ({ ok: true; kind: "active" | "empty" } | { ok: false; reason: string })[];
	authEvents: AuthEvent[];
	authMutation?: AuthMutationReceipt;
	signs: number;
	subscriptions: number;
	publications: number;
	mutations: number;
	events: string[];
}
export interface RecoveryReport {
	mode: RecoveryCase;
	result: { ok: boolean; kind?: unknown; detail?: unknown };
	effects: Effects;
	classification: "REACHED" | "MASKED_BY_ENVELOPE_REJECTION";
	head?: { currentAnchorDigest: string; epoch: number; objectId: string };
	state?: unknown;
	issued?: { ok: boolean; kind?: unknown };
	published?: { ok: boolean; kind?: unknown };
}
export interface NativeMutations {
	readonly authMutation?: AuthMutationReceipt;
	before(mode: RecoveryCase, bootstrap: RestartBootstrap): Promise<number>;
	after(mode: RecoveryCase, scope: SnapshotQuarantineScopeKey): Promise<number>;
}

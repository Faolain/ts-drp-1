// Uncompensated direct API gate; excluded from the fixture wiring project.
import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import type {
	AheBoundedRecoveryRoleStore,
	GenerationRecord,
	GenerationRef,
	PresentHead,
	StorageObjectId,
	StorageRejectionReason,
} from "@ts-drp/storage";
import type {
	SnapshotChunkDescriptor,
	SnapshotQuarantineFailureCode,
	SnapshotQuarantineScopeKey,
	SnapshotRecoveryStore,
	SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";

import {
	type CreatorProtectedRecoveryRoleCause,
	type CreatorProtectedRecoveryRoleDebt,
	type CreatorProtectedRecoveryRoleFailureKind,
	type CreatorProtectedRecoveryRoleIdentity,
	type CreatorProtectedRecoveryRoleInput,
	type CreatorProtectedRecoveryRoleObservation,
	type CreatorProtectedRecoveryRoleResult,
	type CreatorProtectedRecoveryRoleSummary,
	type CreatorRollbackFloorReader,
	observeCreatorProtectedRecoveryRoles,
	resolveCreatorProtectedRecoveryRoleObservation,
} from "../../../packages/node/src/internal/creator-closed-rollback-data.js";
import {
	captureCreatorRoomHeadState,
	type CreatorExpectedRoomHead,
} from "../../../packages/node/src/internal/creator-room-head.js";
import { inspectCreatorAdoptionCandidateLineage } from "../../../packages/node/src/internal/creator-transition-advance.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type ExpectedInput = {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalPinnedGenesisTrustStateRecordBytes: Uint8Array;
	readonly roomHeadAuthority: CreatorRollbackFloorReader;
	readonly catalog: TrustedBlueprintCatalog;
	readonly store: AheBoundedRecoveryRoleStore;
	readonly snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	readonly signal?: AbortSignal;
};
type Kinds =
	| "malformed-input"
	| "floor-unavailable"
	| "floor-invalid"
	| "floor-stale"
	| "ahe-empty"
	| "ahe-rejected"
	| "ahe-stale"
	| "chain-invalid"
	| "role-missing"
	| "role-ambiguous"
	| "pending-policy-unavailable"
	| "inherited-scope-unclassified"
	| "snapshot-unavailable"
	| "snapshot-not-ready"
	| "snapshot-invalid"
	| "blueprint-invalid"
	| "proof-budget-exceeded"
	| "aborted"
	| "release-failed"
	| "internal-invariant";
type Debt = Readonly<{
	owner: "floor" | "ahe" | "snapshot";
	role: "current" | "pending-adoption" | "unclassified";
	objectId: string;
	generationId?: string;
	snapshotScope?: SnapshotQuarantineScopeKey;
}>;
type Cause =
	| Readonly<{ owner: "ahe"; reason: StorageRejectionReason }>
	| Readonly<{ owner: "snapshot"; reason: SnapshotQuarantineFailureCode }>
	| Readonly<{ owner: "floor"; reason: "conflict" | "unavailable" }>
	| Readonly<{ owner: "role-policy"; reason: "RETIREMENT_ONLY_ADVANCE_UNAVAILABLE" }>;
type Identity = Readonly<{
	roomHead: CreatorExpectedRoomHead;
	profileId: string;
	generation: Readonly<GenerationRecord & { derivedHead: PresentHead }>;
	controls: readonly Readonly<{
		kind: "projection" | "trust" | "cut" | "commit-qc" | "retirement" | "aggregate" | "settlement" | "closed-acl";
		ref: GenerationRef;
	}>[];
	snapshot: null | Readonly<{
		scope: SnapshotQuarantineScopeKey;
		manifestByteLength: number;
		payloadDigest: string;
		stateDigest: string;
		closedAclDigest: string;
		successorAclDigest: string;
		totalBytes: number;
		chunks: readonly SnapshotChunkDescriptor[];
	}>;
}>;
type Summary = Readonly<{
	floor: Readonly<{
		stable: CreatorExpectedRoomHead;
		pending: null | Readonly<{ previous: CreatorExpectedRoomHead; next: CreatorExpectedRoomHead }>;
	}>;
	head: PresentHead;
	current: Identity;
	pending: null | Readonly<{ role: Identity; publication: "before-publication" | "already-published" }>;
	supportGenerations: readonly GenerationRecord[];
	heldGenerations: readonly GenerationRecord[];
	currency: "point-observed-no-incarnation";
}>;
type Result =
	| Readonly<{ ok: true; observation: CreatorProtectedRecoveryRoleObservation }>
	| Readonly<{ ok: false; kind: Kinds; debt: Debt; cause?: Cause }>;
export const exactInput: Equal<CreatorProtectedRecoveryRoleInput, ExpectedInput> = true;
export const closedKinds: Equal<CreatorProtectedRecoveryRoleFailureKind, Kinds> = true;
export const exactDebt: Equal<CreatorProtectedRecoveryRoleDebt, Debt> = true;
export const exactCause: Equal<CreatorProtectedRecoveryRoleCause, Cause> = true;
export const exactIdentity: Equal<CreatorProtectedRecoveryRoleIdentity, Identity> = true;
export const exactSummary: Equal<CreatorProtectedRecoveryRoleSummary, Summary> = true;
export const exactResult: Equal<CreatorProtectedRecoveryRoleResult, Result> = true;
export const fieldless: Equal<CreatorProtectedRecoveryRoleObservation, Readonly<Record<never, never>>> = true;
export const observerSignature: Equal<
	typeof observeCreatorProtectedRecoveryRoles,
	(input: CreatorProtectedRecoveryRoleInput) => Promise<CreatorProtectedRecoveryRoleResult>
> = true;
export const resolverSignature: Equal<
	typeof resolveCreatorProtectedRecoveryRoleObservation,
	(value: unknown) => CreatorProtectedRecoveryRoleSummary | undefined
> = true;
export const capturedStateSignature: Equal<
	typeof captureCreatorRoomHeadState,
	(
		value: unknown,
		objectId: string,
		pin: string
	) =>
		| Readonly<{ ok: true; state: Summary["floor"] }>
		| Readonly<{ ok: false; kind: "floor-unavailable" | "floor-invalid"; reason?: "conflict" | "unavailable" }>
> = true;
export const lineageSignature: Equal<
	typeof inspectCreatorAdoptionCandidateLineage,
	(input: { objectId: StorageObjectId; lineage: readonly GenerationRecord[]; candidate: GenerationRecord }) =>
		| Readonly<{
				currentGeneration: GenerationRecord;
				proposedGeneration: GenerationRecord;
				candidateGeneration: GenerationRecord;
				currentHead: PresentHead;
				proposedHead: PresentHead;
				candidateHead: PresentHead;
		  }>
		| undefined
> = true;
/**
 *
 * @param input
 */
export function required(input: CreatorProtectedRecoveryRoleInput): Promise<CreatorProtectedRecoveryRoleResult> {
	return observeCreatorProtectedRecoveryRoles(input);
}
export function resolution(token: unknown): CreatorProtectedRecoveryRoleSummary | undefined {
	return resolveCreatorProtectedRecoveryRoleObservation(token);
}
export function hostCapture(
	value: unknown,
	objectId: string,
	pin: string
): ReturnType<typeof captureCreatorRoomHeadState> {
	return captureCreatorRoomHeadState(value, objectId, pin);
}
export function candidateCapture(
	input: Parameters<typeof inspectCreatorAdoptionCandidateLineage>[0]
): ReturnType<typeof inspectCreatorAdoptionCandidateLineage> {
	return inspectCreatorAdoptionCandidateLineage(input);
}
export function forbidden(input: CreatorProtectedRecoveryRoleInput): void {
	// @ts-expect-error No journal input.
	void input.liveJournalStore;
	// @ts-expect-error No caller head.
	void input.expectedRoomHead;
	// @ts-expect-error No caller role.
	void input.role;
	// @ts-expect-error No caller declaration.
	void input.snapshotDeclaration;
	// @ts-expect-error No caller ACL.
	void input.closedAclBytes;
	// @ts-expect-error No caller profile.
	void input.profileId;
	// @ts-expect-error No parameters hint.
	void input.parameters;
}

import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import type { AheDurableStore, PresentHead } from "@ts-drp/storage";
import type { SnapshotRecoveryStore, SnapshotVerificationReceipt } from "@ts-drp/storage/snapshot-transfer";
import type { BindCreatorLiveCloseInput } from "../creator-close.js";
import type { CreatorRollbackFloorReader } from "./creator-closed-rollback-data.js";
import type { CreatorSuccessorGenerationMaterial } from "./creator-successor-live.js";

/** Captured once by the genuine room owner. These native ports are premises,
 * not classification authority; the protected planner authenticates all bytes. */
export interface CreatorPendingClassificationNativeOwners {
	readonly author: string;
	readonly roomHeadAuthority: CreatorRollbackFloorReader;
	readonly exactCanonicalPinnedGenesisTrustStateRecordBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes: Uint8Array;
	readonly voteStore: BindCreatorLiveCloseInput["voteStore"];
	readonly evidenceStore: BindCreatorLiveCloseInput["evidenceStore"];
	readonly signer: BindCreatorLiveCloseInput["signer"];
	readonly storageIncarnation: string;
}

/** Inputs to the sole existing runtime owner's nonactivating native custody
 * composition. Neither snapshot receipt nor this native tuple is authority. */
export interface CreatorPendingClassificationCustodyInput {
	readonly generation: CreatorSuccessorGenerationMaterial;
	readonly expectedNativeHead: PresentHead;
	readonly catalog: TrustedBlueprintCatalog;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly pinnedGenesisAnchorDigest: string;
	readonly store: AheDurableStore;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly owners: CreatorPendingClassificationNativeOwners;
}

export interface CreatorAdoptionRoomHead {
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

export interface CreatorAdoptionPendingRecoveryInput {
	/** Existing room maintenance book, not authority or a separate archive allowance. */
	readonly proofAccounting?: import("./creator-closed-rollback-data.js").CreatorClosedRollbackProofAccounting;
	readonly authenticationProfile: "creator-only";
	readonly catalog: TrustedBlueprintCatalog;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly expectedNextRoomHead: CreatorAdoptionRoomHead;
	readonly expectedPreviousRoomHead: CreatorAdoptionRoomHead;
	readonly pinnedGenesisAnchorDigest: string;
	readonly snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	readonly store: AheDurableStore;
	/** Required only when the native snapshot owns received recovery custody. */
	readonly issuanceStore?: DurableIssuanceStore;
	readonly liveJournalStore?: DurableLiveJournalStore;
	/** Internal room-owner composition only; public pending input capture does
	 * not accept this tuple and cannot publish while migration remains held. */
	readonly classificationOwners?: CreatorPendingClassificationNativeOwners;
}

export type CreatorAdoptionPendingRecoveryResult =
	| Readonly<{
			readonly head: CreatorAdoptionRoomHead;
			readonly lifecycle: "successor-published";
			readonly ok: true;
			readonly recovery: "active-new";
	  }>
	| Readonly<{ readonly detail: string; readonly kind: string; readonly ok: false }>;

type RecoveryOwner = (input: CreatorAdoptionPendingRecoveryInput) => Promise<CreatorAdoptionPendingRecoveryResult>;

let owner: RecoveryOwner | undefined;

/**
 * Installs the sole private non-activating pending-recovery owner.
 * @param candidate - Authenticated durable recovery kernel.
 * @returns Whether the owner was installed.
 */
export function installCreatorAdoptionPendingRecovery(candidate: RecoveryOwner): boolean {
	if (owner !== undefined) return false;
	owner = candidate;
	return true;
}

/**
 * Executes the installed private non-activating recovery owner.
 * @param input - Exact copied provider heads and durable authentication carriers.
 * @returns Published room head or typed fail-closed result.
 */
export function consumeCreatorAdoptionPendingRecovery(
	input: CreatorAdoptionPendingRecoveryInput
): Promise<CreatorAdoptionPendingRecoveryResult> {
	return owner === undefined
		? Promise.resolve(
				Object.freeze({
					detail: "creator adoption pending recovery owner is unavailable",
					kind: "internal-invariant",
					ok: false,
				})
			)
		: owner(input);
}

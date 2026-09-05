import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import type { AheDurableStore } from "@ts-drp/storage";
import type {
	SnapshotQuarantineDeclaration,
	SnapshotQuarantineStore,
	SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";

export interface CreatorAdoptionRoomHead {
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

export interface CreatorAdoptionPendingRecoveryInput {
	readonly authenticationProfile: "creator-only";
	readonly catalog: TrustedBlueprintCatalog;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly expectedNextRoomHead: CreatorAdoptionRoomHead;
	readonly expectedPreviousRoomHead: CreatorAdoptionRoomHead;
	readonly pinnedGenesisAnchorDigest: string;
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly store: AheDurableStore;
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

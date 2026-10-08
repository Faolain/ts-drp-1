import type { BindCreatorLiveCloseInput } from "../../../packages/node/dist/src/creator-close.js";
import type { CreatorAdoptionPendingRecoveryInput } from "../../../packages/node/dist/src/internal/creator-adoption-recover.js";
import type {
	SnapshotQuarantineStore,
	SnapshotRecoveryStore,
	SnapshotVerificationReceipt,
} from "../../../packages/storage/dist/src/snapshot-transfer.js";
type PendingHasNoDeclaration = "snapshotDeclaration" extends keyof CreatorAdoptionPendingRecoveryInput ? never : true;
type PendingRequiresDiscovery =
	CreatorAdoptionPendingRecoveryInput["snapshotStore"] extends SnapshotRecoveryStore<SnapshotVerificationReceipt>
		? true
		: never;
export const noDeclaration: PendingHasNoDeclaration = true;
export const requiredDiscovery: PendingRequiresDiscovery = true;
/**
 * Producer remains deliberately narrow; this signature must compile unchanged.
 * @param store - Deliberately narrow live producer store.
 * @returns The unchanged narrow producer capability.
 */
export function producerStore(
	store: SnapshotQuarantineStore<SnapshotVerificationReceipt>
): BindCreatorLiveCloseInput["snapshotStore"] {
	return store;
}

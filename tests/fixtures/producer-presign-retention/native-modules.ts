import { activateCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption-activate.js";
import { commitCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption-commit.js";
import { verifyCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption.js";
import { bindCreatorLiveClose } from "../../../packages/node/src/creator-close.js";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	prepareV3LiveGeneration,
	recoverV3LiveReplica,
	routeV3Ingress,
} from "../../../packages/node/src/v3-live.js";
import { openBrowserSealEvidenceStore } from "../../../packages/storage-browser/src/seal-evidence.js";
import { openBrowserSealVoteStore } from "../../../packages/storage-browser/src/seal-vote.js";
import { createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/src/snapshot-transfer.js";
import { createSqliteAheDurableStore } from "../../../packages/storage-node/src/index.js";
import { resolveNodeDurableIssuancePruningMaintenance } from "../../../packages/storage-node/src/issuance-maintenance.js";
import { createNodeDurableIssuanceStore } from "../../../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/src/live-journal.js";
import type { GenuineCreatorAdoptionFixtureModules } from "../phase-6a-v3/creator-adoption-contract.js";

/**
 * Static, genuine module DI avoids the adoption fixture's file-URL loader in the bundled child.
 * @param aheFilename - Exact process-owned native AHE database path.
 * @returns Real source modules with only the AHE storage location selected.
 */
export function nativeProducerModules(aheFilename: string): GenuineCreatorAdoptionFixtureModules {
	return {
		activateCreatorSuccessorAdoption,
		activateV3LivePlane,
		bindCreatorLiveClose,
		bindV3BlueprintLivePlane,
		commitCreatorSuccessorAdoption,
		createBrowserSnapshotQuarantineStore,
		createNodeDurableIssuanceStore,
		createNodeDurableLiveJournalStore,
		createSqliteAheDurableStore: () => createSqliteAheDurableStore({ filename: aheFilename }),
		openBrowserSealEvidenceStore,
		openBrowserSealVoteStore,
		prepareV3LiveGeneration,
		recoverV3LiveReplica,
		resolveNodeDurableIssuancePruningMaintenance,
		routeV3Ingress,
		verifyCreatorSuccessorAdoption,
	};
}

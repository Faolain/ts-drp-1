import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import type { DurableIssuancePruningMaintenance } from "@ts-drp/issuance-store/maintenance";

import { nodeIssuancePruningMaintenanceForStore } from "./internal/node-issuance-store.js";

/**
 * Resolves pruning authority only for the exact genuine Node issuance facade.
 * @param store - Candidate ordinary issuance facade.
 * @returns Its Node-owned maintenance capability, when identity matches.
 */
export function resolveNodeDurableIssuancePruningMaintenance(
	store: DurableIssuanceStore
): DurableIssuancePruningMaintenance | undefined {
	return nodeIssuancePruningMaintenanceForStore(store);
}

import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import type { DurableIssuancePruningMaintenance } from "@ts-drp/issuance-store/maintenance";

import { browserIssuancePruningMaintenanceForStore } from "./internal/browser-issuance-store.js";

/**
 * Resolves pruning authority only for the exact genuine browser issuance facade.
 * @param store - Candidate ordinary issuance facade.
 * @returns Its browser-owned maintenance capability, when identity matches.
 */
export function resolveBrowserDurableIssuancePruningMaintenance(
	store: DurableIssuanceStore
): DurableIssuancePruningMaintenance | undefined {
	return browserIssuancePruningMaintenanceForStore(store);
}

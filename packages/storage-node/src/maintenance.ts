import type { AheDurableStore } from "@ts-drp/storage";
import type { AheReclamationMaintenance } from "@ts-drp/storage/maintenance";

import { nodeAheReclamationMaintenanceForStore } from "./internal/ahe-reclamation.js";

/**
 * Resolves reclamation authority only for the exact genuine Node AHE facade.
 * @param store - Candidate ordinary AHE facade.
 * @returns Its Node-owned maintenance capability when identity matches.
 */
export function resolveNodeAheReclamationMaintenance(store: AheDurableStore): AheReclamationMaintenance | undefined {
	return nodeAheReclamationMaintenanceForStore(store);
}

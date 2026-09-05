import type { AheDurableStore } from "@ts-drp/storage";
import type { AheReclamationMaintenance } from "@ts-drp/storage/maintenance";

import { browserAheReclamationMaintenanceForStore } from "./internal/ahe-reclamation.js";

/**
 * Resolves reclamation authority only for the exact genuine browser AHE facade.
 * @param store - Candidate ordinary AHE facade.
 * @returns Its browser-owned maintenance capability when identity matches.
 */
export function resolveBrowserAheReclamationMaintenance(store: AheDurableStore): AheReclamationMaintenance | undefined {
	return browserAheReclamationMaintenanceForStore(store);
}

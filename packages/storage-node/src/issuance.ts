import type { DurableIssuanceStore } from "@ts-drp/issuance-store";

import { createNodeDurableIssuanceStoreImplementation } from "./internal/node-issuance-store.js";

export interface NodeDurableIssuanceStoreOptions {
	readonly primaryFilename: string;
}

/**
 * Creates one durable Node issuance capability over the exact derived SQLite authority.
 * @param options - Exact Node factory options.
 * @returns The shared five-method durable issuance capability.
 */
export function createNodeDurableIssuanceStore(options: NodeDurableIssuanceStoreOptions): DurableIssuanceStore {
	return createNodeDurableIssuanceStoreImplementation(options);
}

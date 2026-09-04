import type { DurableIssuanceStore } from "@ts-drp/issuance-store";

import { createBrowserDurableIssuanceStoreImplementation } from "./internal/browser-issuance-store.js";

export interface BrowserDurableIssuanceStoreOptions {
	readonly primaryDatabaseName: string;
}

/**
 * Creates one strict-durability browser issuance capability over its dedicated derived database.
 * @param options - Exact browser factory options.
 * @returns The shared eight-method durable issuance capability.
 */
export async function createBrowserDurableIssuanceStore(
	options: BrowserDurableIssuanceStoreOptions
): Promise<DurableIssuanceStore> {
	return createBrowserDurableIssuanceStoreImplementation(options);
}

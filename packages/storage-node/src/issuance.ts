import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import type { NodeNativeReadPort } from "./index.js";

import { createNodeDurableIssuanceStoreImplementation } from "./internal/node-issuance-store.js";
import type { LocalSessionLifetime } from "./internal/local-session-lifetime.js";

export interface NodeDurableIssuanceStoreOptions {
	readonly primaryFilename: string;
	readonly initialization?: "create" | "reopen";
}

/**
 * Creates one durable Node issuance capability over the exact derived SQLite authority.
 * @param options - Exact Node factory options.
 * @returns The shared eight-method durable issuance capability.
 */
export function createNodeDurableIssuanceStore(
	options: NodeDurableIssuanceStoreOptions,
	session?: LocalSessionLifetime
): DurableIssuanceStore & NodeNativeReadPort {
	return createNodeDurableIssuanceStoreImplementation(options, session);
}

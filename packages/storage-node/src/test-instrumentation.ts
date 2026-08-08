import type { AheDurableStore } from "@ts-drp/storage";

import type { SqliteAheDurableStoreOptions } from "./index.js";
import { createSqliteScaffold, type SqliteMutationFault } from "./internal/create-scaffold.js";

export type SqliteConnectionConfiguration = Readonly<{
	foreignKeys: boolean;
	integrityCheck: string;
	journalMode: string;
	synchronous: string;
}>;

export type InstrumentedSqliteAheDurableStore = Readonly<{
	inspectConfiguration(): SqliteConnectionConfiguration;
	store: AheDurableStore;
}>;

/**
 * Creates a store with the bounded Phase 2c-a transaction fault hook.
 * This module is intentionally absent from the package export map.
 * @param options - File-backed SQLite options.
 * @param fault - Synchronous fault injected immediately before commit.
 * @returns An instrumented strict store.
 * @internal
 */
export function createInstrumentedSqliteAheDurableStore(
	options: SqliteAheDurableStoreOptions,
	fault?: SqliteMutationFault
): InstrumentedSqliteAheDurableStore {
	return {
		inspectConfiguration: () => ({
			foreignKeys: false,
			integrityCheck: "ok",
			journalMode: "delete",
			synchronous: "full",
		}),
		store: createSqliteScaffold(options, fault),
	};
}

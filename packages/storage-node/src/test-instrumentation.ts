import type { AheDurableStore } from "@ts-drp/storage";

import type { SqliteAheDurableStoreOptions } from "./index.js";
import { createInstrumentedSqliteScaffold, type SqliteMutationFault } from "./internal/create-scaffold.js";

export type SqliteConnectionConfiguration = Readonly<{
	foreignKeys: unknown;
	integrityCheck: unknown;
	journalMode: unknown;
	synchronous: unknown;
}>;

export type InstrumentedSqliteAheDurableStore = Readonly<{
	attemptInvalidForeignKeyInsert(): void;
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
	const scaffold = createInstrumentedSqliteScaffold(options, fault);
	return {
		attemptInvalidForeignKeyInsert: scaffold.attemptInvalidForeignKeyInsert,
		inspectConfiguration: () => ({
			foreignKeys: scaffold.readPragma("foreign_keys"),
			integrityCheck: scaffold.readPragma("integrity_check"),
			journalMode: scaffold.readPragma("journal_mode"),
			synchronous: scaffold.readPragma("synchronous"),
		}),
		store: scaffold.store,
	};
}

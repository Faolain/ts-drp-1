import type { AheDurableStore } from "@ts-drp/storage";

import type { SqliteAheDurableStoreOptions } from "./index.js";
import {
	installNodeAheReclamationCountFault,
	installNodeAheReclamationCrashObserver,
	type NodeAheReclamationCountFault,
	type NodeAheReclamationCrashObserver,
} from "./internal/ahe-reclamation.js";
import {
	createInstrumentedSqliteScaffold,
	type SqliteCrashCheckpointObserver,
	type SqliteMutationFault,
} from "./internal/create-scaffold.js";

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

export type ExpandedCrashInstrumentation = Readonly<{ crashCheckpoints: "expanded" }>;

export { installNodeAheReclamationCrashObserver };
export { installNodeAheReclamationCountFault };
export type { NodeAheReclamationCountFault, NodeAheReclamationCrashObserver };

/**
 * Creates a store with the bounded Phase 2c-a transaction fault hook.
 * This module is intentionally absent from the package export map.
 * @param options - File-backed SQLite options.
 * @param callback - Legacy fault hook, or the expanded crash observer when explicitly enabled.
 * @param instrumentation - Private opt-in for expanded process-death checkpoints.
 * @returns An instrumented strict store.
 */
export function createInstrumentedSqliteAheDurableStore(
	options: SqliteAheDurableStoreOptions,
	callback?: SqliteCrashCheckpointObserver,
	instrumentation?: ExpandedCrashInstrumentation
): InstrumentedSqliteAheDurableStore {
	const expanded = instrumentation?.crashCheckpoints === "expanded";
	const scaffold = createInstrumentedSqliteScaffold(
		options,
		expanded ? undefined : (callback as SqliteMutationFault | undefined),
		expanded ? callback : undefined
	);
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

import type { AheDurableStore } from "@ts-drp/storage";

import { createSqliteScaffold } from "./internal/create-scaffold.js";

export type SqliteAheDurableStoreOptions = {
	readonly filename: string;
};

/**
 * Creates the Node SQLite durable-store adapter.
 * @param options - File-backed SQLite options.
 * @returns A strict durable-store adapter.
 */
export function createSqliteAheDurableStore(options: SqliteAheDurableStoreOptions): AheDurableStore {
	return createSqliteScaffold(options);
}

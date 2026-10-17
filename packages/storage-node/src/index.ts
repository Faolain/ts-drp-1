import type { AheBoundedRecoveryRoleStore, NativeReadReservation } from "@ts-drp/storage";

import { createSqliteScaffold } from "./internal/create-scaffold.js";
export { createNodeArchiveStorage } from "./archive.js";
export type { NodeArchiveStorageOptions } from "./archive.js";
import type { LocalSessionLifetime } from "./internal/local-session-lifetime.js";

export type SqliteAheDurableStoreOptions = {
	readonly filename: string;
	readonly initialization?: "create" | "reopen";
};

/** Mechanical native custody exposed by the host, not an authentication grant. */
export interface NodeNativeReadPort {
	acquireNativeReadReservation(input: Readonly<{ objectId: string }>): Promise<NativeReadReservation>;
}

/**
 * Creates the Node SQLite durable-store adapter.
 * @param options - File-backed SQLite options.
 * @returns A strict durable-store adapter.
 */
export function createSqliteAheDurableStore(
	options: SqliteAheDurableStoreOptions,
	session?: LocalSessionLifetime
): AheBoundedRecoveryRoleStore & NodeNativeReadPort {
	return createSqliteScaffold(options, undefined, session);
}

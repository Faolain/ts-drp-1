import { resolve } from "node:path";

import { SqliteSigningDatabase } from "./signing-database.js";
import { SqliteSigningRetirementOwner } from "./signing-retirement.js";
import type { LocalSessionLifetime } from "./local-session-lifetime.js";

export interface NodeSigningStoreOptions {
	readonly filename: string;
	readonly initialization: "create" | "reopen";
}

interface SharedSigningDatabase {
	readonly database: SqliteSigningDatabase;
	references: number;
	closing: boolean;
}
const databases = new Map<string, SharedSigningDatabase>();

export interface SqliteSigningLease {
	readonly database: SqliteSigningDatabase;
	readonly retirement: SqliteSigningRetirementOwner;
	run<T>(write: boolean, operation: () => T): Promise<T>;
	close(): Promise<void>;
}

/**
 * Vote and evidence aliases share the original physical signing domain and
 * incarnation. Each alias retains its own revocation and admitted-work join.
 * This registry grants neither source authority nor a JavaScript writer lock.
 * @param options - Exact native filename and initialization policy.
 * @returns Alias lifetime over actual SQLite custody.
 */
export function acquireSqliteSigningLease(options: NodeSigningStoreOptions, session?: LocalSessionLifetime): SqliteSigningLease {
	session?.assertCurrent();
	if (options === null || typeof options !== "object" || Array.isArray(options))
		throw new TypeError("INVALID_SIGNING_DATABASE");
	const fields = Object.getOwnPropertyDescriptors(options);
	if (
		Reflect.ownKeys(fields).length !== 2 ||
		!fields.filename ||
		!("value" in fields.filename) ||
		!fields.initialization ||
		!("value" in fields.initialization) ||
		typeof fields.filename.value !== "string" ||
		!fields.filename.value ||
		fields.filename.value.includes("\0") ||
		!["create", "reopen"].includes(fields.initialization.value as string)
	)
		throw new TypeError("INVALID_SIGNING_DATABASE");
	const filename = resolve(fields.filename.value as string);
	let shared = databases.get(filename);
	if (shared?.closing) throw new Error("STORE_CLOSING");
	if (shared === undefined) {
		shared = {
			database: new SqliteSigningDatabase({
				filename,
				initialization: fields.initialization.value as "create" | "reopen",
			}, session),
			references: 0,
			closing: false,
		};
		databases.set(filename, shared);
	} else {
		shared.database.enforceLocalCustody(session);
		shared.database.transact(false, () => shared?.database.assertCurrency());
	}
	shared.references++;
	const captured = shared;
	const retirement = new SqliteSigningRetirementOwner(captured.database, async (): Promise<void> => {
		captured.references--;
		if (captured.references !== 0) return;
		captured.closing = true;
		try {
			await captured.database.close();
		} finally {
			if (databases.get(filename) === captured) databases.delete(filename);
		}
	}, session);
	let closed = false;
	return Object.freeze({
		database: captured.database,
		retirement,
		run<T>(write: boolean, operation: () => T): Promise<T> {
			try {
				session?.assertCurrent();
				if (closed) throw new Error("STORE_CLOSED");
				return session ? session.run(() => captured.database.transact(write, operation)) : Promise.resolve(captured.database.transact(write, operation));
			} catch (cause) {
				return Promise.reject(cause);
			}
		},
		close(): Promise<void> {
			closed = true;
			return retirement.close();
		},
	});
}

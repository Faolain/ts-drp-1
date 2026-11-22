import { DatabaseSync } from "node:sqlite";

import { sqliteFilename } from "./sqlite-filename.js";
import { cachedStatement } from "./sqlite-statement-cache.js";

/**
 * A stable numbered coordination file, never an epoch file or wire authority.
 * @param filename - Canonical primary-owner-derived numbered coordination file.
 * @param mode - Shared dependency custody or exact retirement exclusion.
 * @param initialize - Only true for a never-before-allocated stable slot.
 * @returns Joined native lock operations, without protocol authority.
 */
export function acquireSnapshotDependencyLock(
	filename: string,
	mode: "shared" | "exclusive",
	initialize = false
): Readonly<{ check(): void; release(): void }> {
	const database = new DatabaseSync(sqliteFilename(filename, initialize ? "create" : "reopen"));
	let active = false;
	try {
		database.exec("PRAGMA busy_timeout=0");
		const names = cachedStatement(database, "SELECT name FROM sqlite_schema WHERE type='table'").all();
		if (names.length === 0 && initialize) {
			// Allocation occurs under the primary owner's native writer transaction.
			// Stable files are never unlinked or replaced, including on slot reuse.
			database.exec(
				"PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; CREATE TABLE snapshot_dependency_lock(id INTEGER PRIMARY KEY CHECK(id=1)) STRICT; INSERT INTO snapshot_dependency_lock VALUES(1); COMMIT"
			);
		}
		if (
			String(cachedStatement(database, "PRAGMA journal_mode").get()?.journal_mode).toLowerCase() !== "delete" ||
			names.length > 1 ||
			(names.length === 1 && names[0]?.name !== "snapshot_dependency_lock") ||
			cachedStatement(database, "SELECT sql FROM sqlite_schema WHERE name='snapshot_dependency_lock'").get()?.sql !==
				"CREATE TABLE snapshot_dependency_lock(id INTEGER PRIMARY KEY CHECK(id=1)) STRICT" ||
			cachedStatement(database, "SELECT count(*) AS n, min(id) AS id FROM snapshot_dependency_lock").get()?.n !== 1
		)
			throw new Error("SNAPSHOT_DEPENDENCY_LOCK_POISONED");
		database.exec(mode === "shared" ? "BEGIN" : "BEGIN EXCLUSIVE");
		active = true;
		// In DELETE mode this establishes a genuine native SHARED lock. BEGIN by
		// itself is insufficient; WAL snapshot transactions are never used here.
		if (cachedStatement(database, "SELECT id FROM snapshot_dependency_lock").get()?.id !== 1)
			throw new Error("SNAPSHOT_DEPENDENCY_LOCK_POISONED");
		return Object.freeze({
			check(): void {
				if (!active) throw new Error("SNAPSHOT_DEPENDENCY_LOCK_RELEASED");
				if (cachedStatement(database, "SELECT id FROM snapshot_dependency_lock").get()?.id !== 1)
					throw new Error("SNAPSHOT_DEPENDENCY_LOCK_LOST");
			},
			release(): void {
				if (!active) return;
				active = false;
				const failures: unknown[] = [];
				try {
					database.exec("ROLLBACK");
				} catch (cause) {
					failures.push(cause);
				}
				try {
					database.close();
				} catch (cause) {
					failures.push(cause);
				}
				if (failures.length)
					throw new AggregateError(failures, "snapshot dependency lock release failed", { cause: failures[0] });
			},
		});
	} catch (primary) {
		const failures = [primary];
		try {
			if (active) database.exec("ROLLBACK");
		} catch (cause) {
			failures.push(cause);
		}
		try {
			database.close();
		} catch (cause) {
			failures.push(cause);
		}
		if (failures.length > 1)
			throw new AggregateError(failures, "snapshot dependency lock acquisition and cleanup failed", { cause: primary });
		throw primary;
	}
}

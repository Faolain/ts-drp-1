import { DatabaseSync } from "node:sqlite";

import type { ShippingChatArchiveStore, ShippingChatArchiveStoredRow } from "./v3-chat-archive.js";

// Track W: the Chat device archive's Node store (Node hosts and tests; the browser app uses the
// IndexedDB store in v3-chat-archive.ts). Its own SQLite file, never a room database. WAL with
// synchronous=FULL, and one explicit IMMEDIATE transaction per commit, so a crash leaves the old
// or the new archive.

/**
 * Opens (creating if needed) the archive file.
 * @param filename - The archive's own SQLite file.
 * @returns The store.
 */
export function openNodeShippingChatArchiveStore(filename: string): ShippingChatArchiveStore {
	const db = new DatabaseSync(filename);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA synchronous=FULL");
	db.exec(
		"CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL, record BLOB NOT NULL)"
	);
	const select = db.prepare("SELECT seq, key, epoch, record FROM messages ORDER BY seq");
	const insert = db.prepare("INSERT INTO messages (seq, key, epoch, record) VALUES (?, ?, ?, ?)");
	const remove = db.prepare("DELETE FROM messages WHERE seq = ?");
	let open = true;
	return Object.freeze({
		load(): Promise<readonly ShippingChatArchiveStoredRow[]> {
			return Promise.resolve(
				select.all().map((row) => ({
					seq: Number(row.seq),
					key: typeof row.key === "string" ? row.key : "",
					epoch: Number(row.epoch),
					record: row.record instanceof Uint8Array ? new Uint8Array(row.record) : new Uint8Array(),
				}))
			);
		},
		commit(append: readonly ShippingChatArchiveStoredRow[], removed: readonly number[]): Promise<void> {
			if (!open) return Promise.reject(new TypeError("Chat archive store is closed"));
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const seq of removed) remove.run(seq);
				for (const row of append) insert.run(row.seq, row.key, row.epoch, row.record);
			} catch (error) {
				db.exec("ROLLBACK");
				return Promise.reject(error instanceof Error ? error : new TypeError(String(error)));
			}
			db.exec("COMMIT");
			return Promise.resolve();
		},
		close(): Promise<void> {
			if (open) {
				open = false;
				db.close();
			}
			return Promise.resolve();
		},
	});
}

import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { captureShippingChatOperation, type ShippingChatMessage } from "./v3-chat-message.js";

// Track W: the Chat device archive. The room's replicated state is a rolling window, so each
// device keeps the messages its own room projection has shown in a local archive: application
// data of this device, in its own database (never a room database, never counted as room
// storage), bounded by its own limit (oldest dropped first), written after the projection
// callback in a later task (never on the room's commit, seal, adoption, install or lull paths),
// and never read by the room. Every message it records was authenticated and admitted by this
// device's room before the projection showed it; the archive adds nothing to that, grants no
// authority and feeds nothing back into replicated state, admission or any proof. Stored bytes
// are untrusted: every row is re-validated when loaded and only ever displayed.

/** Proposed for owner review (Track W): at most this many messages and record bytes per room per device. */
export const SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND = Object.freeze({ maxMessages: 2000, maxBytes: 1_048_576 });

export interface ShippingChatArchiveBound {
	readonly maxMessages: number;
	readonly maxBytes: number;
}

/** One stored row: canonical message record bytes, keyed by identity and content digest. */
export interface ShippingChatArchiveStoredRow {
	readonly seq: number;
	readonly key: string;
	readonly epoch: number;
	readonly record: Uint8Array;
}

/** A device-local store for the archive. One `commit` is one atomic, strictly durable transaction. */
export interface ShippingChatArchiveStore {
	/** Every stored row, in sequence order. */
	load(): Promise<readonly ShippingChatArchiveStoredRow[]>;
	commit(append: readonly ShippingChatArchiveStoredRow[], remove: readonly number[]): Promise<void>;
	close(): Promise<void>;
}

export interface ShippingChatArchiveRecord extends ShippingChatMessage {
	readonly key: string;
	readonly seq: number;
	/** The epoch of the projection this device first showed the message in. */
	readonly epoch: number;
	/** Its canonical record bytes (the unit of the byte bound). */
	readonly bytes: number;
}

export interface ShippingChatArchiveStats {
	readonly messages: number;
	readonly bytes: number;
	/** Records appended and evicted since this archive was opened. */
	readonly appended: number;
	readonly evicted: number;
	/** Store transactions since open, and the wall time spent in them (append cost). */
	readonly transactions: number;
	readonly transactionMs: number;
	/** Rows dropped on load because they failed validation. */
	readonly invalidRows: number;
	/** Background writes that failed (the room is never affected). */
	readonly failures: number;
}

export interface ShippingChatLocalArchive {
	/** Keeps a reference to the projection and schedules one write in a later task. O(1). */
	observe(projection: Readonly<{ messages: readonly ShippingChatMessage[]; epoch?: number }>): void;
	/** Writes whatever was observed and not yet written; resolves when the store has committed. */
	flush(): Promise<void>;
	/** The archive, oldest first. */
	records(): readonly ShippingChatArchiveRecord[];
	stats(): ShippingChatArchiveStats;
	/** Writes pending work, then closes the store. */
	close(): Promise<void>;
	/** Closes without writing pending work (what a crash leaves). */
	discard(): Promise<void>;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const identityOf = (message: Readonly<{ author: string; clientOperationId: string }>): string =>
	`${message.author}\u0000${message.clientOperationId}`;
const contentOf = (message: ShippingChatMessage): string =>
	`${identityOf(message)}\u0000${message.displayTimeMs}\u0000${message.text}`;
// The stored key: author (64 hex), identity (no "/") and record digest; text-safe in every store.
const keyOf = (message: ShippingChatMessage, record: Uint8Array): string =>
	`${message.author}/${message.clientOperationId}/${hex(hashDomain("ts-drp/chat-archive-record/v1", record))}`;

/**
 * The archive's database for one room and one local author: never a room database name.
 * @param objectId - The room.
 * @param author - The local author.
 * @returns The IndexedDB database name.
 */
export function shippingChatArchiveDatabaseName(objectId: string, author: string): string {
	return (
		"ts-drp-chat-archive-v1--" +
		hex(hashDomain("ts-drp/chat-archive-database/v1", new TextEncoder().encode(`${objectId}\u0000${author}`)))
	);
}

/**
 * Untrusted stored bytes back to a message, or undefined (never trusted, only displayed).
 * @param row
 */
function restoreRow(row: ShippingChatArchiveStoredRow): ShippingChatArchiveRecord | undefined {
	try {
		if (!Number.isSafeInteger(row.seq) || row.seq < 1 || !Number.isSafeInteger(row.epoch) || row.epoch < 0)
			return undefined;
		const decoded = decodeCanonical(row.record) as Record<string, unknown>;
		if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
		const keys = Object.keys(decoded).sort();
		if (keys.join(",") !== "author,clientOperationId,displayTimeMs,text" || typeof decoded.author !== "string")
			return undefined;
		const operation = captureShippingChatOperation(
			{
				action: "message",
				clientOperationId: decoded.clientOperationId,
				displayTimeMs: decoded.displayTimeMs,
				text: decoded.text,
			},
			decoded.author
		);
		const message: ShippingChatMessage = Object.freeze({
			author: decoded.author,
			clientOperationId: operation.clientOperationId,
			displayTimeMs: operation.displayTimeMs,
			text: operation.text,
		});
		const record = encodeCanonical(message);
		if (record.byteLength !== row.record.byteLength || record.some((byte, index) => byte !== row.record[index]))
			return undefined;
		if (keyOf(message, record) !== row.key) return undefined;
		return Object.freeze({ ...message, key: row.key, seq: row.seq, epoch: row.epoch, bytes: record.byteLength });
	} catch {
		return undefined;
	}
}

// A tombstone is a stored row with an empty record: the bound dropped that record while its message
// was still in the window. It keeps the window's older messages from being archived again (while
// running and after a reopen) and is deleted once its message leaves the window, so there are never
// more tombstones than the window holds messages.
const TOMBSTONE_KEY = /^[0-9a-f]{64}\/[A-Za-z0-9._:-]{1,128}\/[0-9a-f]{64}$/u;

/**
 * Opens a device archive over `store`.
 * @param input - The store, an optional bound (default SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND) and an
 * optional scheduler for background writes (default: a later macrotask).
 * @returns The archive, loaded and within its bound.
 */
export async function openShippingChatLocalArchive(
	input: Readonly<{
		store: ShippingChatArchiveStore;
		bound?: ShippingChatArchiveBound;
		schedule?(run: () => void): void;
	}>
): Promise<ShippingChatLocalArchive> {
	const store = input.store;
	const bound = input.bound ?? SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND;
	if (!Number.isSafeInteger(bound.maxMessages) || bound.maxMessages < 1 || !Number.isSafeInteger(bound.maxBytes))
		throw new TypeError("Chat archive bound is invalid");
	const schedule = input.schedule ?? ((run: () => void): void => void setTimeout(run, 0));
	const rows: ShippingChatArchiveRecord[] = [];
	const byContent = new Map<string, ShippingChatArchiveRecord>();
	// Tombstones by key (their sequence numbers), and by message content once a window showed it.
	const tombstones = new Map<string, number>();
	const tombstoneByContent = new Map<string, string>();
	let bytes = 0;
	let nextSeq = 1;
	const stats = { appended: 0, evicted: 0, transactions: 0, transactionMs: 0, invalidRows: 0, failures: 0 };

	const commit = async (append: readonly ShippingChatArchiveStoredRow[], remove: readonly number[]): Promise<void> => {
		if (append.length === 0 && remove.length === 0) return;
		const started = performance.now();
		await store.commit(append, remove);
		stats.transactions++;
		stats.transactionMs += performance.now() - started;
	};
	const add = (record: ShippingChatArchiveRecord): void => {
		rows.push(record);
		byContent.set(contentOf(record), record);
		bytes += record.bytes;
	};
	/** Oldest first, until within the bound; returns the removed records. */
	const evict = (): ShippingChatArchiveRecord[] => {
		const removed: ShippingChatArchiveRecord[] = [];
		while (rows.length > bound.maxMessages || bytes > bound.maxBytes) {
			const oldest = rows.shift() as ShippingChatArchiveRecord;
			byContent.delete(contentOf(oldest));
			bytes -= oldest.bytes;
			removed.push(oldest);
		}
		return removed;
	};
	const tombstone = (record: ShippingChatArchiveRecord, epoch: number): ShippingChatArchiveStoredRow => {
		const row = Object.freeze({ seq: nextSeq++, key: record.key, epoch, record: new Uint8Array() });
		tombstones.set(row.key, row.seq);
		tombstoneByContent.set(contentOf(record), row.key);
		return row;
	};

	// Load: re-validate every row; drop what fails (and duplicates), then apply the bound. Records
	// over the bound become tombstones (the window is not known yet); the first write keeps those
	// whose message is still in the window.
	const invalid: number[] = [];
	for (const row of await store.load()) {
		const ordered = Number.isSafeInteger(row.seq) && row.seq >= nextSeq;
		if (ordered && row.record.byteLength === 0) {
			if (!TOMBSTONE_KEY.test(row.key) || tombstones.has(row.key) || !Number.isSafeInteger(row.epoch)) {
				invalid.push(row.seq);
				continue;
			}
			tombstones.set(row.key, row.seq);
			nextSeq = row.seq + 1;
			continue;
		}
		const record = restoreRow(row);
		if (record === undefined || !ordered || byContent.has(contentOf(record))) {
			invalid.push(row.seq);
			continue;
		}
		add(record);
		nextSeq = record.seq + 1;
	}
	// A key both live and tombstoned cannot come from the store's unique key; keep the record.
	for (const record of rows) {
		const seq = tombstones.get(record.key);
		if (seq === undefined) continue;
		invalid.push(seq);
		tombstones.delete(record.key);
	}
	stats.invalidRows = invalid.length;
	const overBound = evict();
	stats.evicted += overBound.length;
	await commit(
		overBound.map((record) => tombstone(record, record.epoch)),
		[...invalid, ...overBound.map((record) => record.seq)]
	);

	let pending: Readonly<{ messages: readonly ShippingChatMessage[]; epoch?: number }> | undefined;
	let scheduled = false;
	let closed = false;
	let chain: Promise<void> = Promise.resolve();

	// Every window message the archive neither holds nor has a tombstone for is new to it: admitted
	// since the last write, or while the archive was not writing (a crash between admission and
	// append). It is appended in window order; the bound then drops the oldest records, and any of
	// them still in the window leaves a tombstone. Tombstones whose message left the window go.
	const write = async (): Promise<void> => {
		const projection = pending;
		pending = undefined;
		if (projection === undefined) return;
		const epoch = projection.epoch ?? 0;
		const window = new Set<string>();
		const shown = new Set<string>();
		const append: ShippingChatArchiveStoredRow[] = [];
		const appended = new Set<number>();
		for (const value of projection.messages) {
			const message: ShippingChatMessage = Object.freeze({
				author: value.author,
				clientOperationId: value.clientOperationId,
				displayTimeMs: value.displayTimeMs,
				text: value.text,
			});
			const content = contentOf(message);
			window.add(content);
			if (byContent.has(content)) continue;
			const known = tombstoneByContent.get(content);
			if (known !== undefined) {
				shown.add(known);
				continue;
			}
			const record = encodeCanonical(message);
			const key = keyOf(message, record);
			if (tombstones.has(key)) {
				tombstoneByContent.set(content, key);
				shown.add(key);
				continue;
			}
			const stored = Object.freeze({ seq: nextSeq++, key, epoch, record });
			append.push(stored);
			appended.add(stored.seq);
			add(Object.freeze({ ...message, key, seq: stored.seq, epoch, bytes: record.byteLength }));
		}
		const remove: number[] = [];
		for (const [key, seq] of tombstones)
			if (!shown.has(key)) {
				tombstones.delete(key);
				remove.push(seq);
			}
		for (const [content, key] of tombstoneByContent) if (!tombstones.has(key)) tombstoneByContent.delete(content);
		const evicted = evict();
		const kept = new Set(rows.map((row) => row.seq));
		const rowsToWrite: ShippingChatArchiveStoredRow[] = append.filter((row) => kept.has(row.seq));
		for (const record of evicted) {
			// A record appended and evicted in the same write is never stored.
			if (!appended.has(record.seq)) remove.push(record.seq);
			if (window.has(contentOf(record))) rowsToWrite.push(tombstone(record, record.epoch));
		}
		await commit(rowsToWrite, remove);
		stats.appended += append.length;
		stats.evicted += evicted.length;
	};
	const flush = (): Promise<void> => {
		const next = chain.then(write);
		chain = next.catch(() => {
			stats.failures++;
		});
		return next;
	};

	return Object.freeze({
		observe(projection: Readonly<{ messages: readonly ShippingChatMessage[]; epoch?: number }>): void {
			if (closed) return;
			pending = projection;
			if (scheduled) return;
			scheduled = true;
			schedule(() => {
				scheduled = false;
				if (!closed) void flush().catch(() => undefined);
			});
		},
		flush,
		records: () => Object.freeze([...rows]),
		stats: () =>
			Object.freeze({
				messages: rows.length,
				bytes,
				...stats,
			}),
		async close(): Promise<void> {
			if (closed) return;
			await flush().catch(() => undefined);
			closed = true;
			await chain;
			await store.close();
		},
		async discard(): Promise<void> {
			if (closed) return;
			closed = true;
			pending = undefined;
			await chain;
			await store.close();
		},
	});
}

export interface ShippingChatHistoryMessage extends ShippingChatMessage {
	/** True when the message is in the shared window; false when only this device's archive has it. */
	readonly inWindow: boolean;
}

/**
 * This device's history: the window and the archive, each message once (the window's copy
 * first), ordered by display time, then author, then identity.
 * @param window - The projection's messages.
 * @param archive - The archive's records.
 * @returns The merged history.
 */
export function shippingChatHistory(
	window: readonly ShippingChatMessage[],
	archive: readonly ShippingChatArchiveRecord[]
): readonly ShippingChatHistoryMessage[] {
	const seen = new Set<string>();
	const history: ShippingChatHistoryMessage[] = [];
	for (const message of window) {
		seen.add(contentOf(message));
		history.push(
			Object.freeze({
				author: message.author,
				clientOperationId: message.clientOperationId,
				displayTimeMs: message.displayTimeMs,
				text: message.text,
				inWindow: true,
			})
		);
	}
	for (const record of archive) {
		if (seen.has(contentOf(record))) continue;
		seen.add(contentOf(record));
		history.push(
			Object.freeze({
				author: record.author,
				clientOperationId: record.clientOperationId,
				displayTimeMs: record.displayTimeMs,
				text: record.text,
				inWindow: false,
			})
		);
	}
	const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
	return history.sort(
		(left, right) =>
			left.displayTimeMs - right.displayTimeMs ||
			order(left.author, right.author) ||
			order(left.clientOperationId, right.clientOperationId)
	);
}

/**
 * The browser store: its own IndexedDB database (see shippingChatArchiveDatabaseName), one object
 * store keyed by sequence with a unique key index, strict-durability transactions.
 * @param databaseName - The archive database.
 * @returns The store.
 */
export async function openBrowserShippingChatArchiveStore(databaseName: string): Promise<ShippingChatArchiveStore> {
	const db = await new Promise<IDBDatabase>((resolve, reject): void => {
		const request = indexedDB.open(databaseName, 1);
		request.onupgradeneeded = (): void => {
			const store = request.result.createObjectStore("messages", { keyPath: "seq" });
			store.createIndex("key", "key", { unique: true });
		};
		request.onsuccess = (): void => resolve(request.result);
		request.onerror = (): void => reject(request.error ?? new TypeError("Chat archive database did not open"));
		request.onblocked = (): void => reject(new TypeError("Chat archive database is blocked"));
	});
	const transaction = (mode: IDBTransactionMode): IDBTransaction =>
		db.transaction(["messages"], mode, { durability: "strict" });
	const done = (tx: IDBTransaction): Promise<void> =>
		new Promise<void>((resolve, reject): void => {
			tx.oncomplete = (): void => resolve();
			tx.onabort = (): void => reject(tx.error ?? new TypeError("Chat archive transaction aborted"));
			tx.onerror = (): void => reject(tx.error ?? new TypeError("Chat archive transaction failed"));
		});
	return Object.freeze({
		async load(): Promise<readonly ShippingChatArchiveStoredRow[]> {
			const tx = transaction("readonly");
			const request = tx.objectStore("messages").getAll();
			const completed = done(tx);
			await completed;
			const values = request.result as unknown[];
			return values.flatMap((value) => {
				if (value === null || typeof value !== "object") return [];
				const row = value as Record<string, unknown>;
				return typeof row.seq === "number" &&
					typeof row.key === "string" &&
					typeof row.epoch === "number" &&
					row.record instanceof Uint8Array
					? [{ seq: row.seq, key: row.key, epoch: row.epoch, record: row.record }]
					: typeof row.seq === "number"
						? [{ seq: row.seq, key: "", epoch: -1, record: new Uint8Array() }]
						: [];
			});
		},
		async commit(append: readonly ShippingChatArchiveStoredRow[], remove: readonly number[]): Promise<void> {
			const tx = transaction("readwrite");
			const completed = done(tx);
			const messages = tx.objectStore("messages");
			for (const seq of remove) messages.delete(seq);
			for (const row of append)
				messages.put({ seq: row.seq, key: row.key, epoch: row.epoch, record: new Uint8Array(row.record) });
			await completed;
		},
		close(): Promise<void> {
			db.close();
			return Promise.resolve();
		},
	});
}

import type { PeerCachePersistenceErrorEvent, PeerCacheStore, StoredPeerRecord } from "./peer-cache.js";

export interface PeerCacheStorage {
	getItem(key: string): string | null;
	removeItem(key: string): void;
	setItem(key: string, value: string): void;
}

export interface LocalStoragePeerCacheStoreOptions {
	readonly key: string;
	onPersistenceError?(event: PeerCachePersistenceErrorEvent): void;
	readonly storage?: PeerCacheStorage;
}

/** Browser-local persistence adapter; it has no Node runtime dependency. */
export class LocalStoragePeerCacheStore implements PeerCacheStore {
	readonly #key: string;
	readonly #onPersistenceError: LocalStoragePeerCacheStoreOptions["onPersistenceError"];
	readonly #storage: PeerCacheStorage | undefined;
	#memoryRecords: readonly StoredPeerRecord[] = [];
	#persistenceDirty = false;

	/**
	 * @param options - Storage key, optional adapter, and sanitized failure sink.
	 */
	constructor(options: LocalStoragePeerCacheStoreOptions) {
		if (typeof options.key !== "string" || options.key.length === 0) {
			throw new Error("peer cache localStorage key must be non-empty");
		}
		this.#key = options.key;
		this.#onPersistenceError = options.onPersistenceError;
		this.#storage = options.storage;
	}

	/** @returns Persisted records, or the last in-memory snapshot when storage is unavailable. */
	load(): Promise<readonly StoredPeerRecord[]> {
		if (this.#persistenceDirty) return Promise.resolve([...this.#memoryRecords]);
		try {
			const storage = this.#resolveStorage();
			const serialized = storage.getItem(this.#key);
			if (serialized === null) {
				this.#memoryRecords = [];
				return Promise.resolve([]);
			}
			const parsed: unknown = JSON.parse(serialized);
			this.#memoryRecords = Array.isArray(parsed) ? (parsed as readonly StoredPeerRecord[]) : [];
		} catch {
			this.#reportPersistenceError("load");
		}
		return Promise.resolve([...this.#memoryRecords]);
	}

	/**
	 * @param records - Bounded authenticated records to persist best-effort.
	 * @returns Completion after persistence succeeds or degrades to memory.
	 */
	save(records: readonly StoredPeerRecord[]): Promise<void> {
		this.#memoryRecords = [...records];
		try {
			const storage = this.#resolveStorage();
			if (records.length === 0) storage.removeItem(this.#key);
			else storage.setItem(this.#key, JSON.stringify(records));
			this.#persistenceDirty = false;
		} catch {
			this.#persistenceDirty = true;
			this.#reportPersistenceError("save");
		}
		return Promise.resolve();
	}

	#reportPersistenceError(operation: PeerCachePersistenceErrorEvent["operation"]): void {
		try {
			this.#onPersistenceError?.({ kind: "peer-cache-persistence", operation, outcome: "failed" });
		} catch {
			// Cache telemetry must not change cache behavior.
		}
	}

	#resolveStorage(): PeerCacheStorage {
		const storage = this.#storage ?? globalThis.localStorage;
		if (storage === undefined) throw new Error("localStorage is unavailable in this runtime");
		return storage;
	}
}

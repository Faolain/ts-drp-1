import { decodeCanonical, hashDomain } from "@ts-drp/canonical";

// Track M, slice 14f: raw observation of native IndexedDB databases in the browser worker,
// through the test's OWN connections (never an owner object). Every row is reduced to a
// stable text form and a digest so the parent can compare states exactly without
// shipping bytes. Observation only.

export type Key = unknown;
export interface RawStore {
	readonly keyPath: string | string[] | null;
	readonly rows: (readonly [Key, unknown])[];
}
export interface RawDump {
	readonly database: string;
	readonly version: number;
	readonly stores: Readonly<Record<string, RawStore>>;
}
export interface DigestStore {
	readonly keyPath: string | string[] | null;
	/** [stable key, row digest], in key order. */
	readonly rows: (readonly [string, string])[];
}
export interface DigestDump {
	readonly database: string;
	readonly version: number;
	readonly stores: Readonly<Record<string, DigestStore>>;
}

const encoder = new TextEncoder();

export function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

/**
 * A deterministic text form of a structured-clone value: sorted object keys, bytes as hex.
 * @param value - Any value IndexedDB stores.
 * @returns Stable text.
 */
export function stable(value: unknown): string {
	return JSON.stringify(jsonable(value));
}

/**
 * A JSON-safe, deterministic form of a structured-clone value.
 * @param value - Any value IndexedDB stores.
 * @returns JSON-safe value.
 */
export function jsonable(value: unknown): unknown {
	if (value === undefined) return { $undef: 1 };
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : { $num: String(value) };
	if (typeof value === "bigint") return { $big: value.toString() };
	if (value instanceof Uint8Array) return { $u8: hex(value) };
	if (value instanceof ArrayBuffer) return { $ab: hex(new Uint8Array(value)) };
	if (ArrayBuffer.isView(value))
		return {
			$view: value.constructor.name,
			hex: hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
		};
	if (value instanceof Date) return { $date: value.toISOString() };
	if (Array.isArray(value)) return value.map(jsonable);
	if (value instanceof Map) return { $map: [...value].map(([key, item]) => [jsonable(key), jsonable(item)]) };
	if (value instanceof Set) return { $set: [...value].map(jsonable) };
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) out[key] = jsonable((value as Record<string, unknown>)[key]);
		return out;
	}
	return { $other: String(value) };
}

/**
 * The digest of one stored row (key and exact structured value), local to this harness.
 * @param key - Exact primary key.
 * @param value - Exact stored value.
 * @returns Lowercase hex digest.
 */
export function rowDigest(key: Key, value: unknown): string {
	return hex(hashDomain("track-m-14f-row/v1", encoder.encode(stable([key, value]))));
}

function request<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.addEventListener("success", () => resolve(r.result), { once: true });
		r.addEventListener("error", () => reject(r.error ?? new Error("TRACK_M_14F_REQUEST")), { once: true });
	});
}

/**
 * Opens an EXISTING database without creating or upgrading it.
 * @param database - Database name.
 * @returns The connection, or null when the database does not exist.
 */
export function openExisting(database: string): Promise<IDBDatabase | null> {
	return new Promise((resolve, reject) => {
		const r = indexedDB.open(database);
		let absent = false;
		r.onupgradeneeded = (event): void => {
			if (event.oldVersion !== 0) return;
			absent = true;
			r.transaction?.abort();
		};
		r.onsuccess = (): void => resolve(r.result);
		r.onerror = (): void => {
			if (absent) resolve(null);
			else reject(r.error ?? new Error("TRACK_M_14F_OPEN"));
		};
		r.onblocked = (): void => undefined;
	});
}

/**
 * Every row of every store of one database, in one readonly transaction.
 * @param database - Database name.
 * @returns The dump, or null when the database does not exist.
 */
export async function rawDump(database: string): Promise<RawDump | null> {
	const db = await openExisting(database);
	if (db === null) return null;
	try {
		const names = [...db.objectStoreNames].sort();
		const stores: Record<string, RawStore> = {};
		if (names.length !== 0) {
			const tx = db.transaction(names, "readonly");
			await Promise.all(
				names.map(async (name) => {
					const store = tx.objectStore(name);
					const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
					stores[name] = {
						keyPath: store.keyPath,
						rows: (keys as Key[]).map((key, index) => [key, (values as unknown[])[index]] as const),
					};
				})
			);
		}
		return { database, version: db.version, stores };
	} finally {
		db.close();
	}
}

export function digestDump(raw: RawDump): DigestDump {
	const stores: Record<string, DigestStore> = {};
	for (const [name, store] of Object.entries(raw.stores))
		stores[name] = {
			keyPath: store.keyPath,
			rows: store.rows.map(([key, value]) => [stable(key), rowDigest(key, value)]),
		};
	return { database: raw.database, version: raw.version, stores };
}

export function counts(raw: RawDump | null): Record<string, number> {
	const out: Record<string, number> = {};
	if (raw === null) return out;
	for (const [name, store] of Object.entries(raw.stores)) out[name] = store.rows.length;
	return out;
}

/** Extracts an in-line key from a value by key path (string, dotted, or array). */
export function keyFromPath(keyPath: string | string[], value: unknown): Key {
	const one = (path: string): unknown => {
		if (path === "") return value;
		let current: unknown = value;
		for (const part of path.split(".")) current = (current as Record<string, unknown> | undefined)?.[part];
		return current;
	};
	return Array.isArray(keyPath) ? keyPath.map(one) : one(keyPath);
}

/**
 * Decodes canonical bytes found inside a stored value, recursively and bounded, so a
 * control's labels can be read. Bytes that do not decode stay as bytes.
 * @param value - Stored value.
 * @param depth - Remaining depth.
 * @returns The value with canonical byte fields decoded.
 */
export function deepDecode(value: unknown, depth = 6): unknown {
	if (depth <= 0) return value;
	if (value instanceof Uint8Array) {
		if (value.byteLength < 2) return value;
		try {
			const decoded = decodeCanonical(value);
			if (decoded !== null && typeof decoded === "object") return { $canonical: deepDecode(decoded, depth - 1) };
		} catch {
			/* Not canonical bytes. */
		}
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => deepDecode(item, depth - 1));
	if (value !== null && typeof value === "object" && !(value instanceof Date)) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = deepDecode(item, depth - 1);
		return out;
	}
	return value;
}

/** The first `completed` object found in a decoded control (its labels), or null. */
export function completedLabels(
	decoded: unknown
): Readonly<{ decisionDigest?: unknown; throughEpoch?: unknown; sourceProofDigest?: unknown }> | null {
	const seen: unknown[] = [decoded];
	while (seen.length !== 0) {
		const item = seen.shift();
		if (item === null || typeof item !== "object") continue;
		if (Array.isArray(item)) {
			seen.push(...item);
			continue;
		}
		const record = item as Record<string, unknown>;
		const completed = record.completed;
		if (completed !== null && typeof completed === "object" && !Array.isArray(completed)) {
			const labels = completed as Record<string, unknown>;
			if ("decisionDigest" in labels || "throughEpoch" in labels)
				return {
					decisionDigest: labels.decisionDigest,
					throughEpoch: labels.throughEpoch,
					sourceProofDigest: labels.sourceProofDigest,
				};
		}
		seen.push(...Object.values(record));
	}
	return null;
}

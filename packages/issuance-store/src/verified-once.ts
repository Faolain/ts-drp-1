/**
 * Verify-once memos for durable canonical records.
 *
 * A durable record is re-verified on every read: decode, rebuild, re-encode, compare.
 * The verification is a pure function of the record's exact bytes, so a result
 * computed once for some bytes is the result for every byte-identical input. These
 * memos are keyed by those exact bytes (or the exact stored string), never by an
 * address, revision or object identity. A write, rollback, reopen or another
 * connection's write changes what is read, so a different key is looked up: an old
 * entry can only ever be returned for byte-identical input, where it is still the
 * correct answer. Nothing needs invalidating for soundness; bounds only cap memory.
 *
 * The key is a private copy and values never escape: callers detach a fresh result
 * on every hit, so no caller can mutate the shared verified state.
 */

/** Work counts for one memo: full verifications run and verified results reused. */
export interface IssuanceVerifiedOnceCounts {
	readonly verifications: number;
	readonly hits: number;
}

interface BytesEntry<V> {
	readonly hash: number;
	readonly key: Uint8Array;
	readonly value: V;
}

/**
 * Compares two byte strings by value with a tight loop (no per-byte closure).
 * @param left - First byte string.
 * @param right - Second byte string.
 * @returns Whether both byte strings are equal.
 */
export function issuanceExactBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	const length = left.length;
	if (length !== right.length) return false;
	for (let index = 0; index < length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function fnv1a(bytes: Uint8Array): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < bytes.length; index++) {
		hash = Math.imul(hash ^ (bytes[index] as number), 0x01000193);
	}
	return hash >>> 0;
}

/** Bounded LRU from exact bytes to the verified result for those bytes. */
export class IssuanceVerifiedOnceBytes<V> {
	readonly #maxEntries: number;
	readonly #maxBytes: number;
	#entries: BytesEntry<V>[] = [];
	#bytes = 0;
	#verifications = 0;
	#hits = 0;

	/**
	 * @param limits - Entry count and total key-byte bounds.
	 */
	constructor(limits: Readonly<{ maxEntries: number; maxBytes: number }>) {
		this.#maxEntries = limits.maxEntries;
		this.#maxBytes = limits.maxBytes;
	}

	/**
	 * Returns the verified result for exactly `key`, verifying at most once per bytes.
	 * A throwing verification is never memoized; it throws again on the next read.
	 * @param key - Exact record bytes. The memo keeps its own copy.
	 * @param verify - Full verification of exactly these bytes.
	 * @returns The memoized value, which the caller must not let escape.
	 */
	verify(key: Uint8Array, verify: () => V): V {
		const hash = fnv1a(key);
		const entries = this.#entries;
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index] as BytesEntry<V>;
			if (entry.hash === hash && issuanceExactBytesEqual(entry.key, key)) {
				if (index !== 0) {
					entries.splice(index, 1);
					entries.unshift(entry);
				}
				this.#hits++;
				return entry.value;
			}
		}
		this.#verifications++;
		const value = verify();
		if (key.byteLength <= this.#maxBytes) {
			entries.unshift({ hash, key: new Uint8Array(key), value });
			this.#bytes += key.byteLength;
			while (entries.length > this.#maxEntries || this.#bytes > this.#maxBytes) {
				this.#bytes -= (entries.pop() as BytesEntry<V>).key.byteLength;
			}
		}
		return value;
	}

	/** @returns Work counts since construction or the last clear. */
	counts(): IssuanceVerifiedOnceCounts {
		return { verifications: this.#verifications, hits: this.#hits };
	}

	/** Drops every entry and resets the counts. Never needed for soundness. */
	clear(): void {
		this.#entries = [];
		this.#bytes = 0;
		this.#verifications = 0;
		this.#hits = 0;
	}
}

/** Bounded LRU from an exact stored string to the verified result for that string. */
export class IssuanceVerifiedOnceText<V> {
	readonly #maxEntries: number;
	readonly #maxChars: number;
	readonly #entries = new Map<string, V>();
	#chars = 0;
	#verifications = 0;
	#hits = 0;

	/**
	 * @param limits - Entry count and total key-length bounds.
	 */
	constructor(limits: Readonly<{ maxEntries: number; maxChars: number }>) {
		this.#maxEntries = limits.maxEntries;
		this.#maxChars = limits.maxChars;
	}

	/**
	 * Returns the verified result for exactly `key`, verifying at most once per string.
	 * A throwing or `undefined` verification is never memoized.
	 * @param key - Exact stored text, including every field the verification reads.
	 * @param verify - Full verification of exactly this text.
	 * @returns The memoized value, which the caller must not let escape.
	 */
	verify<R extends V | undefined>(key: string, verify: () => R): V | R {
		const entries = this.#entries;
		const cached = entries.get(key);
		if (cached !== undefined) {
			entries.delete(key);
			entries.set(key, cached);
			this.#hits++;
			return cached;
		}
		this.#verifications++;
		const value = verify();
		if (value !== undefined && key.length <= this.#maxChars) {
			entries.set(key, value as V);
			this.#chars += key.length;
			while (entries.size > this.#maxEntries || this.#chars > this.#maxChars) {
				const oldest = entries.keys().next().value as string;
				entries.delete(oldest);
				this.#chars -= oldest.length;
			}
		}
		return value;
	}

	/** @returns Work counts since construction or the last clear. */
	counts(): IssuanceVerifiedOnceCounts {
		return { verifications: this.#verifications, hits: this.#hits };
	}

	/** Drops every entry and resets the counts. Never needed for soundness. */
	clear(): void {
		this.#entries.clear();
		this.#chars = 0;
		this.#verifications = 0;
		this.#hits = 0;
	}
}

/**
 * Deeply detaches a verified plain value: fresh arrays, plain objects and byte strings,
 * same own-key order, same values. Frozen leaves of primitives are copied too.
 * @param value - A verified value built only from plain objects, arrays, Uint8Array and primitives.
 * @returns A deep copy no other caller holds.
 */
export function detachIssuanceVerifiedValue<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	if (value instanceof Uint8Array) return new Uint8Array(value) as T;
	if (Array.isArray(value)) return value.map((item: unknown) => detachIssuanceVerifiedValue(item)) as T;
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(value))
		copy[key] = detachIssuanceVerifiedValue((value as Record<string, unknown>)[key]);
	return copy as T;
}

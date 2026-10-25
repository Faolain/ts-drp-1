/**
 * Verify-once memo for pure functions of exact byte strings.
 *
 * A hit is returned ONLY for input byte-identical to bytes that were verified
 * earlier: the bucket fingerprint is a cheap discriminator, never an identity,
 * and every hit re-compares the complete private copy against the input. The
 * memo therefore depends on no storage revision at all: a write, rollback,
 * reopen, another connection's write or a poisoned row that changes the bytes
 * is a miss by construction, and unchanged bytes still verify identically.
 *
 * Callers memoize only deterministic results of the bytes themselves (decode
 * plus canonical re-encode, a content digest). State checks (closed, poisoned,
 * session, currency) are never memoized and stay on every call.
 *
 * Inputs to get/set must be genuine non-shared Uint8Array values the caller
 * owns for the duration of the call: a detached copy, or a fresh native read
 * carrier. set() always retains its own private copy, so no later mutation of
 * an input can reach a retained comparison basis.
 */
export class ExactBytesMemo<V> {
	readonly #maxEntries: number;
	readonly #maxBytes: number;
	readonly #maxEntryBytes: number;
	// Map insertion order is the eviction order; a hit refreshes its bucket.
	readonly #buckets = new Map<string, Array<Readonly<{ bytes: Uint8Array; value: V }>>>();
	#entries = 0;
	#bytes = 0;

	/**
	 * @param maxEntries - Hard bound on retained entries.
	 * @param maxBytes - Hard bound on retained private byte copies.
	 * @param maxEntryBytes - Larger inputs are never retained.
	 */
	public constructor(maxEntries: number, maxBytes: number, maxEntryBytes: number) {
		this.#maxEntries = maxEntries;
		this.#maxBytes = maxBytes;
		this.#maxEntryBytes = maxEntryBytes;
	}

	/**
	 * @param bytes - Exact input.
	 * @returns The value remembered for byte-identical input, or undefined.
	 */
	public get(bytes: Uint8Array): V | undefined {
		if (bytes.byteLength > this.#maxEntryBytes) return undefined;
		const key = fingerprint(bytes),
			bucket = this.#buckets.get(key);
		if (bucket === undefined) return undefined;
		for (const entry of bucket)
			if (sameBytes(entry.bytes, bytes)) {
				this.#buckets.delete(key);
				this.#buckets.set(key, bucket);
				return entry.value;
			}
		return undefined;
	}

	/**
	 * Remembers a verified value under a PRIVATE copy of its exact input.
	 * @param bytes - Exact input that produced `value`.
	 * @param value - Immutable verification result of exactly those bytes.
	 */
	public set(bytes: Uint8Array, value: V): void {
		const length = bytes.byteLength;
		if (length > this.#maxEntryBytes || length > this.#maxBytes) return;
		const key = fingerprint(bytes);
		let bucket = this.#buckets.get(key);
		if (bucket !== undefined) {
			if (bucket.some((entry) => sameBytes(entry.bytes, bytes))) return;
			this.#buckets.delete(key);
		} else bucket = [];
		if (bucket.length >= BUCKET_ENTRIES) {
			const dropped = bucket.shift()!;
			this.#entries--;
			this.#bytes -= dropped.bytes.byteLength;
		}
		bucket.push(Object.freeze({ bytes: new Uint8Array(bytes), value }));
		this.#buckets.set(key, bucket);
		this.#entries++;
		this.#bytes += length;
		while (this.#entries > this.#maxEntries || this.#bytes > this.#maxBytes) {
			const [oldestKey, oldest] = this.#buckets.entries().next().value!;
			const dropped = oldest.shift()!;
			this.#entries--;
			this.#bytes -= dropped.bytes.byteLength;
			if (oldest.length === 0) this.#buckets.delete(oldestKey);
		}
	}

	/** Drops every retained copy. */
	public clear(): void {
		this.#buckets.clear();
		this.#entries = 0;
		this.#bytes = 0;
	}

	/** @returns Retained entry and byte counts, for bound tests. */
	public size(): Readonly<{ entries: number; bytes: number }> {
		return { entries: this.#entries, bytes: this.#bytes };
	}
}

const BUCKET_ENTRIES = 4,
	EDGE = 32,
	SAMPLES = 64;

// Bucket discriminator only. Length, both edges and evenly spaced interior
// samples; equality of the WHOLE input is decided by sameBytes on every hit.
function fingerprint(bytes: Uint8Array): string {
	const length = bytes.byteLength;
	let h1 = 0x811c9dc5 ^ length,
		h2 = 0x01000193 ^ Math.imul(length, 0x9e3779b1);
	const mix = (index: number): void => {
		const byte = bytes[index]!;
		h1 = Math.imul(h1 ^ byte, 0x01000193);
		h2 = Math.imul(h2 ^ (byte + index), 0x85ebca6b) ^ (h2 >>> 13);
	};
	if (length <= 2 * EDGE + SAMPLES) for (let index = 0; index < length; index++) mix(index);
	else {
		for (let index = 0; index < EDGE; index++) mix(index);
		for (let index = length - EDGE; index < length; index++) mix(index);
		const stride = Math.floor((length - 2 * EDGE) / SAMPLES);
		for (let index = EDGE, count = 0; count < SAMPLES; count++, index += stride) mix(index);
	}
	return `${length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/**
 * Exact byte equality of two non-shared views.
 * @param left - Input.
 * @param right - Input.
 * @returns Whether every byte is equal.
 */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	const length = left.byteLength;
	if (length !== right.byteLength) return false;
	let index = 0;
	if ((left.byteOffset & 3) === 0 && (right.byteOffset & 3) === 0 && length >= 64) {
		const words = length >>> 2,
			a = new Uint32Array(left.buffer, left.byteOffset, words),
			b = new Uint32Array(right.buffer, right.byteOffset, words);
		for (let word = 0; word < words; word++) if (a[word] !== b[word]) return false;
		index = words << 2;
	}
	for (; index < length; index++) if (left[index] !== right[index]) return false;
	return true;
}

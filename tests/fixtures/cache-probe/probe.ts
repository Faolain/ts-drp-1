// Track Y measurement only: a probe for the library's five in-memory caches (the canonical hash memo, the
// transition memo, the trust-record verdicts, the ed25519 verify memo and the closure digests).
//
// It exists only in bundles built with the cache-probe plugin (./plugin.ts, behind an explicit build flag): the
// plugin rewrites each cache's `new Map()` into `probeCache(name, new Map())` in the bundle, never in the source.
// Shipped builds and default test bundles never import this module, so the library carries no hook and no cost.
//
// The probe returns a Map with the same behaviour. It infers each cache's own semantics from the call pattern
// (all five caches run synchronously: get, then touch or insert, then evict):
// - hit: `get` finds an entry, and either the cache returns it directly (the FIFO caches) or re-inserts the
//   same entry object (the LRU caches' touch: `delete`, then `set` of the same value);
// - miss: `get` finds nothing, or (LRU caches) finds an entry whose bytes differ, which the cache then replaces
//   or leaves (a refused recomputation is never inserted);
// - insert: `set` of a new entry; evict: `delete` of a key that is not being touched or replaced.
// Events are packed into an Int32Array and flushed, base64-encoded, to `globalThis.__cacheProbeSink` (a test
// harness binding) when the harness asks.

export type CacheName = "hashMemo" | "transitionMemo" | "trustRecordVerdicts" | "ed25519Memo" | "closureDigests";
const NAMES: ReadonlySet<string> = new Set([
	"hashMemo",
	"transitionMemo",
	"trustRecordVerdicts",
	"ed25519Memo",
	"closureDigests",
]);
const LRU: ReadonlySet<string> = new Set(["hashMemo", "transitionMemo"]);

/**
 * Event operations. Each event is 4 int32: [map | op << 8 | phase << 16, key id, a, b].
 * - hit: a = epoch, b = 0;
 * - miss: a = epoch, b = 0 when absent, 1 when present with different bytes;
 * - insert: a = epoch, b = entry size (the cache's own unit plus key characters);
 * - evict: a = epoch, b = entry size;
 * - key (first sight of a key): a = key characters, b = the epoch the key names (transition memo) or -1;
 * - domain (hash memo key): a = hash domain id, b = 0;
 * - cost (just before the insert that follows a miss of the same key): a = microseconds from the missing `get`
 *   to that insert (the cache's own recomputation, plus its copies), b = 0.
 */
export const OP = { hit: 1, miss: 2, insert: 3, evict: 4, key: 5, domain: 6, cost: 7 } as const;

export interface CacheProbeContext {
	readonly phase?: string;
	readonly epoch: number;
	readonly role: string;
}

let contextOf: () => CacheProbeContext = () => ({ epoch: -1, role: "unset" });
const activePhases: string[] = [];
const phaseIds = new Map<string, number>();
const domainIds = new Map<string, number>();
const instance = Math.random().toString(36).slice(2, 10);
let flushes = 0;
// Residency-only bundles (cacheProbePlugin({ residencyOnly: true })) record no events and keep no key table, so
// the probe's own memory stays bounded by the caches' entries in endurance runs; flushes carry residency only.
let residencyOnly = false;

let events = new Int32Array(1 << 16);
let used = 0;
function emit(map: number, op: number, key: number, a: number, b: number): void {
	if (residencyOnly) return;
	if (used + 4 > events.length) {
		const grown = new Int32Array(events.length * 2);
		grown.set(events);
		events = grown;
	}
	events[used++] = map | (op << 8) | (currentPhase() << 16);
	events[used++] = key;
	events[used++] = a;
	events[used++] = b;
}

function idOf(table: Map<string, number>, name: string): number {
	let id = table.get(name);
	if (id === undefined) {
		id = table.size;
		table.set(name, id);
	}
	return id;
}

function context(): CacheProbeContext {
	try {
		return contextOf();
	} catch {
		return { epoch: -1, role: "unset" };
	}
}

function currentPhase(): number {
	return idOf(phaseIds, activePhases.at(-1) ?? "background");
}

function currentEpoch(): number {
	const epoch = context().epoch;
	return Number.isSafeInteger(epoch) ? epoch : -1;
}

/** Size of one entry in the cache's own accounting unit, plus its key's characters. */
function entrySize(name: string, key: string, value: unknown): number {
	const record = value as { bytes?: unknown; retained?: unknown } | undefined;
	if (name === "hashMemo" && typeof record?.bytes === "number") return record.bytes + 32 + key.length;
	if (name === "transitionMemo" && typeof record?.retained === "number") return record.retained + key.length;
	if (name === "closureDigests") return key.length + 64;
	return key.length;
}

/** The epoch an entry is about, read from its key: the transition memo's current trust epoch. */
function keyEpoch(name: string, key: string): number {
	if (name !== "transitionMemo") return -1;
	const match = /\|T\["[0-9a-f]*",(\d+),/u.exec(key);
	return match === null ? -1 : Number(match[1]);
}

const maps: { name: string; ordinal: number; map: ProbedMap }[] = [];

class ProbedMap extends Map<string, unknown> {
	readonly #name: string;
	readonly #index: number;
	readonly #lru: boolean;
	readonly #keys = new Map<string, number>();
	readonly #sizes = new Map<string, number>();
	#bytes = 0;
	#pending: { key: string; value: unknown } | undefined;
	#lastGet: { key: string; at: number } | undefined;

	constructor(name: string, index: number) {
		super();
		this.#name = name;
		this.#index = index;
		this.#lru = LRU.has(name);
	}

	#id(key: string): number {
		if (residencyOnly) return 0;
		let id = this.#keys.get(key);
		if (id === undefined) {
			id = this.#keys.size;
			this.#keys.set(key, id);
			emit(this.#index, OP.key, id, key.length, keyEpoch(this.#name, key));
			if (this.#name === "hashMemo")
				emit(this.#index, OP.domain, id, idOf(domainIds, key.slice(0, Math.max(0, key.indexOf("\u0000")))), 0);
		}
		return id;
	}

	/** An LRU get that found an entry that was neither touched nor replaced: its bytes differed. */
	#settle(): void {
		const pending = this.#pending;
		if (pending === undefined) return;
		this.#pending = undefined;
		emit(this.#index, OP.miss, this.#id(pending.key), currentEpoch(), 1);
	}

	override get(key: string): unknown {
		this.#settle();
		const value = super.get(key);
		this.#lastGet = { key, at: performance.now() };
		if (value === undefined) emit(this.#index, OP.miss, this.#id(key), currentEpoch(), 0);
		else if (this.#lru) this.#pending = { key, value };
		else emit(this.#index, OP.hit, this.#id(key), currentEpoch(), 0);
		return value;
	}

	override set(key: string, value: unknown): this {
		const pending = this.#pending;
		if (pending !== undefined && pending.key === key) {
			this.#pending = undefined;
			if (pending.value === value) {
				emit(this.#index, OP.hit, this.#id(key), currentEpoch(), 0);
				return super.set(key, value);
			}
			emit(this.#index, OP.miss, this.#id(key), currentEpoch(), 1);
		} else this.#settle();
		const lastGet = this.#lastGet;
		this.#lastGet = undefined;
		if (lastGet !== undefined && lastGet.key === key)
			emit(this.#index, OP.cost, this.#id(key), Math.round((performance.now() - lastGet.at) * 1000), 0);
		const size = entrySize(this.#name, key, value);
		const previous = this.#sizes.get(key);
		if (previous !== undefined) this.#bytes -= previous;
		this.#sizes.set(key, size);
		this.#bytes += size;
		emit(this.#index, OP.insert, this.#id(key), currentEpoch(), size);
		return super.set(key, value);
	}

	override delete(key: string): boolean {
		const pending = this.#pending;
		// The first half of an LRU touch or replacement: the following set decides.
		if (pending !== undefined && pending.key === key) return super.delete(key);
		this.#settle();
		const existed = super.delete(key);
		if (existed) {
			const size = this.#sizes.get(key) ?? 0;
			this.#sizes.delete(key);
			this.#bytes -= size;
			emit(this.#index, OP.evict, this.#id(key), currentEpoch(), size);
		}
		return existed;
	}

	override clear(): void {
		this.#settle();
		for (const key of [...super.keys()]) this.delete(key);
	}

	residency(): Readonly<Record<string, unknown>> {
		this.#settle();
		let keyCharacters = 0;
		const epochs: Record<string, number> = {};
		for (const key of super.keys()) {
			keyCharacters += key.length;
			const epoch = keyEpoch(this.#name, key);
			if (epoch >= 0) epochs[epoch] = (epochs[epoch] ?? 0) + 1;
		}
		return {
			entries: this.size,
			size: this.#bytes,
			keyCharacters,
			distinctKeys: this.#keys.size,
			...(this.#name === "transitionMemo" ? { entryEpochs: epochs } : {}),
		};
	}
}

/**
 * Called by the bundle-only rewrite of each cache's declaration.
 * @param name - Which cache.
 * @param original - The cache's own new, empty Map (replaced by the probed one).
 * @param mode - "residency" in residency-only bundles: no events, no key table.
 * @returns A Map with the same behaviour that records the cache's events.
 */
export function probeCache<Key, Value>(
	name: CacheName,
	original: Map<Key, Value>,
	mode?: "residency"
): Map<Key, Value> {
	if (original.size !== 0 || !NAMES.has(name) || maps.length >= 255) throw new TypeError("CACHE_PROBE_SITE_INVALID");
	if (mode === "residency") residencyOnly = true;
	const map = new ProbedMap(name, maps.length);
	maps.push({ name, ordinal: maps.filter((row) => row.name === name).length, map });
	return map as unknown as Map<Key, Value>;
}

function base64(bytes: Uint8Array): string {
	let text = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		text += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000) as unknown as number[]);
	return btoa(text);
}

/** The harness side of the probe, published as `globalThis.__cacheProbe` (only in probe bundles). */
export interface CacheProbe {
	/** Where epoch and role come from. */
	setContext(provider: () => CacheProbeContext): void;
	/** A measured call starts (called outside its timer). */
	enter(phase: string): void;
	/** That call ended. */
	exit(phase: string): void;
	/** Sends the events since the last flush and each cache's residency to `__cacheProbeSink`. */
	flush(label: string): Promise<unknown>;
}

const probe: CacheProbe = Object.freeze({
	setContext(provider: () => CacheProbeContext): void {
		contextOf = provider;
	},
	enter(phase: string): void {
		activePhases.push(phase);
	},
	exit(phase: string): void {
		const index = activePhases.lastIndexOf(phase);
		if (index >= 0) activePhases.splice(index, 1);
	},
	flush(label: string): Promise<unknown> {
		const residency = maps.map((row) => ({ name: row.name, ordinal: row.ordinal, ...row.map.residency() }));
		const sink = Reflect.get(globalThis, "__cacheProbeSink") as ((line: string) => Promise<unknown>) | undefined;
		const now = context();
		const payload = events.subarray(0, used);
		const line = JSON.stringify({
			kind: "cache-probe",
			...(residencyOnly ? { mode: "residency" } : {}),
			instance,
			flush: flushes++,
			label,
			role: now.role,
			epoch: now.epoch,
			at: performance.now(),
			phases: [...phaseIds.keys()],
			domains: [...domainIds.keys()],
			caches: residency,
			events: base64(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)),
		});
		used = 0;
		return sink === undefined ? Promise.resolve(undefined) : sink(line);
	},
});

Reflect.set(globalThis, "__cacheProbe", probe);

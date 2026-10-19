import { describe, expect, it } from "vitest";

import * as current from "../src/internal/codec.js";
import * as reference from "./reference/codec-v1.js";

/** Deterministic PRNG so every failure is reproducible from its seed. */
function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

const STRINGS = ["", "a", "kind", "epoch", "objectId", "peer-B", "peer-a", "Peer-a", "peerä", "peer-😀", "﻿bom",
	"x".repeat(127), "y".repeat(128), "z".repeat(300), "é".repeat(40), "日本語テキスト", "\u0000", "__proto__", "\ud800", "a\udc00"];

function randomValue(next: () => number, depth: number): unknown {
	const pick = Math.floor(next() * (depth > 4 ? 9 : 16));
	switch (pick) {
		case 0: return null;
		case 1: return next() < 0.5;
		case 2: return Math.floor((next() - 0.5) * 2 ** Math.floor(next() * 54));
		case 3: return [0, -0, 1, -1, 63, 64, -64, -65, 2 ** 31, -(2 ** 31), 2 ** 52, -(2 ** 52), -(2 ** 52) - 1,
			Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 53, NaN, Infinity][Math.floor(next() * 18)];
		case 4: return (next() - 0.5) * 1e6;
		case 5: return STRINGS[Math.floor(next() * STRINGS.length)];
		case 6: return Uint8Array.from({ length: Math.floor(next() * 200) }, () => Math.floor(next() * 256));
		case 7: return String.fromCharCode(...Array.from({ length: Math.floor(next() * 12) }, () => Math.floor(next() * 0x10000)));
		case 8: return next() < 0.1 ? undefined : "s" + Math.floor(next() * 1000);
		case 9: return Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth + 1));
		case 10:
		case 11: {
			const object: Record<string, unknown> = next() < 0.2 ? Object.create(null) : {};
			const count = Math.floor(next() * 6);
			for (let index = 0; index < count; index++) object[STRINGS[Math.floor(next() * 12)]! + (next() < 0.3 ? index : "")] = randomValue(next, depth + 1);
			return object;
		}
		case 12: return new Map(Array.from({ length: Math.floor(next() * 4) }, () => [randomValue(next, depth + 2), randomValue(next, depth + 1)]));
		case 13: return new Set(Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, depth + 2)));
		case 14: return [Float32Array.of(next(), -0, 1.5), Float64Array.of(next() * 1e9, -0), Int32Array.of(-5, 7), Uint32Array.of(0xffffffff, 3),
			Float32Array.of(NaN)][Math.floor(next() * 5)];
		default: return next() < 0.5 ? new Date(0) : [randomValue(next, depth + 1)];
	}
}

function outcome(action: () => unknown): unknown {
	try {
		return { ok: action() };
	} catch (error) {
		const name = error instanceof current.CanonicalDecodingError || error instanceof reference.CanonicalDecodingError
			? "decode" : error instanceof current.CanonicalEncodingError || error instanceof reference.CanonicalEncodingError
				? "encode" : (error as Error).constructor.name;
		return { error: name, message: (error as Error).message, limit: (error as { resourceLimit?: string }).resourceLimit };
	}
}

const LIMITS = [{}, { maxDepth: 2 }, { maxItems: 3 }, { maxBytes: 40 }, { maxDepth: 0 }, { maxBytes: 2 }];

describe("fast codec is byte- and error-identical to the frozen v1 codec", () => {
	it("encodes random canonical-domain and invalid values identically", () => {
		for (let seed = 1; seed <= 4000; seed++) {
			const next = rng(seed);
			const value = randomValue(next, 0);
			const limits = LIMITS[seed % LIMITS.length]!;
			expect(outcome(() => current.encodeCanonical(value, limits)), `seed ${seed}`)
				.toEqual(outcome(() => reference.encodeCanonical(value, limits)));
		}
	});

	it("decodes valid, mutated, truncated and extended bytes identically", () => {
		for (let seed = 1; seed <= 4000; seed++) {
			const next = rng(seed * 7919);
			let bytes: Uint8Array;
			try {
				bytes = reference.encodeCanonical(randomValue(next, 0));
			} catch {
				continue;
			}
			const variants = [bytes, bytes.subarray(0, Math.floor(next() * bytes.length)), Uint8Array.of(...bytes, 0)];
			const mutated = bytes.slice();
			for (let flips = 0; flips < 3 && mutated.length; flips++) mutated[Math.floor(next() * mutated.length)] = Math.floor(next() * 256);
			variants.push(mutated);
			for (const [index, variant] of variants.entries()) {
				const limits = LIMITS[(seed + index) % LIMITS.length]!;
				expect(outcome(() => current.decodeCanonical(variant, limits)), `seed ${seed} variant ${index}`)
					.toEqual(outcome(() => reference.decodeCanonical(variant, limits)));
			}
		}
	});

	it("matches varuint, integer, UTF-8 and BOM edge encodings", () => {
		const cases = ["0380808080808080808001", "03ffffffffffffffff7f", "03feffffffffffff3f", "03ffffffffffffff3f",
			"03808001", "038000", "0503efbbbf", "0506efbbbfefbbbf", "0502efbb", "0503eda080", "0504f4908080", "0502c0af",
			"0581" + "61".repeat(129), "07028000", "0b0180000000", "0c017ff0000000000000", "0d02fffffffe00000001",
			"0902050161030005016103", "08020501620300050161030a", "0a020301030100"];
		for (const hex of cases) {
			const bytes = Uint8Array.from(hex.match(/../gu)!, (byte) => Number.parseInt(byte, 16));
			expect(outcome(() => current.decodeCanonical(bytes)), hex).toEqual(outcome(() => reference.decodeCanonical(bytes)));
		}
		for (const value of [2 ** 52, -(2 ** 52), -(2 ** 52) - 1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 31 - 1, -(2 ** 31)])
			expect(current.encodeCanonical(value)).toEqual(reference.encodeCanonical(value));
	});

	it("hashes framed parts identically and reuses writers across reentrant encodes", () => {
		const parts = [Uint8Array.of(), Uint8Array.of(1, 2, 3), new Uint8Array(5000).fill(7)];
		expect(current.hashDomain("ts-drp/test/v1", ...parts)).toEqual(reference.hashDomain("ts-drp/test/v1", ...parts));
		expect(current.hashDomain("ts-drp/test/v1")).toEqual(reference.hashDomain("ts-drp/test/v1"));
		const inner = { a: 1 };
		const reentrant = new Proxy(inner, {
			ownKeys(target) {
				expect(current.encodeCanonical({ nested: "x".repeat(2000) })).toEqual(reference.encodeCanonical({ nested: "x".repeat(2000) }));
				return Reflect.ownKeys(target);
			},
		});
		expect(current.encodeCanonical([reentrant, "tail"])).toEqual(reference.encodeCanonical([{ a: 1 }, "tail"]));
	});
});

describe("fast codec observes caller views like the frozen v1 codec", () => {
	function observed(codec: typeof current | typeof reference, make: () => ArrayBufferView): unknown {
		const log: string[] = [];
		const view = make();
		for (const property of ["byteLength", "length"])
			Object.defineProperty(view, property, { configurable: true, get() { log.push(property); return 2; } });
		return { result: outcome(() => codec.encodeCanonical({ view })), log };
	}
	it("reads own length/byteLength accessors the same number of times and in the same order", () => {
		for (const make of [() => Uint8Array.of(1, 2, 3), () => Float32Array.of(1, -0, 2), () => Float64Array.of(1.5, 2, 3),
			() => Int32Array.of(-1, 2, 3), () => Uint32Array.of(1, 2, 3)])
			expect(observed(current, make)).toEqual(observed(reference, make));
	});
});

describe("hashDomain exact-input memo", () => {
	it("returns the frozen digest for repeated, mutated, sliced and exotic inputs", () => {
		const next = rng(4242);
		const blobs = Array.from({ length: 12 }, (_, index) => Uint8Array.from({ length: 900 + index * 700 }, () => Math.floor(next() * 256)));
		for (let round = 0; round < 3; round++)
			for (const blob of blobs) {
				expect(current.hashDomain("ts-drp-storage/blob/v1", blob)).toEqual(reference.hashDomain("ts-drp-storage/blob/v1", blob));
				expect(current.hashDomain("ts-drp/other/v1", Uint8Array.of(1), blob)).toEqual(reference.hashDomain("ts-drp/other/v1", Uint8Array.of(1), blob));
			}
		// Mutation after hashing must never return the stale digest: every
		// sampled and unsampled position, including the last byte.
		const target = blobs[5]!.slice();
		const before = current.hashDomain("ts-drp-storage/blob/v1", target);
		for (const position of [0, 1, 2, 3, 37, target.length >> 1, target.length - 2, target.length - 1]) {
			target[position] = (target[position]! + 1) & 0xff;
			const digest = current.hashDomain("ts-drp-storage/blob/v1", target);
			expect(digest).toEqual(reference.hashDomain("ts-drp-storage/blob/v1", target));
			expect(digest).not.toEqual(before);
		}
		// Unaligned subarray views and same-bytes/different-split framing.
		const backing = new Uint8Array(blobs[3]!.length + 3);
		backing.set(blobs[3]!, 3);
		const view = backing.subarray(3);
		expect(current.hashDomain("ts-drp-storage/blob/v1", view)).toEqual(reference.hashDomain("ts-drp-storage/blob/v1", blobs[3]!));
		const whole = blobs[7]!;
		const split = [whole.subarray(0, 1000), whole.subarray(1000)];
		expect(current.hashDomain("ts-drp/split/v1", ...split)).toEqual(reference.hashDomain("ts-drp/split/v1", ...split));
		expect(current.hashDomain("ts-drp/split/v1", whole)).toEqual(reference.hashDomain("ts-drp/split/v1", whole));
		// Returned digests are fresh copies; mutating one cannot poison the memo.
		const first = current.hashDomain("ts-drp-storage/blob/v1", blobs[0]!);
		first.fill(0);
		expect(current.hashDomain("ts-drp-storage/blob/v1", blobs[0]!)).toEqual(reference.hashDomain("ts-drp-storage/blob/v1", blobs[0]!));
		// Instrumented carriers keep the original uncached path and reads.
		const instrumented = blobs[1]!.slice();
		let reads = 0;
		Object.defineProperty(instrumented, "byteLength", { configurable: true, get() { reads++; return blobs[1]!.byteLength; } });
		expect(current.hashDomain("ts-drp-storage/blob/v1", instrumented)).toEqual(reference.hashDomain("ts-drp-storage/blob/v1", blobs[1]!));
		const currentReads = reads;
		reads = 0;
		reference.hashDomain("ts-drp-storage/blob/v1", instrumented);
		expect(currentReads).toBe(reads);
	});
	it("bounds retained bytes by evicting least-recently used entries", () => {
		const large = Array.from({ length: 12 }, (_, index) => new Uint8Array(4 * 1024 * 1024).fill(index + 1));
		for (const blob of large) current.hashDomain("ts-drp-storage/blob/v1", blob);
		for (const blob of large)
			expect(current.hashDomain("ts-drp-storage/blob/v1", blob)).toEqual(reference.hashDomain("ts-drp-storage/blob/v1", blob));
	});
});

describe("compareBytes word-prefix fast path", () => {
	it("orders exactly like the frozen byte loop across alignments and difference positions", () => {
		const next = rng(99);
		for (let trial = 0; trial < 3000; trial++) {
			const length = Math.floor(next() * 300);
			const base = Uint8Array.from({ length }, () => Math.floor(next() * 256));
			const other = base.slice(0, Math.max(0, length - Math.floor(next() * 3)));
			if (other.length && next() < 0.7) other[Math.floor(next() * other.length)] = Math.floor(next() * 256);
			const shift = Math.floor(next() * 4);
			const backing = new Uint8Array(other.length + shift);
			backing.set(other, shift);
			for (const right of [other, backing.subarray(shift)])
				expect(Math.sign(current.compareBytes(base, right)), `trial ${trial}`).toBe(Math.sign(reference.compareBytes(base, right)));
		}
	});
});

describe("decodeCanonicalExactness", () => {
	const roundTrips = (bytes: Uint8Array, limits: object): boolean => {
		try {
			const encoded = reference.encodeCanonical(reference.decodeCanonical(bytes, limits));
			return encoded.length === bytes.length && encoded.every((byte, index) => byte === bytes[index]);
		} catch {
			return false;
		}
	};
	it("decodes identically and is exact only when the frozen re-encode reproduces the input", () => {
		let exactCount = 0;
		const extra = ["﻿lead", "﻿", "x﻿"].map(value => reference.encodeCanonical({ [value]: value }));
		const bigFloat = Uint8Array.of(0x04, 0x43, 0xf0, 0, 0, 0, 0, 0, 0); // FLOAT64 2^64
		for (let seed = 1; seed <= 6000; seed++) {
			const next = rng(seed * 104729);
			let bytes: Uint8Array;
			try {
				bytes = reference.encodeCanonical(randomValue(next, 0));
			} catch {
				continue;
			}
			const variants = [bytes, bytes.subarray(0, Math.floor(next() * bytes.length)), ...extra, bigFloat];
			const mutated = bytes.slice();
			for (let flips = 0; flips < 2 && mutated.length; flips++) mutated[Math.floor(next() * mutated.length)] = Math.floor(next() * 256);
			variants.push(mutated);
			for (const [index, variant] of variants.entries()) {
				const limits = LIMITS[(seed + index) % LIMITS.length]!;
				const decoded = outcome(() => current.decodeCanonicalExactness(variant, limits));
				const expected = outcome(() => reference.decodeCanonical(variant, limits));
				if ("ok" in (decoded as object)) {
					const result = (decoded as { ok: { value: unknown; exact: boolean } }).ok;
					expect({ ok: result.value }, `seed ${seed} variant ${index}`).toEqual(expected);
					if (result.exact) {
						exactCount++;
						expect(roundTrips(variant, limits), `seed ${seed} variant ${index}`).toBe(true);
					}
				} else expect(decoded, `seed ${seed} variant ${index}`).toEqual(expected);
			}
		}
		expect(exactCount).toBeGreaterThan(3000);
		// Leading BOMs are stripped and huge integral floats are refused by the
		// encoder: never exact. An interior BOM survives and stays exact.
		expect([...extra, bigFloat].map(bytes => current.decodeCanonicalExactness(bytes).exact)).toEqual([false, false, true, false]);
		expect([...extra, bigFloat].map(bytes => roundTrips(bytes, {}))).toEqual([false, false, true, false]);
	});
});

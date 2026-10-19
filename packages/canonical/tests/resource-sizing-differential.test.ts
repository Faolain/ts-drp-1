import { describe, expect, it } from "vitest";

import * as reference from "./reference/codec-v1.js";
import * as current from "../src/internal/codec.js";

/**
 * Deterministic PRNG so every failure is reproducible from its seed.
 * @param seed
 */
function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

function outcome(action: () => unknown): unknown {
	try {
		const value = action() as Record<string, unknown>;
		return { ok: value, frozen: Object.isFrozen(value), prototype: Object.getPrototypeOf(value) === Object.prototype };
	} catch (error) {
		const name =
			error instanceof current.CanonicalEncodingError || error instanceof reference.CanonicalEncodingError
				? "encode"
				: error instanceof current.CanonicalDecodingError || error instanceof reference.CanonicalDecodingError
					? "decode"
					: (error as Error).constructor.name;
		return { error: name, message: (error as Error).message };
	}
}

const PRIMITIVES: unknown[] = [
	null,
	true,
	false,
	0,
	-0,
	1,
	-1,
	63,
	64,
	-65,
	2 ** 31,
	2 ** 53,
	Number.MAX_SAFE_INTEGER,
	1.5,
	NaN,
	Infinity,
	"",
	"a",
	"byteLength",
	"x".repeat(127),
	"y".repeat(128),
	"z".repeat(300),
	"é".repeat(40),
	"\ud800",
	"a\udc00",
	"peer-😀",
	undefined,
	BigInt(10),
	Symbol("s"),
	() => 1,
	"f".repeat(64),
];
const LIMITS: unknown[] = [
	undefined,
	{},
	{ maxBytes: 3 },
	{ maxBytes: 40 },
	{ maxItems: 1 },
	{ maxItems: 9 },
	{ maxDepth: 0 },
	{ maxDepth: 1 },
	{ maxBytes: 0 },
	{ maxDepth: -1 },
	{ maxItems: 1.5 },
	{ unknown: 1 },
	Object.create({ maxBytes: 1 }),
	Object.defineProperty({}, "maxBytes", { enumerable: true, get: () => 10 }),
	Object.defineProperty({}, "maxBytes", { value: 2 }),
	{ maxBytes: 10, maxItems: 100, maxDepth: 3 },
	Object.freeze({ maxBytes: 64 }),
];

const pick = <T>(next: () => number, values: readonly T[]): T => values[Math.floor(next() * values.length)]!;

/**
 * Both implementations receive structurally identical but distinct inputs.
 * @param next
 * @param depth
 */
function footprintPair(next: () => number, depth: number): [unknown, unknown] {
	const kind = Math.floor(next() * (depth > 2 ? 5 : 9));
	switch (kind) {
		case 0: {
			const v = pick(next, PRIMITIVES);
			return [v, v];
		}
		case 1: {
			const shape = {
				byteLength: Math.floor(next() * 50),
				items: Math.floor(next() * 5),
				maxDepth: Math.floor(next() * 3),
			};
			return [{ ...shape }, { ...shape }];
		}
		case 2: {
			const shape = { byteLength: 5, items: 1, maxDepth: 0, extra: 1 };
			return [{ ...shape }, { ...shape }];
		}
		case 3: {
			const make = () =>
				Object.defineProperty({ items: 1, maxDepth: 0 }, "byteLength", { enumerable: true, get: () => 3 });
			return [make(), make()];
		}
		case 4: {
			const v = Math.floor(next() * 40);
			return [current.canonicalBytesResourceForSizing(v), reference.canonicalBytesResourceForSizing(v)];
		}
		case 5: {
			const p = pick(next, PRIMITIVES) as string;
			return [
				outcomeValue(() => current.canonicalPrimitiveResourceForSizing(p)),
				outcomeValue(() => reference.canonicalPrimitiveResourceForSizing(p)),
			];
		}
		case 6: {
			const [a, b] = recordPair(next, depth + 1);
			return [
				outcomeValue(() => current.canonicalRecordResourceForSizing(a as never)),
				outcomeValue(() => reference.canonicalRecordResourceForSizing(b as never)),
			];
		}
		case 7: {
			const count = Math.floor(next() * 4),
				[a, b] = footprintPair(next, depth + 1);
			return [
				outcomeValue(() => current.canonicalArrayResourceForSizing(count, a as never)),
				outcomeValue(() => reference.canonicalArrayResourceForSizing(count, b as never)),
			];
		}
		default: {
			const pairs = Array.from({ length: Math.floor(next() * 4) }, () => footprintPair(next, depth + 1));
			return [
				outcomeValue(() => current.canonicalArrayResourcesForSizing(pairs.map((p) => p[0]) as never)),
				outcomeValue(() => reference.canonicalArrayResourcesForSizing(pairs.map((p) => p[1]) as never)),
			];
		}
	}
}
function outcomeValue(action: () => unknown): unknown {
	try {
		return action();
	} catch {
		return { invalid: true };
	}
}
function recordPair(next: () => number, depth: number): [unknown, unknown] {
	const keys = ["a", "kind", "byteLength", "f".repeat(64), "é", "\ud800", "__proto__", "y".repeat(128)];
	const left: Record<string, unknown> = next() < 0.2 ? Object.create(null) : {},
		right: Record<string, unknown> = Object.create(Object.getPrototypeOf(left));
	for (let index = 0, count = Math.floor(next() * 5); index < count; index++) {
		const key = pick(next, keys) + (next() < 0.3 ? index : ""),
			[a, b] = footprintPair(next, depth);
		Object.defineProperty(left, key, { value: a, enumerable: true, configurable: true, writable: true });
		Object.defineProperty(right, key, { value: b, enumerable: true, configurable: true, writable: true });
	}
	return [left, right];
}

describe("resource sizing fast paths", () => {
	it("match the frozen reference results and refusals across random footprints, records and limits", () => {
		// Two rounds: the second runs with every interning cache warm.
		for (const round of [0, 1]) {
			const next = rng(0x5eed),
				checks: unknown[] = [];
			for (let iteration = 0; iteration < 4_000; iteration++) {
				const limits = pick(next, LIMITS) as never,
					operation = Math.floor(next() * 5);
				const args = limits === undefined ? [] : [limits];
				let actual: unknown, expected: unknown;
				if (operation === 0) {
					const value = pick(next, PRIMITIVES) as never;
					actual = outcome(() => current.canonicalPrimitiveResourceForSizing(value, ...args));
					expected = outcome(() => reference.canonicalPrimitiveResourceForSizing(value, ...args));
				} else if (operation === 1) {
					const length = pick(next, [0, 1, 127, 128, 70_000, -1, 1.5, Number.MAX_SAFE_INTEGER]);
					actual = outcome(() => current.canonicalBytesResourceForSizing(length, ...args));
					expected = outcome(() => reference.canonicalBytesResourceForSizing(length, ...args));
				} else if (operation === 2) {
					const [a, b] = recordPair(next, 0);
					actual = outcome(() => current.canonicalRecordResourceForSizing(a as never, ...args));
					expected = outcome(() => reference.canonicalRecordResourceForSizing(b as never, ...args));
				} else if (operation === 3) {
					const count = pick(next, [0, 1, 2, 5, 200, -1, 2.5]),
						[a, b] = footprintPair(next, 0);
					actual = outcome(() => current.canonicalArrayResourceForSizing(count, a as never, ...args));
					expected = outcome(() => reference.canonicalArrayResourceForSizing(count, b as never, ...args));
				} else {
					const pairs = Array.from({ length: Math.floor(next() * 5) }, () => footprintPair(next, 0));
					actual = outcome(() => current.canonicalArrayResourcesForSizing(pairs.map((p) => p[0]) as never, ...args));
					expected = outcome(() =>
						reference.canonicalArrayResourcesForSizing(pairs.map((p) => p[1]) as never, ...args)
					);
				}
				expect(actual, `round ${round} iteration ${iteration}`).toEqual(expected);
				checks.push(actual);
			}
			// The corpus exercises both acceptance and every refusal family.
			expect(checks.some((value) => "ok" in (value as object))).toBe(true);
			expect(
				new Set(
					checks.flatMap((value) => ("message" in (value as object) ? [(value as { message: string }).message] : []))
				).size
			).toBeGreaterThanOrEqual(8);
		}
	});
	it("replays the encoder's exact refusal when an interned width exceeds tighter limits", () => {
		for (const value of ["f".repeat(64), 2 ** 40, "é".repeat(40)]) {
			const wide = current.canonicalPrimitiveResourceForSizing(value);
			expect(wide).toEqual(reference.canonicalPrimitiveResourceForSizing(value));
			for (const maxBytes of [wide.byteLength - 1, wide.byteLength - 3, 1, wide.byteLength]) {
				expect(outcome(() => current.canonicalPrimitiveResourceForSizing(value, { maxBytes }))).toEqual(
					outcome(() => reference.canonicalPrimitiveResourceForSizing(value, { maxBytes }))
				);
				expect(
					outcome(() => current.canonicalRecordResourceForSizing({ [value as string]: value as never }, { maxBytes }))
				).toEqual(
					outcome(() => reference.canonicalRecordResourceForSizing({ [value as string]: value as never }, { maxBytes }))
				);
			}
		}
	});
	it("rechecks a module-produced footprint against every later limit and never aliases it to a caller", () => {
		const child = current.canonicalRecordResourceForSizing({ a: "f".repeat(64), b: 1 });
		const nested = current.canonicalArrayResourceForSizing(3, child);
		expect(nested).not.toBe(child);
		expect(Object.isFrozen(nested)).toBe(true);
		for (const limits of [
			{ maxBytes: child.byteLength - 1 },
			{ maxItems: child.items - 1 },
			{ maxDepth: child.maxDepth - 1 },
			{},
		]) {
			const shape = { byteLength: child.byteLength, items: child.items, maxDepth: child.maxDepth };
			expect(outcome(() => current.canonicalArrayResourcesForSizing([child, child], limits))).toEqual(
				outcome(() => reference.canonicalArrayResourcesForSizing([shape, { ...shape }], limits))
			);
			expect(outcome(() => current.canonicalRecordResourceForSizing({ x: child }, limits))).toEqual(
				outcome(() => reference.canonicalRecordResourceForSizing({ x: shape }, limits))
			);
		}
	});
});

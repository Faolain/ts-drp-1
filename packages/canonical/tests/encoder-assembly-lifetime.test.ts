import {describe, expect, it} from "vitest";
import {CanonicalEncodingError, createCanonicalEncodingCapture, decodeCanonical, encodeCanonical} from "../src/internal/codec.ts";

describe("canonical encoder assembly preserves traversal and leaf lifetimes", () => {
	it("snapshots byte and numeric typed-array leaves before later array getters can mutate them", () => {
		const bytes = Uint8Array.of(7, 9), floats = Float32Array.of(-0, 1.5), doubles = Float64Array.of(-0, 2.5),
			ints = Int32Array.of(-1, 2), uints = Uint32Array.of(1, 0xffff_ffff);
		const value: unknown[] = [bytes, floats, doubles, ints, uints]; let reads = 0;
		Object.defineProperty(value, 5, {enumerable: true, get() {
			reads++; bytes.fill(0); floats.fill(9); doubles.fill(9); ints.fill(9); uints.fill(9); return null;
		}});
		const encoded = encodeCanonical(value), decoded = decodeCanonical(encoded) as unknown[];
		expect(reads).toBe(1);
		expect(decoded).toEqual([Uint8Array.of(7, 9), Float32Array.of(0, 1.5), Float64Array.of(0, 2.5),
			Int32Array.of(-1, 2), Uint32Array.of(1, 0xffff_ffff), null]);
		expect(Object.is((decoded[1] as Float32Array)[0], -0)).toBe(false);
		expect(Object.is((decoded[2] as Float64Array)[0], -0)).toBe(false);
	});

	it("uses Map.entries at the original point and snapshots each key before its value", () => {
		const key = Uint8Array.of(7), events: string[] = [], value = new Proxy({ok: true}, {
			ownKeys(target) {events.push("value-descriptors"); key[0] = 99; return Reflect.ownKeys(target);},
		});
		class EntriesMap extends Map<unknown, unknown> {
			override *entries(): MapIterator<[unknown, unknown]> {
				events.push("entries-start"); yield [key, value]; events.push("entries-end");
			}
			override [Symbol.iterator](): MapIterator<[unknown, unknown]> {throw Error("not the original entries method");}
		}
		// Native size remains0. Preserve its existing item-limit rule rather than
		// tightening it to count values yielded by a custom iterator.
		const result = decodeCanonical(encodeCanonical(new EntriesMap(), {maxItems: 0})) as Map<Uint8Array, unknown>;
		expect([...result.keys()]).toEqual([Uint8Array.of(7)]);
		expect(events).toEqual(["entries-start", "value-descriptors", "value-descriptors", "entries-end"]);
	});

	it("finishes custom Set iteration before encoding items and keeps canonical duplicate detection", () => {
		const item = Uint8Array.of(1), events: string[] = [];
		class IteratedSet extends Set<unknown> {
			override *[Symbol.iterator](): SetIterator<unknown> {
				events.push("yield-first"); yield item; item[0] = 2; events.push("yield-second"); yield {x: 1};
			}
		}
		const result = decodeCanonical(encodeCanonical(new IteratedSet(), {maxItems: 0})) as Set<unknown>;
		expect([...result]).toEqual([Uint8Array.of(2), Object.assign(Object.create(null), {x: 1})]);
		expect(events).toEqual(["yield-first", "yield-second"]);
		expect(() => encodeCanonical(new Set([{x: 1}, {x: 1}]))).toThrow("set contains duplicate canonical values");
		expect(() => encodeCanonical(new Map([[{x: 1}, 1], [{x: 1}, 2]]))).toThrow("map contains duplicate canonical keys");
		// Every value is validated before duplicate-key sorting/refusal.
		expect(() => encodeCanonical(new Map([[{x: 1}, 1], [{x: 1}, undefined]]))).toThrow("undefined is outside the canonical domain");
	});

	it("retains descriptor snapshots, ignores nonenumerable accessors and never invokes object getters", () => {
		let getters = 0, ownKeys = 0, descriptors = 0;
		const target = Object.defineProperty({a: Uint8Array.of(1)}, "hidden", {get() {getters++; return undefined;}}),
			value = new Proxy(target, {ownKeys(object) {ownKeys++; return Reflect.ownKeys(object);},
				getOwnPropertyDescriptor(object, key) {descriptors++; return Reflect.getOwnPropertyDescriptor(object, key);}});
		expect(decodeCanonical(encodeCanonical(value))).toEqual(Object.assign(Object.create(null), {a: Uint8Array.of(1)}));
		expect({getters, ownKeys, descriptors}).toEqual({getters: 0, ownKeys: 2, descriptors: 2});
		Object.defineProperty(target, "bad", {enumerable: true, get() {getters++; return 1;}});
		expect(() => encodeCanonical(value)).toThrow("accessor property bad is outside the canonical domain");
		expect(getters).toBe(0);
	});

	it("preserves byte/depth/item error precedence without adding a cumulative encoder item budget", () => {
		const accessor = Object.defineProperty({}, "bad", {enumerable: true, get() {throw Error("must not execute");}});
		expect(() => encodeCanonical([new Uint8Array(128), accessor], {maxBytes: 1}))
			.toThrow("accessor property bad is outside the canonical domain");
		expect(() => encodeCanonical(["too long", accessor], {maxBytes: 1})).toThrow("string exceeds byte limit");
		expect(() => encodeCanonical([new Uint8Array(128), null], {maxBytes: 1})).toThrow("canonical value exceeds byte limit");
		expect(() => encodeCanonical([[undefined]], {maxDepth: 1})).toThrow("canonical value exceeds maximum nesting depth");
		expect(() => encodeCanonical([[undefined]], {maxItems: 0})).toThrow("array exceeds item limit");
		expect(() => encodeCanonical(new Array(1))).toThrow("sparse arrays are outside the canonical domain");
		const nested = [[null], [null]];
		expect(encodeCanonical(nested, {maxItems: 2})).toEqual(encodeCanonical(nested));
		expect(encodeCanonical(new Uint32Array(8), {maxItems: 0})).toEqual(encodeCanonical(new Uint32Array(8)));
	});

	it("retains active-cycle detection and permits repeated noncyclic aliases after refusal", () => {
		const cyclic: unknown[] = []; cyclic.push(cyclic);
		expect(() => encodeCanonical(cyclic)).toThrow(CanonicalEncodingError);
		const shared = {bytes: Uint8Array.of(4, 5)}, repeated = [shared, shared];
		expect(encodeCanonical(repeated)).toEqual(encodeCanonical([{bytes: Uint8Array.of(4, 5)}, {bytes: Uint8Array.of(4, 5)}]));
		const map = new Map(); map.set(map, null);
		expect(() => encodeCanonical(map)).toThrow("cyclic values are outside the canonical domain");
		expect(encodeCanonical(repeated)).toEqual(encodeCanonical(repeated));
	});
});

describe("invocation-local canonical encoding capture", () => {
	const limits = {maxBytes: 4096, maxItems: 128, maxDepth: 16};
	it("reuses one original traversal for charge, frame and complete image without exposing mutable segments", () => {
		let descriptorReads = 0;
		const original = {object_id: "room", epoch: 2, received_preimage: Uint8Array.of(7, 9), source_kind: "received"},
			row = new Proxy(original, {ownKeys(target) { descriptorReads++; return Reflect.ownKeys(target); }}),
			owner = createCanonicalEncodingCapture();
		const expected = encodeCanonical(original, limits), handle = owner.capture(row, limits), reads = descriptorReads;
		expect(handle.byteLength).toBe(expected.length);
		expect(Object.isFrozen(handle)).toBe(true);
		original.received_preimage.fill(99); original.epoch = 3;
		const expectedRow = decodeCanonical(expected), frame = owner.encode(["accepted_entries", ["room", 2], handle],
			{...limits, maxDepth: 17, maxItems: 144});
		expect(frame).toEqual(encodeCanonical(["accepted_entries", ["room", 2], expectedRow]));
		frame.fill(0);
		expect(owner.encode({scopes: [], rows: [handle]}, {...limits, maxItems: 129}))
			.toEqual(encodeCanonical({scopes: [], rows: [expectedRow]}));
		expect(descriptorReads).toBe(reads);
		owner.release();
		expect(() => owner.encode(handle, limits)).toThrow("foreign or released canonical capture");
	});

	it("rejects foreign/released handles, weaker limits and arbitrary-byte enrollment", () => {
		const first = createCanonicalEncodingCapture(), second = createCanonicalEncodingCapture(),
			handle = first.capture(Uint8Array.of(7), limits);
		expect(() => second.encode(handle, limits)).toThrow("foreign or released canonical capture");
		expect(() => first.encode(handle, {...limits, maxItems: 127})).toThrow("dominating byte and item limits");
		expect(() => first.encode(handle, {...limits, maxBytes: 4095})).toThrow("dominating byte and item limits");
		expect(() => encodeCanonical(handle)).toThrow("class instances require an explicit snapshot codec");
		const copied = {...handle};
		expect(first.encode(copied, limits)).toEqual(encodeCanonical(copied, limits));
		expect(first.encode(copied, limits)).not.toEqual(first.encode(handle, limits));
		first.release(); second.release();
		expect(() => first.capture(null, limits)).toThrow("foreign or released canonical capture");
	});

	it("preserves depth at the original insertion point and final byte refusal ordering", () => {
		const owner = createCanonicalEncodingCapture(), handle = owner.capture({a: {b: null}}, limits);
		expect(() => owner.encode([handle], {...limits, maxDepth: 2})).toThrow("canonical value exceeds maximum nesting depth");
		expect(owner.encode([handle], {...limits, maxDepth: 3})).toEqual(encodeCanonical([{a: {b: null}}], {...limits, maxDepth: 3}));
		const small = {maxBytes: 32, maxItems: 128, maxDepth: 16}, wide = owner.capture(new Uint8Array(28), small);
		const accessor = Object.defineProperty({}, "bad", {enumerable: true, get() {throw Error("must not execute");}});
		expect(() => owner.encode([wide, accessor], small)).toThrow("accessor property bad is outside the canonical domain");
		expect(() => owner.encode([wide, wide], small)).toThrow("canonical value exceeds byte limit");
		owner.release();
	});

	it("retains original malformed string, descriptor, class, item and cycle refusals", () => {
		const owner = createCanonicalEncodingCapture(), accessor = Object.defineProperty({}, "bad", {enumerable: true, get() {throw Error("not called");}}),
			cycle: unknown[] = []; cycle.push(cycle);
		class Outside { value = 1; }
		const outcome = (run: () => unknown) => {try {run(); return null;} catch (error) {
			return error instanceof Error ? [error.constructor.name, error.message] : error;
		}};
		for (const value of ["\ud800", {"\udfff": 1}, Infinity, accessor, new Outside(), new Array(1), cycle, new Array(129).fill(null)])
			expect(outcome(() => owner.capture(value, limits))).toEqual(outcome(() => encodeCanonical(value, limits)));
		for (const value of ["\ufeffhello", "\ufeff\ufeffhello", Uint8Array.of(0xef, 0xbb, 0xbf), new Map([[{a: 1}, new Set([2, 3])]])]) {
			const handle = owner.capture(value, limits);
			expect(owner.encode(handle, limits)).toEqual(encodeCanonical(value, limits));
		}
		owner.release();
	});

	it("refuses enrollment and delivery after release from an original caller callback", () => {
		const captureOwner = createCanonicalEncodingCapture(), captureInput: unknown[] = [Uint8Array.of(7)];
		Object.defineProperty(captureInput, 1, {get() {captureOwner.release(); return null;}});
		expect(() => captureOwner.capture(captureInput, limits)).toThrow("foreign or released canonical capture");
		const encodeOwner = createCanonicalEncodingCapture(), handle = encodeOwner.capture(Uint8Array.of(9), limits), input: unknown[] = [handle];
		Object.defineProperty(input, 1, {get() {encodeOwner.release(); return null;}});
		expect(() => encodeOwner.encode(input, limits)).toThrow("foreign or released canonical capture");
	});
});

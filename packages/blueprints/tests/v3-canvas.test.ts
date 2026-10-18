import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, test } from "vitest";

import { blueprint, CANVAS_LIMITS, createCanvasStateKernel, createV3CanvasDescriptor } from "../src/v3-canvas.js";
import type { CanvasAcceptedOperation, CanvasOperation } from "../src/v3-canvas.js";

const paint: CanvasOperation = { action: "paint", offset: [0, 0], rgb: [255, 7, 1] };
const splash: CanvasOperation = { action: "splash", offset: [0, 0], size: [2, 2], rgb: [2, 250, 3] };
const row = (digit: string, operation: CanvasOperation = paint, epoch = 0): CanvasAcceptedOperation => ({
	vertexDigest: digit.repeat(64),
	author: "c".repeat(64),
	epoch,
	operationIndex: 0,
	operation,
});

describe("pure v3 additive RGB canvas", () => {
	test("concurrent additions commute including overlapping valid splash", () => {
		const kernel = createCanvasStateKernel(),
			initial = kernel.createState(2, 2);
		const first = kernel.apply(kernel.apply(initial, paint).state, splash).state;
		const second = kernel.apply(kernel.apply(initial, splash).state, paint).state;
		expect(first).toEqual(second);
		expect(initial.counters.every((pixel) => pixel.every((n) => n === 0))).toBe(true);
	});
	test("artifact reducers and descriptor projection consume the single kernel law", () => {
		const descriptor = createV3CanvasDescriptor(2, 2);
		const artifact = blueprint.reducers.splash({
			state: blueprint.reducers.paint({ state: descriptor.initialState, operation: paint }).state,
			operation: splash,
		}).state;
		expect(descriptor.projectAcceptedOperations({ epoch: 0, operations: [row("a"), row("b", splash)] })).toEqual(
			artifact
		);
	});
	test("deduplicates exact authenticated retries but not equal independent colors", () => {
		const descriptor = createV3CanvasDescriptor(2, 2),
			a = row("a"),
			b = row("b");
		const state = descriptor.projectAcceptedOperations({ epoch: 0, operations: [a, { ...a }, b] });
		expect(descriptor.kernel.queryCounters(state, 0, 0)).toEqual([510, 14, 2]);
		expect(
			descriptor.kernel.queryCounters(
				descriptor.kernel.apply(descriptor.kernel.apply(descriptor.initialState, paint).state, paint).state,
				0,
				0
			)
		).toEqual([510, 14, 2]);
	});
	test("rejects conflicting retry values/author while allowing distinct batch indices", () => {
		const descriptor = createV3CanvasDescriptor(2, 2),
			a = row("a");
		expect(() =>
			descriptor.projectAcceptedOperations({ epoch: 0, operations: [a, { ...a, operation: splash }] })
		).toThrow("retry conflicts");
		expect(() =>
			descriptor.projectAcceptedOperations({ epoch: 0, operations: [a, { ...a, author: "d".repeat(64) }] })
		).toThrow("retry conflicts");
		const state = descriptor.projectAcceptedOperations({ epoch: 0, operations: [a, { ...a, operationIndex: 1 }] });
		expect(descriptor.kernel.queryCounters(state, 0, 0)[0]).toBe(510);
	});
	test("refuses overflow atomically across a whole splash", () => {
		const kernel = createCanvasStateKernel();
		const state = kernel.captureState({
			version: 1,
			width: 2,
			height: 2,
			counters: [
				[0, 0, 0],
				[0, 0, 0],
				[0, 0, 0],
				[CANVAS_LIMITS.maxCounter, 0, 0],
			],
		});
		const before = encodeCanonical(state);
		expect(() => kernel.apply(state, splash)).toThrow("overflow");
		expect(encodeCanonical(state)).toEqual(before);
		expect(kernel.queryCounters(state, 0, 0)).toEqual([0, 0, 0]);
	});
	test("admits bounded dimensions and refuses invalid counters/regions/increments", () => {
		const kernel = createCanvasStateKernel();
		expect(kernel.createState(64, 64).counters).toHaveLength(4096);
		for (const [width, height] of [
			[0, 1],
			[65, 1],
			[1.5, 2],
			[-1, 2],
		])
			expect(() => kernel.createState(width, height)).toThrow();
		for (const operation of [
			{ ...paint, offset: [2, 0] },
			{ ...splash, offset: [1, 0] },
			{ ...splash, size: [0, 1] },
			{ ...paint, rgb: [-1, 0, 0] },
			{ ...paint, rgb: [256, 0, 0] },
			{ ...paint, rgb: [0.5, 0, 0] },
		])
			expect(() => kernel.apply(kernel.createState(2, 2), operation)).toThrow();
		expect(() =>
			kernel.captureState({ version: 1, width: 1, height: 1, counters: [[Number.MAX_SAFE_INTEGER + 1, 0, 0]] })
		).toThrow();
	});
	test("snapshot roundtrip and subsequent fold match uninterrupted exact counters", () => {
		const descriptor = createV3CanvasDescriptor(2, 2);
		const prefix = descriptor.projectAcceptedOperations({ epoch: 0, operations: [row("a")] });
		const restored = descriptor.restoreState(descriptor.canonicalStateBytes(prefix));
		const resumed = descriptor.projectAcceptedOperations({
			epoch: 1,
			base: { epoch: 0, state: restored },
			operations: [row("b", splash, 1)],
		});
		expect(resumed).toEqual(
			descriptor.projectAcceptedOperations({ epoch: 0, operations: [row("a"), row("b", splash)] })
		);
	});
	test("rejects snapshot double-fold, wrong dimensions/extra fields and old epoch replay", () => {
		const descriptor = createV3CanvasDescriptor(2, 2),
			state = descriptor.initialState;
		expect(() =>
			descriptor.projectAcceptedOperations({ epoch: 1, base: { epoch: 0, state }, operations: [row("a")] })
		).toThrow("identity");
		expect(() => descriptor.projectAcceptedOperations({ epoch: 0, base: { epoch: 0, state }, operations: [] })).toThrow(
			"boundary"
		);
		expect(() => descriptor.projectAcceptedOperations({ epoch: 2, base: { epoch: 0, state }, operations: [] })).toThrow(
			"boundary"
		);
		expect(() => descriptor.restoreState(encodeCanonical({ ...state, width: 1 }))).toThrow();
		expect(() => descriptor.restoreState(encodeCanonical({ ...state, extra: true }))).toThrow();
		expect(() => descriptor.canonicalStateBytes(descriptor.kernel.createState(1, 1))).toThrow("dimensions");
	});
	test("captures decoded null-record state without aliasing and refuses accessors", () => {
		const kernel = createCanvasStateKernel(),
			state = kernel.createState(2, 2);
		expect(kernel.captureState(decodeCanonical(encodeCanonical(state)))).toEqual(state);
		let calls = 0;
		const malicious = {
			...paint,
			get rgb(): number[] {
				calls++;
				return [1, 2, 3];
			},
		};
		expect(() => kernel.apply(state, malicious)).toThrow("accessor");
		expect(calls).toBe(0);
	});
	test("roundtrips the maximum admitted dimensions and counters within snapshot limits", () => {
		const descriptor = createV3CanvasDescriptor(64, 64);
		const state = descriptor.kernel.captureState({
			version: 1,
			width: 64,
			height: 64,
			counters: Array.from({ length: 4096 }, () => [
				Number.MAX_SAFE_INTEGER,
				Number.MAX_SAFE_INTEGER,
				Number.MAX_SAFE_INTEGER,
			]),
		});
		const bytes = descriptor.canonicalStateBytes(state);
		expect(descriptor.restoreState(bytes)).toEqual(state);
	});
	test("detaches state and normalizes signed zero to the canonical counter domain", () => {
		const descriptor = createV3CanvasDescriptor(1, 1),
			counters = [[-0, 2, 3]];
		const state = descriptor.kernel.captureState({ version: 1, width: 1, height: 1, counters });
		counters[0][1] = 99;
		expect(state.counters[0]).toEqual([0, 2, 3]);
		expect(Object.is(state.counters[0][0], -0)).toBe(false);
		expect(descriptor.restoreState(descriptor.canonicalStateBytes(state))).toEqual(state);
	});
	test("refuses malformed or oversized author identities within the bounded retry schema", () => {
		const descriptor = createV3CanvasDescriptor(64, 64),
			original = row("a");
		for (const author of ["", "label", "a".repeat(65), "A".repeat(64), "a".repeat(100_000)]) {
			expect(() => descriptor.projectAcceptedOperations({ epoch: 0, operations: [{ ...original, author }] })).toThrow(
				"identity"
			);
		}
		let coercions = 0;
		const masquerade = {
			toString(): string {
				coercions++;
				return "a".repeat(64);
			},
		};
		expect(() =>
			descriptor.projectAcceptedOperations({
				epoch: 0,
				operations: [{ ...original, author: masquerade as unknown as string }],
			})
		).toThrow("identity");
		expect(coercions).toBe(0);
		const full: CanvasOperation = { action: "splash", offset: [0, 0], size: [64, 64], rgb: [255, 255, 255] };
		const admitted = row("b", full);
		expect(descriptor.projectAcceptedOperations({ epoch: 0, operations: [admitted, admitted] }).counters[4095]).toEqual(
			[255, 255, 255]
		);
	});
});

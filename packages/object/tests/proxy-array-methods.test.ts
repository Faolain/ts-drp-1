import { type IDRP, SemanticsType } from "@ts-drp/types";
import { describe, expect, test } from "vitest";

import { DRPObject } from "../src/index.js";
import { trackMutations } from "../src/proxy.js";

class ArrayMethodsDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	items = [1, 2, 3, 4];

	mapAssigned(): void {
		this.items = this.items.map((value) => value * 2);
	}

	filterAssigned(): void {
		this.items = this.items.filter((value) => value % 2 === 0);
	}

	sliceAssigned(): void {
		this.items = this.items.slice(1, 3);
	}

	spliceChanged(): void {
		this.items.splice(1, 2, 9, 10);
	}

	concatAssigned(): void {
		this.items = this.items.concat([5, 6]);
	}

	flatAssigned(): void {
		this.items = [this.items, [5]].flat();
	}

	mapLocalOnly(): number[] {
		return this.items.map((value) => value * 2);
	}
}

function objectWithArrays(): DRPObject<ArrayMethodsDRP> {
	return new DRPObject({ peerId: "array-methods", drp: new ArrayMethodsDRP() });
}

describe("mutation tracking for Array species methods through a real DRPObject", () => {
	test.each([
		["map", "mapAssigned", [2, 4, 6, 8]],
		["filter", "filterAssigned", [2, 4]],
		["slice", "sliceAssigned", [2, 3]],
		["splice", "spliceChanged", [1, 9, 10, 4]],
		["concat", "concatAssigned", [1, 2, 3, 4, 5, 6]],
		["flat", "flatAssigned", [1, 2, 3, 4, 5]],
	] as const)("applies %s, tracks its state write, and creates a vertex", (_name, method, expected) => {
		const object = objectWithArrays();

		expect(() => object.drp?.[method]()).not.toThrow();
		expect(object.drp?.items).toEqual(expected);
		expect(object.vertices).toHaveLength(2);
	});

	test("does not create a vertex when map only feeds a local variable", () => {
		const object = objectWithArrays();

		expect(object.drp?.mapLocalOnly()).toEqual([2, 4, 6, 8]);
		expect(object.drp?.items).toEqual([1, 2, 3, 4]);
		expect(object.vertices).toHaveLength(1);
	});
});

describe("mutation tracking hardening", () => {
	test("defaults unknown Map and Set function calls to changed", () => {
		class ExtendedMap<K, V> extends Map<K, V> {
			unknownMethod(): number {
				return this.size;
			}
		}
		class ExtendedSet<V> extends Set<V> {
			unknownMethod(): number {
				return this.size;
			}
		}

		const map = trackMutations({ value: new ExtendedMap([["one", 1]]) });
		const set = trackMutations({ value: new ExtendedSet([1]) });
		expect(map.proxy.value.unknownMethod()).toBe(1);
		expect(set.proxy.value.unknownMethod()).toBe(1);
		expect(map.hasChanges()).toBe(true);
		expect(set.hasChanges()).toBe(true);
	});

	test("defineProperty marks the tracked object changed", () => {
		const state: { value: number; added?: number } = { value: 1 };
		const tracked = trackMutations(state);

		Object.defineProperty(tracked.proxy, "added", { configurable: true, enumerable: true, value: 2 });

		expect(tracked.hasChanges()).toBe(true);
		expect(state.added).toBe(2);
	});
});

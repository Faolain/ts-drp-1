import { describe, expect, it } from "vitest";

import { insertionPermutations } from "./corpus.js";

describe("Phase 0b insertion-permutation coverage", () => {
	it("spreads the anchor across beginning, interior, and end positions", () => {
		const anchor = "anchor";
		const entries = new Map(Array.from({ length: 5 }, (_, index) => [index === 0 ? anchor : `vertex-${index}`, index]));
		const permutations = insertionPermutations(entries);
		const serialized = permutations.map((permutation) => [...permutation.keys()].join(","));
		const anchorPositions = new Set(permutations.map((permutation) => [...permutation.keys()].indexOf(anchor)));

		expect(permutations).toHaveLength(8);
		expect(new Set(serialized)).toHaveLength(8);
		expect(anchorPositions).toContain(0);
		expect(anchorPositions).toContain(Math.floor(entries.size / 2));
		expect(anchorPositions).toContain(entries.size - 1);
	});
});

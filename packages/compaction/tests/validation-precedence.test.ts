import { describe, expect, it, vi } from "vitest";

import { type CompactionModule, type EpochVertex, loadCompaction, sourceExists } from "./contract.js";
import { ANCHOR_HASH, hashForIndex, insertionPermutations, makeGraph } from "./corpus.js";

const CONCURRENT_SHAPE = {
	ancestorMasks: [0, 1, 1],
	dependencies: [[], [0], [0]],
};

function expectLinearizationCode(module: CompactionModule, action: () => unknown, code: string): void {
	let captured: unknown;
	try {
		action();
	} catch (error) {
		captured = error;
	}
	expect(captured).toBeInstanceOf(module.LinearizationError);
	expect(captured).toMatchObject({ code });
}

describe.skipIf(!sourceExists)("Phase 0b validation precedence", () => {
	it("classifies an unknown mode before checking for a resolver", async () => {
		const module = await loadCompaction();
		const vertices = makeGraph(CONCURRENT_SHAPE);
		expectLinearizationCode(
			module,
			() =>
				module.linearizeEpoch({
					anchorHash: ANCHOR_HASH,
					mode: "bogus" as "none",
					vertices,
				}),
			"UNKNOWN_MODE"
		);
	});

	it("classifies an unknown mode before validating an invalid graph", async () => {
		const module = await loadCompaction();
		expectLinearizationCode(
			module,
			() =>
				module.linearizeEpoch({
					anchorHash: "not-a-digest",
					mode: "bogus" as "none",
					vertices: {} as unknown as Map<string, EpochVertex>,
				}),
			"UNKNOWN_MODE"
		);
	});

	it.each([
		["NaN", Number.NaN],
		["function", (): undefined => undefined],
		["symbol", Symbol("noncanonical")],
	])(
		"rejects a noncanonical %s operation as INVALID_VERTEX in every mode before resolver invocation",
		async (_, value) => {
			const module = await loadCompaction();
			const vertices = makeGraph(CONCURRENT_SHAPE, (index) => ({
				conflictKey: "shared",
				value: index === 1 ? value : { index },
			}));
			const resolver = vi.fn(() => ({ action: "Nop" as const }));

			expectLinearizationCode(module, () => module.topologicalOrder(vertices, ANCHOR_HASH), "INVALID_VERTEX");
			expectLinearizationCode(
				module,
				() => module.linearizeEpoch({ anchorHash: ANCHOR_HASH, mode: "none", vertices }),
				"INVALID_VERTEX"
			);
			expectLinearizationCode(
				module,
				() => module.linearizeEpoch({ anchorHash: ANCHOR_HASH, mode: "pair", resolveConflicts: resolver, vertices }),
				"INVALID_VERTEX"
			);
			expectLinearizationCode(
				module,
				() =>
					module.linearizeEpoch({ anchorHash: ANCHOR_HASH, mode: "multiple", resolveConflicts: resolver, vertices }),
				"INVALID_VERTEX"
			);
			expect(resolver).not.toHaveBeenCalled();
		}
	);

	it("pins structural INVALID_VERTEX precedence for two simultaneous defects across insertion orders", async () => {
		const module = await loadCompaction();
		const graph = makeGraph(CONCURRENT_SHAPE);
		graph.set(hashForIndex(1), null as unknown as EpochVertex);
		graph.set(hashForIndex(2), {
			...(graph.get(hashForIndex(2)) as EpochVertex),
			hash: "f".repeat(64),
		});

		for (const vertices of insertionPermutations(graph)) {
			expectLinearizationCode(module, () => module.topologicalOrder(vertices, ANCHOR_HASH), "INVALID_VERTEX");
		}
	});
});

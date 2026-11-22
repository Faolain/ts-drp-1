import { describe, expect, it, vi } from "vitest";

import { type EpochVertex, errorCode, loadCompaction, sourceExists } from "./contract.js";

const hashes = Array.from({ length: 6 }, (_, index) => index.toString(16).padStart(64, "0"));
const anchorHash = hashes[0];

function graphWithConcurrentOperations(): Map<string, EpochVertex> {
	return new Map([
		[
			hashes[0],
			{
				dependencies: [],
				epoch: 8,
				hash: hashes[0],
				kind: "drp-epoch-anchor",
				objectId: "conflict-object",
			},
		],
		[
			hashes[1],
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 8,
				hash: hashes[1],
				kind: "drp-vertex",
				objectId: "conflict-object",
				operation: { conflictKey: "shared", value: 1 },
			},
		],
		[
			hashes[2],
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 8,
				hash: hashes[2],
				kind: "drp-vertex",
				objectId: "conflict-object",
				operation: { conflictKey: "shared", value: 2 },
			},
		],
		[
			hashes[3],
			{
				anchor: anchorHash,
				dependencies: [hashes[1]],
				epoch: 8,
				hash: hashes[3],
				kind: "drp-vertex",
				objectId: "conflict-object",
				operation: { conflictKey: "other", value: 3 },
			},
		],
	]);
}

function graphWithInterveningDescendant(): Map<string, EpochVertex> {
	return new Map([
		[
			hashes[0],
			{
				dependencies: [],
				epoch: 8,
				hash: hashes[0],
				kind: "drp-epoch-anchor",
				objectId: "swap-causality-object",
			},
		],
		[
			hashes[1],
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 8,
				hash: hashes[1],
				kind: "drp-vertex",
				objectId: "swap-causality-object",
				operation: { conflictKey: "shared", value: "ancestor" },
			},
		],
		[
			hashes[2],
			{
				anchor: anchorHash,
				dependencies: [hashes[1]],
				epoch: 8,
				hash: hashes[2],
				kind: "drp-vertex",
				objectId: "swap-causality-object",
				operation: { conflictKey: "shared", value: "descendant" },
			},
		],
		[
			hashes[3],
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 8,
				hash: hashes[3],
				kind: "drp-vertex",
				objectId: "swap-causality-object",
				operation: { conflictKey: "shared", value: "concurrent" },
			},
		],
	]);
}

function graphWithGroupedDescendant(): Map<string, EpochVertex> {
	return new Map([
		[
			hashes[0],
			{
				dependencies: [],
				epoch: 8,
				hash: hashes[0],
				kind: "drp-epoch-anchor",
				objectId: "multiple-causality-object",
			},
		],
		[
			hashes[1],
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 8,
				hash: hashes[1],
				kind: "drp-vertex",
				objectId: "multiple-causality-object",
				operation: { conflictKey: "shared", value: "concurrent" },
			},
		],
		[
			hashes[2],
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 8,
				hash: hashes[2],
				kind: "drp-vertex",
				objectId: "multiple-causality-object",
				operation: { conflictKey: "other", value: "dependency" },
			},
		],
		[
			hashes[3],
			{
				anchor: anchorHash,
				dependencies: [hashes[2]],
				epoch: 8,
				hash: hashes[3],
				kind: "drp-vertex",
				objectId: "multiple-causality-object",
				operation: { conflictKey: "shared", value: "descendant" },
			},
		],
	]);
}

function graphWithDroppedIntermediate(): Map<string, EpochVertex> {
	return new Map([
		[
			hashes[0],
			{
				dependencies: [],
				epoch: 8,
				hash: hashes[0],
				kind: "drp-epoch-anchor",
				objectId: "dropped-intermediate-object",
			},
		],
		[
			hashes[1],
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 8,
				hash: hashes[1],
				kind: "drp-vertex",
				objectId: "dropped-intermediate-object",
				operation: { conflictKey: "shared", value: "retained-ancestor-a" },
			},
		],
		[
			hashes[2],
			{
				anchor: anchorHash,
				dependencies: [hashes[1]],
				epoch: 8,
				hash: hashes[2],
				kind: "drp-vertex",
				objectId: "dropped-intermediate-object",
				operation: { conflictKey: "shared", value: "dropped-intermediate-b" },
			},
		],
		[
			hashes[3],
			{
				anchor: anchorHash,
				dependencies: [hashes[2]],
				epoch: 8,
				hash: hashes[3],
				kind: "drp-vertex",
				objectId: "dropped-intermediate-object",
				operation: { conflictKey: "shared", value: "retained-descendant-c" },
			},
		],
		[
			hashes[4],
			{
				anchor: anchorHash,
				dependencies: [anchorHash],
				epoch: 8,
				hash: hashes[4],
				kind: "drp-vertex",
				objectId: "dropped-intermediate-object",
				operation: { conflictKey: "shared", value: "concurrent-d" },
			},
		],
	]);
}

function outputHashes(output: readonly EpochVertex[]): string[] {
	return output.map(({ hash }) => hash);
}

describe.skipIf(!sourceExists)("Phase 0b amended conflict laws", () => {
	it("invokes pair resolution only for concurrent vertices and in deterministic order", async () => {
		const module = await loadCompaction();
		const vertices = graphWithConcurrentOperations();
		const calls: string[][] = [];
		const output = module.linearizeEpoch({
			anchorHash,
			mode: "pair",
			resolveConflicts: (pair) => {
				calls.push(pair.map(({ hash }) => hash));
				return { action: "Nop" };
			},
			vertices,
		});
		expect(outputHashes(output)).toEqual([hashes[1], hashes[2], hashes[3]]);
		expect(calls).toEqual([
			[hashes[1], hashes[2]],
			[hashes[2], hashes[3]],
		]);

		const reversed = new Map([...vertices].reverse());
		const reversedCalls: string[][] = [];
		module.linearizeEpoch({
			anchorHash,
			mode: "pair",
			resolveConflicts: (pair) => {
				reversedCalls.push(pair.map(({ hash }) => hash));
				return { action: "Nop" };
			},
			vertices: reversed,
		});
		expect(reversedCalls).toEqual(calls);
	});

	it.each([
		["Nop", [hashes[1], hashes[2], hashes[3]]],
		["DropLeft", [hashes[2], hashes[3]]],
		["DropRight", [hashes[1], hashes[3]]],
		["Drop", [hashes[3]]],
	] as const)("implements the frozen %s pair action", async (action, expected) => {
		const module = await loadCompaction();
		let resolved = false;
		const output = module.linearizeEpoch({
			anchorHash,
			mode: "pair",
			resolveConflicts: () => {
				if (resolved) return { action: "Nop" };
				resolved = true;
				return { action };
			},
			vertices: graphWithConcurrentOperations(),
		});
		expect(outputHashes(output)).toEqual(expected);
	});

	it("implements Swap but detects a resolver-induced swap cycle", async () => {
		const module = await loadCompaction();
		let resolved = false;
		expect(
			outputHashes(
				module.linearizeEpoch({
					anchorHash,
					mode: "pair",
					resolveConflicts: () => {
						if (resolved) return { action: "Nop" };
						resolved = true;
						return { action: "Swap" };
					},
					vertices: graphWithConcurrentOperations(),
				})
			)
		).toEqual([hashes[2], hashes[1], hashes[3]]);

		expect(() =>
			module.linearizeEpoch({
				anchorHash,
				maxPasses: 4,
				mode: "pair",
				resolveConflicts: () => ({ action: "Swap" }),
				vertices: graphWithConcurrentOperations(),
			})
		).toThrow(/NON_CONVERGENT_CONFLICT_POLICY|swap cycle/iu);
	});

	it("fails closed when a non-adjacent Swap would move an ancestor after its descendant", async () => {
		const module = await loadCompaction();
		let swapped = false;
		let captured: unknown;
		let output: EpochVertex[] | undefined;
		try {
			output = module.linearizeEpoch({
				anchorHash,
				mode: "pair",
				resolveConflicts: (pair) => {
					if (!swapped && pair[0]?.hash === hashes[1] && pair[1]?.hash === hashes[3]) {
						swapped = true;
						return { action: "Swap" };
					}
					return { action: "Nop" };
				},
				vertices: graphWithInterveningDescendant(),
			});
		} catch (error) {
			captured = error;
		}
		if (captured === undefined) {
			expect(swapped).toBe(true);
			expect(outputHashes(output as EpochVertex[])).toEqual([hashes[3], hashes[2], hashes[1]]);
		}
		expect(captured).toBeInstanceOf(module.LinearizationError);
		expect(captured).toMatchObject({ code: "CAUSALITY_VIOLATION" });
	});

	it("propagates retained ancestry solely through a dropped intermediate", async () => {
		const module = await loadCompaction();
		let droppedIntermediate = false;
		let swappedRetainedAncestor = false;
		let captured: unknown;
		try {
			module.linearizeEpoch({
				anchorHash,
				mode: "pair",
				resolveConflicts: (pair) => {
					const pairHashes = pair.map(({ hash }) => hash);
					if (!droppedIntermediate && pairHashes[0] === hashes[2] && pairHashes[1] === hashes[4]) {
						droppedIntermediate = true;
						return { action: "DropLeft" };
					}
					if (
						droppedIntermediate &&
						!swappedRetainedAncestor &&
						pairHashes[0] === hashes[1] &&
						pairHashes[1] === hashes[4]
					) {
						swappedRetainedAncestor = true;
						return { action: "Swap" };
					}
					return { action: "Nop" };
				},
				vertices: graphWithDroppedIntermediate(),
			});
		} catch (error) {
			captured = error;
		}
		expect(droppedIntermediate).toBe(true);
		expect(swappedRetainedAncestor).toBe(true);
		expect(captured).toBeInstanceOf(module.LinearizationError);
		expect(captured).toMatchObject({ code: "CAUSALITY_VIOLATION" });
	});

	it.each(["pair", "multiple"] as const)("emits MISSING_CONFLICT_RESOLVER for valid %s input", async (mode) => {
		const module = await loadCompaction();
		expect(
			errorCode(() =>
				module.linearizeEpoch({
					anchorHash,
					mode,
					vertices: graphWithConcurrentOperations(),
				})
			)
		).toBe("MISSING_CONFLICT_RESOLVER");
	});

	it("validates action/result shape and fails closed without mutating the graph", async () => {
		const module = await loadCompaction();
		const invalidResults: unknown[] = [
			undefined,
			"Nop",
			{},
			{ action: "Unknown" },
			{ action: "Nop", vertices: [hashes[1]] },
			{ action: "Drop", vertices: [hashes[5]] },
		];
		for (const result of invalidResults) {
			const vertices = graphWithConcurrentOperations();
			const before = [...vertices].map(([hash, vertex]) => [hash, structuredClone(vertex)]);
			expect(() =>
				module.linearizeEpoch({
					anchorHash,
					mode: "pair",
					resolveConflicts: () => result as never,
					vertices,
				})
			).toThrow();
			expect([...vertices]).toEqual(before);
		}

		const vertices = graphWithConcurrentOperations();
		const before = structuredClone([...vertices]);
		expect(() =>
			module.linearizeEpoch({
				anchorHash,
				mode: "pair",
				resolveConflicts: () => {
					throw new Error("resolver poison");
				},
				vertices,
			})
		).toThrow(/resolver|conflict/iu);
		expect([...vertices]).toEqual(before);
	});

	it.each(["pair", "multiple"] as const)(
		"isolates the graph and frozen context from a mutating %s resolver across subsequent calls",
		async (mode) => {
			const module = await loadCompaction();
			const vertices = graphWithConcurrentOperations();
			const before = structuredClone([...vertices]);
			const firstCalls: string[][] = [];
			const contextWrites: boolean[] = [];
			const firstOutput = module.linearizeEpoch({
				anchorHash,
				mode,
				resolveConflicts: (received, context) => {
					firstCalls.push(received.map((vertex) => vertex.hash));
					for (const vertex of received) {
						vertex.hash = hashes[5];
						if (vertex.operation !== undefined) vertex.operation.value = { poisoned: true };
					}
					contextWrites.push(Reflect.set(context, "poisoned", true));
					return { action: "Nop" };
				},
				vertices,
			});
			expect([...vertices]).toEqual(before);
			expect(contextWrites.every((result) => !result)).toBe(true);
			expect(outputHashes(firstOutput).every((hash) => hash !== hashes[5])).toBe(true);

			const subsequentCalls: string[][] = [];
			const subsequentOutput = module.linearizeEpoch({
				anchorHash,
				mode,
				resolveConflicts: (received) => {
					subsequentCalls.push(received.map((vertex) => vertex.hash));
					return { action: "Nop" };
				},
				vertices,
			});
			expect(subsequentCalls).toEqual(firstCalls);
			expect(outputHashes(subsequentOutput)).toEqual(outputHashes(firstOutput));
			expect([...vertices]).toEqual(before);
		}
	);

	it("forms deterministic concurrent groups, validates Drop members, and never calls a singleton group", async () => {
		const module = await loadCompaction();
		const vertices = graphWithConcurrentOperations();
		const resolver = vi.fn((group: readonly EpochVertex[]) => ({
			action: "Drop" as const,
			vertices: [group[1]?.hash as string],
		}));
		const output = module.linearizeEpoch({
			anchorHash,
			mode: "multiple",
			resolveConflicts: resolver,
			vertices,
		});
		expect(resolver).toHaveBeenCalledTimes(1);
		expect(resolver.mock.calls[0]?.[0].map(({ hash }) => hash)).toEqual([hashes[1], hashes[2]]);
		expect(outputHashes(output)).toEqual([hashes[1], hashes[3]]);

		expect(() =>
			module.linearizeEpoch({
				anchorHash,
				mode: "multiple",
				resolveConflicts: () => ({ action: "Drop", vertices: [hashes[5]] }),
				vertices,
			})
		).toThrow(/group|outside|vertex/iu);
		expect(() =>
			module.linearizeEpoch({
				anchorHash,
				mode: "multiple",
				resolveConflicts: () => ({ action: "Drop", vertices: [hashes[1], hashes[1]] }),
				vertices,
			})
		).toThrow(/duplicate|vertex|result/iu);
	});

	it("wraps a thrown multiple resolver exception as CONFLICT_RESOLVER_FAILED", async () => {
		const module = await loadCompaction();
		expect(
			errorCode(() =>
				module.linearizeEpoch({
					anchorHash,
					mode: "multiple",
					resolveConflicts: () => {
						throw new Error("multiple resolver poison");
					},
					vertices: graphWithConcurrentOperations(),
				})
			)
		).toBe("CONFLICT_RESOLVER_FAILED");
	});

	it.each([
		["undefined", "INVALID_CONFLICT_RESULT", (): undefined => undefined],
		["malformed object", "INVALID_CONFLICT_ACTION", (): { vertices: string[] } => ({ vertices: [hashes[1]] })],
		["async result", "INVALID_CONFLICT_ACTION", (): Promise<{ action: "Nop" }> => Promise.resolve({ action: "Nop" })],
	] as const)(
		"rejects a %s multiple resolver result with the coded taxonomy",
		async (_label, expectedCode, resolver) => {
			const module = await loadCompaction();
			expect(
				errorCode(() =>
					module.linearizeEpoch({
						anchorHash,
						mode: "multiple",
						resolveConflicts: resolver as never,
						vertices: graphWithConcurrentOperations(),
					})
				)
			).toBe(expectedCode);
		}
	);

	it("rejects malformed multiple-mode action shapes as INVALID_MULTIPLE_RESULT", async () => {
		const module = await loadCompaction();
		const malformedResults: unknown[] = [
			{ action: "Nop", vertices: [] },
			{ action: "DropLeft" },
			{ action: "Drop" },
			{ action: "Drop", vertices: "not-an-array" },
		];
		for (const result of malformedResults) {
			expect(
				errorCode(() =>
					module.linearizeEpoch({
						anchorHash,
						mode: "multiple",
						resolveConflicts: () => result as never,
						vertices: graphWithConcurrentOperations(),
					})
				)
			).toBe("INVALID_MULTIPLE_RESULT");
		}
	});

	it("preserves retained causality when a multiple group spans an intervening dependency", async () => {
		const module = await loadCompaction();
		const calls: string[][] = [];
		const output = module.linearizeEpoch({
			anchorHash,
			mode: "multiple",
			resolveConflicts: (group) => {
				calls.push(group.map((vertex) => vertex.hash));
				return { action: "Nop" };
			},
			vertices: graphWithGroupedDescendant(),
		});
		expect(calls).toEqual([[hashes[1], hashes[3]]]);
		expect(outputHashes(output)).toEqual([hashes[1], hashes[2], hashes[3]]);
	});

	it("pins the amended law instead of the four-action original reference behavior", async () => {
		const module = await loadCompaction();
		const output = module.linearizeEpoch({
			anchorHash,
			mode: "pair",
			resolveConflicts: () => ({ action: "Drop" }),
			vertices: graphWithConcurrentOperations(),
		});
		expect(outputHashes(output)).toEqual([hashes[3]]);
	});
});

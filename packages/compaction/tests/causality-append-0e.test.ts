import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CausalityIndex, type EpochVertex, LinearizationError } from "../src/index.js";

interface IncrementalCausalityIndex {
	readonly size: number;
	append(hash: string, vertex: EpochVertex): void;
	has(hash: string): boolean;
	isAncestor(ancestorHash: string, descendantHash: string): boolean;
}

const OBJECT_ID = "phase-0e-object";

function hashFor(label: string): string {
	return createHash("sha256").update(`phase-0e:${label}`).digest("hex");
}

function anchor(hash = hashFor("anchor")): EpochVertex {
	return {
		dependencies: [],
		epoch: 4,
		hash,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
	};
}

function vertex(hash: string, dependencies: string[]): EpochVertex {
	return {
		anchor: hashFor("anchor"),
		dependencies,
		epoch: 4,
		hash,
		kind: "drp-vertex",
		objectId: OBJECT_ID,
	};
}

function incrementalIndex(): IncrementalCausalityIndex {
	const epochAnchor = anchor();
	return new CausalityIndex(new Map([[epochAnchor.hash, epochAnchor]])) as CausalityIndex & IncrementalCausalityIndex;
}

function relationSnapshot(
	index: IncrementalCausalityIndex,
	hashes: readonly string[]
): readonly (readonly boolean[])[] {
	return hashes.map((descendant) => hashes.map((ancestor) => index.isAncestor(ancestor, descendant)));
}

describe("Phase 0e append-only exact ancestor index", () => {
	it("publishes the full recurrence for each append and never follows later caller mutation", () => {
		const epochAnchorHash = hashFor("anchor");
		const a = hashFor("a");
		const b = hashFor("b");
		const c = hashFor("c");
		const join = hashFor("join");
		const index = incrementalIndex();
		const aDependencies = [epochAnchorHash];
		const joinDependencies = [b, c];

		expect({ anchorPresent: index.has(epochAnchorHash), size: index.size }).toEqual({
			anchorPresent: true,
			size: 1,
		});
		index.append(a, vertex(a, aDependencies));
		index.append(b, vertex(b, [a]));
		index.append(c, vertex(c, [epochAnchorHash]));
		index.append(join, vertex(join, joinDependencies));

		expect({
			anchorOfJoin: index.isAncestor(epochAnchorHash, join),
			aOfJoin: index.isAncestor(a, join),
			bOfJoin: index.isAncestor(b, join),
			cOfJoin: index.isAncestor(c, join),
			joinOfItself: index.isAncestor(join, join),
			siblingForward: index.isAncestor(b, c),
			siblingReverse: index.isAncestor(c, b),
			size: index.size,
		}).toEqual({
			anchorOfJoin: true,
			aOfJoin: true,
			bOfJoin: true,
			cOfJoin: true,
			joinOfItself: false,
			siblingForward: false,
			siblingReverse: false,
			size: 5,
		});

		aDependencies.length = 0;
		joinDependencies.splice(0, joinDependencies.length, epochAnchorHash);
		expect({
			anchorOfA: index.isAncestor(epochAnchorHash, a),
			aOfJoin: index.isAncestor(a, join),
			bOfJoin: index.isAncestor(b, join),
			cOfJoin: index.isAncestor(c, join),
		}).toEqual({
			anchorOfA: true,
			aOfJoin: true,
			bOfJoin: true,
			cOfJoin: true,
		});
	});

	it("grows exact bitsets across the first Uint32 word boundary", () => {
		const epochAnchorHash = hashFor("anchor");
		const hashes = Array.from({ length: 33 }, (_, index) => hashFor(`word-boundary-${index + 1}`));
		const index = incrementalIndex();

		for (const [position, hash] of hashes.entries()) {
			const dependency = position === 0 ? epochAnchorHash : (hashes[position - 1] as string);
			index.append(hash, vertex(hash, [dependency]));
		}

		const last = hashes[32] as string;
		expect({
			anchorOfLast: index.isAncestor(epochAnchorHash, last),
			bit31OfLast: index.isAncestor(hashes[30] as string, last),
			bit32OfLast: index.isAncestor(hashes[31] as string, last),
			lastOfBit32: index.isAncestor(last, hashes[31] as string),
			size: index.size,
		}).toEqual({
			anchorOfLast: true,
			bit31OfLast: true,
			bit32OfLast: true,
			lastOfBit32: false,
			size: 34,
		});
	});

	it("keeps hash visibility and its bitset atomic, and rolls every failed append back", () => {
		const epochAnchorHash = hashFor("anchor");
		const first = hashFor("first");
		const observedDuringAppend: Array<{
			readonly ancestor: boolean;
			readonly present: boolean;
			readonly size: number;
		}> = [];
		const index = incrementalIndex();
		const firstVertex = {
			anchor: epochAnchorHash,
			get dependencies(): string[] {
				observedDuringAppend.push({
					ancestor: index.isAncestor(epochAnchorHash, first),
					present: index.has(first),
					size: index.size,
				});
				return [epochAnchorHash];
			},
			epoch: 4,
			hash: first,
			kind: "drp-vertex" as const,
			objectId: OBJECT_ID,
		};

		index.append(first, firstVertex);
		expect(observedDuringAppend).toEqual([{ ancestor: false, present: false, size: 1 }]);
		expect({
			ancestor: index.isAncestor(epochAnchorHash, first),
			present: index.has(first),
			size: index.size,
		}).toEqual({ ancestor: true, present: true, size: 2 });

		const stableHashes = [epochAnchorHash, first] as const;
		const stableRelations = relationSnapshot(index, stableHashes);
		const missingDependency = hashFor("missing-dependency");
		const missingChild = hashFor("missing-child");
		const malformed = hashFor("malformed");
		const wrongEpoch = hashFor("wrong-epoch");
		const wrongAnchor = hashFor("wrong-anchor");
		const failures: ReadonlyArray<readonly [string, EpochVertex]> = [
			[first, vertex(first, [epochAnchorHash])],
			[missingChild, vertex(missingChild, [missingDependency])],
			[wrongEpoch, { ...vertex(wrongEpoch, [first]), epoch: 5 }],
			[wrongAnchor, { ...vertex(wrongAnchor, [first]), anchor: hashFor("other-anchor") }],
			[
				malformed,
				{
					...vertex(malformed, [epochAnchorHash]),
					kind: "not-a-registered-kind",
				} as unknown as EpochVertex,
			],
		];

		for (const [hash, candidate] of failures) {
			expect(() => index.append(hash, candidate)).toThrow();
			expect({
				priorRelations: relationSnapshot(index, stableHashes),
				size: index.size,
				targetPresent: index.has(hash),
			}).toEqual({
				priorRelations: stableRelations,
				size: 2,
				targetPresent: hash === first,
			});
		}

		index.append(missingChild, vertex(missingChild, [first]));
		expect({
			firstOfChild: index.isAncestor(first, missingChild),
			present: index.has(missingChild),
			size: index.size,
		}).toEqual({ firstOfChild: true, present: true, size: 3 });
	});

	it("does not expose an orphaned row when the second publication write fails", () => {
		const epochAnchorHash = hashFor("anchor");
		const first = hashFor("second-write-first");
		const failed = hashFor("second-write-failed");
		const replacement = hashFor("second-write-replacement");
		const index = incrementalIndex();
		index.append(first, vertex(first, [epochAnchorHash]));

		const stableHashes = [epochAnchorHash, first] as const;
		const stableRelations = relationSnapshot(index, stableHashes);
		const storage = index as unknown as {
			readonly ancestors: Uint32Array[];
			readonly index: Map<string, number>;
		};
		const publishedRows = storage.ancestors.length;
		const originalSet = storage.index.set;
		const injectedFault = new Error("injected second publication write failure");
		let fault: unknown;
		let rowCountAtFault = -1;
		let restorationSucceeded = false;

		Object.defineProperty(storage.index, "set", {
			configurable: true,
			value(key: string, position: number): Map<string, number> {
				if (key === failed) {
					rowCountAtFault = storage.ancestors.length;
					throw injectedFault;
				}
				return originalSet.call(this, key, position);
			},
		});
		try {
			index.append(failed, vertex(failed, [first]));
		} catch (error) {
			fault = error;
		} finally {
			restorationSucceeded = Reflect.deleteProperty(storage.index, "set");
		}

		expect({
			failedPresent: index.has(failed),
			fault,
			priorRelations: relationSnapshot(index, stableHashes),
			restorationSucceeded,
			restoredMethod: storage.index.set,
			rowCountAtFault,
			size: index.size,
		}).toEqual({
			failedPresent: false,
			fault: injectedFault,
			priorRelations: stableRelations,
			restorationSucceeded: true,
			restoredMethod: originalSet,
			rowCountAtFault: publishedRows + 1,
			size: 2,
		});

		index.append(replacement, vertex(replacement, [epochAnchorHash]));
		expect({
			anchorOfReplacement: index.isAncestor(epochAnchorHash, replacement),
			failedPresent: index.has(failed),
			firstOfReplacement: index.isAncestor(first, replacement),
			replacementPresent: index.has(replacement),
			size: index.size,
		}).toEqual({
			anchorOfReplacement: true,
			failedPresent: false,
			firstOfReplacement: false,
			replacementPresent: true,
			size: 3,
		});
	});

	it("rejects a stale outer append after a same-hash reentrant append publishes first", () => {
		const epochAnchorHash = hashFor("anchor");
		const x = hashFor("reentrant-x");
		const a = hashFor("reentrant-a");
		const b = hashFor("reentrant-b");
		const index = incrementalIndex();
		let reentries = 0;
		let nestedAppendSucceeded = false;
		let outerFailure: unknown;

		index.append(x, vertex(x, [epochAnchorHash]));
		const staleOuterCandidate = {
			anchor: epochAnchorHash,
			get dependencies(): string[] {
				reentries++;
				index.append(a, vertex(a, [epochAnchorHash]));
				nestedAppendSucceeded = index.has(a) && index.isAncestor(epochAnchorHash, a);
				return [x];
			},
			epoch: 4,
			hash: a,
			kind: "drp-vertex" as const,
			objectId: OBJECT_ID,
		};

		try {
			index.append(a, staleOuterCandidate);
		} catch (error) {
			outerFailure = error;
		}
		const aRelationsAfterOuter = {
			anchorOfA: index.isAncestor(epochAnchorHash, a),
			size: index.size,
			xOfA: index.isAncestor(x, a),
		};

		index.append(b, vertex(b, [a]));
		const hashes = [epochAnchorHash, x, a, b] as const;
		expect({
			aRelationsAfterOuter,
			finalRelations: relationSnapshot(index, hashes),
			finalSize: index.size,
			nestedAppendSucceeded,
			outerErrorCode: outerFailure instanceof LinearizationError ? outerFailure.code : undefined,
			outerIsLinearizationError: outerFailure instanceof LinearizationError,
			reentries,
		}).toEqual({
			aRelationsAfterOuter: {
				anchorOfA: true,
				size: 3,
				xOfA: false,
			},
			finalRelations: [
				[false, false, false, false],
				[true, false, false, false],
				[true, false, false, false],
				[true, false, true, false],
			],
			finalSize: 4,
			nestedAppendSucceeded: true,
			outerErrorCode: "DUPLICATE_VERTEX",
			outerIsLinearizationError: true,
			reentries: 1,
		});
	});
});

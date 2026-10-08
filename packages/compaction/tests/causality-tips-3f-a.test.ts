import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CausalityIndex, type CausalityIndexOptions, type EpochFullOutcome, type EpochVertex } from "../src/index.js";

interface TipCausalityIndex {
	readonly size: number;
	append(hash: string, vertex: EpochVertex, byteCharge?: number): undefined | EpochFullOutcome;
	has(hash: string): boolean;
	tips(): readonly string[];
}

const OBJECT_ID = "phase-3f-a-object";
const ANCHOR_HASH = hashFor("anchor");

function hashFor(label: string): string {
	return createHash("sha256").update(`phase-3f-a:${label}`).digest("hex");
}

function anchor(): EpochVertex {
	return {
		dependencies: [],
		epoch: 12,
		hash: ANCHOR_HASH,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
	};
}

function vertex(hash: string, dependencies: string[]): EpochVertex {
	return {
		anchor: ANCHOR_HASH,
		dependencies,
		epoch: 12,
		hash,
		kind: "drp-vertex",
		objectId: OBJECT_ID,
	};
}

function indexFor(
	vertices: ReadonlyMap<string, EpochVertex> = new Map([[ANCHOR_HASH, anchor()]]),
	order?: readonly string[],
	options?: CausalityIndexOptions
): TipCausalityIndex {
	return new CausalityIndex(vertices, order, options) as CausalityIndex & TipCausalityIndex;
}

function sorted(...hashes: string[]): string[] {
	return hashes.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function expectTips(index: TipCausalityIndex, ...hashes: string[]): void {
	expect(index.tips()).toEqual(sorted(...hashes));
}

describe("Phase 3f-a authoritative causality tips", () => {
	it("owns the exact anchor, sibling, full-join and proper-subset antichains", () => {
		const a = hashFor("live-a");
		const b = hashFor("live-b");
		const c = hashFor("live-c");
		const subsetJoin = hashFor("live-subset-join");
		const fullJoin = hashFor("live-full-join");
		const index = indexFor();

		expectTips(index, ANCHOR_HASH);
		index.append(a, vertex(a, [ANCHOR_HASH]));
		index.append(b, vertex(b, [ANCHOR_HASH]));
		index.append(c, vertex(c, [ANCHOR_HASH]));
		expectTips(index, a, b, c);

		index.append(subsetJoin, vertex(subsetJoin, [a, b]));
		expectTips(index, c, subsetJoin);

		index.append(fullJoin, vertex(fullJoin, [c, subsetJoin]));
		expectTips(index, fullJoin);
	});

	it("derives the same proper-subset snapshot from every valid complete-graph order", () => {
		const a = hashFor("constructed-a");
		const b = hashFor("constructed-b");
		const c = hashFor("constructed-c");
		const join = hashFor("constructed-subset-join");
		const entries = [
			[ANCHOR_HASH, anchor()],
			[a, vertex(a, [ANCHOR_HASH])],
			[b, vertex(b, [ANCHOR_HASH])],
			[c, vertex(c, [ANCHOR_HASH])],
			[join, vertex(join, [a, b])],
		] as const;
		const forward = new Map<string, EpochVertex>(entries);
		const reverse = new Map<string, EpochVertex>([...entries].reverse());

		expectTips(indexFor(forward, [ANCHOR_HASH, a, b, c, join]), c, join);
		expectTips(indexFor(reverse, [ANCHOR_HASH, c, b, a, join]), c, join);
		expectTips(indexFor(reverse), c, join);
	});

	it("returns fresh frozen snapshots without exposing internal custody", () => {
		const first = hashFor("detached-first");
		const second = hashFor("detached-second");
		const index = indexFor();
		index.append(first, vertex(first, [ANCHOR_HASH]));

		const snapshot = index.tips();
		const anotherSnapshot = index.tips();
		expect({ frozen: Object.isFrozen(snapshot), sameReference: snapshot === anotherSnapshot }).toEqual({
			frozen: true,
			sameReference: false,
		});
		expect(() => (snapshot as string[]).push(hashFor("caller-mutation"))).toThrow(TypeError);

		index.append(second, vertex(second, [first]));
		expect(snapshot).toEqual([first]);
		expectTips(index, second);
	});

	it("publishes no tip state of its own for every validation and capacity failure", () => {
		const first = hashFor("stable-first");
		const stable = indexFor();
		stable.append(first, vertex(first, [ANCHOR_HASH]));
		const attempts: ReadonlyArray<readonly [string, string, EpochVertex]> = [
			["key/hash mismatch", hashFor("key-mismatch"), vertex(hashFor("different-hash"), [first])],
			[
				"invalid kind",
				hashFor("invalid-kind"),
				{ ...vertex(hashFor("invalid-kind"), [first]), kind: "unknown" } as unknown as EpochVertex,
			],
			["multiple roots", hashFor("multiple-roots"), vertex(hashFor("multiple-roots"), [])],
			[
				"duplicate dependency",
				hashFor("duplicate-dependency"),
				vertex(hashFor("duplicate-dependency"), [first, first]),
			],
			["invalid vertex", hashFor("invalid-vertex"), null as unknown as EpochVertex],
			["missing dependency", hashFor("missing-child"), vertex(hashFor("missing-child"), [hashFor("missing-parent")])],
			["duplicate hash", first, vertex(first, [ANCHOR_HASH])],
			["wrong epoch", hashFor("wrong-epoch"), { ...vertex(hashFor("wrong-epoch"), [first]), epoch: 13 }],
		];

		for (const [label, hash, candidate] of attempts) {
			expect(() => stable.append(hash, candidate), label).toThrow();
			expectTips(stable, first);
		}

		const countBounded = indexFor(undefined, undefined, { maxEpochVertices: 1 });
		expect(countBounded.append(hashFor("count-full"), vertex(hashFor("count-full"), [ANCHOR_HASH]))).toEqual({
			code: "EPOCH_FULL",
			latchByHash: false,
			status: "pending",
		});
		expectTips(countBounded, ANCHOR_HASH);

		const byteBounded = indexFor(undefined, undefined, {
			initialByteCharges: new Map([[ANCHOR_HASH, 1]]),
			maxEpochBytes: 1,
		});
		expect(byteBounded.append(hashFor("byte-full"), vertex(hashFor("byte-full"), [ANCHOR_HASH]), 1)).toEqual({
			code: "EPOCH_FULL",
			latchByHash: false,
			status: "pending",
		});
		expectTips(byteBounded, ANCHOR_HASH);
	});

	it("preserves nested successful tips when a stale outer append fails", () => {
		const x = hashFor("reentrant-x");
		const nested = hashFor("reentrant-nested");
		const after = hashFor("reentrant-after");
		const index = indexFor();
		index.append(x, vertex(x, [ANCHOR_HASH]));
		let observations = 0;
		const staleOuter = {
			anchor: ANCHOR_HASH,
			get dependencies(): string[] {
				observations++;
				index.append(nested, vertex(nested, [ANCHOR_HASH]));
				return [x];
			},
			epoch: 12,
			hash: nested,
			kind: "drp-vertex" as const,
			objectId: OBJECT_ID,
		};

		expect(() => index.append(nested, staleOuter)).toThrow();
		expect({ nestedPresent: index.has(nested), observations }).toEqual({ nestedPresent: true, observations: 1 });
		expectTips(index, nested, x);

		index.append(after, vertex(after, [nested, x]));
		expectTips(index, after);
	});

	it("preserves nested successful tips when outer capacity is rechecked", () => {
		const x = hashFor("capacity-x");
		const nested = hashFor("capacity-nested");
		const outer = hashFor("capacity-outer");
		const index = indexFor(undefined, undefined, { maxEpochVertices: 3 });
		index.append(x, vertex(x, [ANCHOR_HASH]));
		const outerCandidate = {
			anchor: ANCHOR_HASH,
			get dependencies(): string[] {
				index.append(nested, vertex(nested, [ANCHOR_HASH]));
				return [x];
			},
			epoch: 12,
			hash: outer,
			kind: "drp-vertex" as const,
			objectId: OBJECT_ID,
		};

		expect(index.append(outer, outerCandidate)).toEqual({
			code: "EPOCH_FULL",
			latchByHash: false,
			status: "pending",
		});
		expect({ nestedPresent: index.has(nested), outerPresent: index.has(outer), size: index.size }).toEqual({
			nestedPresent: true,
			outerPresent: false,
			size: 3,
		});
		expectTips(index, nested, x);
	});

	it("does not publish an outer tip when index publication fails", () => {
		const first = hashFor("publication-first");
		const failed = hashFor("publication-failed");
		const replacement = hashFor("publication-replacement");
		const index = indexFor();
		index.append(first, vertex(first, [ANCHOR_HASH]));
		const storage = index as unknown as { readonly index: Map<string, number> };
		const originalSet = storage.index.set;
		const injectedFault = new Error("injected index publication failure");

		Object.defineProperty(storage.index, "set", {
			configurable: true,
			value(key: string, position: number): Map<string, number> {
				if (key === failed) throw injectedFault;
				return originalSet.call(this, key, position);
			},
		});
		try {
			expect(() => index.append(failed, vertex(failed, [first]))).toThrow(injectedFault);
			expectTips(index, first);
		} finally {
			expect(Reflect.deleteProperty(storage.index, "set")).toBe(true);
		}

		index.append(replacement, vertex(replacement, [first]));
		expectTips(index, replacement);
	});
});

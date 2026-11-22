/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0p1-v3/epoch-capacity-contract.json" with { type: "json" };

interface EpochVertex {
	readonly anchor?: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly hash: string;
	readonly kind: "drp-epoch-anchor" | "drp-vertex";
	readonly objectId: string;
}
interface CapacityOptions {
	readonly maxEpochVertices?: number | undefined;
}
interface EpochFullOutcome {
	readonly status: "pending";
	readonly code: "EPOCH_FULL";
	readonly latchByHash: false;
}
interface Index {
	readonly size: number;
	append(hash: string, vertex: EpochVertex): undefined | EpochFullOutcome;
	has(hash: string): boolean;
	isAncestor(ancestorHash: string, descendantHash: string): boolean;
}
type IndexConstructor = new (
	vertices: ReadonlyMap<string, EpochVertex>,
	order?: readonly string[],
	options?: CapacityOptions
) => Index;
interface Surface {
	readonly CausalityIndex?: IndexConstructor;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const IMPLEMENTATION =
	process.env.PHASE_0P1_IMPLEMENTATION_MODULE === undefined
		? resolve(HERE, contract.implementationModule)
		: resolve(ROOT, process.env.PHASE_0P1_IMPLEMENTATION_MODULE);
const loaded = import(pathToFileURL(IMPLEMENTATION).href) as Promise<Surface>;
const OBJECT_ID = "phase-0p1-object";

function hashFor(label: string): string {
	return createHash("sha256").update(`phase-0p1:${label}`).digest("hex");
}
function anchor(label = "anchor"): EpochVertex {
	return {
		dependencies: [],
		epoch: 23,
		hash: hashFor(label),
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
	};
}
function vertex(label: string, dependency: string, anchorHash = hashFor("anchor")): EpochVertex {
	return {
		anchor: anchorHash,
		dependencies: [dependency],
		epoch: 23,
		hash: hashFor(label),
		kind: "drp-vertex",
		objectId: OBJECT_ID,
	};
}
async function constructor(): Promise<IndexConstructor> {
	const surface = await loaded;
	if (typeof surface.CausalityIndex !== "function") {
		throw new Error("PHASE_0P1_MISSING_CAUSALITY_INDEX");
	}
	return surface.CausalityIndex;
}
async function emptyIndex(maxEpochVertices?: number): Promise<Index> {
	const Constructor = await constructor();
	const epochAnchor = anchor();
	return new Constructor(
		new Map([[epochAnchor.hash, epochAnchor]]),
		undefined,
		maxEpochVertices === undefined ? undefined : { maxEpochVertices }
	);
}
function outcome(): EpochFullOutcome {
	return { status: "pending", code: "EPOCH_FULL", latchByHash: false };
}
function relationSnapshot(index: Index, hashes: readonly string[]) {
	return {
		keys: hashes.map((hash) => index.has(hash)),
		relations: hashes.map((descendant) => hashes.map((ancestorHash) => index.isAncestor(ancestorHash, descendant))),
		size: index.size,
	};
}
function capturedError(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("Phase 0p-1 anchor-inclusive CausalityIndex capacity causal RED", () => {
	it("[governance] freezes a local capacity stall without finality or profile authority", () => {
		const directory = resolve(HERE, contract.conformanceDirectory);
		expect(existsSync(directory)).toBe(true);
		expect(readdirSync(directory).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		const profile = JSON.parse(readFileSync(resolve(directory, "profile.json"), "utf8"));
		expect(profile).toMatchObject({
			profileId: contract.profileId,
			capacity: {
				anchorInclusive: true,
				ordinaryVertexMaximum: "maxEpochVertices - 1",
				absent: "legacy-unbounded-behavior",
				reentrantRecheck: "after-candidate-observation-before-bitset-allocation-and-publication",
			},
			outcome: {
				status: "pending",
				code: "EPOCH_FULL",
				latchByHash: false,
				finalMembershipAuthority: false,
			},
			claims: {
				executionMetering: false,
				maxEpochBytes: false,
				supportedProfileSelection: false,
			},
		});
		const spec = readFileSync(resolve(directory, "spec.md"), "utf8");
		const normalizedSpec = spec.replace(/\s+/gu, " ");
		for (const phrase of [
			"anchor at position zero",
			"before publication",
			"does not name or certify a final winner",
			"different transient local membership",
			"after all candidate fields and dependencies have been captured",
			"Phase 5",
			"no invalid tombstone",
		]) {
			expect(normalizedSpec).toContain(phrase);
		}
	});

	it("[constructor-contract] validates opt-in capacity and counts an anchor-only epoch as one", async () => {
		const Constructor = await constructor();
		const epochAnchor = anchor();
		const graph = new Map([[epochAnchor.hash, epochAnchor]]);
		for (const invalidOptions of [null, [], 2, "invalid", true, () => undefined]) {
			expect(() => new Constructor(graph, undefined, invalidOptions as unknown as CapacityOptions)).toThrow(
				"CausalityIndex options must be an object"
			);
		}
		for (const maxEpochVertices of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => new Constructor(graph, undefined, { maxEpochVertices })).toThrow(
				"maxEpochVertices must be a positive safe integer"
			);
		}
		expect(
			() =>
				new Constructor(graph, undefined, {
					maxEpochVertices: "2" as unknown as number,
				})
		).toThrow("maxEpochVertices must be a positive safe integer");
		expect(new Constructor(graph, undefined, { maxEpochVertices: Number.MAX_SAFE_INTEGER }).size).toBe(1);
		for (const absentOptions of [{}, { maxEpochVertices: undefined }]) {
			const unbounded = new Constructor(graph, undefined, absentOptions as CapacityOptions);
			const first = vertex("explicit-absent-first", epochAnchor.hash);
			const second = vertex("explicit-absent-second", first.hash);
			expect(unbounded.append(first.hash, first)).toBeUndefined();
			expect(unbounded.append(second.hash, second)).toBeUndefined();
			expect(unbounded.size).toBe(3);
		}
		const index = new Constructor(graph, undefined, { maxEpochVertices: 1 });
		expect(index.size).toBe(1);
		const first = vertex("cap-one-first", epochAnchor.hash);
		expect(index.append(first.hash, first)).toEqual(outcome());
		expect({ present: index.has(first.hash), size: index.size }).toEqual({ present: false, size: 1 });
	});

	it("[exact-boundary] admits N-1 ordinary vertices with exact ancestry, then refuses N+1 before publication", async () => {
		const epochAnchorHash = hashFor("anchor");
		const a = vertex("boundary-a", epochAnchorHash);
		const b = vertex("boundary-b", a.hash);
		const refused = vertex("boundary-refused", b.hash);
		const index = await emptyIndex(3);

		expect(index.append(a.hash, a)).toBeUndefined();
		expect(index.append(b.hash, b)).toBeUndefined();
		const stable = relationSnapshot(index, [epochAnchorHash, a.hash, b.hash, refused.hash]);
		expect(stable).toMatchObject({
			keys: [true, true, true, false],
			size: 3,
		});
		expect(index.isAncestor(epochAnchorHash, b.hash)).toBe(true);
		expect(index.isAncestor(a.hash, b.hash)).toBe(true);

		expect(index.append(refused.hash, refused)).toEqual(outcome());
		expect(relationSnapshot(index, [epochAnchorHash, a.hash, b.hash, refused.hash])).toEqual(stable);
	});

	it("[prepublication] never exposes a refused hash or ancestor row", async () => {
		const epochAnchorHash = hashFor("anchor");
		const accepted = vertex("prepublication-accepted", epochAnchorHash);
		const refused = vertex("prepublication-refused", accepted.hash);
		const index = await emptyIndex(2);
		index.append(accepted.hash, accepted);
		const stable = relationSnapshot(index, [epochAnchorHash, accepted.hash, refused.hash]);

		expect(index.append(refused.hash, refused)).toEqual(outcome());
		expect(relationSnapshot(index, [epochAnchorHash, accepted.hash, refused.hash])).toEqual(stable);
		expect(index.isAncestor(accepted.hash, refused.hash)).toBe(false);
	});

	it("[duplicate-charge] preserves duplicate rejection and charges no additional capacity", async () => {
		const epochAnchorHash = hashFor("anchor");
		const a = vertex("duplicate-a", epochAnchorHash);
		const b = vertex("duplicate-b", a.hash);
		const refused = vertex("duplicate-refused", b.hash);
		const index = await emptyIndex(3);
		expect(index.append(a.hash, a)).toBeUndefined();
		expect(capturedError(() => index.append(a.hash, a))).toMatchObject({ code: "DUPLICATE_VERTEX" });
		expect(index.append(b.hash, b)).toBeUndefined();
		expect(index.append(refused.hash, refused)).toEqual(outcome());
		expect({ a: index.has(a.hash), b: index.has(b.hash), size: index.size }).toEqual({
			a: true,
			b: true,
			size: 3,
		});
	});

	it("[nonlatched-redelivery] returns the same pending result on retry and permits reevaluation in a larger index", async () => {
		const epochAnchorHash = hashFor("anchor");
		const accepted = vertex("retry-accepted", epochAnchorHash);
		const retried = vertex("retry-candidate", accepted.hash);
		const full = await emptyIndex(2);
		full.append(accepted.hash, accepted);
		expect(full.append(retried.hash, retried)).toEqual(outcome());
		expect(full.append(retried.hash, retried)).toEqual(outcome());
		expect(full.has(retried.hash)).toBe(false);

		const Constructor = await constructor();
		const graph = new Map<string, EpochVertex>([
			[epochAnchorHash, anchor()],
			[accepted.hash, accepted],
		]);
		const reevaluated = new Constructor(graph, [epochAnchorHash, accepted.hash], { maxEpochVertices: 3 });
		expect(reevaluated.append(retried.hash, retried)).toBeUndefined();
		expect({ present: reevaluated.has(retried.hash), size: reevaluated.size }).toEqual({
			present: true,
			size: 3,
		});
	});

	it("[reentrant-fill] rechecks capacity after candidate observation and before bitset publication", async () => {
		const epochAnchorHash = hashFor("anchor");
		const base = vertex("reentrant-base", epochAnchorHash);
		const nested = vertex("reentrant-nested", base.hash);
		const outerHash = hashFor("reentrant-outer");
		const index = await emptyIndex(3);
		expect(index.append(base.hash, base)).toBeUndefined();
		let dependencyReads = 0;
		let nestedResult: undefined | EpochFullOutcome;
		const outer = {
			anchor: epochAnchorHash,
			get dependencies(): readonly string[] {
				dependencyReads++;
				nestedResult = index.append(nested.hash, nested);
				return [base.hash];
			},
			epoch: 23,
			hash: outerHash,
			kind: "drp-vertex" as const,
			objectId: OBJECT_ID,
		};

		const result = index.append(outerHash, outer);

		expect(nestedResult).toBeUndefined();
		expect(result).toEqual(outcome());
		expect(Object.isFrozen(result)).toBe(true);
		expect({
			anchorOfNested: index.isAncestor(epochAnchorHash, nested.hash),
			baseOfNested: index.isAncestor(base.hash, nested.hash),
			dependencyReads,
			nestedPresent: index.has(nested.hash),
			outerPresent: index.has(outerHash),
			size: index.size,
		}).toEqual({
			anchorOfNested: true,
			baseOfNested: true,
			dependencyReads: 1,
			nestedPresent: true,
			outerPresent: false,
			size: 3,
		});
	});

	it("[no-final-winner] opposing final-slot schedules expose no membership decision in the capacity result", async () => {
		const epochAnchorHash = hashFor("anchor");
		const base = vertex("schedule-base", epochAnchorHash);
		const left = vertex("schedule-left", base.hash);
		const right = vertex("schedule-right", base.hash);
		const leftFirst = await emptyIndex(3);
		const rightFirst = await emptyIndex(3);
		leftFirst.append(base.hash, base);
		rightFirst.append(base.hash, base);

		expect(leftFirst.append(left.hash, left)).toBeUndefined();
		const leftResult = leftFirst.append(right.hash, right);
		expect(rightFirst.append(right.hash, right)).toBeUndefined();
		const rightResult = rightFirst.append(left.hash, left);

		expect(leftResult).toEqual(outcome());
		expect(rightResult).toEqual(outcome());
		expect(Object.isFrozen(leftResult)).toBe(true);
		expect(Object.isFrozen(rightResult)).toBe(true);
		expect(Object.keys(leftResult as EpochFullOutcome).sort()).toEqual(["code", "latchByHash", "status"]);
		expect(Object.keys(rightResult as EpochFullOutcome).sort()).toEqual(["code", "latchByHash", "status"]);
		expect({
			leftFirst: [leftFirst.has(left.hash), leftFirst.has(right.hash)],
			rightFirst: [rightFirst.has(left.hash), rightFirst.has(right.hash)],
		}).toEqual({
			leftFirst: [true, false],
			rightFirst: [false, true],
		});
	});

	it("[initial-capacity] accepts an exact-cap graph and rejects oversize before graph traversal or bitset allocation", async () => {
		const Constructor = await constructor();
		const epochAnchor = anchor();
		const accepted = vertex("initial-accepted", epochAnchor.hash);
		const exact = new Constructor(
			new Map([
				[epochAnchor.hash, epochAnchor],
				[accepted.hash, accepted],
			]),
			[epochAnchor.hash, accepted.hash],
			{ maxEpochVertices: 2 }
		);
		expect({ ancestor: exact.isAncestor(epochAnchor.hash, accepted.hash), size: exact.size }).toEqual({
			ancestor: true,
			size: 2,
		});

		const poisonHash = hashFor("initial-poison");
		const poison = {
			anchor: epochAnchor.hash,
			get dependencies(): readonly string[] {
				throw new Error("INITIAL_GRAPH_WAS_TRAVERSED");
			},
			epoch: 23,
			hash: poisonHash,
			get kind(): "drp-vertex" {
				throw new Error("INITIAL_GRAPH_WAS_TRAVERSED");
			},
			objectId: OBJECT_ID,
		};
		const error = capturedError(
			() =>
				new Constructor(
					new Map<string, EpochVertex>([
						[poisonHash, poison],
						[epochAnchor.hash, epochAnchor],
					]),
					undefined,
					{ maxEpochVertices: 1 }
				)
		);
		expect(error).toMatchObject({ code: contract.initialOversizeCode });
		expect(String(error)).not.toContain("INITIAL_GRAPH_WAS_TRAVERSED");
	});

	it("[absent-capacity] preserves legacy append results and exact ancestry without a hidden default", async () => {
		const epochAnchorHash = hashFor("anchor");
		const index = await emptyIndex();
		const hashes: string[] = [];
		let dependency = epochAnchorHash;
		for (let position = 0; position < 40; position++) {
			const candidate = vertex(`unbounded-${position}`, dependency);
			expect(index.append(candidate.hash, candidate)).toBeUndefined();
			hashes.push(candidate.hash);
			dependency = candidate.hash;
		}
		expect({
			anchorOfLast: index.isAncestor(epochAnchorHash, hashes[39] as string),
			firstOfLast: index.isAncestor(hashes[0] as string, hashes[39] as string),
			size: index.size,
		}).toEqual({ anchorOfLast: true, firstOfLast: true, size: 41 });
	});
});

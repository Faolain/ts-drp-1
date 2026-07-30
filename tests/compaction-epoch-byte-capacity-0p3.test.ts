/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0p3-v3/epoch-byte-capacity-contract.json" with { type: "json" };

interface EpochVertex {
	readonly anchor?: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly hash: string;
	readonly kind: "drp-epoch-anchor" | "drp-vertex";
	readonly objectId: string;
}
interface ByteCapacityOptions {
	readonly initialByteCharges?: ReadonlyMap<string, number> | undefined;
	readonly maxEpochBytes?: number | undefined;
	readonly maxEpochVertices?: number | undefined;
}
interface EpochFullOutcome {
	readonly code: "EPOCH_FULL";
	readonly latchByHash: false;
	readonly status: "pending";
}
interface Index {
	readonly size: number;
	append(hash: string, vertex: EpochVertex, byteCharge?: number): undefined | EpochFullOutcome;
	has(hash: string): boolean;
	isAncestor(ancestorHash: string, descendantHash: string): boolean;
}
type IndexConstructor = new (
	vertices: ReadonlyMap<string, EpochVertex>,
	order?: readonly string[],
	options?: ByteCapacityOptions
) => Index;
interface Surface {
	readonly CausalityIndex?: IndexConstructor;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const IMPLEMENTATION =
	process.env.PHASE_0P3_IMPLEMENTATION_MODULE === undefined
		? resolve(HERE, contract.implementationModule)
		: resolve(ROOT, process.env.PHASE_0P3_IMPLEMENTATION_MODULE);
const loaded = import(pathToFileURL(IMPLEMENTATION).href) as Promise<Surface>;
const OBJECT_ID = "phase-0p3-object";

function hashFor(label: string): string {
	return createHash("sha256").update(`phase-0p3:${label}`).digest("hex");
}
function anchor(label = "anchor"): EpochVertex {
	return {
		dependencies: [],
		epoch: 29,
		hash: hashFor(label),
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
	};
}
function vertex(label: string, dependency: string, anchorHash = hashFor("anchor")): EpochVertex {
	return {
		anchor: anchorHash,
		dependencies: [dependency],
		epoch: 29,
		hash: hashFor(label),
		kind: "drp-vertex",
		objectId: OBJECT_ID,
	};
}
function outcome(): EpochFullOutcome {
	return { code: "EPOCH_FULL", latchByHash: false, status: "pending" };
}
async function constructor(): Promise<IndexConstructor> {
	const surface = await loaded;
	if (typeof surface.CausalityIndex !== "function") {
		throw new Error("PHASE_0P3_MISSING_CAUSALITY_INDEX");
	}
	return surface.CausalityIndex;
}
async function byteIndex({
	anchorLabel = "anchor",
	anchorCharge,
	maxEpochBytes,
	maxEpochVertices,
}: {
	anchorLabel?: string;
	anchorCharge: number;
	maxEpochBytes: number;
	maxEpochVertices?: number;
}): Promise<Index> {
	const Constructor = await constructor();
	const epochAnchor = anchor(anchorLabel);
	return new Constructor(new Map([[epochAnchor.hash, epochAnchor]]), undefined, {
		initialByteCharges: new Map([[epochAnchor.hash, anchorCharge]]),
		maxEpochBytes,
		maxEpochVertices,
	});
}
function capturedError(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}
function errorCode(error: unknown): unknown {
	return error !== null && typeof error === "object" && "code" in error
		? (error as { code?: unknown }).code
		: undefined;
}
function relationSnapshot(index: Index, hashes: readonly string[]) {
	return {
		keys: hashes.map((hash) => index.has(hash)),
		relations: hashes.map((descendant) => hashes.map((ancestorHash) => index.isAncestor(ancestorHash, descendant))),
		size: index.size,
	};
}

describe("Phase 0p-3 anchor-inclusive epoch-byte capacity causal RED", () => {
	it("[governance] freezes a separate provenance-neutral byte-capacity family and preserves the predecessor", () => {
		const directory = resolve(HERE, contract.conformanceDirectory);
		const predecessor = resolve(HERE, contract.predecessorConformanceDirectory);
		expect(existsSync(directory)).toBe(true);
		expect(readdirSync(directory).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		expect(readdirSync(predecessor).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		const predecessorProfile = JSON.parse(readFileSync(resolve(predecessor, "profile.json"), "utf8"));
		expect(predecessorProfile.claims.maxEpochBytes).toBe(false);

		const profile = JSON.parse(readFileSync(resolve(directory, "profile.json"), "utf8"));
		expect(profile).toMatchObject({
			profileId: contract.profileId,
			accounting: {
				anchorInclusive: true,
				comparison: "charge <= maxEpochBytes - total",
				duplicateCharge: 0,
				refusalCharge: 0,
			},
			api: {
				appendChargeArgument: contract.appendChargeArgument,
				initialChargesOption: contract.initialChargesOption,
				optional: true,
				returnUnion: "undefined | EpochFullOutcome",
			},
			claims: {
				carrierAuthentication: false,
				carrierMeasurement: false,
				finalMembershipAuthority: false,
				parametersDigestAuthentication: false,
			},
		});
		const normalizedSpec = readFileSync(resolve(directory, "spec.md"), "utf8").replace(/\s+/gu, " ");
		for (const phrase of [
			"exact graph keyset",
			"read exactly once",
			"Map's intrinsic entries",
			"Overridden `size`, `keys`, `entries`, `has`, `get`",
			"incompatible Proxy or Map pretender",
			"including the anchor",
			"charge <= maxEpochBytes - total",
			"count-first",
			"three-way rollback",
			"provenance-neutral",
			"Phase 3a",
			"does not name a winner",
		]) {
			expect(normalizedSpec).toContain(phrase);
		}
	});

	it("[ceiling-domain-and-absent] validates only an opted-in positive safe byte ceiling and preserves legacy calls", async () => {
		const Constructor = await constructor();
		const epochAnchor = anchor("domain-anchor");
		const graph = new Map([[epochAnchor.hash, epochAnchor]]);
		for (const maxEpochBytes of [
			0,
			-1,
			1.5,
			Number.NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			"8" as unknown as number,
		]) {
			expect(
				() =>
					new Constructor(graph, undefined, {
						initialByteCharges: new Map([[epochAnchor.hash, 1]]),
						maxEpochBytes,
					})
			).toThrow("maxEpochBytes must be a positive safe integer");
		}
		let poisonChargeReads = 0;
		class PoisonCharges extends Map<string, number> {
			override get(key: string): number | undefined {
				poisonChargeReads++;
				throw new Error(`INVALID_CEILING_READ_INITIAL_CHARGE:${key}`);
			}
		}
		expect(
			() =>
				new Constructor(graph, undefined, {
					initialByteCharges: new PoisonCharges([[epochAnchor.hash, 1]]),
					maxEpochBytes: 0,
				})
		).toThrow("maxEpochBytes must be a positive safe integer");
		expect(poisonChargeReads).toBe(0);
		const unbounded = new Constructor(graph, undefined, {
			initialByteCharges: new Map([["not-the-graph", -1]]),
		});
		const first = vertex("absent-first", epochAnchor.hash, epochAnchor.hash);
		const second = vertex("absent-second", first.hash, epochAnchor.hash);
		expect(unbounded.append(first.hash, first, -1)).toBeUndefined();
		expect(unbounded.append(second.hash, second)).toBeUndefined();
		expect({
			anchorOfSecond: unbounded.isAncestor(epochAnchor.hash, second.hash),
			firstOfSecond: unbounded.isAncestor(first.hash, second.hash),
			size: unbounded.size,
		}).toEqual({ anchorOfSecond: true, firstOfSecond: true, size: 3 });
	});

	it("[charge-domain-and-precheck] requires positive safe inert charges before candidate observation", async () => {
		const Constructor = await constructor();
		const epochAnchor = anchor("charge-domain-anchor");
		const graph = new Map([[epochAnchor.hash, epochAnchor]]);
		for (const invalidCharge of [
			undefined,
			0,
			-1,
			1.5,
			Number.NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			"1" as unknown as number,
		]) {
			const error = capturedError(
				() =>
					new Constructor(graph, undefined, {
						initialByteCharges: new Map([[epochAnchor.hash, invalidCharge as number]]),
						maxEpochBytes: Number.MAX_SAFE_INTEGER,
					})
			);
			expect(errorCode(error)).toBe(contract.invalidChargesCode);
		}
		const overflowVertex = vertex("charge-domain-overflow", epochAnchor.hash, epochAnchor.hash);
		const overflowError = capturedError(
			() =>
				new Constructor(
					new Map([
						[epochAnchor.hash, epochAnchor],
						[overflowVertex.hash, overflowVertex],
					]),
					[epochAnchor.hash, overflowVertex.hash],
					{
						initialByteCharges: new Map([
							[epochAnchor.hash, Number.MAX_SAFE_INTEGER],
							[overflowVertex.hash, Number.MAX_SAFE_INTEGER],
						]),
						maxEpochBytes: Number.MAX_SAFE_INTEGER,
					}
				)
		);
		expect(errorCode(overflowError)).toBe(contract.invalidChargesCode);

		const index = await byteIndex({ anchorCharge: 1, maxEpochBytes: 10 });
		for (const invalidCharge of [
			undefined,
			0,
			-1,
			1.5,
			Number.NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			"1" as unknown as number,
		]) {
			const candidate = vertex(`append-invalid-${String(invalidCharge)}`, hashFor("anchor"));
			expect(errorCode(capturedError(() => index.append(candidate.hash, candidate, invalidCharge as number)))).toBe(
				contract.invalidChargesCode
			);
			expect(index.has(candidate.hash)).toBe(false);
		}
		const poisonHash = hashFor("byte-precheck-poison");
		const poison = new Proxy({} as EpochVertex, {
			get() {
				throw new Error("BYTE_PRECHECK_OBSERVED_CANDIDATE");
			},
		});
		expect(index.append(poisonHash, poison, 10)).toEqual(outcome());
		expect(index.has(poisonHash)).toBe(false);
	});

	it("[initial-keyset-read-once] requires exact keys including the anchor and snapshots initial numeric values", async () => {
		const Constructor = await constructor();
		const keysetAnchor = anchor("keyset-anchor");
		const extra = hashFor("keyset-extra");
		const laxError = capturedError(
			() =>
				new Constructor(new Map([[keysetAnchor.hash, keysetAnchor]]), undefined, {
					initialByteCharges: new Map([[extra, 4]]),
					maxEpochBytes: 10,
				})
		);
		expect(errorCode(laxError)).toBe(contract.invalidChargesCode);

		const mutableAnchor = anchor("mutable-anchor");
		const mutableChild = vertex("mutable-child", mutableAnchor.hash, mutableAnchor.hash);
		const charges = new Map([
			[mutableAnchor.hash, 6],
			[mutableChild.hash, 2],
		]);
		const snapshotted = new Constructor(
			new Map([
				[mutableAnchor.hash, mutableAnchor],
				[mutableChild.hash, mutableChild],
			]),
			[mutableAnchor.hash, mutableChild.hash],
			{
				initialByteCharges: charges,
				maxEpochBytes: 10,
			}
		);
		charges.set(mutableAnchor.hash, 1);
		charges.set(mutableChild.hash, 1);
		const refused = vertex("mutable-refused", mutableChild.hash, mutableAnchor.hash);
		expect(snapshotted.append(refused.hash, refused, 3)).toEqual(outcome());
		expect({
			present: snapshotted.has(refused.hash),
			size: snapshotted.size,
		}).toEqual({
			present: false,
			size: 2,
		});
	});

	it("[intrinsic-initial-entry-snapshot] snapshots exact intrinsic Map entries once before vertex observation", async () => {
		const Constructor = await constructor();
		const intrinsicAnchor = anchor("intrinsic-keyset-anchor");
		const extra = hashFor("intrinsic-keyset-extra");
		const virtualCalls = {
			entries: 0,
			get: 0,
			has: 0,
			iterator: 0,
			keys: 0,
			size: 0,
		};
		class SpoofedCharges extends Map<string, number> {
			override get size(): number {
				virtualCalls.size++;
				return 1;
			}

			override entries() {
				virtualCalls.entries++;
				throw new Error("OVERRIDDEN_INITIAL_ENTRIES_USED");
			}

			override get(key: string): number | undefined {
				virtualCalls.get++;
				return key === intrinsicAnchor.hash ? 1 : undefined;
			}

			override has(key: string): boolean {
				virtualCalls.has++;
				return key === intrinsicAnchor.hash;
			}

			override [Symbol.iterator]() {
				virtualCalls.iterator++;
				throw new Error("OVERRIDDEN_INITIAL_ITERATOR_USED");
			}

			override keys() {
				virtualCalls.keys++;
				throw new Error("OVERRIDDEN_INITIAL_KEYS_USED");
			}
		}
		const graph = new Map([[intrinsicAnchor.hash, intrinsicAnchor]]);
		const hiddenExtraError = capturedError(
			() =>
				new Constructor(graph, undefined, {
					initialByteCharges: new SpoofedCharges([
						[intrinsicAnchor.hash, 1],
						[extra, 9],
					]),
					maxEpochBytes: 1,
				})
		);
		expect(errorCode(hiddenExtraError)).toBe(contract.invalidChargesCode);
		const missingAnchorError = capturedError(
			() =>
				new Constructor(graph, undefined, {
					initialByteCharges: new SpoofedCharges([[extra, 9]]),
					maxEpochBytes: 1,
				})
		);
		expect(errorCode(missingAnchorError)).toBe(contract.invalidChargesCode);

		const validCharges = new SpoofedCharges([[intrinsicAnchor.hash, 1]]);
		const snapshotted = new Constructor(graph, undefined, {
			initialByteCharges: validCharges,
			maxEpochBytes: 2,
		});
		validCharges.set(intrinsicAnchor.hash, 2);
		const afterMutation = vertex("intrinsic-after-mutation", intrinsicAnchor.hash, intrinsicAnchor.hash);
		expect(snapshotted.append(afterMutation.hash, afterMutation, 1)).toBeUndefined();
		expect(virtualCalls).toEqual({
			entries: 0,
			get: 0,
			has: 0,
			iterator: 0,
			keys: 0,
			size: 0,
		});

		const poisonHash = hashFor("intrinsic-keyset-poison");
		let vertexObservations = 0;
		const poison = {
			dependencies: [],
			epoch: 29,
			hash: poisonHash,
			get kind(): "drp-epoch-anchor" {
				vertexObservations++;
				throw new Error("INCOMPATIBLE_INITIAL_CHARGES_OBSERVED_VERTEX");
			},
			objectId: OBJECT_ID,
		};
		const poisonGraph = new Map<string, EpochVertex>([[poisonHash, poison]]);
		const revoked = Proxy.revocable(new Map([[poisonHash, 1]]), {});
		revoked.revoke();
		const incompatibleCharges: ReadonlyMap<string, number>[] = [
			new Proxy(new Map([[poisonHash, 1]]), {}),
			new Proxy(new Map([[poisonHash, 1]]), {
				getPrototypeOf() {
					throw new Error("INCOMPATIBLE_INITIAL_CHARGES_BRAND_TRAP");
				},
			}),
			revoked.proxy,
			Object.create(Map.prototype) as ReadonlyMap<string, number>,
		];
		for (const charges of incompatibleCharges) {
			const error = capturedError(
				() =>
					new Constructor(poisonGraph, undefined, {
						initialByteCharges: charges,
						maxEpochBytes: 1,
					})
			);
			expect(errorCode(error)).toBe(contract.invalidChargesCode);
			expect(String(error)).not.toContain("INCOMPATIBLE_INITIAL_CHARGES_OBSERVED_VERTEX");
		}
		expect(vertexObservations).toBe(0);
	});

	it("[initial-precedence] rejects invalid charge shape/keyset before count oversize and without vertex observation", async () => {
		const Constructor = await constructor();
		const epochAnchor = anchor("precedence-anchor");
		const poisonHash = hashFor("precedence-poison");
		const poison = {
			get anchor(): string {
				throw new Error("INITIAL_VERTEX_OBSERVED");
			},
			get dependencies(): readonly string[] {
				throw new Error("INITIAL_VERTEX_OBSERVED");
			},
			epoch: 29,
			hash: poisonHash,
			get kind(): "drp-vertex" {
				throw new Error("INITIAL_VERTEX_OBSERVED");
			},
			objectId: OBJECT_ID,
		};
		const error = capturedError(
			() =>
				new Constructor(
					new Map<string, EpochVertex>([
						[epochAnchor.hash, epochAnchor],
						[poisonHash, poison],
					]),
					undefined,
					{
						initialByteCharges: new Map([[epochAnchor.hash, 100]]),
						maxEpochBytes: 1,
						maxEpochVertices: 1,
					}
				)
		);
		expect(errorCode(error)).toBe(contract.invalidChargesCode);
		expect(String(error)).not.toContain("INITIAL_VERTEX_OBSERVED");

		const AllocationProbe = Uint32Array;
		let bitsetAllocations = 0;
		globalThis.Uint32Array = new Proxy(AllocationProbe, {
			construct(target, argumentsList, newTarget) {
				bitsetAllocations++;
				return Reflect.construct(target, argumentsList, newTarget);
			},
		}) as Uint32ArrayConstructor;
		const allocationAnchor = anchor("allocation-probe-anchor");
		let allocationError: unknown;
		try {
			allocationError = capturedError(
				() =>
					new Constructor(new Map([[allocationAnchor.hash, allocationAnchor]]), undefined, {
						initialByteCharges: new Map([[allocationAnchor.hash, 2]]),
						maxEpochBytes: 1,
					})
			);
		} finally {
			globalThis.Uint32Array = AllocationProbe;
		}
		expect(errorCode(allocationError)).toBe(contract.initialOversizeCode);
		expect(bitsetAllocations).toBe(0);

		const countAnchor = anchor("precedence-count-anchor");
		const countChild = vertex("precedence-count-child", countAnchor.hash, countAnchor.hash);
		const countBeforeByte = capturedError(
			() =>
				new Constructor(
					new Map([
						[countAnchor.hash, countAnchor],
						[countChild.hash, countChild],
					]),
					[countAnchor.hash, countChild.hash],
					{
						initialByteCharges: new Map([
							[countAnchor.hash, 2],
							[countChild.hash, 2],
						]),
						maxEpochBytes: 1,
						maxEpochVertices: 1,
					}
				)
		);
		expect(errorCode(countBeforeByte)).toBe(contract.initialOversizeCode);
		expect(String(countBeforeByte)).toContain("maxEpochVertices");
	});

	it("[initial-boundary-and-precedence] accepts equality and rejects byte oversize after count checks but before anchor discovery", async () => {
		const Constructor = await constructor();
		const exactAnchor = anchor("initial-exact-anchor");
		const exact = new Constructor(new Map([[exactAnchor.hash, exactAnchor]]), undefined, {
			initialByteCharges: new Map([[exactAnchor.hash, 7]]),
			maxEpochBytes: 7,
			maxEpochVertices: 1,
		});
		expect(exact.size).toBe(1);

		const omittedAnchorHash = hashFor("anchor-omitted-anchor");
		const omittedAnchor = {
			dependencies: [],
			epoch: 29,
			hash: omittedAnchorHash,
			get kind(): "drp-epoch-anchor" {
				throw new Error("ANCHOR_DISCOVERY_RAN_BEFORE_BYTE_OVERSIZE");
			},
			objectId: OBJECT_ID,
		};
		const error = capturedError(
			() =>
				new Constructor(new Map([[omittedAnchorHash, omittedAnchor]]), undefined, {
					initialByteCharges: new Map([[omittedAnchorHash, 8]]),
					maxEpochBytes: 7,
					maxEpochVertices: 1,
				})
		);
		expect(errorCode(error)).toBe(contract.initialOversizeCode);
		expect(String(error)).not.toContain("ANCHOR_DISCOVERY_RAN_BEFORE_BYTE_OVERSIZE");

		const lateAnchorHash = hashFor("late-byte-anchor");
		const lateAnchor = {
			dependencies: [],
			epoch: 29,
			hash: lateAnchorHash,
			get kind(): "drp-epoch-anchor" {
				throw new Error("LATE_INITIAL_BYTE_CHECK");
			},
			objectId: OBJECT_ID,
		};
		const lateError = capturedError(
			() =>
				new Constructor(new Map([[lateAnchorHash, lateAnchor]]), undefined, {
					initialByteCharges: new Map([[lateAnchorHash, 2]]),
					maxEpochBytes: 1,
				})
		);
		expect(errorCode(lateError)).toBe(contract.initialOversizeCode);
		expect(String(lateError)).not.toContain("LATE_INITIAL_BYTE_CHECK");
	});

	it("[B-minus-one-B-B-plus-one] applies exact subtraction-safe equality at append", async () => {
		const index = await byteIndex({ anchorCharge: 5, maxEpochBytes: 10 });
		const below = vertex("boundary-below", hashFor("anchor"));
		const equal = vertex("boundary-equal", below.hash);
		const above = vertex("boundary-above", equal.hash);
		expect(index.append(below.hash, below, 4)).toBeUndefined();
		expect(index.append(equal.hash, equal, 1)).toBeUndefined();
		expect(index.append(above.hash, above, 1)).toEqual(outcome());
		expect(relationSnapshot(index, [hashFor("anchor"), below.hash, equal.hash, above.hash])).toMatchObject({
			keys: [true, true, true, false],
			size: 3,
		});
	});

	it("[reachable-32-bit-boundary] never truncates or wraps a reachable safe-integer running total", async () => {
		const anchorCharge = 2 ** 32 + 1;
		const index = await byteIndex({ anchorCharge, maxEpochBytes: anchorCharge + 20 });
		const accepted = vertex("wrap-candidate", hashFor("anchor"));
		const refused = vertex("wrap-refused", accepted.hash);
		expect(index.append(accepted.hash, accepted, 10)).toBeUndefined();
		expect(index.append(refused.hash, refused, 11)).toEqual(outcome());
		expect({ accepted: index.has(accepted.hash), refused: index.has(refused.hash), size: index.size }).toEqual({
			accepted: true,
			refused: false,
			size: 2,
		});
	});

	it("[duplicate-and-refusal-zero-charge] charges neither duplicate delivery nor a structurally refused candidate", async () => {
		const duplicateIndex = await byteIndex({ anchorCharge: 3, maxEpochBytes: 10 });
		const duplicate = vertex("duplicate-candidate", hashFor("anchor"));
		const afterDuplicate = vertex("duplicate-after", duplicate.hash);
		expect(duplicateIndex.append(duplicate.hash, duplicate, 3)).toBeUndefined();
		expect(errorCode(capturedError(() => duplicateIndex.append(duplicate.hash, duplicate, 3)))).toBe(
			"DUPLICATE_VERTEX"
		);
		expect(duplicateIndex.append(afterDuplicate.hash, afterDuplicate, 4)).toBeUndefined();

		const refusalIndex = await byteIndex({ anchorCharge: 3, maxEpochBytes: 10 });
		const refusedHash = hashFor("refused-candidate");
		const refused = vertex("refused-candidate", hashFor("refused-missing"));
		expect(errorCode(capturedError(() => refusalIndex.append(refusedHash, refused, 4)))).toBe("MISSING_DEPENDENCY");
		const afterRefusal = vertex("refused-after", hashFor("anchor"));
		expect(refusalIndex.append(afterRefusal.hash, afterRefusal, 7)).toBeUndefined();
		expect({ duplicateSize: duplicateIndex.size, refusalSize: refusalIndex.size }).toEqual({
			duplicateSize: 3,
			refusalSize: 2,
		});
	});

	it("[count-saturated-skip] keeps duplicate-first and returns EPOCH_FULL before charge or candidate observation", async () => {
		const index = await byteIndex({
			anchorCharge: 1,
			maxEpochBytes: 100,
			maxEpochVertices: 1,
		});
		const poisonHash = hashFor("count-saturated-poison");
		const poison = new Proxy({} as EpochVertex, {
			get() {
				throw new Error("COUNT_SATURATED_CANDIDATE_OBSERVED");
			},
		});
		expect(index.append(poisonHash, poison, Number.NaN)).toEqual(outcome());
		expect(index.append(poisonHash, poison, 0)).toEqual(outcome());
		const epochAnchor = anchor();
		expect(errorCode(capturedError(() => index.append(epochAnchor.hash, epochAnchor, Number.NaN)))).toBe(
			"DUPLICATE_VERTEX"
		);
		expect(index.size).toBe(1);
	});

	it("[shared-nonterminal-nonlatched-outcome] both caps return the identical closed reevaluable EPOCH_FULL", async () => {
		const byteFull = await byteIndex({ anchorCharge: 5, maxEpochBytes: 5, maxEpochVertices: 2 });
		const terminalCandidate = vertex("terminal-candidate", hashFor("anchor"));
		const byteResult = byteFull.append(terminalCandidate.hash, terminalCandidate, 1);
		expect(byteResult).toEqual(outcome());
		expect(Object.isFrozen(byteResult)).toBe(true);
		expect(Object.keys(byteResult as EpochFullOutcome).sort()).toEqual(["code", "latchByHash", "status"]);

		const countFull = await byteIndex({ anchorCharge: 1, maxEpochBytes: 100, maxEpochVertices: 1 });
		const countCandidate = vertex("both-count-candidate", hashFor("anchor"));
		const countResult = countFull.append(countCandidate.hash, countCandidate, 1);
		expect(countResult).toBe(byteResult);

		const latched = await byteIndex({ anchorCharge: 4, maxEpochBytes: 5 });
		const latchedCandidate = vertex("latched-candidate", hashFor("anchor"));
		expect(latched.append(latchedCandidate.hash, latchedCandidate, 2)).toEqual(outcome());
		expect(latched.append(latchedCandidate.hash, latchedCandidate, 1)).toBeUndefined();
		expect(latched.has(latchedCandidate.hash)).toBe(true);
	});

	it("[both-cap-enforcement] neither count nor byte capacity may stand in for the other", async () => {
		const byteLimited = await byteIndex({ anchorCharge: 5, maxEpochBytes: 5, maxEpochVertices: 10 });
		const byteCandidate = vertex("byte-only-candidate", hashFor("anchor"));
		expect(byteLimited.append(byteCandidate.hash, byteCandidate, 1)).toEqual(outcome());

		const countLimited = await byteIndex({ anchorCharge: 1, maxEpochBytes: 100, maxEpochVertices: 1 });
		const countCandidate = vertex("count-only-candidate", hashFor("anchor"));
		expect(countLimited.append(countCandidate.hash, countCandidate, 1)).toEqual(outcome());
		expect({ byteSize: byteLimited.size, countSize: countLimited.size }).toEqual({
			byteSize: 1,
			countSize: 1,
		});
	});

	it("[nested-reentrant-dual-recheck] rechecks current byte and count totals after once-capturing a nested candidate", async () => {
		const epochAnchorHash = hashFor("anchor");
		const index = await byteIndex({ anchorCharge: 10, maxEpochBytes: 30, maxEpochVertices: 4 });
		const base = vertex("reentrant-base", epochAnchorHash);
		const nested = vertex("reentrant-nested", base.hash);
		expect(index.append(base.hash, base, 1)).toBeUndefined();
		let dependencyReads = 0;
		let nestedResult: undefined | EpochFullOutcome;
		const outerHash = hashFor("reentrant-outer");
		const outer = {
			anchor: epochAnchorHash,
			get dependencies(): readonly string[] {
				dependencyReads++;
				nestedResult = index.append(nested.hash, nested, 10);
				return [base.hash];
			},
			epoch: 29,
			hash: outerHash,
			kind: "drp-vertex" as const,
			objectId: OBJECT_ID,
		};
		const result = index.append(outerHash, outer, 10);
		expect(nestedResult).toBeUndefined();
		expect(result).toEqual(outcome());
		expect({
			baseOfNested: index.isAncestor(base.hash, nested.hash),
			dependencyReads,
			nestedPresent: index.has(nested.hash),
			outerPresent: index.has(outerHash),
			size: index.size,
		}).toEqual({
			baseOfNested: true,
			dependencyReads: 1,
			nestedPresent: true,
			outerPresent: false,
			size: 3,
		});

		const countIndex = await byteIndex({ anchorCharge: 1, maxEpochBytes: 100, maxEpochVertices: 2 });
		const countNested = vertex("reentrant-count-nested", epochAnchorHash);
		const countOuterHash = hashFor("reentrant-count-outer");
		const countOuter = {
			anchor: epochAnchorHash,
			get dependencies(): readonly string[] {
				expect(countIndex.append(countNested.hash, countNested, 1)).toBeUndefined();
				return [epochAnchorHash];
			},
			epoch: 29,
			hash: countOuterHash,
			kind: "drp-vertex" as const,
			objectId: OBJECT_ID,
		};
		expect(countIndex.append(countOuterHash, countOuter, 1)).toEqual(outcome());
		expect({
			nestedPresent: countIndex.has(countNested.hash),
			outerPresent: countIndex.has(countOuterHash),
			size: countIndex.size,
		}).toEqual({ nestedPresent: true, outerPresent: false, size: 2 });
	});

	it("[three-way-rollback] publication failure rolls back ancestor row, index row and byte charge", async () => {
		const epochAnchorHash = hashFor("anchor");
		const index = await byteIndex({ anchorCharge: 4, maxEpochBytes: 10 });
		const base = vertex("rollback-base", epochAnchorHash);
		expect(index.append(base.hash, base, 1)).toBeUndefined();
		const failing = vertex("rollback-failing", base.hash);
		const originalSet = Map.prototype.set;
		Map.prototype.set = function patchedSet(key: unknown, value: unknown) {
			const result = originalSet.call(this, key, value);
			if (key === failing.hash) throw new Error("INJECTED_INDEX_PUBLICATION_FAILURE");
			return result;
		};
		try {
			expect(() => index.append(failing.hash, failing, 2)).toThrow("INJECTED_INDEX_PUBLICATION_FAILURE");
		} finally {
			Map.prototype.set = originalSet;
		}
		expect(index.has(failing.hash)).toBe(false);
		const retry = vertex("rollback-retry", epochAnchorHash);
		expect(index.append(retry.hash, retry, 5)).toBeUndefined();
		expect({
			anchorOfRetry: index.isAncestor(epochAnchorHash, retry.hash),
			baseOfRetry: index.isAncestor(base.hash, retry.hash),
			failedPresent: index.has(failing.hash),
			retryPresent: index.has(retry.hash),
			size: index.size,
		}).toEqual({
			anchorOfRetry: true,
			baseOfRetry: false,
			failedPresent: false,
			retryPresent: true,
			size: 3,
		});
	});

	it("[no-arrival-winner-or-finality-leakage] opposing byte-saturation schedules expose no semantic winner", async () => {
		const epochAnchorHash = hashFor("anchor");
		const left = vertex("arrival-left", epochAnchorHash);
		const right = vertex("arrival-right", epochAnchorHash);
		const leftFirst = await byteIndex({ anchorCharge: 1, maxEpochBytes: 2 });
		const rightFirst = await byteIndex({ anchorCharge: 1, maxEpochBytes: 2 });
		expect(leftFirst.append(left.hash, left, 1)).toBeUndefined();
		const leftResult = leftFirst.append(right.hash, right, 1);
		expect(rightFirst.append(right.hash, right, 1)).toBeUndefined();
		const rightResult = rightFirst.append(left.hash, left, 1);
		for (const result of [leftResult, rightResult]) {
			expect(result).toEqual(outcome());
			expect(Object.keys(result as EpochFullOutcome).sort()).toEqual(["code", "latchByHash", "status"]);
			expect(Object.values(result as EpochFullOutcome)).not.toContain(left.hash);
			expect(Object.values(result as EpochFullOutcome)).not.toContain(right.hash);
		}
		expect({
			leftFirst: [leftFirst.has(left.hash), leftFirst.has(right.hash)],
			rightFirst: [rightFirst.has(left.hash), rightFirst.has(right.hash)],
		}).toEqual({
			leftFirst: [true, false],
			rightFirst: [false, true],
		});
	});

	it("[provenance-neutral-inert-charge] never invokes a live authority and imports no protocol/live binder", async () => {
		const source = readFileSync(resolve(HERE, "../packages/compaction/src/linearize.ts"), "utf8");
		const types = readFileSync(resolve(HERE, "../packages/compaction/src/types.ts"), "utf8");
		expect(`${source}\n${types}`).not.toMatch(
			/from\s+["'][^"']*(protocol-v3|registry|transport|packages\/node)|parametersDigest/u
		);

		const index = await byteIndex({ anchorCharge: 1, maxEpochBytes: 10 });
		const candidate = vertex("live-authority-candidate", hashFor("anchor"));
		let calls = 0;
		const lazyAuthority = (() => {
			calls++;
			return 1;
		}) as unknown as number;
		const error = capturedError(() => index.append(candidate.hash, candidate, lazyAuthority));
		expect(errorCode(error)).toBe(contract.invalidChargesCode);
		expect({ calls, present: index.has(candidate.hash), size: index.size }).toEqual({
			calls: 0,
			present: false,
			size: 1,
		});
	});
});

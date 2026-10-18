/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0o-b3-v3/acl-reputation-contract.json" with { type: "json" };
import type { EquivocationScope } from "../packages/protocol-v3/src/index.js";

interface Slot {
	readonly scope: EquivocationScope;
	readonly digestHexes: readonly string[];
}
interface Projection {
	readonly author: string;
	readonly slots: readonly Slot[];
}
interface Policy {
	readonly maxReputationPenalty: number;
}
interface Composition {
	readonly author: string;
	readonly equivocatingSlotCount: number;
	readonly totalCanonicalPairCount: number;
	readonly reputationPenalty: number;
	readonly saturated: boolean;
}
type Composer = (projection: Projection, policy: Policy) => Composition;
interface Surface {
	composeAuthorAclReputation?: Composer;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const IMPLEMENTATION =
	process.env.PHASE_0O_B3_IMPLEMENTATION_MODULE === undefined
		? resolve(HERE, contract.implementationModule)
		: resolve(ROOT, process.env.PHASE_0O_B3_IMPLEMENTATION_MODULE);
const PUBLIC_ENTRY =
	process.env.PHASE_0O_B3_MUTANT === "public-reexport"
		? resolve(HERE, contract.publicReexportMutantModule)
		: resolve(HERE, contract.publicEntryModule);
const loaded = import(pathToFileURL(IMPLEMENTATION).href) as Promise<Surface>;
const [D1, D2, D3, D4] = contract.digests as [string, string, string, string];

function scope(objectId: string, authorSequence: number): EquivocationScope {
	return { author: contract.author, objectId, authorSequence };
}
function base(): Projection {
	return {
		author: contract.author,
		slots: [
			{ scope: scope(contract.objectB, 11), digestHexes: [D4, D2] },
			{ scope: scope(contract.objectA, 7), digestHexes: [D3, D1, D2] },
		],
	};
}
async function composer(): Promise<Composer> {
	const value = await loaded;
	if (typeof value.composeAuthorAclReputation !== "function")
		throw new Error("PHASE_0O_B3_MISSING_DEEP_HELPER:composeAuthorAclReputation");
	return value.composeAuthorAclReputation;
}
function compose(fn: Composer, value: Projection, maxReputationPenalty: number): Composition {
	return fn(value, { maxReputationPenalty });
}

describe("Phase 0o-b3 pure ACL-visible reputation causal RED", () => {
	it("[governance] freezes projection-only pair-unit reputation and no ACL authority", () => {
		const supplement = resolve(HERE, contract.supplementDirectory);
		expect(existsSync(supplement)).toBe(true);
		expect(readdirSync(supplement).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		const profile = JSON.parse(readFileSync(resolve(supplement, "profile.json"), "utf8"));
		expect(profile).toMatchObject({
			profileId: contract.profileId,
			baseProfileId: contract.baseProfileId,
			reputation: {
				unit: "canonical-unordered-distinct-digest-pair",
				capEffect: "composition-output-only",
				higherPenalty: "worse-reputation",
			},
			input: { detachedDigestSetsOnly: true, gossipBudgetSelection: false, pendingRows: false },
			claims: { aclMutation: false, admissionAuthority: false },
		});
		const text = readFileSync(resolve(supplement, "spec.md"), "utf8");
		for (const phrase of [
			"canonical unordered distinct digest-pair",
			"not ACL mutation or admission authority",
			"nonnegative safe integer",
			"O(total captured digest entries)",
			"conditional recovery",
			"at-least-once",
			"no global evidence bound",
		])
			expect(text).toContain(phrase);
		const workflow = readFileSync(resolve(ROOT, contract.workflow), "utf8");
		for (const phrase of [
			"permissions:\n  contents: read",
			"timeout-minutes: 10",
			"PHASE_0O_B3_IMPLEMENTATION_MODULE",
			"--no-coverage --maxWorkers=1 --minWorkers=1",
		])
			expect(workflow).toContain(phrase);
	});

	it("[author-wide-policy] calculates below, at, and above the explicit pair-unit cap", async () => {
		const fn = await composer();
		expect(compose(fn, base(), 5)).toEqual({
			author: contract.author,
			equivocatingSlotCount: 2,
			totalCanonicalPairCount: 4,
			reputationPenalty: 4,
			saturated: false,
		});
		expect(compose(fn, base(), 4)).toEqual(compose(fn, base(), 5));
		expect(compose(fn, base(), 3)).toEqual({
			author: contract.author,
			equivocatingSlotCount: 2,
			totalCanonicalPairCount: 4,
			reputationPenalty: 3,
			saturated: true,
		});
	});

	it("[closed-shape] exposes only the minimal aggregate without selected pairs or a second identity", async () => {
		const result = compose(await composer(), base(), 6);
		expect(Object.keys(result).sort()).toEqual([
			"author",
			"equivocatingSlotCount",
			"reputationPenalty",
			"saturated",
			"totalCanonicalPairCount",
		]);
		expect(JSON.stringify(result)).not.toContain("selectedPairs");
	});

	it("[duplicate-union] merges duplicate full scopes, collapses digests, and preserves each independently provable slot contribution", async () => {
		const equivalent: Projection = {
			author: contract.author,
			slots: [
				{ scope: scope(contract.objectA, 7), digestHexes: [D1] },
				{ scope: scope(contract.objectA, 7), digestHexes: [D2, D2] },
				{ scope: scope(contract.objectA, 7), digestHexes: [D3] },
				{ scope: scope(contract.objectB, 11), digestHexes: [D4] },
				{ scope: scope(contract.objectB, 11), digestHexes: [D2] },
			],
		};
		const fn = await composer();
		expect(compose(fn, equivalent, 7)).toEqual(compose(fn, base(), 7));
		expect(
			compose(
				fn,
				{ author: contract.author, slots: [{ scope: scope(contract.objectA, 7), digestHexes: [D1, D2, D3] }] },
				7
			)
		).toMatchObject({ equivocatingSlotCount: 1, totalCanonicalPairCount: 3 });
		expect(
			compose(
				fn,
				{ author: contract.author, slots: [{ scope: scope(contract.objectB, 11), digestHexes: [D2, D4] }] },
				7
			)
		).toMatchObject({ equivocatingSlotCount: 1, totalCanonicalPairCount: 1 });
	});

	it("[permutation-retry-concurrency] has byte/deep-equal detached output for equivalent retry inputs", async () => {
		const fn = await composer();
		const first = base();
		const second = structuredClone(first);
		second.slots.reverse();
		const results = await Promise.all([
			Promise.resolve(compose(fn, first, 9)),
			Promise.resolve(compose(fn, second, 9)),
			Promise.resolve(compose(fn, structuredClone(first), 9)),
		]);
		expect(results).toEqual([results[0], results[0], results[0]]);
		expect(JSON.stringify(results[0])).toBe(JSON.stringify(results[2]));
	});

	it("[full-scope-identity] treats object/sequence scopes collision-safely and counts every normalized scope", async () => {
		const fn = await composer();
		const value: Projection = {
			author: contract.author,
			slots: [
				{ scope: scope("object:1", 23), digestHexes: [D1, D2] },
				{ scope: scope("object:12", 3), digestHexes: [D1, D2] },
				{ scope: scope(contract.objectA, 2), digestHexes: [D1] },
			],
		};
		expect(compose(fn, value, 99)).toMatchObject({ equivocatingSlotCount: 2, totalCanonicalPairCount: 2 });
	});

	it("[capture-detach] once-captures scalar getters and indexed arrays without dispatching caller methods", async () => {
		const reads: Record<string, number> = {};
		const read = <T>(key: string, value: T): T => {
			reads[key] = (reads[key] ?? 0) + 1;
			return value;
		};
		const digests = [D1, D2, D3];
		Object.defineProperty(digests, Symbol.iterator, {
			get: () => {
				throw new Error("iterator dispatched");
			},
		});
		for (const name of ["map", "sort", "slice", "forEach"])
			Object.defineProperty(digests, name, {
				get: () => {
					throw new Error(`Array.${name} dispatched`);
				},
			});
		for (let index = 0; index < digests.length; index++) {
			const value = digests[index] as string;
			Object.defineProperty(digests, index, { configurable: true, get: () => read(`digest.${index}`, value) });
		}
		const hostileSlots = [
			{
				get scope() {
					return {
						get author() {
							return read("scope.author", contract.author);
						},
						get objectId() {
							return read("scope.object", contract.objectA);
						},
						get authorSequence() {
							return read("scope.sequence", 7);
						},
					};
				},
				get digestHexes() {
					return read("digests", digests);
				},
			},
		];
		Object.defineProperty(hostileSlots, Symbol.iterator, {
			get: () => {
				throw new Error("slots iterator dispatched");
			},
		});
		for (const name of ["map", "sort", "slice", "forEach"])
			Object.defineProperty(hostileSlots, name, {
				get: () => {
					throw new Error(`slots.${name} dispatched`);
				},
			});
		const hostile = Object.defineProperties(Object.create(null), {
			author: { get: () => read("author", contract.author) },
			slots: { get: () => read("slots", hostileSlots) },
		}) as Projection;
		const policy = Object.defineProperty(Object.create(null), "maxReputationPenalty", {
			get: () => read("policy", 8),
		}) as Policy;
		expect((await composer())(hostile, policy).totalCanonicalPairCount).toBe(3);
		expect(reads).toEqual({
			"author": 1,
			"slots": 1,
			"scope.author": 1,
			"scope.object": 1,
			"scope.sequence": 1,
			"digests": 1,
			"digest.0": 1,
			"digest.1": 1,
			"digest.2": 1,
			"policy": 1,
		});
	});

	it("[purity-freshness] has no cache, ambient dependency, aliases, or mutation", async () => {
		const fn = await composer();
		const value = structuredClone(base()) as Projection & Record<string, unknown>;
		const before = structuredClone(value);
		for (const field of [
			"pendingRows",
			"proofBodies",
			"selectedPairs",
			"saturation",
			"durableState",
			"recovery",
			"handoff",
			"acl",
			"policyStorage",
			"transport",
		])
			Object.defineProperty(value, field, {
				get: () => {
					throw new Error(`forbidden read: ${field}`);
				},
			});
		const now = Date.now;
		const random = Math.random;
		const locale = String.prototype.localeCompare;
		Date.now = () => {
			throw new Error("clock");
		};
		Math.random = () => {
			throw new Error("random");
		};
		String.prototype.localeCompare = () => {
			throw new Error("locale");
		};
		try {
			const first = compose(fn, value, 17);
			const second = compose(fn, value, 17);
			expect(first).toEqual(second);
			expect(first).not.toBe(second);
			expect(value).toEqual(before);
		} finally {
			Date.now = now;
			Math.random = random;
			String.prototype.localeCompare = locale;
		}
	});

	it("[projection-only] ignores caller totals, b2 selection/saturation, and attached authority fields", async () => {
		const value = Object.assign(base(), {
			totalCanonicalPairCount: 999,
			selectedPairs: ["not authority"],
			saturated: true,
			reputationPenalty: -1,
		});
		expect(compose(await composer(), value, 11)).toMatchObject({
			totalCanonicalPairCount: 4,
			reputationPenalty: 4,
			saturated: false,
		});
	});

	it("[cap-output-only] does not read or affect adjacent ACL/admission/resolution/projection state", async () => {
		const value = base() as Projection & Record<string, unknown>;
		const before = structuredClone(value);
		for (const field of [
			"admission",
			"resolution",
			"slotSignal",
			"verification",
			"durableProjection",
			"pendingHandoff",
			"acl",
			"policyStorage",
			"gossipBudget",
		])
			Object.defineProperty(value, field, {
				get: () => {
					throw new Error(`adjacent read: ${field}`);
				},
			});
		const fn = await composer();
		expect(compose(fn, value, 2).reputationPenalty).toBe(2);
		expect(compose(fn, value, 4).reputationPenalty).toBe(4);
		expect(value).toEqual(before);
	});

	it("[malformed-fail-closed] rejects nulls, malformed arrays/scopes/digests, unsafe sequences and cross-author scopes before partial output", async () => {
		const fn = await composer();
		const invalid: unknown[] = [
			null,
			{},
			{ author: contract.author, slots: null },
			{ author: contract.author, slots: [null] },
			{ author: contract.author, slots: [{ scope: null, digestHexes: [] }] },
			{
				author: contract.author,
				slots: [{ scope: { author: "mallory", objectId: contract.objectA, authorSequence: 7 }, digestHexes: [D1, D2] }],
			},
			{ author: contract.author, slots: [{ scope: scope(contract.objectA, -1), digestHexes: [D1] }] },
			{
				author: contract.author,
				slots: [{ scope: scope(contract.objectA, Number.MAX_SAFE_INTEGER + 1), digestHexes: [D1] }],
			},
			{ author: contract.author, slots: [{ scope: scope(contract.objectA, 7), digestHexes: "not-array" }] },
			{ author: contract.author, slots: [{ scope: scope(contract.objectA, 7), digestHexes: ["A".repeat(64)] }] },
			{ author: contract.author, slots: [{ scope: scope(contract.objectA, 7), digestHexes: ["aa"] }] },
		];
		for (const value of invalid) expect(() => fn(value as Projection, { maxReputationPenalty: 1 })).toThrow(TypeError);
		for (const policy of [null, {}, { maxReputationPenalty: "1" }])
			expect(() => fn(base(), policy as Policy)).toThrow();
		const late = structuredClone(base()) as Projection & Record<string, unknown>;
		Object.defineProperty(late, "pendingRows", {
			get: () => {
				throw new Error("adjacent read");
			},
		});
		(late.slots as Slot[]).push({ scope: scope(contract.objectA, 9), digestHexes: ["xx"] });
		const firstDigest = late.slots[0]?.digestHexes[0];
		expect(() => fn(late, { maxReputationPenalty: 1 })).toThrow(TypeError);
		expect(late.slots).toHaveLength(3);
		expect(late.slots[0]?.digestHexes[0]).toBe(firstDigest);
	});

	it("[safe-policy] rejects invalid caps, preserves empty-zero unsaturation, and accepts exact safe limits", async () => {
		const fn = await composer();
		for (const cap of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
			expect(() => compose(fn, base(), cap)).toThrow(RangeError);
		expect(compose(fn, { author: contract.author, slots: [] }, 0)).toMatchObject({
			totalCanonicalPairCount: 0,
			equivocatingSlotCount: 0,
			reputationPenalty: 0,
			saturated: false,
		});
		expect(
			compose(fn, { author: contract.author, slots: [{ scope: scope(contract.objectA, 7), digestHexes: [D1] }] }, 0)
		).toMatchObject({ totalCanonicalPairCount: 0, equivocatingSlotCount: 0, reputationPenalty: 0, saturated: false });
		expect(
			compose(fn, { author: contract.author, slots: [{ scope: scope(contract.objectA, 7), digestHexes: [D1, D2] }] }, 0)
		).toMatchObject({ totalCanonicalPairCount: 1, reputationPenalty: 0, saturated: true });
		expect(compose(fn, base(), Number.MAX_SAFE_INTEGER).reputationPenalty).toBe(4);
	});

	it("[public-boundary] keeps the deep helper absent from source, built, and runtime public roots", async () => {
		const symbol = "composeAuthorAclReputation";
		const publicSource = readFileSync(resolve(ROOT, "packages/protocol-v3/src/public.ts"), "utf8");
		expect(publicSource).not.toMatch(new RegExp(`\\b${symbol}\\b`, "u"));
		expect(readFileSync(resolve(HERE, "fixtures/phase-0o-b3-v3/public-entry-type-audit.ts"), "utf8")).toContain(symbol);
		expect(readFileSync(resolve(HERE, "fixtures/phase-0o-b3-v3/built-package-type-audit.ts"), "utf8")).toContain(
			symbol
		);
		expect(await import(pathToFileURL(PUBLIC_ENTRY).href)).not.toHaveProperty(symbol);
		expect(await import("@ts-drp/protocol-v3")).not.toHaveProperty(symbol);
	});

	it("[phase-exclusions] adds no v2, live ACL binding, admission, transport, persistence, compaction, token bucket, or 0n", () => {
		const text = readFileSync(resolve(HERE, contract.supplementDirectory, "spec.md"), "utf8");
		for (const phrase of [
			"no v2",
			"no live ACL binder",
			"no admission rule",
			"no transport",
			"no persistence",
			"no compaction",
			"no token bucket",
			"no Phase 0n",
			"@ts-drp/math",
		])
			expect(text).toContain(phrase);
	});
});

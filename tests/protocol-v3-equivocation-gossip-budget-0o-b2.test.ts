/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0o-b2-v3/gossip-budget-contract.json" with { type: "json" };
import type { EquivocationScope } from "../packages/protocol-v3/src/index.js";
import { auditSuccessorWorkflowRouting } from "./fixtures/phase-3a1b-freeze-successor-v1/analyzers/workflow/routing-analyzer.js";

const LEGACY_FREEZE_CHECKERS = [
	"packages/protocol-v3/conformance/blueprint-operation-budget-v1/check-freeze.mjs",
	"packages/protocol-v3/supplements/blueprint-work-budget-v1/check-freeze.mjs",
	"packages/protocol-v3/supplements/equivocation-author-projection-v1/check-freeze.mjs",
	"packages/protocol-v3/supplements/equivocation-gossip-budget-v1/check-freeze.mjs",
	"packages/protocol-v3/supplements/equivocation-acl-reputation-v1/check-freeze.mjs",
] as const;

interface DetachedAuthorGossipSlot {
	readonly scope: EquivocationScope;
	readonly digestHexes: readonly string[];
}

interface DetachedAuthorGossipProjection {
	readonly author: string;
	readonly slots: readonly DetachedAuthorGossipSlot[];
}

interface AuthorGossipBudgetPolicy {
	readonly maxGossipPairCount: number;
}

interface AuthorGossipPair {
	readonly scope: EquivocationScope;
	readonly lesserDigestHex: string;
	readonly greaterDigestHex: string;
}

interface AuthorGossipBudgetComposition {
	readonly author: string;
	readonly selectedPairs: readonly AuthorGossipPair[];
	readonly totalPairCount: number;
	readonly suppressedPairCount: number;
	readonly saturated: boolean;
}

type Composer = (
	projection: DetachedAuthorGossipProjection,
	policy: AuthorGossipBudgetPolicy
) => AuthorGossipBudgetComposition;

interface BudgetSurface {
	composeAuthorGossipBudget?: Composer;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const IMPLEMENTATION =
	process.env.PHASE_0O_B2_IMPLEMENTATION_MODULE === undefined
		? resolve(CURRENT_DIRECTORY, contract.implementationModule)
		: resolve(REPOSITORY_ROOT, process.env.PHASE_0O_B2_IMPLEMENTATION_MODULE);
const PUBLIC_ENTRY =
	process.env.PHASE_0O_B2_MUTANT === "public-reexport"
		? resolve(CURRENT_DIRECTORY, contract.publicReexportMutantModule)
		: resolve(CURRENT_DIRECTORY, contract.publicEntryModule);
const implementationLoad = import(pathToFileURL(IMPLEMENTATION).href) as Promise<BudgetSurface>;

const [D1, D2, D3, D4] = contract.digests as [string, string, string, string];

function scope(objectId: string, authorSequence: number): EquivocationScope {
	return { author: contract.author, authorSequence, objectId };
}

function projection(): DetachedAuthorGossipProjection {
	return {
		author: contract.author,
		slots: [
			{
				scope: scope(contract.objectB, contract.sequenceB),
				digestHexes: [D4, D2],
			},
			{
				scope: scope(contract.objectA, contract.sequenceA),
				digestHexes: [D3, D1, D2],
			},
		],
	};
}

function expectedPairs(): AuthorGossipPair[] {
	return [
		{ scope: scope(contract.objectA, contract.sequenceA), lesserDigestHex: D1, greaterDigestHex: D2 },
		{ scope: scope(contract.objectA, contract.sequenceA), lesserDigestHex: D1, greaterDigestHex: D3 },
		{ scope: scope(contract.objectA, contract.sequenceA), lesserDigestHex: D2, greaterDigestHex: D3 },
		{ scope: scope(contract.objectB, contract.sequenceB), lesserDigestHex: D2, greaterDigestHex: D4 },
	];
}

function differentialProjection(): DetachedAuthorGossipProjection {
	return {
		author: contract.author,
		slots: [
			{
				scope: scope(contract.orderingBmpObjectId, 2),
				digestHexes: [D4, D3],
			},
			{
				scope: scope(contract.orderingAstralObjectId, 10),
				digestHexes: [D4, D1],
			},
			{
				scope: scope(contract.orderingAstralObjectId, 2),
				digestHexes: [D3, D2, D1],
			},
		],
	};
}

function expectedDifferentialPairs(): AuthorGossipPair[] {
	return [
		{
			scope: scope(contract.orderingAstralObjectId, 2),
			lesserDigestHex: D1,
			greaterDigestHex: D2,
		},
		{
			scope: scope(contract.orderingAstralObjectId, 2),
			lesserDigestHex: D1,
			greaterDigestHex: D3,
		},
		{
			scope: scope(contract.orderingAstralObjectId, 2),
			lesserDigestHex: D2,
			greaterDigestHex: D3,
		},
		{
			scope: scope(contract.orderingAstralObjectId, 10),
			lesserDigestHex: D1,
			greaterDigestHex: D4,
		},
		{
			scope: scope(contract.orderingBmpObjectId, 2),
			lesserDigestHex: D3,
			greaterDigestHex: D4,
		},
	];
}

async function requireComposer(): Promise<Composer> {
	const loaded = await implementationLoad;
	if (typeof loaded.composeAuthorGossipBudget !== "function") {
		throw new Error("PHASE_0O_B2_MISSING_DEEP_HELPER:composeAuthorGossipBudget");
	}
	return loaded.composeAuthorGossipBudget;
}

function compose(composer: Composer, value: DetachedAuthorGossipProjection, maxGossipPairCount: number) {
	return composer(value, { maxGossipPairCount });
}

describe("Phase 0o-b2 pure author gossip-budget causal RED", () => {
	it("[governance] freezes a pure projection-only budget and explicit negative authority boundary", () => {
		const supplement = resolve(CURRENT_DIRECTORY, contract.supplementDirectory);
		expect(existsSync(supplement)).toBe(true);
		expect(readdirSync(supplement).sort()).toEqual([
			"check-freeze.mjs",
			"freeze-policy.json",
			"profile.json",
			"spec.md",
		]);
		const profile = JSON.parse(readFileSync(resolve(supplement, "profile.json"), "utf8")) as Record<string, unknown>;
		expect(profile).toMatchObject({
			baseProfileId: contract.baseProfileId,
			profileId: contract.profileId,
			budget: {
				selection: "canonical-first-N-author-wide-pair-tuples",
				saturationEffect: "composition-output-only",
			},
			governance: {
				provisionalAuthorizesGreen: false,
				supersedesProvisionalRed: "fdb6765c2d292a86c0fba2d8ac3a2acef420e354",
			},
			input: {
				authoritativeCounts: false,
				detachedDigestSetsOnly: true,
				pendingRows: false,
				proofBodies: false,
			},
		});
		const specification = readFileSync(resolve(supplement, "spec.md"), "utf8");
		for (const phrase of [
			"detached digest sets",
			"canonical first N",
			"code-unit order",
			"U+10000",
			"U+E000",
			"sequence `2` before `10`",
			"superseded and must never authorize GREEN",
			"nonnegative safe integer",
			"pending rows",
			"future reputation",
			"composition output only",
		]) {
			expect(specification).toContain(phrase);
		}
		const workflow = readFileSync(resolve(REPOSITORY_ROOT, contract.workflow), "utf8");
		for (const phrase of [
			"permissions:\n  contents: read",
			"timeout-minutes: 10",
			"PHASE_0O_B2_IMPLEMENTATION_MODULE",
			"--no-coverage --maxWorkers=1 --minWorkers=1",
			"protocol-v3-equivocation-author-projection-0o-b1b.test.ts",
			"equivocation-digest-identity-v1/check-freeze.mjs",
			"equivocation-evidence-projection-v1/check-freeze.mjs",
		]) {
			expect(workflow).toContain(phrase);
		}
		expect(
			auditSuccessorWorkflowRouting(
				workflow,
				{
					jobKey: "protocol-v3-equivocation-gossip-budget",
					jobName: "Require immutable protocol-v3 equivocation gossip budget supplement",
					workflowName: "Protocol v3 equivocation gossip budget freeze",
				},
				LEGACY_FREEZE_CHECKERS
			)
		).toEqual([]);
	});

	it("[author-wide-boundaries] composes two slots exactly below, at and above one shared budget", async () => {
		const composer = await requireComposer();
		const below = compose(composer, projection(), 5);
		const at = compose(composer, projection(), 4);
		const above = compose(composer, projection(), 3);
		expect(below).toEqual({
			author: contract.author,
			saturated: false,
			selectedPairs: expectedPairs(),
			suppressedPairCount: 0,
			totalPairCount: 4,
		});
		expect(at).toEqual(below);
		expect(above).toEqual({
			author: contract.author,
			saturated: true,
			selectedPairs: expectedPairs().slice(0, 3),
			suppressedPairCount: 1,
			totalPairCount: 4,
		});
	});

	it("[deterministic-selection] uses exact locale-free scope/digest tie-breaking and a closed record shape", async () => {
		const composer = await requireComposer();
		const result = compose(composer, projection(), 6);
		expect(result.selectedPairs).toEqual(expectedPairs());
		expect(Object.keys(result).sort()).toEqual([
			"author",
			"saturated",
			"selectedPairs",
			"suppressedPairCount",
			"totalPairCount",
		]);
		for (const pair of result.selectedPairs) {
			expect(Object.keys(pair).sort()).toEqual(["greaterDigestHex", "lesserDigestHex", "scope"]);
			expect(Object.keys(pair.scope).sort()).toEqual(["author", "authorSequence", "objectId"]);
		}
	});

	it("[differential-ordering] uses UTF-16 objectId order, numeric sequence order and both digest tie-breaks for first-N", async () => {
		const composer = await requireComposer();
		const prefixLength = "object:".length;
		expect(contract.orderingAstralObjectId < contract.orderingBmpObjectId).toBe(true);
		expect(
			(contract.orderingAstralObjectId.codePointAt(prefixLength) as number) >
				(contract.orderingBmpObjectId.codePointAt(prefixLength) as number)
		).toBe(true);
		const allPairs = expectedDifferentialPairs();
		const result = compose(composer, differentialProjection(), 4);
		expect(result).toEqual({
			author: contract.author,
			saturated: true,
			selectedPairs: allPairs.slice(0, 4),
			suppressedPairCount: 1,
			totalPairCount: 5,
		});
		expect(allPairs[0]?.scope.authorSequence).toBe(2);
		expect(allPairs[3]?.scope.authorSequence).toBe(10);
		expect(allPairs[0]?.lesserDigestHex).toBe(allPairs[1]?.lesserDigestHex);
		expect(allPairs[0]?.greaterDigestHex < (allPairs[1]?.greaterDigestHex as string)).toBe(true);
		expect((allPairs[1]?.lesserDigestHex as string) < (allPairs[2]?.lesserDigestHex as string)).toBe(true);
	});

	it("[retry-concurrency] merges duplicate/reordered projections without double-counting", async () => {
		const composer = await requireComposer();
		const canonical = projection();
		const equivalent: DetachedAuthorGossipProjection = {
			author: contract.author,
			slots: [
				{ scope: scope(contract.objectA, contract.sequenceA), digestHexes: [D2, D3, D1, D1] },
				{ scope: scope(contract.objectB, contract.sequenceB), digestHexes: [D2, D4, D4] },
				{ scope: scope(contract.objectA, contract.sequenceA), digestHexes: [D3, D2] },
			],
		};
		const results = await Promise.all([
			Promise.resolve(compose(composer, canonical, 7)),
			Promise.resolve(compose(composer, equivalent, 7)),
			Promise.resolve(compose(composer, structuredClone(equivalent), 7)),
			Promise.resolve(compose(composer, structuredClone(canonical), 7)),
		]);
		expect(results).toEqual([results[0], results[0], results[0], results[0]]);
		expect(JSON.stringify(results[0])).toBe(JSON.stringify(results[3]));
		expect(results[0]?.totalPairCount).toBe(4);
	});

	it("[capture-detach] once-captures hostile getters and indexed arrays without caller dispatch or TOCTOU", async () => {
		const composer = await requireComposer();
		const reads: Record<string, number> = {};
		const read = <Value>(key: string, value: Value): Value => {
			reads[key] = (reads[key] ?? 0) + 1;
			return value;
		};
		const hostileDigests = [] as string[];
		for (const [index, digest] of [D3, D1, D2].entries()) {
			let current = digest;
			Object.defineProperty(hostileDigests, index, {
				configurable: true,
				get: () => {
					const captured = read(`digest.${index}`, current);
					current = D4;
					return captured;
				},
			});
		}
		Object.defineProperty(hostileDigests, "length", { value: 3 });
		for (const method of ["filter", "forEach", "includes", "map", "slice", "sort"]) {
			Object.defineProperty(hostileDigests, method, {
				get: () => {
					throw new Error(`caller Array.${method} dispatched`);
				},
			});
		}
		Object.defineProperty(hostileDigests, Symbol.iterator, {
			get: () => {
				throw new Error("caller iterator dispatched");
			},
		});
		const hostileSlot = Object.defineProperties(Object.create(null), {
			digestHexes: { get: () => read("slot.digests", hostileDigests) },
			scope: {
				get: () =>
					read("slot.scope", {
						get author() {
							return read("scope.author", contract.author);
						},
						get authorSequence() {
							return read("scope.sequence", contract.sequenceA);
						},
						get objectId() {
							return read("scope.object", contract.objectA);
						},
					}),
			},
		}) as DetachedAuthorGossipSlot;
		const hostileSlots = [hostileSlot];
		for (const method of ["filter", "forEach", "map", "slice", "sort"]) {
			Object.defineProperty(hostileSlots, method, {
				get: () => {
					throw new Error(`caller slots.${method} dispatched`);
				},
			});
		}
		Object.defineProperty(hostileSlots, Symbol.iterator, {
			get: () => {
				throw new Error("caller slots iterator dispatched");
			},
		});
		const hostileProjection = Object.defineProperties(Object.create(null), {
			author: { get: () => read("projection.author", contract.author) },
			slots: { get: () => read("projection.slots", hostileSlots) },
		}) as DetachedAuthorGossipProjection;
		const policyReads: Record<string, number> = {};
		const hostilePolicy = Object.defineProperties(Object.create(null), {
			maxGossipPairCount: {
				get: () => {
					policyReads.max = (policyReads.max ?? 0) + 1;
					return 8;
				},
			},
		}) as AuthorGossipBudgetPolicy;
		const result = composer(hostileProjection, hostilePolicy);
		expect(result.selectedPairs).toEqual(expectedPairs().slice(0, 3));
		expect(policyReads).toEqual({ max: 1 });
		expect(reads).toEqual({
			"digest.0": 1,
			"digest.1": 1,
			"digest.2": 1,
			"projection.author": 1,
			"projection.slots": 1,
			"scope.author": 1,
			"scope.object": 1,
			"scope.sequence": 1,
			"slot.digests": 1,
			"slot.scope": 1,
		});
	});

	it("[canonical-pairs] collapses same digests, forbids self-pairs and normalizes unordered encounters", async () => {
		const composer = await requireComposer();
		const reversed: DetachedAuthorGossipProjection = {
			author: contract.author,
			slots: [{ scope: scope(contract.objectA, contract.sequenceA), digestHexes: [D3, D2, D1, D2, D1] }],
		};
		const normalized = compose(composer, reversed, 9);
		const selfProbe = compose(composer, reversed, 10);
		expect(normalized.selectedPairs).toEqual(expectedPairs().slice(0, 3));
		expect(selfProbe).toEqual({ ...normalized, selectedPairs: normalized.selectedPairs });
		expect(normalized.selectedPairs.every((pair) => pair.lesserDigestHex < pair.greaterDigestHex)).toBe(true);
	});

	it("[projection-only-accounting] derives totals from normalized digest sets and ignores caller counts", async () => {
		const composer = await requireComposer();
		const value = Object.assign(projection(), {
			totalPairCount: 999,
			pairCount: -1,
			suppressedPairCount: 888,
		});
		const result = compose(composer, value, 11);
		expect(result.totalPairCount).toBe(4);
		expect(result.suppressedPairCount).toBe(0);
		expect(result.selectedPairs).toEqual(expectedPairs());
	});

	it("[purity] never mutates caller inputs or dispatches attached durable fields, and repeat calls are fresh", async () => {
		const composer = await requireComposer();
		const value = projection() as {
			author: string;
			slots: Array<{ scope: EquivocationScope; digestHexes: string[] }>;
		};
		const policy = { maxGossipPairCount: 12 };
		const beforeProjection = structuredClone(value);
		const beforePolicy = structuredClone(policy);
		for (const forbidden of ["durableState", "pendingRows", "proofBodies"]) {
			Object.defineProperty(value, forbidden, {
				get: () => {
					throw new Error(`purity boundary read: ${forbidden}`);
				},
			});
		}
		const first = composer(value, policy);
		const second = composer(value, policy);
		expect(second).toEqual(first);
		expect(value).toEqual(beforeProjection);
		expect(policy).toEqual(beforePolicy);
		expect(first).not.toBe(second);
		expect(first.selectedPairs).not.toBe(second.selectedPairs);
	});

	it("[ambient-free] has no module cache, wall clock, randomness or locale dependency", async () => {
		const composer = await requireComposer();
		const originalNow = Date.now;
		const originalRandom = Math.random;
		const originalLocaleCompare = String.prototype.localeCompare;
		Date.now = () => {
			throw new Error("wall clock accessed");
		};
		Math.random = () => {
			throw new Error("randomness accessed");
		};
		String.prototype.localeCompare = () => {
			throw new Error("locale accessed");
		};
		try {
			const first = compose(composer, projection(), 17);
			const changed = projection() as {
				author: string;
				slots: Array<{ scope: EquivocationScope; digestHexes: string[] }>;
			};
			changed.slots[1]?.digestHexes.push(D4);
			const second = compose(composer, changed, 17);
			expect(first.totalPairCount).toBe(4);
			expect(second.totalPairCount).toBe(7);
			expect(second).not.toEqual(first);
		} finally {
			Date.now = originalNow;
			Math.random = originalRandom;
			String.prototype.localeCompare = originalLocaleCompare;
		}
	});

	it("[negative-surface] never reads excluded proof, pending, transport, authority or reputation fields", async () => {
		const composer = await requireComposer();
		const value = projection() as DetachedAuthorGossipProjection & Record<string, unknown>;
		for (const forbidden of [
			"pending",
			"proofBodies",
			"state",
			"receivedVertices",
			"admissionResult",
			"verificationResult",
			"materializationResult",
			"resolverOutput",
			"aclState",
			"reputation",
			"slotSignal",
			"durableTransaction",
			"recovery",
			"handoff",
			"transport",
		]) {
			Object.defineProperty(value, forbidden, {
				get: () => {
					throw new Error(`forbidden surface read: ${forbidden}`);
				},
			});
		}
		const policy = Object.defineProperties(
			{ maxGossipPairCount: 13 },
			{
				futureReputation: {
					get: () => {
						throw new Error("future reputation read");
					},
				},
			}
		) as AuthorGossipBudgetPolicy;
		expect(composer(value, policy).totalPairCount).toBe(4);
	});

	it("[saturation-invariance] changes only composition output and leaves every adjacent decision/state untouched", async () => {
		const composer = await requireComposer();
		const value = projection() as {
			author: string;
			slots: Array<{ scope: EquivocationScope; digestHexes: string[] }>;
		};
		const adjacent = {
			admission: { accepted: true },
			resolution: { winner: D1 },
			standaloneVerification: { verified: true },
			slotSignal: { observedForkCount: 2 },
			durableProjection: { slots: structuredClone(value.slots) },
			recovery: { reconciledSlotCount: 2 },
			pendingHandoff: { handedOff: true },
			futureReputation: { value: 17 },
		};
		const beforeValue = structuredClone(value);
		const adjacentReads: Record<string, number> = {};
		for (const key of Object.keys(adjacent) as Array<keyof typeof adjacent>) {
			Object.defineProperty(value, key, {
				get: () => {
					adjacentReads[key] = (adjacentReads[key] ?? 0) + 1;
					return adjacent[key];
				},
			});
		}
		const saturated = compose(composer, value, 2);
		const unsaturated = compose(composer, value, 4);
		expect(saturated).toEqual({
			author: contract.author,
			saturated: true,
			selectedPairs: expectedPairs().slice(0, 2),
			suppressedPairCount: 2,
			totalPairCount: 4,
		});
		expect(unsaturated.selectedPairs).toEqual(expectedPairs());
		expect(value).toEqual(beforeValue);
		expect(adjacentReads).toEqual({});
	});

	it("[bounded-policy] rejects negative, fractional, non-finite and unsafe pair-count bounds", async () => {
		const composer = await requireComposer();
		for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => compose(composer, projection(), invalid)).toThrow(RangeError);
		}
		expect(compose(composer, projection(), 0)).toMatchObject({
			saturated: true,
			selectedPairs: [],
			suppressedPairCount: 4,
			totalPairCount: 4,
		});
		expect(compose(composer, projection(), Number.MAX_SAFE_INTEGER).totalPairCount).toBe(4);
	});

	it("[public-boundary] pins source, built and runtime closure for the deep-only composer", async () => {
		const symbol = "composeAuthorGossipBudget";
		const publicSource = readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/src/public.ts"), "utf8");
		const sourceAudit = readFileSync(
			resolve(CURRENT_DIRECTORY, "fixtures/phase-0o-b2-v3/public-entry-type-audit.ts"),
			"utf8"
		);
		const builtAudit = readFileSync(
			resolve(CURRENT_DIRECTORY, "fixtures/phase-0o-b2-v3/built-package-type-audit.ts"),
			"utf8"
		);
		const sourceRuntime = await import(pathToFileURL(PUBLIC_ENTRY).href);
		const packageRuntime = await import("@ts-drp/protocol-v3");
		expect(Object.keys(sourceRuntime).sort()).toEqual([
			"ANCHOR_TRUST_STATE_MAX_RECORD_BYTES",
			"admitReceivedVertex",
			"authenticateCurrentEpochAnchor",
			"createAdmissionBoundTransactionalVertexIssuer",
			"extractAdmittedReceivedVertex",
			"installCreatorAnchorTrustRoot",
			"isAnchorTrustStateRecordBytes",
			"openCurrentAnchorTrust",
			"prepareBlueprintAdmission",
			"prepareBlueprintRuntime",
		]);
		expect(publicSource).not.toMatch(new RegExp(`\\b${symbol}\\b`, "u"));
		expect(sourceAudit).toContain(`import { ${symbol} }`);
		expect(builtAudit).toContain(`import { ${symbol} }`);
		expect(packageRuntime).not.toHaveProperty(symbol);
	});

	it("[phase-exclusions] adds no v2, reputation, ACL, transport, persistence, outbox, compaction or Phase 0n owner", () => {
		const profile = readFileSync(resolve(CURRENT_DIRECTORY, contract.supplementDirectory, "profile.json"), "utf8");
		const specification = readFileSync(resolve(CURRENT_DIRECTORY, contract.supplementDirectory, "spec.md"), "utf8");
		for (const phrase of [
			"no v2 implementation",
			"no reputation composition",
			"no ACL mutation",
			"no gossip transport",
			"no persistence",
			"no payload outbox",
			"no witness or proof compaction",
			"no Phase 0n math work",
		]) {
			expect(`${profile}\n${specification}`).toContain(phrase);
		}
	});
});

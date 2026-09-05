import {
	createMemoryAheDurableStore,
	digestBlob,
	digestClosure,
	type ExpectedHead,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
} from "@ts-drp/storage";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
	D109C_CORRUPTION_MUTANTS,
	D109C_COUNT_MUTANTS,
	D109C_CRASH_EDGES,
	D109C_ERROR_CODES,
	D109C_EXPORT_CENSUS_PATHS,
	D109C_GREEN_PATHS,
	D109C_LINEAGE_MUTANTS,
	D109C_OTHER_OBJECT,
	D109C_POLICY_DIGEST,
	D109C_RED_PATHS,
	D109C_REFERENCE_CASES,
	d109cBlobDigest,
	d109cDeepFrozen,
	d109cErrorCode,
	d109cGenerationId,
	d109cInput,
	d109cNoHead,
	type D109cSharedMaintenanceModule,
} from "./fixtures/phase-6b/ahe-reclamation-contract.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SHARED_OWNER = "packages/storage/src/maintenance.ts";

function source(path: string): string {
	return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

function readiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing = !existsSync(resolve(REPOSITORY_ROOT, SHARED_OWNER))
		? [SHARED_OWNER]
		: source(SHARED_OWNER).includes("AHE_RECLAMATION_ERROR_CODES")
			? []
			: [SHARED_OWNER];
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

async function candidate(): Promise<D109cSharedMaintenanceModule> {
	return import(pathToFileURL(resolve(REPOSITORY_ROOT, SHARED_OWNER)).href) as Promise<D109cSharedMaintenanceModule>;
}

const state = readiness();

function successful<T>(result: { ok: false; reason: string } | { ok: true; value: T }): T {
	if (!result.ok) throw new TypeError(`D109C_SHARED_FIXTURE:${result.reason}`);
	return result.value;
}

function sharedClassifierFixture(): Readonly<{
	input: ReturnType<typeof d109cInput>;
	sharedDigest: GenerationRef["digest"];
	snapshot: Parameters<D109cSharedMaintenanceModule["classifyAheReclamation"]>[1];
}> {
	const generations: GenerationRecord[] = [];
	const blobs: { bytes: Uint8Array; digest: GenerationRef["digest"] }[] = [];
	const promotions: {
		digest: GenerationRef["digest"];
		generationId: GenerationRecord["generationId"];
		objectId: GenerationRecord["objectId"];
	}[] = [];
	let base: ExpectedHead = d109cNoHead();
	let head: PresentHead | undefined;
	for (let index = 1; index <= 5; index += 1) {
		const bytes = Uint8Array.of(index, index + 1, index + 2);
		const digest = successful(digestBlob(bytes));
		const closure = Object.freeze([{ byteLength: bytes.byteLength, digest }]);
		const closureDigest = successful(digestClosure(closure));
		const generationId = d109cGenerationId(index);
		generations.push(
			Object.freeze({
				baseExpectedHead: base,
				closure,
				closureDigest,
				generationId,
				objectId: d109cNoHead().objectId,
				state: index === 5 ? "Adopted" : "Superseded",
			})
		);
		blobs.push({ bytes, digest });
		promotions.push({ digest, generationId, objectId: d109cNoHead().objectId });
		head = Object.freeze({
			closureDigest,
			generationId,
			kind: "present",
			objectId: d109cNoHead().objectId,
			revision: index as PresentHead["revision"],
		});
		base = head;
	}
	if (head === undefined) throw new TypeError("D109C_SHARED_HEAD_MISSING");
	const floor = generations[2];
	if (floor === undefined) throw new TypeError("D109C_SHARED_FLOOR_MISSING");
	const sharedDigest = generations[0]?.closure[0]?.digest ?? d109cBlobDigest(1);
	const sharedClosure = Object.freeze([{ byteLength: 3, digest: sharedDigest }]);
	const sharedClosureDigest = successful(digestClosure(sharedClosure));
	generations.push(
		Object.freeze({
			baseExpectedHead: d109cNoHead(D109C_OTHER_OBJECT),
			closure: sharedClosure,
			closureDigest: sharedClosureDigest,
			generationId: d109cGenerationId(9),
			objectId: D109C_OTHER_OBJECT,
			state: "Staged",
		})
	);
	return Object.freeze({
		input: Object.freeze({
			activeGenerationId: d109cGenerationId(5),
			availabilityPolicyDigest: D109C_POLICY_DIGEST,
			closedEpoch: 4,
			expectedHead: head,
			lineageFloor: Object.freeze({
				deleteGenerationIds: Object.freeze([d109cGenerationId(1), d109cGenerationId(2)]),
				expectedBaseExpectedHead: floor.baseExpectedHead,
				generationId: floor.generationId,
				replacementBaseExpectedHead: d109cNoHead(),
			}),
			objectId: d109cNoHead().objectId,
			rollbackGenerationIds: Object.freeze([d109cGenerationId(4), floor.generationId]),
		}),
		sharedDigest,
		snapshot: Object.freeze({
			blobs: Object.freeze(blobs),
			generations: Object.freeze(generations),
			head,
			promotions: Object.freeze(promotions),
		}),
	});
}

describe("D.109c shared AHE-reclamation causal RED", () => {
	it("freezes the exact path, error, lineage, corruption, reference, count and crash rosters", () => {
		expect(D109C_RED_PATHS).toHaveLength(9);
		expect(new Set(D109C_RED_PATHS).size).toBe(D109C_RED_PATHS.length);
		expect(D109C_EXPORT_CENSUS_PATHS).toHaveLength(4);
		expect(D109C_GREEN_PATHS).toHaveLength(11);
		expect(D109C_ERROR_CODES).toHaveLength(6);
		expect(D109C_LINEAGE_MUTANTS).toHaveLength(15);
		expect(D109C_CORRUPTION_MUTANTS).toHaveLength(9);
		expect(D109C_REFERENCE_CASES).toHaveLength(6);
		expect(D109C_COUNT_MUTANTS).toHaveLength(4);
		expect(D109C_CRASH_EDGES).toEqual([
			"after-floor-rewrite",
			"after-promotion-delete",
			"after-generation-delete",
			"after-blob-delete",
			"before-commit",
			"after-commit",
		]);
	});

	it("pins the unchanged 12-key facade, ephemeral memory owner and D.109a lineage predicates", () => {
		const memory = source("packages/storage/src/memory.ts");
		const transition = source("packages/storage/src/internal/transition.ts");
		const planner = source("packages/node/src/internal/closed-epoch-cleanup.ts");
		const adoption = source("packages/node/src/creator-adoption.ts");
		const adoptionCommit = source("packages/node/src/creator-adoption-commit.ts");
		expect(memory).toContain('new TransitionOwner("ephemeral")');
		expect(memory).not.toContain("resolveMemoryAheReclamationMaintenance");
		expect(transition).toContain('if (this.durability === "ephemeral") return rejected("DURABILITY_UNAVAILABLE")');
		expect(transition).not.toContain("reclaimClosedEpoch");
		expect(planner).toContain("cursor.revision !== expectedRevision - 1");
		expect(planner).toContain("child.baseExpectedHead.revision === expectedChildRevision - 1");
		expect(adoption).toContain("!byId.has(generation.baseExpectedHead.generationId)");
		expect(adoptionCommit).toContain("!byId.has(generation.baseExpectedHead.generationId)");
	});

	it("freezes the current storage export map before the additive maintenance subpath", () => {
		const manifest = JSON.parse(source("packages/storage/package.json")) as { exports?: Record<string, unknown> };
		const keys = Object.keys(manifest.exports ?? {}).sort();
		const maintenancePresent = Object.hasOwn(manifest.exports ?? {}, "./maintenance");
		expect(keys).toEqual([
			".",
			"./adapter",
			"./contract",
			...(maintenancePresent ? ["./maintenance"] : []),
			"./snapshot-transfer",
		]);
	});

	it("keeps the four authorized live census amendments readiness-conditional", () => {
		for (const path of D109C_EXPORT_CENSUS_PATHS) {
			const value = source(path);
			expect(value, path).toContain("Object.hasOwn(");
			expect(value, path).toContain('"./maintenance"');
		}
	});

	it("[RED readiness] requires the shared maintenance contract and classifier owner", () => {
		expect(state, "D109C_SHARED_MAINTENANCE_MISSING").toEqual({ missing: [], ready: true });
	});

	it.skipIf(!state.ready)("publishes only the exact closed shared error registry", async () => {
		const module = await candidate();
		expect(module.AHE_RECLAMATION_ERROR_CODES).toEqual(D109C_ERROR_CODES);
		expect(Object.isFrozen(module.AHE_RECLAMATION_ERROR_CODES)).toBe(true);
	});

	it.skipIf(!state.ready)("captures the frozen D.109a AHE subset without aliases or runtime authority", async () => {
		const module = await candidate();
		const mutable = structuredClone(d109cInput());
		const input = module.captureAheReclamationInput(mutable);
		expect(Object.keys(input).sort()).toEqual([
			"activeGenerationId",
			"availabilityPolicyDigest",
			"closedEpoch",
			"expectedHead",
			"lineageFloor",
			"objectId",
			"rollbackGenerationIds",
		]);
		expect(d109cDeepFrozen(input)).toBe(true);
		expect(input).not.toHaveProperty("issuance");
		expect(input).not.toHaveProperty("snapshotBytes");
		Reflect.set(mutable, "closedEpoch", 99);
		expect(input.closedEpoch).toBe(4);
		expect(() => module.captureAheReclamationInput({ ...mutable, availabilityPolicyDigest: "0".repeat(64) })).toThrow();
		try {
			module.captureAheReclamationInput({ ...mutable, availabilityPolicyDigest: "0".repeat(64) });
		} catch (error) {
			expect(d109cErrorCode(error)).toBe("AHE_RECLAMATION_INVALID_ARGUMENT");
		}
	});

	it.skipIf(!state.ready)(
		"classifies one lineage, preserves shared blobs and produces a frozen replay receipt",
		async () => {
			const module = await candidate();
			const fixture = sharedClassifierFixture();
			const decision = module.classifyAheReclamation(fixture.input, fixture.snapshot);
			expect(decision.deleteGenerationIds).toEqual([d109cGenerationId(1), d109cGenerationId(2)]);
			expect(decision.deletePromotions).toHaveLength(2);
			expect(decision.deleteBlobDigests).toEqual([fixture.snapshot.generations[1]?.closure[0]?.digest]);
			expect(decision.deleteBlobDigests).not.toContain(fixture.sharedDigest);
			expect(decision.floor.normalizedThisCall).toBe(true);
			expect(decision.floor.rewrittenGeneration.baseExpectedHead).toEqual(d109cNoHead());
			const receipt = module.createAheReclamationReceipt(decision);
			expect(receipt.deletedPromotionCount).toBe(2);
			expect(receipt.reclaimedGenerationIds).toEqual([d109cGenerationId(1), d109cGenerationId(2)]);
			expect(d109cDeepFrozen(receipt)).toBe(true);

			const replayGenerations = fixture.snapshot.generations
				.filter(
					({ generationId, objectId }) => objectId !== fixture.input.objectId || generationId > d109cGenerationId(2)
				)
				.map((generation) =>
					generation.generationId === fixture.input.lineageFloor.generationId
						? Object.freeze({ ...generation, baseExpectedHead: d109cNoHead() })
						: generation
				);
			const replay = module.classifyAheReclamation(fixture.input, {
				...fixture.snapshot,
				generations: replayGenerations,
				promotions: fixture.snapshot.promotions.filter(
					({ generationId, objectId }) => objectId !== fixture.input.objectId || generationId > d109cGenerationId(2)
				),
			});
			expect(replay.deleteGenerationIds).toEqual([]);
			expect(replay.deletePromotions).toEqual([]);
			expect(replay.deleteBlobDigests).toEqual([]);
			expect(module.createAheReclamationReceipt(replay).floor.normalizedThisCall).toBe(false);
		}
	);

	it("proves the honest memory facade remains non-authoritative", async () => {
		const store = createMemoryAheDurableStore();
		try {
			const facadeKeys = [
				"beginGeneration",
				"capabilities",
				"close",
				"completeGeneration",
				"discardGeneration",
				"getBlob",
				"promoteReference",
				"putCachedBlob",
				"readGenerationPage",
				"readHead",
				"recoverActiveGeneration",
				"swapHead",
			] as const;
			expect(facadeKeys).toHaveLength(12);
			for (const key of facadeKeys) expect(store).toHaveProperty(key);
			expect(store).not.toHaveProperty("reclaimClosedEpoch");
			expect(store.capabilities).toEqual({ durability: "ephemeral", signingEligibility: "never" });
		} finally {
			await store.close();
		}
	});
});

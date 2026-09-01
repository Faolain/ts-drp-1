import { createMemoryAheDurableStore } from "@ts-drp/storage";
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
	D109C_RED_PATHS,
	D109C_REFERENCE_CASES,
	d109cDeepFrozen,
	d109cInput,
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

describe("D.109c shared AHE-reclamation causal RED", () => {
	it("freezes the exact path, error, lineage, corruption, reference, count and crash rosters", () => {
		expect(D109C_RED_PATHS).toHaveLength(9);
		expect(new Set(D109C_RED_PATHS).size).toBe(D109C_RED_PATHS.length);
		expect(D109C_EXPORT_CENSUS_PATHS).toHaveLength(4);
		expect(D109C_GREEN_PATHS).toHaveLength(8);
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
		await candidate();
		const input = d109cInput();
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
	});

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

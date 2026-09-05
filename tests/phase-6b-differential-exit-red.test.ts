import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	D109F_GREEN_PATHS,
	D109F_PROOF_KIND_REGISTRY,
	D109F_RED_PATHS,
	D109F_SCOPE,
	D109F_STEP_COUNT,
	d109fDeepFrozen,
	runD109fPlannerDifferential,
} from "./fixtures/phase-6b/differential-exit-contract.js";
import { D109D_CENSUS_KEYS } from "./fixtures/phase-6b/runtime-reclamation-contract.js";
import { createDurableIssuanceRecordPrunedError } from "../packages/issuance-store/src/maintenance.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

describe("D.109f differential and Phase-6b exit RED", () => {
	it("freezes the exact RED and GREEN owner sets", () => {
		expect(D109F_RED_PATHS).toHaveLength(8);
		expect(D109F_GREEN_PATHS).toEqual([
			"packages/storage/src/maintenance.ts",
			"packages/issuance-store/src/maintenance.ts",
			"packages/storage-node/src/internal/node-issuance-store.ts",
		]);
		for (const path of [...D109F_RED_PATHS, ...D109F_GREEN_PATHS]) {
			expect(existsSync(resolve(REPOSITORY_ROOT, path)), path).toBe(true);
		}
	});

	it("runs all 128 deterministic archival-versus-compacted planner steps", async () => {
		const result = await runD109fPlannerDifferential();
		expect(result.steps).toHaveLength(D109F_STEP_COUNT);
		expect(result.steps.map(({ closedEpoch }) => closedEpoch)).toEqual(
			Array.from({ length: D109F_STEP_COUNT }, (_, index) => index)
		);
		expect(result.archivalGenerationCount).toBe(131);
		expect(result.compactedGenerationCount).toBe(3);
		expect(result.steps.every(({ compactedDeleteCount }) => compactedDeleteCount === 1)).toBe(true);
		expect(result.steps.at(-1)?.archivalDeleteCount).toBe(128);
		expect(result.steps.at(-1)?.activeGenerationId).toBe("83".padStart(64, "0"));
	});

	it("freezes one sorted duplicate-free proof-kind registry", () => {
		const names = D109F_PROOF_KIND_REGISTRY.map(({ name }) => name);
		const lifecycleOwnerKeys = D109F_PROOF_KIND_REGISTRY.flatMap((entry) =>
			"ownerKey" in entry ? [entry.ownerKey] : []
		);
		expect(names).toEqual([...names].sort());
		expect(new Set(names).size).toBe(names.length);
		expect(lifecycleOwnerKeys.sort()).toEqual([...D109D_CENSUS_KEYS].sort());
		expect(new Set(D109F_PROOF_KIND_REGISTRY.map(({ proofKind }) => proofKind))).toEqual(
			new Set(["durable-count", "owner-observed-lifecycle", "retained-unchanged", "stable-key-set"])
		);
		expect(names).toEqual([
			"ahe.blobs",
			"ahe.generations",
			"ahe.heads",
			"ahe.promotions",
			"ahe.references",
			"browser.facade-keys",
			"creator-close.commitment",
			"creator-close.durable-replay",
			"creator-close.graph",
			"creator-close.persisted-snapshot",
			"creator-close.staged-snapshot",
			"issuance.issued-records",
			"issuance.lineage",
			"issuance.outbox",
			"issuance.watermark",
			"legacy.finality",
			"legacy.object",
			"live-journal.rows",
			"package.export-maps",
			"package.factory-maps",
			"package.module-maps",
			"runtime.anchor",
			"runtime.application-authors",
			"runtime.application-charges",
			"runtime.application-vertices",
			"runtime.blueprint-state",
			"runtime.causality-index",
			"runtime.displaced-rebase-cursor",
			"runtime.displaced-source",
			"runtime.epoch-bytes",
			"runtime.graph-version",
			"runtime.hot-predecessor",
			"runtime.latched-operations",
			"runtime.pending-ingress",
			"runtime.pending-ingress-bytes",
			"runtime.publication",
			"runtime.quarantine",
			"runtime.rebase",
			"runtime.retained-payload-metadata",
			"snapshot-quarantine.chunks",
		]);
	});

	it("deeply freezes the detached pruned-record error scope", () => {
		const error = createDurableIssuanceRecordPrunedError(D109F_SCOPE, 0);
		expect(error.code).toBe("ISSUANCE_RECORD_PRUNED");
		expect(error.scope).not.toBe(D109F_SCOPE);
		expect(Object.isFrozen(error.scope), "D109F_PRUNED_SCOPE_NOT_FROZEN").toBe(true);
		expect(d109fDeepFrozen(error)).toBe(true);
	});

	it("keeps the three GREEN defects confined to their named owners", () => {
		const ahe = readFileSync(resolve(REPOSITORY_ROOT, D109F_GREEN_PATHS[0]), "utf8");
		const issuance = readFileSync(resolve(REPOSITORY_ROOT, D109F_GREEN_PATHS[1]), "utf8");
		const node = readFileSync(resolve(REPOSITORY_ROOT, D109F_GREEN_PATHS[2]), "utf8");
		expect(ahe).toContain("captureAheReclamationInput");
		expect(issuance).toContain("createDurableIssuanceRecordPrunedError");
		expect(node).toContain("inspectPruningState");
		const builtFactory = readFileSync(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-3a1b-p3/live-fixture.ts"), "utf8");
		const builtMaintenance = readFileSync(
			resolve(REPOSITORY_ROOT, "tests/fixtures/phase-6b/runtime-reclamation-contract.ts"),
			"utf8"
		);
		expect(builtFactory).toContain('packages/storage-node/dist/src/index.js"');
		expect(builtMaintenance).toContain('packages/storage-node/dist/src/maintenance.js"');
	});
});

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	D109F_GREEN_PATHS,
	D109F_RED_PATHS,
	D109F_SCOPE,
	D109F_STEP_COUNT,
	d109fDeepFrozen,
	runD109fPlannerDifferential,
} from "./fixtures/phase-6b/differential-exit-contract.js";
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
		expect(result.selectedEpochRowCounts).toEqual([65, 65]);
		expect(result.discordProjection).toMatchObject({ channelCount: 65, messageCount: 65 });
		expect(result.mmorpgProjection).toMatchObject({ inventoryEntries: 65, worldEvents: 65 });
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
	});
});

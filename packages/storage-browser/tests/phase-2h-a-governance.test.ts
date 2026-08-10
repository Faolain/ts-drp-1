import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import inertConfig from "../playwright.protocol-v2-inert.config.js";
import protocolConfig from "../playwright.protocol-v2.config.js";
import { phase2hCoverageErrors, type Phase2hCoverageMeasurement } from "./fixtures/phase-2h-a-coverage.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function json(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(repositoryRoot, file), "utf8")) as Record<string, unknown>;
}

describe("Phase 2h-a configuration and governance", () => {
	it("pins the package-local three-engine serial config outside the RunId root", () => {
		expect(protocolConfig.testMatch).toEqual([
			"phase-2h-b-browser-surfaces-red.pw.ts",
			"phase-2h-c-capacity-quota-red.pw.ts",
		]);
		expect(protocolConfig.fullyParallel).toBe(false);
		expect(protocolConfig.workers).toBe(1);
		expect(protocolConfig.retries).toBe(0);
		expect(protocolConfig.projects?.map(({ name }) => name)).toEqual(["chromium", "firefox", "webkit"]);
		expect(protocolConfig.use?.trace).toBe("retain-on-failure");
		expect(protocolConfig.outputDir).toBe("./test-results/playwright-phase-2h-a");
		expect(path.resolve("packages/storage-browser", String(protocolConfig.outputDir))).not.toContain(
			path.resolve("packages/storage-browser/test-results/phase-2h") + path.sep
		);
		expect(inertConfig.testMatch).toBe("phase-2h-a-inert-red.pw.ts");
		expect(inertConfig.globalSetup).toBe(protocolConfig.globalSetup);
		expect(inertConfig.projects?.map(({ name }) => name)).toEqual(["chromium", "firefox", "webkit"]);
		expect(inertConfig.outputDir).not.toBe(protocolConfig.outputDir);
	});

	it("typechecks but build-excludes the config using the established package pattern", () => {
		const typecheck = json("packages/storage-browser/tsconfig.json");
		const build = json("packages/storage-browser/tsconfig.build.json");
		expect(typecheck.include).toContain("playwright.protocol-v2.config.ts");
		expect(typecheck.include).toContain("playwright.protocol-v2-inert.config.ts");
		expect(build.exclude).toContain("playwright.protocol-v2.config.ts");
		expect(build.exclude).toContain("playwright.protocol-v2-inert.config.ts");
	});

	it("keeps the workflow dormant, direct-config-only and upload-on-always", () => {
		const workflowPath = path.join(repositoryRoot, ".github/workflows/phase-2h-a-browser-validation-red.yml");
		const source = fs.readFileSync(workflowPath, "utf8");
		const workflow = YAML.parse(source) as Record<string, unknown>;
		const triggers = Reflect.get(workflow, "on") as Record<string, unknown>;
		expect(Object.keys(triggers)).toEqual(["workflow_dispatch"]);
		expect(source).not.toMatch(/^\s+(?:push|pull_request):/mu);
		expect(source).toContain(
			"pnpm exec playwright test --config packages/storage-browser/playwright.protocol-v2.config.ts --fail-on-flaky-tests"
		);
		expect(source).toContain("playwright install --with-deps chromium firefox webkit");
		expect(source).toContain("if: always()");
		expect(source).toContain("packages/storage-browser/test-results/phase-2h/ahe-storage-validation.json");
		expect(source).toContain("packages/storage-browser/test-results/phase-2h/phase-2h/**");
		expect(source).toContain("packages/storage-browser/test-results/playwright-phase-2h-a/**");
	});

	it("does not add the Phase 2h root script before 2h-e", () => {
		const rootPackage = json("package.json");
		const scripts = rootPackage.scripts as Record<string, unknown>;
		expect(scripts["e2e-test:protocol-v2"]).toBeUndefined();
		expect(scripts["e2e-test:storage-browser"]).not.toContain("protocol-v2");
	});

	it("keeps browser schema v1 and the production package surface untouched", () => {
		const schema = fs.readFileSync(
			path.join(repositoryRoot, "packages/storage-browser/src/internal/schema-idb.ts"),
			"utf8"
		);
		expect(schema).toContain("version: 1");
		for (const store of ["objects", "generations", "blobs", "promotions"]) expect(schema).toContain(`"${store}"`);
		expect(schema).not.toMatch(/voteSlots|storageMeta|signerState|voteOutbox/u);
	});

	it("validates the bounded coverage-denominator before/after contract", () => {
		const common = Object.freeze({
			command: "pnpm exec vitest run --coverage",
			gitSha: "a".repeat(40),
			nodeVersion: "v22.0.0",
			pnpmVersion: "10.24.0",
			providerVersion: "3.0.5",
			thresholdLines: 70 as const,
			vitestVersion: "3.1.1",
		});
		const before: Phase2hCoverageMeasurement = { ...common, config: null, lf: 41_486, lh: 35_000, worktree: "before" };
		const after: Phase2hCoverageMeasurement = {
			...common,
			config: { lf: 24, sf: "packages/storage-browser/playwright.protocol-v2.config.ts" },
			lf: 41_510,
			lh: 35_000,
			worktree: "after",
		};
		expect(phase2hCoverageErrors(before, after)).toEqual([]);
		const mutants = [
			{ ...after, command: "different" },
			{ ...after, gitSha: "b".repeat(40) },
			{ ...after, config: null },
			{ ...after, lf: after.lf + 1 },
			{ ...after, lh: after.lh + 1 },
		] as const;
		for (const mutant of mutants) expect(phase2hCoverageErrors(before, mutant)).not.toEqual([]);
	});
});

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

function isAncestor(ancestor: string, descendant: string): boolean {
	const relative = path.relative(ancestor, descendant);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

describe("Phase 2h-a configuration and governance", () => {
	it("pins the package-local three-engine serial config outside evidence and separates inert custody", () => {
		expect(protocolConfig.testMatch).toEqual([
			"phase-2h-b-browser-surfaces-red.pw.ts",
			"phase-2h-c-capacity-quota-red.pw.ts",
			"phase-2h-d-process-death-producer.pw.ts",
			"phase-2h-d-process-death-red.pw.ts",
		]);
		const orderedMatches = Array.isArray(protocolConfig.testMatch) ? protocolConfig.testMatch.map(String) : [];
		expect(orderedMatches.indexOf("phase-2h-d-process-death-producer.pw.ts")).toBe(
			orderedMatches.indexOf("phase-2h-d-process-death-red.pw.ts") - 1
		);
		expect(protocolConfig.fullyParallel).toBe(false);
		expect(protocolConfig.workers).toBe(1);
		expect(protocolConfig.retries).toBe(0);
		expect(protocolConfig.projects?.map(({ name }) => name)).toEqual(["chromium", "firefox", "webkit"]);
		expect(protocolConfig.use?.trace).toBe("retain-on-failure");
		expect(protocolConfig.outputDir).toBe("./test-results/playwright-phase-2h-a");
		const runnerOutput = path.resolve("packages/storage-browser", String(protocolConfig.outputDir));
		const runRoot = path.resolve(
			"packages/storage-browser/test-results/phase-2h/phase-2h",
			"a".repeat(40),
			"00000000-0000-4000-8000-000000000000"
		);
		expect(isAncestor(runnerOutput, runRoot)).toBe(false);
		expect(isAncestor(path.resolve("packages/storage-browser/test-results"), runRoot)).toBe(true);
		expect(inertConfig.testMatch).toBe("phase-2h-a-inert-red.pw.ts");
		expect.soft(inertConfig.globalSetup).not.toBe(protocolConfig.globalSetup);
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

	it("keeps scratch crash-safe and teardown as the sole authoritative aggregate finalizer", () => {
		const setupSource = fs.readFileSync(
			path.join(repositoryRoot, "packages/storage-browser/tests/phase-2h-a-global-setup.ts"),
			"utf8"
		);
		expect(setupSource).toContain('const assetRoot = path.join(packageDirectory, "test-results")');
		expect(setupSource).not.toContain("os.tmpdir");
		expect(setupSource.indexOf("await parent.close()", setupSource.indexOf("return async"))).toBeLessThan(
			setupSource.indexOf("aggregatePhase2h({", setupSource.indexOf("return async"))
		);
		expect(setupSource.indexOf("aggregatePhase2h({", setupSource.indexOf("return async"))).toBeLessThan(
			setupSource.indexOf("writePhase2hAggregate(layout, aggregate)", setupSource.indexOf("return async"))
		);
		for (const producer of Array.isArray(protocolConfig.testMatch) ? protocolConfig.testMatch : []) {
			const producerSource = fs.readFileSync(
				path.join(repositoryRoot, "packages/storage-browser/tests", String(producer)),
				"utf8"
			);
			expect(producerSource).not.toContain("writePhase2hAggregate");
		}
	});

	it("activates pull-request execution without the temporary push transport and preserves workflow custody", () => {
		const workflowPath = path.join(repositoryRoot, ".github/workflows/phase-2h-a-browser-validation-red.yml");
		const source = fs.readFileSync(workflowPath, "utf8");
		const workflow = YAML.parse(source) as Record<string, unknown>;
		const triggers = Reflect.get(workflow, "on") as Record<string, unknown>;
		const permissions = workflow.permissions as Record<string, unknown>;
		const jobs = workflow.jobs as Record<string, unknown>;
		const job = jobs["native-process-death-campaign"] as Record<string, unknown>;
		const steps = job.steps as Array<Record<string, unknown>>;

		expect.soft(Reflect.has(triggers, "pull_request")).toBe(true);
		expect.soft(Reflect.has(triggers, "pull_request_target")).toBe(false);
		expect.soft(Reflect.has(triggers, "push")).toBe(false);
		expect(permissions).toEqual({ contents: "read" });
		expect(source).not.toContain("secrets.");
		expect(Object.keys(jobs)).toEqual(["native-process-death-campaign"]);
		expect(job["runs-on"]).toBe("ubuntu-latest");
		expect(job["timeout-minutes"]).toBe(20);
		expect(source).toContain(
			"pnpm exec playwright test --config packages/storage-browser/playwright.protocol-v2.config.ts --fail-on-flaky-tests"
		);
		expect(source).toContain("playwright install --with-deps chromium firefox webkit");

		const captureSteps = steps.filter(({ name }) => name === "Require all native-x64 pre-signal admission captures");
		expect(captureSteps).toHaveLength(1);
		expect(String(captureSteps[0]?.run).trim().split("\n")).toEqual([
			'test "$(find packages/storage-browser/test-results/phase-2h-native-admission -name chromium.json -type f | wc -l)" -eq 1',
			'test "$(find packages/storage-browser/test-results/phase-2h-native-admission -name firefox.json -type f | wc -l)" -eq 1',
			'test "$(find packages/storage-browser/test-results/phase-2h-native-admission -name webkit.json -type f | wc -l)" -eq 1',
		]);

		const uploadSteps = steps.filter(({ uses }) => uses === "actions/upload-artifact@v4");
		expect(uploadSteps).toHaveLength(1);
		expect(uploadSteps[0]?.if).toBe("always()");
		const upload = uploadSteps[0]?.with as Record<string, unknown>;
		expect(upload.name).toBe("phase-2h-a-browser-validation-red");
		expect(upload["if-no-files-found"]).toBe("error");
		expect(String(upload.path).trim().split("\n")).toEqual([
			"packages/storage-browser/test-results/phase-2h/ahe-storage-validation.json",
			"packages/storage-browser/test-results/phase-2h/phase-2h/**",
			"packages/storage-browser/test-results/playwright-phase-2h-a/**",
			"packages/storage-browser/test-results/phase-2h-native-admission/**",
		]);

		expect.soft(new Set(Object.keys(triggers))).toEqual(new Set(["workflow_dispatch", "pull_request"]));
	});

	it("activates only the exact package-local Phase 2h root script", () => {
		const rootPackage = json("package.json");
		const scripts = rootPackage.scripts as Record<string, unknown>;
		expect
			.soft(scripts["e2e-test:protocol-v2"])
			.toBe(
				"pnpm exec playwright test --config packages/storage-browser/playwright.protocol-v2.config.ts --fail-on-flaky-tests"
			);
		expect(scripts["e2e-test:storage-browser"]).not.toContain("protocol-v2");
	});

	it("retains the historical v1 authority while assigning the current v2 vote stores only to Phase 5c", () => {
		const schema = fs.readFileSync(
			path.join(repositoryRoot, "packages/storage-browser/src/internal/schema-idb.ts"),
			"utf8"
		);
		expect(schema).toContain("PHASE_2D_SCHEMA_AUTHORITY");
		expect(schema).toContain("version: 1");
		expect(schema).toContain("PHASE_5C_SCHEMA_AUTHORITY");
		expect(schema).toContain("version: 2");
		for (const store of ["objects", "generations", "blobs", "promotions"]) expect(schema).toContain(`"${store}"`);
		for (const store of ["voteSlots", "storageMeta", "signerState", "voteOutbox"]) {
			expect(schema).toContain(`"${store}"`);
		}
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

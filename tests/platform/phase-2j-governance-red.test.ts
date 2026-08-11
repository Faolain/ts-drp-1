import { devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import protocolConfig from "../../packages/storage-browser/playwright.protocol-v2.config.js";
import {
	aggregatePhase2h,
	consumeCurrentPhase2hAggregate,
} from "../../packages/storage-browser/tests/fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlEntries,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
} from "../../packages/storage-browser/tests/fixtures/phase-2h-a-controls.js";
import {
	PHASE_2H_ENGINES,
	PHASE_2H_REQUIRED_TUPLE_IDS,
	PHASE_2H_SCENARIOS,
} from "../../packages/storage-browser/tests/fixtures/phase-2h-a-registry.js";
import platformConfig from "../../playwright.platform-capability.config.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function json(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(repositoryRoot, file), "utf8")) as Record<string, unknown>;
}

describe("Phase 2j config and workflow ownership RED", () => {
	it("keeps the exact five trusted descriptor-backed provenance mappings", () => {
		const expected = [
			{ browser: "chromium", descriptor: "Desktop Chrome", name: "chromium" },
			{ browser: "firefox", descriptor: "Desktop Firefox", name: "firefox" },
			{ browser: "webkit", descriptor: "Desktop Safari", name: "webkit" },
			{ browser: "webkit", descriptor: "iPhone 15", name: "ios-safari-emulation" },
			{ browser: "chromium", descriptor: "Pixel 7", name: "android-chrome-emulation" },
		] as const;
		expect(platformConfig.projects?.map(({ name }) => name)).toEqual(expected.map(({ name }) => name));
		for (const [index, row] of expected.entries()) {
			const use = platformConfig.projects?.[index]?.use;
			expect(use?.defaultBrowserType).toBe(row.browser);
			expect(use?.userAgent).toBe(devices[row.descriptor].userAgent);
			expect(use?.isMobile).toBe(devices[row.descriptor].isMobile);
			expect(use?.viewport).toEqual(devices[row.descriptor].viewport);
		}
	});

	it("makes the existing config the sole bounded setup/finalization owner", () => {
		expect(platformConfig.globalSetup).toBe("./tests/platform/phase-2j-webcrypto-global-setup.ts");
		expect(platformConfig.testMatch).toEqual(/webcrypto-capability\.pw\.ts/u);
		expect(platformConfig.outputDir).toBe("./test-results/phase-2j/playwright");
		expect(platformConfig.retries).toBe(0);
		expect(platformConfig.use?.trace).toBe("retain-on-failure");
		const rootPackage = json("package.json");
		const scripts = rootPackage.scripts as Record<string, unknown>;
		expect(scripts["e2e-test:platform"]).toBe(
			"pnpm exec playwright test --config playwright.platform-capability.config.ts"
		);
	});

	it("adds a dedicated PR/manual workflow with direct execution, current consumption and always-on custody", () => {
		const workflowPath = path.join(repositoryRoot, ".github/workflows/phase-2j-webcrypto-capability.yml");
		expect(fs.existsSync(workflowPath)).toBe(true);
		if (!fs.existsSync(workflowPath)) return;
		const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as Record<string, unknown>;
		const triggers = Reflect.get(workflow, "on") as Record<string, unknown>;
		const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
		expect(new Set(Object.keys(triggers))).toEqual(new Set(["pull_request", "workflow_dispatch"]));
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(Object.keys(jobs)).toHaveLength(1);
		const job = Object.values(jobs)[0];
		expect(job?.["runs-on"]).toBe("ubuntu-latest");
		const steps = job?.steps as Array<Record<string, unknown>>;
		expect(
			steps.some(({ run }) =>
				String(run).includes("pnpm exec playwright test --config playwright.platform-capability.config.ts")
			)
		).toBe(true);
		expect(
			steps.some(({ run }) => String(run).includes("test-results/phase-2j/webcrypto-capability-matrix.json"))
		).toBe(true);
		const uploads = steps.filter(({ uses }) => uses === "actions/upload-artifact@v4");
		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.if).toBe("always()");
		const upload = uploads[0]?.with as Record<string, unknown>;
		expect(upload["if-no-files-found"]).toBe("error");
		expect(String(upload.path).trim().split("\n")).toEqual([
			"test-results/phase-2j/webcrypto-capability-matrix.json",
			"test-results/phase-2j/phase-2j/**",
			"test-results/phase-2j/playwright/**",
		]);
	});
});

describe("Phase 2h non-widening guard", () => {
	it("retains exactly 69 tuples, three projects and six scenarios", () => {
		expect(PHASE_2H_REQUIRED_TUPLE_IDS).toHaveLength(69);
		expect(PHASE_2H_ENGINES).toEqual(["chromium", "firefox", "webkit"]);
		expect(PHASE_2H_SCENARIOS).toHaveLength(6);
		expect(protocolConfig.projects?.map(({ name }) => name)).toEqual(PHASE_2H_ENGINES);
	});

	it("keeps the closed Phase 2h aggregate at twelve keys and rejects a capability key", () => {
		const aggregate = aggregatePhase2h({
			entries: phase2hControlEntries(),
			gitSha: PHASE_2H_CONTROL_GIT_SHA,
			runId: PHASE_2H_CONTROL_RUN_ID,
		});
		expect(aggregate.records).toHaveLength(69);
		expect(Object.keys(aggregate)).toHaveLength(12);
		expect(
			consumeCurrentPhase2hAggregate(aggregate, {
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				runId: PHASE_2H_CONTROL_RUN_ID,
			})
		).toEqual(aggregate);
		expect(() =>
			consumeCurrentPhase2hAggregate(
				{ ...aggregate, webcryptoCapability: { verdict: "pass" } },
				{ gitSha: PHASE_2H_CONTROL_GIT_SHA, runId: PHASE_2H_CONTROL_RUN_ID }
			)
		).toThrow(/closed/u);
	});
});

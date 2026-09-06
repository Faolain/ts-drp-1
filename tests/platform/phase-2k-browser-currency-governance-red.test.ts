import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
	currencyInput,
	loadPhase2kOwner,
	PHASE_2K_ARTIFACT_KEYS,
	PHASE_2K_GIT_SHA,
	PHASE_2K_RAW_SOURCES,
	PHASE_2K_RUN_ID,
	PHASE_2K_UUID,
	sourceSnapshot,
} from "./fixtures/phase-2k-browser-currency-red-controls.js";
import currentShippingManifest from "../fixtures/phase-0j-d-v3/current-inactive-shipping-targets.json" with { type: "json" };
import syntheticShippingManifest from "../fixtures/phase-0j-d-v3/synthetic-shipped-electron-target.json" with { type: "json" };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories = new Set<string>();

afterEach(() => {
	for (const directory of temporaryDirectories) fs.rmSync(directory, { force: true, recursive: true });
	temporaryDirectories.clear();
});

function json(relativePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8")) as Record<string, unknown>;
}

function yaml(relativePath: string): Record<string, unknown> {
	const file = path.join(repositoryRoot, relativePath);
	return fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
}

function currentDependencyInput(): Record<string, unknown> {
	const lock = YAML.parse(fs.readFileSync(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8")) as {
		importers: Record<string, unknown>;
		packages: Record<string, unknown>;
	};
	const versions = {
		"@playwright/test": [] as string[],
		"playwright": [] as string[],
		"playwright-core": [] as string[],
	};
	for (const key of Object.keys(lock.packages)) {
		for (const packageName of Object.keys(versions)) {
			const prefix = `${packageName}@`;
			if (key.startsWith(prefix)) versions[packageName as keyof typeof versions].push(key.slice(prefix.length));
		}
	}
	return {
		installedPackageEntries: fs
			.readdirSync(path.join(repositoryRoot, "node_modules/.pnpm"))
			.filter(
				(entry) =>
					entry.startsWith("@playwright+test@") ||
					entry.startsWith("playwright@") ||
					entry.startsWith("playwright-core@")
			),
		installedVersions: versions,
		lockImporters: lock.importers,
		manifests: {
			"package.json": json("package.json"),
			"examples/network-spike/package.json": json("examples/network-spike/package.json"),
		},
		rootPin: (json("package.json").devDependencies as Record<string, string>)["@playwright/test"],
	};
}

function workflowFixture(): Record<string, unknown> {
	return {
		currency: {
			on: { pull_request: {}, workflow_dispatch: {} },
			permissions: { contents: "read" },
			jobs: {
				"browser-currency": {
					"runs-on": "ubuntu-latest",
					"steps": [
						{ run: "pnpm install --frozen-lockfile" },
						{ run: "pnpm exec playwright install --with-deps chromium firefox webkit" },
						{ run: "pnpm exec playwright test --config playwright.browser-currency.config.ts" },
						{ if: "always()", uses: "actions/upload-artifact@v4", with: { "if-no-files-found": "error" } },
					],
				},
			},
		},
		refresh: {
			on: { schedule: [{ cron: "23 5 * * 1" }], workflow_dispatch: {} },
			concurrency: { "cancel-in-progress": false, "group": "phase-2k-browser-currency-refresh" },
			jobs: {
				refresh: {
					"runs-on": "ubuntu-latest",
					"steps": [
						{ run: "pnpm tsx scripts/phase-2k-browser-currency-refresh.ts --branch chore/phase-2k-browser-currency" },
						{ uses: "peter-evans/create-pull-request@v7", with: { branch: "chore/phase-2k-browser-currency" } },
					],
				},
			},
		},
	};
}

describe("Phase 2k artifact, launch and Electron governance RED", () => {
	it("accepts only the closed ordered sixteen-field current-invocation artifact", async () => {
		const owner = await loadPhase2kOwner();
		const artifact = owner.evaluateBrowserCurrency(currencyInput());
		expect(Object.keys(artifact)).toEqual(PHASE_2K_ARTIFACT_KEYS);
		expect(owner.validateArtifact(artifact, { gitSha: PHASE_2K_GIT_SHA, runId: PHASE_2K_RUN_ID })).toEqual({
			artifact,
			errors: [],
		});
		for (const mutant of [
			{ ...artifact, extra: true },
			{ ...artifact, gitSha: "b".repeat(40) },
			{ ...artifact, runId: `phase-2k/${PHASE_2K_GIT_SHA}/not-a-uuid` },
			{ ...artifact, requiredChannelIds: [...artifact.requiredChannelIds].reverse() },
			{ ...artifact, verdict: "pass" },
		]) {
			expect(
				owner.validateArtifact(mutant, { gitSha: PHASE_2K_GIT_SHA, runId: PHASE_2K_RUN_ID }).errors.length
			).toBeGreaterThan(0);
		}
	});

	it("publishes the stable artifact create-only for one GitSha/RunId invocation", async () => {
		const owner = await loadPhase2kOwner();
		const outputBase = fs.mkdtempSync(path.join(os.tmpdir(), "ts-drp-phase-2k-publication-"));
		temporaryDirectories.add(outputBase);
		const artifact = owner.evaluateBrowserCurrency(currencyInput());
		const publication = owner.createArtifactPublication({ gitSha: PHASE_2K_GIT_SHA, outputBase, uuid: PHASE_2K_UUID });
		expect(publication.aggregatePath).toBe(path.join(outputBase, "browser-matrix-currency.json"));
		expect(publication.finalize(artifact)).toEqual(artifact);
		expect(JSON.parse(fs.readFileSync(publication.aggregatePath, "utf8"))).toEqual(artifact);
		expect(() => publication.finalize(artifact)).toThrow(/create-only|exists|duplicate/iu);
	});

	it("binds each real root launch to the resolved installed browser manifest", async () => {
		const owner = await loadPhase2kOwner();
		const valid = {
			launches: [
				{ browserVersion: "151.0.7922.34", engine: "chromium" },
				{ browserVersion: "153.0", engine: "firefox" },
				{ browserVersion: "26.5", engine: "webkit" },
			],
			manifest: { chromium: "151.0.7922.34", firefox: "153.0", webkit: "26.5" },
			manifestOwner: "resolved-root-playwright-core",
		};
		expect(owner.validateRuntimeIdentity(valid).errors).toEqual([]);
		for (const mutant of [
			{ ...valid, launches: valid.launches.slice(0, 2) },
			{
				...valid,
				launches: valid.launches.map((row) => (row.engine === "firefox" ? { ...row, browserVersion: "152.0" } : row)),
			},
			{ ...valid, manifestOwner: "nested-lookalike-playwright-core" },
		]) {
			expect(owner.validateRuntimeIdentity(mutant).errors.length).toBeGreaterThan(0);
		}
	});

	it("keeps the real Electron target inactive and ignores dependencies and lookalike manifests", async () => {
		const owner = await loadPhase2kOwner();
		const observed = owner.evaluateElectron({
			dependencyNames: ["electron", "electron-to-chromium", "is-electron"],
			lookalikeManifests: [syntheticShippingManifest],
			receipts: [],
			shippingManifest: currentShippingManifest,
		});
		expect(observed).toEqual({ activated: false, chromeVersion: null, executions: 0, status: "inactive" });
	});

	it("activates only the exact shipped manifest and validates its closed runtime receipt", async () => {
		const owner = await loadPhase2kOwner();
		const receipt = {
			artifactKind: "ts-drp/electron-runtime-observation/v1",
			chromeVersion: "151.0.7922.34",
			processVersions: { chrome: "151.0.7922.34", electron: "42.0.0" },
			runtime: "electron",
			targetId: "electron-desktop",
			version: "42.0.0",
		};
		const valid = {
			dependencyNames: [],
			lookalikeManifests: [],
			receipts: [receipt],
			shippingManifest: syntheticShippingManifest,
		};
		expect(owner.evaluateElectron(valid)).toEqual({
			activated: true,
			chromeVersion: "151.0.7922.34",
			executions: 1,
			status: "observed",
		});
		for (const mutantReceipt of [
			{ ...receipt, artifactKind: "ts-drp/electron-runtime-observation/v2" },
			{ ...receipt, chromeVersion: "150.0.0.0" },
			{ ...receipt, extra: true },
		]) {
			expect(() => owner.evaluateElectron({ ...valid, receipts: [mutantReceipt] })).toThrow();
		}
	});
});

describe("Phase 2k dependency, refresh and release governance RED", () => {
	it("requires one exact Playwright test/playwright/core graph and removes the network-spike declaration", async () => {
		const owner = await loadPhase2kOwner();
		const good = {
			installedPackageEntries: ["@playwright+test@1.62.1", "playwright@1.62.1", "playwright-core@1.62.1"],
			installedVersions: { "@playwright/test": ["1.62.1"], "playwright": ["1.62.1"], "playwright-core": ["1.62.1"] },
			lockImporters: {
				".": { devDependencies: { "@playwright/test": { specifier: "1.62.1", version: "1.62.1" } } },
				"examples/network-spike": { devDependencies: {} },
			},
			manifests: {
				"package.json": { devDependencies: { "@playwright/test": "1.62.1" } },
				"examples/network-spike/package.json": { devDependencies: {} },
			},
			rootPin: "1.62.1",
		};
		expect(owner.auditPlaywrightGraph(good).errors).toEqual([]);
		const exactPinFallback = structuredClone(good);
		(exactPinFallback.manifests["examples/network-spike/package.json"].devDependencies as Record<string, string>)[
			"@playwright/test"
		] = "1.62.1";
		(
			(exactPinFallback.lockImporters["examples/network-spike"] as Record<string, unknown>).devDependencies as Record<
				string,
				unknown
			>
		)["@playwright/test"] = { specifier: "1.62.1", version: "1.62.1" };
		expect(owner.auditPlaywrightGraph(exactPinFallback).errors).toEqual([]);
		const divergent = structuredClone(good);
		(divergent.manifests["examples/network-spike/package.json"].devDependencies as Record<string, string>)[
			"@playwright/test"
		] = "1.51.1";
		expect(owner.auditPlaywrightGraph(divergent).errors.length).toBeGreaterThan(0);
		expect(owner.auditPlaywrightGraph(currentDependencyInput()).errors).toEqual([]);
	});

	it("plans one fixed atomic refresh and exposes no partial writes on every bounded failure", async () => {
		const owner = await loadPhase2kOwner();
		const expectedPaths = [
			"browser-currency-sources.json",
			"package.json",
			"pnpm-lock.yaml",
			...Object.keys(PHASE_2K_RAW_SOURCES).map((file) => `tests/fixtures/phase-2k/sources/${file}`),
		].sort();
		const valid = {
			currentPlaywrightVersion: "1.61.1",
			nextPlaywrightVersion: "1.62.1",
			rawSources: PHASE_2K_RAW_SOURCES,
			snapshot: sourceSnapshot(),
		};
		const planned = owner.planAtomicRefresh(valid);
		expect(planned).toMatchObject({ errors: [], status: "ready" });
		expect(planned.changes.map((change) => change.path).sort()).toEqual(expectedPaths);
		for (const failure of [
			"timeout",
			"tls",
			"http",
			"redirect",
			"size",
			"encoding",
			"pointer",
			"grammar",
			"schema",
			"cross-source",
			"playwright-major",
			"lock-regeneration",
		]) {
			const failed = owner.planAtomicRefresh({ ...valid, forcedFailure: failure });
			expect(failed.status, failure).toBe("failed");
			expect(failed.changes, failure).toEqual([]);
			expect(failed.errors.length, failure).toBeGreaterThan(0);
		}
		const generalized = owner.planAtomicRefresh({ ...valid, requestedChanges: ["README.md"] });
		expect(generalized.status).toBe("failed");
		expect(generalized.changes).toEqual([]);
	});

	it("owns one non-masking report workflow and one fixed non-cancelling refresh workflow", async () => {
		const owner = await loadPhase2kOwner();
		const fixture = workflowFixture();
		expect(owner.auditWorkflow(fixture).errors).toEqual([]);
		for (const maskedRun of ["pnpm phase-2k:report || true", "set +e\npnpm phase-2k:report"]) {
			const masking = structuredClone(fixture);
			const steps = ((masking.currency as Record<string, unknown>).jobs as Record<string, Record<string, unknown>>)[
				"browser-currency"
			].steps as Record<string, unknown>[];
			steps[2].run = maskedRun;
			expect(owner.auditWorkflow(masking).errors.length).toBeGreaterThan(0);
		}
		const continueOnError = structuredClone(fixture);
		((continueOnError.currency as Record<string, unknown>).jobs as Record<string, Record<string, unknown>>)[
			"browser-currency"
		]["continue-on-error"] = true;
		expect(owner.auditWorkflow(continueOnError).errors.length).toBeGreaterThan(0);
		const cancelling = structuredClone(fixture);
		((cancelling.refresh as Record<string, unknown>).concurrency as Record<string, unknown>)["cancel-in-progress"] =
			true;
		expect(owner.auditWorkflow(cancelling).errors.length).toBeGreaterThan(0);
		const automatic = structuredClone(fixture);
		const refreshSteps = (
			(automatic.refresh as Record<string, unknown>).jobs as Record<string, Record<string, unknown>>
		).refresh.steps as Record<string, unknown>[];
		(refreshSteps[1].with as Record<string, unknown>)["auto-merge"] = true;
		expect(owner.auditWorkflow(automatic).errors.length).toBeGreaterThan(0);
		const missingUpload = structuredClone(fixture);
		const currencySteps = (
			(missingUpload.currency as Record<string, unknown>).jobs as Record<string, Record<string, unknown>>
		)["browser-currency"].steps as Record<string, unknown>[];
		currencySteps.pop();
		expect(owner.auditWorkflow(missingUpload).errors.length).toBeGreaterThan(0);
		expect(
			owner.auditWorkflow({
				currency: yaml(".github/workflows/phase-2k-browser-currency.yml"),
				refresh: yaml(".github/workflows/phase-2k-browser-currency-refresh.yml"),
			}).errors
		).toEqual([]);
	});

	it("places the pure hook before release init and makes every publication reachable from the launch gate", async () => {
		const owner = await loadPhase2kOwner();
		const rootPackage = json("package.json");
		const releaseWorkflow = yaml(".github/workflows/release.yml");
		const candidate = { packageManifest: rootPackage, workflow: releaseWorkflow };
		expect(owner.auditReleaseWorkflow(candidate)).toEqual({
			errors: [],
			publicationJobs: ["npm_publish", "publish_buf_registry", "build_docker_images"],
		});
		const bypass = structuredClone(candidate);
		const jobs = bypass.workflow.jobs as Record<string, Record<string, unknown>>;
		jobs.npm_publish.needs = ["phase-0j-c-release-conformance"];
		expect(owner.auditReleaseWorkflow(bypass).errors.length).toBeGreaterThan(0);
		const noHook = structuredClone(candidate);
		delete ((noHook.packageManifest["release-it"] as Record<string, unknown>).hooks as Record<string, unknown>)[
			"before:init"
		];
		expect(owner.auditReleaseWorkflow(noHook).errors.length).toBeGreaterThan(0);
	});
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	phase2e7ClosureErrors,
	type Phase2e7ClosureObservation,
	PHASE_2E7_GREEN_CHANGE_PATHS,
	PHASE_2E7_PACKAGE_FILES,
	PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS,
	PHASE_2E7_PUBLIC_RUNTIME_KEYS,
	PHASE_2E7_RETAINED_GOVERNANCE_PATHS,
	PHASE_2E7_TOY_IMPORT_EDGES,
	PHASE_2E7_TOY_REMOVE_PATHS,
	PHASE_2E7_TOY_REWRITE_PATHS,
} from "./fixtures/phase-2e7-publication-component-contract.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");

function workspacePath(relative: string): string {
	return path.join(WORKSPACE_DIRECTORY, relative);
}

function text(relative: string): string {
	return fs.readFileSync(workspacePath(relative), "utf8");
}

function textIfPresent(relative: string): string {
	return fs.existsSync(workspacePath(relative)) ? text(relative) : "";
}

function json(relative: string): Record<string, unknown> {
	return JSON.parse(text(relative)) as Record<string, unknown>;
}

function currentClosure(): Phase2e7ClosureObservation {
	const metadata = json("packages/storage-browser/package.json");
	const exportsMap = metadata.exports as Record<string, unknown> | undefined;
	const telemetryOwners = [
		"packages/storage-browser/tests/fixtures/phase-2e6-real-process-death-contract.ts",
		"packages/storage-browser/tests/fixtures/phase-2e6-real-process-death-validator.ts",
		"packages/storage-browser/tests/phase-2e6-real-process-death-contract-red.test.ts",
		PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.staleTest,
		PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.frozenTest,
	];
	const telemetryFields = ["mainThreadAtomicsWaitCalls", "publicResultDeliveries"];
	const presentTelemetry = telemetryFields.filter((field) =>
		telemetryOwners.some((owner) => textIfPresent(owner).includes(field))
	);
	const presentEdges = PHASE_2E7_TOY_IMPORT_EDGES.filter(({ from, to }) => text(from).includes(to)).map(
		({ from, to }) => `${from}->${to}`
	);
	const phase2e6Authority: string[] = [PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.staleTest].filter((candidate) =>
		fs.existsSync(workspacePath(candidate))
	);
	if (
		!textIfPresent(PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.config).includes(
			`testMatch: "${path.basename(PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.frozenTest)}"`
		)
	)
		phase2e6Authority.push(PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.config);
	const phase2e6Sources = [
		PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.config,
		PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.frozenTest,
		PHASE_2E7_PHASE_2E6_AUTHORITY_PATHS.staleTest,
		"packages/storage-browser/tests/phase-2e6-global-setup.ts",
		"packages/storage-browser/tests/assets/phase-2e6-real-process-death-entry.ts",
		"packages/storage-browser/tests/assets/phase-2e6-real-process-death-worker.ts",
	].filter((candidate) => fs.existsSync(workspacePath(candidate)));
	const agentPaths = phase2e6Sources.filter((owner) => /(?:codex|claude|agent)/iu.test(text(owner)));
	return {
		// Runtime keys are observed only by the real bundled Chromium component.
		publicRuntimeKeys: [],
		exportSubpaths: Object.keys(exportsMap ?? {}),
		toyPathsPresent: PHASE_2E7_TOY_REMOVE_PATHS.filter((candidate) => fs.existsSync(workspacePath(candidate))),
		toyImportEdgesPresent: presentEdges,
		telemetryFieldsPresent: presentTelemetry,
		staleAuthorityPathsPresent: phase2e6Authority,
		agentNamedArtifactPathsPresent: agentPaths,
		// Rollback behavior is observed only by the real bundled Chromium component.
		rollbackControl: undefined,
	};
}

describe("Phase 2e7 public browser package and component closure", () => {
	it("freezes one stable public root and publishable workspace metadata", () => {
		const metadata = json("packages/storage-browser/package.json");
		expect.soft(metadata).not.toHaveProperty("private");
		expect.soft(metadata).toMatchObject({
			license: "MIT",
			repository: { type: "git", url: "git+https://github.com/drp-tech/ts-drp.git" },
			types: "./dist/src/index.d.ts",
			files: PHASE_2E7_PACKAGE_FILES,
			exports: { ".": { types: "./dist/src/index.d.ts", import: "./dist/src/index.js" } },
		});
		expect.soft((metadata.scripts as Record<string, unknown> | undefined)?.prepack).toBe("tsc -b");
		expect.soft(Object.keys((metadata.exports as Record<string, unknown> | undefined) ?? {})).toEqual(["."]);
		expect.soft(fs.existsSync(workspacePath("packages/storage-browser/src/index.ts"))).toBe(true);
	});

	it("ships functional root JavaScript and declarations without tests, Playwright, toy, or build-info artifacts", () => {
		execFileSync("pnpm", ["--dir", PACKAGE_DIRECTORY, "build"], { cwd: WORKSPACE_DIRECTORY, stdio: "pipe" });
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
				cwd: PACKAGE_DIRECTORY,
				encoding: "utf8",
			})
		) as readonly [{ readonly files: readonly { readonly path: string }[] }];
		const files = packed[0]?.files.map(({ path: packedPath }) => packedPath) ?? [];
		expect.soft(files).toContain("dist/src/index.js");
		expect.soft(files).toContain("dist/src/index.d.ts");
		expect
			.soft(
				files.filter(
					(candidate) =>
						/(^|\/)(?:tests?|playwright[^/]*|killpoints\.json)(?:\/|$)/u.test(candidate) ||
						candidate.endsWith(".tsbuildinfo") ||
						candidate.includes("instrumented-idb") ||
						candidate.includes("src/killpoints")
				)
			)
			.toEqual([]);
	});

	it("retires the complete toy campaign while retaining shared process, server, and ownership governance", () => {
		const observed = currentClosure();
		expect.soft(observed.toyPathsPresent).toEqual([]);
		expect.soft(observed.toyImportEdgesPresent).toEqual([]);
		for (const retained of PHASE_2E7_RETAINED_GOVERNANCE_PATHS)
			expect.soft(fs.existsSync(workspacePath(retained)), retained).toBe(true);
		expect.soft(new Set(PHASE_2E7_TOY_REMOVE_PATHS).size).toBe(PHASE_2E7_TOY_REMOVE_PATHS.length);
		expect.soft(new Set(PHASE_2E7_TOY_REWRITE_PATHS).size).toBe(PHASE_2E7_TOY_REWRITE_PATHS.length);
	});

	it("folds non-vacuous Phase 2e6 telemetry and custody hygiene into the renamed authority", () => {
		const observed = currentClosure();
		expect.soft(observed.telemetryFieldsPresent).toEqual([]);
		expect.soft(observed.staleAuthorityPathsPresent).toEqual([]);
		expect.soft(observed.agentNamedArtifactPathsPresent).toEqual([]);
	});

	it("closes the ownership ledger and kills one mutant for every Phase 2e7 boundary", () => {
		const control: Phase2e7ClosureObservation = {
			publicRuntimeKeys: PHASE_2E7_PUBLIC_RUNTIME_KEYS,
			exportSubpaths: ["."],
			toyPathsPresent: [],
			toyImportEdgesPresent: [],
			telemetryFieldsPresent: [],
			staleAuthorityPathsPresent: [],
			agentNamedArtifactPathsPresent: [],
			rollbackControl: { candidateState: "Complete", expectedHead: "stale", result: "HEAD_CONFLICT" },
		};
		expect(phase2e7ClosureErrors(control)).toEqual([]);
		const mutants: readonly Phase2e7ClosureObservation[] = [
			{ ...control, publicRuntimeKeys: ["createPhase2dAheDurableStore"] },
			{ ...control, exportSubpaths: [".", "./internal/idb-adapter"] },
			{ ...control, toyPathsPresent: [PHASE_2E7_TOY_REMOVE_PATHS[0] ?? "missing"] },
			{ ...control, toyImportEdgesPresent: ["toy->owner"] },
			{ ...control, telemetryFieldsPresent: ["publicResultDeliveries"] },
			{ ...control, staleAuthorityPathsPresent: ["phase-red.pw.ts"] },
			{ ...control, agentNamedArtifactPathsPresent: ["green-agent/artifacts"] },
			{ ...control, rollbackControl: { candidateState: "Adopted", expectedHead: "stale", result: "HEAD_CONFLICT" } },
		];
		for (const mutant of mutants) expect(phase2e7ClosureErrors(mutant)).not.toEqual([]);
		expect(new Set(PHASE_2E7_GREEN_CHANGE_PATHS).size).toBe(PHASE_2E7_GREEN_CHANGE_PATHS.length);
	});
});

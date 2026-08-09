import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import inventoryConfig from "../playwright.phase-2e5-browser-inventory.config.js";
import {
	phase2e5AuthorityErrors,
	type Phase2e5AuthorityInput,
	PHASE_2E5_MATRIX,
	PHASE_2E5_ROOT_COMMAND,
} from "./fixtures/phase-2e5-browser-inventory-authority.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");
const MATRIX_PATH = path.join(PACKAGE_DIRECTORY, "tests", PHASE_2E5_MATRIX);
const WORKFLOW_PATH = path.join(WORKSPACE_DIRECTORY, ".github/workflows/storage-browser-request-inventory.yml");

function workflowCommands(): readonly string[] {
	const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as {
		readonly jobs?: Readonly<Record<string, { readonly steps?: readonly { readonly run?: unknown }[] }>>;
	};
	return Object.values(workflow.jobs ?? {}).flatMap(({ steps = [] }) =>
		steps.flatMap(({ run }) => (typeof run === "string" ? [run] : []))
	);
}

function actualAuthority(): Phase2e5AuthorityInput {
	const root = JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIRECTORY, "package.json"), "utf8")) as {
		readonly scripts?: Readonly<Record<string, unknown>>;
	};
	return {
		ciCommands: workflowCommands(),
		configMatch: inventoryConfig.testMatch,
		matrixExists: fs.existsSync(MATRIX_PATH),
		matrixSource: fs.existsSync(MATRIX_PATH) ? fs.readFileSync(MATRIX_PATH, "utf8") : "",
		rootCommand: root.scripts?.["e2e-test:storage-browser"],
	};
}

describe("Phase 2e5 browser inventory authority", () => {
	it("makes the dedicated nonempty real-adapter matrix authoritative from root and CI", () => {
		expect(actualAuthority()).toMatchObject({
			configMatch: PHASE_2E5_MATRIX,
			matrixExists: true,
			rootCommand: PHASE_2E5_ROOT_COMMAND,
		});
		expect(phase2e5AuthorityErrors(actualAuthority())).toEqual([]);
	});

	it("kills root-command, CI-command, matcher, absent, empty, and skipped bypass mutants", () => {
		const control = actualAuthority();
		const mutants: readonly Phase2e5AuthorityInput[] = [
			{
				...control,
				rootCommand: "pnpm exec playwright test --config packages/storage-browser/missing-storage-browser.config.ts",
			},
			{
				...control,
				ciCommands: ["pnpm exec playwright test --config packages/storage-browser/missing-storage-browser.config.ts"],
			},
			{ ...control, configMatch: "missing-browser-matrix.pw.ts" },
			{ ...control, matrixExists: false },
			{ ...control, matrixSource: "" },
			{ ...control, matrixSource: "test.skip('decorative', () => undefined);" },
		];
		for (const mutant of mutants) expect(phase2e5AuthorityErrors(mutant)).not.toEqual([]);
	});
});

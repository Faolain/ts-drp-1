import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	PACKAGE_RESOLUTION_CONTRACT,
	REPOSITORY_ROOT,
	REQUIRED_GREEN_PATHS,
	REQUIRED_RED_PATHS,
	subprocessResolutionReadiness,
} from "./fixtures/phase-4c-v3/snapshot-subprocess-resolution-contract.js";

function deterministicEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of ["HOME", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
		if (process.env[name] !== undefined) environment[name] = process.env[name];
	}
	return environment;
}

describe("D.107b.1 Phase-4c fresh subprocess resolution RED", () => {
	it("freezes the exact tests-only RED and GREEN infrastructure rosters", () => {
		expect(REQUIRED_RED_PATHS).toEqual([
			"tests/fixtures/phase-4c-v3/snapshot-subprocess-resolution-contract.ts",
			"tests/phase-4c-snapshot-subprocess-resolution-red.test.ts",
		]);
		expect(REQUIRED_GREEN_PATHS).toEqual([
			"tests/fixtures/shared/workspace-package-subprocess.mjs",
			"tests/fixtures/phase-4c-v3/snapshot-stream-memory-child.mjs",
			"tests/phase-4c-snapshot-stream-red.test.ts",
		]);
		expect(PACKAGE_RESOLUTION_CONTRACT.forbiddenMechanisms).toEqual([
			"Vite aliases",
			"NODE_PATH",
			"root shim package",
			"production-relative source imports",
			"stale or gitignored dist artifacts",
			"weakened memory limits",
			"new product APIs",
			"broad production dependency changes",
		]);
		expect(PACKAGE_RESOLUTION_CONTRACT.currentChildBareImports).toEqual(["@noble/hashes/sha2", "@ts-drp/canonical"]);
	});

	it("isolates the root canonical failure while the package graph selects exact built exports", () => {
		const specifier = PACKAGE_RESOLUTION_CONTRACT.requiredRootFailure;
		const direct = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`],
			{
				cwd: REPOSITORY_ROOT,
				encoding: "utf8",
				env: deterministicEnvironment(),
				timeout: 10_000,
			}
		);
		expect(direct.status).not.toBe(0);
		expect(`${direct.stdout}${direct.stderr}`).toMatch(new RegExp(`ERR_MODULE_NOT_FOUND[\\s\\S]*${specifier}`));

		const packageDirectory = resolve(REPOSITORY_ROOT, PACKAGE_RESOLUTION_CONTRACT.anchor, "..");
		const expectedImports = Object.entries(PACKAGE_RESOLUTION_CONTRACT.expectedBuiltImports);
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`for (const specifier of ${JSON.stringify(expectedImports.map(([specifier]) => specifier))}) console.log(specifier + "\\t" + import.meta.resolve(specifier));`,
			],
			{ cwd: packageDirectory, encoding: "utf8", env: deterministicEnvironment() }
		);
		expect(probe.status, probe.stderr).toBe(0);
		const resolvedImports = probe.stdout.trim().split("\n");
		expect(resolvedImports).toHaveLength(expectedImports.length);
		for (const [index, [specifier, expectedPath]] of expectedImports.entries()) {
			const [resolvedSpecifier, resolved] = resolvedImports[index]?.split("\t") ?? [];
			expect(resolvedSpecifier).toBe(specifier);
			if (resolved === undefined) throw new Error(`missing package resolution for ${specifier}`);
			const resolvedPath = fileURLToPath(resolved);
			expect(resolvedPath).toBe(resolve(REPOSITORY_ROOT, expectedPath));
			expect(readFileSync(resolvedPath).byteLength).toBeGreaterThan(0);
		}
	});

	it("[RED readiness] requires the single package-aware fresh-process launcher", () => {
		expect(subprocessResolutionReadiness()).toEqual({ missing: [], ready: true });
	});
});

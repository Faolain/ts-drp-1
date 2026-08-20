import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyRepositoryPath(targetRoot: string, path: string): void {
	const source = join(repositoryRoot, path);
	const target = join(targetRoot, path);
	mkdirSync(dirname(target), { recursive: true });
	if (statSync(source).isDirectory()) cpSync(source, target, { recursive: true });
	else copyFileSync(source, target);
}

function run(targetRoot: string, executable: string, args: readonly string[]): ReturnType<typeof spawnSync> {
	return spawnSync(executable, [...args], {
		cwd: targetRoot,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_EMAIL: "freeze-test@example.invalid",
			GIT_AUTHOR_NAME: "Freeze Test",
			GIT_COMMITTER_EMAIL: "freeze-test@example.invalid",
			GIT_COMMITTER_NAME: "Freeze Test",
			PROTOCOL_FREEZE_REPOSITORY_ROOT: targetRoot,
		},
	});
}

function expectRun(result: ReturnType<typeof spawnSync>, expectedStatus: number): void {
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedStatus);
}

function initializeGit(targetRoot: string): void {
	expectRun(run(targetRoot, "git", ["init", "--quiet"]), 0);
}

function commitAll(targetRoot: string, message: string): void {
	expectRun(run(targetRoot, "git", ["add", "."]), 0);
	expectRun(run(targetRoot, "git", ["commit", "--quiet", "-m", message]), 0);
}

function runFreezeCli(targetRoot: string, base = "HEAD"): ReturnType<typeof spawnSync> {
	return run(targetRoot, process.execPath, [
		realpathSync(join(targetRoot, "packages/protocol-v2/scripts/check-protocol-freeze.mjs")),
		base,
	]);
}

describe("Phase -1e(ii) real freeze CLI", () => {
	it("enforces stacked bootstrap, governance semantics, regenerated provenance, and permanent closure", () => {
		const bootstrapPaths = [
			"CODEOWNERS",
			".github/workflows/protocol-v2-registry.yml",
			"packages/protocol-v2/conformance/freeze-policy.json",
			"packages/protocol-v2/conformance/reference.lock.json",
			"packages/protocol-v2/scripts/check-protocol-freeze.mjs",
			"packages/protocol-v2/tests/fixtures/golden-vectors/registry-v5.json",
		] as const;
		const preFreezePaths = [
			"docs/production-hardening/ts-drp-ahe-review-bundle/SHA256SUMS.txt",
			"packages/protocol-v2/conformance/ahe-reference",
			"packages/protocol-v2/registry/field-registry.json",
		] as const;
		const invalidRoot = mkdtempSync(join(tmpdir(), "protocol-freeze-invalid-base-"));
		const targetRoot = mkdtempSync(join(tmpdir(), "protocol-freeze-cli-"));
		try {
			initializeGit(invalidRoot);
			writeFileSync(join(invalidRoot, "README.md"), "base without protocol-v2\n");
			commitAll(invalidRoot, "invalid base");
			for (const path of [...preFreezePaths, ...bootstrapPaths]) copyRepositoryPath(invalidRoot, path);
			expectRun(runFreezeCli(invalidRoot), 1);

			initializeGit(targetRoot);
			for (const path of preFreezePaths) copyRepositoryPath(targetRoot, path);
			commitAll(targetRoot, "pre-freeze registry and original reference");
			for (const path of bootstrapPaths) copyRepositoryPath(targetRoot, path);
			expectRun(runFreezeCli(targetRoot), 0);

			const targetCodeowners = join(targetRoot, "CODEOWNERS");
			const validCodeowners = readFileSync(targetCodeowners, "utf8");
			writeFileSync(targetCodeowners, `${validCodeowners}* @unauthorized-owner\n`);
			expectRun(runFreezeCli(targetRoot), 1);
			writeFileSync(targetCodeowners, validCodeowners);

			const targetWorkflow = join(targetRoot, ".github/workflows/protocol-v2-registry.yml");
			const validWorkflow = readFileSync(targetWorkflow, "utf8");
			writeFileSync(targetWorkflow, validWorkflow.replace(", edited", ""));
			expectRun(runFreezeCli(targetRoot), 1);
			writeFileSync(targetWorkflow, validWorkflow);

			const alternateCodeowners = join(targetRoot, ".github/CODEOWNERS");
			writeFileSync(alternateCodeowners, "* @unauthorized-owner\n");
			expectRun(runFreezeCli(targetRoot), 1);
			rmSync(alternateCodeowners);
			commitAll(targetRoot, "freeze bootstrap");

			const regeneratedSourcePath = "packages/protocol-v2/conformance/ahe-reference-regen/src/canonical.js";
			const regeneratedLockPath = "packages/protocol-v2/conformance/reference-regen.lock.json";
			const regeneratedSource = join(targetRoot, regeneratedSourcePath);
			const regeneratedLock = join(targetRoot, regeneratedLockPath);
			mkdirSync(dirname(regeneratedSource), { recursive: true });
			writeFileSync(regeneratedSource, "export const regenerated = true;\n");
			const provenancePaths = {
				originalReferenceLock: "packages/protocol-v2/conformance/reference.lock.json",
				registry: "packages/protocol-v2/registry/field-registry.json",
				vectors: "packages/protocol-v2/tests/fixtures/golden-vectors/registry-v5.json",
			} as const;
			const validRegeneratedLock = {
				algorithm: "sha256",
				files: { "src/canonical.js": sha256File(regeneratedSource) },
				provenance: Object.fromEntries(
					Object.entries(provenancePaths).map(([name, path]) => [
						name,
						{ path, sha256: sha256File(join(targetRoot, path)) },
					])
				),
			};
			writeFileSync(regeneratedLock, `${JSON.stringify(validRegeneratedLock, null, "\t")}\n`);
			expectRun(runFreezeCli(targetRoot), 0);

			const badProvenance = structuredClone(validRegeneratedLock);
			badProvenance.provenance.registry.sha256 = "0".repeat(64);
			writeFileSync(regeneratedLock, `${JSON.stringify(badProvenance, null, "\t")}\n`);
			expectRun(runFreezeCli(targetRoot), 1);
			writeFileSync(regeneratedLock, `${JSON.stringify(validRegeneratedLock, null, "\t")}\n`);
			rmSync(regeneratedLock);
			expectRun(runFreezeCli(targetRoot), 1);
			writeFileSync(regeneratedLock, `${JSON.stringify(validRegeneratedLock, null, "\t")}\n`);
			commitAll(targetRoot, "regenerated reference");

			writeFileSync(regeneratedSource, "export const regenerated = false;\n");
			expectRun(runFreezeCli(targetRoot), 1);
			writeFileSync(regeneratedSource, "export const regenerated = true;\n");
			const addedRegeneratedSource = join(
				targetRoot,
				"packages/protocol-v2/conformance/ahe-reference-regen/src/added.js"
			);
			writeFileSync(addedRegeneratedSource, "export const added = true;\n");
			expectRun(runFreezeCli(targetRoot), 1);
			rmSync(addedRegeneratedSource);
			rmSync(regeneratedSource);
			expectRun(runFreezeCli(targetRoot), 1);
			writeFileSync(regeneratedSource, "export const regenerated = true;\n");
			writeFileSync(regeneratedLock, `${JSON.stringify(validRegeneratedLock, null, "\t")}\n\n`);
			expectRun(runFreezeCli(targetRoot), 1);
			writeFileSync(regeneratedLock, `${JSON.stringify(validRegeneratedLock, null, "\t")}\n`);
			rmSync(regeneratedLock);
			expectRun(runFreezeCli(targetRoot), 1);
			writeFileSync(regeneratedLock, `${JSON.stringify(validRegeneratedLock, null, "\t")}\n`);

			const registryPath = join(targetRoot, "packages/protocol-v2/registry/field-registry.json");
			const bumpedRegistry = readJson(registryPath);
			bumpedRegistry.registryVersion = 6;
			writeFileSync(registryPath, `${JSON.stringify(bumpedRegistry, null, "\t")}\n`);
			const v5Path = join(targetRoot, "packages/protocol-v2/tests/fixtures/golden-vectors/registry-v5.json");
			const v6 = readJson(v5Path);
			v6.registryVersion = 6;
			writeFileSync(
				join(targetRoot, "packages/protocol-v2/tests/fixtures/golden-vectors/registry-v6.json"),
				`${JSON.stringify(v6, null, "\t")}\n`
			);
			expectRun(runFreezeCli(targetRoot), 1);
		} finally {
			rmSync(invalidRoot, { force: true, recursive: true });
			rmSync(targetRoot, { force: true, recursive: true });
		}
	}, 60_000);
});

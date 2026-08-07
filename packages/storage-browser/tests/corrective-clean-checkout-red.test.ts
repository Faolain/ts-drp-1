import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLEAN_SNAPSHOT_CHILD = "PHASE_2B_CLEAN_SNAPSHOT_CHILD";
const CORRECTIVE_FILES = Object.freeze([
	"packages/storage-browser/tests/corrective-clean-checkout-red.test.ts",
	"packages/storage-browser/tests/corrective-failure-finalization-red.test.ts",
	"packages/storage-browser/tests/corrective-persisted-artifacts-red.test.ts",
	"packages/storage-browser/tests/fixtures/corrective-run-finalizer.ts",
	"packages/storage-browser/tests/fixtures/corrective-artifact-fixtures.ts",
]);

it.skipIf(process.env[CLEAN_SNAPSHOT_CHILD] === "1")(
	"runs the default storage-browser Vitest package gate from tracked files without campaign logs",
	() => {
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2b-clean-vitest-"));
		const snapshotRoot = path.join(temporaryRoot, "snapshot");
		fs.mkdirSync(snapshotRoot);
		try {
			const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
				cwd: REPOSITORY_ROOT,
				maxBuffer: 128 * 1024 * 1024,
			});
			const extracted = spawnSync("tar", ["-xf", "-", "-C", snapshotRoot], {
				input: archive,
				encoding: "utf8",
			});
			expect(extracted.status, extracted.stderr).toBe(0);
			for (const relativePath of CORRECTIVE_FILES) {
				const destination = path.join(snapshotRoot, relativePath);
				fs.mkdirSync(path.dirname(destination), { recursive: true });
				fs.copyFileSync(path.join(REPOSITORY_ROOT, relativePath), destination);
			}

			fs.symlinkSync(path.join(REPOSITORY_ROOT, "node_modules"), path.join(snapshotRoot, "node_modules"), "dir");
			for (const scope of ["examples", "packages"] as const) {
				const sourceScope = path.join(REPOSITORY_ROOT, scope);
				for (const entry of fs.readdirSync(sourceScope, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					const sourceNodeModules = path.join(sourceScope, entry.name, "node_modules");
					if (!fs.existsSync(sourceNodeModules)) continue;
					const snapshotPackage = path.join(snapshotRoot, scope, entry.name);
					fs.mkdirSync(snapshotPackage, { recursive: true });
					fs.symlinkSync(sourceNodeModules, path.join(snapshotPackage, "node_modules"), "dir");
				}
			}
			const result = spawnSync("pnpm", ["--dir", path.join(snapshotRoot, "packages/storage-browser"), "test"], {
				encoding: "utf8",
				env: { ...process.env, [CLEAN_SNAPSHOT_CHILD]: "1" },
				timeout: 120_000,
			});
			const diagnostic = [result.stdout, result.stderr].filter(Boolean).join("\n");
			expect(result.status, diagnostic).toBe(0);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	},
	130_000
);

import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Bundles the D.108c real IndexedDB and detached process-death assets.
 * @returns Cleanup for the temporary asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = resolve(import.meta.dirname, "..");
	const outputDirectory = mkdtempSync(join(packageDirectory, ".phase-6a-creator-adoption-commit-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-6a-creator-adoption-commit": resolve(
				packageDirectory,
				"tests/assets/phase-6a-creator-adoption-commit-entry.ts"
			),
		},
		format: "esm",
		outdir: outputDirectory,
		platform: "browser",
		target: "es2022",
	});
	await build({
		bundle: true,
		entryPoints: {
			"phase-6a-creator-adoption-commit-child": resolve(
				packageDirectory,
				"tests/process/phase-6a-creator-adoption-commit-child.ts"
			),
		},
		format: "esm",
		outdir: outputDirectory,
		packages: "external",
		platform: "node",
		target: "node22",
	});
	writeFileSync(
		join(outputDirectory, "phase-6a-creator-adoption-commit.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-6a-creator-adoption-commit.js"></script>',
		"utf8"
	);
	process.env.PHASE_6A_CREATOR_ADOPTION_COMMIT_ASSET_DIR = outputDirectory;
	return () => rmSync(outputDirectory, { force: true, recursive: true });
}

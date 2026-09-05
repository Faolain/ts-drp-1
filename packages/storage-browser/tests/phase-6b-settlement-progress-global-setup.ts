import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Builds the bounded browser-only RED asset.
 * @returns Cleanup for the generated asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = resolve(import.meta.dirname, "..");
	const outputDirectory = mkdtempSync(join(packageDirectory, ".phase-6b-settlement-progress-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-6b-settlement-progress": resolve(packageDirectory, "tests/assets/phase-6b-settlement-progress-entry.ts"),
		},
		format: "esm",
		outdir: outputDirectory,
		platform: "browser",
		target: "es2022",
	});
	writeFileSync(
		join(outputDirectory, "phase-6b-settlement-progress.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-6b-settlement-progress.js"></script>',
		"utf8"
	);
	process.env.D110C_F5B0T_BROWSER_ASSET_DIR = outputDirectory;
	return () => rmSync(outputDirectory, { force: true, recursive: true });
}

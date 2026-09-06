import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Builds the D.109f browser entry from the freshly built workspace tree.
 * @returns Cleanup for the temporary asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = resolve(import.meta.dirname, "..");
	const outputDirectory = mkdtempSync(join(packageDirectory, ".phase-6b-differential-exit-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-6b-differential-exit": resolve(packageDirectory, "tests/assets/phase-6b-differential-exit-entry.ts"),
		},
		format: "esm",
		outdir: outputDirectory,
		platform: "browser",
		target: "es2022",
	});
	writeFileSync(
		join(outputDirectory, "phase-6b-differential-exit.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-6b-differential-exit.js"></script>',
		"utf8"
	);
	process.env.PHASE_6B_DIFFERENTIAL_EXIT_ASSET_DIR = outputDirectory;
	return () => rmSync(outputDirectory, { force: true, recursive: true });
}

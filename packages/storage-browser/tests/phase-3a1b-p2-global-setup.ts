import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

/**
 * Builds the private Seam 2 browser-death assets.
 * @returns Cleanup for the generated asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-3a1b-p2-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-3a1b-p2-entry": path.join(packageDirectory, "tests/assets/phase-3a1b-p2-browser-publication-entry.ts"),
			"phase-3a1b-p2-worker": path.join(packageDirectory, "tests/assets/phase-3a1b-p2-browser-publication-worker.ts"),
		},
		format: "esm",
		outdir: assetDirectory,
		platform: "browser",
		target: "es2022",
	});
	await build({
		bundle: true,
		entryPoints: {
			"phase-3a1b-p2-crash-child": path.join(
				packageDirectory,
				"tests/process/phase-3a1b-p2-browser-publication-crash-child.ts"
			),
		},
		format: "esm",
		outdir: assetDirectory,
		packages: "external",
		platform: "node",
		target: "node22",
	});
	fs.writeFileSync(
		path.join(assetDirectory, "phase-3a1b-p2.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-3a1b-p2-entry.js"></script>',
		"utf8"
	);
	process.env.PHASE_3A1B_P2_BROWSER_ASSET_DIR = assetDirectory;
	return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
}

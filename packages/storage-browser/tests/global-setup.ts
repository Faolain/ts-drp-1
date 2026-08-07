import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

/**
 *
 */
export default async function globalSetup(): Promise<void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2b-assets-"));
	await build({
		entryPoints: {
			"page-entry": path.join(packageDirectory, "tests/assets/page-entry.ts"),
			"worker-entry": path.join(packageDirectory, "tests/assets/worker-entry.ts"),
		},
		outdir: assetDirectory,
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
	});
	await build({
		entryPoints: {
			"settled-child": path.join(packageDirectory, "tests/process/settled-child.ts"),
			"arming-child": path.join(packageDirectory, "tests/process/arming-child.ts"),
			"crash-child": path.join(packageDirectory, "tests/process/crash-child.ts"),
			"browser-smoke-child": path.join(packageDirectory, "tests/process/browser-smoke-child.ts"),
		},
		outdir: assetDirectory,
		bundle: true,
		format: "esm",
		platform: "node",
		packages: "external",
		target: "node22",
	});
	fs.writeFileSync(
		path.join(assetDirectory, "index.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./page-entry.js"></script>',
		"utf8"
	);
	process.env.PHASE_2B_ASSET_DIR = assetDirectory;
}

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

/**
 * Bundles the isolated browser/Worker/crash-child assets for one campaign.
 * @returns Cleanup bound to the exact temporary asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2e6-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-2e6-real-process-death": path.join(packageDirectory, "tests/assets/phase-2e6-real-process-death-entry.ts"),
			"phase-2e6-real-process-death-worker": path.join(
				packageDirectory,
				"tests/assets/phase-2e6-real-process-death-worker.ts"
			),
		},
		format: "esm",
		outdir: assetDirectory,
		platform: "browser",
		target: "es2022",
	});
	await build({
		bundle: true,
		entryPoints: {
			"phase-2e6-crash-child": path.join(packageDirectory, "tests/process/phase-2e6-crash-child.ts"),
		},
		format: "esm",
		outdir: assetDirectory,
		packages: "external",
		platform: "node",
		target: "node22",
	});
	fs.writeFileSync(
		path.join(assetDirectory, "phase-2e6.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="/phase-2e6-real-process-death.js"></script>',
		"utf8"
	);
	process.env.PHASE_2E6_ASSET_DIR = assetDirectory;
	return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
}

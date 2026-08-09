import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

/**
 * Bundles the public-root-only Chromium component and cleans its temporary assets.
 * @returns Cleanup bound to the exact temporary asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2e7-assets-"));
	try {
		await build({
			bundle: true,
			entryPoints: {
				"phase-2e7-publication-component": path.join(
					packageDirectory,
					"tests/assets/phase-2e7-publication-component-entry.ts"
				),
			},
			format: "esm",
			outdir: assetDirectory,
			platform: "browser",
			target: "es2022",
		});
		fs.writeFileSync(
			path.join(assetDirectory, "phase-2e7.html"),
			'<!doctype html><meta charset="utf-8"><script type="module" src="/phase-2e7-publication-component.js"></script>',
			"utf8"
		);
		process.env.PHASE_2E7_ASSET_DIR = assetDirectory;
		return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
	} catch (error) {
		fs.rmSync(assetDirectory, { force: true, recursive: true });
		throw error;
	}
}

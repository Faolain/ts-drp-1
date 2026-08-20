import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

/**
 * Builds the isolated Chromium metadata-presence asset.
 * @returns Cleanup bound to the generated asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2g-b-presence-assets-"));
	try {
		await build({
			bundle: true,
			entryPoints: {
				"phase-2g-b-presence-entry": path.join(packageDirectory, "tests/assets/phase-2g-b-presence-entry.ts"),
			},
			format: "esm",
			outdir: assetDirectory,
			platform: "browser",
			target: "es2022",
		});
		fs.writeFileSync(
			path.join(assetDirectory, "index.html"),
			'<!doctype html><meta charset="utf-8"><script type="module" src="/phase-2g-b-presence-entry.js"></script>',
			"utf8"
		);
		process.env.PHASE_2G_B_PRESENCE_ASSET_DIR = assetDirectory;
		return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
	} catch (error) {
		fs.rmSync(assetDirectory, { force: true, recursive: true });
		throw error;
	}
}

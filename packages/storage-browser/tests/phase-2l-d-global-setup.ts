import { build, type Plugin } from "esbuild";
import fs from "node:fs";
import path from "node:path";

function exactOwnerPlugin(repositoryRoot: string): Plugin {
	return {
		name: "phase-2l-d-exact-owners",
		setup(builder): void {
			builder.onResolve({ filter: /^#phase-2l-d-shared-harness$/ }, () => ({
				path: path.join(repositoryRoot, "tests/fixtures/phase-2l-d/real-adapter-conformance.ts"),
			}));
			builder.onResolve({ filter: /^#phase-2l-d-unmodified-protocol$/ }, () => ({
				path: path.join(repositoryRoot, "packages/protocol-v3/src/index.ts"),
			}));
		},
	};
}

/**
 * Bundles the test-only browser half of the shared Phase 2l-d harness.
 * @returns Cleanup for the generated asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const repositoryRoot = path.resolve(packageDirectory, "../..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2l-d-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-2l-d-browser-parity": path.join(packageDirectory, "tests/assets/phase-2l-d-browser-parity-entry.ts"),
		},
		format: "esm",
		outdir: assetDirectory,
		platform: "browser",
		plugins: [exactOwnerPlugin(repositoryRoot)],
		target: "es2022",
	});
	fs.writeFileSync(
		path.join(assetDirectory, "phase-2l-d.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2l-d-browser-parity.js"></script>',
		"utf8"
	);
	process.env.PHASE_2L_D_ASSET_DIR = assetDirectory;
	return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
}

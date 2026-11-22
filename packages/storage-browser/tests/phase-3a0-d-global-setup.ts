import { build, type Plugin } from "esbuild";
import fs from "node:fs";
import path from "node:path";

function exactOwners(repositoryRoot: string): Plugin {
	const owners = new Map([
		["@ts-drp/canonical", "packages/canonical/src/index.ts"],
		["@ts-drp/control-plane", "packages/control-plane/src/index.ts"],
		["@ts-drp/protocol-v3", "packages/protocol-v3/src/public.ts"],
		["@ts-drp/storage", "packages/storage/src/index.ts"],
	]);
	return {
		name: "phase-3a0-d-exact-owners",
		setup(builder): void {
			for (const [specifier, owner] of owners) {
				builder.onResolve({ filter: new RegExp(`^${specifier.replaceAll("/", "\\/")}$`) }, () => ({
					path: path.join(repositoryRoot, owner),
				}));
			}
		},
	};
}

/**
 * Bundles only the nightly browser-reload evidence asset.
 * @returns Cleanup for the generated asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const repositoryRoot = path.resolve(packageDirectory, "../..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-3a0-d-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-3a0-d-anchor-trust-entry": path.join(repositoryRoot, "tests/fixtures/phase-3a0-d-v3/browser-entry.ts"),
		},
		format: "esm",
		outdir: assetDirectory,
		platform: "browser",
		plugins: [exactOwners(repositoryRoot)],
		target: "es2022",
	});
	fs.writeFileSync(
		path.join(assetDirectory, "phase-3a0-d.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-3a0-d-anchor-trust-entry.js"></script>',
		"utf8"
	);
	process.env.PHASE_3A0_D_ASSET_DIR = assetDirectory;
	return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
}

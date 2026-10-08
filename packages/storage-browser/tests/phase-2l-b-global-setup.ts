import { build, type Plugin } from "esbuild";
import fs from "node:fs";
import path from "node:path";

function candidatePlugin(packageDirectory: string): Plugin {
	const candidate = path.join(packageDirectory, "src/issuance.ts");
	const testControl = path.join(packageDirectory, "src/internal/issuance-test-control.ts");
	return {
		name: "phase-2l-b-candidate",
		setup(builder): void {
			builder.onResolve({ filter: /^#phase-2l-b-candidate$/ }, () =>
				fs.existsSync(candidate) ? { path: candidate } : { namespace: "phase-2l-b-absent", path: "candidate" }
			);
			builder.onResolve({ filter: /^#phase-2l-b-test-control$/ }, () =>
				fs.existsSync(testControl) ? { path: testControl } : { namespace: "phase-2l-b-absent", path: "control" }
			);
			builder.onLoad({ filter: /.*/, namespace: "phase-2l-b-absent" }, ({ path: absentPath }) => ({
				contents:
					absentPath === "candidate"
						? `export async function createBrowserDurableIssuanceStore() { const error = new Error("Phase 2l-b candidate absent"); error.code = "PHASE_2L_B_CANDIDATE_ABSENT"; throw error; }`
						: `export async function runBrowserTerminalAmbiguityCase() { return { code: "PHASE_2L_B_TEST_CONTROL_ABSENT", exposedKeys: [] }; }`,
				loader: "js",
			}));
		},
	};
}

/**
 * Bundles one private real-browser RED asset without creating a production seam.
 * @returns Cleanup for the exact generated asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2l-b-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-2l-b-browser-death": path.join(packageDirectory, "tests/assets/phase-2l-b-browser-death-entry.ts"),
			"phase-2l-b-browser-death-worker": path.join(packageDirectory, "tests/assets/phase-2l-b-browser-death-worker.ts"),
			"phase-2l-b-browser-issuance": path.join(packageDirectory, "tests/assets/phase-2l-b-browser-issuance-entry.ts"),
		},
		format: "esm",
		outdir: assetDirectory,
		platform: "browser",
		plugins: [candidatePlugin(packageDirectory)],
		target: "es2022",
	});
	await build({
		bundle: true,
		entryPoints: {
			"phase-2l-b-crash-child": path.join(packageDirectory, "tests/process/phase-2l-b-crash-child.ts"),
		},
		format: "esm",
		outdir: assetDirectory,
		packages: "external",
		platform: "node",
		target: "node22",
	});
	fs.writeFileSync(
		path.join(assetDirectory, "phase-2l-b.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2l-b-browser-issuance.js"></script>',
		"utf8"
	);
	fs.writeFileSync(
		path.join(assetDirectory, "phase-2l-b-death.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2l-b-browser-death.js"></script>',
		"utf8"
	);
	process.env.PHASE_2L_B_ASSET_DIR = assetDirectory;
	return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
}

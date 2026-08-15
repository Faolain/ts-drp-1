import { build, type Plugin } from "esbuild";
import fs from "node:fs";
import path from "node:path";

function candidatePlugin(packageDirectory: string): Plugin {
	const candidate = path.join(packageDirectory, "src/live-journal.ts");
	const testControl = path.join(packageDirectory, "src/internal/live-journal-observation.ts");
	return {
		name: "phase-3a1b-p4-browser-candidate",
		setup(builder): void {
			builder.onResolve({ filter: /^#phase-3a1b-p4-browser-candidate$/ }, () =>
				fs.existsSync(candidate) ? { path: candidate } : { namespace: "phase-3a1b-p4-absent", path: "candidate" }
			);
			builder.onResolve({ filter: /^#phase-3a1b-p4-browser-test-control$/ }, () =>
				fs.existsSync(testControl) ? { path: testControl } : { namespace: "phase-3a1b-p4-absent", path: "test-control" }
			);
			builder.onLoad({ filter: /.*/, namespace: "phase-3a1b-p4-absent" }, ({ path: absentPath }) => ({
				contents:
					absentPath === "candidate"
						? 'export async function createBrowserDurableLiveJournalStore() { throw new Error("PHASE_3A1B_P4_BROWSER_CANDIDATE_ABSENT"); }'
						: [
								'export function armPhase3a1bP4BrowserTrace() { throw new Error("PHASE_3A1B_P4_BROWSER_TEST_CONTROL_ABSENT"); }',
								'export function armPhase3a1bP4BrowserDurabilityDowngrade() { throw new Error("PHASE_3A1B_P4_BROWSER_TEST_CONTROL_ABSENT"); }',
								'export function armPhase3a1bP4BrowserReadbackFault() { throw new Error("PHASE_3A1B_P4_BROWSER_TEST_CONTROL_ABSENT"); }',
							].join("\n"),
				loader: "js",
			}));
		},
	};
}

/**
 * Bundles the private p4 browser RED without adding a production export.
 * @returns Cleanup for the generated asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-3a1b-p4-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-3a1b-p4-browser": path.join(packageDirectory, "tests/assets/phase-3a1b-p4-browser-live-journal-entry.ts"),
			"phase-3a1b-p4-browser-live-journal-death-entry": path.join(
				packageDirectory,
				"tests/assets/phase-3a1b-p4-browser-live-journal-death-entry.ts"
			),
			"phase-3a1b-p4-browser-live-journal-worker": path.join(
				packageDirectory,
				"tests/assets/phase-3a1b-p4-browser-live-journal-worker.ts"
			),
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
			"phase-3a1b-p4-browser-live-journal-crash-child": path.join(
				packageDirectory,
				"tests/process/phase-3a1b-p4-browser-live-journal-crash-child.ts"
			),
		},
		format: "esm",
		outdir: assetDirectory,
		packages: "external",
		platform: "node",
		target: "node22",
	});
	fs.writeFileSync(
		path.join(assetDirectory, "phase-3a1b-p4.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-3a1b-p4-browser.js"></script>',
		"utf8"
	);
	fs.writeFileSync(
		path.join(assetDirectory, "phase-3a1b-p4-death.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-3a1b-p4-browser-live-journal-death-entry.js"></script>',
		"utf8"
	);
	process.env.PHASE_3A1B_P4_BROWSER_ASSET_DIR = assetDirectory;
	return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
}

import { build, type Plugin } from "esbuild";
import fs from "node:fs";
import path from "node:path";

function candidatePlugin(packageDirectory: string, mutateSharedDecisions = false): Plugin {
	const candidate = path.join(packageDirectory, "src/live-journal.ts");
	const testControl = path.join(packageDirectory, "tests/fixtures/phase-3a1b-p4-browser-observation.ts");
	const decisionMutant = path.resolve(
		packageDirectory,
		"../../tests/fixtures/phase-3a1b-p4/runtime-mutants/shared-decision-runtime-mutant.ts"
	);
	const shared = path.resolve(packageDirectory, "../live-journal/src/index.ts");
	return {
		name: "phase-3a1b-p4-browser-candidate",
		setup(builder): void {
			builder.onResolve({ filter: /^#phase-3a1b-p4-browser-candidate$/ }, () =>
				fs.existsSync(candidate) ? { path: candidate } : { namespace: "phase-3a1b-p4-absent", path: "candidate" }
			);
			builder.onResolve({ filter: /^#phase-3a1b-p4-browser-test-control$/ }, () => ({ path: testControl }));
			if (mutateSharedDecisions) {
				builder.onResolve({ filter: /^@ts-drp\/live-journal$/ }, ({ importer }) => ({
					path: path.resolve(importer) === decisionMutant ? shared : decisionMutant,
				}));
			}
			builder.onResolve({ filter: /internal\/live-journal-observation(?:\.js)?$/ }, ({ importer }) =>
				importer === candidate ? { path: testControl } : undefined
			);
			builder.onLoad({ filter: /.*/, namespace: "phase-3a1b-p4-absent" }, ({ path: absentPath }) => ({
				contents:
					absentPath === "candidate"
						? 'export async function createBrowserDurableLiveJournalStore() { throw new Error("PHASE_3A1B_P4_BROWSER_CANDIDATE_ABSENT"); }'
						: 'throw new Error("unexpected p4 absent namespace");',
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
	const entry = path.join(packageDirectory, "tests/assets/phase-3a1b-p4-browser-live-journal-entry.ts");
	await build({
		bundle: true,
		entryPoints: {
			"phase-3a1b-p4-browser": entry,
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
			"phase-3a1b-p4-browser-decision-mutant": path.join(
				packageDirectory,
				"tests/assets/phase-3a1b-p4-browser-live-journal-entry.ts"
			),
		},
		format: "esm",
		outdir: assetDirectory,
		platform: "browser",
		plugins: [candidatePlugin(packageDirectory, true)],
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
	fs.writeFileSync(
		path.join(assetDirectory, "phase-3a1b-p4-decision-mutant.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-3a1b-p4-browser-decision-mutant.js"></script>',
		"utf8"
	);
	process.env.PHASE_3A1B_P4_BROWSER_ASSET_DIR = assetDirectory;
	return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
}

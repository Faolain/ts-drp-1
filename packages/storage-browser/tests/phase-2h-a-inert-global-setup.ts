import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

import { aggregatePhase2h, readPhase2hRunEntries } from "./fixtures/phase-2h-a-aggregate.js";
import { phase2hGitSha, preparePhase2hRun, writePhase2hAggregate } from "./fixtures/phase-2h-a-publication.js";

/**
 * Creates diagnostic-only assets and output custody that cannot overwrite the
 * required Phase 2h campaign aggregate.
 * @returns Finalizer for the separate fail-closed inert aggregate.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const repositoryDirectory = path.resolve(packageDirectory, "../..");
	const outputBase = path.join(packageDirectory, "test-results/phase-2h-inert");
	const assetRoot = path.join(outputBase, "assets");
	fs.mkdirSync(assetRoot, { recursive: true });
	const assetDirectory = fs.mkdtempSync(path.join(assetRoot, "run-"));
	try {
		await build({
			bundle: true,
			entryPoints: {
				"phase-2h-a-inert-entry": path.join(packageDirectory, "tests/assets/phase-2h-a-inert-entry.ts"),
			},
			format: "esm",
			outdir: assetDirectory,
			platform: "browser",
			target: "es2022",
		});
		fs.writeFileSync(
			path.join(assetDirectory, "phase-2h-a.html"),
			'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2h-a-inert-entry.js"></script>',
			"utf8"
		);
		const layout = preparePhase2hRun({
			gitSha: phase2hGitSha(repositoryDirectory),
			outputBase,
		});
		process.env.PHASE_2H_A_ASSET_DIR = assetDirectory;
		process.env.PHASE_2H_A_GIT_SHA = layout.gitSha;
		process.env.PHASE_2H_A_RUN_ID = layout.runId;
		return () => {
			try {
				writePhase2hAggregate(
					layout,
					aggregatePhase2h({
						...readPhase2hRunEntries(layout.runRoot),
						gitSha: layout.gitSha,
						runId: layout.runId,
					})
				);
			} finally {
				delete process.env.PHASE_2H_A_ASSET_DIR;
				delete process.env.PHASE_2H_A_GIT_SHA;
				delete process.env.PHASE_2H_A_RUN_ID;
				fs.rmSync(assetDirectory, { force: true, recursive: true });
			}
		};
	} catch (error) {
		fs.rmSync(assetDirectory, { force: true, recursive: true });
		throw error;
	}
}

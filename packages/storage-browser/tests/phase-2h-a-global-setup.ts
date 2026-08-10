import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

import { readPhase2hRunEntries } from "./fixtures/phase-2h-a-aggregate.js";
import {
	phase2hGitSha,
	preparePhase2hRun,
	writePhase2hAggregate,
} from "./fixtures/phase-2h-a-publication-reference.js";
import { PHASE_2H_A_INERT_CANDIDATE } from "./fixtures/phase-2h-a-subject.js";

/**
 * Creates one fresh inert Phase 2h-a invocation and its browser-neutral asset.
 * @returns Finalizer that always writes the bound failing aggregate when able.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const repositoryDirectory = path.resolve(packageDirectory, "../..");
	const assetDirectory = fs.mkdtempSync(path.join(packageDirectory, ".phase-2h-a-assets-"));
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
		const gitSha = phase2hGitSha(repositoryDirectory);
		const layout = preparePhase2hRun({
			gitSha,
			outputBase: path.join(packageDirectory, "test-results/phase-2h"),
		});
		process.env.PHASE_2H_A_ASSET_DIR = assetDirectory;
		process.env.PHASE_2H_A_GIT_SHA = layout.gitSha;
		process.env.PHASE_2H_A_RUN_ID = layout.runId;
		return () => {
			try {
				const aggregate = PHASE_2H_A_INERT_CANDIDATE.aggregate({
					entries: readPhase2hRunEntries(layout.runRoot),
					gitSha: layout.gitSha,
					runId: layout.runId,
				});
				writePhase2hAggregate(layout, aggregate);
			} finally {
				fs.rmSync(assetDirectory, { force: true, recursive: true });
			}
		};
	} catch (error) {
		fs.rmSync(assetDirectory, { force: true, recursive: true });
		throw error;
	}
}

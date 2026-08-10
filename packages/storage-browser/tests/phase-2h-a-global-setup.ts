import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

import { aggregatePhase2h, readPhase2hRunEntries } from "./fixtures/phase-2h-a-aggregate.js";
import {
	createPhase2hPublisher,
	phase2hGitSha,
	preparePhase2hRun,
	writePhase2hAggregate,
} from "./fixtures/phase-2h-a-publication.js";
import { startPhase2hParentPublisher } from "./fixtures/phase-2h-b-parent-publisher.js";

/**
 * Creates one fresh Phase 2h invocation, its browser assets and sole publisher.
 * @returns Finalizer that always writes the bound failing aggregate when able.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const repositoryDirectory = path.resolve(packageDirectory, "../..");
	const assetRoot = path.join(packageDirectory, "test-results");
	fs.mkdirSync(assetRoot, { recursive: true });
	const assetDirectory = fs.mkdtempSync(path.join(assetRoot, "phase-2h-assets-"));
	try {
		await build({
			bundle: true,
			entryPoints: {
				"phase-2e6-real-process-death": path.join(
					packageDirectory,
					"tests/assets/phase-2e6-real-process-death-entry.ts"
				),
				"phase-2e6-real-process-death-worker": path.join(
					packageDirectory,
					"tests/assets/phase-2e6-real-process-death-worker.ts"
				),
				"phase-2g-a-capacity-entry": path.join(packageDirectory, "tests/assets/phase-2g-a-capacity-entry.ts"),
				"phase-2h-a-inert-entry": path.join(packageDirectory, "tests/assets/phase-2h-a-inert-entry.ts"),
				"phase-2h-b-browser-surfaces": path.join(packageDirectory, "tests/assets/phase-2h-b-browser-surfaces-entry.ts"),
				"phase-2h-b-main-thread-oracle": path.join(
					repositoryDirectory,
					"packages/worker-host/tests/browser/fixtures/phase-2h-b-oracle-entry.ts"
				),
				"phase-2h-b-operation-workload": path.join(
					repositoryDirectory,
					"packages/worker-host/src/operation-workload.worker.ts"
				),
				"phase-2h-c-quota-entry": path.join(packageDirectory, "tests/assets/phase-2h-c-quota-entry.ts"),
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
			'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2e6-real-process-death.js"></script>',
			"utf8"
		);
		fs.writeFileSync(
			path.join(assetDirectory, "phase-2h-a.html"),
			'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2h-a-inert-entry.js"></script>',
			"utf8"
		);
		fs.writeFileSync(
			path.join(assetDirectory, "phase-2h-b.html"),
			'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2h-b-main-thread-oracle.js"></script><script type="module" src="./phase-2h-b-browser-surfaces.js"></script><script type="module" src="./phase-2g-a-capacity-entry.js"></script><script type="module" src="./phase-2h-c-quota-entry.js"></script>',
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
		const admissionDirectory = path.join(
			packageDirectory,
			"test-results/phase-2h-native-admission",
			layout.gitSha,
			layout.runId
		);
		fs.mkdirSync(admissionDirectory, { recursive: true });
		process.env.PHASE_2H_NATIVE_ADMISSION_DIR = admissionDirectory;
		const publisher = createPhase2hPublisher(layout);
		const parent = await startPhase2hParentPublisher(layout, publisher);
		process.env.PHASE_2H_A_SUBMISSION_URLS = JSON.stringify(parent.submissionURLs);
		return async () => {
			let closeFailure: unknown;
			try {
				try {
					await parent.close();
				} catch (error) {
					closeFailure = error;
				}
				const aggregate = aggregatePhase2h({
					...readPhase2hRunEntries(layout.runRoot),
					census: publisher.census(),
					gitSha: layout.gitSha,
					runId: layout.runId,
				});
				writePhase2hAggregate(layout, aggregate);
				if (closeFailure !== undefined) throw closeFailure;
			} finally {
				delete process.env.PHASE_2H_A_SUBMISSION_URLS;
				delete process.env.PHASE_2H_NATIVE_ADMISSION_DIR;
				fs.rmSync(assetDirectory, { force: true, recursive: true });
			}
		};
	} catch (error) {
		fs.rmSync(assetDirectory, { force: true, recursive: true });
		throw error;
	}
}

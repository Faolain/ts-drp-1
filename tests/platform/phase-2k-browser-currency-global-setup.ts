import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
	createArtifactPublication,
	evaluateBrowserCurrency,
	evaluateReleaseCandidate,
	resolveInstalledBrowserManifestPath,
} from "../../scripts/phase-2k-browser-currency.mjs";

interface Snapshot {
	readonly firstObservedBehindAtUtc: Record<string, string>;
	readonly safariReview: Record<string, unknown>;
	readonly sources: readonly { readonly assertedValue: string; readonly file: string }[];
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function browserVersions(manifest: Record<string, unknown>): Record<string, string> {
	const rows = manifest.browsers as readonly Record<string, unknown>[];
	return Object.fromEntries(
		["chromium", "firefox", "webkit"].map((engine) => {
			const row = rows.find((candidate) => candidate.name === engine && candidate.installByDefault === true);
			if (row === undefined || typeof row.browserVersion !== "string")
				throw new TypeError(`missing ${engine} manifest`);
			return [engine, row.browserVersion];
		})
	);
}

/**
 * Establishes one create-only Phase 2k invocation.
 * @returns Its sole finalizer.
 */
export default function globalSetup(): () => void {
	const repositoryRoot = path.resolve(import.meta.dirname, "../..");
	const outputBase = path.join(repositoryRoot, "test-results/phase-2k");
	const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
	const uuid = process.env.PHASE_2K_RUN_UUID ?? randomUUID();
	const runId = `phase-2k/${gitSha}/${uuid}`;
	const runRoot = path.join(outputBase, runId);
	fs.mkdirSync(outputBase, { recursive: true });
	fs.rmSync(path.join(outputBase, "browser-matrix-currency.json"), { force: true });
	fs.mkdirSync(path.dirname(runRoot), { recursive: true });
	fs.mkdirSync(runRoot);
	fs.mkdirSync(path.join(runRoot, "records"), { recursive: false });
	process.env.PHASE_2K_GIT_SHA = gitSha;
	process.env.PHASE_2K_RUN_ID = runId;
	process.env.PHASE_2K_RUN_ROOT = runRoot;
	return () => {
		try {
			const snapshot = readJson(path.join(repositoryRoot, "browser-currency-sources.json")) as unknown as Snapshot;
			const values = Object.fromEntries(snapshot.sources.map((row) => [row.file, row.assertedValue]));
			const rawSources = Object.fromEntries(
				snapshot.sources.map(({ file }) => [
					file,
					fs.readFileSync(path.join(repositoryRoot, "tests/fixtures/phase-2k/sources", file), "utf8"),
				])
			);
			const packageManifest = readJson(path.join(repositoryRoot, "package.json"));
			const installedManifest = readJson(resolveInstalledBrowserManifestPath(repositoryRoot));
			const installed = browserVersions(installedManifest);
			const newest = JSON.parse(values["playwright-browsers.json"] ?? "{}") as Record<string, string>;
			const launches = ["chromium", "firefox", "webkit"].flatMap((engine) => {
				const recordPath = path.join(runRoot, "records", `${engine}.json`);
				if (!fs.existsSync(recordPath)) return [];
				const record = readJson(recordPath);
				if (record.gitSha !== gitSha || record.runId !== runId || record.engine !== engine)
					throw new TypeError(`foreign Phase 2k ${engine} record`);
				return [{ browserVersion: record.browserVersion, channelId: engine, engine }];
			});
			const artifact = evaluateBrowserCurrency({
				coverageEvidence: [],
				electron: {
					manifest: readJson(
						path.join(repositoryRoot, "tests/fixtures/phase-0j-d-v3/current-inactive-shipping-targets.json")
					),
					receipts: [],
				},
				firstObservedBehindAtUtc: snapshot.firstObservedBehindAtUtc,
				gitSha,
				launches,
				nowUtc: new Date().toISOString(),
				playwright: {
					browsers: installed,
					newestStableBrowsers: newest,
					newestStableVersion: values["npm-playwright-test-dist-tags.json"],
					version: (packageManifest.devDependencies as Record<string, string>)["@playwright/test"],
				},
				runId,
				safariReview: snapshot.safariReview,
				snapshot,
				sourceBytes: rawSources,
				stableChannels: {
					chromium: values["chrome-for-testing-last-known-good-versions.json"],
					firefox: values["mozilla-firefox-versions.json"],
				},
			});
			createArtifactPublication({ gitSha, outputBase, uuid }).finalize(artifact);
			for (const warning of artifact.warnings)
				process.stderr.write(`::warning title=Phase 2k browser currency::${warning}\n`);
			const summaryPath = process.env.GITHUB_STEP_SUMMARY;
			if (summaryPath !== undefined) {
				const rows = artifact.channels.map(
					(row: Record<string, unknown>) =>
						`| ${String(row.channelId)} | ${String(row.launchedVersion ?? row.currentVersion)} | ${String(row.stableVersion)} |`
				);
				fs.appendFileSync(
					summaryPath,
					`## Phase 2k browser currency\n\n| Channel | Launched | Stable |\n|---|---:|---:|\n${rows.join("\n")}\n\nVerdict: **${artifact.verdict}**\n`
				);
			}
			const report = evaluateReleaseCandidate({ artifact, mode: "report" });
			if (report.exitCode !== 0 || artifact.verdict === "fail")
				throw new TypeError(`Phase 2k structural failure: ${[...artifact.invalidRowIds, ...report.reasons].join(",")}`);
		} finally {
			delete process.env.PHASE_2K_GIT_SHA;
			delete process.env.PHASE_2K_RUN_ID;
			delete process.env.PHASE_2K_RUN_ROOT;
		}
	};
}

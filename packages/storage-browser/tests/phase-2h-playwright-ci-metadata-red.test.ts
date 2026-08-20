import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import globalSetup from "./phase-2h-a-global-setup.js";

const CURRENT_PLAYWRIGHT_VERSION = "1.62.1";
const HISTORICAL_PLAYWRIGHT_VERSION = "1.61.1";
const FIRST_RUN_SIDE_EFFECT = "phase-2h-ci-metadata:first-run-side-effect";
const CI_COMMIT_HASH = "a".repeat(40);
const CURRENT_BROWSER_VERSIONS = Object.freeze({
	chromium: "151.0.7922.34",
	firefox: "153.0",
	webkit: "26.5",
} as const);
const PLAYWRIGHT_CI_METADATA = Object.freeze({
	ci: Object.freeze({
		commitHash: CI_COMMIT_HASH,
		commitHref: `https://github.com/drp-tech/ts-drp/commit/${CI_COMMIT_HASH}`,
	}),
	gitCommit: Object.freeze({
		branch: "candidate",
		hash: CI_COMMIT_HASH,
		subject: "candidate",
	}),
	gitDiff: "diff --git a/a b/a\n",
});

function currentIdentity(): Readonly<{
	browserVersions: typeof CURRENT_BROWSER_VERSIONS;
	playwrightVersion: string;
}> {
	return Object.freeze({
		browserVersions: CURRENT_BROWSER_VERSIONS,
		playwrightVersion: CURRENT_PLAYWRIGHT_VERSION,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Phase 2h Playwright-owned CI metadata", () => {
	it("admits the trusted invocation version amid Playwright-owned pre-setup metadata", async () => {
		const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
			throw new Error(FIRST_RUN_SIDE_EFFECT);
		});
		const resolvePlaywrightIdentity = vi.fn(currentIdentity);

		await expect(
			globalSetup(
				{
					metadata: {
						phase2hPlaywrightVersion: CURRENT_PLAYWRIGHT_VERSION,
						...PLAYWRIGHT_CI_METADATA,
					},
				},
				{ resolvePlaywrightIdentity }
			)
		).rejects.toThrow(FIRST_RUN_SIDE_EFFECT);

		expect(resolvePlaywrightIdentity).toHaveBeenCalledOnce();
		expect(resolvePlaywrightIdentity).toHaveBeenCalledWith(
			expect.stringContaining(path.join("packages", "storage-browser", "tests", "phase-2h-a-global-setup.ts"))
		);
		expect(mkdirSync).toHaveBeenCalledOnce();
	});

	it.each([
		["missing", undefined],
		["malformed", "^1.62.1"],
		["forged historical", HISTORICAL_PLAYWRIGHT_VERSION],
	] as const)("rejects a %s trusted-version claim before every run side effect", async (_label, version) => {
		const mkdirSync = vi.spyOn(fs, "mkdirSync");
		const resolvePlaywrightIdentity = vi.fn(currentIdentity);
		const metadata: Record<string, unknown> = { ...PLAYWRIGHT_CI_METADATA };
		if (version !== undefined) metadata.phase2hPlaywrightVersion = version;

		await expect(globalSetup({ metadata }, { resolvePlaywrightIdentity })).rejects.toThrow(
			/tooling-identity|Playwright|version/iu
		);

		expect(resolvePlaywrightIdentity).toHaveBeenCalledOnce();
		expect(mkdirSync).not.toHaveBeenCalled();
	});
});

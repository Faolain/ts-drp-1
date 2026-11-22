import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import config from "../packages/storage-browser/playwright.phase-3a0-d-anchor-trust.config.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const contractPath = path.join(repositoryRoot, "tests/fixtures/phase-3a0-d-v3/contract.json");
const dedicatedTsconfig = path.join(repositoryRoot, "tests/fixtures/phase-3a0-d-v3/tsconfig.test.json");

describe("Phase 3a0-D browser parity governance RED", () => {
	it("freezes the exact nightly engines, reload boundary, process owner and withheld claims", async () => {
		const contract = JSON.parse(await readFile(contractPath, "utf8")) as Record<string, unknown>;
		expect(config.projects?.map(({ name }) => name)).toEqual(["chromium", "firefox", "webkit"]);
		expect({
			fullyParallel: config.fullyParallel,
			retries: config.retries,
			testMatch: config.testMatch,
			workers: config.workers,
		}).toEqual({
			fullyParallel: false,
			retries: 0,
			testMatch: "phase-3a0-d-anchor-trust-browser-parity-red.pw.ts",
			workers: 1,
		});
		expect(contract).toEqual({
			browserReload: "page.reload",
			engines: ["chromium", "firefox", "webkit"],
			kind: "phase-3a0-d-browser-anchor-trust-parity",
			processDeathOwner: "phase-2e6",
			requiredClaims: [
				"byte-identical-trust-record-after-reload",
				"exact-trust-ref-after-reload",
				"fresh-capability-authenticates-exact-provenance",
				"old-xor-exact-new-authority",
				"strict-indexeddb-fail-closed",
			],
			tier: "nightly",
			transactionBoundary: "completed-strict-indexeddb-transaction",
			version: 1,
			withheldClaims: [
				"browser-process-death",
				"physical-debris-absence",
				"fsync-or-power-loss",
				"live-state-construction",
				"trust-advancement",
				"certified-profile-or-qc",
			],
		});
	});

	it("keeps the cross-package browser asset under one dedicated compiler owner", async () => {
		const dedicatedConfig = JSON.parse(await readFile(dedicatedTsconfig, "utf8")) as { files?: readonly string[] };
		expect(dedicatedConfig.files).toContain("./browser-entry.ts");
		await expect(
			execFileAsync("pnpm", ["exec", "tsc", "--noEmit", "--project", dedicatedTsconfig], { cwd: repositoryRoot })
		).resolves.toMatchObject({ stderr: "" });
	});
});

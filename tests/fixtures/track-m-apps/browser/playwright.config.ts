import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const evidence = process.env.TRACK_M_APPS_EVIDENCE;

// Track M measurement: the Canvas and Chat long rooms (tests/fixtures/track-m-apps/
// long-room-core.ts) in a real browser, on the engine's own IndexedDB. Measurement only:
// TRACK_M_APPS_EVIDENCE names the directory for bundles and test results (a temporary one
// otherwise), TRACK_M_APPS_OUT the directory for the per-epoch JSONL.
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./global-setup.ts",
	globalTimeout: 21_600_000,
	// Never inside the repository.
	outputDir: path.join(evidence ?? os.tmpdir(), "test-results"),
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: [["line"]],
	retries: 0,
	testDir: ".",
	testMatch: "long-room.pw.ts",
	timeout: 3_600_000,
	use: { headless: true },
	workers: 1,
});

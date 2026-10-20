import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const evidence = process.env.TRACK_M_14F_EVIDENCE;

// Track M, slice 14f: native evidence for the single retention transaction (cases 2, 3,
// 5-8 and optionally 11) in Chromium, Firefox and WebKit. TRACK_M_14F_EVIDENCE names the
// directory for logs, profiles and bundles (a temporary one otherwise).
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
	testMatch: "room-retention-native.pw.ts",
	timeout: 3_600_000,
	use: { headless: true },
	workers: 1,
});

import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { resolvePhase2hPlaywrightIdentity } from "./tests/fixtures/phase-2h-playwright-identity.js";

// The retained 18-edge Chromium campaign measured 39.6s. The process bound is
// three measured campaigns. Playwright enumerates 15 serial tests across the
// four files and three projects; the global bound sums every legal per-test
// bound plus one minute for global setup and finalization.
const MEASURED_18_EDGE_CAMPAIGN_MS = 39_600;
const PROCESS_TEST_TIMEOUT_MS = MEASURED_18_EDGE_CAMPAIGN_MS * 3;
const SERIAL_TEST_COUNT = 15;
const playwrightIdentity = resolvePhase2hPlaywrightIdentity(fileURLToPath(import.meta.url));

export default defineConfig({
	metadata: { phase2hPlaywrightVersion: playwrightIdentity.playwrightVersion },
	testDir: "./tests",
	testMatch: [
		"phase-2h-b-browser-surfaces-red.pw.ts",
		"phase-2h-c-capacity-quota-red.pw.ts",
		"phase-2h-d-process-death-producer.pw.ts",
		"phase-2h-d-process-death-red.pw.ts",
	],
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./tests/phase-2h-a-global-setup.ts",
	globalTimeout: PROCESS_TEST_TIMEOUT_MS * SERIAL_TEST_COUNT + 60_000,
	outputDir: "./test-results/playwright-phase-2h-a",
	projects: [
		{ name: "chromium", use: { browserName: "chromium", headless: true } },
		{ name: "firefox", use: { browserName: "firefox", headless: true } },
		{ name: "webkit", use: { browserName: "webkit", headless: true } },
	],
	retries: 0,
	timeout: PROCESS_TEST_TIMEOUT_MS,
	use: {
		trace: "retain-on-failure",
	},
	workers: 1,
});

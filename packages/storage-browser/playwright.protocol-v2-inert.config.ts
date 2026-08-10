import { defineConfig } from "@playwright/test";

import protocolConfig from "./playwright.protocol-v2.config.js";

export default defineConfig({
	...protocolConfig,
	outputDir: "./test-results/playwright-phase-2h-a-inert",
	testMatch: "phase-2h-a-inert-red.pw.ts",
});

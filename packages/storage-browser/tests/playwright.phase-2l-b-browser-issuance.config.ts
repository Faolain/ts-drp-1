import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: ["phase-2l-b-browser-issuance-red.pw.ts", "phase-2l-b-browser-death-red.pw.ts"],
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./phase-2l-b-global-setup.ts",
	globalTimeout: 300_000,
	projects:
		process.env.PHASE_2L_B_R8_SHARED === undefined
			? [{ name: "chromium", use: { browserName: "chromium" } }]
			: [
					{ name: "chromium", use: { browserName: "chromium" } },
					{ name: "firefox", use: { browserName: "firefox" } },
					{ name: "webkit", use: { browserName: "webkit" } },
				],
	retries: 0,
	timeout: 120_000,
	use: { baseURL: "http://127.0.0.1:43891", browserName: "chromium", headless: true },
	workers: 1,
});

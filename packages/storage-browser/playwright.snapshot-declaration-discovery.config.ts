import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 360000,
	outputDir: resolve(
		import.meta.dirname,
		"../../.logs/bounded-storage-lifecycle/declaration-discovery-red-correction-04/native",
		new Date().toISOString().replaceAll(":", "-")
	),
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: [["line"]],
	retries: 0,
	testDir: "./tests",
	testMatch: "snapshot-declaration-discovery-red.pw.ts",
	timeout: 15000,
	use: { headless: true },
	workers: 3,
});

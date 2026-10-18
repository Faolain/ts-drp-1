import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 120000,
	outputDir: fileURLToPath(
		new URL(
			"../../../.logs/bounded-storage-lifecycle/declaration-discovery-provenance-browser-controls-01/native",
			import.meta.url
		)
	),
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: [
		["line"],
		[
			"json",
			{
				outputFile: fileURLToPath(
					new URL(
						"../../../.logs/bounded-storage-lifecycle/declaration-discovery-provenance-browser-controls-01/native-report.json",
						import.meta.url
					)
				),
			},
		],
	],
	retries: 0,
	testDir: ".",
	testMatch: "browser-controls.pw.ts",
	timeout: 20000,
	use: { headless: true },
	workers: 3,
});

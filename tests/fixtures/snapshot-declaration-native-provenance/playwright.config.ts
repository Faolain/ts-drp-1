import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const label = process.env.NATIVE_PROVENANCE_ARTIFACT_LABEL ?? "native";
const evidence = new URL(
	"../../../.logs/bounded-storage-lifecycle/declaration-discovery-provenance-native-red-01/",
	import.meta.url
);
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 360000,
	outputDir: fileURLToPath(new URL(label, evidence)),
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	reporter: [["line"], ["json", { outputFile: fileURLToPath(new URL(label + ".report.json", evidence)) }]],
	retries: 0,
	testDir: ".",
	testMatch: "browser-red.pw.ts",
	timeout: 15000,
	use: { headless: true },
	workers: 3,
});

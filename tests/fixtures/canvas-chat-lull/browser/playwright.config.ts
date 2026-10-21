import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const evidence = process.env.CANVAS_CHAT_LULL_EVIDENCE;

// Track Q: the Canvas and Chat long rooms (tests/fixtures/canvas-chat-lull/long-room-core.ts)
// in a real browser, on the engine's own IndexedDB. Measurement only:
// CANVAS_CHAT_LULL_EVIDENCE names the directory for bundles and test results (a temporary
// one otherwise), CANVAS_CHAT_LULL_OUT the directory for the per-epoch JSONL.
export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalSetup: "./global-setup.ts",
	globalTimeout: 21_600_000,
	// Never inside the repository.
	outputDir: path.join(evidence ?? os.tmpdir(), "test-results"),
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	reporter: [["line"]],
	retries: 0,
	testDir: ".",
	testMatch: "long-room.pw.ts",
	timeout: 3_600_000,
	use: { headless: true },
	workers: 1,
});

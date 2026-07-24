import { defineConfig, devices } from "@playwright/test";

// Platform-capability matrix. Asserts what the browser engines actually implement, so that
// protocol decisions resting on those capabilities (e.g. the signature suite) are pinned to
// measurement rather than to memory of a release note.
//
// Deliberately hermetic: no app, no web server, no network. The spec fulfils its own document
// over an https origin so `crypto.subtle` runs in a secure context offline.
//
// Runs all three engines — a capability that differs per engine is exactly the thing this exists
// to catch, so a chromium-only run would defeat the purpose.
export default defineConfig({
	expect: { timeout: 10_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: true,
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	reporter: "line",
	retries: 0,
	testDir: "./tests/platform",
	testMatch: /.*\.pw\.ts/u,
	timeout: 30_000,
	use: { trace: "retain-on-failure" },
});

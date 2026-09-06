import type { PlaywrightTestConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import protocolConfig from "../playwright.protocol-v2.config.js";

const packageDirectory = path.resolve(import.meta.dirname, "..");
const inertConfigPath = path.join(packageDirectory, "playwright.protocol-v2-inert.config.ts");

function expectBoundedSerialProjects(config: PlaywrightTestConfig): void {
	expect(config.fullyParallel).toBe(false);
	expect(config.workers).toBe(1);
	expect(config.retries).toBe(0);
	expect(config.projects?.map(({ name }) => name)).toEqual(["chromium", "firefox", "webkit"]);
	expect(config.use?.trace).toBe("retain-on-failure");
}

describe("Phase 2h-b browser-surface execution topology", () => {
	it("moves the main three-engine config to the real browser-surface producer", () => {
		expectBoundedSerialProjects(protocolConfig);
		expect(protocolConfig.testMatch).toEqual([
			"phase-2h-b-browser-surfaces-red.pw.ts",
			"phase-2h-c-capacity-quota-red.pw.ts",
			"phase-2h-d-process-death-producer.pw.ts",
			"phase-2h-d-process-death-red.pw.ts",
		]);
		expect(protocolConfig.globalSetup).toBe("./tests/phase-2h-a-global-setup.ts");
	});

	it("keeps the authorized zero-record campaign independently executable and honestly failing", async () => {
		expect(fs.existsSync(inertConfigPath)).toBe(true);
		if (!fs.existsSync(inertConfigPath)) return;
		const loaded = (await import(pathToFileURL(inertConfigPath).href)) as Readonly<{
			default: PlaywrightTestConfig;
		}>;
		const inertConfig = loaded.default;
		expectBoundedSerialProjects(inertConfig);
		expect(inertConfig.testMatch).toBe("phase-2h-a-inert-red.pw.ts");
		expect(inertConfig.globalSetup).toBe("./tests/phase-2h-a-inert-global-setup.ts");
		expect(inertConfig.outputDir).not.toBe(protocolConfig.outputDir);
		const typecheck = JSON.parse(fs.readFileSync(path.join(packageDirectory, "tsconfig.json"), "utf8")) as {
			include: string[];
		};
		const build = JSON.parse(fs.readFileSync(path.join(packageDirectory, "tsconfig.build.json"), "utf8")) as {
			exclude: string[];
		};
		expect(typecheck.include).toContain("playwright.protocol-v2-inert.config.ts");
		expect(build.exclude).toContain("playwright.protocol-v2-inert.config.ts");
	});
});

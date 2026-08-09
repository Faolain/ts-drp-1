import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_DIRECTORY = path.resolve(import.meta.dirname, "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");

function readJson(relativePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIRECTORY, relativePath), "utf8")) as Record<string, unknown>;
}

describe("storage-browser structural controls", () => {
	it("publishes one root while storage-node remains private", () => {
		const browser = readJson("packages/storage-browser/package.json");
		const node = readJson("packages/storage-node/package.json");
		expect(browser).not.toHaveProperty("private");
		expect(Object.keys(browser.exports as object)).toEqual(["."]);
		expect(node.private).toBe(true);
		expect(browser.dependencies).toEqual({ "@ts-drp/canonical": "0.11.0", "@ts-drp/storage": "0.11.0" });
	});

	it("keeps all retained real browser authorities in typecheck and out of the package build", () => {
		const tsconfig = readJson("packages/storage-browser/tsconfig.json");
		expect(tsconfig).not.toHaveProperty("files");
		expect(tsconfig.include).toEqual([
			"src/**/*.ts",
			"tests/**/*.ts",
			"playwright.phase-2d1-schema.config.ts",
			"playwright.phase-2d2a-idb-adapter.config.ts",
			"playwright.phase-2d2b1-adapter-closure.config.ts",
			"playwright.phase-2e5-browser-inventory.config.ts",
			"playwright.phase-2e6-real-process-death.config.ts",
			"playwright.phase-2e7-publication-component.config.ts",
		]);
		const build = readJson("packages/storage-browser/tsconfig.build.json");
		expect(build.exclude).toEqual([
			"dist",
			"tests/**/*.ts",
			"playwright.phase-2d1-schema.config.ts",
			"playwright.phase-2d2a-idb-adapter.config.ts",
			"playwright.phase-2d2b1-adapter-closure.config.ts",
			"playwright.phase-2e5-browser-inventory.config.ts",
			"playwright.phase-2e6-real-process-death.config.ts",
			"playwright.phase-2e7-publication-component.config.ts",
		]);
	});

	it("retains dedicated Phase 2e5, 2e6, and 2e7 browser authorities", () => {
		const root = readJson("package.json");
		const command = (root.scripts as Record<string, string>)["e2e-test:storage-browser"];
		for (const config of [
			"playwright.phase-2e5-browser-inventory.config.ts",
			"playwright.phase-2e6-real-process-death.config.ts",
			"playwright.phase-2e7-publication-component.config.ts",
		])
			expect(command).toContain(config);
		const setup = fs.readFileSync(path.join(PACKAGE_DIRECTORY, "tests/phase-2e6-global-setup.ts"), "utf8");
		expect(setup).toContain("return () => fs.rmSync(assetDirectory, { force: true, recursive: true })");
	});
});

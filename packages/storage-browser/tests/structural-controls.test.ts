import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_DIRECTORY = path.resolve(import.meta.dirname, "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");

function readJson(relativePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIRECTORY, relativePath), "utf8")) as Record<string, unknown>;
}

describe("storage-browser structural controls", () => {
	it("preserves the browser root plus issuance subpath while storage-node remains private", () => {
		const browser = readJson("packages/storage-browser/package.json");
		const node = readJson("packages/storage-node/package.json");
		expect(browser).not.toHaveProperty("private");
		expect(browser.exports).toEqual({
			".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" },
			"./issuance": { import: "./dist/src/issuance.js", types: "./dist/src/issuance.d.ts" },
			"./live-journal": { import: "./dist/src/live-journal.js", types: "./dist/src/live-journal.d.ts" },
			"./seal-vote": { import: "./dist/src/seal-vote.js", types: "./dist/src/seal-vote.d.ts" },
			"./snapshot-transfer": {
				import: "./dist/src/snapshot-transfer.js",
				types: "./dist/src/snapshot-transfer.d.ts",
			},
		});
		expect(node.private).toBe(true);
		expect(browser.dependencies).toEqual({
			"@ts-drp/canonical": "0.11.0",
			"@ts-drp/compaction": "0.11.0",
			"@ts-drp/issuance-store": "0.11.0",
			"@ts-drp/live-journal": "0.11.0",
			"@ts-drp/seal": "0.11.0",
			"@ts-drp/storage": "0.11.0",
		});
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
			"playwright.phase-5c-seal-vote.config.ts",
			"playwright.protocol-v2.config.ts",
			"playwright.protocol-v2-inert.config.ts",
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
			"playwright.phase-5c-seal-vote.config.ts",
			"playwright.protocol-v2.config.ts",
			"playwright.protocol-v2-inert.config.ts",
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

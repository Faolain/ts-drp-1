import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { KILL_POINT_MANIFEST, orderedKillPoints } from "../src/killpoints.js";
import { expectedFixtureState, expectedHitDurability } from "./fixtures/inert-campaign.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");

function readJson(relativePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(WORKSPACE_DIRECTORY, relativePath), "utf8")) as Record<string, unknown>;
}

describe("Phase 2b structural controls", () => {
	it("derives the exact fourteen before/after tuples from the manifest bijection", () => {
		expect(KILL_POINT_MANIFEST).toEqual({
			"database-open": 0,
			"transition-begin": 1,
			"preflight-cursor-open": 2,
			"preflight-cursor-continue": 3,
			"left-write": 4,
			"right-write": 5,
			"transaction-complete": 6,
		});
		expect(orderedKillPoints()).toEqual(
			Object.keys(KILL_POINT_MANIFEST).flatMap((id) => [
				{ id, edge: "before" },
				{ id, edge: "after" },
			])
		);
		expect(orderedKillPoints().map(expectedFixtureState)).toEqual([...Array.from({ length: 13 }, () => "old"), "new"]);
		expect(
			orderedKillPoints()
				.map(expectedHitDurability)
				.filter((state) => state === "not-reached")
		).toHaveLength(3);
		expect(
			orderedKillPoints()
				.map(expectedHitDurability)
				.filter((state) => state === "strict")
		).toHaveLength(11);
	});

	it("keeps the package private, dependency-exact and export-free", () => {
		const metadata = readJson("packages/storage-browser/package.json");
		expect(metadata.private).toBe(true);
		expect(metadata.dependencies).toEqual({ "@ts-drp/canonical": "0.11.0", "@ts-drp/storage": "0.11.0" });
		expect(metadata).not.toHaveProperty("exports");
		expect(metadata).not.toHaveProperty("types");
		const tsconfig = readJson("packages/storage-browser/tsconfig.json");
		expect(tsconfig.files).toEqual(["killpoints.json"]);
		expect(tsconfig.include).toEqual([
			"src/**/*.ts",
			"tests/**/*.ts",
			"playwright.storage-browser.config.ts",
			"playwright.phase-2d1-schema.config.ts",
			"playwright.phase-2d2a-idb-adapter.config.ts",
			"playwright.phase-2d2b1-adapter-closure.config.ts",
		]);
		const build = readJson("packages/storage-browser/tsconfig.build.json");
		expect(build.exclude).toEqual([
			"dist",
			"tests/**/*.ts",
			"playwright.storage-browser.config.ts",
			"playwright.phase-2d1-schema.config.ts",
			"playwright.phase-2d2a-idb-adapter.config.ts",
			"playwright.phase-2d2b1-adapter-closure.config.ts",
		]);
	});

	it("keeps the toy diagnostic outside both frozen protocol registries", () => {
		for (const registry of [
			"packages/protocol-v2/registry/field-registry.json",
			"packages/protocol-v3/registry/registry-v1.json",
		]) {
			expect(fs.readFileSync(path.join(WORKSPACE_DIRECTORY, registry), "utf8")).not.toContain(
				"ts-drp-storage/phase-2b-fixture-records/v1"
			);
		}
	});

	it("uses only the creator-bound identity and never introduces a spec-collected Playwright file", () => {
		const files = fs
			.readdirSync(path.join(PACKAGE_DIRECTORY, "tests"), { recursive: true })
			.filter((entry): entry is string => typeof entry === "string");
		expect(files.some((file) => file.endsWith(".spec.ts"))).toBe(false);
		const sources = files
			.filter((file) => file.endsWith(".ts") && file !== "structural-controls.test.ts")
			.map((file) => fs.readFileSync(path.join(PACKAGE_DIRECTORY, "tests", file), "utf8"))
			.join("\n");
		expect(sources).not.toContain("parseLegacy");
		expect(sources).not.toContain("normalizeObjectId");
		expect(sources).not.toContain("plain-object-id");
	});

	it("keeps graceful lifecycle behavior unreachable from the crash child", () => {
		const crash = ["tests/process/crash-child.ts", "tests/process/inert-role.ts", "tests/fixtures/fixture-records.ts"]
			.map((file) => fs.readFileSync(path.join(PACKAGE_DIRECTORY, file), "utf8"))
			.join("\n");
		for (const forbidden of [
			"settled-child",
			"arming-child",
			".close(",
			"storageState",
			".dispose(",
			"SIGINT",
			"SIGTERM",
			"SIGHUP",
			"beforeExit",
			"shutdown",
			"oracle-idb",
		]) {
			expect(crash).not.toContain(forbidden);
		}
	});

	it("wires the exact Playwright matcher and root runner", () => {
		const config = fs.readFileSync(path.join(PACKAGE_DIRECTORY, "playwright.storage-browser.config.ts"), "utf8");
		const setup = fs.readFileSync(path.join(PACKAGE_DIRECTORY, "tests/global-setup.ts"), "utf8");
		expect(config).toContain('testMatch: "crash-driver.pw.ts"');
		expect(config).toContain("workers: 1");
		expect(config).toContain("fullyParallel: false");
		expect(setup).toContain('".logs/phase-2b-process-death/artifacts"');
		expect(setup).not.toContain("green-codex-high");
		const root = readJson("package.json");
		expect(root.scripts).toMatchObject({
			"e2e-test:storage-browser":
				"pnpm exec playwright test --config packages/storage-browser/playwright.storage-browser.config.ts",
		});
	});
});

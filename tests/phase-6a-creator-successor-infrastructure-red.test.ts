import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108E1_GREEN_PATHS,
	D108E1_RED_PATHS,
	isD108e1DirectSnapshotTelemetry,
} from "./fixtures/phase-6a-v3/creator-successor-infrastructure-contract.js";
import { workspacePackageImportHook } from "./fixtures/shared/workspace-package-subprocess.mjs";

const GLOBAL_SETUP = resolve(
	REPOSITORY_ROOT,
	"packages/storage-browser/tests/phase-6a-creator-successor-activation-global-setup.ts"
);

describe("D.108e1 activation test-infrastructure RED", () => {
	it("freezes exactly seven RED and eight GREEN test-infrastructure owners", () => {
		expect(D108E1_RED_PATHS).toHaveLength(7);
		expect(D108E1_GREEN_PATHS).toHaveLength(8);
		expect(new Set(D108E1_RED_PATHS).size).toBe(7);
		expect(new Set(D108E1_GREEN_PATHS).size).toBe(8);
		expect(D108E1_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
	});

	it("binds the closed hook only after the package's own built export map resolves the exact target", () => {
		const canonical = resolve(REPOSITORY_ROOT, "packages/canonical/dist/src/index.js");
		expect(
			workspacePackageImportHook({
				expectedImports: { "@ts-drp/canonical": canonical },
			})
		).toMatch(/^--import=data:text\/javascript;base64,/u);
		expect(() =>
			workspacePackageImportHook({
				expectedImports: {
					"@ts-drp/canonical": resolve(REPOSITORY_ROOT, "packages/compaction/dist/src/snapshot-stream.js"),
				},
			})
		).toThrow(/workspace package target mismatch for @ts-drp\/canonical/u);
	});

	it("rejects completion-derived snapshot telemetry", () => {
		expect(
			isD108e1DirectSnapshotTelemetry({
				completeAfterReads: true,
				completeBeforeSubscribe: true,
				declaredChunkCount: 1,
				reads: [
					{
						byteLength: 32,
						digest: "a".repeat(64),
						index: 0,
						observedByteLength: 32,
						source: "snapshot-complete-loop",
					},
				],
				telemetrySource: "completion-derived",
			})
		).toBe(false);
	});

	it("moves package shims behind one bounded Playwright global-setup owner", async () => {
		expect(existsSync(GLOBAL_SETUP)).toBe(true);
		const config = (await import(
			`${
				pathToFileURL(
					resolve(
						REPOSITORY_ROOT,
						"packages/storage-browser/playwright.phase-6a-creator-successor-activation.config.ts"
					)
				).href
			}?d108e1=${crypto.randomUUID()}`
		)) as Readonly<{ readonly default?: Readonly<{ readonly globalSetup?: string }> }>;
		expect(config.default?.globalSetup).toBe("./tests/phase-6a-creator-successor-activation-global-setup.ts");
	});
});

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	D108E1_GREEN_PATHS,
	D108E1_RED_PATHS,
	type D108e1ExpectedSnapshotRead,
	isD108e1DirectSnapshotTelemetry,
} from "./fixtures/phase-6a-v3/creator-successor-infrastructure-contract.js";
import { D108E4_INFRASTRUCTURE_BEHAVIORS } from "./fixtures/phase-6a-v3/creator-successor-local-author-contract.js";
import { importWorkspacePackageExportFile } from "./fixtures/shared/workspace-package-export-file.mjs";
import { workspacePackageImportHook } from "./fixtures/shared/workspace-package-subprocess.mjs";

const GLOBAL_SETUP = resolve(
	REPOSITORY_ROOT,
	"packages/storage-browser/tests/phase-6a-creator-successor-activation-global-setup.ts"
);
const SHIM_ROOT = resolve(REPOSITORY_ROOT, "tests/fixtures/node_modules/@ts-drp");
const SHIM_SIBLING_SENTINEL = resolve(REPOSITORY_ROOT, "tests/fixtures/node_modules/d108e1-caller-owned.txt");
const SHIM_PARENT = dirname(SHIM_SIBLING_SENTINEL);

interface ActivationShimSetupHooks {
	afterRootCreated?(): void;
}

interface ActivationShimSetupModule {
	default(): Promise<() => void>;
	setupActivationWorkspaceShims?(hooks?: Readonly<ActivationShimSetupHooks>): Promise<() => void>;
}

async function activationShimSetupModule(): Promise<ActivationShimSetupModule> {
	return (await import(
		`${pathToFileURL(GLOBAL_SETUP).href}?d108e6=${crypto.randomUUID()}`
	)) as ActivationShimSetupModule;
}

describe("D.108e1 activation test-infrastructure RED", () => {
	it(D108E4_INFRASTRUCTURE_BEHAVIORS[0], async () => {
		const directory = mkdtempSync(resolve(tmpdir(), "ts-drp-d108e4-export-file-"));
		try {
			mkdirSync(resolve(directory, "dist"));
			writeFileSync(
				resolve(directory, "package.json"),
				JSON.stringify({ name: "@ts-drp/canonical", exports: { ".": { import: "./dist/index.js" } } }),
				"utf8"
			);
			writeFileSync(resolve(directory, "dist/index.js"), "export const marker = 'fresh-built-export';\n", "utf8");
			const imported = await importWorkspacePackageExportFile({
				expectedPackageName: "@ts-drp/canonical",
				exportKey: ".",
				packageDirectory: directory,
			});
			const packageDirectoryRealpath = realpathSync(directory);
			expect(imported).toMatchObject({
				module: { marker: "fresh-built-export" },
				packageDirectoryRealpath,
				targetRealpath: realpathSync(resolve(packageDirectoryRealpath, "dist/index.js")),
			});
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it(D108E4_INFRASTRUCTURE_BEHAVIORS[1], async () => {
		const root = mkdtempSync(resolve(tmpdir(), "ts-drp-d108e4-export-file-negative-"));
		try {
			const rootRealpath = realpathSync(root);
			const packageDirectory = resolve(rootRealpath, "canonical");
			mkdirSync(resolve(packageDirectory, "dist"), { recursive: true });
			writeFileSync(resolve(packageDirectory, "dist/index.js"), "export const marker = true;\n", "utf8");
			writeFileSync(resolve(packageDirectory, "dist/empty.js"), "", "utf8");
			const invoke = (selectedDirectory = packageDirectory): Promise<unknown> =>
				importWorkspacePackageExportFile({
					expectedPackageName: "@ts-drp/canonical",
					exportKey: ".",
					packageDirectory: selectedDirectory,
				});
			for (const [name, manifest] of [
				["wrong-name", { name: "@ts-drp/not-canonical", exports: { ".": { import: "./dist/index.js" } } }],
				["missing-export", { name: "@ts-drp/canonical", exports: {} }],
				["source-target", { name: "@ts-drp/canonical", exports: { ".": { import: "./src/index.ts" } } }],
				["declaration-target", { name: "@ts-drp/canonical", exports: { ".": { import: "./dist/index.d.ts" } } }],
				["empty-target", { name: "@ts-drp/canonical", exports: { ".": { import: "" } } }],
				["escape-target", { name: "@ts-drp/canonical", exports: { ".": { import: "../outside.js" } } }],
				[
					"absolute-target",
					{ name: "@ts-drp/canonical", exports: { ".": { import: resolve(rootRealpath, "outside.js") } } },
				],
				["missing-built-target", { name: "@ts-drp/canonical", exports: { ".": { import: "./dist/missing.js" } } }],
				["empty-built-target", { name: "@ts-drp/canonical", exports: { ".": { import: "./dist/empty.js" } } }],
			] as const) {
				writeFileSync(resolve(packageDirectory, "package.json"), JSON.stringify(manifest), "utf8");
				await expect.soft(invoke(), name).rejects.toThrow(/workspace package export file mismatch/u);
			}
			const nodeModulesPackage = resolve(rootRealpath, "node_modules/@ts-drp/canonical");
			mkdirSync(resolve(nodeModulesPackage, "dist"), { recursive: true });
			writeFileSync(
				resolve(nodeModulesPackage, "package.json"),
				JSON.stringify({ name: "@ts-drp/canonical", exports: { ".": { import: "./dist/index.js" } } }),
				"utf8"
			);
			writeFileSync(resolve(nodeModulesPackage, "dist/index.js"), "export const marker = true;\n", "utf8");
			await expect
				.soft(invoke(nodeModulesPackage), "node-modules-directory")
				.rejects.toThrow(/workspace package export file mismatch/u);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("freezes exactly seven RED and eight GREEN test-infrastructure owners", () => {
		expect(D108E1_RED_PATHS).toHaveLength(7);
		expect(D108E1_GREEN_PATHS).toHaveLength(8);
		expect(new Set(D108E1_RED_PATHS).size).toBe(7);
		expect(new Set(D108E1_GREEN_PATHS).size).toBe(8);
		expect(D108E1_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
	});

	it("binds the closed hook only after the package's own built export map resolves the exact target", () => {
		const canonical = resolve(REPOSITORY_ROOT, "packages/canonical/dist/src/index.js");
		const activation = resolve(REPOSITORY_ROOT, "packages/node/dist/src/creator-adoption-activate.js");
		expect(
			workspacePackageImportHook({
				expectedImports: {
					"@ts-drp/canonical": canonical,
					"@ts-drp/node/creator-adoption-activate": activation,
				},
			})
		).toMatch(/^--import=data:text\/javascript;base64,/u);
		for (const wrongTarget of [
			resolve(REPOSITORY_ROOT, "packages/compaction/dist/src/snapshot-stream.js"),
			resolve(REPOSITORY_ROOT, "packages/canonical/dist/src/domain-hash-stream.js"),
			resolve(REPOSITORY_ROOT, "packages/canonical/dist/src/index.d.ts"),
			resolve(REPOSITORY_ROOT, "packages/canonical/src/index.ts"),
		]) {
			expect(() =>
				workspacePackageImportHook({
					expectedImports: { "@ts-drp/canonical": wrongTarget },
				})
			).toThrow(/workspace package target mismatch for @ts-drp\/canonical/u);
		}
	});

	it("rejects completion-derived snapshot telemetry", () => {
		const expectedReads = Object.freeze([
			Object.freeze({ bodySha256: "b".repeat(64), byteLength: 32, digest: "a".repeat(64), index: 0 }),
		] satisfies readonly D108e1ExpectedSnapshotRead[]);
		expect(
			isD108e1DirectSnapshotTelemetry(
				{
					completeAfterReads: true,
					completeBeforeSubscribe: true,
					declaredChunkCount: 1,
					directReadInvocationCount: 0,
					reads: [
						{
							byteLength: 32,
							digest: "a".repeat(64),
							index: 0,
							observedBodySha256: "b".repeat(64),
							observedByteLength: 32,
							readInvocationOrdinal: 1,
							source: "verification-quarantine-port",
						},
					],
					telemetrySource: "awaited-port-read",
				},
				expectedReads
			)
		).toBe(false);
	});

	it("removes its setup-created empty parent and preserves the live owner on refusal", async () => {
		expect(existsSync(SHIM_ROOT)).toBe(false);
		expect(existsSync(SHIM_PARENT)).toBe(false);
		const setup = await activationShimSetupModule();
		let cleanup: (() => void) | undefined;
		try {
			cleanup = await setup.default();
			expect(existsSync(SHIM_ROOT)).toBe(true);
			expect(existsSync(SHIM_PARENT)).toBe(true);
			const canonicalManifest = resolve(SHIM_ROOT, "canonical/package.json");
			const manifestBytes = readFileSync(canonicalManifest);
			const refusal = await setup.default().then(
				() => undefined,
				(error: unknown) => error
			);
			expect.soft(refusal).toBeInstanceOf(Error);
			expect.soft(refusal instanceof Error ? refusal.message : String(refusal)).toContain(SHIM_ROOT);
			expect.soft(readFileSync(canonicalManifest)).toEqual(manifestBytes);
			cleanup();
			cleanup = undefined;
			expect.soft(existsSync(SHIM_ROOT)).toBe(false);
			expect.soft(existsSync(SHIM_PARENT)).toBe(false);
		} finally {
			cleanup?.();
			rmSync(SHIM_ROOT, { force: true, recursive: true });
			if (existsSync(SHIM_PARENT)) rmdirSync(SHIM_PARENT);
		}
	});

	it("preserves a pre-existing empty shim parent", async () => {
		expect(existsSync(SHIM_ROOT)).toBe(false);
		expect(existsSync(SHIM_PARENT)).toBe(false);
		mkdirSync(SHIM_PARENT, { recursive: true });
		try {
			const setup = await activationShimSetupModule();
			const cleanup = await setup.default();
			cleanup();
			expect(existsSync(SHIM_ROOT)).toBe(false);
			expect(existsSync(SHIM_PARENT)).toBe(true);
		} finally {
			rmSync(SHIM_ROOT, { force: true, recursive: true });
			if (existsSync(SHIM_PARENT)) rmdirSync(SHIM_PARENT);
		}
	});

	it("refuses populated and dangling exact roots without deleting caller ownership", async () => {
		expect(existsSync(SHIM_ROOT)).toBe(false);
		expect(existsSync(SHIM_PARENT)).toBe(false);
		const setup = await activationShimSetupModule();
		mkdirSync(SHIM_ROOT, { recursive: true });
		const sentinel = resolve(SHIM_ROOT, "preexisting.txt");
		writeFileSync(sentinel, "caller-owned", "utf8");
		try {
			const populatedRefusal = await setup.default().then(
				() => undefined,
				(error: unknown) => error
			);
			expect.soft(populatedRefusal).toBeInstanceOf(Error);
			expect
				.soft(populatedRefusal instanceof Error ? populatedRefusal.message : String(populatedRefusal))
				.toContain(SHIM_ROOT);
			expect.soft(readFileSync(sentinel, "utf8")).toBe("caller-owned");
		} finally {
			rmSync(SHIM_ROOT, { force: true, recursive: true });
		}

		const danglingTarget = "d108e6-caller-owned-missing-target";
		symlinkSync(danglingTarget, SHIM_ROOT);
		try {
			const danglingRefusal = await setup.default().then(
				() => undefined,
				(error: unknown) => error
			);
			expect.soft(danglingRefusal).toBeInstanceOf(Error);
			expect
				.soft(danglingRefusal instanceof Error ? danglingRefusal.message : String(danglingRefusal))
				.toContain(SHIM_ROOT);
			let observedTarget: string | undefined;
			try {
				observedTarget = readlinkSync(SHIM_ROOT);
			} catch {
				observedTarget = undefined;
			}
			expect.soft(observedTarget).toBe(danglingTarget);
		} finally {
			rmSync(SHIM_ROOT, { force: true, recursive: true });
			if (existsSync(SHIM_PARENT)) rmdirSync(SHIM_PARENT);
		}
	});

	it("cleans its root and setup-created parent after a deterministic setup failure", async () => {
		expect(existsSync(SHIM_ROOT)).toBe(false);
		expect(existsSync(SHIM_PARENT)).toBe(false);
		const setup = await activationShimSetupModule();
		if (setup.setupActivationWorkspaceShims === undefined) {
			throw new Error("D108E6_AFTER_ROOT_CREATED_SEAM_ABSENT");
		}
		await expect(
			setup.setupActivationWorkspaceShims({
				afterRootCreated() {
					throw new Error("D108E6_AFTER_ROOT_CREATED_FAILURE");
				},
			})
		).rejects.toThrow("D108E6_AFTER_ROOT_CREATED_FAILURE");
		expect(existsSync(SHIM_ROOT)).toBe(false);
		expect(existsSync(SHIM_PARENT)).toBe(false);
	});

	it("moves package shims behind one bounded Playwright global-setup owner", async () => {
		expect(existsSync(GLOBAL_SETUP)).toBe(true);
		expect(existsSync(SHIM_ROOT)).toBe(false);
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
		expect(existsSync(SHIM_ROOT)).toBe(false);
		const setup = (await import(`${pathToFileURL(GLOBAL_SETUP).href}?d108e1=${crypto.randomUUID()}`)) as Readonly<{
			default(): Promise<() => void>;
		}>;
		const parentExisted = existsSync(SHIM_PARENT);
		mkdirSync(SHIM_PARENT, { recursive: true });
		try {
			writeFileSync(SHIM_SIBLING_SENTINEL, "sibling-owned", "utf8");
			try {
				const cleanup = await setup.default();
				expect(existsSync(SHIM_ROOT)).toBe(true);
				try {
					throw new Error("D108E1_SIMULATED_TEST_FAILURE");
				} catch (error) {
					expect(error).toEqual(new Error("D108E1_SIMULATED_TEST_FAILURE"));
				} finally {
					cleanup();
				}
				expect(existsSync(SHIM_ROOT)).toBe(false);
				expect(readFileSync(SHIM_SIBLING_SENTINEL, "utf8")).toBe("sibling-owned");
			} finally {
				rmSync(SHIM_ROOT, { force: true, recursive: true });
			}

			mkdirSync(SHIM_ROOT, { recursive: true });
			const sentinel = resolve(SHIM_ROOT, "preexisting.txt");
			writeFileSync(sentinel, "caller-owned", "utf8");
			try {
				await expect(setup.default()).rejects.toThrow(/workspace package shim root already exists/u);
				expect(readFileSync(sentinel, "utf8")).toBe("caller-owned");
			} finally {
				rmSync(SHIM_ROOT, { force: true, recursive: true });
			}
		} finally {
			rmSync(SHIM_SIBLING_SENTINEL, { force: true });
			rmSync(SHIM_ROOT, { force: true, recursive: true });
			if (!parentExisted) rmdirSync(SHIM_PARENT);
		}
	});
});

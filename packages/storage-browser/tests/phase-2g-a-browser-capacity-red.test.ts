import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as browserRoot from "../src/index.js";
import { selectBrowserCapacityFactory } from "./fixtures/phase-2g-a-browser-capacity-scaffold.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");
const browserModule = browserRoot as unknown as Record<string, unknown>;

function sourceFiles(directory: string): readonly string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const candidate = path.join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(candidate);
		return entry.isFile() && entry.name.endsWith(".ts") ? [candidate] : [];
	});
}

function writeJson(file: string, value: unknown): void {
	fs.writeFileSync(file, `${JSON.stringify(value, undefined, "\t")}\n`);
}

describe("Phase 2g-a sole no-argument browser capacity binding RED", () => {
	it("switches the permissive scaffold to a supplied real binding", () => {
		const marker = Object.freeze({ estimate: () => ({ quota: 1, usage: 0 }) });
		const selected = selectBrowserCapacityFactory({ createBrowserStorageCapacityPort: () => marker });
		expect(selected()).toBe(marker);
	});

	it("keeps the existing public root and adds exactly one no-argument capacity binding", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIRECTORY, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
		};
		const factory = selectBrowserCapacityFactory(browserModule);
		factory();
		expect.soft(Object.keys(manifest.exports ?? {})).toEqual(["."]);
		expect.soft(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@ts-drp/canonical", "@ts-drp/storage"]);
		expect.soft(factory.length).toBe(0);
		expect
			.soft(Object.keys(browserModule).sort())
			.toEqual(["createBrowserAheDurableStore", "createBrowserStorageCapacityPort"]);
		expect.soft(browserModule.createBrowserStorageCapacityPort).toBeTypeOf("function");
	});

	it("has one browser-only navigator.storage owner and no inference or injection vocabulary", () => {
		const productionFiles = [
			...sourceFiles(path.join(WORKSPACE_DIRECTORY, "packages/storage/src")),
			...sourceFiles(path.join(WORKSPACE_DIRECTORY, "packages/storage-browser/src")),
		];
		const owners = productionFiles.filter((file) =>
			/\bnavigator(?:\?\.)?storage\b|Reflect\.get\([^\n]+["']navigator["']/u.test(fs.readFileSync(file, "utf8"))
		);
		expect.soft(owners).toHaveLength(1);
		expect.soft(owners[0]?.startsWith(path.join(WORKSPACE_DIRECTORY, "packages/storage-browser/src"))).toBe(true);
		const browserSource = sourceFiles(path.join(WORKSPACE_DIRECTORY, "packages/storage-browser/src"))
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		expect.soft(/createBrowserStorageCapacityPort\s*\(\s*\)/u.test(browserSource)).toBe(true);
		expect
			.soft(browserSource)
			.not.toMatch(/\b(?:incognito|private[-_ ]?mode|userAgent|quota[-_ ]?threshold|browser[-_ ]?brand)\b/iu);
		expect
			.soft(browserSource)
			.not.toMatch(/createBrowserStorageCapacityPort\s*\([^)]*(?:platform|navigator|storageManager|fault|test)/iu);
	});

	it("ships the exact no-argument browser binding to a packed consumer", () => {
		const consumerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2g-a-browser-consumer-"));
		try {
			execFileSync("pnpm", ["--dir", PACKAGE_DIRECTORY, "build"], {
				cwd: WORKSPACE_DIRECTORY,
				stdio: "pipe",
			});
			const packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", consumerDirectory], {
					cwd: PACKAGE_DIRECTORY,
					encoding: "utf8",
				})
			) as readonly Readonly<{ filename: string }>[];
			const browserPackage = path.join(consumerDirectory, "node_modules/@ts-drp/storage-browser");
			fs.mkdirSync(browserPackage, { recursive: true });
			execFileSync(
				"tar",
				[
					"-xzf",
					path.join(consumerDirectory, packed[0]?.filename ?? "missing.tgz"),
					"--strip-components=1",
					"-C",
					browserPackage,
				],
				{ stdio: "pipe" }
			);
			const storagePackage = path.join(consumerDirectory, "node_modules/@ts-drp/storage");
			fs.mkdirSync(storagePackage, { recursive: true });
			writeJson(path.join(storagePackage, "package.json"), {
				exports: { ".": { types: "./index.d.ts" } },
				name: "@ts-drp/storage",
				type: "module",
				version: "0.0.0-phase-2g-a-control",
			});
			fs.writeFileSync(
				path.join(storagePackage, "index.d.ts"),
				`export interface AheDurableStore { close(): Promise<void> }
export type StorageCapacityPort = Readonly<{
	persisted?: () => unknown;
	persist?: () => unknown;
	estimate?: () => unknown;
}>;
`
			);
			fs.writeFileSync(
				path.join(consumerDirectory, "consumer.ts"),
				`import type { StorageCapacityPort } from "@ts-drp/storage";
import { createBrowserStorageCapacityPort } from "@ts-drp/storage-browser";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _NoArguments = Expect<Equal<Parameters<typeof createBrowserStorageCapacityPort>, []>>;
type _ExactResult = Expect<Equal<ReturnType<typeof createBrowserStorageCapacityPort>, StorageCapacityPort>>;
const factory: () => StorageCapacityPort = createBrowserStorageCapacityPort;
void factory;
`
			);
			writeJson(path.join(consumerDirectory, "tsconfig.json"), {
				compilerOptions: {
					lib: ["ES2023", "DOM"],
					module: "NodeNext",
					moduleResolution: "NodeNext",
					noEmit: true,
					skipLibCheck: false,
					strict: true,
					target: "ES2023",
					types: [],
				},
				files: ["./consumer.ts"],
			});
			const compilation = spawnSync(
				"pnpm",
				["exec", "tsc", "--project", path.join(consumerDirectory, "tsconfig.json"), "--pretty", "false"],
				{ cwd: WORKSPACE_DIRECTORY, encoding: "utf8" }
			);
			if (compilation.error) throw compilation.error;
			const diagnostics = `${compilation.stdout}${compilation.stderr}`.trim();
			expect(compilation.status, diagnostics).toBe(0);
			expect(diagnostics).toBe("");
		} finally {
			fs.rmSync(consumerDirectory, { force: true, recursive: true });
		}
	});
});

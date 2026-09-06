import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as browserRoot from "../src/index.js";

const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");

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

describe("Phase 2g-b browser metadata capability RED", () => {
	it("keeps the existing runtime root while giving IDB sole getKey-only presence ownership", () => {
		expect
			.soft(Object.keys(browserRoot).sort())
			.toEqual(["createBrowserAheDurableStore", "createBrowserStorageCapacityPort"]);
		const browserSource = sourceFiles(path.join(WORKSPACE_DIRECTORY, "packages/storage-browser/src"))
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		const idbAdapterSource = fs.readFileSync(
			path.join(WORKSPACE_DIRECTORY, "packages/storage-browser/src/internal/idb-adapter.ts"),
			"utf8"
		);
		const neutralStoreSource = fs.readFileSync(
			path.join(WORKSPACE_DIRECTORY, "packages/storage/src/memory.ts"),
			"utf8"
		);
		const nodeSource = sourceFiles(path.join(WORKSPACE_DIRECTORY, "packages/storage-node/src"))
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		expect.soft(browserSource).toMatch(/\bprobeBlobPresence\b/u);
		const methodStart = idbAdapterSource.search(/\bpublic\s+(?:async\s+)?probeBlobPresence\b/u);
		const methodEnd = methodStart < 0 ? -1 : idbAdapterSource.indexOf("\n\tpublic ", methodStart + 1);
		const methodSource =
			methodStart < 0 ? "" : idbAdapterSource.slice(methodStart, methodEnd < 0 ? undefined : methodEnd);
		expect.soft(methodSource.match(/\.getKey\s*\(/gu) ?? []).toHaveLength(1);
		expect
			.soft(methodSource)
			.not.toMatch(/\b(?:digestBlob|encode|decode|JSON|structuredClone|Uint8Array)\b|\.get\s*\(/u);
		expect.soft(neutralStoreSource).not.toMatch(/\bprobeBlobPresence\b/u);
		expect.soft(nodeSource).not.toMatch(/\bprobeBlobPresence\b/u);
	});

	it("ships the exact browser composition and factory return type", () => {
		const consumerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2g-b-browser-consumer-"));
		try {
			execFileSync("pnpm", ["--dir", PACKAGE_DIRECTORY, "build"], { cwd: WORKSPACE_DIRECTORY, stdio: "pipe" });
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
				version: "0.0.0-phase-2g-b-control",
			});
			fs.writeFileSync(
				path.join(storagePackage, "index.d.ts"),
				`declare const digest: unique symbol;
export type BlobDigest = string & { readonly [digest]: true };
export type StoreResult<T> = { readonly ok:true; readonly value:T } | { readonly ok:false; readonly reason:string; readonly cause?:unknown };
export interface AheDurableStore { readonly marker: "ahe"; close(): Promise<void> }
export interface BlobExistencePort { probeBlobPresence(digests: readonly BlobDigest[]): Promise<StoreResult<readonly boolean[]>> }
`
			);
			fs.writeFileSync(
				path.join(consumerDirectory, "consumer.ts"),
				`import type { AheDurableStore, BlobExistencePort } from "@ts-drp/storage";
import { type BrowserAheDurableStore, createBrowserAheDurableStore } from "@ts-drp/storage-browser";
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
type Expect<T extends true> = T;
type _Composition = Expect<Equal<BrowserAheDurableStore, AheDurableStore & BlobExistencePort>>;
type _Return = Expect<Equal<Awaited<ReturnType<typeof createBrowserAheDurableStore>>, BrowserAheDurableStore>>;
const factory: (input: { readonly databaseName:string }) => Promise<BrowserAheDurableStore> = createBrowserAheDurableStore;
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
	}, 30_000);
});

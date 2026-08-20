import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { checkEmittedWorkerGraph } from "./emitted-worker-graph.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

async function fixture(files: Readonly<Record<string, string>>, entries: readonly string[]): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), "phase-2f-c-graph-"));
	temporaryRoots.push(root);
	for (const [path, source] of Object.entries(files)) {
		const absolute = resolve(root, path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, source);
	}
	await writeFile(resolve(root, "worker-entries.json"), JSON.stringify(entries));
	return root;
}

async function failure(root: string): Promise<string> {
	try {
		await checkEmittedWorkerGraph(root);
		return "no failure";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("Phase 2f-c emitted worker graph checker", () => {
	test("clean five-import graph is bundled by esbuild", async () => {
		const files: Record<string, string> = { "src/clean.worker.ts": 'import "./one.js"; export const value = 1;' };
		for (let index = 1; index <= 5; index++) {
			files[`src/${["one", "two", "three", "four", "five"][index - 1]}.ts`] =
				index === 5 ? "export const leaf = 5;" : `import "./${["two", "three", "four", "five"][index - 1]}.js";`;
		}
		const root = await fixture(files, ["src/clean.worker.ts"]);
		const [artifact] = await checkEmittedWorkerGraph(root);
		expect(artifact?.inputs).toHaveLength(6);
		expect(artifact?.bytes.byteLength).toBeGreaterThan(0);
	});

	test("static cycles remain esbuild-owned", async () => {
		const root = await fixture(
			{
				"src/cycle.worker.ts": 'import { a } from "./a.js"; postMessage(a);',
				"src/a.ts": 'import { b } from "./b.js"; export const a = b + 1;',
				"src/b.ts": 'import { a } from "./a.js"; export const b = a ?? 0;',
			},
			["src/cycle.worker.ts"]
		);
		expect(await checkEmittedWorkerGraph(root)).toHaveLength(1);
	});

	test("type-only imports and import.meta are clean controls", async () => {
		const root = await fixture(
			{
				"src/meta.worker.ts":
					'import type { Marker } from "./types.js"; const marker: Marker = "ok"; postMessage([marker, import.meta.url]);',
				"src/types.ts": 'export type Marker = "ok";',
			},
			["src/meta.worker.ts"]
		);
		expect(await checkEmittedWorkerGraph(root)).toHaveLength(1);
	});

	test.each([
		["direct", { "src/bad.worker.ts": "await Promise.resolve();" }],
		[
			"transitive",
			{ "src/bad.worker.ts": 'import "./dep.js";', "src/dep.ts": "await Promise.resolve(); export const value = 1;" },
		],
		[
			"export-star",
			{
				"src/bad.worker.ts": 'export * from "./dep.js";',
				"src/dep.ts": "await Promise.resolve(); export const value = 1;",
			},
		],
	] as const)("rejects %s top-level await", async (_name, files) => {
		const root = await fixture(files, ["src/bad.worker.ts"]);
		expect(await failure(root)).toContain("top-level await is forbidden");
	});

	test("rejects top-level for-await while allowing it inside a function", async () => {
		const bad = await fixture({ "src/bad.worker.ts": "for await (const item of []) postMessage(item);" }, [
			"src/bad.worker.ts",
		]);
		expect(await failure(bad)).toContain("top-level for-await is forbidden");
		const good = await fixture(
			{ "src/good.worker.ts": "export async function run() { for await (const item of []) postMessage(item); }" },
			["src/good.worker.ts"]
		);
		expect(await checkEmittedWorkerGraph(good)).toHaveLength(1);
	});

	test("rejects dynamic import but permits ordinary static imports", async () => {
		const root = await fixture(
			{ "src/bad.worker.ts": 'void import("./dep.js");', "src/dep.ts": "export const value = 1;" },
			["src/bad.worker.ts"]
		);
		expect(await failure(root)).toContain("dynamic import is forbidden");
	});

	test("rejects both missing and unlisted manifest entries", async () => {
		const unlisted = await fixture({ "src/present.worker.ts": "postMessage(1);" }, []);
		expect(await failure(unlisted)).toContain("unlisted=[src/present.worker.ts]");
		const missing = await fixture({}, ["src/missing.worker.ts"]);
		expect(await failure(missing)).toContain("missing=[src/missing.worker.ts]");
	});

	test("scans the emitted artifact for approved-dependency top-level await", async () => {
		const root = await fixture(
			{
				"src/bad.worker.ts": 'import { value } from "@ts-drp/canonical"; postMessage(value);',
				"node_modules/@ts-drp/canonical/package.json": JSON.stringify({
					name: "@ts-drp/canonical",
					type: "module",
					main: "index.js",
				}),
				"node_modules/@ts-drp/canonical/index.js": "await Promise.resolve(); export const value = 1;",
			},
			["src/bad.worker.ts"]
		);
		expect(await failure(root)).toContain("artifact: top-level await is forbidden");
	});

	test.each(["@ts-drp/application", "@ts-drp/object", "@ts-drp/protocol-v3", "@ts-drp/reducer", "@ts-drp/fold"])(
		"excludes %s ownership from worker and fixture imports",
		async (owner) => {
			const root = await fixture({ "src/owned.worker.ts": `import ${JSON.stringify(owner)};` }, [
				"src/owned.worker.ts",
			]);
			expect(await failure(root)).toContain(`forbidden bare import ${owner}`);
		}
	);

	test("excludes a forbidden owner reached through a local helper", async () => {
		const root = await fixture(
			{
				"src/owned.worker.ts": 'import "./helper.js";',
				"src/helper.ts": 'import "@ts-drp/object";',
				"node_modules/@ts-drp/object/package.json": JSON.stringify({
					name: "@ts-drp/object",
					type: "module",
					main: "index.js",
				}),
				"node_modules/@ts-drp/object/index.js": "export const forbidden = true;",
			},
			["src/owned.worker.ts"]
		);
		expect(await failure(root)).toContain("forbidden dependency owner object");
	});

	test("enforces input-count and per-source byte bounds", async () => {
		const manyFiles: Record<string, string> = {
			"src/many.worker.ts": Array.from({ length: 256 }, (_, index) => `import "./m${index}.js";`).join("\n"),
		};
		for (let index = 0; index < 256; index++) manyFiles[`src/m${index}.ts`] = `export const v${index} = ${index};`;
		const many = await fixture(manyFiles, ["src/many.worker.ts"]);
		expect(await failure(many)).toContain("257 exceeds 256");
		const large = await fixture({ "src/large.worker.ts": `/*${"x".repeat(256 * 1024)}*/` }, ["src/large.worker.ts"]);
		expect(await failure(large)).toContain("source bytes exceeds 262144");
	});

	test("enforces the emitted-artifact byte bound", async () => {
		const files: Record<string, string> = {
			"src/large.worker.ts": Array.from({ length: 17 }, (_, index) => `import { v${index} } from "./p${index}.js";`)
				.concat(`postMessage([${Array.from({ length: 17 }, (_, index) => `v${index}`).join(",")}]);`)
				.join("\n"),
		};
		for (let index = 0; index < 17; index++)
			files[`src/p${index}.ts`] = `export const v${index} = "${"x".repeat(250_000)}${index}";`;
		const root = await fixture(files, ["src/large.worker.ts"]);
		expect(await failure(root)).toContain("emitted bytes exceeds 4194304");
	});

	test("the real worker-host manifest and every worker entry pass the exact gate", async () => {
		const artifacts = await checkEmittedWorkerGraph(PACKAGE_ROOT);
		expect(artifacts.length).toBeGreaterThan(0);
	});
});

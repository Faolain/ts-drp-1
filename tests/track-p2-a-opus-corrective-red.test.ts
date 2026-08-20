import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildBlueprint } from "../packages/blueprint-toolchain/src/index.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures/track-p2-a");
const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `track-p2-a-corrective-${label}-`));
	temporaryDirectories.push(directory);
	return directory;
}

function authoringWithSource(
	label: string,
	sourceFixture: string
): { readonly authoring: string; readonly output: string } {
	const root = temporaryDirectory(label);
	const authoring = path.join(root, "authoring");
	fs.mkdirSync(authoring);
	fs.copyFileSync(path.join(FIXTURE_ROOT, "forward-counter/blueprint.json"), path.join(authoring, "blueprint.json"));
	fs.copyFileSync(sourceFixture, path.join(authoring, "blueprint.ts"));
	return { authoring, output: path.join(root, "bundle") };
}

function runTsc(project: string): ReturnType<typeof spawnSync> {
	return spawnSync("pnpm", ["exec", "tsc", "-p", project], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		timeout: 30_000,
	});
}

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Track P2-a Opus corrective causal RED", () => {
	it("builds valid template-literal and regular-expression reducer source without AST traversal failure", async () => {
		const { authoring, output } = authoringWithSource(
			"valid-literals",
			path.join(FIXTURE_ROOT, "literal-controls/blueprint.ts")
		);
		await expect(buildBlueprint(authoring, output)).resolves.toBeUndefined();
		expect(fs.readdirSync(output).sort()).toEqual(["artifact.mjs", "lint.bin", "package.bin", "receipt.bin"]);
	});

	it("keeps the AST guard causal by rejecting a forbidden module export", async () => {
		const source = path.join(temporaryDirectory("forbidden-source"), "blueprint.ts");
		fs.copyFileSync(path.join(FIXTURE_ROOT, "forward-counter/blueprint.ts"), source);
		fs.appendFileSync(source, "export {};\n");
		const { authoring, output } = authoringWithSource("forbidden", source);
		await expect(buildBlueprint(authoring, output)).rejects.toThrow(/forbidden ExportNamedDeclaration/u);
		expect(fs.existsSync(output)).toBe(false);
	});

	it("typechecks the load-bearing production JavaScript with checkJs enabled", () => {
		const project = "tests/tsconfig.track-p2-a-toolchain-checkjs.json";
		const config = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, project), "utf8")) as {
			readonly compilerOptions?: { readonly checkJs?: boolean };
		};
		expect(config.compilerOptions?.checkJs).toBe(true);
		const result = runTsc(project);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	});

	it("proves the checkJs gate is load-bearing with a seeded bad-shape JavaScript mutant", () => {
		const result = runTsc("tests/tsconfig.track-p2-a-checkjs-mutant.json");
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(
			/checkjs-bad-shape\.js[\s\S]*TS2322|TS2322[\s\S]*number[\s\S]*string/u
		);
	});
});

describe("Track P2-a exact-byte fixture governance", () => {
	it("keeps the exact allowlist lint-clean and Prettier-stable without changing governed bytes", () => {
		const governed = [
			"packages/blueprint-toolchain/contracts/no-ambient-lint-v1.json",
			"tests/fixtures/track-p2-a/date-controls/artifact.mjs",
			"tests/fixtures/track-p2-a/forward-counter/artifact.mjs",
			"tests/fixtures/track-p2-a/no-ambient-lint-v1.json",
		];
		const before = Object.fromEntries(
			governed.map((filename) => [filename, fs.readFileSync(path.join(REPOSITORY_ROOT, filename))])
		);
		const lint = spawnSync("pnpm", ["exec", "eslint", "tests/fixtures/track-p2-a"], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(lint.status, `${lint.stdout}\n${lint.stderr}`).toBe(0);
		const format = spawnSync("pnpm", ["exec", "prettier", "--check", ...governed], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(format.status, `${format.stdout}\n${format.stderr}`).toBe(0);
		for (const filename of governed)
			expect(fs.readFileSync(path.join(REPOSITORY_ROOT, filename))).toEqual(before[filename]);
	}, 60_000);
});

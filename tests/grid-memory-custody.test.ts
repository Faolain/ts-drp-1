import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectGridSourceHashes } from "./fixtures/grid-memory-custody.mjs";

const temporaryRoots: string[] = [];
const requiredFiles = [
	"tests/fixtures/grid-memory-profiler.ts",
	"tests/grid-memory-attribution-contract.test.ts",
	"scripts/run-grid-memory-attribution.mjs",
] as const;

function put(root: string, path: string, content: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "grid-custody-contract-"));
	temporaryRoots.push(root);
	git(root, "init", "--quiet");
	for (const path of ["src/staged.ts", "src/unstaged.ts", "src/unchanged.ts", requiredFiles[0]]) {
		put(root, path, `baseline:${path}\n`);
	}
	git(root, "add", ".");
	git(
		root,
		"-c",
		"user.name=Custody Test",
		"-c",
		"user.email=custody@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--quiet",
		"-m",
		"baseline"
	);
	put(root, "src/staged.ts", "staged-only edit\n");
	git(root, "add", "src/staged.ts");
	put(root, "src/unstaged.ts", "unstaged edit\n");
	put(root, requiredFiles[1], "untracked attribution control\n");
	put(root, requiredFiles[2], "untracked capture launcher\n");
	return root;
}

function sha256(root: string, path: string): string {
	return createHash("sha256")
		.update(readFileSync(join(root, path)))
		.digest("hex");
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("grid capture source custody", () => {
	it("hashes tracked changes against HEAD and every required source, including untracked controls and launcher", () => {
		const root = fixture();
		expect(git(root, "diff", "--name-only")).toBe("src/unstaged.ts\n");
		expect(git(root, "diff", "--cached", "--name-only")).toBe("src/staged.ts\n");
		const hashes = collectGridSourceHashes(root, requiredFiles);
		const paths = [...requiredFiles, "src/staged.ts", "src/unstaged.ts"];
		expect(hashes).toEqual(Object.fromEntries(paths.map((path) => [path, sha256(root, path)])));
	});

	it.each([...requiredFiles, "src/staged.ts", "src/unstaged.ts"])(
		"changes the captured SHA256 when included source %s changes",
		(path) => {
			const root = fixture();
			const before = collectGridSourceHashes(root, requiredFiles);
			put(root, path, `mutated:${path}\n`);
			const after = collectGridSourceHashes(root, requiredFiles);
			expect(before[path]).toMatch(/^[a-f0-9]{64}$/u);
			expect(after[path]).toBe(sha256(root, path));
			expect(after[path]).not.toBe(before[path]);
			for (const other of Object.keys(before).filter((candidate) => candidate !== path)) {
				expect(after[other]).toBe(before[other]);
			}
		}
	);

	it("fails closed when any explicitly required source is absent", () => {
		const root = fixture();
		expect(() => collectGridSourceHashes(root, [...requiredFiles, "tests/missing-required-control.ts"])).toThrow();
	});
});

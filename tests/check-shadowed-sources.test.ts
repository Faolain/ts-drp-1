import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { findShadowedSources } from "../scripts/check-shadowed-sources.mjs";

function tree(files: readonly string[]): string {
	const root = mkdtempSync(join(tmpdir(), "shadowed-sources-"));
	for (const file of files) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), "");
	}
	return root;
}

describe("shadowed source guard", () => {
	test("reports tsc output beside its source", () => {
		const root = tree([
			"packages/a/src/internal/x.ts",
			"packages/a/src/internal/x.js",
			"packages/a/src/internal/x.d.ts",
			"packages/a/src/internal/x.d.ts.map",
			"packages/a/src/y.mts",
			"packages/a/src/y.mjs",
			"tests/fixtures/z.tsx",
			"tests/fixtures/z.js.map",
		]);
		expect(findShadowedSources(root)).toEqual([
			"packages/a/src/internal/x.d.ts",
			"packages/a/src/internal/x.d.ts.map",
			"packages/a/src/internal/x.js",
			"packages/a/src/y.mjs",
			"tests/fixtures/z.js.map",
		]);
	});

	test("allows hand-written modules, dependencies, build output and hidden evidence", () => {
		const root = tree([
			"tests/fixtures/f.ts",
			"tests/fixtures/f.mjs",
			"tests/fixtures/g.js",
			"packages/a/node_modules/x/z.ts",
			"packages/a/node_modules/x/z.js",
			"packages/a/dist/w.ts",
			"packages/a/dist/w.js",
			"tests/.frozen/q.ts",
			"tests/.frozen/q.js",
		]);
		expect(findShadowedSources(root)).toEqual([]);
	});

	test("the repository has no compiled output shadowing a source", () => {
		expect(findShadowedSources()).toEqual([]);
	});
});

import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Phase 4b peer-cache runtime firewall", () => {
	it("keeps the main/localStorage entry free of node:* and publishes fs only from ./node", async () => {
		const mainEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
		const nodeEntry = fileURLToPath(new URL("../src/node.ts", import.meta.url));
		const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
		const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			exports?: Record<string, { import?: string; types?: string }>;
		};

		expect(manifest.exports?.["./node"]).toEqual({
			import: "./dist/src/node.js",
			types: "./dist/src/node.d.ts",
		});
		expect(existsSync(nodeEntry), "the fs adapter must live in a Node-only source entry").toBe(true);
		if (!existsSync(nodeEntry)) return;

		const mainBuiltins = await resolvedNodeBuiltins(mainEntry, "browser");
		const nodeBuiltins = await resolvedNodeBuiltins(nodeEntry, "node");
		expect(mainBuiltins).toEqual([]);
		expect(nodeBuiltins).toEqual(expect.arrayContaining([expect.stringMatching(/^node:fs(?:\/promises)?$/u)]));
	});
});

async function resolvedNodeBuiltins(entryPoint: string, platform: "browser" | "node"): Promise<string[]> {
	const builtins = new Set<string>();
	await build({
		bundle: true,
		entryPoints: [entryPoint],
		format: "esm",
		platform,
		plugins: [
			{
				name: "phase-four-b-cache-builtin-audit",
				setup(buildApi): void {
					buildApi.onResolve({ filter: /^node:/ }, (args) => {
						builtins.add(args.path);
						return { external: true, path: args.path };
					});
				},
			},
		],
		write: false,
	});
	return [...builtins].sort();
}

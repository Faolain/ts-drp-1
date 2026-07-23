import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Phase 4a rendezvous service split", () => {
	it("keeps node:http out of the browser entry and reachable only through @ts-drp/rendezvous/service", async () => {
		const mainEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
		const serviceEntry = fileURLToPath(new URL("../src/service.ts", import.meta.url));
		const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
		const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			exports?: Record<string, { import?: string; types?: string }>;
		};

		expect(manifest.exports?.["./service"]).toEqual({
			import: "./dist/src/service.js",
			types: "./dist/src/service.d.ts",
		});
		expect(existsSync(serviceEntry), "the Node-only service must live outside the main entry").toBe(true);
		if (!existsSync(serviceEntry)) return;

		const mainBuiltins = await resolvedNodeBuiltins(mainEntry, "browser");
		const serviceBuiltins = await resolvedNodeBuiltins(serviceEntry, "node");
		expect(mainBuiltins).toEqual([]);
		expect(serviceBuiltins).toContain("node:http");
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
				name: "phase-four-node-builtin-audit",
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

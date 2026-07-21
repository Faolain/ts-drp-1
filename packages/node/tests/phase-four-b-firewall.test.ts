import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Phase 4b @ts-drp/node browser firewall", () => {
	it("keeps cache persistence runtime-selected without pulling the rendezvous Node subpath into main", async () => {
		const forbidden = new Set<string>();
		const entryPoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
		const result = await build({
			bundle: true,
			entryPoints: [entryPoint],
			format: "esm",
			platform: "browser",
			plugins: [
				{
					name: "phase-four-b-node-firewall",
					setup(buildApi): void {
						buildApi.onResolve({ filter: /^(?:node:|@ts-drp\/rendezvous\/node$)/ }, (args) => {
							forbidden.add(args.path);
							return { external: true, path: args.path };
						});
					},
				},
				NodeModulesPolyfillPlugin(),
				NodeGlobalsPolyfillPlugin(),
			],
			write: false,
		});
		const bundledSource = result.outputFiles.map(({ text }) => text).join("\n");

		expect([...forbidden]).toEqual([]);
		expect(bundledSource).toContain("rendezvous-cache");
		expect(bundledSource).toContain("rendezvous-invite");
	}, 30_000);
});

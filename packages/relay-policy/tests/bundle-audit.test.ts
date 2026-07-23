import * as relayPolicy from "@ts-drp/relay-policy";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("relay-policy public surface", () => {
	it("does not export the retired cold Node closest-peer relay source", () => {
		expect("NodeRoutingClosestPeersSource" in relayPolicy).toBe(false);
	});
});

describe("relay-policy browser bundle", () => {
	it("resolves no node:* builtin from the package entry", async () => {
		const resolvedNodeBuiltins = new Set<string>();
		await build({
			bundle: true,
			entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
			format: "esm",
			platform: "browser",
			plugins: [
				{
					name: "audit-node-builtins",
					setup(buildApi): void {
						buildApi.onResolve({ filter: /^node:/ }, (args) => {
							resolvedNodeBuiltins.add(args.path);
							return { external: true, path: args.path };
						});
					},
				},
			],
			write: false,
		});

		expect([...resolvedNodeBuiltins]).toEqual([]);
	});
});

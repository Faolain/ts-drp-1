import { build, type Plugin } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("routing-browser bundle firewall", () => {
	it("bundles the package entry for browsers without resolving Node builtins", async () => {
		const resolvedNodeBuiltins: string[] = [];
		const auditNodeBuiltins: Plugin = {
			name: "audit-node-builtins",
			setup(build): void {
				build.onResolve({ filter: /^node:/ }, ({ path }) => {
					resolvedNodeBuiltins.push(path);
					return { external: true, path };
				});
			},
		};

		await build({
			bundle: true,
			entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
			format: "esm",
			platform: "browser",
			plugins: [auditNodeBuiltins],
			write: false,
		});

		expect(resolvedNodeBuiltins).toEqual([]);
	});
});

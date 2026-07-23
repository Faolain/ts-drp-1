import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const sourceEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const packageJsonUrl = new URL("../package.json", import.meta.url);
let builtEntry = "";
let packageJson: { exports?: Record<string, { import?: unknown }> };

beforeAll(async () => {
	packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as typeof packageJson;
	const exportedMain = packageJson.exports?.["."]?.import;
	if (typeof exportedMain !== "string") throw new Error("@ts-drp/node main import export is missing");
	builtEntry = fileURLToPath(new URL(exportedMain, packageJsonUrl));
	try {
		await access(builtEntry);
	} catch {
		await execFileAsync("pnpm", ["--filter", "@ts-drp/node", "build"], {
			cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		});
	}
}, 30_000);

describe("@ts-drp/node entry firewall", () => {
	it("keeps the main entry browser-safe while publishing a separate Node-only runtime subpath", async () => {
		const forbidden = new Set<string>();
		for (const entryPoint of [sourceEntry, builtEntry]) {
			await build({
				bundle: true,
				entryPoints: [entryPoint],
				format: "esm",
				platform: "browser",
				plugins: [
					{
						name: "audit-node-runtime-dependencies",
						setup(buildApi): void {
							buildApi.onResolve(
								{ filter: /^(?:node:|@ts-drp\/routing-node(?:\/|$)|@libp2p\/(?:kad-dht|tcp)(?:\/|$))/ },
								(args) => {
									forbidden.add(args.path);
									return { external: true, path: args.path };
								}
							);
						},
					},
					// Known follow-up: prom-client brings polyfilled bare http/https/zlib through network metrics.
					NodeModulesPolyfillPlugin(),
					NodeGlobalsPolyfillPlugin(),
				],
				write: false,
			});
		}

		expect([...forbidden]).toEqual([]);
		expect(packageJson.exports?.["./runtime"]).toBeDefined();
	}, 30_000);
});

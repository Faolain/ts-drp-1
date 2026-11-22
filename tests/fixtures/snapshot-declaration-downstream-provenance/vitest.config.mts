import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vitest/config";

function builtPackage(id: string): string {
	const [, name, ...subpath] = id.split("/");
	const packageRoot = new URL(`../../../packages/node/node_modules/@ts-drp/${name}/`, import.meta.url);
	const manifestPath = realpathSync(fileURLToPath(new URL("package.json", packageRoot)));
	const manifestBytes = readFileSync(manifestPath);
	if (process.env.DOWNSTREAM_CUSTODY)
		appendFileSync(
			process.env.DOWNSTREAM_CUSTODY,
			JSON.stringify({
				kind: "fixture-package-export-map",
				specifier: id,
				url: pathToFileURL(manifestPath).href,
				sha256: createHash("sha256").update(manifestBytes).digest("hex"),
			}) + "\n"
		);
	const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
		exports: Record<string, { import: string } | string>;
	};
	const key = subpath.length ? "./" + subpath.join("/") : ".";
	const entry = manifest.exports[key];
	return realpathSync(fileURLToPath(new URL(typeof entry === "string" ? entry : entry.import, packageRoot)));
}

export default defineConfig({
	root: fileURLToPath(new URL("../../../", import.meta.url)),
	plugins: [
		{
			name: "built-fixture-package-resolution",
			enforce: "pre",
			resolveId(id): string | undefined {
				if (id.startsWith("@ts-drp/")) return builtPackage(id);
			},
			transform(_code, id): void {
				if (process.env.DOWNSTREAM_CUSTODY && id.includes("/tests/") && !id.includes("?"))
					appendFileSync(
						process.env.DOWNSTREAM_CUSTODY,
						JSON.stringify({
							kind: "vite-fixture-transform",
							url: pathToFileURL(id).href,
							sha256: createHash("sha256").update(readFileSync(id)).digest("hex"),
						}) + "\n"
					);
			},
		},
	],
	resolve: {
		alias: [
			{
				find: /.*packages\/node\/src\/v3-live\.js$/,
				replacement: fileURLToPath(new URL("../../../packages/node/dist/src/v3-live.js", import.meta.url)),
			},
			{
				find: /.*packages\/canonical\/src\/index\.js$/,
				replacement: fileURLToPath(new URL("../../../packages/canonical/dist/src/index.js", import.meta.url)),
			},
		],
	},
	test: {
		server: { deps: { external: [/packages\/.*\/dist\//] } },
		include: ["tests/fixtures/snapshot-declaration-downstream-provenance/pull.test.ts"],
		coverage: { enabled: false },
		testTimeout: 60000,
	},
});

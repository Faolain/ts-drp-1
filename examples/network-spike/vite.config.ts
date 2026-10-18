import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
	build: {
		target: "esnext",
	},
	plugins: [
		{
			// Match the existing native source launcher: generated sibling .js
			// artifacts must not shadow the current workspace TypeScript candidate.
			name: "current-workspace-source",
			enforce: "pre",
			resolveId(id, importer): string | undefined {
				if (importer === undefined || !id.startsWith(".") || !id.endsWith(".js")) return;
				const source = path.resolve(path.dirname(importer), `${id.slice(0, -3)}.ts`);
				const workspace = path.resolve(import.meta.dirname, "../..");
				if (source.startsWith(`${workspace}${path.sep}`) && existsSync(source)) return source;
			},
		},
		nodePolyfills(),
	],
	optimizeDeps: {
		esbuildOptions: {
			target: "esnext",
		},
	},
	resolve: {
		alias: [
			{
				find: "@ts-drp/example-browser-network",
				replacement: path.resolve(import.meta.dirname, "../browser-network/src/index.ts"),
			},
			{
				find: "@ts-drp/network-spike/grid/fixture",
				replacement: path.resolve(import.meta.dirname, "../../packages/network-spike/src/grid/fixture.ts"),
			},
			{
				find: /^@ts-drp\/node\/(.+)$/,
				replacement: path.resolve(import.meta.dirname, "../../packages/node/src/$1.ts"),
			},
			{ find: /^@ts-drp\/node$/, replacement: path.resolve(import.meta.dirname, "../../packages/node/src/index.ts") },
			{
				find: "vite-plugin-node-polyfills/shims/process",
				replacement: path.resolve(import.meta.dirname, "node_modules/vite-plugin-node-polyfills/shims/process"),
			},
		],
	},
	server: {
		host: "127.0.0.1",
		port: 4174,
	},
});

import path from "node:path";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
	build: {
		target: "esnext",
	},
	plugins: [nodePolyfills()],
	optimizeDeps: {
		esbuildOptions: {
			target: "esnext",
		},
	},
	resolve: {
		alias: {
			"vite-plugin-node-polyfills/shims/process": path.resolve(
				import.meta.dirname,
				"node_modules/vite-plugin-node-polyfills/shims/process"
			),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 4174,
	},
});

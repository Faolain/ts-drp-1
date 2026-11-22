import { build, type Plugin } from "esbuild";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cacheProbePlugin } from "./plugin.js";

// Track Y measurement only: bundles ./node-long-room.ts for Node with the cache probe (./plugin.ts) from the
// WORKING-TREE SOURCES: every `@ts-drp/*` specifier resolves to the package's `src/*.ts`, and every relative
// `.js` import whose `.ts` sibling exists resolves to the `.ts` (a stale compiled sibling never runs instead of
// source). Third-party packages and Node built-ins are bundled or left to Node as esbuild decides for
// `platform: "node"`.
//
// usage: node --experimental-strip-types tests/fixtures/cache-probe/build-node.ts <out.mjs> [residency]
// ("residency" builds the residency-only probe: no events and no key table, for endurance runs)

const root = resolve(import.meta.dirname, "../../..");

function packageDirectories(): Map<string, string> {
	const out = new Map<string, string>();
	for (const base of ["packages", "examples"])
		for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
			const manifest = join(root, base, entry.name, "package.json");
			if (!entry.isDirectory() || !existsSync(manifest)) continue;
			const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
			if (typeof name === "string") out.set(name, join(root, base, entry.name));
		}
	return out;
}

function sourcePlugin(): Plugin {
	const packages = packageDirectories();
	return {
		name: "cache-probe-node-current-source",
		setup(context): void {
			context.onResolve({ filter: /^@ts-drp\// }, (args) => {
				const match = /^(@ts-drp\/[^/]+)(?:\/(.+))?$/.exec(args.path);
				const directory = match === null ? undefined : packages.get(match[1] ?? "");
				if (match === null || directory === undefined) return undefined;
				const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
					exports?: Record<string, string | { import?: string; default?: string }>;
				};
				const exported = manifest.exports?.[match[2] === undefined ? "." : `./${match[2]}`];
				const target = typeof exported === "string" ? exported : (exported?.import ?? exported?.default);
				if (target === undefined) return undefined;
				if (target.endsWith(".json")) return { path: join(directory, target) };
				const source = join(directory, target.replace(/^\.\/dist\//, "./").replace(/\.js$/, ".ts"));
				if (!existsSync(source)) throw new Error(`CACHE_PROBE_NODE_SOURCE_MISSING ${args.path}`);
				return { path: source };
			});
			context.onResolve({ filter: /^\..*\.js$/ }, (args) => {
				if (args.resolveDir.includes("/node_modules/")) return undefined;
				const source = resolve(args.resolveDir, `${args.path.slice(0, -3)}.ts`);
				return source.startsWith(`${root}/`) && existsSync(source) ? { path: source } : undefined;
			});
		},
	};
}

const [outfile, mode] = process.argv.slice(2);
if (outfile === undefined || (mode !== undefined && mode !== "residency"))
	throw new Error("usage: build-node.ts <out.mjs> [residency]");
await build({
	bundle: true,
	entryPoints: [join(import.meta.dirname, "node-long-room.ts")],
	format: "esm",
	outfile: resolve(outfile),
	platform: "node",
	target: "node22",
	logLevel: "warning",
	nodePaths: [join(root, "node_modules")],
	banner: {
		js: 'import { createRequire as __cacheProbeRequire } from "node:module"; const require = __cacheProbeRequire(import.meta.url);',
	},
	plugins: [cacheProbePlugin({ residencyOnly: mode === "residency" }), sourcePlugin()],
});
process.stdout.write(`${resolve(outfile)}\n`);

import { build, type Metafile, type Plugin } from "esbuild";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Track Q (Canvas and Chat creator lull in a browser): bundles
// tests/fixtures/canvas-chat-lull/browser/entry.ts from the WORKING-TREE SOURCES of the tree
// it sits in (Track M's tests/fixtures/track-m-apps/browser/build.ts, da3704ac). Every
// `@ts-drp/*` specifier resolves to the package's `src/*.ts` (the module its `exports` names
// under `dist/src/*.js`), and every relative `.js` import whose `.ts` sibling exists resolves
// to the `.ts` (a stale compiled sibling never runs instead of source). Only third-party
// packages come from node_modules.

const root = resolve(import.meta.dirname, "../../../..");
const here = import.meta.dirname;

function packageDirectories(): Map<string, string> {
	const out = new Map<string, string>();
	for (const base of ["packages", "examples"])
		for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifest = join(root, base, entry.name, "package.json");
			if (!existsSync(manifest)) continue;
			const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
			if (typeof name === "string") out.set(name, join(root, base, entry.name));
		}
	return out;
}

async function viteAliases(): Promise<Record<string, string>> {
	const loaded = (await import(new URL("../../../../vite.config.mts", import.meta.url).href)) as {
		workspaceAliases: Record<string, string>;
	};
	return { ...loaded.workspaceAliases };
}

function sourcePlugin(aliases: Record<string, string>, distResolved: Set<string>): Plugin {
	const packages = packageDirectories();
	return {
		name: "canvas-chat-lull-current-source",
		setup(context): void {
			context.onResolve({ filter: /^@ts-drp\// }, (args) => {
				const exact = aliases[args.path];
				if (exact !== undefined && existsSync(exact)) return { path: exact };
				const match = /^(@ts-drp\/[^/]+)(?:\/(.+))?$/.exec(args.path);
				const directory = match === null ? undefined : packages.get(match[1] ?? "");
				if (match === null || directory === undefined) return undefined;
				const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
					exports?: Record<string, string | { import?: string; default?: string }>;
				};
				const subpath = match[2] === undefined ? "." : `./${match[2]}`;
				const exported = manifest.exports?.[subpath];
				const target = typeof exported === "string" ? exported : (exported?.import ?? exported?.default);
				if (target === undefined) return undefined;
				if (target.endsWith(".json")) return { path: join(directory, target) };
				const source = join(directory, target.replace(/^\.\/dist\//, "./").replace(/\.js$/, ".ts"));
				if (existsSync(source)) return { path: source };
				distResolved.add(args.path);
				return undefined;
			});
			context.onResolve({ filter: /^\..*\.js$/ }, (args) => {
				if (args.resolveDir.includes(`${"/"}node_modules${"/"}`)) return undefined;
				const source = resolve(args.resolveDir, `${args.path.slice(0, -3)}.ts`);
				return source.startsWith(`${root}/`) && existsSync(source) ? { path: source } : undefined;
			});
		},
	};
}

/**
 * Builds the page into `outDir`.
 * @param outDir - New, empty output directory.
 * @returns Specifiers that did not resolve to source (expected empty) and the bundle inputs.
 */
export async function buildCanvasChatLullAssets(
	outDir: string
): Promise<Readonly<{ distResolved: string[]; inputs: string[] }>> {
	const aliases = await viteAliases();
	const distResolved = new Set<string>();
	const result = await build({
		bundle: true,
		entryPoints: { "ccl-entry": join(here, "entry.ts") },
		format: "esm",
		outdir: outDir,
		platform: "browser",
		target: "es2022",
		metafile: true,
		logLevel: "warning",
		nodePaths: [join(root, "packages/storage-browser/node_modules"), join(root, "node_modules")],
		plugins: [sourcePlugin(aliases, distResolved)],
	});
	writeFileSync(
		join(outDir, "ccl.html"),
		'<!doctype html><meta charset="utf-8"><title>canvas-chat-lull</title><script type="module" src="./ccl-entry.js"></script>',
		"utf8"
	);
	const inputs = Object.keys((result.metafile as Metafile).inputs);
	writeFileSync(join(outDir, "inputs.json"), JSON.stringify({ distResolved: [...distResolved], inputs }, null, 1));
	return { distResolved: [...distResolved], inputs };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(here, "build.ts")) {
	const out = process.argv[2];
	if (out === undefined) throw new Error("usage: build.ts <outDir>");
	const built = await buildCanvasChatLullAssets(resolve(out));
	const dist = built.inputs.filter((file) => /packages\/[^/]+\/dist\//.test(file));
	process.stdout.write(
		`${JSON.stringify({ out: resolve(out), distResolved: built.distResolved, distInputs: dist, inputs: built.inputs.length })}\n`
	);
}

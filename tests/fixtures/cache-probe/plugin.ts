import type { Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Track Y measurement only: an esbuild plugin that wraps the library's five in-memory caches with the probe in
// ./probe.ts, in the bundle only. The source files are never changed. Each harness enables it behind its own
// explicit build flag (off by default), so no shipped or default test bundle contains the probe.

const probeModule = join(import.meta.dirname, "probe.ts");

const SITES: readonly { readonly file: RegExp; readonly variable: string; readonly name: string }[] = [
	{
		file: /\/packages\/canonical\/(?:dist\/)?src\/internal\/codec\.(?:ts|js)$/u,
		variable: "hashMemo",
		name: "hashMemo",
	},
	{
		file: /\/packages\/node\/(?:dist\/)?src\/internal\/creator-transition-advance\.(?:ts|js)$/u,
		variable: "transitionMemo",
		name: "transitionMemo",
	},
	{
		file: /\/packages\/protocol-v3\/(?:dist\/)?src\/index\.(?:ts|js)$/u,
		variable: "trustRecordVerdicts",
		name: "trustRecordVerdicts",
	},
	{
		file: /\/packages\/protocol-v3\/(?:dist\/)?src\/internal\/ed25519-verify\.(?:ts|js)$/u,
		variable: "memo",
		name: "ed25519Memo",
	},
	{
		file: /\/packages\/storage\/(?:dist\/)?src\/values\.(?:ts|js)$/u,
		variable: "closureDigests",
		name: "closureDigests",
	},
];

/**
 * The cache-probe plugin. Put it first in the plugin list: it loads the five cache-owning modules itself.
 * @param options - `residencyOnly`: the probe records no events and keeps no key table (endurance runs).
 * @param options.residencyOnly - Whether the bundle's probe only reports each cache's resident entries and size.
 * @returns The plugin; the build fails if any cache declaration is not found exactly once.
 */
export function cacheProbePlugin(options: { readonly residencyOnly?: boolean } = {}): Plugin {
	const mode = options.residencyOnly === true ? ', "residency"' : "";
	return {
		name: "track-y-cache-probe",
		setup(build): void {
			const wrapped = new Set<string>();
			// esbuild runs filters as Go regular expressions: no flags.
			const filter = new RegExp(SITES.map((site) => site.file.source).join("|"));
			build.onLoad({ filter }, ({ path }) => {
				const site = SITES.find((row) => row.file.test(path));
				if (site === undefined) return undefined;
				const raw = readFileSync(path, "utf8");
				const declaration = new RegExp(`\\bconst ${site.variable} = new Map(<[^;]*?>)?\\(\\);`, "gu");
				const matches = [...raw.matchAll(declaration)];
				if (matches.length !== 1) throw new Error(`CACHE_PROBE_SITE_CHANGED ${site.name} ${path} ${matches.length}`);
				const contents =
					`import { probeCache as __trackYProbeCache } from ${JSON.stringify(probeModule)};\n` +
					raw.replace(
						declaration,
						(_, types: string | undefined) =>
							`const ${site.variable} = __trackYProbeCache(${JSON.stringify(site.name)}, new Map${types ?? ""}()${mode});`
					);
				wrapped.add(site.name);
				return { contents, loader: path.endsWith(".ts") ? "ts" : "js", resolveDir: dirname(path) };
			});
			build.onEnd((result) => {
				if (result.errors.length !== 0) return;
				const missing = SITES.filter((site) => !wrapped.has(site.name)).map((site) => site.name);
				if (missing.length !== 0) throw new Error(`CACHE_PROBE_SITES_NOT_BUNDLED ${missing.join(",")}`);
			});
		},
	};
}

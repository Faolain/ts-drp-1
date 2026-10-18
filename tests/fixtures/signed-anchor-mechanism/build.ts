import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { liveFrameObservation } from "./instrument.js";
const destination = process.argv[2];
if (!destination) throw new Error("FRESH_OUTPUT_REQUIRED");
mkdirSync(destination);
const root = resolve(import.meta.dirname, "../../.."),
	entries = [];
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
for (const name of process.argv.slice(3)) {
	const browser = name.startsWith("browser");
	const entry =
		name === "browser-cleanup"
			? join(root, "tests/fixtures/rollback-data-observation/browser-cleanup.ts")
			: join(root, "tests/fixtures/signed-anchor-mechanism", name + ".ts");
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: browser ? "browser" : "node",
		target: "es2022",
		alias: {
			"@ts-drp/canonical": join(root, "packages/canonical/dist/src/index.js"),
			"@ts-drp/canonical/domain-hash-stream": join(root, "packages/canonical/dist/src/domain-hash-stream.js"),
		},
		write: false,
		metafile: true,
		plugins:
			name === "node-entry" || name === "browser-entry"
				? [{ name: "one-current-workspace-owner", setup(context) {
					context.onResolve({ filter: /^@ts-drp\// }, ({ path }) => {
						const [name, ...subpath] = path.slice("@ts-drp/".length).split("/");
						const directory = join(root, "packages", name);
						const manifest = join(directory, "package.json");
						if (!existsSync(manifest)) return;
						const pkg = JSON.parse(readFileSync(manifest, "utf8"));
						const item = pkg.exports?.[subpath.length ? `./${subpath.join("/")}` : "."];
						const target = typeof item === "string" ? item : item?.import;
						if (typeof target !== "string") return;
						const file = resolve(directory, target).replace("/dist/src/", "/src/").replace(/\.js$/u, ".ts");
						if (existsSync(file)) return { path: file };
					});
					context.onResolve({ filter: /\.js$/ }, ({ path, importer }) => {
						if (!path.startsWith(".")) return;
						const file = resolve(dirname(importer), path).replace("/dist/src/", "/src/").replace(/\.js$/u, ".ts");
						if (file.startsWith(join(root, "packages/")) && existsSync(file)) return { path: file };
					});
				} }, liveFrameObservation(root, join(destination, name + "-live-frame"))]
				: [],
		banner: browser
			? undefined
			: {
					js: 'import { createRequire as __fixtureCreateRequire } from "node:module"; const require = __fixtureCreateRequire(import.meta.url);',
				},
	});
	const output = result.outputFiles[0];
	if (!output) throw new Error("NO_BUNDLE");
	const outputPath = join(destination, name + ".mjs");
	writeFileSync(outputPath, output.contents, { flag: "wx" });
	const inputs = Object.fromEntries(
		Object.keys(result.metafile.inputs).map((path) => [path, hash(readFileSync(path))])
	);
	writeFileSync(join(destination, name + ".metafile.json"), JSON.stringify(result.metafile, null, 2), { flag: "wx" });
	entries.push({ name, outputPath, outputSha256: hash(output.contents), inputs });
}
writeFileSync(join(destination, "artifacts.json"), JSON.stringify({ entries }, null, 2), { flag: "wx" });
console.log(JSON.stringify(entries.map(({ name, outputSha256 }) => ({ name, outputSha256 }))));

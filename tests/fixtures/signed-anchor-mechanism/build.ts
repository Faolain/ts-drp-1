import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
		write: false,
		metafile: true,
		plugins:
			name === "node-entry" || name === "browser-entry"
				? [liveFrameObservation(root, join(destination, name + "-live-frame"))]
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

/* eslint-disable @typescript-eslint/no-non-null-assertion -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readerInstrumentation } from "./instrument.js";
const destination = process.argv[2];
if (!destination) throw new Error("FRESH_OUTPUT_REQUIRED");
mkdirSync(destination);
const root = resolve(import.meta.dirname, "../../.."),
	hash = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex"),
	entries = [];
for (const name of process.argv.slice(3)) {
	const actual = join(root, "packages/node/src/internal/creator-closed-rollback-data.ts"),
		available = existsSync(actual);
	const alias = {
		"rollback-observer-under-test": available
			? actual
			: join(root, "tests/fixtures/rollback-data-observation/missing-api.ts"),
	};
	const result = await build({
		entryPoints: [join(root, "tests/fixtures/rollback-data-observation", name + ".ts")],
		alias,
		bundle: true,
		format: "esm",
		platform: name.includes("browser") ? "browser" : "node",
		target: "es2022",
		write: false,
		metafile: true,
		plugins: name.endsWith("recovery")
			? [
					readerInstrumentation(
						root,
						join(destination, name + "-reader-observation"),
						name.includes("browser") ? "browser" : "node",
						name.startsWith("role-")
					),
				]
			: [],
		banner: name.includes("browser")
			? undefined
			: {
					js: 'import { createRequire as __fixtureCreateRequire } from "node:module"; const require = __fixtureCreateRequire(import.meta.url);',
				},
	});
	const bytes = result.outputFiles[0]!.contents,
		outputPath = join(destination, name + ".mjs");
	writeFileSync(outputPath, bytes, { flag: "wx" });
	const inputs = Object.fromEntries(Object.keys(result.metafile.inputs).map((p) => [p, hash(readFileSync(p))]));
	const graphPath = join(destination, name + ".metafile.json");
	writeFileSync(graphPath, JSON.stringify(result.metafile), { flag: "wx" });
	entries.push({ name, outputPath, outputSha256: hash(bytes), inputs, graphPath, observerAvailable: available });
}
writeFileSync(join(destination, "artifacts.json"), JSON.stringify({ entries }, null, 2), { flag: "wx" });
console.log(
	JSON.stringify({ destination, entries: entries.map((e) => ({ name: e.name, outputSha256: e.outputSha256 })) })
);

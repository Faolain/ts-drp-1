import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const result = await build({
	bundle: true,
	entryPoints: ["src/browser-dht/index.ts"],
	format: "esm",
	metafile: true,
	minify: true,
	platform: "browser",
	target: ["es2022"],
	write: false,
});
const output = result.outputFiles[0];
if (output === undefined) throw new Error("esbuild did not return a browser DHT bundle");
const inputs = Object.keys(result.metafile.inputs);
const forbiddenInputs = inputs.filter(
	(input) => input.includes("@libp2p/tcp") || input.startsWith("node:") || input.includes("/node/")
);
const report = {
	bytes: output.contents.byteLength,
	forbiddenInputs,
	gzipBytes: gzipSync(output.contents).byteLength,
	inputCount: inputs.length,
	nodeTcpImported: forbiddenInputs.length > 0,
	verification: "esbuild browser-platform metafile",
};
await writeFile(
	new URL("../../../examples/network-spike/src/browser-dht-bundle-evidence.json", import.meta.url),
	`${JSON.stringify(report, undefined, "\t")}\n`
);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (forbiddenInputs.length > 0) process.exitCode = 1;

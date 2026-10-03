/* eslint-disable jsdoc/require-jsdoc -- Test-owned native entry server with exact build custody. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

export async function buildAssets(): Promise<void> {
	const root = resolve(import.meta.dirname, "../../.."),
		destination = process.env.BOUNDED_AHE_ARTIFACTS;
	if (!destination) throw new Error("new owned artifact directory required");
	const loaded = (await import(new URL("../../../vite.config.mts", import.meta.url).href)) as {
		workspaceAliases: Record<string, string>;
	};
	const alias = { ...loaded.workspaceAliases };
	alias["@ts-drp/example-v3-room"] = join(root, "examples/v3-room/src/index.ts");
	alias["@ts-drp/message-queue"] = join(root, "packages/message-queue/src/index.ts");
	for (const name of [
		"creator-adoption",
		"creator-adoption-activate",
		"creator-adoption-commit",
		"creator-adoption-recover",
		"creator-adoption-stage",
		"creator-close",
		"v3-live",
	])
		alias["@ts-drp/node/" + name] = join(root, "packages/node/src", name + ".ts");
	for (const name of ["browser", "producer"]) {
		const result = await build({
			entryPoints: [join(import.meta.dirname, name + "-entry.ts")],
			bundle: true,
			platform: "browser",
			format: "esm",
			write: false,
			metafile: true,
			alias,
		});
		const firstOutput = result.outputFiles[0],
			metafile = result.metafile;
		if (!firstOutput || !metafile) throw new Error("native bundle output/metafile absent");
		const bytes = firstOutput.contents,
			hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
		writeFileSync(join(destination, name + "-bundle.mjs"), bytes, { flag: "wx" });
		writeFileSync(
			join(destination, name + "-inputs.json"),
			JSON.stringify(
				{
					bundleSha256: hash(bytes),
					inputs: Object.keys(metafile.inputs).map((file) => {
						const actual = realpathSync(resolve(root, file));
						return {
							file,
							actual,
							sha256: hash(readFileSync(actual)),
							external: !actual.startsWith(realpathSync(root) + "/"),
						};
					}),
					metafile: result.metafile,
				},
				null,
				2
			),
			{ flag: "wx" }
		);
	}
}
export async function server(): Promise<{ origin: string; close(): Promise<void> }> {
	const destination = process.env.BOUNDED_AHE_ARTIFACTS;
	if (!destination) throw new Error("exact prebuilt artifact directory required");
	const bytes = readFileSync(join(destination, "browser-bundle.mjs")),
		producer = readFileSync(join(destination, "producer-bundle.mjs"));
	const native = createServer((req, res) => {
		if (req.url === "/entry.js")
			res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(bytes);
		else if (req.url === "/producer.js")
			res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(producer);
		else if (req.url === "/producer")
			res
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end("<!doctype html><script type=module src=/producer.js></script>");
		else if (req.url === "/")
			res
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end("<!doctype html><script type=module src=/entry.js></script>");
		else res.writeHead(404).end();
	});
	await new Promise<void>((ok, fail) => {
		native.once("error", fail);
		native.listen(0, "127.0.0.1", ok);
	});
	const address = native.address();
	if (!address || typeof address === "string") throw new Error("native server address absent");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((ok, fail) => native.close((e) => (e ? fail(e) : ok()))),
	};
}
if (process.argv[2] === "build") await buildAssets();

/* eslint-disable jsdoc/require-jsdoc -- Test-owned native entry server with exact build custody. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

export async function buildAssets(lane: "active" | "role" = "active"): Promise<void> {
	const root = resolve(import.meta.dirname, "../../.."),
		destination = process.env.BOUNDED_AHE_ARTIFACTS;
	if (!destination) throw new Error("new owned artifact directory required");
	const loaded = (await import(new URL("../../../vite.config.mts", import.meta.url).href)) as {
		workspaceAliases: Record<string, string>;
	};
	const alias = { ...loaded.workspaceAliases };
	// Root imports and explicit lifecycle subpaths must share the same custody owner.
	alias["@ts-drp/canonical"] = join(root, "packages/canonical/src");
	alias["@ts-drp/node"] = join(root, "packages/node/src/index.ts");
	alias["@ts-drp/network/snapshot-transfer"] = join(root, "packages/network/src/snapshot-transfer.ts");
	alias["@ts-drp/protocol-v3/internal/creator-forward-promotion"] = join(
		root,
		"packages/protocol-v3/src/internal/creator-forward-promotion.ts"
	);
	alias["@ts-drp/example-v3-room"] = join(root, "examples/v3-room/src/index.ts");
	alias["@ts-drp/message-queue"] = join(root, "packages/message-queue/src/index.ts");
	for (const name of [
		"creator-adoption",
		"creator-adoption-activate",
		"creator-adoption-commit",
		"creator-adoption-recover",
		"creator-adoption-stage",
		"creator-close",
		"snapshot-transfer",
		"v3-live",
	])
		alias["@ts-drp/node/" + name] = join(root, "packages/node/src", name + ".ts");
	for (const name of lane === "role" ? ["role-browser"] : ["browser", "producer"]) {
		const result = await build({
			entryPoints: [join(import.meta.dirname, name + "-entry.ts")],
			bundle: true,
			platform: "browser",
			format: "esm",
			write: false,
			metafile: true,
			alias,
			plugins: [
				{
					name: "current-native-source-owner",
					setup(context): void {
						// Explicit .js imports must not select stale beside-source emit.
						// Reuse the native launcher rule for product and owned fixture sources.
						context.onResolve({ filter: /^\..*\.js$/ }, (args) => {
							const emitted = resolve(args.resolveDir, args.path.slice(0, -3) + ".ts");
							// Explicit fixture imports of workspace dist/src entries must
							// select the same current source owner as its relative imports.
							const target = emitted.startsWith(join(root, "packages") + "/")
								? emitted.replace(/\/dist\/src\//u, "/src/") : emitted;
							return (target.startsWith(join(root, "packages") + "/") ||
								target.startsWith(join(root, "tests/fixtures") + "/")) &&
								existsSync(target)
								? { path: target }
								: undefined;
						});
					},
				},
			],
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
export async function server(lane: "active" | "role" = "active"): Promise<{ origin: string; close(): Promise<void> }> {
	const destination = process.env.BOUNDED_AHE_ARTIFACTS;
	if (!destination) throw new Error("exact prebuilt artifact directory required");
	const bytes = readFileSync(join(destination, lane === "role" ? "role-browser-bundle.mjs" : "browser-bundle.mjs")),
		producer = lane === "active" ? readFileSync(join(destination, "producer-bundle.mjs")) : undefined;
	const native = createServer((req, res) => {
		if (lane === "role" && req.url === "/role.js")
			res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(bytes);
		else if (lane === "role" && req.url === "/role")
			res
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end("<!doctype html><script type=module src=/role.js></script>");
		else if (lane === "active" && req.url === "/entry.js")
			res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(bytes);
		else if (lane === "active" && req.url === "/producer.js")
			res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(producer);
		else if (lane === "active" && req.url === "/producer")
			res
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end("<!doctype html><script type=module src=/producer.js></script>");
		else if (lane === "active" && req.url === "/")
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
// Script entry without top-level await: package programs that import this
// server compile it at their ES6 target. A rejection still exits non-zero.
if (process.argv[2] === "build") void buildAssets();
if (process.argv[2] === "build-role") void buildAssets("role");

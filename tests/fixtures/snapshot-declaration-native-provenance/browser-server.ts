import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export interface NativeBrowserServer {
	origin: string;
	evidence: {
		ownerSha256: string;
		bootstrapSha256: string;
		hashes: Record<string, string>;
		ownerInputs: string[];
		bootstrapInputs: string[];
	};
	close(): Promise<void>;
}

/**
 * Serve pre-import bootstrap and actual source-owner bundle with built dependencies.
 * @returns Isolated server and exact input/bundle hashes.
 */
export async function startNativeBrowserServer(): Promise<NativeBrowserServer> {
	const compile = async (name: string): Promise<{ text: string; inputs: string[] }> => {
		const result = await build({
			entryPoints: [fileURLToPath(new URL(name, import.meta.url))],
			platform: "browser",
			format: "esm",
			bundle: true,
			write: false,
			metafile: true,
		});
		const output = result.outputFiles[0];
		if (output === undefined) throw new Error("missing native browser bundle");
		return { text: output.text, inputs: Object.keys(result.metafile.inputs) };
	};
	const owner = await compile("browser-owner.ts"),
		bootstrap = await compile("browser-bootstrap.ts");
	if (
		!owner.inputs.includes("packages/storage-browser/src/snapshot-transfer.ts") ||
		owner.inputs.includes("packages/storage-browser/dist/src/snapshot-transfer.js")
	)
		throw new Error("native browser must use held source owner");
	for (const path of [
		"packages/storage/dist/src/snapshot-transfer.js",
		"packages/protocol-v3/dist/src/snapshot-transfer.js",
		"packages/canonical/dist/src/index.js",
	])
		if (!owner.inputs.includes(path)) throw new Error("missing actual built dependency: " + path);
	if (bootstrap.inputs.some((path) => path.startsWith("packages/")))
		throw new Error("pre-import bootstrap must not import product modules");
	const hash = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");
	const evidence = {
		ownerSha256: hash(owner.text),
		bootstrapSha256: hash(bootstrap.text),
		hashes: Object.fromEntries(
			[...new Set([...owner.inputs, ...bootstrap.inputs])].map((path) => [path, hash(readFileSync(path))])
		),
		ownerInputs: owner.inputs,
		bootstrapInputs: bootstrap.inputs,
	};
	const server = createServer((request, response) => {
		if (request.url === "/owner.js" || request.url === "/entry.js")
			response
				.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" })
				.end(request.url === "/owner.js" ? owner.text : bootstrap.text);
		else if (request.url === "/")
			response
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end("<!doctype html><script type=module src=/entry.js></script>");
		else response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no native test server TCP binding");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		evidence,
		close: async (): Promise<void> => {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

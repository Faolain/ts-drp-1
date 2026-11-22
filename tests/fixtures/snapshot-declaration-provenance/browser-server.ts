import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export interface BrowserServer {
	origin: string;
	evidence: { resolvedCanonical: string; bundleSha256: string; inputHashes: Record<string, string>; inputs: string[] };
	close(): Promise<void>;
}

/**
 * Serve an in-memory browser bundle from unchanged built product dependencies.
 * @returns Isolated local server and exact bundle/input custody.
 */
export async function startBrowserServer(): Promise<BrowserServer> {
	const resolvedCanonical = execFileSync(
		process.execPath,
		["--input-type=module", "--eval", 'process.stdout.write(import.meta.resolve("@ts-drp/canonical"))'],
		{
			cwd: new URL("../../../packages/protocol-v3/", import.meta.url),
			encoding: "utf8",
			timeout: 10000,
		}
	).trim();
	const expected = new URL("../../../packages/canonical/dist/src/index.js", import.meta.url).href;
	if (resolvedCanonical !== expected) throw new Error("canonical public export changed");
	const result = await build({
		entryPoints: [fileURLToPath(new URL("browser-entry.ts", import.meta.url))],
		bundle: true,
		format: "esm",
		platform: "browser",
		write: false,
		metafile: true,
	});
	const bundle = result.outputFiles[0]?.text;
	if (bundle === undefined) throw new Error("missing browser bundle");
	const inputs = Object.keys(result.metafile.inputs);
	if (!inputs.includes("packages/canonical/dist/src/index.js") || inputs.includes("packages/canonical/src/index.ts"))
		throw new Error("browser must exercise built canonical export");
	const evidence = {
		resolvedCanonical,
		bundleSha256: createHash("sha256").update(bundle).digest("hex"),
		inputs,
		inputHashes: Object.fromEntries(
			inputs.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])
		),
	};
	const server = createServer((request, response) => {
		if (request.url === "/entry.js") {
			response
				.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
				.end(bundle);
		} else if (request.url === "/") {
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
				.end("<!doctype html><meta charset=utf-8><script type=module src=/entry.js></script>");
		} else response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("server did not bind TCP");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		evidence,
		close: async (): Promise<void> => {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

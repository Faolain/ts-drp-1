/* eslint-disable jsdoc/require-jsdoc -- Verify frozen bundles before serving local-only fresh realms. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
export async function server(directory: string): Promise<{ origin: string; close(): Promise<void> }> {
	const entries = (
		JSON.parse(readFileSync(join(directory, "artifacts.json"), "utf8")) as {
			entries: { name: string; outputPath: string; outputSha256: string; inputs: Record<string, string> }[];
		}
	).entries;
	const scripts = new Map<string, Uint8Array>();
	const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
	for (const name of ["browser-entry", "browser-cleanup"]) {
		const artifact = entries.find((entry) => entry.name === name);
		assert.ok(artifact);
		const bytes = readFileSync(artifact.outputPath);
		assert.equal(hash(bytes), artifact.outputSha256);
		for (const [path, expected] of Object.entries(artifact.inputs))
			assert.equal(hash(readFileSync(path)), expected, path);
		scripts.set("/" + name + ".mjs", bytes);
	}
	const instance = createServer((req, res) => {
		const script = scripts.get(req.url ?? "");
		if (script) res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(script);
		else if (req.url === "/work" || req.url === "/cleanup")
			res
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end(`<script type="module" src="/${req.url === "/work" ? "browser-entry" : "browser-cleanup"}.mjs"></script>`);
		else res.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		instance.once("error", reject);
		instance.listen(0, "127.0.0.1", resolve);
	});
	const address = instance.address();
	if (!address || typeof address === "string") throw new Error("NATIVE_SERVER_ADDRESS");
	return {
		origin: "http://127.0.0.1:" + address.port,
		close: () => new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve()))),
	};
}

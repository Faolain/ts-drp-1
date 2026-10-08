import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

/**
 * Serve frozen bundles and verify every actual build input before the first page.
 * @param directory - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function browserServer(
	directory: string
): Promise<{ origin: string; artifactsSha256: string; close(): Promise<void> }> {
	const artifactBytes = readFileSync(join(directory, "artifacts.json"));
	const artifacts = JSON.parse(artifactBytes.toString()) as {
		controllers: Record<string, string>;
		entries: { name: string; outputPath: string; outputSha256: string; inputs: Record<string, string> }[];
	};
	const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
	for (const [path, expected] of Object.entries(artifacts.controllers))
		assert.equal(hash(readFileSync(path)), expected, "fixture/controller input drift:" + path);
	const scripts = new Map<string, Uint8Array>();
	for (const name of ["browser-setup", "browser-recovery", "browser-probe", "browser-auth-probe"]) {
		const artifact = artifacts.entries.find((entry) => entry.name === name);
		assert.ok(artifact);
		const bytes = readFileSync(artifact.outputPath);
		assert.equal(hash(bytes), artifact.outputSha256);
		for (const [path, expected] of Object.entries(artifact.inputs))
			assert.equal(hash(readFileSync(path)), expected, `browser input drift:${path}`);
		scripts.set(`/${name}.mjs`, bytes);
	}
	const server = createServer((request, response) => {
		const script = scripts.get(request.url ?? "");
		if (script !== undefined)
			response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(script);
		else if (["/setup", "/recovery", "/probe", "/auth-probe"].includes(request.url ?? ""))
			response
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end(`<!doctype html><script type="module" src="/browser-${request.url?.slice(1)}.mjs"></script>`);
		else response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("SERVER_ADDRESS");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		artifactsSha256: hash(artifactBytes),
		close: (): Promise<void> =>
			new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

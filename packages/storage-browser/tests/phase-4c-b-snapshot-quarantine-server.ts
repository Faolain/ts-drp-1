import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Phase4cBServer {
	readonly origin: string;
	close(): Promise<void>;
}

async function bundle(entryPoint: string): Promise<string> {
	const result = await build({
		bundle: true,
		entryPoints: [entryPoint],
		format: "esm",
		platform: "browser",
		write: false,
	});
	const output = result.outputFiles[0];
	if (output === undefined) throw new Error("missing browser bundle");
	return output.text;
}

/**
 * Starts the isolated Phase 4c-b browser asset server.
 * @returns Bound server handle.
 */
export async function startPhase4cBServer(): Promise<Phase4cBServer> {
	const directory = dirname(fileURLToPath(import.meta.url));
	const [entry, worker] = await Promise.all([
		bundle(resolve(directory, "assets/phase-4c-b-snapshot-quarantine-entry.ts")),
		bundle(resolve(directory, "assets/phase-4c-b-snapshot-quarantine-worker.ts")),
	]);
	const server: Server = createServer((request, response) => {
		const isolationHeaders = {
			"cross-origin-embedder-policy": "require-corp",
			"cross-origin-opener-policy": "same-origin",
		};
		if (request.url === "/entry.js" || request.url === "/worker.js") {
			response.writeHead(200, {
				...isolationHeaders,
				"cache-control": "no-store",
				"content-type": "text/javascript; charset=utf-8",
			});
			response.end(request.url === "/entry.js" ? entry : worker);
			return;
		}
		if (request.url === "/" || request.url === "/index.html") {
			response.writeHead(200, {
				...isolationHeaders,
				"cache-control": "no-store",
				"content-type": "text/html; charset=utf-8",
			});
			response.end("<!doctype html><meta charset=utf-8><script type=module src=/entry.js></script>");
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("server did not bind a TCP port");
	return Object.freeze({
		origin: `http://127.0.0.1:${address.port}`,
		close: async () => {
			await new Promise<void>((resolvePromise, reject) =>
				server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
			);
		},
	});
}

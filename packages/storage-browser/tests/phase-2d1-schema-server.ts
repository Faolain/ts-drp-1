import * as esbuild from "esbuild";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 43_875;
const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bundle(entryPoint: string): Uint8Array {
	const result = esbuild.buildSync({
		bundle: true,
		entryPoints: [entryPoint],
		format: "esm",
		platform: "browser",
		sourcemap: false,
		target: "es2022",
		write: false,
	});
	const output = result.outputFiles[0];
	if (output === undefined) throw new Error(`esbuild emitted no browser module for ${entryPoint}`);
	return output.contents;
}

const MODULES = new Map([
	["/src/internal/idb-adapter.js", bundle(path.join(PACKAGE_DIRECTORY, "src/internal/idb-adapter.ts"))],
	[
		"/tests/assets/schema-lifecycle-entry.js",
		bundle(path.join(PACKAGE_DIRECTORY, "tests/assets/schema-lifecycle-entry.ts")),
	],
	["/tests/assets/idb-adapter-entry.js", bundle(path.join(PACKAGE_DIRECTORY, "tests/assets/idb-adapter-entry.ts"))],
]);
const PAGE = Buffer.from(
	'<!doctype html><html><head><meta charset="utf-8"><title>Phase 2d1 schema RED</title></head>' +
		'<body><script type="module" src="/tests/assets/schema-lifecycle-entry.js"></script>' +
		'<script type="module" src="/tests/assets/idb-adapter-entry.js"></script></body></html>'
);

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url === "/") {
		response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
		response.end(PAGE);
		return;
	}
	const module = request.url === undefined ? undefined : MODULES.get(request.url);
	if (request.method === "GET" && module !== undefined) {
		response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8" });
		response.end(module);
		return;
	}
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
});

server.listen(PORT, HOST);

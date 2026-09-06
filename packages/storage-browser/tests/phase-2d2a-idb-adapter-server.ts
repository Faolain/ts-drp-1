import * as esbuild from "esbuild";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 43_876;
const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(PACKAGE_DIRECTORY, "tests/assets/idb-adapter-entry.ts");
const ADAPTER = path.join(PACKAGE_DIRECTORY, "src/internal/idb-adapter.ts");

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

const entryModule = bundle(ENTRY);
const page = Buffer.from(
	'<!doctype html><html><head><meta charset="utf-8"><title>Phase 2d2a IDB adapter RED</title></head>' +
		'<body><script type="module" src="/tests/assets/idb-adapter-entry.js"></script></body></html>'
);

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url === "/") {
		response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
		response.end(page);
		return;
	}
	if (request.method === "GET" && request.url === "/tests/assets/idb-adapter-entry.js") {
		response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8" });
		response.end(entryModule);
		return;
	}
	if (request.method === "GET" && request.url === "/src/internal/idb-adapter.js" && fs.existsSync(ADAPTER)) {
		response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8" });
		response.end(bundle(ADAPTER));
		return;
	}
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
});

server.listen(PORT, HOST);

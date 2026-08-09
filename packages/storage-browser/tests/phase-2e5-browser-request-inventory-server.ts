import * as esbuild from "esbuild";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 43_877;
const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(PACKAGE_DIRECTORY, "tests/assets/phase-2e5-browser-inventory-entry.ts");
const PHASE_2E6_ENTRY = path.join(PACKAGE_DIRECTORY, "tests/assets/phase-2e6-real-process-death-entry.ts");
const PHASE_2E6_WORKER = path.join(PACKAGE_DIRECTORY, "tests/assets/phase-2e6-real-process-death-worker.ts");
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
const phase2e6EntryModule = bundle(PHASE_2E6_ENTRY);
const phase2e6WorkerModule = bundle(PHASE_2E6_WORKER);

const page = Buffer.from(
	'<!doctype html><html><head><meta charset="utf-8"><title>Phase 2e5 browser inventory</title></head>' +
		'<body><script type="module" src="/phase-2e5-browser-inventory.js"></script></body></html>'
);
const phase2e6Page = Buffer.from(
	'<!doctype html><html><head><meta charset="utf-8"><title>Phase 2e6 real process death</title></head>' +
		'<body><script type="module" src="/phase-2e6-real-process-death.js"></script></body></html>'
);

const ISOLATION_HEADERS = Object.freeze({
	"cache-control": "no-store",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
});

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url === "/") {
		response.writeHead(200, { ...ISOLATION_HEADERS, "content-type": "text/html; charset=utf-8" });
		response.end(page);
		return;
	}
	if (request.method === "GET" && request.url === "/phase-2e6/") {
		response.writeHead(200, { ...ISOLATION_HEADERS, "content-type": "text/html; charset=utf-8" });
		response.end(phase2e6Page);
		return;
	}
	if (request.method === "GET" && request.url === "/phase-2e5-browser-inventory.js") {
		response.writeHead(200, { ...ISOLATION_HEADERS, "content-type": "text/javascript; charset=utf-8" });
		response.end(entryModule);
		return;
	}
	if (request.method === "GET" && request.url === "/phase-2e6-real-process-death.js") {
		response.writeHead(200, { ...ISOLATION_HEADERS, "content-type": "text/javascript; charset=utf-8" });
		response.end(phase2e6EntryModule);
		return;
	}
	if (request.method === "GET" && request.url === "/phase-2e6-real-process-death-worker.js") {
		response.writeHead(200, { ...ISOLATION_HEADERS, "content-type": "text/javascript; charset=utf-8" });
		response.end(phase2e6WorkerModule);
		return;
	}
	if (request.method === "GET" && request.url === "/src/internal/idb-adapter.js" && fs.existsSync(ADAPTER)) {
		response.writeHead(200, { ...ISOLATION_HEADERS, "content-type": "text/javascript; charset=utf-8" });
		response.end(bundle(ADAPTER));
		return;
	}
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
});

server.listen(PORT, HOST);

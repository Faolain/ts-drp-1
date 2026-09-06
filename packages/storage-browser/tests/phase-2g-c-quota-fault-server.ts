import * as esbuild from "esbuild";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 43_880;
const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_ENTRY = path.join(PACKAGE_DIRECTORY, "tests/assets/phase-2e5-browser-inventory-entry.ts");
const QUOTA_ENTRY = path.join(PACKAGE_DIRECTORY, "tests/assets/phase-2g-c-quota-fault-entry.ts");
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

const inventoryModule = bundle(INVENTORY_ENTRY);
const quotaModule = bundle(QUOTA_ENTRY);
const headers = Object.freeze({
	"cache-control": "no-store",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
});

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url === "/inventory") {
		response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
		response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/inventory.js"></script>');
		return;
	}
	if (request.method === "GET" && request.url === "/quota") {
		response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
		response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/quota.js"></script>');
		return;
	}
	if (request.method === "GET" && request.url === "/inventory.js") {
		response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
		response.end(inventoryModule);
		return;
	}
	if (request.method === "GET" && request.url === "/quota.js") {
		response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
		response.end(quotaModule);
		return;
	}
	if (request.method === "GET" && request.url === "/src/internal/idb-adapter.js" && fs.existsSync(ADAPTER)) {
		response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
		response.end(bundle(ADAPTER));
		return;
	}
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
});

server.listen(PORT, HOST);

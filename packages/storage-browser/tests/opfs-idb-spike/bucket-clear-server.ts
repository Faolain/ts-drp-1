import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HOST = "127.0.0.1";
const PORTS = [43_873, 43_874, 43_875] as const;
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const harness = Buffer.from(
	ts.transpileModule(fs.readFileSync(path.join(DIRECTORY, "assets/bucket-clear-harness.ts"), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
	}).outputText
);
const page = Buffer.from(
	'<!doctype html><html><head><meta charset="utf-8"><title>bucket clear S3</title></head>' +
		'<body><script type="module" src="/bucket-clear-harness.js"></script></body></html>'
);
const headers = {
	"cache-control": "no-store",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
};

for (const port of PORTS) {
	createServer((request, response) => {
		if (request.method === "GET" && request.url === "/") {
			response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
			response.end(page);
			return;
		}
		if (request.method === "GET" && request.url === "/bucket-clear-harness.js") {
			response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
			response.end(harness);
			return;
		}
		response.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
		response.end("not found");
	}).listen(port, HOST);
}

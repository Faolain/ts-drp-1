import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HOST = "127.0.0.1";
const PORT = 43_871;
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = Buffer.from(
	ts.transpileModule(fs.readFileSync(path.join(DIRECTORY, "assets/strict-idb-harness.ts"), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
	}).outputText
);
const PAGE = Buffer.from(
	'<!doctype html><html><head><meta charset="utf-8"><title>strict IDB S1</title></head>' +
		'<body><script type="module" src="/strict-idb-harness.ts"></script></body></html>'
);

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url === "/") {
		response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
		response.end(PAGE);
		return;
	}
	if (request.method === "GET" && request.url === "/strict-idb-harness.ts") {
		response.writeHead(200, {
			"cache-control": "no-store",
			"content-type": "text/javascript; charset=utf-8",
		});
		response.end(HARNESS);
		return;
	}
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
});

server.listen(PORT, HOST);

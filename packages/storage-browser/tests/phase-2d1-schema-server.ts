import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HOST = "127.0.0.1";
const PORT = 43_875;
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function transpile(relativePath: string): Buffer {
	return Buffer.from(
		ts.transpileModule(fs.readFileSync(path.join(DIRECTORY, relativePath), "utf8"), {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
		}).outputText
	);
}

const MODULES = new Map([
	["/src/internal/schema-idb.js", transpile("../src/internal/schema-idb.ts")],
	["/tests/assets/schema-lifecycle-entry.js", transpile("assets/schema-lifecycle-entry.ts")],
]);
const PAGE = Buffer.from(
	'<!doctype html><html><head><meta charset="utf-8"><title>Phase 2d1 schema RED</title></head>' +
		'<body><script type="module" src="/tests/assets/schema-lifecycle-entry.js"></script></body></html>'
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

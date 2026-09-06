import { buildSync } from "esbuild";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 43_872;
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const bundle = buildSync({
	entryPoints: [path.join(DIRECTORY, "assets/substrate-bench-worker.ts")],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	write: false,
});
const worker = bundle.outputFiles[0]?.contents;
if (worker === undefined) throw new Error("S2 Worker bundle was not produced");

const page = Buffer.from(`<!doctype html>
<html><head><meta charset="utf-8"><title>substrate benchmark S2</title></head>
<body><script type="module">
window.runSubstrateBenchmark = (request) => new Promise((resolve, reject) => {
  const worker = new Worker('/substrate-bench-worker.js', { type: 'module' });
  const timeout = setTimeout(() => { worker.terminate(); reject(new Error('S2 Worker timed out')); }, 20000);
  worker.addEventListener('message', (event) => {
    clearTimeout(timeout);
    worker.terminate();
    if (event.data?.ok === true) resolve(event.data.value);
    else reject(new Error(event.data?.error ?? 'S2 Worker failed'));
  }, { once: true });
  worker.addEventListener('error', (event) => {
    clearTimeout(timeout);
    worker.terminate();
    reject(new Error(event.message));
  }, { once: true });
  worker.postMessage(request);
});
</script></body></html>`);

const isolationHeaders = {
	"cache-control": "no-store",
	"cross-origin-embedder-policy": "require-corp",
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
};

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url === "/") {
		response.writeHead(200, { ...isolationHeaders, "content-type": "text/html; charset=utf-8" });
		response.end(page);
		return;
	}
	if (request.method === "GET" && request.url === "/substrate-bench-worker.js") {
		response.writeHead(200, { ...isolationHeaders, "content-type": "text/javascript; charset=utf-8" });
		response.end(worker);
		return;
	}
	response.writeHead(404, { ...isolationHeaders, "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
});

server.listen(PORT, HOST);

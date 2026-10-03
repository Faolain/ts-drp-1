import { createServer } from "node:http";

import { type Artifact, compile } from "./build.js";

export interface ReaderServer {
	origin: string;
	artifact: Omit<Artifact, "text">;
	close(): Promise<void>;
}

/** Exact new loopback server owner; no external traffic or shared product harness edits. */
export async function start(): Promise<ReaderServer> {
	const artifact = await compile("browser-owner.ts");
	const server = createServer((request, response) => {
		if (request.url === "/entry.js")
			response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(artifact.text);
		else if (request.url === "/")
			response
				.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
				.end("<!doctype html><script type=module src=/entry.js></script>");
		else response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("reader fixture loopback binding absent");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		artifact: { sha256: artifact.sha256, inputs: artifact.inputs },
		close: async (): Promise<void> => {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error)))
			);
		},
	};
}

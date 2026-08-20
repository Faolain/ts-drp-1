import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export interface Phase3a0DServer {
	close(): Promise<void>;
	issue(): string;
	revoke(url: string): void;
}

const ASSETS = new Set(["phase-3a0-d.html", "phase-3a0-d-anchor-trust-entry.js"]);

/**
 * Starts the exact loopback-only Phase 3a0-D asset owner.
 * @param assetDirectory - Directory containing the generated D assets.
 * @returns The bounded tokenized server.
 */
export function startPhase3a0DServer(assetDirectory: string): Promise<Phase3a0DServer> {
	const root = fs.realpathSync(assetDirectory);
	const tokens = new Set<string>();
	const server = http.createServer((request, response) => {
		let url: URL;
		try {
			url = new URL(request.url ?? "", "http://127.0.0.1");
		} catch {
			response.writeHead(400).end();
			return;
		}
		const [, prefix, token, asset] = url.pathname.split("/");
		if (prefix !== "phase-3a0-d" || token === undefined || !tokens.has(token) || !ASSETS.has(asset ?? "")) {
			response.writeHead(404).end();
			return;
		}
		const candidate = path.resolve(root, asset ?? "");
		if (!candidate.startsWith(`${root}${path.sep}`)) {
			response.writeHead(404).end();
			return;
		}
		fs.readFile(candidate, (error, body) => {
			if (error) {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, {
				"Cache-Control": "no-store",
				"Content-Type": asset?.endsWith(".js") === true ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
				"Cross-Origin-Embedder-Policy": "require-corp",
				"Cross-Origin-Opener-Policy": "same-origin",
				"Cross-Origin-Resource-Policy": "same-origin",
			});
			response.end(body);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new TypeError("D server did not bind a TCP port"));
				return;
			}
			resolve({
				close: () => new Promise<void>((done, failed) => server.close((error) => (error ? failed(error) : done()))),
				issue: () => {
					const token = randomUUID();
					tokens.add(token);
					return `http://127.0.0.1:${address.port}/phase-3a0-d/${token}/phase-3a0-d.html`;
				},
				revoke: (issued) => {
					const token = new URL(issued).pathname.split("/")[2];
					if (token !== undefined) tokens.delete(token);
				},
			});
		});
	});
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export interface P4AssetServer {
	readonly baseURL: string;
	close(): Promise<void>;
	issueTransitionURL(asset: string): string;
	revoke(token: string): void;
}

const ALLOWED = new Set([
	"phase-3a1b-p4.html",
	"phase-3a1b-p4-browser.js",
	"phase-3a1b-p4-browser-decision-mutant.js",
	"phase-3a1b-p4-decision-mutant.html",
	"phase-3a1b-p4-death.html",
	"phase-3a1b-p4-browser-live-journal-death-entry.js",
	"phase-3a1b-p4-browser-live-journal-worker.js",
]);

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/**
 * Serves only the generated p4 assets with cross-origin isolation.
 * @param assetDirectory - Exact generated p4 directory.
 * @returns Loopback server and one-use transition controls.
 */
export function startP4AssetServer(assetDirectory: string): Promise<P4AssetServer> {
	const root = fs.realpathSync(assetDirectory);
	const tokens = new Set<string>();
	const server = http.createServer((request, response) => {
		const pathname = decodeURIComponent(new URL(request.url ?? "", "http://127.0.0.1").pathname);
		const [, transition, token, asset] = pathname.split("/");
		if (
			transition !== "transition" ||
			token === undefined ||
			asset === undefined ||
			!tokens.has(token) ||
			!ALLOWED.has(asset)
		) {
			response.writeHead(404).end();
			return;
		}
		const candidate = path.resolve(root, asset);
		if (!candidate.startsWith(`${root}${path.sep}`) || !fs.existsSync(candidate)) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"Cache-Control": "no-store",
			"Content-Type":
				path.extname(candidate) === ".html" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Resource-Policy": "same-origin",
		});
		response.end(fs.readFileSync(candidate));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new TypeError("p4 asset server did not bind"));
				return;
			}
			resolve({
				baseURL: `http://127.0.0.1:${address.port}`,
				close: () => closeServer(server),
				issueTransitionURL: (asset): string => {
					if (!ALLOWED.has(asset)) throw new TypeError("p4 transition asset is not allowed");
					const token = randomUUID();
					tokens.add(token);
					return `http://127.0.0.1:${address.port}/transition/${token}/${asset}`;
				},
				revoke: (token): void => {
					tokens.delete(token);
				},
			});
		});
	});
}

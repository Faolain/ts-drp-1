import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export interface AssetServer {
	readonly baseURL: string;
	close(): Promise<void>;
	issueTransitionURL(): string;
	revoke(token: string): void;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
});

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

/**
 * Starts a loopback-only server for the generated suite assets.
 * @param assetDirectory - Resolved per-suite asset directory.
 * @returns The bound server and token controls.
 */
export function startAssetServer(assetDirectory: string): Promise<AssetServer> {
	const root = fs.realpathSync(assetDirectory);
	const allowed = new Set([
		"index.html",
		"page-entry.js",
		"worker-entry.js",
		"seed.html",
		"seed-entry.js",
		"oracle.html",
		"oracle-entry.js",
	]);
	const tokens = new Set<string>();
	const server = http.createServer((request, response) => {
		const rawUrl = request.url ?? "";
		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname).replace(/^\/+/, "");
		} catch {
			response.writeHead(400).end();
			return;
		}
		const parts = pathname.split("/");
		const token = parts.length === 3 && parts[0] === "transition" ? parts[1] : undefined;
		const asset = token === undefined ? pathname : (parts[2] ?? "");
		if (
			!allowed.has(asset) ||
			pathname.includes("..") ||
			path.isAbsolute(pathname) ||
			(token !== undefined && !tokens.has(token))
		) {
			response.writeHead(404).end();
			return;
		}
		const candidate = path.resolve(root, asset);
		if (!candidate.startsWith(`${root}${path.sep}`)) {
			response.writeHead(404).end();
			return;
		}
		fs.readFile(candidate, (error, bytes) => {
			if (error) {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, {
				"Content-Type": CONTENT_TYPES[path.extname(candidate)] ?? "application/octet-stream",
				"Cache-Control": "no-store",
				"Cross-Origin-Opener-Policy": "same-origin",
				"Cross-Origin-Embedder-Policy": "require-corp",
				"Cross-Origin-Resource-Policy": "same-origin",
			});
			response.end(bytes);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new TypeError("asset server did not bind a TCP port"));
				return;
			}
			const baseURL = `http://127.0.0.1:${address.port}`;
			resolve({
				baseURL,
				close: (): Promise<void> => closeServer(server),
				issueTransitionURL: (): string => {
					const token = randomUUID();
					tokens.add(token);
					return `${baseURL}/transition/${token}/index.html`;
				},
				revoke: (token): void => {
					tokens.delete(token);
				},
			});
		});
	});
}

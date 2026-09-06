import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export interface AssetServer {
	readonly baseURL: string;
	close(): Promise<void>;
	issueTransitionURL(asset?: string): string;
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
		"phase-2g-a-capacity-entry.js",
		"phase-2h-a.html",
		"phase-2h-a-inert-entry.js",
		"phase-2h-b.html",
		"phase-2h-b-browser-surfaces.js",
		"phase-2h-b-main-thread-oracle.js",
		"phase-2h-b-operation-workload.js",
		"phase-2h-c-quota-entry.js",
		"phase-2e6.html",
		"phase-2e6-real-process-death.js",
		"phase-2e6-real-process-death-worker.js",
		"phase-2e7.html",
		"phase-2e7-publication-component.js",
		"phase-2l-b.html",
		"phase-2l-b-browser-issuance.js",
		"phase-2l-b-death.html",
		"phase-2l-b-browser-death.js",
		"phase-2l-b-browser-death-worker.js",
		"phase-2l-d.html",
		"phase-2l-d-browser-parity.js",
	]);
	const tokens = new Set<string>();
	const server = http.createServer((request, response) => {
		const rawUrl = request.url ?? "";
		if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
			response.writeHead(404).end();
			return;
		}
		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
		} catch {
			response.writeHead(400).end();
			return;
		}
		const parts = pathname.split("/");
		const token = parts.length === 4 && parts[1] === "transition" ? parts[2] : undefined;
		const asset = token === undefined ? "" : (parts[3] ?? "");
		if (!allowed.has(asset) || pathname.includes("..") || token === undefined || !tokens.has(token)) {
			response.writeHead(404).end();
			return;
		}
		const candidate = path.resolve(root, asset);
		if (!candidate.startsWith(`${root}${path.sep}`)) {
			response.writeHead(404).end();
			return;
		}
		fs.realpath(candidate, (realpathError, realCandidate) => {
			if (realpathError || !realCandidate.startsWith(`${root}${path.sep}`)) {
				response.writeHead(404).end();
				return;
			}
			fs.readFile(realCandidate, (error, bytes) => {
				if (error) {
					response.writeHead(404).end();
					return;
				}
				response.writeHead(200, {
					"Content-Type": CONTENT_TYPES[path.extname(realCandidate)] ?? "application/octet-stream",
					"Cache-Control": "no-store",
					"Cross-Origin-Opener-Policy": "same-origin",
					"Cross-Origin-Embedder-Policy": "require-corp",
					"Cross-Origin-Resource-Policy": "same-origin",
				});
				response.end(bytes);
			});
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
				issueTransitionURL: (asset = "index.html"): string => {
					if (!allowed.has(asset)) throw new TypeError("transition asset is not allowed");
					const token = randomUUID();
					tokens.add(token);
					return `${baseURL}/transition/${token}/${asset}`;
				},
				revoke: (token): void => {
					tokens.delete(token);
				},
			});
		});
	});
}

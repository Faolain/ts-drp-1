import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export type Phase2gACapacityServer = Readonly<{
	baseURL: string;
	close(): Promise<void>;
}>;

/**
 * Starts the loopback-only server for the capacity smoke asset.
 * @param assetDirectory - Generated asset directory.
 * @returns The bound server and close authority.
 */
export function startPhase2gACapacityServer(assetDirectory: string): Promise<Phase2gACapacityServer> {
	const root = fs.realpathSync(assetDirectory);
	const allowed = new Set(["index.html", "phase-2g-a-capacity-entry.js"]);
	const server = http.createServer((request, response) => {
		let asset: string;
		try {
			asset = decodeURIComponent(new URL(request.url ?? "", "http://127.0.0.1").pathname).replace(/^\/+/, "");
		} catch {
			response.writeHead(400).end();
			return;
		}
		if (!allowed.has(asset) || asset.includes("..") || path.isAbsolute(asset)) {
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
				"Cache-Control": "no-store",
				"Content-Type": asset.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
			});
			response.end(bytes);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("Phase 2g-a capacity server failed to bind"));
				return;
			}
			resolve(
				Object.freeze({
					baseURL: `http://127.0.0.1:${address.port}/index.html`,
					close: () =>
						new Promise<void>((closeResolve, closeReject) => {
							server.close((error) => (error ? closeReject(error) : closeResolve()));
						}),
				})
			);
		});
	});
}

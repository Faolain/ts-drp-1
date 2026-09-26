import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

export interface ProductBrowserServer {
	readonly origin: string;
	readonly bundleSha256: string;
	close(): Promise<void>;
}

/**
 *
 * @param entryPoint
 * @param plugins
 */
export async function startProductBrowserServer(
	entryPoint: string,
	plugins: readonly Plugin[] = []
): Promise<ProductBrowserServer> {
	const configUrl = new URL("../../../../vite.config.mts", import.meta.url).href;
	const loaded = (await import(configUrl)) as Readonly<{
		workspaceAliases?: Readonly<Record<string, string>>;
	}>;
	if (loaded.workspaceAliases === undefined) throw new TypeError("D.108d2 workspace aliases are unavailable");
	const lifetimeModules = new Set(
		[
			"creator-adoption",
			"creator-adoption-activate",
			"creator-adoption-commit",
			"creator-adoption-recover",
			"creator-adoption-stage",
			"creator-close",
			"v3-live",
		].map((name) => `@ts-drp/node/${name}`)
	);
	const aliases = Object.freeze(
		Object.fromEntries([
			...Object.entries(loaded.workspaceAliases).filter(([specifier]) => !lifetimeModules.has(specifier)),
			...(plugins.length === 0
				? [...lifetimeModules].map((specifier) => [
						specifier,
						resolve(REPOSITORY_ROOT, "packages/node/src", `${specifier.split("/").at(-1)}.ts`),
					])
				: []),
		])
	);
	const bundled = await build({
		alias: aliases,
		bundle: true,
		format: "esm",
		platform: "browser",
		nodePaths: [resolve(REPOSITORY_ROOT, "packages/storage-browser/node_modules")],
		plugins: [
			...plugins,
			{
				name: "product-raw-source",
				setup(context): void {
					context.onResolve({ filter: /\?raw$/ }, ({ path, resolveDir }) => ({
						path: resolve(resolveDir, path.slice(0, -4)),
						namespace: "product-raw-source",
					}));
					context.onLoad({ filter: /.*/, namespace: "product-raw-source" }, ({ path }) => ({
						contents: readFileSync(path, "utf8"),
						loader: "text",
					}));
				},
			},
		],
		stdin: {
			contents: `
import { createV3ChatApplication } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "examples/v3-chat/src/index.ts"))};
import { createV3ZoneApplication } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "examples/grid/src/v3-zone.ts"))};
import { createV3RoomCreatorInviteMaterial, createV3RoomSession } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "examples/v3-room/src/index.ts"))};
import { bindV3BlueprintLivePlane } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts"))};
import { Keychain } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "packages/keychain/src/index.ts"))};
import { createRecoverableFinalitySigner } from ${JSON.stringify(resolve(REPOSITORY_ROOT, "packages/keychain/src/finality.ts"))};
import ${JSON.stringify(entryPoint)};
Object.defineProperty(globalThis, "__d108e3DirectRoomDependencies", {
  configurable: false,
  value: Object.freeze({
    bindV3BlueprintLivePlane,
    createRecoverableFinalitySigner,
    createV3ChatApplication,
    createV3ZoneApplication,
    createV3RoomCreatorInviteMaterial,
    createV3RoomSession,
    Keychain,
  }),
  writable: false,
});`,
			loader: "js",
			resolveDir: REPOSITORY_ROOT,
		},
		write: false,
	});
	const entry = bundled.outputFiles[0]?.text;
	if (entry === undefined) throw new TypeError("D.108d2 browser bundle is absent");
	const server: Server = createServer((request, response) => {
		const headers = {
			"cross-origin-embedder-policy": "require-corp",
			"cross-origin-opener-policy": "same-origin",
		};
		if (request.url === "/entry.js") {
			response.writeHead(200, { ...headers, "cache-control": "no-store", "content-type": "text/javascript" });
			response.end(entry);
			return;
		}
		if (request.url === "/" || request.url === "/index.html") {
			response.writeHead(200, { ...headers, "cache-control": "no-store", "content-type": "text/html" });
			response.end("<!doctype html><meta charset=utf-8><script type=module src=/entry.js></script>");
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new TypeError("D.108d2 browser server did not bind");
	return Object.freeze({
		origin: `http://127.0.0.1:${address.port}`,
		bundleSha256: createHash("sha256").update(entry).digest("hex"),
		close: async (): Promise<void> =>
			new Promise<void>((resolvePromise, reject) =>
				server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
			),
	});
}

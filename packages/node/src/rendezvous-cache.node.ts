import type { PeerCacheStore } from "@ts-drp/rendezvous";

/** Node-only cache adapter factory, loaded only for explicit node-fs persistence. */
export async function createFsPeerCacheStore(path: string): Promise<PeerCacheStore> {
	const packageSubpath = ["@ts-drp/rendezvous", "node"].join("/");
	let loaded: { readonly FsPeerCacheStore: new (options: { readonly path: string }) => PeerCacheStore };
	try {
		loaded = (await import(/* @vite-ignore */ packageSubpath)) as typeof loaded;
	} catch (error) {
		if (!isMissingSubpath(error)) throw error;
		// Source-tree fallback for test runners whose exact-package alias does not map exported subpaths.
		const sourceSubpath = "../../rendezvous/src/node.js";
		loaded = (await import(/* @vite-ignore */ sourceSubpath)) as typeof loaded;
	}
	return new loaded.FsPeerCacheStore({ path });
}

function isMissingSubpath(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		/Cannot find module|does not provide an export|Package subpath/iu.test(error.message) ||
		("code" in error && (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"))
	);
}

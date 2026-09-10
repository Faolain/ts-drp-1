import type * as Owner from "./browser-owner.js";
import { installNativeHooks, type NativeBoundary, type NativeSentinel } from "./hooks.js";

declare global {
	interface Window {
		runNativeProvenance(boundary: NativeBoundary, sentinel: NativeSentinel, mode?: string): Promise<unknown>;
	}
}
window.runNativeProvenance = async (boundary, sentinel, mode): Promise<unknown> => {
	const hooks = installNativeHooks(boundary, sentinel);
	try {
		const url = "/owner.js";
		const owner = (await import(url)) as typeof Owner;
		return await owner.run("native-provenance-" + crypto.randomUUID(), hooks, mode);
	} finally {
		hooks.restore();
	}
};

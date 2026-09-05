// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- TS6059/TS6307 report a deliberate esbuild boundary.
// @ts-ignore -- The browser bundle intentionally composes the example outside this package's TypeScript root.
import "../../../../examples/v3-chat/src/index.js";

Object.defineProperty(globalThis, "phase5eCreatorLiveClose", {
	configurable: false,
	enumerable: true,
	value: Reflect.get(globalThis, "d9336V3Chat"),
	writable: false,
});

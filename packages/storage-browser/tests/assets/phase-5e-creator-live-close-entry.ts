// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- TS6059/TS6307 report a deliberate esbuild boundary.
// @ts-ignore -- The browser bundle intentionally composes the example outside this package's TypeScript root.
import "../../../../examples/v3-chat/src/index.js";

// This harness seals by hand, so it opens the product room without the demo's automatic rollover
// and successor delivery (v3-chat's test override, read when a room opens).
Reflect.set(globalThis, "__TS_DRP_V3_CHAT_ROLLOVER__", "manual");

Object.defineProperty(globalThis, "phase5eCreatorLiveClose", {
	configurable: false,
	enumerable: true,
	value: Reflect.get(globalThis, "d9336V3Chat"),
	writable: false,
});

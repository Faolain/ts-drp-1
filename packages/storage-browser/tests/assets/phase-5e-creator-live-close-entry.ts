import "../../../../examples/v3-chat/src/index.js";

declare global {
	interface Window {
		readonly phase5eCreatorLiveClose: unknown;
	}
}

Object.defineProperty(globalThis, "phase5eCreatorLiveClose", {
	configurable: false,
	enumerable: true,
	value: Reflect.get(globalThis, "d9336V3Chat"),
	writable: false,
});

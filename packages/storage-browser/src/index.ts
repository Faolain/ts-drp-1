/* eslint-disable @typescript-eslint/method-signature-style -- mirrors the neutral function-valued port */
export {
	type BrowserAheDurableStore,
	type BrowserAheDurableStoreOptions,
	createBrowserAheDurableStore,
} from "./internal/idb-adapter.js";

type BrowserStorageCapacityPort = Readonly<{
	persisted?: () => unknown;
	persist?: () => unknown;
	estimate?: () => unknown;
}>;

/**
 * Creates the same-realm browser capacity port without requesting persistence.
 * @returns Safe receiver-preserving wrappers around the available storage manager methods.
 */
export function createBrowserStorageCapacityPort(): BrowserStorageCapacityPort {
	const storage = globalThis.navigator?.storage;
	if (storage === undefined) return Object.freeze({});

	const port: { -readonly [Key in keyof BrowserStorageCapacityPort]: BrowserStorageCapacityPort[Key] } = {};
	const persisted = storage.persisted;
	const persist = storage.persist;
	const estimate = storage.estimate;
	if (typeof persisted === "function") port.persisted = (): unknown => Reflect.apply(persisted, storage, []);
	if (typeof persist === "function") port.persist = (): unknown => Reflect.apply(persist, storage, []);
	if (typeof estimate === "function") port.estimate = (): unknown => Reflect.apply(estimate, storage, []);
	return Object.freeze(port);
}

/* eslint-disable jsdoc/require-jsdoc -- bounded tests-only RED scaffold */
export type BrowserTestCapacityPort = Readonly<{
	persisted?(): unknown;
	persist?(): unknown;
	estimate?(): unknown;
}>;

type StorageLike = Readonly<{
	persisted?: unknown;
	persist?: unknown;
	estimate?: unknown;
}>;

export type BrowserCapacityFactory = () => BrowserTestCapacityPort;

export function testOnlyCreateBrowserStorageCapacityPort(): BrowserTestCapacityPort {
	const navigatorValue = Reflect.get(globalThis, "navigator") as { readonly storage?: StorageLike } | undefined;
	const storage = navigatorValue?.storage;
	if (storage === undefined) return Object.freeze({});
	const port: {
		persisted?(): unknown;
		persist?(): unknown;
		estimate?(): unknown;
	} = {};
	const persisted = storage.persisted;
	const persist = storage.persist;
	const estimate = storage.estimate;
	if (typeof persisted === "function") port.persisted = (): unknown => Reflect.apply(persisted, storage, []);
	if (typeof persist === "function") port.persist = (): unknown => Reflect.apply(persist, storage, []);
	if (typeof estimate === "function") port.estimate = (): unknown => Reflect.apply(estimate, storage, []);
	return Object.freeze(port);
}

export function selectBrowserCapacityFactory(module: Record<string, unknown>): BrowserCapacityFactory {
	const candidate = module.createBrowserStorageCapacityPort;
	return typeof candidate === "function"
		? (candidate as BrowserCapacityFactory)
		: testOnlyCreateBrowserStorageCapacityPort;
}

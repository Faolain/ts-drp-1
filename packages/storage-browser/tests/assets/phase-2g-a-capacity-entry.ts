import { selectBrowserCapacityFactory } from "../fixtures/phase-2g-a-browser-capacity-scaffold.js";
import { selectInspectionApi } from "../fixtures/phase-2g-a-inspection-scaffold.js";

type StorageManagerLike = Readonly<Record<string, unknown>>;

function isOwnClosedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return false;
	return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validClosedReport(value: unknown): boolean {
	if (!isOwnClosedRecord(value, ["persistence", "quota"])) return false;
	const persistence = value.persistence;
	const quota = value.quota;
	if (typeof persistence !== "object" || persistence === null || !Object.isFrozen(persistence)) return false;
	if (typeof quota !== "object" || quota === null || !Object.isFrozen(quota)) return false;
	if (!isOwnClosedRecord(persistence, ["status"]) && !isOwnClosedRecord(persistence, ["status", "reason"]))
		return false;
	if (
		!isOwnClosedRecord(quota, ["status", "reason"]) &&
		!isOwnClosedRecord(quota, ["status", "usageBytes", "quotaBytes", "availableBytes"])
	)
		return false;
	const persistenceStatus = persistence.status;
	if (!["unsupported", "granted", "not-granted", "unavailable"].includes(String(persistenceStatus))) return false;
	if (persistenceStatus === "unavailable" && !["exception", "invalid-response"].includes(String(persistence.reason)))
		return false;
	if (quota.status === "available") {
		return (
			Number.isSafeInteger(quota.usageBytes) &&
			Number.isSafeInteger(quota.quotaBytes) &&
			Number.isSafeInteger(quota.availableBytes) &&
			(quota.usageBytes as number) >= 0 &&
			(quota.quotaBytes as number) >= (quota.usageBytes as number) &&
			quota.availableBytes === (quota.quotaBytes as number) - (quota.usageBytes as number)
		);
	}
	return (
		quota.status === "unavailable" &&
		["unsupported", "exception", "incomplete", "unsafe", "inconsistent"].includes(String(quota.reason))
	);
}

function installPersistTrap(): Readonly<{
	callCount(): number;
	restore(): void;
	trapReady: boolean;
}> {
	const manager = Reflect.get(navigator, "storage") as unknown as StorageManagerLike | undefined;
	if (manager === undefined) return Object.freeze({ callCount: () => 0, restore: () => undefined, trapReady: true });
	let calls = 0;
	const target = manager as object;
	const ownDescriptor = Object.getOwnPropertyDescriptor(target, "persist");
	try {
		Object.defineProperty(target, "persist", {
			configurable: true,
			enumerable: ownDescriptor?.enumerable ?? false,
			value: () => {
				calls += 1;
				return Promise.resolve(false);
			},
			writable: true,
		});
		return Object.freeze({
			callCount: () => calls,
			restore: () => {
				if (ownDescriptor === undefined) Reflect.deleteProperty(target, "persist");
				else Object.defineProperty(target, "persist", ownDescriptor);
			},
			trapReady: true,
		});
	} catch {
		return Object.freeze({ callCount: () => calls, restore: () => undefined, trapReady: false });
	}
}

async function runCapacitySmoke(): Promise<unknown> {
	const trap = installPersistTrap();
	const databaseName = `phase-2g-a-${crypto.randomUUID()}`;
	try {
		const [storage, browser] = await Promise.all([import("@ts-drp/storage"), import("@ts-drp/storage-browser")]);
		const storageModule = storage as unknown as Record<string, unknown>;
		const browserModule = browser as unknown as Record<string, unknown>;
		const api = selectInspectionApi(storageModule);
		const factory = selectBrowserCapacityFactory(browserModule);
		const port = factory();
		const storeFactory = browserModule.createBrowserAheDurableStore as (
			input: Readonly<{ databaseName: string }>
		) => Promise<{ close(): Promise<void> }>;
		const store = await storeFactory({ databaseName });
		await store.close();
		const report = await api.inspectStorageCapability(port);
		const portKeys = Object.keys(port).sort();
		const portKeysValid =
			portKeys.every((key) => ["estimate", "persist", "persisted"].includes(key)) &&
			portKeys.every((key) => typeof Reflect.get(port, key) === "function");
		return Object.freeze({
			factoryArity: factory.length,
			persistCalls: trap.callCount(),
			portKeys,
			portKeysValid,
			publicKeys: Object.keys(browserModule).sort(),
			realFactory: typeof browserModule.createBrowserStorageCapacityPort === "function",
			report,
			reportValidAndFrozen: validClosedReport(report),
			storeOpened: true,
			trapReady: trap.trapReady,
		});
	} finally {
		trap.restore();
	}
}

Reflect.set(globalThis, "phase2gACapacitySmoke", Object.freeze({ run: runCapacitySmoke }));

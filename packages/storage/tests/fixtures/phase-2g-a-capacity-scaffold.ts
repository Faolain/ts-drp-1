/* eslint-disable jsdoc/require-jsdoc -- bounded tests-only RED scaffold */
export type TestStorageCapacityPort = Readonly<{
	persisted?(): unknown;
	persist?(): unknown;
	estimate?(): unknown;
}>;

export type TestPersistenceObservation =
	| Readonly<{ status: "unsupported" }>
	| Readonly<{ status: "granted" }>
	| Readonly<{ status: "not-granted" }>
	| Readonly<{ status: "unavailable"; reason: "exception" | "invalid-response" }>;

export type TestQuotaObservation =
	| Readonly<{
			status: "available";
			usageBytes: number;
			quotaBytes: number;
			availableBytes: number;
	  }>
	| Readonly<{
			status: "unavailable";
			reason: "unsupported" | "exception" | "incomplete" | "unsafe" | "inconsistent";
	  }>;

export type TestStorageCapabilityReport = Readonly<{
	persistence: TestPersistenceObservation;
	quota: TestQuotaObservation;
}>;

export type TestPersistenceRequestResult =
	| Readonly<{ status: "already-granted" | "granted" | "denied" | "unsupported" }>
	| Readonly<{ status: "unavailable"; reason: "exception" | "invalid-response" }>;

export type TestCapacityApi = Readonly<{
	inspectStorageCapability(port: TestStorageCapacityPort): Promise<TestStorageCapabilityReport>;
	requestPersistentStorage(port: TestStorageCapacityPort): Promise<TestPersistenceRequestResult>;
}>;

function frozen<const T extends object>(value: T): Readonly<T> {
	return Object.freeze(value);
}

async function observePersistence(port: TestStorageCapacityPort): Promise<TestPersistenceObservation> {
	if (typeof port.persisted !== "function") return frozen({ status: "unsupported" });
	try {
		const result = await port.persisted();
		if (typeof result !== "boolean") return frozen({ reason: "invalid-response", status: "unavailable" });
		return frozen({ status: result ? "granted" : "not-granted" });
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
}

async function observeQuota(port: TestStorageCapacityPort): Promise<TestQuotaObservation> {
	if (typeof port.estimate !== "function") return frozen({ reason: "unsupported", status: "unavailable" });
	let result: unknown;
	try {
		result = await port.estimate();
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
	if (typeof result !== "object" || result === null || Array.isArray(result))
		return frozen({ reason: "incomplete", status: "unavailable" });
	if (!Object.hasOwn(result, "usage") || !Object.hasOwn(result, "quota"))
		return frozen({ reason: "incomplete", status: "unavailable" });
	let usage: unknown;
	let quota: unknown;
	try {
		usage = Reflect.get(result, "usage");
		quota = Reflect.get(result, "quota");
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
	if (
		typeof usage !== "number" ||
		typeof quota !== "number" ||
		!Number.isSafeInteger(usage) ||
		!Number.isSafeInteger(quota) ||
		usage < 0 ||
		quota < 0
	)
		return frozen({ reason: "unsafe", status: "unavailable" });
	if (usage > quota) return frozen({ reason: "inconsistent", status: "unavailable" });
	return frozen({
		availableBytes: quota - usage,
		quotaBytes: quota,
		status: "available",
		usageBytes: usage,
	});
}

async function inspectStorageCapability(port: TestStorageCapacityPort): Promise<TestStorageCapabilityReport> {
	const persistence = await observePersistence(port);
	const quota = await observeQuota(port);
	return frozen({ persistence, quota });
}

async function requestPersistentStorage(port: TestStorageCapacityPort): Promise<TestPersistenceRequestResult> {
	if (typeof port.persisted === "function") {
		let observed: unknown;
		try {
			observed = await port.persisted();
		} catch {
			return frozen({ reason: "exception", status: "unavailable" });
		}
		if (typeof observed !== "boolean") return frozen({ reason: "invalid-response", status: "unavailable" });
		if (observed) return frozen({ status: "already-granted" });
	}
	if (typeof port.persist !== "function") return frozen({ status: "unsupported" });
	try {
		const requested = await port.persist();
		if (typeof requested !== "boolean") return frozen({ reason: "invalid-response", status: "unavailable" });
		return frozen({ status: requested ? "granted" : "denied" });
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
}

export const TEST_ONLY_PHASE_2G_A_REFERENCE_API: TestCapacityApi = Object.freeze({
	inspectStorageCapability,
	requestPersistentStorage,
});

export function selectCapacityApi(module: Record<string, unknown>): TestCapacityApi {
	const inspect = module.inspectStorageCapability;
	const request = module.requestPersistentStorage;
	if (typeof inspect !== "function" || typeof request !== "function") return TEST_ONLY_PHASE_2G_A_REFERENCE_API;
	return Object.freeze({
		inspectStorageCapability: inspect as TestCapacityApi["inspectStorageCapability"],
		requestPersistentStorage: request as TestCapacityApi["requestPersistentStorage"],
	});
}

/* eslint-disable @typescript-eslint/method-signature-style -- the ratified public port uses function-valued properties */
export type StorageCapacityPort = Readonly<{
	persisted?: () => unknown;
	persist?: () => unknown;
	estimate?: () => unknown;
}>;

export type PersistenceObservation =
	| Readonly<{ status: "unsupported" }>
	| Readonly<{ status: "granted" }>
	| Readonly<{ status: "not-granted" }>
	| Readonly<{ status: "unavailable"; reason: "exception" | "invalid-response" }>;

export type QuotaObservation =
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

export type StorageCapabilityReport = Readonly<{
	persistence: PersistenceObservation;
	quota: QuotaObservation;
}>;

export type PersistenceRequestResult =
	| Readonly<{ status: "already-granted" | "granted" | "denied" | "unsupported" }>
	| Readonly<{ status: "unavailable"; reason: "exception" | "invalid-response" }>;

function frozen<const T extends object>(value: T): Readonly<T> {
	return Object.freeze(value);
}

async function observePersistence(port: StorageCapacityPort): Promise<PersistenceObservation> {
	let persisted: unknown;
	try {
		persisted = port.persisted;
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
	if (typeof persisted !== "function") return frozen({ status: "unsupported" });

	try {
		const result: unknown = await Reflect.apply(persisted, port, []);
		if (typeof result !== "boolean") return frozen({ reason: "invalid-response", status: "unavailable" });
		return frozen({ status: result ? "granted" : "not-granted" });
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
}

async function observeQuota(port: StorageCapacityPort): Promise<QuotaObservation> {
	let estimate: unknown;
	try {
		estimate = port.estimate;
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
	if (typeof estimate !== "function") return frozen({ reason: "unsupported", status: "unavailable" });

	let result: unknown;
	try {
		result = await Reflect.apply(estimate, port, []);
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		return frozen({ reason: "incomplete", status: "unavailable" });
	}

	let usage: unknown;
	let quota: unknown;
	try {
		if (!Object.hasOwn(result, "usage") || !Object.hasOwn(result, "quota")) {
			return frozen({ reason: "incomplete", status: "unavailable" });
		}
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
	) {
		return frozen({ reason: "unsafe", status: "unavailable" });
	}
	if (usage > quota) return frozen({ reason: "inconsistent", status: "unavailable" });
	return frozen({
		availableBytes: quota - usage,
		quotaBytes: quota,
		status: "available",
		usageBytes: usage,
	});
}

/**
 * Inspects persistence and quota independently without requesting persistence.
 * @param port - Neutral host capacity operations.
 * @returns Detached persistence and quota observations.
 */
export async function inspectStorageCapability(port: StorageCapacityPort): Promise<StorageCapabilityReport> {
	const persistence = await observePersistence(port);
	const quota = await observeQuota(port);
	return frozen({ persistence, quota });
}

/**
 * Requests persistence explicitly after first observing the current grant.
 * @param port - Neutral host capacity operations.
 * @returns The contained persistence-request outcome.
 */
export async function requestPersistentStorage(port: StorageCapacityPort): Promise<PersistenceRequestResult> {
	let persisted: unknown;
	try {
		persisted = port.persisted;
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
	if (typeof persisted === "function") {
		let observed: unknown;
		try {
			observed = await Reflect.apply(persisted, port, []);
		} catch {
			return frozen({ reason: "exception", status: "unavailable" });
		}
		if (typeof observed !== "boolean") return frozen({ reason: "invalid-response", status: "unavailable" });
		if (observed) return frozen({ status: "already-granted" });
	}

	let persist: unknown;
	try {
		persist = port.persist;
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
	if (typeof persist !== "function") return frozen({ status: "unsupported" });

	try {
		const requested: unknown = await Reflect.apply(persist, port, []);
		if (typeof requested !== "boolean") return frozen({ reason: "invalid-response", status: "unavailable" });
		return frozen({ status: requested ? "granted" : "denied" });
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
}

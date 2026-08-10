/* eslint-disable jsdoc/require-jsdoc -- bounded tests-only browser observation scaffold */
import type { BrowserTestCapacityPort } from "./phase-2g-a-browser-capacity-scaffold.js";

type ObservationApi = Readonly<{
	inspectStorageCapability(port: BrowserTestCapacityPort): Promise<Readonly<Record<string, unknown>>>;
}>;

function unavailable(reason: string): Readonly<{ reason: string; status: "unavailable" }> {
	return Object.freeze({ reason, status: "unavailable" });
}

async function persisted(port: BrowserTestCapacityPort): Promise<Readonly<Record<string, unknown>>> {
	if (typeof port.persisted !== "function") return Object.freeze({ status: "unsupported" });
	try {
		const value = await port.persisted();
		if (typeof value !== "boolean") return unavailable("invalid-response");
		return Object.freeze({ status: value ? "granted" : "not-granted" });
	} catch {
		return unavailable("exception");
	}
}

async function quota(port: BrowserTestCapacityPort): Promise<Readonly<Record<string, unknown>>> {
	if (typeof port.estimate !== "function") return unavailable("unsupported");
	let value: unknown;
	try {
		value = await port.estimate();
	} catch {
		return unavailable("exception");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return unavailable("incomplete");
	if (!Object.hasOwn(value, "usage") || !Object.hasOwn(value, "quota")) return unavailable("incomplete");
	const usage = Reflect.get(value, "usage");
	const maximum = Reflect.get(value, "quota");
	if (
		typeof usage !== "number" ||
		typeof maximum !== "number" ||
		!Number.isSafeInteger(usage) ||
		!Number.isSafeInteger(maximum) ||
		usage < 0 ||
		maximum < 0
	)
		return unavailable("unsafe");
	if (usage > maximum) return unavailable("inconsistent");
	return Object.freeze({
		availableBytes: maximum - usage,
		quotaBytes: maximum,
		status: "available",
		usageBytes: usage,
	});
}

const FALLBACK: ObservationApi = Object.freeze({
	inspectStorageCapability: async (port) =>
		Object.freeze({ persistence: await persisted(port), quota: await quota(port) }),
});

export function selectInspectionApi(module: Record<string, unknown>): ObservationApi {
	const candidate = module.inspectStorageCapability;
	return typeof candidate === "function"
		? Object.freeze({
				inspectStorageCapability: candidate as ObservationApi["inspectStorageCapability"],
			})
		: FALLBACK;
}

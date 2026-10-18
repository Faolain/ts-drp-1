import {
	NATIVE_BOUNDARIES,
	NATIVE_SENTINELS,
	type NativeBoundary,
	type NativeEvent,
	type NativeSentinel,
} from "./hooks.js";

export interface NativeCase {
	label: string;
	boundary: NativeBoundary;
	sentinel: NativeSentinel;
	mode: string;
	expected: string;
}
export interface NativeObservation {
	controls: Record<string, boolean>;
	events: NativeEvent[];
	injections: number;
	observed: { code: string | null; sentinelRetained?: boolean; causes: unknown[] };
	guard?: { parseCalls: number };
	[field: string]: unknown;
}

/**
 * Explicit native provenance and deterministic metadata case roster.
 * @param backend - Genuine native backend to exercise.
 * @returns Independently asserted native cases.
 */
export function nativeCases(backend: "sqlite" | "indexeddb"): NativeCase[] {
	const boundaries: NativeBoundary[] = [
		...NATIVE_BOUNDARIES,
		...(backend === "sqlite" ? ["sqlite-json" as const] : []),
	];
	const result: NativeCase[] = boundaries.flatMap((boundary) =>
		NATIVE_SENTINELS.map((sentinel) => ({
			label: `${boundary}:${sentinel}`,
			boundary,
			sentinel,
			mode: "fault",
			expected: "storage-failed",
		}))
	);
	for (const sentinel of NATIVE_SENTINELS)
		result.push({
			label: `historical:${sentinel}`,
			boundary: "canonical-decode",
			sentinel,
			mode: "historical",
			expected: "poisoned",
		});
	for (const name of [
		"carrier",
		"utf8",
		"unsafe-total",
		"digest",
		"binding",
		"incarnation-byte-bound",
		...(backend === "sqlite" ? ["json-syntax", "json-whitespace", "json-reordered", "json-nonstring"] : []),
	])
		result.push({
			label: `data:${name}`,
			boundary: name.startsWith("json-") ? "sqlite-json" : "canonical-decode",
			sentinel: "range-error",
			mode: `data:${name}`,
			expected: ["json-whitespace", "json-reordered"].includes(name) ? "present" : "poisoned",
		});
	if (backend === "sqlite")
		result.push({
			label: "json-js-primitive-guard",
			boundary: "sqlite-json",
			sentinel: "range-error",
			mode: "js-guard",
			expected: "poisoned",
		});
	return result;
}

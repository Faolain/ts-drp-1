import type { WorkerFailureCode } from "../../src/internal/instrumented-idb.js";
import { KILL_POINT_MANIFEST, type KillHit, type KillPoint } from "../../src/killpoints.js";

export type WorkerRunMessage = {
	readonly kind: "run";
	readonly version: 1;
	readonly databaseName: string;
	readonly objectId: string;
	readonly armed: KillPoint | null;
	readonly signal: SharedArrayBuffer;
};

export type WorkerToPageMessage =
	| { readonly kind: "ready"; readonly version: 1 }
	| ({ readonly kind: "hit"; readonly version: 1 } & KillHit)
	| {
			readonly kind: "complete";
			readonly version: 1;
			readonly observed: readonly KillHit[];
			readonly transactionDurability: "strict";
	  }
	| {
			readonly kind: "failure";
			readonly version: 1;
			readonly code: WorkerFailureCode;
			readonly detail: string;
	  };

export type BrowserSmokeChildMessage =
	| { readonly kind: "smoke-result"; readonly version: 1; readonly result: WorkerToPageMessage }
	| { readonly kind: "smoke-error"; readonly version: 1; readonly detail: string };

const FAILURE_CODES: ReadonlySet<WorkerFailureCode> = new Set([
	"UNSUPPORTED_CAPABILITY",
	"INVALID_RUN_MESSAGE",
	"INVALID_OBJECT_ID",
	"UNEXPECTED_UPGRADE",
	"DURABILITY_NOT_STRICT",
	"PREFLIGHT_MISMATCH",
	"REQUEST_ERROR",
	"TRANSACTION_ABORT",
	"ARM_STATE_ERROR",
	"MANIFEST_MISMATCH",
	"DRIVER_NOT_IMPLEMENTED",
]);

function closedDataRecord(value: object, keys: readonly string[]): boolean {
	if (Object.getOwnPropertySymbols(value).length !== 0) return false;
	const actual = Object.getOwnPropertyNames(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]) &&
		actual.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
		})
	);
}

function closedArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
	const expected = [...value.keys()].map(String).concat("length").sort();
	const actual = Object.getOwnPropertyNames(value).sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return undefined;
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
	}
	return value;
}

function parseKillPoint(value: unknown): KillPoint | null | undefined {
	if (value === null) return null;
	if (typeof value !== "object" || value === null || !closedDataRecord(value, ["id", "edge"])) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.id !== "string" ||
		!Object.hasOwn(KILL_POINT_MANIFEST, candidate.id) ||
		(candidate.edge !== "before" && candidate.edge !== "after")
	) {
		return undefined;
	}
	return Object.freeze({ id: candidate.id as KillPoint["id"], edge: candidate.edge });
}

function parseKillHit(value: unknown): KillHit | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		!closedDataRecord(value, ["id", "edge", "transactionDurability"])
	) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const point = parseKillPoint({ id: candidate.id, edge: candidate.edge });
	if (
		point === null ||
		point === undefined ||
		(candidate.transactionDurability !== "not-reached" && candidate.transactionDurability !== "strict")
	) {
		return undefined;
	}
	return Object.freeze({ ...point, transactionDurability: candidate.transactionDurability });
}

/**
 * Parses the exact page-to-Worker run message.
 * @param value - Untrusted structured-clone value.
 * @returns A closed run message, or undefined.
 */
export function parseWorkerRunMessage(value: unknown): WorkerRunMessage | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		!closedDataRecord(value, ["kind", "version", "databaseName", "objectId", "armed", "signal"])
	) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const armed = parseKillPoint(candidate.armed);
	if (
		candidate.kind !== "run" ||
		candidate.version !== 1 ||
		typeof candidate.databaseName !== "string" ||
		candidate.databaseName.length === 0 ||
		candidate.databaseName.length > 128 ||
		typeof candidate.objectId !== "string" ||
		armed === undefined ||
		typeof SharedArrayBuffer === "undefined" ||
		!(candidate.signal instanceof SharedArrayBuffer) ||
		candidate.signal.byteLength !== 4
	) {
		return undefined;
	}
	return Object.freeze({
		kind: "run",
		version: 1,
		databaseName: candidate.databaseName,
		objectId: candidate.objectId,
		armed,
		signal: candidate.signal,
	});
}

/**
 * Parses every exact Worker-to-page message variant without repairing provenance.
 * @param value - Untrusted Worker message.
 * @returns A fresh closed message, or undefined.
 */
export function parseWorkerToPageMessage(value: unknown): WorkerToPageMessage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
	if (kindDescriptor === undefined || !("value" in kindDescriptor) || !kindDescriptor.enumerable) return undefined;
	const kind = kindDescriptor.value;
	if (kind === "ready") {
		if (!closedDataRecord(value, ["kind", "version"])) return undefined;
		const candidate = value as Record<string, unknown>;
		return candidate.version === 1 ? Object.freeze({ kind: "ready", version: 1 }) : undefined;
	}
	if (kind === "hit") {
		if (!closedDataRecord(value, ["kind", "version", "id", "edge", "transactionDurability"])) return undefined;
		const candidate = value as Record<string, unknown>;
		const hit = parseKillHit({
			id: candidate.id,
			edge: candidate.edge,
			transactionDurability: candidate.transactionDurability,
		});
		return candidate.version === 1 && hit !== undefined
			? Object.freeze({ kind: "hit", version: 1, ...hit })
			: undefined;
	}
	if (kind === "complete") {
		if (!closedDataRecord(value, ["kind", "version", "observed", "transactionDurability"])) return undefined;
		const candidate = value as Record<string, unknown>;
		const observedValues = closedArray(candidate.observed);
		if (candidate.version !== 1 || candidate.transactionDurability !== "strict" || observedValues === undefined) {
			return undefined;
		}
		const observed = observedValues.map(parseKillHit);
		if (observed.some((hit) => hit === undefined)) return undefined;
		return Object.freeze({
			kind: "complete",
			version: 1,
			observed: Object.freeze(observed as KillHit[]),
			transactionDurability: "strict",
		});
	}
	if (kind === "failure") {
		if (!closedDataRecord(value, ["kind", "version", "code", "detail"])) return undefined;
		const candidate = value as Record<string, unknown>;
		const detail = boundedDetail(candidate.detail);
		if (candidate.version !== 1 || !isWorkerFailureCode(candidate.code) || detail === undefined) return undefined;
		return Object.freeze({ kind: "failure", version: 1, code: candidate.code, detail });
	}
	return undefined;
}

/**
 * Parses the closed child IPC relay around a validated Worker message.
 * @param value - Untrusted child IPC value.
 * @returns A fresh closed child message, or undefined.
 */
export function parseBrowserSmokeChildMessage(value: unknown): BrowserSmokeChildMessage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
	if (kindDescriptor === undefined || !("value" in kindDescriptor) || !kindDescriptor.enumerable) return undefined;
	const candidate = value as Record<string, unknown>;
	if (kindDescriptor.value === "smoke-result") {
		if (!closedDataRecord(value, ["kind", "version", "result"]) || candidate.version !== 1) return undefined;
		const result = parseWorkerToPageMessage(candidate.result);
		return result === undefined ? undefined : Object.freeze({ kind: "smoke-result", version: 1, result });
	}
	if (kindDescriptor.value === "smoke-error") {
		if (!closedDataRecord(value, ["kind", "version", "detail"]) || candidate.version !== 1) return undefined;
		const detail = boundedDetail(candidate.detail);
		return detail === undefined ? undefined : Object.freeze({ kind: "smoke-error", version: 1, detail });
	}
	return undefined;
}

/**
 * Checks the closed Worker failure taxonomy.
 * @param value - Untrusted failure code.
 * @returns Whether the code is known.
 */
export function isWorkerFailureCode(value: unknown): value is WorkerFailureCode {
	return typeof value === "string" && FAILURE_CODES.has(value as WorkerFailureCode);
}

/**
 * Accepts a non-empty bounded protocol detail.
 * @param value - Untrusted detail value.
 * @returns The detail or undefined.
 */
export function boundedDetail(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

/**
 * Maps unrecognized Worker codes to the sole closed parent code.
 * @param value - Untrusted Worker failure code.
 * @returns The known code or UNKNOWN_FAILURE_CODE.
 */
export function parentFailureCodeForWorker(value: unknown): WorkerFailureCode | "UNKNOWN_FAILURE_CODE" {
	return isWorkerFailureCode(value) ? value : "UNKNOWN_FAILURE_CODE";
}

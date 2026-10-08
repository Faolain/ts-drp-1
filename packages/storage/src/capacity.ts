import { encodeGenerationRecordV1 } from "./codecs.js";
import {
	compareCanonicalText,
	copyExpectedHead,
	copyGenerationRef,
	isClosedArray,
	isClosedRecord,
	isGenerationId,
	isStorageObjectId,
} from "./internal/validation.js";
import type {
	AheDurableStore,
	BlobDigest,
	GenerationRecord,
	GenerationRef,
	ParseResult,
	StoreResult,
} from "./types.js";
import { digestClosure } from "./values.js";

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

export type CapacityProfile = Readonly<{
	maxClosureReferences: number;
	maxStageCostBytes: number;
	reserveBytes: number;
}>;

export interface BlobExistencePort {
	probeBlobPresence(digests: readonly BlobDigest[]): Promise<StoreResult<readonly boolean[]>>;
}

export type StageCost = Readonly<{
	stagedGenerationRecordBytes: number;
	missingBlobBytes: number;
	totalBytes: number;
}>;

export type StageAdmission =
	| Readonly<{
			admitted: true;
			basis: "measured" | "bounded-unavailable-estimate";
			stageCostBytes: number;
			requiredBytes: number;
			availableBytes?: number;
	  }>
	| Readonly<{
			admitted: false;
			reason: "STAGE_COST_LIMIT_EXCEEDED" | "QUOTA_HEADROOM_INSUFFICIENT" | "ARITHMETIC_UNSAFE";
			stageCostBytes?: number;
			requiredBytes?: number;
			availableBytes?: number;
	  }>;

export type AdmittedBeginResult =
	| Readonly<{
			kind: "begun";
			admission: Extract<StageAdmission, { admitted: true }>;
			record: GenerationRecord;
	  }>
	| Readonly<{
			kind: "refused";
			admission: Extract<StageAdmission, { admitted: false }>;
	  }>
	| Readonly<{
			kind: "input-rejected";
			reason: "INVALID_ARGUMENT" | "SHARED_BUFFER_INPUT";
	  }>
	| Readonly<{
			kind: "store-rejected";
			phase: "presence" | "begin";
			result: Extract<StoreResult<never>, { ok: false }>;
	  }>;

type BeginInput = Parameters<AheDurableStore["beginGeneration"]>[0];

function frozen<const T extends object>(value: T): Readonly<T> {
	return Object.freeze(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkedAdd(left: number, right: number): number | undefined {
	const result = left + right;
	return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function copyBeginInput(value: unknown): BeginInput | undefined {
	if (!isClosedRecord(value, ["objectId", "generationId", "baseExpectedHead", "closure"])) return undefined;
	if (!isStorageObjectId(value.objectId) || !isGenerationId(value.generationId) || !isClosedArray(value.closure)) {
		return undefined;
	}
	const baseExpectedHead = copyExpectedHead(value.baseExpectedHead, value.objectId);
	if (baseExpectedHead === undefined) return undefined;
	const closure: GenerationRef[] = [];
	for (const reference of value.closure) {
		const copied = copyGenerationRef(reference);
		if (copied === undefined) return undefined;
		closure.push(frozen(copied));
	}
	return frozen({
		baseExpectedHead: frozen(baseExpectedHead),
		closure: frozen(closure),
		generationId: value.generationId,
		objectId: value.objectId,
	});
}

function refused(admission: Extract<StageAdmission, { admitted: false }>): AdmittedBeginResult {
	return frozen({ admission: frozen(admission), kind: "refused" });
}

function storeRejected(
	phase: "presence" | "begin",
	result: Extract<StoreResult<never>, { ok: false }>
): AdmittedBeginResult {
	return frozen({ kind: "store-rejected", phase, result });
}

async function delegateBegin(
	store: AheDurableStore,
	input: BeginInput,
	admission?: Extract<StageAdmission, { admitted: true }>
): Promise<AdmittedBeginResult> {
	const result = await store.beginGeneration(input);
	if (!result.ok) return storeRejected("begin", result);
	if (admission === undefined) throw new Error("semantically invalid closure was accepted by the durable store");
	return frozen({ admission: frozen(admission), kind: "begun", record: result.value });
}

function classifyQuotaEstimate(result: unknown): QuotaObservation {
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		return frozen({ reason: "incomplete", status: "unavailable" });
	}
	let quota: unknown;
	let usage: unknown;
	try {
		if (!Object.hasOwn(result, "usage") || !Object.hasOwn(result, "quota")) {
			return frozen({ reason: "incomplete", status: "unavailable" });
		}
		usage = Reflect.get(result, "usage");
		quota = Reflect.get(result, "quota");
	} catch {
		return frozen({ reason: "exception", status: "unavailable" });
	}
	if (!isNonNegativeSafeInteger(quota) || !isNonNegativeSafeInteger(usage)) {
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

async function availableBytes(port: StorageCapacityPort): Promise<number | undefined> {
	let estimate: unknown;
	try {
		estimate = port.estimate;
		if (typeof estimate !== "function") return undefined;
		const result: unknown = await Reflect.apply(estimate, port, []);
		const observation = classifyQuotaEstimate(result);
		return observation.status === "available" ? observation.availableBytes : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Parses an exact operational capacity profile without coercion or defaults.
 * @param value - Candidate host-owned configuration.
 * @returns A detached frozen profile or the stable parse rejection.
 */
export function parseCapacityProfile(value: unknown): ParseResult<CapacityProfile> {
	if (!isClosedRecord(value, ["maxClosureReferences", "maxStageCostBytes", "reserveBytes"])) {
		return frozen({ ok: false, reason: "INVALID_ARGUMENT" });
	}
	if (
		!isNonNegativeSafeInteger(value.maxClosureReferences) ||
		value.maxClosureReferences === 0 ||
		!isNonNegativeSafeInteger(value.maxStageCostBytes) ||
		value.maxStageCostBytes === 0 ||
		!isNonNegativeSafeInteger(value.reserveBytes) ||
		checkedAdd(value.maxStageCostBytes, value.reserveBytes) === undefined
	) {
		return frozen({ ok: false, reason: "INVALID_ARGUMENT" });
	}
	return frozen({
		ok: true,
		value: frozen({
			maxClosureReferences: value.maxClosureReferences,
			maxStageCostBytes: value.maxStageCostBytes,
			reserveBytes: value.reserveBytes,
		}),
	});
}

/**
 * Creates a profile-bounded advisory admission controller for staged generations.
 * @param input - Durable store, capacity observer and reviewed operational profile.
 * @returns The frozen single-operation controller.
 */
export function createStageAdmissionController(
	input: Readonly<{
		store: AheDurableStore & BlobExistencePort;
		capacity: StorageCapacityPort;
		profile: CapacityProfile;
	}>
): Readonly<{ beginAdmittedGeneration(input: BeginInput): Promise<AdmittedBeginResult> }> {
	const parsedProfile = parseCapacityProfile(input.profile);
	if (!parsedProfile.ok) throw new TypeError("invalid capacity profile");
	const profile = parsedProfile.value;
	const store = input.store;
	const capacity = input.capacity;

	return frozen({
		async beginAdmittedGeneration(value: BeginInput): Promise<AdmittedBeginResult> {
			const copied = copyBeginInput(value);
			if (copied === undefined) return frozen({ kind: "input-rejected", reason: "INVALID_ARGUMENT" });
			if (copied.closure.length > profile.maxClosureReferences) {
				return refused({ admitted: false, reason: "STAGE_COST_LIMIT_EXCEEDED" });
			}

			const sorted = frozen([...copied.closure].sort((left, right) => compareCanonicalText(left.digest, right.digest)));
			const duplicate = sorted.some((reference, index) => index > 0 && sorted[index - 1]?.digest === reference.digest);
			const detached = frozen({ ...copied, closure: sorted });
			if (sorted.length === 0 || duplicate) return delegateBegin(store, detached);

			const closureDigest = digestClosure(sorted);
			if (!closureDigest.ok) return frozen({ kind: "input-rejected", reason: closureDigest.reason });
			const stagedRecord: GenerationRecord = frozen({
				...detached,
				closureDigest: closureDigest.value,
				state: "Staged",
			});
			const stagedGenerationRecordBytes = encodeGenerationRecordV1(stagedRecord).byteLength;
			if (stagedGenerationRecordBytes > profile.maxStageCostBytes) {
				return refused({
					admitted: false,
					reason: "STAGE_COST_LIMIT_EXCEEDED",
					stageCostBytes: stagedGenerationRecordBytes,
				});
			}

			const digests = frozen(sorted.map((reference) => reference.digest));
			const presence = await store.probeBlobPresence(digests);
			if (!presence.ok) return storeRejected("presence", presence);
			let missingBlobBytes = 0;
			for (let index = 0; index < sorted.length; index++) {
				if (presence.value[index] === true) continue;
				const next = checkedAdd(missingBlobBytes, sorted[index]?.byteLength ?? 0);
				if (next === undefined) return refused({ admitted: false, reason: "ARITHMETIC_UNSAFE" });
				missingBlobBytes = next;
			}
			const stageCostBytes = checkedAdd(stagedGenerationRecordBytes, missingBlobBytes);
			if (stageCostBytes === undefined) return refused({ admitted: false, reason: "ARITHMETIC_UNSAFE" });
			if (stageCostBytes > profile.maxStageCostBytes) {
				return refused({ admitted: false, reason: "STAGE_COST_LIMIT_EXCEEDED", stageCostBytes });
			}
			const requiredBytes = checkedAdd(stageCostBytes, profile.reserveBytes);
			if (requiredBytes === undefined) {
				return refused({ admitted: false, reason: "ARITHMETIC_UNSAFE", stageCostBytes });
			}

			const observedAvailableBytes = await availableBytes(capacity);
			if (observedAvailableBytes !== undefined && observedAvailableBytes < requiredBytes) {
				return refused({
					admitted: false,
					availableBytes: observedAvailableBytes,
					reason: "QUOTA_HEADROOM_INSUFFICIENT",
					requiredBytes,
					stageCostBytes,
				});
			}
			const admission: Extract<StageAdmission, { admitted: true }> =
				observedAvailableBytes === undefined
					? {
							admitted: true,
							basis: "bounded-unavailable-estimate",
							requiredBytes,
							stageCostBytes,
						}
					: {
							admitted: true,
							availableBytes: observedAvailableBytes,
							basis: "measured",
							requiredBytes,
							stageCostBytes,
						};
			return delegateBegin(store, detached, admission);
		},
	});
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
	return classifyQuotaEstimate(result);
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

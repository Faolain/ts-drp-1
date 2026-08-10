import {
	type AheDurableStore,
	type BlobDigest,
	digestClosure,
	encodeGenerationRecordV1,
	type GenerationRecord,
	type GenerationRef,
	parseBlobDigest,
	parseClosureDigest,
	parseGenerationId,
	parseHeadRevision,
	type ParseResult,
	parseStorageObjectId,
	type StorageCapacityPort,
	type StoreResult,
} from "../../src/index.js";

export type TestCapacityProfile = Readonly<{
	maxClosureReferences: number;
	maxStageCostBytes: number;
	reserveBytes: number;
}>;

export type TestBlobExistencePort = Readonly<{
	probeBlobPresence(digests: readonly BlobDigest[]): Promise<StoreResult<readonly boolean[]>>;
}>;

export type TestStageAdmission =
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

export type TestAdmittedBeginResult =
	| Readonly<{
			kind: "begun";
			admission: Extract<TestStageAdmission, { admitted: true }>;
			record: GenerationRecord;
	  }>
	| Readonly<{
			kind: "refused";
			admission: Extract<TestStageAdmission, { admitted: false }>;
	  }>
	| Readonly<{ kind: "input-rejected"; reason: "INVALID_ARGUMENT" | "SHARED_BUFFER_INPUT" }>
	| Readonly<{
			kind: "store-rejected";
			phase: "presence" | "begin";
			result: Extract<StoreResult<never>, { ok: false }>;
	  }>;

type BeginInput = Parameters<AheDurableStore["beginGeneration"]>[0];

export type TestStageAdmissionController = Readonly<{
	beginAdmittedGeneration(input: BeginInput): Promise<TestAdmittedBeginResult>;
}>;

export type TestAdmissionApi = Readonly<{
	createStageAdmissionController(
		input: Readonly<{
			store: AheDurableStore & TestBlobExistencePort;
			capacity: StorageCapacityPort;
			profile: TestCapacityProfile;
		}>
	): TestStageAdmissionController;
	parseCapacityProfile(value: unknown): ParseResult<TestCapacityProfile>;
}>;

function isClosedDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
		return false;
	}
	return keys.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor !== undefined && "value" in descriptor && descriptor.value !== undefined;
	});
}

function isClosedArray(value: unknown): value is readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
	return value.every((_, index) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		return descriptor !== undefined && descriptor.enumerable && "value" in descriptor && descriptor.value !== undefined;
	});
}

function nonNegativeSafe(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafe(value: unknown): value is number {
	return nonNegativeSafe(value) && value > 0;
}

function checkedAdd(left: number, right: number): number | undefined {
	const result = left + right;
	return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function testOnlyParseCapacityProfile(value: unknown): ParseResult<TestCapacityProfile> {
	if (!isClosedDataRecord(value, ["maxClosureReferences", "maxStageCostBytes", "reserveBytes"])) {
		return { ok: false, reason: "INVALID_ARGUMENT" };
	}
	if (
		!positiveSafe(value.maxClosureReferences) ||
		!positiveSafe(value.maxStageCostBytes) ||
		!nonNegativeSafe(value.reserveBytes) ||
		checkedAdd(value.maxStageCostBytes, value.reserveBytes) === undefined
	) {
		return { ok: false, reason: "INVALID_ARGUMENT" };
	}
	return {
		ok: true,
		value: Object.freeze({
			maxClosureReferences: value.maxClosureReferences,
			maxStageCostBytes: value.maxStageCostBytes,
			reserveBytes: value.reserveBytes,
		}),
	};
}

function copyHead(value: unknown, objectId: string): BeginInput["baseExpectedHead"] | undefined {
	if (isClosedDataRecord(value, ["kind", "objectId"]) && value.kind === "none") {
		const parsed = typeof value.objectId === "string" ? parseStorageObjectId(value.objectId) : undefined;
		return parsed?.ok === true && parsed.value === objectId
			? Object.freeze({ kind: "none", objectId: parsed.value })
			: undefined;
	}
	if (
		isClosedDataRecord(value, ["kind", "objectId", "generationId", "revision", "closureDigest"]) &&
		value.kind === "present" &&
		typeof value.objectId === "string" &&
		typeof value.generationId === "string" &&
		typeof value.closureDigest === "string" &&
		typeof value.revision === "number"
	) {
		const object = parseStorageObjectId(value.objectId);
		const generation = parseGenerationId(value.generationId);
		const revision = parseHeadRevision(value.revision);
		const closure = parseClosureDigest(value.closureDigest);
		if (object.ok && object.value === objectId && generation.ok && revision.ok && closure.ok) {
			return Object.freeze({
				closureDigest: closure.value,
				generationId: generation.value,
				kind: "present",
				objectId: object.value,
				revision: revision.value,
			});
		}
	}
	return undefined;
}

function copyBeginInput(value: unknown): BeginInput | undefined {
	if (!isClosedDataRecord(value, ["objectId", "generationId", "baseExpectedHead", "closure"])) return undefined;
	if (typeof value.objectId !== "string" || typeof value.generationId !== "string") return undefined;
	const objectId = parseStorageObjectId(value.objectId);
	const generationId = parseGenerationId(value.generationId);
	if (!objectId.ok || !generationId.ok || !isClosedArray(value.closure)) return undefined;
	const baseExpectedHead = copyHead(value.baseExpectedHead, objectId.value);
	if (baseExpectedHead === undefined) return undefined;
	const closure: GenerationRef[] = [];
	for (const item of value.closure) {
		if (!isClosedDataRecord(item, ["digest", "byteLength"])) return undefined;
		if (typeof item.digest !== "string" || !nonNegativeSafe(item.byteLength)) return undefined;
		const digest = parseBlobDigest(item.digest);
		if (!digest.ok) return undefined;
		closure.push(Object.freeze({ byteLength: item.byteLength, digest: digest.value }));
	}
	return Object.freeze({
		baseExpectedHead,
		closure: Object.freeze(closure),
		generationId: generationId.value,
		objectId: objectId.value,
	});
}

function refused(admission: Extract<TestStageAdmission, { admitted: false }>): TestAdmittedBeginResult {
	return Object.freeze({ admission: Object.freeze(admission), kind: "refused" });
}

function storeRejected(
	phase: "presence" | "begin",
	result: Extract<StoreResult<never>, { ok: false }>
): TestAdmittedBeginResult {
	return Object.freeze({ kind: "store-rejected", phase, result });
}

async function delegateBegin(
	store: AheDurableStore,
	input: BeginInput,
	admission?: Extract<TestStageAdmission, { admitted: true }>
): Promise<TestAdmittedBeginResult> {
	const result = await store.beginGeneration(input);
	if (!result.ok) return storeRejected("begin", result);
	if (admission === undefined) throw new Error("semantic-control begin unexpectedly succeeded");
	return Object.freeze({ admission: Object.freeze(admission), kind: "begun", record: result.value });
}

function quotaObservation(value: unknown): Readonly<{ availableBytes: number }> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (!Object.hasOwn(value, "quota") || !Object.hasOwn(value, "usage")) return undefined;
	const quota = Reflect.get(value, "quota") as unknown;
	const usage = Reflect.get(value, "usage") as unknown;
	if (!nonNegativeSafe(quota) || !nonNegativeSafe(usage) || usage > quota) return undefined;
	return { availableBytes: quota - usage };
}

function testOnlyCreateStageAdmissionController(
	input: Readonly<{
		store: AheDurableStore & TestBlobExistencePort;
		capacity: StorageCapacityPort;
		profile: TestCapacityProfile;
	}>
): TestStageAdmissionController {
	const parsedProfile = testOnlyParseCapacityProfile(input.profile);
	if (!parsedProfile.ok) throw new TypeError("invalid capacity profile");
	const profile = parsedProfile.value;
	const store = input.store;
	const capacity = input.capacity;
	return Object.freeze({
		async beginAdmittedGeneration(value: BeginInput): Promise<TestAdmittedBeginResult> {
			const copied = copyBeginInput(value);
			if (copied === undefined) return Object.freeze({ kind: "input-rejected", reason: "INVALID_ARGUMENT" });
			if (copied.closure.length > profile.maxClosureReferences) {
				return refused({ admitted: false, reason: "STAGE_COST_LIMIT_EXCEEDED" });
			}
			const sorted = Object.freeze(
				[...copied.closure].sort((left, right) =>
					left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
				)
			);
			const duplicate = sorted.some((reference, index) => index > 0 && sorted[index - 1]?.digest === reference.digest);
			const detached = Object.freeze({ ...copied, closure: sorted });
			if (sorted.length === 0 || duplicate) return delegateBegin(store, detached);
			const digest = digestClosure(sorted);
			if (!digest.ok) return Object.freeze({ kind: "input-rejected", reason: digest.reason });
			const stagedRecord: GenerationRecord = Object.freeze({
				...detached,
				closureDigest: digest.value,
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
			const presence = await store.probeBlobPresence(Object.freeze(sorted.map(({ digest: itemDigest }) => itemDigest)));
			if (!presence.ok) return storeRejected("presence", presence);
			let missingBlobBytes = 0;
			for (let index = 0; index < sorted.length; index++) {
				if (presence.value[index] !== false) continue;
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
			let estimated: unknown;
			let available: Readonly<{ availableBytes: number }> | undefined;
			try {
				const estimate = Reflect.get(capacity, "estimate") as unknown;
				estimated = typeof estimate === "function" ? await Reflect.apply(estimate, capacity, []) : undefined;
				available = quotaObservation(estimated);
			} catch {
				available = undefined;
			}
			if (available !== undefined && available.availableBytes < requiredBytes) {
				return refused({
					admitted: false,
					availableBytes: available.availableBytes,
					reason: "QUOTA_HEADROOM_INSUFFICIENT",
					requiredBytes,
					stageCostBytes,
				});
			}
			const admission: Extract<TestStageAdmission, { admitted: true }> =
				available === undefined
					? { admitted: true, basis: "bounded-unavailable-estimate", requiredBytes, stageCostBytes }
					: {
							admitted: true,
							availableBytes: available.availableBytes,
							basis: "measured",
							requiredBytes,
							stageCostBytes,
						};
			return delegateBegin(store, detached, admission);
		},
	});
}

/**
 * Selects the production API when present and otherwise keeps RED controls executable.
 * @param module - Candidate storage root.
 * @returns The production API or the tests-only yielding scaffold.
 */
export function selectAdmissionApi(module: Readonly<Record<string, unknown>>): TestAdmissionApi {
	const parseCapacityProfile = module.parseCapacityProfile;
	const createStageAdmissionController = module.createStageAdmissionController;
	return typeof parseCapacityProfile === "function" && typeof createStageAdmissionController === "function"
		? ({ createStageAdmissionController, parseCapacityProfile } as TestAdmissionApi)
		: Object.freeze({
				createStageAdmissionController: testOnlyCreateStageAdmissionController,
				parseCapacityProfile: testOnlyParseCapacityProfile,
			});
}

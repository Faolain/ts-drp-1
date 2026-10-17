import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { classifyPersistedState } from "./persisted-state.js";
import {
	AHE_LEGACY_RETIREMENT_CONTROL_MAX_BYTES,
	AHE_RETIREMENT_CONTROL_LIMITS,
	aheRetirementGenerationIdentity,
} from "../retirement-control.js";
import { AHE_BOUNDED_READ_LIMITS as LIMITS } from "../types.js";
import type {
	AheBoundedReadAcquisition,
	AheBoundedReadInput,
	AheBoundedRecoveryRoleRead,
	AheBoundedRecoveryRoleReadInput,
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	PresentHead,
	StorageObjectId,
	StoreResult,
} from "../types.js";
import { digestBlob } from "../values.js";
import {
	bytesEqual,
	hasSharedBacking,
	headsEqual,
	isBlobDigest,
	isClosedRecord,
	isGenerationId,
	isStorageObjectId,
} from "./validation.js";

/** Native scalar guards use this marker without projecting an oversized value. */
export class BoundedReadBudgetError extends Error {}

export type BoundedReadRequest =
	| Readonly<{ kind: "head"; objectId: StorageObjectId }>
	| Readonly<{ kind: "keys"; objectId: StorageObjectId }>
	| Readonly<{ kind: "generation"; objectId: StorageObjectId; generationId: GenerationId }>
	| Readonly<{ kind: "promotion"; objectId: StorageObjectId; generationId: GenerationId; digest: BlobDigest }>
	| Readonly<{ kind: "blob"; digest: BlobDigest }>
	| Readonly<{ kind: "blob-preflight"; references: readonly GenerationRef[] }>;

/** Complete promotion-prefix request exists only for local native metadata admission. */
export type RetirementAdmissionRequest =
	| BoundedReadRequest
	| Readonly<{ kind: "promotions"; objectId: StorageObjectId }>
	| Readonly<{ kind: "blob-census-preflight"; references: readonly GenerationRef[] }>;

/** Exact bounded native image identity; not authenticated protocol eligibility. */
export type RetirementAdmission = Readonly<{
	logicalBytes: number;
	imageDigest: string;
	generations: readonly Readonly<{ generationId: GenerationId; recordDigest: string; identityDigest: string }>[];
}>;

const MAX_PROMOTIONS = LIMITS.maxObjectGenerations * LIMITS.maxClosureReferences;
const ZERO_BYTES = new Uint8Array();
function varUintBytes(length: number): number {
	let bytes = 1;
	while (length >= 128) {
		length = Math.floor(length / 128);
		bytes++;
	}
	return bytes;
}
// An outer row has exactly one binary value. Measure its bounded zero-length
// presentation and original canonical BYTES framing; never copy payload to charge it.
function logicalByteRow(store: string, key: unknown, value: Record<string, unknown>, length: number): number {
	return encodeCanonical({ store, key, value }).byteLength + length + varUintBytes(length) - 1;
}
function controlCharge(objectId: StorageObjectId, length: number, browser: boolean): number {
	const key = browser ? `ahe-retirement:${objectId}` : objectId;
	return logicalByteRow(
		browser ? "storageMeta" : "retirement_controls",
		key,
		{ [browser ? "key" : "object_id"]: key, record: ZERO_BYTES },
		length
	);
}
function maximumLogicalCharge(browser: boolean): number {
	const objectId = ("\u0800".repeat(991) + ":" + "f".repeat(32)) as StorageObjectId;
	const digest = "f".repeat(64),
		oid = browser ? "objectId" : "object_id",
		gid = browser ? "generationId" : "generation_id";
	return (
		controlCharge(objectId, AHE_LEGACY_RETIREMENT_CONTROL_MAX_BYTES, browser) +
		logicalByteRow(
			"objects",
			objectId,
			{ [oid]: objectId, [browser ? "record" : "head_record"]: ZERO_BYTES },
			LIMITS.maxHeadBytes
		) +
		LIMITS.maxObjectGenerations *
			logicalByteRow(
				"generations",
				[objectId, digest],
				{ [oid]: objectId, [gid]: digest, record: ZERO_BYTES },
				LIMITS.maxGenerationBytes
			) +
		MAX_PROMOTIONS *
			encodeCanonical({
				store: "promotions",
				key: [objectId, digest, digest],
				value: { [oid]: objectId, [gid]: digest, digest },
			}).byteLength +
		MAX_PROMOTIONS * logicalByteRow("blobs", digest, { digest, bytes: ZERO_BYTES }, LIMITS.maxBlobBytes) -
		MAX_PROMOTIONS * LIMITS.maxBlobBytes +
		LIMITS.maxUnionBytes
	);
}

/** Relative per-object logical rows, not a physical/global DB or proof-reader budget. */
export const AHE_LOCAL_CONTROL_CENSUS_LIMITS = Object.freeze({
	maxRows: 2 + LIMITS.maxObjectGenerations + 2 * MAX_PROMOTIONS,
	maxPromotions: MAX_PROMOTIONS,
	maxSqliteLogicalBytes: maximumLogicalCharge(false),
	maxIdbLogicalBytes: maximumLogicalCharge(true),
});

export type BoundedReadObservation = Readonly<{
	head: ExpectedHead;
	generations: readonly GenerationRecord[];
	blobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
}>;

/** Mechanical facts from one backend-owned native snapshot, never authority.
 * The native adapter keeps this token private and checks its exact binding.
 * Retain detached metadata and verified lengths, never borrowed payloads. */
export class BoundedReadNativeFacts {
	readonly #owner: object;
	readonly #transaction: WeakRef<object>;
	readonly #objectId: StorageObjectId;
	#head?: Readonly<{head: ExpectedHead; record: Uint8Array | null}>;
	#keys?: readonly GenerationId[];
	readonly #generations = new Map<GenerationId, Readonly<{generation: GenerationRecord; record: Uint8Array}>>();
	readonly #blobs = new Map<BlobDigest, number>();
	#complete = false;
	constructor(owner: object, transaction: object, objectId: StorageObjectId) {
		this.#owner = owner; this.#transaction = new WeakRef(transaction); this.#objectId = objectId;
		Object.freeze(this);
	}
	matches(owner: object, transaction: object, objectId: StorageObjectId): boolean {
		return this.#complete && this.#owner === owner && this.#transaction.deref() === transaction && this.#objectId === objectId;
	}
	within(transaction: object): boolean { return this.#complete && this.#transaction.deref() === transaction; }
	captureHead(value: Readonly<{head: ExpectedHead; record: Uint8Array | null}>): void {
		if (this.#complete) throw new TypeError("BOUNDED_NATIVE_FACTS_COMPLETE");
		this.#head = Object.freeze({head: Object.freeze({...value.head}), record: value.record?.slice() ?? null});
	}
	captureKeys(keys: readonly GenerationId[]): void {
		if (this.#complete) throw new TypeError("BOUNDED_NATIVE_FACTS_COMPLETE");
		this.#keys = Object.freeze([...keys]);
	}
	captureGeneration(value: Readonly<{generation: GenerationRecord; record: Uint8Array}>): void {
		if (this.#complete) throw new TypeError("BOUNDED_NATIVE_FACTS_COMPLETE");
		this.#generations.set(value.generation.generationId, Object.freeze({
			generation: freezeGenerations([value.generation])[0]!, record: value.record.slice()}));
	}
	captureBlob(ref: GenerationRef): void {
		if (this.#complete) throw new TypeError("BOUNDED_NATIVE_FACTS_COMPLETE");
		this.#blobs.set(ref.digest, ref.byteLength);
	}
	finish(): void { if (this.#complete) return; this.#complete = this.#head !== undefined && this.#keys !== undefined &&
		new Set(this.#keys).size === this.#keys.length && this.#keys.length === this.#generations.size &&
		this.#keys.every(key => this.#generations.has(key)); }
	verifiedBlobLength(ref: GenerationRef): number | undefined {
		return this.#complete && this.#blobs.get(ref.digest) === ref.byteLength ? ref.byteLength : undefined;
	}
	census(objectId: StorageObjectId): RoleCensus | undefined {
		if (!this.#complete || this.#objectId !== objectId) return undefined;
		const rows = this.#keys!.map(key => this.#generations.get(key)!);
		return {head: this.#head!.head, headRecord: this.#head!.record, keys: this.#keys!,
			generations: rows.map(row => row.generation), records: rows.map(row => row.record)};
	}
}
Object.freeze(BoundedReadNativeFacts.prototype);
Object.freeze(BoundedReadNativeFacts);

/**
 * Capture exact closed arguments before scheduling native work.
 * @param value - Untrusted closed acquisition arguments.
 * @returns Detached immutable arguments or pre-I/O refusal.
 */
export function prepareBoundedRead(value: unknown): StoreResult<AheBoundedReadInput> {
	if (
		!isClosedRecord(value, ["objectId", "ancestorCount", "limits"]) ||
		!isStorageObjectId(value.objectId) ||
		(value.ancestorCount !== 0 && value.ancestorCount !== 2) ||
		!isClosedRecord(value.limits, Object.keys(LIMITS))
	)
		return { ok: false, reason: "INVALID_ARGUMENT" };
	for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[])
		if (value.limits[key] !== LIMITS[key]) return { ok: false, reason: "INVALID_ARGUMENT" };
	return {
		ok: true,
		value: Object.freeze({ objectId: value.objectId, ancestorCount: value.ancestorCount, limits: LIMITS }),
	};
}

/**
 * Captures the closed role request, including trapping proxies, before native admission.
 * @param value - Untrusted input.
 * @returns Detached fixed arguments or pre-I/O refusal.
 */
export function prepareBoundedRecoveryRoleRead(value: unknown): StoreResult<AheBoundedRecoveryRoleReadInput> {
	try {
		const captured = captureDataRecord(value, ["objectId", "limits"]);
		if (!captured || !isStorageObjectId(captured.objectId)) return { ok: false, reason: "INVALID_ARGUMENT" };
		const limits = captureDataRecord(captured.limits, Object.keys(LIMITS));
		if (!limits) return { ok: false, reason: "INVALID_ARGUMENT" };
		for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[])
			if (limits[key] !== LIMITS[key]) return { ok: false, reason: "INVALID_ARGUMENT" };
		return { ok: true, value: Object.freeze({ objectId: captured.objectId, limits: LIMITS }) };
	} catch {
		return { ok: false, reason: "INVALID_ARGUMENT" };
	}
}

/**
 * Captures data descriptors rather than invoking property access on hostile inputs.
 * @param value - Untrusted record.
 * @param keys - Exact allowed field names.
 * @returns Captured data fields when closed.
 */
function captureDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const own = Reflect.ownKeys(value);
	if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return undefined;
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) return undefined;
		result[key] = descriptor.value;
	}
	return result;
}

/**
 * Only actual persisted integrity failures latch the existing owner.
 * @param result - Terminal bounded observation result.
 * @returns Whether the existing integrity latch must apply.
 */
export function isBoundedReadCorruption(result: StoreResult<unknown>): boolean {
	return (
		!result.ok &&
		[
			"NON_CANONICAL_RECORD",
			"UNSUPPORTED_STORAGE_SCHEMA",
			"ILLEGAL_TRANSITION",
			"BASE_HEAD_MISMATCH",
			"HEAD_CONFLICT",
			"GENERATION_NOT_FOUND",
			"BLOB_CORRUPT",
			"ADOPTED_BLOB_UNPROMOTED",
			"ADOPTED_BLOB_MISSING",
			"ADOPTED_BLOB_CORRUPT",
		].includes(result.reason)
	);
}

/**
 * Same bounded persisted classifier for acquisition and freshness.
 * @param objectId - Exact physical object scope.
 * @yields One bounded head request.
 * @returns Shared classified head or refusal.
 */
export function* boundedHeadSteps(
	objectId: StorageObjectId
): Generator<BoundedReadRequest, StoreResult<ExpectedHead>, unknown> {
	const result = yield* headSteps(objectId);
	return result.ok ? { ok: true, value: result.value.head } : result;
}

/**
 * Classifies the shared bounded head and preserves canonical identity for census.
 * @param objectId - Physical scope.
 * @yields Exact head request.
 * @returns Canonical head and compact bytes.
 */
function* headSteps(
	objectId: StorageObjectId, facts?: BoundedReadNativeFacts
): Generator<BoundedReadRequest, StoreResult<{ head: ExpectedHead; record: Uint8Array | null }>, unknown> {
	const raw = yield { kind: "head", objectId };
	if (raw !== null && !isClosedRecord(raw, ["objectId", "record"]))
		return { ok: false, reason: "NON_CANONICAL_RECORD" };
	const result = classifyPersistedState(
		{ kind: "head", objectId, row: raw === null ? null : { objectId: raw.objectId, record: raw.record } },
		"bounded-active-read"
	);
	if (result.ok && result.value.kind === "head") facts?.captureHead(result.value);
	return result.ok && result.value.kind === "head"
		? { ok: true, value: result.value }
		: (result as StoreResult<{ head: ExpectedHead; record: Uint8Array | null }>);
}

/**
 * Classifies one exact bounded physical metadata row.
 * @param objectId - Physical scope.
 * @param generationId - Addressed physical generation key.
 * @yields Exact metadata request.
 * @returns Decoded metadata and canonical bytes.
 */
function* generationSteps(
	objectId: StorageObjectId,
	generationId: GenerationId, facts?: BoundedReadNativeFacts
): Generator<BoundedReadRequest, StoreResult<{ generation: GenerationRecord; record: Uint8Array }>, unknown> {
	const raw = yield { kind: "generation", objectId, generationId };
	if (raw === null) return { ok: false, reason: "GENERATION_NOT_FOUND" };
	if (!isClosedRecord(raw, ["objectId", "generationId", "record"]))
		return { ok: false, reason: "NON_CANONICAL_RECORD" };
	const classified = classifyPersistedState(
		{
			kind: "generation",
			objectId,
			row: { objectId: raw.objectId, generationId: raw.generationId, record: raw.record },
		},
		"bounded-active-read"
	);
	if (classified.ok && classified.value.kind === "generation") facts?.captureGeneration(classified.value);
	return classified.ok && classified.value.kind === "generation"
		? { ok: true, value: classified.value }
		: (classified as StoreResult<{ generation: GenerationRecord; record: Uint8Array }>);
}

/**
 * Validates all admitted key spellings before deciding physical overflow.
 * @param objectId - Physical scope.
 * @yields Capped keys request.
 * @returns Valid ordered keys or whole refusal.
 */
function* keySteps(objectId: StorageObjectId, facts?: BoundedReadNativeFacts): Generator<BoundedReadRequest, StoreResult<GenerationId[]>, unknown> {
	const keys = yield { kind: "keys", objectId };
	if (!Array.isArray(keys)) return { ok: false, reason: "NON_CANONICAL_RECORD" };
	for (const key of keys) if (!isGenerationId(key)) return { ok: false, reason: "NON_CANONICAL_RECORD" };
	if (keys.length > LIMITS.maxObjectGenerations) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	facts?.captureKeys(keys as GenerationId[]);
	return { ok: true, value: keys as GenerationId[] };
}

/**
 * Serial request protocol; each backend drives it within one native snapshot.
 * @param input - Synchronously captured approved observer request.
 * @yields Each bounded exact native request serially.
 * @returns Complete selected data or whole refusal.
 */
export function* boundedActiveReadSteps(
	input: AheBoundedReadInput, facts?: BoundedReadNativeFacts
): Generator<BoundedReadRequest, StoreResult<BoundedReadObservation>, unknown> {
	const capturedHead = yield* headSteps(input.objectId, facts);
	const headResult = capturedHead.ok ? {ok: true as const, value: capturedHead.value.head} : capturedHead;
	if (!headResult.ok) return headResult;
	const head = headResult.value;
	const keyResult = yield* keySteps(input.objectId, facts);
	if (!keyResult.ok) return keyResult;
	const keys = keyResult.value;
	const selected: GenerationRecord[] = [];
	const visited = new Set<GenerationId>();
	function* read(id: GenerationId): Generator<BoundedReadRequest, StoreResult<GenerationRecord>, unknown> {
		const result = yield* generationSteps(input.objectId, id, facts);
		return result.ok ? { ok: true, value: result.value.generation } : result;
	}
	if (head.kind === "present") {
		let expected = head;
		for (let index = 0; index <= input.ancestorCount; index++) {
			if (visited.has(expected.generationId)) return { ok: false, reason: "BASE_HEAD_MISMATCH" };
			const record = yield* read(expected.generationId);
			if (!record.ok) return record;
			const generation = record.value;
			if (generation.state !== (index === 0 ? "Adopted" : "Superseded"))
				return { ok: false, reason: "ILLEGAL_TRANSITION" };
			if (generation.closureDigest !== expected.closureDigest) return { ok: false, reason: "HEAD_CONFLICT" };
			selected.push(generation);
			visited.add(generation.generationId);
			if (index < input.ancestorCount) {
				const base = generation.baseExpectedHead;
				if (base.kind !== "present" || base.revision + 1 !== expected.revision)
					return { ok: false, reason: "BASE_HEAD_MISMATCH" };
				expected = base;
			}
		}
	}
	let adoptedCount = head.kind === "present" ? 1 : 0;
	for (const id of keys as GenerationId[]) {
		if (visited.has(id)) continue;
		const record = yield* read(id);
		if (!record.ok) return record;
		if (record.value.state === "Adopted") adoptedCount++;
	}
	if (adoptedCount !== (head.kind === "present" ? 1 : 0)) return { ok: false, reason: "ILLEGAL_TRANSITION" };
	const blobs: Array<Readonly<{ ref: GenerationRef; bytes: Uint8Array }>> = [];
	const material = yield* materialSteps(input.objectId, selected, (ref, raw) => {
		blobs.push(Object.freeze({ ref: Object.freeze({ ...ref }), bytes: new Uint8Array(raw) }));
	}, facts);
	if (material.ok) facts?.finish();
	return material.ok ? { ok: true, value: { head, generations: selected, blobs } } : material;
}

/**
 * Owns union/promotion/blob validation with acquisition or serial comparison sinks.
 * @param objectId - Physical scope.
 * @param selected - Storage rows requiring authentic material.
 * @param consume - Serial sink that cannot retain a recaptured union during currency.
 * @yields Exact bounded promotions and serial blob requests.
 * @returns Complete validation or whole typed refusal.
 */
function* materialSteps(
	objectId: StorageObjectId,
	selected: readonly GenerationRecord[],
	consume: (ref: GenerationRef, raw: Uint8Array) => void, facts?: BoundedReadNativeFacts
): Generator<BoundedReadRequest, StoreResult<undefined>, unknown> {
	const unique = new Map<BlobDigest, GenerationRef>();
	let union = 0;
	for (const generation of selected)
		for (const ref of generation.closure) {
			if (ref.byteLength > LIMITS.maxBlobBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
			const prior = unique.get(ref.digest);
			if (prior !== undefined) {
				if (prior.byteLength !== ref.byteLength) return { ok: false, reason: "BLOB_CORRUPT" };
			} else {
				union += ref.byteLength;
				if (union > LIMITS.maxUnionBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
				unique.set(ref.digest, ref);
			}
		}
	for (const generation of selected)
		for (const ref of generation.closure) {
			const promoted = yield {
				kind: "promotion",
				objectId,
				generationId: generation.generationId,
				digest: ref.digest,
			};
			if (promoted !== true) return { ok: false, reason: "ADOPTED_BLOB_UNPROMOTED" };
		}
	// SQLite can preflight scalar lengths without requesting values. IDB cannot
	// avoid its native structured clone and admits each exact get immediately below.
	const admitted = yield { kind: "blob-preflight", references: [...unique.values()] };
	if (admitted !== true) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	for (const ref of unique.values()) {
		let raw = yield { kind: "blob", digest: ref.digest };
		if (raw === null) return { ok: false, reason: "ADOPTED_BLOB_MISSING" };
		if (!(raw instanceof Uint8Array) || hasSharedBacking(raw)) return { ok: false, reason: "ADOPTED_BLOB_CORRUPT" };
		if (raw.byteLength > LIMITS.maxBlobBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		if (raw.byteLength !== ref.byteLength) return { ok: false, reason: "ADOPTED_BLOB_CORRUPT" };
		const digest = digestBlob(raw);
		if (!digest.ok || digest.value !== ref.digest) return { ok: false, reason: "ADOPTED_BLOB_CORRUPT" };
		facts?.captureBlob(ref);
		consume(ref, raw);
		raw = undefined;
	}
	return { ok: true, value: undefined };
}

type RoleCensus = Readonly<{
	head: ExpectedHead;
	headRecord: Uint8Array | null;
	keys: readonly GenerationId[];
	generations: readonly GenerationRecord[];
	records: readonly Uint8Array[];
}>;
type RoleObservation = RoleCensus & Pick<BoundedReadObservation, "blobs">;
type RoleBaseline = RoleCensus &
	Readonly<{
		blobs: readonly Readonly<{ ref: GenerationRef; carrier: Uint8Array; bytes: Uint8Array }>[];
	}>;
type CurrentRole = Readonly<{ kind: "current" }>;

// Read actual typed-array slots, never extensible public carrier properties.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const carrierBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get as (
	this: Uint8Array
) => ArrayBuffer;
const carrierByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get as (
	this: Uint8Array
) => number;
const carrierByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get as (
	this: Uint8Array
) => number;

/**
 * Classifies each physical capped row once and binds the sole Adopted row to head.
 * @param objectId - Physical object scope.
 * @yields Shared native census requests.
 * @returns Compact canonical census or whole refusal.
 */
function* roleCensusSteps(objectId: StorageObjectId, facts?: BoundedReadNativeFacts): Generator<BoundedReadRequest, StoreResult<RoleCensus>, unknown> {
	const head = yield* headSteps(objectId, facts);
	if (!head.ok) return head;
	const keys = yield* keySteps(objectId, facts);
	if (!keys.ok) return keys;
	const generations: GenerationRecord[] = [],
		records: Uint8Array[] = [];
	let adopted = 0;
	for (const key of keys.value) {
		const result = yield* generationSteps(objectId, key, facts);
		if (!result.ok) return result;
		const generation = result.value.generation;
		if (generation.state === "Adopted") {
			adopted++;
			if (head.value.head.kind !== "present") return { ok: false, reason: "ILLEGAL_TRANSITION" };
			if (generation.generationId !== head.value.head.generationId) return { ok: false, reason: "ILLEGAL_TRANSITION" };
			if (generation.closureDigest !== head.value.head.closureDigest) return { ok: false, reason: "HEAD_CONFLICT" };
		}
		generations.push(generation);
		records.push(result.value.record);
	}
	if (adopted !== (head.value.head.kind === "present" ? 1 : 0)) return { ok: false, reason: "ILLEGAL_TRANSITION" };
	return {
		ok: true,
		value: { head: head.value.head, headRecord: head.value.record, keys: keys.value, generations, records },
	};
}

/**
 * Validates the complete addressed native format before local metadata birth/CAS.
 * This census is not DRP authentication, protected-role authority or deletion permission.
 * @param objectId - Existing native object address.
 * @param metadataBytes - Proposed exact canonical control size, or null for observed native absence.
 * @param browser - Native column/key family, never a caller authority flag.
 * @yields Bounded original requests within the caller's one transaction.
 * @returns Charged logical bytes and exact native image commitment, or whole admission refusal.
 */
export function* boundedRetirementAdmissionSteps(
	objectId: StorageObjectId,
	metadataBytes: number | null,
	browser: boolean, facts?: BoundedReadNativeFacts
): Generator<RetirementAdmissionRequest, StoreResult<RetirementAdmission>, unknown> {
	if (
		metadataBytes !== null &&
		(!Number.isSafeInteger(metadataBytes) ||
			metadataBytes <= 0 ||
			metadataBytes > AHE_RETIREMENT_CONTROL_LIMITS.maxBytes)
	)
		return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	const retained = facts?.census(objectId);
	const census = retained === undefined ? yield* roleCensusSteps(objectId) : {ok: true as const, value: retained};
	if (!census.ok) return census;
	if (census.value.head.kind !== "present" || census.value.headRecord === null)
		return { ok: false, reason: "INVALID_ARGUMENT" };
	const promotions = yield { kind: "promotions", objectId };
	if (!Array.isArray(promotions)) return { ok: false, reason: "NON_CANONICAL_RECORD" };
	if (promotions.length > MAX_PROMOTIONS) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	const promoted = new Set<string>(),
		generations = new Map(census.value.generations.map((g) => [g.generationId, g]));
	const oid = browser ? "objectId" : "object_id",
		gid = browser ? "generationId" : "generation_id";
	let charge =
		(metadataBytes === null ? 0 : controlCharge(objectId, metadataBytes, browser)) +
		logicalByteRow(
			"objects",
			objectId,
			{ [oid]: objectId, [browser ? "record" : "head_record"]: ZERO_BYTES },
			census.value.headRecord.byteLength
		);
	for (let index = 0; index < census.value.generations.length; index++) {
		const generation = census.value.generations[index];
		charge += logicalByteRow(
			"generations",
			[objectId, generation.generationId],
			{ [oid]: objectId, [gid]: generation.generationId, record: ZERO_BYTES },
			census.value.records[index].byteLength
		);
	}
	for (const row of promotions) {
		if (
			!isClosedRecord(row, ["generationId", "digest"]) ||
			!isGenerationId(row.generationId) ||
			!isBlobDigest(row.digest)
		)
			return { ok: false, reason: "NON_CANONICAL_RECORD" };
		const generation = generations.get(row.generationId),
			key = `${row.generationId}:${row.digest}`;
		if (!generation || !generation.closure.some((ref) => ref.digest === row.digest) || promoted.has(key))
			return { ok: false, reason: "NON_CANONICAL_RECORD" };
		promoted.add(key);
		charge += encodeCanonical({
			store: "promotions",
			key: [objectId, row.generationId, row.digest],
			value: { [oid]: objectId, [gid]: row.generationId, digest: row.digest },
		}).byteLength;
	}
	const references = new Map<BlobDigest, GenerationRef>(),
		required = new Set<BlobDigest>();
	for (const generation of generations.values())
		for (const ref of generation.closure) {
			const prior = references.get(ref.digest);
			if (prior && prior.byteLength !== ref.byteLength) return { ok: false, reason: "BLOB_CORRUPT" };
			if (ref.byteLength > LIMITS.maxBlobBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
			if (!prior) references.set(ref.digest, ref);
			const hasPromotion = promoted.has(`${generation.generationId}:${ref.digest}`);
			const requiresCompleteMaterial =
				generation.state === "Complete" || generation.state === "Adopted" || generation.state === "Superseded";
			if (requiresCompleteMaterial && !hasPromotion) return { ok: false, reason: "ADOPTED_BLOB_UNPROMOTED" };
			if (requiresCompleteMaterial || hasPromotion) required.add(ref.digest);
		}
	if (!browser) {
		// SQLite can inspect native byte lengths without materializing payloads.
		// Keep that pre-allocation boundary on the SQL path. IndexedDB's get
		// already clones the entire value: a separate preflight there reads every
		// blob twice in the SAME transaction without providing such a boundary.
		const preflight = yield { kind: "blob-census-preflight", references: [...references.values()] };
		if (preflight !== true) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	}
	let presentBlobs = 0,
		payloadBytes = 0,
		browserPreflightBytes = 0;
	let browserBlobRefusal: "ADOPTED_BLOB_MISSING" | "BLOB_CORRUPT" | undefined;
	const presentDigests: BlobDigest[] = [];
	for (const ref of references.values()) {
		const certified = facts?.verifiedBlobLength(ref);
		if (certified !== undefined) {
			browserPreflightBytes += certified;
			if (browser && browserPreflightBytes > LIMITS.maxUnionBytes)
				return {ok: false, reason: "READ_BUDGET_EXCEEDED"};
			payloadBytes += certified;
			if (payloadBytes > LIMITS.maxUnionBytes) return {ok: false, reason: "READ_BUDGET_EXCEEDED"};
			charge += logicalByteRow("blobs", ref.digest, {digest: ref.digest, bytes: ZERO_BYTES}, certified);
			presentBlobs++; presentDigests.push(ref.digest);
			continue;
		}
		let raw = yield { kind: "blob", digest: ref.digest };
		if (browser) {
			// Complete the ORIGINAL actual-length preflight, one bounded native
			// value at a time. Defer integrity refusal until all of that preflight
			// succeeds, preserving its budget/error precedence even when an earlier
			// reference is missing or corrupt. No payload/cache survives this loop.
			if (raw instanceof Uint8Array) {
				browserPreflightBytes += raw.byteLength;
				if (raw.byteLength > LIMITS.maxBlobBytes || browserPreflightBytes > LIMITS.maxUnionBytes)
					return {ok: false, reason: "READ_BUDGET_EXCEEDED"};
			}
			if (browserBlobRefusal !== undefined) { raw = undefined; continue; }
		}
		if (raw === null) {
			if (required.has(ref.digest)) {
				if (!browser) return {ok: false, reason: "ADOPTED_BLOB_MISSING"};
				browserBlobRefusal = "ADOPTED_BLOB_MISSING";
			}
			continue; // Absent unpromoted Staged/Discarded payload, never a usable proof or zero-byte row.
		}
		if (!(raw instanceof Uint8Array) || hasSharedBacking(raw) || raw.byteLength !== ref.byteLength) {
			if (!browser) return {ok: false, reason: "BLOB_CORRUPT"};
			browserBlobRefusal = "BLOB_CORRUPT"; raw = undefined; continue;
		}
		payloadBytes += raw.byteLength;
		if (payloadBytes > LIMITS.maxUnionBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		const digest = digestBlob(raw);
		if (!digest.ok || digest.value !== ref.digest) {
			if (!browser) return {ok: false, reason: "BLOB_CORRUPT"};
			browserBlobRefusal = "BLOB_CORRUPT"; raw = undefined; continue;
		}
		charge += logicalByteRow("blobs", ref.digest, { digest: ref.digest, bytes: ZERO_BYTES }, raw.byteLength);
		presentBlobs++;
		presentDigests.push(ref.digest);
		raw = undefined;
	}
	if (browserBlobRefusal !== undefined) return {ok: false, reason: browserBlobRefusal};
	if (
		(metadataBytes === null ? 1 : 2) + generations.size + promotions.length + presentBlobs >
			AHE_LOCAL_CONTROL_CENSUS_LIMITS.maxRows ||
		charge >
			(browser
				? AHE_LOCAL_CONTROL_CENSUS_LIMITS.maxIdbLogicalBytes
				: AHE_LOCAL_CONTROL_CENSUS_LIMITS.maxSqliteLogicalBytes)
	)
		return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
	// Payloads have already been byte-length and content-digest verified above.
	// Commit their presence separately: an optional cached row appearing after
	// acquisition is a different source image even with unchanged head/control.
	// Canonical metadata stays bounded by the original head/generation/row caps;
	// this does not copy payloads or increase any native/proof admission budget.
	const imageBytes = encodeCanonical(
		{
			head: census.value.headRecord,
			generations: census.value.records,
			promotions: [...promoted].sort(),
			presentBlobs: presentDigests.sort(),
		},
		{
			maxBytes:
				LIMITS.maxHeadBytes +
				LIMITS.maxObjectGenerations * (LIMITS.maxGenerationBytes + 8) +
				MAX_PROMOTIONS * 256 +
				256,
			maxItems: 32 + LIMITS.maxObjectGenerations * 4 + MAX_PROMOTIONS * 12,
			maxDepth: 3,
		}
	);
	const imageDigest = Array.from(hashDomain("ts-drp-storage/retirement-image/v1", imageBytes), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	const boundGenerations = census.value.generations.map((generation, index) => {
		const bytes = census.value.records[index];
		if (bytes === undefined) throw new TypeError("native generation image incomplete");
		const hashed = digestBlob(bytes);
		if (!hashed.ok) throw new TypeError("native generation digest failed");
		return Object.freeze({
			generationId: generation.generationId,
			recordDigest: hashed.value,
			identityDigest: aheRetirementGenerationIdentity(generation),
		});
	});
	return {
		ok: true,
		value: Object.freeze({ logicalBytes: charge, imageDigest, generations: Object.freeze(boundGenerations) }),
	};
}

/**
 * Acquires the entire bounded mechanical candidate union in one native snapshot.
 * @param input - Captured role request.
 * @yields Shared serial native requests.
 * @returns Complete census and borrowed-output material.
 */
export function* boundedRecoveryRoleReadSteps(
	input: AheBoundedRecoveryRoleReadInput, facts?: BoundedReadNativeFacts
): Generator<BoundedReadRequest, StoreResult<RoleObservation>, unknown> {
	const census = yield* roleCensusSteps(input.objectId, facts);
	if (!census.ok) return census;
	const blobs: BoundedReadObservation["blobs"][number][] = [];
	const material = yield* materialSteps(input.objectId, candidates(census.value), (ref, raw) => {
		blobs.push(Object.freeze({ ref: Object.freeze({ ...ref }), bytes: new Uint8Array(raw) }));
	}, facts);
	if (material.ok) facts?.finish();
	return material.ok ? { ok: true, value: { ...census.value, blobs } } : material;
}

/**
 * Selects storage candidates, not authenticated roles.
 * @param census - Classified physical rows.
 * @returns Complete/Adopted/Superseded rows only.
 */
function candidates(census: RoleCensus): readonly GenerationRecord[] {
	return census.generations.filter((generation) => ["Complete", "Adopted", "Superseded"].includes(generation.state));
}

/**
 * Authenticates actual borrowed carriers without retaining another union.
 * @param baseline - Captured immutable bindings and mutable borrowed buffers.
 * @returns Whether every borrowed carrier still matches its binding.
 */
function baselineIntact(baseline: RoleBaseline): boolean {
	try {
		for (const { ref, carrier, bytes } of baseline.blobs) {
			if (
				carrierBuffer.call(carrier) !== bytes.buffer ||
				carrierByteLength.call(carrier) !== ref.byteLength ||
				carrierByteOffset.call(carrier) !== bytes.byteOffset
			)
				return false;
			// This unexposed view shares the output backing, not a retained byte copy.
			const digest = digestBlob(bytes);
			if (!digest.ok || digest.value !== ref.digest) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Fully validates currency and serially compares native material without a second U.
 * @param baseline - Compact original census and borrowed output bindings.
 * @yields Shared full native census, promotion and blob requests.
 * @returns Current or nonpoisoning valid-view staleness; native failures retain identity.
 */
export function* boundedRecoveryRoleCurrencySteps(
	baseline: RoleBaseline
): Generator<BoundedReadRequest, StoreResult<CurrentRole>, unknown> {
	const census = yield* roleCensusSteps(baseline.head.objectId);
	if (!census.ok) return census;
	const now = census.value;
	let same =
		baselineIntact(baseline) &&
		headsEqual(baseline.head, now.head) &&
		(baseline.headRecord === null
			? now.headRecord === null
			: now.headRecord !== null && bytesEqual(baseline.headRecord, now.headRecord)) &&
		baseline.keys.length === now.keys.length &&
		baseline.keys.every((key, index) => {
			const before = baseline.records[index],
				after = now.records[index];
			return key === now.keys[index] && before !== undefined && after !== undefined && bytesEqual(before, after);
		});
	const material = yield* materialSteps(baseline.head.objectId, candidates(now), (ref, raw) => {
		const borrowed = baseline.blobs.find((blob) => blob.ref.digest === ref.digest);
		// materialSteps has just authenticated THIS actual native raw carrier.
		// Its exact equality proves this borrowed carrier's content as well;
		// hashing every other borrowed blob at every iteration is quadratic.
		// Keep the original backing/length/offset guards and whole-view sweeps
		// on both sides of this read, plus the public owner's post-terminal sweep.
		let carrierIntact = false;
		if (borrowed !== undefined) try {
			carrierIntact = carrierBuffer.call(borrowed.carrier) === borrowed.bytes.buffer &&
				carrierByteLength.call(borrowed.carrier) === ref.byteLength &&
				carrierByteOffset.call(borrowed.carrier) === borrowed.bytes.byteOffset;
		} catch { /* Detached/replaced borrowed carriers are stale, not native corruption. */ }
		if (
			!carrierIntact ||
			!borrowed ||
			borrowed.ref.byteLength !== ref.byteLength ||
			!bytesEqual(borrowed.bytes, raw)
		)
			same = false;
	});
	if (!material.ok) return material;
	return same && baselineIntact(baseline)
		? { ok: true, value: Object.freeze({ kind: "current" }) }
		: { ok: false, reason: "READ_STALE_ROLE_VIEW" };
}

/**
 * Owns synchronous admission/coalescing, joined release and final borrowed validation.
 * @param observation - Complete acquisition from a genuine native terminal.
 * @param check - Native full recapture using this private baseline.
 * @returns Frozen role-reader structure with borrowed buffers.
 */
export function createBoundedRecoveryRoleRead(
	observation: RoleObservation,
	check: (
		steps: Generator<BoundedReadRequest, StoreResult<CurrentRole>, unknown>,
		released: () => boolean
	) => Promise<StoreResult<CurrentRole>>
): AheBoundedRecoveryRoleRead {
	let released = false;
	let inFlight: Promise<StoreResult<CurrentRole>> | undefined;
	let releaseJoin: Promise<void> | undefined;
	const generations = freezeGenerations(observation.generations);
	const blobs = Object.freeze(observation.blobs);
	const baseline: RoleBaseline = {
		...observation,
		head: Object.freeze({ ...observation.head }),
		generations,
		blobs: blobs.map(({ ref, bytes: carrier }) => ({
			ref,
			carrier,
			bytes: new Uint8Array(
				carrierBuffer.call(carrier),
				carrierByteOffset.call(carrier),
				carrierByteLength.call(carrier)
			),
		})),
	};
	return Object.freeze({
		head: baseline.head,
		generations,
		blobs,
		checkCurrency(): Promise<StoreResult<CurrentRole>> {
			if (released) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			if (inFlight) return inFlight;
			let resolveJob!: (value: StoreResult<CurrentRole>) => void;
			let rejectJob!: (cause: unknown) => void;
			const job = new Promise<StoreResult<CurrentRole>>((resolve, reject) => {
				resolveJob = resolve;
				rejectJob = reject;
			});
			// Install before the callback: SQLite can synchronously reenter at BEGIN.
			inFlight = job;
			void job.then(
				() => {
					if (inFlight === job) inFlight = undefined;
				},
				() => {
					if (inFlight === job) inFlight = undefined;
				}
			);
			try {
				void check(boundedRecoveryRoleCurrencySteps(baseline), () => released).then((result) => {
					// The native callback has joined its real terminal; no await follows this sweep.
					resolveJob(
						!result.ok
							? result
							: released
								? { ok: false, reason: "READ_RELEASED" }
								: baselineIntact(baseline)
									? result
									: { ok: false, reason: "READ_STALE_ROLE_VIEW" }
					);
				}, rejectJob);
			} catch (cause) {
				rejectJob(cause);
			}
			return job;
		},
		release(): Promise<void> {
			released = true;
			releaseJoin ??= inFlight
				? inFlight.then(
						() => undefined,
						() => undefined
					)
				: Promise.resolve();
			return releaseJoin;
		},
	});
}

/**
 * Detaches and freezes structural generation data for either public reader.
 * @param generations - Classified metadata.
 * @returns Immutable detached rows and reference bindings.
 */
function freezeGenerations(generations: readonly GenerationRecord[]): readonly GenerationRecord[] {
	return Object.freeze(
		generations.map((generation) =>
			Object.freeze({
				...generation,
				baseExpectedHead: Object.freeze({ ...generation.baseExpectedHead }),
				closure: Object.freeze(generation.closure.map((ref) => Object.freeze({ ...ref }))),
			})
		)
	);
}

/**
 * Detached public output and private freshness/release identity, with no native lease.
 * @param observation - Complete data from one successful native snapshot.
 * @param check - Owner-scheduled bounded freshness observation.
 * @returns Frozen structural output with independent handle lifetime.
 */
export function createBoundedReadAcquisition(
	observation: BoundedReadObservation,
	check: (head: PresentHead, released: () => boolean) => Promise<StoreResult<ExpectedHead>>
): AheBoundedReadAcquisition {
	if (observation.head.kind === "none")
		return Object.freeze({ kind: "empty", head: Object.freeze({ ...observation.head }) });
	const captured = Object.freeze({ ...observation.head });
	let released = false;
	const checks = new Set<Promise<unknown>>();
	const generations = freezeGenerations(observation.generations);
	const reader = Object.freeze({
		head: Object.freeze({ ...captured }),
		generations,
		blobs: Object.freeze(observation.blobs),
		checkCurrent(): Promise<StoreResult<Readonly<{ kind: "current" }>>> {
			let resolveCheck!: (result: StoreResult<Readonly<{ kind: "current" }>>) => void;
			let rejectCheck!: (cause: unknown) => void;
			const pending = new Promise<StoreResult<Readonly<{ kind: "current" }>>>((resolve, reject) => {
				resolveCheck = resolve;
				rejectCheck = reject;
			});
			checks.add(pending);
			void pending.then(
				() => checks.delete(pending),
				() => checks.delete(pending)
			);
			try {
				void check(captured, () => released).then(
					(result) =>
						resolveCheck(
							!result.ok
								? result
								: headsEqual(captured, result.value)
									? { ok: true, value: Object.freeze({ kind: "current" }) }
									: { ok: false, reason: "READ_STALE_HEAD" }
						),
					rejectCheck
				);
			} catch (cause) {
				rejectCheck(cause);
			}
			return pending;
		},
		release(): Promise<void> {
			released = true;
			return Promise.all([...checks]).then(() => undefined);
		},
	});
	return Object.freeze({ kind: "present", reader });
}

import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CausalityIndex } from "@ts-drp/compaction";
import { assertTrustPreserved, createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import {
	authenticateCurrentEpochAnchor,
	type CurrentAnchorTrust,
	prepareBlueprintAdmission,
	prepareBlueprintRuntime,
	type PreparedBlueprintAdmission,
	type PreparedBlueprintRuntime,
} from "@ts-drp/protocol-v3";
import parameterRegistry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };
import {
	type AheDurableStore,
	type BlobDigest,
	digestBlob,
	digestClosure,
	type ExpectedHead,
	type GenerationId,
	type GenerationRef,
	parseGenerationId,
	parseHeadRevision,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";

const ArrayIsArray = Array.isArray;
const ArrayPrototype = Array.prototype;
const FunctionHasInstance = Function.prototype[Symbol.hasInstance];
const NumberIsSafeInteger = Number.isSafeInteger;
const ObjectCreate = Object.create;
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const RegExpTest = RegExp.prototype.test;
const ObjectPrototype = Object.prototype;
const SharedArrayBufferConstructor = globalThis.SharedArrayBuffer;
const StringConstructor = String;
const Uint8ArrayConstructor = Uint8Array;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const IntrinsicMap = Map;
const MapPrototype = Map.prototype;
const MapPrototypeEntries = Map.prototype.entries;
const MapPrototypeGet = Map.prototype.get;
const MapPrototypeHas = Map.prototype.has;
const MapPrototypeKeys = Map.prototype.keys;
const MapPrototypeSet = Map.prototype.set;
const MapSizeGetter = ObjectGetOwnPropertyDescriptor(Map.prototype, "size")?.get;
const MapIteratorPrototype = ObjectGetPrototypeOf(ReflectApply(MapPrototypeEntries, new IntrinsicMap(), []));
const MapIteratorNext = ObjectGetOwnPropertyDescriptor(MapIteratorPrototype, "next")?.value;
const DRP_ERROR_BRAND = Symbol.for("@ts-drp/errors/DRPError");
const TypedArrayPrototype = ObjectGetPrototypeOf(Uint8Array.prototype) as object;
const TypedArrayBufferGetter = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, "buffer")?.get;
const TypedArrayByteLengthGetter = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, "byteLength")?.get;
const CryptoGetRandomValues = globalThis.crypto.getRandomValues;

const INPUT_KEYS = [
	"authenticationProfile",
	"store",
	"objectId",
	"pinnedGenesisAnchorDigest",
	"exactCanonicalAnchorPreimageBytes",
	"detachedSignature",
	"exactCanonicalParametersCarrierBytes",
	"catalog",
] as const;
const CATALOG_RESULT_KEYS = [
	"artifactDigest",
	"artifactId",
	"blueprintDigest",
	"canonicalBlueprintPackageBytes",
	"exactArtifactBytes",
	"runtimeProfile",
	"evidence",
] as const;
const CATALOG_EVIDENCE_KEYS = [
	"catalogDigest",
	"lintEvidenceDigest",
	"conformanceReceiptDigest",
	"conformanceDigest",
	"conformanceTier",
	"conformanceResult",
	"engines",
] as const;
const CATALOG_ENGINE_KEYS = ["name", "build"] as const;
const CATALOG_ENGINE_NAMES = ["node", "chromium", "firefox", "webkit"] as const;
const OPEN_RESULT_KEYS = ["head", "ok", "trust", "trustRef"] as const;
const PRESENT_HEAD_KEYS = ["closureDigest", "generationId", "kind", "objectId", "revision"] as const;
const TRUST_KEYS = ["currentAnchorDigest", "currentEpoch", "genesisAnchorDigest", "objectId", "profileId"] as const;
const TRUST_REF_KEYS = ["byteLength", "digest"] as const;
const AUTHENTICATION_RESULT_KEYS = ["ok", "provenance"] as const;
const ACTIVE_RECOVERY_KEYS = ["adoptedGeneration", "head", "kind", "recomputedClosureDigest", "references"] as const;
const GENERATION_RECORD_KEYS = [
	"baseExpectedHead",
	"closure",
	"closureDigest",
	"generationId",
	"objectId",
	"state",
] as const;
const PROVENANCE_KEYS = [
	"anchorDigest",
	"blueprintDigest",
	"epoch",
	"objectId",
	"parametersDigest",
	"profileDigest",
	"signerSetDigest",
] as const;
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const SUPPORTED_PARAMETER_PROFILE = ObjectFreeze({
	parametersDigest: "cd31923f2f1928daab3a6943fa361f7cf40516ba3c4929abbd3109ee65cdc669",
	runtimeProfile: "ecmascript-2024-sync-v1" as const,
});

export interface PrepareV3LiveGenerationInput {
	readonly authenticationProfile: "creator-only";
	readonly store: AheDurableStore;
	readonly objectId: StorageObjectId;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
}

export type PrepareV3LiveFailureKind =
	| "malformed-input"
	| "trust-open-failed"
	| "anchor-authentication-failed"
	| "parameters-rejected"
	| "blueprint-unresolved"
	| "admission-rejected"
	| "runtime-preparation-failed"
	| "graph-rejected"
	| "trust-not-preserved"
	| "stale-head"
	| "storage-failed"
	| "internal-invariant";

export interface V3LiveDescriptor {
	readonly objectId: string;
	readonly epoch: 0;
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly parametersDigest: string;
	readonly profileDigest: string;
	readonly signerSetDigest: string;
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly catalogDigest: string;
	readonly runtimeProfile: "ecmascript-2024-sync-v1";
	readonly trustProfile: "creator-only";
	readonly trustRef: GenerationRef;
	readonly maxEpochVertices: number;
	readonly maxEpochBytes: number;
	readonly maxDependencies: number;
	readonly vertexCount: 1;
	readonly byteCharge: number;
	readonly projectionDigest: BlobDigest;
	readonly head: PresentHead;
}

declare const preparedV3LiveBrand: unique symbol;
export type PreparedV3Live = Readonly<{ readonly [preparedV3LiveBrand]: true }>;

export type PrepareV3LiveResult =
	| Readonly<{
			readonly ok: true;
			readonly capability: PreparedV3Live;
			readonly descriptor: V3LiveDescriptor;
	  }>
	| Readonly<{
			readonly ok: false;
			readonly kind: PrepareV3LiveFailureKind;
			readonly detail: string;
	  }>;

type PlainRecord = Readonly<Record<string, unknown>>;

interface CapturedInput {
	readonly authenticationProfile: "creator-only";
	readonly store: AheDurableStore;
	readonly objectId: StorageObjectId;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
}

interface CatalogSnapshot {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
	readonly runtimeProfile: "ecmascript-2024-sync-v1";
	readonly catalogDigest: string;
	readonly evidence: Readonly<{
		readonly catalogDigest: string;
		readonly lintEvidenceDigest: string;
		readonly conformanceReceiptDigest: string;
		readonly conformanceDigest: string;
		readonly conformanceTier: "nightly";
		readonly conformanceResult: "passed";
		readonly engines: readonly Readonly<{ readonly name: string; readonly build: string }>[];
	}>;
}

interface ProvenanceSnapshot {
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly epoch: 0;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly profileDigest: string;
	readonly signerSetDigest: string;
}

interface OpenedTrustSnapshot {
	readonly head: PresentHead;
	readonly trust: CurrentAnchorTrust;
	readonly trustRef: GenerationRef;
}

interface DurableStateSnapshot extends OpenedTrustSnapshot {
	readonly candidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
	readonly references: readonly GenerationRef[];
}

interface PreparedV3LivePayload {
	readonly admission: PreparedBlueprintAdmission;
	readonly catalog: CatalogSnapshot;
	readonly charges: Map<string, number>;
	readonly exactProjectionBytes: Uint8Array;
	readonly input: CapturedInput;
	readonly liveStateRef: GenerationRef;
	readonly order: readonly string[];
	readonly parameters: AcceptedParameters;
	readonly provenance: ProvenanceSnapshot;
	readonly proposedClosure: readonly GenerationRef[];
	readonly runtime: PreparedBlueprintRuntime;
	readonly trust: OpenedTrustSnapshot;
	readonly vertices: Map<string, unknown>;
}

interface AcceptedParameters {
	readonly maxDependencies: number;
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
}

const preparedV3LiveAuthority = new WeakMap<object, PreparedV3LivePayload>();

function consumePreparedV3Live(capability: PreparedV3Live): PreparedV3LivePayload | undefined {
	const payload = preparedV3LiveAuthority.get(capability);
	if (payload === undefined) return undefined;
	preparedV3LiveAuthority.delete(capability);
	return payload;
}
void consumePreparedV3Live;

function failure(kind: PrepareV3LiveFailureKind, detail: string): PrepareV3LiveResult {
	return ObjectFreeze({ detail, kind, ok: false as const });
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function snapshotClosedRecord(value: unknown, keys: readonly string[]): PlainRecord | undefined {
	try {
		if (!isObject(value) || ObjectGetPrototypeOf(value) !== ObjectPrototype) return undefined;
		const actual = ReflectOwnKeys(value);
		if (actual.length !== keys.length) return undefined;
		for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
			const actualKey = actual[actualIndex];
			if (typeof actualKey !== "string") return undefined;
			let found = false;
			for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
				if (keys[keyIndex] === actualKey) found = true;
			}
			if (!found) return undefined;
		}
		const snapshot = ObjectCreate(null) as Record<string, unknown>;
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index] as string;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			snapshot[key] = descriptor.value;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

function isInstanceOf(value: unknown, constructor: object | undefined): boolean {
	try {
		return constructor !== undefined && ReflectApply(FunctionHasInstance, constructor, [value]) === true;
	} catch {
		return false;
	}
}

function isDigestHex(value: unknown): value is string {
	return typeof value === "string" && ReflectApply(RegExpTest, DIGEST_HEX, [value]) === true;
}

function typedArrayBuffer(value: unknown): ArrayBufferLike | undefined {
	try {
		return TypedArrayBufferGetter === undefined
			? undefined
			: (ReflectApply(TypedArrayBufferGetter, value, []) as ArrayBufferLike);
	} catch {
		return undefined;
	}
}

function typedArrayByteLength(value: unknown): number | undefined {
	try {
		if (TypedArrayByteLengthGetter === undefined) return undefined;
		const byteLength = ReflectApply(TypedArrayByteLengthGetter, value, []) as number;
		return NumberIsSafeInteger(byteLength) && byteLength >= 0 ? byteLength : undefined;
	} catch {
		return undefined;
	}
}

function copyDetachedBytes(value: unknown): Uint8Array | undefined {
	try {
		if (!isInstanceOf(value, Uint8ArrayConstructor) || TypedArrayByteLengthGetter === undefined) return undefined;
		const buffer = typedArrayBuffer(value);
		if (buffer === undefined || isInstanceOf(buffer, SharedArrayBufferConstructor)) {
			return undefined;
		}
		const byteLength = typedArrayByteLength(value);
		if (byteLength === undefined) return undefined;
		const copy = new Uint8ArrayConstructor(value as Uint8Array);
		const copyBuffer = typedArrayBuffer(copy);
		if (copyBuffer === undefined) return undefined;
		ObjectDefineProperty(copy, "buffer", { configurable: true, value: copyBuffer });
		ObjectDefineProperty(copy, "byteLength", { configurable: true, value: byteLength });
		return copy;
	} catch {
		return undefined;
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	const leftLength = typedArrayByteLength(left);
	const rightLength = typedArrayByteLength(right);
	if (leftLength === undefined || leftLength !== rightLength) return false;
	for (let index = 0; index < leftLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function bytesToLowerHex(bytes: Uint8Array): string {
	const alphabet = "0123456789abcdef";
	const byteLength = typedArrayByteLength(bytes);
	if (byteLength === undefined) throw new TypeError("digest bytes are invalid");
	let output = "";
	for (let index = 0; index < byteLength; index += 1) {
		const byte = bytes[index] as number;
		output += alphabet[(byte >>> 4) & 0x0f] as string;
		output += alphabet[byte & 0x0f] as string;
	}
	return output;
}

function captureInput(input: PrepareV3LiveGenerationInput): CapturedInput | undefined {
	const record = snapshotClosedRecord(input, INPUT_KEYS);
	if (record === undefined) return undefined;
	if (record.authenticationProfile !== "creator-only") return undefined;
	if (typeof record.objectId !== "string") return undefined;
	const objectId = parseStorageObjectId(record.objectId);
	if (!objectId.ok || objectId.value !== record.objectId) return undefined;
	if (!isDigestHex(record.pinnedGenesisAnchorDigest)) {
		return undefined;
	}
	if (!isObject(record.store) || !isObject(record.catalog)) return undefined;
	const anchorSource = record.exactCanonicalAnchorPreimageBytes;
	const signatureSource = record.detachedSignature;
	const parametersSource = record.exactCanonicalParametersCarrierBytes;
	if (
		!isInstanceOf(anchorSource, Uint8ArrayConstructor) ||
		!isInstanceOf(signatureSource, Uint8ArrayConstructor) ||
		!isInstanceOf(parametersSource, Uint8ArrayConstructor)
	) {
		return undefined;
	}
	const anchorBuffer = typedArrayBuffer(anchorSource);
	const signatureBuffer = typedArrayBuffer(signatureSource);
	const parametersBuffer = typedArrayBuffer(parametersSource);
	if (
		anchorBuffer === undefined ||
		signatureBuffer === undefined ||
		parametersBuffer === undefined ||
		anchorBuffer === signatureBuffer ||
		anchorBuffer === parametersBuffer ||
		signatureBuffer === parametersBuffer
	) {
		return undefined;
	}
	const exactCanonicalAnchorPreimageBytes = copyDetachedBytes(anchorSource);
	const detachedSignature = copyDetachedBytes(signatureSource);
	const exactCanonicalParametersCarrierBytes = copyDetachedBytes(parametersSource);
	if (
		exactCanonicalAnchorPreimageBytes === undefined ||
		typedArrayByteLength(exactCanonicalAnchorPreimageBytes) === 0 ||
		detachedSignature === undefined ||
		typedArrayByteLength(detachedSignature) !== 64 ||
		exactCanonicalParametersCarrierBytes === undefined ||
		typedArrayByteLength(exactCanonicalParametersCarrierBytes) === 0
	) {
		return undefined;
	}
	return ObjectFreeze({
		authenticationProfile: "creator-only" as const,
		store: record.store as AheDurableStore,
		objectId: objectId.value,
		pinnedGenesisAnchorDigest: record.pinnedGenesisAnchorDigest,
		exactCanonicalAnchorPreimageBytes,
		detachedSignature,
		exactCanonicalParametersCarrierBytes,
		catalog: record.catalog as TrustedBlueprintCatalog,
	});
}

interface ParameterFieldSchema {
	readonly maximum: number;
	readonly minimum: number;
	readonly name: string;
}

interface ParameterSchema {
	readonly domain: string;
	readonly fields: readonly ParameterFieldSchema[];
}

function ownDataValue(value: unknown, key: string): unknown {
	if (!isObject(value)) return undefined;
	const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor
		? descriptor.value
		: undefined;
}

function defineDenseElement(target: unknown[], index: number, value: unknown): boolean {
	try {
		ObjectDefineProperty(target, StringConstructor(index), {
			configurable: true,
			enumerable: true,
			value,
			writable: true,
		});
		return true;
	} catch {
		return false;
	}
}

function finishDenseArray<T>(value: T[], expectedLength: number): readonly T[] | undefined {
	try {
		ObjectDefineProperty(value, "length", {
			configurable: false,
			enumerable: false,
			value: expectedLength,
			writable: true,
		});
		const keys = ReflectOwnKeys(value);
		if (keys.length !== expectedLength + 1 || keys[expectedLength] !== "length") return undefined;
		for (let index = 0; index < expectedLength; index += 1) {
			const key = StringConstructor(index);
			if (keys[index] !== key) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
				return undefined;
			}
		}
		return ObjectFreeze(value);
	} catch {
		return undefined;
	}
}

function snapshotDenseArray(value: unknown, expectedLength: number): readonly unknown[] | undefined {
	try {
		if (!ArrayIsArray(value) || ObjectGetPrototypeOf(value) !== ArrayPrototype || value.length !== expectedLength) {
			return undefined;
		}
		const keys = ReflectOwnKeys(value);
		if (keys.length !== expectedLength + 1 || keys[expectedLength] !== "length") return undefined;
		const output: unknown[] = [];
		for (let index = 0; index < expectedLength; index += 1) {
			const key = StringConstructor(index);
			if (keys[index] !== key) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, key);
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor) ||
				!defineDenseElement(output, index, descriptor.value)
			) {
				return undefined;
			}
		}
		return finishDenseArray(output, expectedLength);
	} catch {
		return undefined;
	}
}

function snapshotPublishedParameterSchema(value: unknown): ParameterSchema | undefined {
	try {
		const kinds = ownDataValue(value, "kinds");
		const parameters = snapshotClosedRecord(ownDataValue(kinds, "parameters"), [
			"domain",
			"encoding",
			"fields",
			"signedEnvelope",
		]);
		if (
			parameters === undefined ||
			typeof parameters.domain !== "string" ||
			parameters.encoding !== "canonical-object"
		) {
			return undefined;
		}
		const fields = snapshotDenseArray(parameters.fields, 7);
		if (fields === undefined) return undefined;
		const captured: ParameterFieldSchema[] = [];
		for (let index = 0; index < fields.length; index += 1) {
			const field = snapshotClosedRecord(fields[index], [
				"name",
				"type",
				"const",
				"constraints",
				"required",
				"sortRule",
			]);
			if (
				field === undefined ||
				typeof field.name !== "string" ||
				field.name.length === 0 ||
				field.type !== "safe-integer" ||
				field.const !== null ||
				field.required !== true ||
				field.sortRule !== null
			) {
				return undefined;
			}
			const constraints = snapshotClosedRecord(field.constraints, ["minimum", "maximum"]);
			if (
				constraints === undefined ||
				typeof constraints.minimum !== "number" ||
				!NumberIsSafeInteger(constraints.minimum) ||
				typeof constraints.maximum !== "number" ||
				!NumberIsSafeInteger(constraints.maximum) ||
				constraints.minimum > constraints.maximum
			) {
				return undefined;
			}
			for (let previous = 0; previous < captured.length; previous += 1) {
				if (captured[previous]?.name === field.name) return undefined;
			}
			if (
				!defineDenseElement(
					captured,
					index,
					ObjectFreeze({
						maximum: constraints.maximum,
						minimum: constraints.minimum,
						name: field.name,
					})
				)
			) {
				return undefined;
			}
		}
		const frozenFields = finishDenseArray(captured, fields.length);
		return frozenFields === undefined ? undefined : ObjectFreeze({ domain: parameters.domain, fields: frozenFields });
	} catch {
		return undefined;
	}
}

const PARAMETER_SCHEMA = snapshotPublishedParameterSchema(parameterRegistry);

function snapshotParameterRecord(value: unknown, schema: ParameterSchema): PlainRecord | undefined {
	try {
		if (!isObject(value) || ObjectGetPrototypeOf(value) !== null) return undefined;
		const keys = ReflectOwnKeys(value);
		if (keys.length !== schema.fields.length) return undefined;
		const output = ObjectCreate(null) as Record<string, unknown>;
		for (let fieldIndex = 0; fieldIndex < schema.fields.length; fieldIndex += 1) {
			const field = schema.fields[fieldIndex] as ParameterFieldSchema;
			let keyFound = false;
			for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
				if (keys[keyIndex] === field.name) keyFound = true;
			}
			if (!keyFound) return undefined;
			const descriptor = ObjectGetOwnPropertyDescriptor(value, field.name);
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor) ||
				typeof descriptor.value !== "number" ||
				!NumberIsSafeInteger(descriptor.value) ||
				descriptor.value < field.minimum ||
				descriptor.value > field.maximum
			) {
				return undefined;
			}
			output[field.name] = descriptor.value;
		}
		return output;
	} catch {
		return undefined;
	}
}

function acceptedParameterDigest(bytes: Uint8Array, expectedDigest: string): AcceptedParameters | undefined {
	try {
		if (PARAMETER_SCHEMA === undefined) return undefined;
		const snapshot = snapshotParameterRecord(decodeCanonical(bytes), PARAMETER_SCHEMA);
		if (snapshot === undefined) return undefined;
		const reencoded = encodeCanonical(snapshot);
		if (!sameBytes(reencoded, bytes)) return undefined;
		const digest = bytesToLowerHex(hashDomain(PARAMETER_SCHEMA.domain, reencoded));
		if (digest !== expectedDigest || digest !== SUPPORTED_PARAMETER_PROFILE.parametersDigest) return undefined;
		const maxDependencies = snapshot.maxDependencies;
		const maxEpochBytes = snapshot.maxEpochBytes;
		const maxEpochVertices = snapshot.maxEpochVertices;
		return typeof maxDependencies === "number" &&
			NumberIsSafeInteger(maxDependencies) &&
			typeof maxEpochBytes === "number" &&
			NumberIsSafeInteger(maxEpochBytes) &&
			typeof maxEpochVertices === "number" &&
			NumberIsSafeInteger(maxEpochVertices)
			? ObjectFreeze({ maxDependencies, maxEpochBytes, maxEpochVertices })
			: undefined;
	} catch {
		return undefined;
	}
}

function snapshotCatalogEngines(value: unknown): readonly Readonly<{ name: string; build: string }>[] | undefined {
	const engines = snapshotDenseArray(value, CATALOG_ENGINE_NAMES.length);
	if (engines === undefined) return undefined;
	const snapshot: Readonly<{ name: string; build: string }>[] = [];
	for (let index = 0; index < CATALOG_ENGINE_NAMES.length; index += 1) {
		const engine = snapshotClosedRecord(engines[index], CATALOG_ENGINE_KEYS);
		if (
			engine === undefined ||
			typeof engine.name !== "string" ||
			engine.name !== CATALOG_ENGINE_NAMES[index] ||
			typeof engine.build !== "string" ||
			engine.build.length === 0
		) {
			return undefined;
		}
		if (!defineDenseElement(snapshot, index, ObjectFreeze({ build: engine.build, name: engine.name }))) {
			return undefined;
		}
	}
	return finishDenseArray(snapshot, CATALOG_ENGINE_NAMES.length);
}

function snapshotCatalog(catalog: TrustedBlueprintCatalog, value: unknown): CatalogSnapshot | undefined {
	const record = snapshotClosedRecord(value, CATALOG_RESULT_KEYS);
	if (record === undefined) return undefined;
	const evidence = snapshotClosedRecord(record.evidence, CATALOG_EVIDENCE_KEYS);
	if (evidence === undefined) return undefined;
	const catalogDescriptor = ObjectGetOwnPropertyDescriptor(catalog, "catalogDigest");
	if (catalogDescriptor === undefined || !("value" in catalogDescriptor)) return undefined;
	const catalogDigest = catalogDescriptor.value;
	if (
		!isDigestHex(record.artifactDigest) ||
		typeof record.artifactId !== "string" ||
		record.artifactId.length === 0 ||
		!isDigestHex(record.blueprintDigest) ||
		record.runtimeProfile !== SUPPORTED_PARAMETER_PROFILE.runtimeProfile ||
		!isDigestHex(catalogDigest) ||
		evidence.catalogDigest !== catalogDigest ||
		evidence.conformanceTier !== "nightly" ||
		evidence.conformanceResult !== "passed"
	) {
		return undefined;
	}
	for (let index = 0; index < 3; index += 1) {
		const key = ["lintEvidenceDigest", "conformanceReceiptDigest", "conformanceDigest"][index] as string;
		if (!isDigestHex(evidence[key])) return undefined;
	}
	const engines = snapshotCatalogEngines(evidence.engines);
	if (engines === undefined) return undefined;
	const canonicalBlueprintPackageBytes = copyDetachedBytes(record.canonicalBlueprintPackageBytes);
	const exactArtifactBytes = copyDetachedBytes(record.exactArtifactBytes);
	if (
		canonicalBlueprintPackageBytes === undefined ||
		typedArrayByteLength(canonicalBlueprintPackageBytes) === 0 ||
		exactArtifactBytes === undefined ||
		typedArrayByteLength(exactArtifactBytes) === 0
	) {
		return undefined;
	}
	return ObjectFreeze({
		artifactDigest: record.artifactDigest,
		artifactId: record.artifactId,
		blueprintDigest: record.blueprintDigest,
		canonicalBlueprintPackageBytes,
		exactArtifactBytes,
		runtimeProfile: SUPPORTED_PARAMETER_PROFILE.runtimeProfile,
		catalogDigest,
		evidence: ObjectFreeze({
			catalogDigest,
			lintEvidenceDigest: evidence.lintEvidenceDigest as string,
			conformanceReceiptDigest: evidence.conformanceReceiptDigest as string,
			conformanceDigest: evidence.conformanceDigest as string,
			conformanceTier: "nightly" as const,
			conformanceResult: "passed" as const,
			engines,
		}),
	});
}

function admissionMatches(value: PreparedBlueprintAdmission, expectedBlueprintDigest: string): boolean {
	const record = snapshotClosedRecord(value, ["blueprintDigest"]);
	return record?.blueprintDigest === expectedBlueprintDigest;
}

function runtimeMatches(value: PreparedBlueprintRuntime, catalog: CatalogSnapshot): boolean {
	const record = snapshotClosedRecord(value, [
		"artifactDigest",
		"artifactId",
		"blueprintDigest",
		"reducers",
		"runtimeProfile",
	]);
	return (
		record?.artifactDigest === catalog.artifactDigest &&
		record.artifactId === catalog.artifactId &&
		record.blueprintDigest === catalog.blueprintDigest &&
		record.runtimeProfile === catalog.runtimeProfile
	);
}

function snapshotOpenedTrust(value: unknown, expectedObjectId: string): OpenedTrustSnapshot | undefined {
	const result = snapshotClosedRecord(value, OPEN_RESULT_KEYS);
	if (result === undefined || result.ok !== true) return undefined;
	const head = snapshotClosedRecord(result.head, PRESENT_HEAD_KEYS);
	const trust = snapshotClosedRecord(result.trust, TRUST_KEYS);
	const trustRef = snapshotClosedRecord(result.trustRef, TRUST_REF_KEYS);
	if (
		head === undefined ||
		head.kind !== "present" ||
		head.objectId !== expectedObjectId ||
		typeof head.generationId !== "string" ||
		typeof head.closureDigest !== "string" ||
		typeof head.revision !== "number" ||
		!NumberIsSafeInteger(head.revision) ||
		head.revision < 1 ||
		trust === undefined ||
		trust.objectId !== expectedObjectId ||
		trust.profileId !== "creator-trusted-v1" ||
		!isDigestHex(trust.currentAnchorDigest) ||
		!isDigestHex(trust.genesisAnchorDigest) ||
		typeof trust.currentEpoch !== "number" ||
		!NumberIsSafeInteger(trust.currentEpoch) ||
		trust.currentEpoch < 0 ||
		trustRef === undefined ||
		!isDigestHex(trustRef.digest) ||
		typeof trustRef.byteLength !== "number" ||
		!NumberIsSafeInteger(trustRef.byteLength) ||
		trustRef.byteLength < 1
	) {
		return undefined;
	}
	return ObjectFreeze({
		head: ObjectFreeze({
			closureDigest: head.closureDigest,
			generationId: head.generationId,
			kind: "present" as const,
			objectId: head.objectId,
			revision: head.revision,
		}) as PresentHead,
		trust: result.trust as CurrentAnchorTrust,
		trustRef: ObjectFreeze({
			byteLength: trustRef.byteLength,
			digest: trustRef.digest,
		}) as GenerationRef,
	});
}

function snapshotAuthenticatedProvenance(value: unknown, expectedObjectId: string): ProvenanceSnapshot | undefined {
	const result = snapshotClosedRecord(value, AUTHENTICATION_RESULT_KEYS);
	if (result === undefined || result.ok !== true) return undefined;
	const provenance = snapshotClosedRecord(result.provenance, PROVENANCE_KEYS);
	if (
		provenance === undefined ||
		provenance.epoch !== 0 ||
		provenance.objectId !== expectedObjectId ||
		!isDigestHex(provenance.anchorDigest) ||
		!isDigestHex(provenance.blueprintDigest) ||
		!isDigestHex(provenance.parametersDigest) ||
		!isDigestHex(provenance.profileDigest) ||
		!isDigestHex(provenance.signerSetDigest)
	) {
		return undefined;
	}
	return ObjectFreeze({
		anchorDigest: provenance.anchorDigest,
		blueprintDigest: provenance.blueprintDigest,
		epoch: 0 as const,
		objectId: provenance.objectId,
		parametersDigest: provenance.parametersDigest,
		profileDigest: provenance.profileDigest,
		signerSetDigest: provenance.signerSetDigest,
	});
}

interface CapturedIteratorStep {
	readonly done: boolean;
	readonly value: unknown;
}

function nextCapturedMapIterator(iterator: unknown): CapturedIteratorStep | undefined {
	try {
		if (typeof MapIteratorNext !== "function") return undefined;
		const result = ReflectApply(MapIteratorNext, iterator, []) as unknown;
		if (!isObject(result)) return undefined;
		const done = ObjectGetOwnPropertyDescriptor(result, "done");
		const value = ObjectGetOwnPropertyDescriptor(result, "value");
		if (done === undefined || !("value" in done) || typeof done.value !== "boolean") return undefined;
		if (done.value === true) return ObjectFreeze({ done: true, value: undefined });
		return value !== undefined && "value" in value ? ObjectFreeze({ done: false, value: value.value }) : undefined;
	} catch {
		return undefined;
	}
}

function isExactOwnedSingleEntryMap(map: unknown, expectedKey: string, expectedValue: unknown): boolean {
	try {
		if (
			!isObject(map) ||
			ObjectGetPrototypeOf(map) !== MapPrototype ||
			ReflectOwnKeys(map).length !== 0 ||
			MapSizeGetter === undefined ||
			ReflectApply(MapSizeGetter, map, []) !== 1 ||
			ReflectApply(MapPrototypeHas, map, [expectedKey]) !== true ||
			ReflectApply(MapPrototypeGet, map, [expectedKey]) !== expectedValue
		) {
			return false;
		}
		const keys = ReflectApply(MapPrototypeKeys, map, []) as unknown;
		const firstKey = nextCapturedMapIterator(keys);
		const lastKey = nextCapturedMapIterator(keys);
		if (firstKey?.done !== false || firstKey.value !== expectedKey || lastKey?.done !== true) return false;
		const entries = ReflectApply(MapPrototypeEntries, map, []) as unknown;
		const firstEntry = nextCapturedMapIterator(entries);
		const lastEntry = nextCapturedMapIterator(entries);
		if (firstEntry?.done !== false || lastEntry?.done !== true || !ArrayIsArray(firstEntry.value)) return false;
		const entryKey = ObjectGetOwnPropertyDescriptor(firstEntry.value, "0");
		const entryValue = ObjectGetOwnPropertyDescriptor(firstEntry.value, "1");
		return (
			entryKey !== undefined &&
			"value" in entryKey &&
			entryKey.value === expectedKey &&
			entryValue !== undefined &&
			"value" in entryValue &&
			entryValue.value === expectedValue
		);
	} catch {
		return false;
	}
}

function isLinearizationFailure(value: unknown): boolean {
	if (!isObject(value)) return false;
	try {
		const brand = ObjectGetOwnPropertyDescriptor(value, DRP_ERROR_BRAND);
		const code = ObjectGetOwnPropertyDescriptor(value, "code");
		const name = ObjectGetOwnPropertyDescriptor(value, "name");
		return (
			brand !== undefined &&
			"value" in brand &&
			brand.value === true &&
			code !== undefined &&
			"value" in code &&
			typeof code.value === "string" &&
			name !== undefined &&
			"value" in name &&
			name.value === "LinearizationError"
		);
	} catch {
		return false;
	}
}

function copiedGenerationRef(digest: unknown, byteLength: unknown): GenerationRef | undefined {
	return isDigestHex(digest) && typeof byteLength === "number" && NumberIsSafeInteger(byteLength) && byteLength > 0
		? (ObjectFreeze({ digest, byteLength }) as GenerationRef)
		: undefined;
}

type StoreResultSnapshot =
	| Readonly<{ readonly ok: true; readonly value: unknown }>
	| Readonly<{ readonly ok: false; readonly reason: string }>;

function snapshotStoreResult(value: unknown): StoreResultSnapshot | undefined {
	try {
		if (!isObject(value)) return undefined;
		const ok = ObjectGetOwnPropertyDescriptor(value, "ok");
		if (ok === undefined || ok.enumerable !== true || !("value" in ok) || typeof ok.value !== "boolean") {
			return undefined;
		}
		if (ok.value) {
			const record = snapshotClosedRecord(value, ["ok", "value"]);
			return record === undefined ? undefined : ObjectFreeze({ ok: true as const, value: record.value });
		}
		const reason = ObjectGetOwnPropertyDescriptor(value, "reason");
		if (
			reason === undefined ||
			reason.enumerable !== true ||
			!("value" in reason) ||
			typeof reason.value !== "string"
		) {
			return undefined;
		}
		const keys = reason.value === "SUBSTRATE_FAILURE" ? ["cause", "ok", "reason"] : ["ok", "reason"];
		return snapshotClosedRecord(value, keys) === undefined
			? undefined
			: ObjectFreeze({ ok: false as const, reason: reason.value });
	} catch {
		return undefined;
	}
}

function copiedPresentHead(value: unknown, expectedObjectId: StorageObjectId): PresentHead | undefined {
	const record = snapshotClosedRecord(value, PRESENT_HEAD_KEYS);
	if (
		record === undefined ||
		record.kind !== "present" ||
		record.objectId !== expectedObjectId ||
		!isDigestHex(record.generationId) ||
		!isDigestHex(record.closureDigest) ||
		typeof record.revision !== "number" ||
		!NumberIsSafeInteger(record.revision) ||
		record.revision < 1
	) {
		return undefined;
	}
	return ObjectFreeze({
		kind: "present" as const,
		objectId: expectedObjectId,
		generationId: record.generationId,
		revision: record.revision,
		closureDigest: record.closureDigest,
	}) as PresentHead;
}

function copiedExpectedHead(value: unknown, expectedObjectId: StorageObjectId): ExpectedHead | undefined {
	try {
		const kind = isObject(value) ? ObjectGetOwnPropertyDescriptor(value, "kind") : undefined;
		if (kind === undefined || !("value" in kind)) return undefined;
		if (kind.value === "none") {
			const record = snapshotClosedRecord(value, ["kind", "objectId"]);
			return record?.objectId === expectedObjectId
				? ObjectFreeze({ kind: "none" as const, objectId: expectedObjectId })
				: undefined;
		}
		return copiedPresentHead(value, expectedObjectId);
	} catch {
		return undefined;
	}
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function copiedGenerationRefs(value: unknown): readonly GenerationRef[] | undefined {
	try {
		if (!ArrayIsArray(value) || ObjectGetPrototypeOf(value) !== ArrayPrototype) return undefined;
		const length = ObjectGetOwnPropertyDescriptor(value, "length");
		if (
			length === undefined ||
			!("value" in length) ||
			typeof length.value !== "number" ||
			!NumberIsSafeInteger(length.value) ||
			length.value < 1 ||
			length.value > 2
		) {
			return undefined;
		}
		const entries = snapshotDenseArray(value, length.value);
		if (entries === undefined) return undefined;
		const refs: GenerationRef[] = [];
		let previous: string | undefined;
		for (let index = 0; index < entries.length; index += 1) {
			const record = snapshotClosedRecord(entries[index], TRUST_REF_KEYS);
			const ref = copiedGenerationRef(record?.digest, record?.byteLength);
			if (ref === undefined || (previous !== undefined && previous >= ref.digest)) return undefined;
			if (!defineDenseElement(refs, index, ref)) return undefined;
			previous = ref.digest;
		}
		return finishDenseArray(refs, entries.length);
	} catch {
		return undefined;
	}
}

function sameClosure(left: readonly GenerationRef[], right: readonly GenerationRef[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (!sameRef(left[index] as GenerationRef, right[index] as GenerationRef)) return false;
	}
	return true;
}

function copiedGenerationRecord(
	value: unknown,
	expected: Readonly<{
		baseExpectedHead?: ExpectedHead;
		closure: readonly GenerationRef[];
		generationId: GenerationId;
		objectId: StorageObjectId;
		state: "Adopted" | "Complete" | "Staged";
	}>
): Readonly<{ readonly closureDigest: string }> | undefined {
	const record = snapshotClosedRecord(value, GENERATION_RECORD_KEYS);
	if (
		record === undefined ||
		record.objectId !== expected.objectId ||
		record.generationId !== expected.generationId ||
		record.state !== expected.state ||
		!isDigestHex(record.closureDigest)
	) {
		return undefined;
	}
	const baseExpectedHead = copiedExpectedHead(record.baseExpectedHead, expected.objectId);
	const closure = copiedGenerationRefs(record.closure);
	return baseExpectedHead !== undefined &&
		(expected.baseExpectedHead === undefined ||
			(baseExpectedHead.kind === expected.baseExpectedHead.kind &&
				(baseExpectedHead.kind === "none" ||
					(expected.baseExpectedHead.kind === "present" && sameHead(baseExpectedHead, expected.baseExpectedHead))))) &&
		closure !== undefined &&
		sameClosure(closure, expected.closure)
		? ObjectFreeze({ closureDigest: record.closureDigest })
		: undefined;
}

function freshGenerationId(): GenerationId | undefined {
	try {
		const bytes = new Uint8ArrayConstructor(32);
		const buffer = typedArrayBuffer(bytes);
		if (buffer === undefined) return undefined;
		ObjectDefineProperty(bytes, "buffer", { configurable: true, value: buffer });
		ObjectDefineProperty(bytes, "byteLength", { configurable: true, value: 32 });
		ReflectApply(CryptoGetRandomValues, globalThis.crypto, [bytes]);
		const parsed = parseGenerationId(bytesToLowerHex(bytes));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

async function reopenDurableState(
	captured: CapturedInput,
	trustStore: ReturnType<typeof createCurrentAnchorTrustStore>
): Promise<DurableStateSnapshot | undefined> {
	try {
		const opened = snapshotOpenedTrust(await trustStore.open(), captured.objectId);
		if (opened === undefined) return undefined;
		const recoveredResult = snapshotStoreResult(await captured.store.recoverActiveGeneration(captured.objectId));
		if (recoveredResult?.ok !== true) return undefined;
		const recovered = snapshotClosedRecord(recoveredResult.value, ACTIVE_RECOVERY_KEYS);
		if (recovered === undefined || recovered.kind !== "active") return undefined;
		const head = copiedPresentHead(recovered.head, captured.objectId);
		const references = copiedGenerationRefs(recovered.references);
		if (
			head === undefined ||
			!sameHead(head, opened.head) ||
			references === undefined ||
			recovered.recomputedClosureDigest !== head.closureDigest
		) {
			return undefined;
		}
		const candidates: Array<Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>> = [];
		let evidenceValid = true;
		let index = 0;
		while (index < references.length) {
			const ref = references[index] as GenerationRef;
			const loaded = snapshotStoreResult(await captured.store.getBlob(ref.digest));
			const bytes = loaded?.ok === true ? copyDetachedBytes(loaded.value) : undefined;
			const digest = bytes === undefined ? undefined : digestBlob(bytes);
			const copiedRef = copiedGenerationRef(ref.digest, ref.byteLength);
			if (
				bytes === undefined ||
				bytes.byteLength !== ref.byteLength ||
				digest?.ok !== true ||
				digest.value !== ref.digest ||
				copiedRef === undefined
			) {
				evidenceValid = false;
				index += 1;
				continue;
			}
			if (!defineDenseElement(candidates, index, ObjectFreeze({ bytes, ref: copiedRef }))) {
				evidenceValid = false;
			}
			index += 1;
		}
		const adopted = copiedGenerationRecord(recovered.adoptedGeneration, {
			closure: references,
			generationId: head.generationId,
			objectId: captured.objectId,
			state: "Adopted",
		});
		if (!evidenceValid || adopted === undefined || adopted.closureDigest !== head.closureDigest) return undefined;
		const frozenCandidates = finishDenseArray(candidates, references.length);
		return frozenCandidates === undefined
			? undefined
			: ObjectFreeze({ ...opened, candidates: frozenCandidates, head, references });
	} catch {
		return undefined;
	}
}

interface PreparedV3LiveMintInput {
	readonly admission: PreparedBlueprintAdmission;
	readonly byteCharge: number;
	readonly captured: CapturedInput;
	readonly catalog: CatalogSnapshot;
	readonly charges: Map<string, number>;
	readonly durableProjectionBytes: Uint8Array;
	readonly liveStateRef: GenerationRef;
	readonly order: readonly string[];
	readonly parameters: AcceptedParameters;
	readonly projectionDigest: BlobDigest;
	readonly proposedClosure: readonly GenerationRef[];
	readonly provenance: ProvenanceSnapshot;
	readonly runtime: PreparedBlueprintRuntime;
	readonly vertices: Map<string, unknown>;
}

interface PreparedV3LiveMint {
	readonly capability: PreparedV3Live;
	readonly descriptor: V3LiveDescriptor;
	readonly payload: PreparedV3LivePayload;
}

function buildPreparedV3LiveMint(
	input: PreparedV3LiveMintInput,
	durable: DurableStateSnapshot
): PreparedV3LiveMint | PrepareV3LiveResult {
	let durableProjection: Uint8Array | undefined;
	let index = 0;
	while (index < durable.candidates.length) {
		const candidate = durable.candidates[index];
		if (candidate?.ref.digest === input.liveStateRef.digest) durableProjection = candidate.bytes;
		index += 1;
	}
	if (durableProjection === undefined || !sameBytes(durableProjection, input.durableProjectionBytes)) {
		return failure("stale-head", "durable creator projection does not match");
	}
	const descriptor = ObjectFreeze({
		objectId: input.provenance.objectId,
		epoch: input.provenance.epoch,
		anchorDigest: input.provenance.anchorDigest,
		blueprintDigest: input.provenance.blueprintDigest,
		parametersDigest: input.provenance.parametersDigest,
		profileDigest: input.provenance.profileDigest,
		signerSetDigest: input.provenance.signerSetDigest,
		artifactDigest: input.catalog.artifactDigest,
		artifactId: input.catalog.artifactId,
		catalogDigest: input.catalog.catalogDigest,
		runtimeProfile: input.catalog.runtimeProfile,
		trustProfile: "creator-only" as const,
		trustRef: ObjectFreeze({ ...durable.trustRef }),
		maxEpochVertices: input.parameters.maxEpochVertices,
		maxEpochBytes: input.parameters.maxEpochBytes,
		maxDependencies: input.parameters.maxDependencies,
		vertexCount: 1 as const,
		byteCharge: input.byteCharge,
		projectionDigest: input.projectionDigest,
		head: ObjectFreeze({ ...durable.head }),
	}) satisfies V3LiveDescriptor;
	const capability = ObjectFreeze({}) as PreparedV3Live;
	const payload = ObjectFreeze({
		admission: input.admission,
		catalog: input.catalog,
		charges: input.charges,
		exactProjectionBytes: new Uint8ArrayConstructor(input.durableProjectionBytes),
		input: input.captured,
		liveStateRef: input.liveStateRef,
		order: input.order,
		parameters: input.parameters,
		provenance: input.provenance,
		proposedClosure: input.proposedClosure,
		runtime: input.runtime,
		trust: durable,
		vertices: input.vertices,
	}) satisfies PreparedV3LivePayload;
	return ObjectFreeze({ capability, descriptor, payload });
}

type StagePreparedGenerationResult =
	| Readonly<{ readonly ok: true; readonly swapResult: StoreResultSnapshot | undefined }>
	| Readonly<{ readonly ok: false; readonly result: PrepareV3LiveResult }>;

async function stagePreparedGeneration(
	captured: CapturedInput,
	current: DurableStateSnapshot,
	proposedClosure: readonly GenerationRef[],
	proposedClosureDigest: string,
	liveStateRef: GenerationRef,
	projectionBytesForStage: Uint8Array
): Promise<StagePreparedGenerationResult> {
	const generationId = freshGenerationId();
	if (generationId === undefined) {
		return ObjectFreeze({
			ok: false as const,
			result: failure("storage-failed", "creator generation identity could not be derived"),
		});
	}
	try {
		const begun = snapshotStoreResult(
			await captured.store.beginGeneration({
				baseExpectedHead: current.head,
				closure: proposedClosure,
				generationId,
				objectId: captured.objectId,
			})
		);
		const begunRecord =
			begun?.ok === true
				? copiedGenerationRecord(begun.value, {
						baseExpectedHead: current.head,
						closure: proposedClosure,
						generationId,
						objectId: captured.objectId,
						state: "Staged",
					})
				: undefined;
		if (begunRecord === undefined || begunRecord.closureDigest !== proposedClosureDigest) {
			return ObjectFreeze({
				ok: false as const,
				result: failure("storage-failed", "creator generation staging failed"),
			});
		}
		const cached = snapshotStoreResult(
			await captured.store.putCachedBlob({
				bytes: projectionBytesForStage,
				digest: liveStateRef.digest,
				generationId,
				objectId: captured.objectId,
			})
		);
		const cachedValue = cached?.ok === true ? snapshotClosedRecord(cached.value, ["inserted"]) : undefined;
		if (cachedValue === undefined || typeof cachedValue.inserted !== "boolean") {
			return ObjectFreeze({
				ok: false as const,
				result: failure("storage-failed", "creator projection staging failed"),
			});
		}
		let index = 0;
		while (index < proposedClosure.length) {
			const promoted = snapshotStoreResult(
				await captured.store.promoteReference({
					digest: (proposedClosure[index] as GenerationRef).digest,
					generationId,
					objectId: captured.objectId,
				})
			);
			if (promoted?.ok !== true || promoted.value !== undefined) {
				return ObjectFreeze({
					ok: false as const,
					result: failure("storage-failed", "creator reference promotion failed"),
				});
			}
			index += 1;
		}
		const completed = snapshotStoreResult(
			await captured.store.completeGeneration({ generationId, objectId: captured.objectId })
		);
		const completedRecord =
			completed?.ok === true
				? copiedGenerationRecord(completed.value, {
						baseExpectedHead: current.head,
						closure: proposedClosure,
						generationId,
						objectId: captured.objectId,
						state: "Complete",
					})
				: undefined;
		if (completedRecord === undefined || completedRecord.closureDigest !== begunRecord.closureDigest) {
			return ObjectFreeze({
				ok: false as const,
				result: failure("storage-failed", "creator generation completion failed"),
			});
		}
		const expectedRevision = parseHeadRevision(current.head.revision + 1);
		if (!expectedRevision.ok) {
			return ObjectFreeze({
				ok: false as const,
				result: failure("storage-failed", "creator head revision is invalid"),
			});
		}
		let swapResult: StoreResultSnapshot | undefined;
		try {
			swapResult = snapshotStoreResult(
				await captured.store.swapHead({
					expectedHead: current.head,
					generationId,
					objectId: captured.objectId,
				})
			);
		} catch {
			swapResult = undefined;
		}
		return ObjectFreeze({ ok: true as const, swapResult });
	} catch {
		return ObjectFreeze({
			ok: false as const,
			result: failure("storage-failed", "creator generation staging failed"),
		});
	}
}

/**
 * Authenticates, preserves and stages one creator generation through the private A-c boundary.
 * @param input - Closed creator preparation input.
 * @returns A frozen preparation result; live activation remains deferred.
 */
async function prepareV3LiveGeneration(input: PrepareV3LiveGenerationInput): Promise<PrepareV3LiveResult> {
	const captured = captureInput(input);
	if (captured === undefined) return failure("malformed-input", "creator preparation input is invalid");

	let openedTrust: OpenedTrustSnapshot;
	let trustStore: ReturnType<typeof createCurrentAnchorTrustStore>;
	try {
		trustStore = createCurrentAnchorTrustStore({
			objectId: captured.objectId,
			pinnedGenesisAnchorDigest: captured.pinnedGenesisAnchorDigest,
			store: captured.store,
		});
		const opened = await trustStore.open();
		const snapshot = snapshotOpenedTrust(opened, captured.objectId);
		if (snapshot === undefined) {
			return failure("trust-open-failed", "creator trust could not be opened");
		}
		openedTrust = snapshot;
	} catch {
		return failure("trust-open-failed", "creator trust could not be opened");
	}

	let provenance: ProvenanceSnapshot;
	try {
		const authenticated = authenticateCurrentEpochAnchor({
			detachedSignature: captured.detachedSignature,
			exactCanonicalAnchorPreimageBytes: captured.exactCanonicalAnchorPreimageBytes,
			trust: openedTrust.trust,
		});
		const snapshot = snapshotAuthenticatedProvenance(authenticated, captured.objectId);
		if (snapshot === undefined || snapshot.anchorDigest !== captured.pinnedGenesisAnchorDigest) {
			return failure("anchor-authentication-failed", "current anchor authentication failed");
		}
		provenance = snapshot;
	} catch {
		return failure("anchor-authentication-failed", "current anchor authentication failed");
	}
	try {
		const independentlyHashedAnchor = bytesToLowerHex(
			hashDomain("ts-drp/epoch-anchor/v3", captured.exactCanonicalAnchorPreimageBytes)
		);
		if (
			independentlyHashedAnchor !== captured.pinnedGenesisAnchorDigest ||
			independentlyHashedAnchor !== provenance.anchorDigest
		) {
			return failure("anchor-authentication-failed", "current anchor digest is invalid");
		}
	} catch {
		return failure("anchor-authentication-failed", "current anchor digest is invalid");
	}

	const parameters = acceptedParameterDigest(
		captured.exactCanonicalParametersCarrierBytes,
		provenance.parametersDigest
	);
	if (parameters === undefined) {
		return failure("parameters-rejected", "creator parameters are unsupported");
	}

	let catalog: CatalogSnapshot;
	try {
		const resolved = captured.catalog.resolve(provenance.blueprintDigest);
		const snapshot = snapshotCatalog(captured.catalog, resolved);
		if (
			snapshot === undefined ||
			snapshot.blueprintDigest !== provenance.blueprintDigest ||
			snapshot.runtimeProfile !== SUPPORTED_PARAMETER_PROFILE.runtimeProfile
		) {
			return failure("blueprint-unresolved", "trusted blueprint could not be resolved");
		}
		catalog = snapshot;
	} catch {
		return failure("blueprint-unresolved", "trusted blueprint could not be resolved");
	}

	let admission: PreparedBlueprintAdmission;
	try {
		admission = prepareBlueprintAdmission({
			canonicalBlueprintPackageBytes: catalog.canonicalBlueprintPackageBytes,
			expectedBlueprintDigest: provenance.blueprintDigest,
		});
	} catch {
		return failure("admission-rejected", "blueprint admission preparation failed");
	}
	if (!admissionMatches(admission, catalog.blueprintDigest)) {
		return failure("admission-rejected", "blueprint admission identity is invalid");
	}

	let runtime: PreparedBlueprintRuntime;
	try {
		runtime = await prepareBlueprintRuntime({
			canonicalBlueprintPackageBytes: catalog.canonicalBlueprintPackageBytes,
			exactArtifactBytes: catalog.exactArtifactBytes,
			expectedBlueprintDigest: provenance.blueprintDigest,
			preparedBlueprintAdmission: admission,
		});
	} catch {
		return failure("runtime-preparation-failed", "blueprint runtime preparation failed");
	}
	if (!runtimeMatches(runtime, catalog)) {
		return failure("runtime-preparation-failed", "blueprint runtime identity is invalid");
	}

	const byteCharge = typedArrayByteLength(captured.exactCanonicalAnchorPreimageBytes);
	if (
		byteCharge === undefined ||
		byteCharge < 1 ||
		byteCharge > parameters.maxEpochBytes ||
		parameters.maxEpochVertices < 1
	) {
		return failure("graph-rejected", "creator graph exceeds authenticated limits");
	}

	const dependencies = finishDenseArray<string>([], 0);
	const orderValues: string[] = [];
	if (dependencies === undefined || !defineDenseElement(orderValues, 0, provenance.anchorDigest)) {
		return failure("internal-invariant", "creator graph containers could not be constructed");
	}
	const order = finishDenseArray(orderValues, 1);
	if (order === undefined) return failure("internal-invariant", "creator graph containers could not be constructed");
	const vertex = ObjectFreeze({
		hash: provenance.anchorDigest,
		kind: "drp-epoch-anchor" as const,
		objectId: provenance.objectId,
		epoch: 0,
		dependencies: dependencies as string[],
	});
	const vertices = new IntrinsicMap<string, typeof vertex>();
	const charges = new IntrinsicMap<string, number>();
	try {
		ReflectApply(MapPrototypeSet, vertices, [provenance.anchorDigest, vertex]);
		ReflectApply(MapPrototypeSet, charges, [provenance.anchorDigest, byteCharge]);
	} catch {
		return failure("internal-invariant", "creator graph containers could not be constructed");
	}
	if (
		!isExactOwnedSingleEntryMap(vertices, provenance.anchorDigest, vertex) ||
		!isExactOwnedSingleEntryMap(charges, provenance.anchorDigest, byteCharge) ||
		order[0] !== provenance.anchorDigest
	) {
		return failure("graph-rejected", "creator graph ownership is invalid");
	}
	try {
		new CausalityIndex(vertices, order, {
			initialByteCharges: charges,
			maxEpochBytes: parameters.maxEpochBytes,
			maxEpochVertices: parameters.maxEpochVertices,
		});
	} catch (error) {
		return isLinearizationFailure(error)
			? failure("graph-rejected", "creator graph validation failed")
			: failure("internal-invariant", "creator graph validation failed unexpectedly");
	}

	let durableProjectionBytes: Uint8Array;
	let projectionDigest: BlobDigest;
	let liveStateRef: GenerationRef;
	let proposedClosure: readonly GenerationRef[];
	let proposedClosureDigest: string;
	try {
		const orderedVertexHashesPreimage = {
			kind: "v3-live-order-1",
			orderedVertexHashes: [provenance.anchorDigest],
		};
		const graphChargePreimage = {
			kind: "v3-live-graph-1",
			vertices: [
				{
					hash: provenance.anchorDigest,
					kind: "drp-epoch-anchor",
					objectId: provenance.objectId,
					epoch: 0,
					dependencies: [],
				},
			],
			charges: [{ hash: provenance.anchorDigest, byteCharge }],
		};
		const exactOrderPreimageBytes = encodeCanonical(orderedVertexHashesPreimage);
		const exactGraphChargePreimageBytes = encodeCanonical(graphChargePreimage);
		const orderedVertexHashesDigest = (digestBlob(exactOrderPreimageBytes) as { readonly value?: BlobDigest }).value;
		if (orderedVertexHashesDigest === undefined) {
			return failure("internal-invariant", "creator order digest could not be derived");
		}
		const graphDigest = (digestBlob(exactGraphChargePreimageBytes) as { readonly value?: BlobDigest }).value;
		if (graphDigest === undefined) {
			return failure("internal-invariant", "creator graph digest could not be derived");
		}
		const projectionRecord = {
			kind: "v3-live-generation-1",
			objectId: provenance.objectId,
			epoch: provenance.epoch,
			anchorDigest: provenance.anchorDigest,
			blueprintDigest: provenance.blueprintDigest,
			parametersDigest: provenance.parametersDigest,
			profileDigest: provenance.profileDigest,
			signerSetDigest: provenance.signerSetDigest,
			artifactDigest: catalog.artifactDigest,
			artifactId: catalog.artifactId,
			catalogDigest: catalog.catalogDigest,
			runtimeProfile: catalog.runtimeProfile,
			trustProfile: "creator-only",
			maxEpochVertices: parameters.maxEpochVertices,
			maxEpochBytes: parameters.maxEpochBytes,
			maxDependencies: parameters.maxDependencies,
			vertexCount: 1,
			byteCharge,
			orderedVertexHashesDigest,
			graphDigest,
		};
		const exactProjectionBytes = encodeCanonical(projectionRecord);
		const derivedProjectionDigest = (digestBlob(exactProjectionBytes) as { readonly value?: BlobDigest }).value;
		const projectionByteLength = typedArrayByteLength(exactProjectionBytes);
		const trustRef = copiedGenerationRef(openedTrust.trustRef.digest, openedTrust.trustRef.byteLength);
		const derivedLiveStateRef = copiedGenerationRef(derivedProjectionDigest, projectionByteLength);
		if (trustRef === undefined || derivedLiveStateRef === undefined || trustRef.digest === derivedLiveStateRef.digest) {
			return failure("internal-invariant", "creator live projection reference is invalid");
		}
		const proposedClosureValues: GenerationRef[] = [];
		const firstRef = trustRef.digest < derivedLiveStateRef.digest ? trustRef : derivedLiveStateRef;
		const secondRef = firstRef === trustRef ? derivedLiveStateRef : trustRef;
		if (
			!defineDenseElement(proposedClosureValues, 0, firstRef) ||
			!defineDenseElement(proposedClosureValues, 1, secondRef)
		) {
			return failure("internal-invariant", "creator closure could not be constructed");
		}
		const frozenClosure = finishDenseArray(proposedClosureValues, 2);
		if (frozenClosure === undefined) {
			return failure("internal-invariant", "creator closure could not be constructed");
		}
		const closureDigest = digestClosure(frozenClosure);
		if (!closureDigest.ok) return failure("internal-invariant", "creator closure digest could not be derived");
		projectionDigest = derivedLiveStateRef.digest;
		liveStateRef = derivedLiveStateRef;
		proposedClosure = frozenClosure;
		proposedClosureDigest = closureDigest.value;
		durableProjectionBytes = exactProjectionBytes;
	} catch {
		return failure("internal-invariant", "creator graph projection could not be derived");
	}

	const mintInput = ObjectFreeze({
		admission,
		byteCharge,
		captured,
		catalog,
		charges,
		durableProjectionBytes,
		liveStateRef,
		order,
		parameters,
		projectionDigest,
		proposedClosure,
		provenance,
		runtime,
		vertices,
	}) satisfies PreparedV3LiveMintInput;
	let carried: DurableStateSnapshot | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let current = carried;
		let stagedHead: PresentHead | undefined;
		let swapResult: StoreResultSnapshot | undefined;
		let awaitingOutcome = false;
		carried = undefined;
		while (true) {
			if (current === undefined) current = await reopenDurableState(captured, trustStore);
			if (current === undefined) return failure("storage-failed", "creator durable state could not be reopened");
			const trustOnlyValues: GenerationRef[] = [];
			const copiedTrustRef = copiedGenerationRef(current.trustRef.digest, current.trustRef.byteLength);
			if (copiedTrustRef === undefined || !defineDenseElement(trustOnlyValues, 0, copiedTrustRef)) {
				return failure("internal-invariant", "creator trust closure could not be copied");
			}
			const trustOnly = finishDenseArray(trustOnlyValues, 1);
			if (trustOnly === undefined) return failure("internal-invariant", "creator trust closure could not be copied");
			if (sameClosure(current.references, proposedClosure)) {
				const mint = buildPreparedV3LiveMint(mintInput, current);
				if ("ok" in mint) return mint;
				const capability = mint.capability;
				preparedV3LiveAuthority.set(capability, mint.payload);
				return ObjectFreeze({ capability, descriptor: mint.descriptor, ok: true as const });
			}
			if (!sameClosure(current.references, trustOnly)) {
				return failure("stale-head", "creator durable head is not an exact preparation predecessor");
			}
			if (awaitingOutcome) {
				if (stagedHead === undefined || !sameHead(current.head, stagedHead)) {
					return failure("stale-head", "another creator generation became authoritative");
				}
				const definiteLoss = swapResult?.ok === false && swapResult.reason === "HEAD_CONFLICT";
				if (!definiteLoss) return failure("storage-failed", "creator head swap outcome is ambiguous");
				if (attempt === 1) return failure("stale-head", "creator head swap lost twice");
				carried = current;
				break;
			}

			const candidates: Array<Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>> = [];
			let closureIndex = 0;
			while (closureIndex < proposedClosure.length) {
				const ref = proposedClosure[closureIndex] as GenerationRef;
				let bytes: Uint8Array | undefined;
				if (ref.digest === liveStateRef.digest) {
					bytes = copyDetachedBytes(durableProjectionBytes);
				} else {
					let candidateIndex = 0;
					while (candidateIndex < current.candidates.length) {
						const candidate = current.candidates[candidateIndex];
						if (candidate?.ref.digest === ref.digest) bytes = copyDetachedBytes(candidate.bytes);
						candidateIndex += 1;
					}
				}
				const copiedRef = copiedGenerationRef(ref.digest, ref.byteLength);
				if (
					bytes === undefined ||
					copiedRef === undefined ||
					!defineDenseElement(candidates, closureIndex, ObjectFreeze({ bytes, ref: copiedRef }))
				) {
					return failure("internal-invariant", "creator preservation candidates could not be copied");
				}
				closureIndex += 1;
			}
			const frozenCandidates = finishDenseArray(candidates, proposedClosure.length);
			const closureForPreservation = copiedGenerationRefs(proposedClosure);
			const expectedTrustRef = copiedGenerationRef(current.trustRef.digest, current.trustRef.byteLength);
			const projectionBytesForStage = copyDetachedBytes(durableProjectionBytes);
			if (
				frozenCandidates === undefined ||
				closureForPreservation === undefined ||
				expectedTrustRef === undefined ||
				projectionBytesForStage === undefined
			) {
				return failure("internal-invariant", "creator preservation input could not be copied");
			}
			let preserved: unknown;
			try {
				preserved = assertTrustPreserved({
					candidates: frozenCandidates,
					closure: closureForPreservation,
					expectedTrustRef,
				});
			} catch {
				return failure("trust-not-preserved", "creator trust preservation failed");
			}
			const preservation = snapshotClosedRecord(preserved, ["exactCanonicalTrustStateRecordBytes", "ok", "trustRef"]);
			const preservedRef =
				preservation === undefined ? undefined : snapshotClosedRecord(preservation.trustRef, TRUST_REF_KEYS);
			if (
				preservation?.ok !== true ||
				copyDetachedBytes(preservation.exactCanonicalTrustStateRecordBytes) === undefined ||
				preservedRef === undefined ||
				preservedRef.digest !== expectedTrustRef.digest ||
				preservedRef.byteLength !== expectedTrustRef.byteLength
			) {
				return failure("trust-not-preserved", "creator trust preservation failed");
			}

			const staged = await stagePreparedGeneration(
				captured,
				current,
				proposedClosure,
				proposedClosureDigest,
				liveStateRef,
				projectionBytesForStage
			);
			if (!staged.ok) return staged.result;
			stagedHead = current.head;
			swapResult = staged.swapResult;
			awaitingOutcome = true;
			current = undefined;
		}
	}

	return failure("internal-invariant", "creator preparation exhausted unexpectedly");
}

export { prepareV3LiveGeneration };

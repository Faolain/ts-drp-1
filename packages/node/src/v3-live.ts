import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CausalityIndex } from "@ts-drp/compaction";
import { createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
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
	type GenerationRef,
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

interface AcceptedParameters {
	readonly maxDependencies: number;
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
}

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
		return new Uint8ArrayConstructor(value as Uint8Array);
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

/**
 * Authenticates and prepares one creator generation through the graph/projection A-b boundary.
 * @param input - Closed creator preparation input.
 * @returns A frozen stage result; A-b intentionally ends before trust preservation and staging.
 */
export async function prepareV3LiveGeneration(input: PrepareV3LiveGenerationInput): Promise<PrepareV3LiveResult> {
	const captured = captureInput(input);
	if (captured === undefined) return failure("malformed-input", "creator preparation input is invalid");

	let openedTrust: OpenedTrustSnapshot;
	try {
		const trustStore = createCurrentAnchorTrustStore({
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
		const projectionDigest = (digestBlob(exactProjectionBytes) as { readonly value?: BlobDigest }).value;
		const projectionByteLength = typedArrayByteLength(exactProjectionBytes);
		const trustRef = copiedGenerationRef(openedTrust.trustRef.digest, openedTrust.trustRef.byteLength);
		const liveStateRef = copiedGenerationRef(projectionDigest, projectionByteLength);
		if (trustRef === undefined || liveStateRef === undefined || trustRef.digest === liveStateRef.digest) {
			return failure("internal-invariant", "creator live projection reference is invalid");
		}
		const proposedClosure: GenerationRef[] = [];
		const firstRef = trustRef.digest < liveStateRef.digest ? trustRef : liveStateRef;
		const secondRef = firstRef === trustRef ? liveStateRef : trustRef;
		if (
			!defineDenseElement(proposedClosure, 0, firstRef) ||
			!defineDenseElement(proposedClosure, 1, secondRef) ||
			finishDenseArray(proposedClosure, 2) === undefined
		) {
			return failure("internal-invariant", "creator closure could not be constructed");
		}
		const closureDigest = digestClosure(proposedClosure);
		if (!closureDigest.ok) return failure("internal-invariant", "creator closure digest could not be derived");
	} catch {
		return failure("internal-invariant", "creator graph projection could not be derived");
	}

	return failure("trust-not-preserved", "creator trust preservation is deferred to A-c");
}

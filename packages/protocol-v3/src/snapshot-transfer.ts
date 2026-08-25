import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

export const SNAPSHOT_MANIFEST_MAX_BYTES = 212_387 as const;

const MANIFEST_DOMAIN = "ts-drp/snapshot-manifest/v3";
const CHUNK_DOMAIN = "ts-drp/snapshot-chunk/v3";
const MANIFEST_FIELDS = Object.freeze([
	"aclDigest",
	"anchor",
	"chunks",
	"encodingVersion",
	"epoch",
	"kind",
	"objectId",
	"payloadDigest",
	"protocolMajor",
	"schemaVersion",
	"stateDigest",
	"totalBytes",
] as const);
const CHUNK_FIELDS = Object.freeze(["byteLength", "digest", "index"] as const);
const intrinsicArrayBuffer = ArrayBuffer;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicObjectPrototype = Object.prototype;
const intrinsicReflectApply = Reflect.apply;
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBuffer.prototype,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
const intrinsicArrayBufferResizableGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBuffer.prototype,
	"resizable"
)?.get as ((this: ArrayBuffer) => boolean) | undefined;
const intrinsicTypedArrayPrototype = intrinsicObjectGetPrototypeOf(intrinsicUint8ArrayPrototype);
const intrinsicTypedArrayBufferGetter = intrinsicObjectGetOwnPropertyDescriptor(intrinsicTypedArrayPrototype, "buffer")
	?.get as (this: Uint8Array) => ArrayBufferLike;
const intrinsicTypedArrayByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	"byteLength"
)?.get as (this: Uint8Array) => number;
const intrinsicTypedArrayByteOffsetGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicTypedArrayPrototype,
	"byteOffset"
)?.get as (this: Uint8Array) => number;

export interface SnapshotChunkDescriptor {
	readonly byteLength: number;
	readonly digest: string;
	readonly index: number;
}

export interface SnapshotTransferProfile {
	readonly maxManifestBytes: 212_387;
	readonly maxSnapshotBytes: 268_435_456;
	readonly snapshotChunkBytes: 131_072;
}

export interface DecodedSnapshotManifest {
	readonly chunks: readonly SnapshotChunkDescriptor[];
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly manifest: Readonly<Record<string, unknown>>;
	readonly manifestDigest: string;
}

type SnapshotManifestFailureCode =
	| "manifest-digest-mismatch"
	| "manifest-invalid"
	| "manifest-noncanonical"
	| "manifest-too-large";

class SnapshotManifestError extends TypeError {
	readonly code: SnapshotManifestFailureCode;

	constructor(code: SnapshotManifestFailureCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
	}
}

function hex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function assertDigest(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
		throw new SnapshotManifestError("manifest-invalid", `${name} must be a lowercase 32-byte digest`);
	}
}

function assertProfile(profile: SnapshotTransferProfile): void {
	if (
		profile.maxManifestBytes !== SNAPSHOT_MANIFEST_MAX_BYTES ||
		profile.maxSnapshotBytes !== 268_435_456 ||
		profile.snapshotChunkBytes !== 131_072
	) {
		throw new SnapshotManifestError("manifest-invalid", "snapshot transfer profile is invalid");
	}
}

function exactByteLength(input: Uint8Array): number {
	try {
		return intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, input, []);
	} catch (error) {
		throw new SnapshotManifestError("manifest-invalid", "manifest carrier is unreadable", { cause: error });
	}
}

function intrinsicReadableView(input: Uint8Array, name: string): Uint8Array {
	try {
		if (intrinsicObjectGetPrototypeOf(input) !== intrinsicUint8ArrayPrototype) {
			throw new TypeError(`${name} must be an unshared Uint8Array`);
		}
		const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, input, []);
		const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, input, []);
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, input, []);
		if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBuffer.prototype) {
			throw new TypeError(`${name} must be unshared`);
		}
		intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
		const resizable =
			intrinsicArrayBufferResizableGetter === undefined
				? false
				: intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []);
		if (resizable) throw new TypeError(`${name} must be non-resizable`);
		return new intrinsicUint8Array(buffer, byteOffset, byteLength);
	} catch (error) {
		if (error instanceof TypeError && error.message.startsWith(name)) throw error;
		throw new TypeError(`${name} is unreadable`, { cause: error });
	}
}

function copyExactCarrier(input: Uint8Array, name: string, allowEmpty = false): Uint8Array {
	try {
		if (intrinsicObjectGetPrototypeOf(input) !== intrinsicUint8ArrayPrototype) {
			throw new TypeError(`${name} must be an unshared Uint8Array`);
		}
		const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, input, []);
		const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, input, []);
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, input, []);
		if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBuffer.prototype) {
			throw new TypeError(`${name} must be unshared`);
		}
		const bufferByteLength = intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
		const resizable =
			intrinsicArrayBufferResizableGetter === undefined
				? false
				: intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []);
		if ((!allowEmpty && byteLength === 0) || byteOffset !== 0 || byteLength !== bufferByteLength || resizable) {
			throw new TypeError(`${name} must use one full, attached, non-resizable buffer`);
		}
		const output = new intrinsicUint8Array(byteLength);
		intrinsicReflectApply(intrinsicUint8ArraySet, output, [input]);
		return output;
	} catch (error) {
		if (error instanceof TypeError && error.message.startsWith(name)) throw error;
		throw new TypeError(`${name} is unreadable`, { cause: error });
	}
}

function exactRecord(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new SnapshotManifestError("manifest-invalid", `${name} must be an ordinary record`);
	}
	const prototype = intrinsicObjectGetPrototypeOf(value);
	if (prototype !== null && prototype !== intrinsicObjectPrototype) {
		throw new SnapshotManifestError("manifest-invalid", `${name} must be an ordinary record`);
	}
	const keys = intrinsicReflectOwnKeys(value);
	if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
		throw new SnapshotManifestError("manifest-invalid", `${name} fields are invalid`);
	}
	const output: Record<string, unknown> = {};
	for (const field of fields) {
		const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, field);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			throw new SnapshotManifestError("manifest-invalid", `${name}.${field} must be an enumerable data property`);
		}
		output[field] = descriptor.value;
	}
	return output;
}

function safeInteger(value: unknown, minimum: number, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new SnapshotManifestError("manifest-invalid", `${name} is invalid`);
	}
	return value;
}

function decodeRecord(bytes: Uint8Array): Record<string, unknown> {
	let value: unknown;
	try {
		value = decodeCanonical(bytes, { maxBytes: SNAPSHOT_MANIFEST_MAX_BYTES });
	} catch (error) {
		throw new SnapshotManifestError("manifest-noncanonical", "manifest canonical bytes are invalid", {
			cause: error,
		});
	}
	let canonical: Uint8Array;
	try {
		canonical = encodeCanonical(value, { maxBytes: SNAPSHOT_MANIFEST_MAX_BYTES });
	} catch (error) {
		throw new SnapshotManifestError("manifest-invalid", "manifest value is outside the canonical profile", {
			cause: error,
		});
	}
	if (compareBytes(bytes, canonical) !== 0) {
		throw new SnapshotManifestError("manifest-noncanonical", "manifest bytes are not canonical");
	}
	return exactRecord(value, MANIFEST_FIELDS, "manifest");
}

/** Decodes and validates one externally authenticated frozen snapshot manifest. */
export function decodeSnapshotManifest(input: {
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly expectedManifestDigest: string;
	readonly profile: SnapshotTransferProfile;
}): DecodedSnapshotManifest {
	const exactCanonicalManifestBytes = input.exactCanonicalManifestBytes;
	const expectedManifestDigest = input.expectedManifestDigest;
	const suppliedProfile = input.profile;
	const profile: SnapshotTransferProfile = Object.freeze({
		maxManifestBytes: suppliedProfile.maxManifestBytes,
		maxSnapshotBytes: suppliedProfile.maxSnapshotBytes,
		snapshotChunkBytes: suppliedProfile.snapshotChunkBytes,
	});
	assertProfile(profile);
	const carrierLength = exactByteLength(exactCanonicalManifestBytes);
	if (carrierLength > SNAPSHOT_MANIFEST_MAX_BYTES) {
		throw new SnapshotManifestError("manifest-too-large", "manifest exceeds the pre-copy byte limit");
	}
	let bytes: Uint8Array;
	try {
		bytes = copyExactCarrier(exactCanonicalManifestBytes, "manifest carrier");
	} catch (error) {
		throw new SnapshotManifestError("manifest-invalid", "manifest carrier is invalid", { cause: error });
	}
	assertDigest(expectedManifestDigest, "expectedManifestDigest");
	const manifestDigest = hex(hashDomain(MANIFEST_DOMAIN, bytes));
	if (manifestDigest !== expectedManifestDigest) {
		throw new SnapshotManifestError("manifest-digest-mismatch", "manifest digest does not match exact bytes");
	}
	const manifest = decodeRecord(bytes);
	if (
		manifest.kind !== "drp-snapshot-manifest" ||
		manifest.protocolMajor !== 3 ||
		manifest.encodingVersion !== "drp-canonical-profile-1"
	) {
		throw new SnapshotManifestError("manifest-invalid", "manifest discriminator is invalid");
	}
	if (typeof manifest.objectId !== "string" || manifest.objectId.length < 1 || manifest.objectId.length > 1024) {
		throw new SnapshotManifestError("manifest-invalid", "manifest.objectId is invalid");
	}
	safeInteger(manifest.epoch, 0, "manifest.epoch");
	safeInteger(manifest.schemaVersion, 1, "manifest.schemaVersion");
	assertDigest(manifest.anchor, "manifest.anchor");
	assertDigest(manifest.stateDigest, "manifest.stateDigest");
	assertDigest(manifest.aclDigest, "manifest.aclDigest");
	assertDigest(manifest.payloadDigest, "manifest.payloadDigest");
	const totalBytes = safeInteger(manifest.totalBytes, 1, "manifest.totalBytes");
	if (totalBytes > profile.maxSnapshotBytes) {
		throw new SnapshotManifestError("manifest-invalid", "manifest.totalBytes exceeds the authenticated limit");
	}
	const manifestChunks = manifest.chunks;
	if (!Array.isArray(manifestChunks) || manifestChunks.length < 1 || manifestChunks.length > 2_048) {
		throw new SnapshotManifestError("manifest-invalid", "manifest.chunks count is invalid");
	}
	let sum = 0;
	const chunks = manifestChunks.map((value, index): SnapshotChunkDescriptor => {
		const chunk = exactRecord(value, CHUNK_FIELDS, `manifest.chunks[${index}]`);
		const chunkIndex = safeInteger(chunk.index, 0, `manifest.chunks[${index}].index`);
		if (chunkIndex !== index) {
			throw new SnapshotManifestError("manifest-invalid", "manifest chunk indices must be contiguous");
		}
		assertDigest(chunk.digest, `manifest.chunks[${index}].digest`);
		const byteLength = safeInteger(chunk.byteLength, 1, `manifest.chunks[${index}].byteLength`);
		const final = index === manifestChunks.length - 1;
		if ((!final && byteLength !== profile.snapshotChunkBytes) || byteLength > profile.snapshotChunkBytes) {
			throw new SnapshotManifestError("manifest-invalid", "manifest chunk length is invalid");
		}
		sum += byteLength;
		if (!Number.isSafeInteger(sum) || sum > profile.maxSnapshotBytes) {
			throw new SnapshotManifestError("manifest-invalid", "manifest chunk sum exceeds the authenticated limit");
		}
		return Object.freeze({ byteLength, digest: chunk.digest, index: chunkIndex });
	});
	if (sum !== totalBytes) {
		throw new SnapshotManifestError("manifest-invalid", "manifest chunk lengths do not equal totalBytes");
	}
	return Object.freeze({
		chunks: Object.freeze(chunks),
		exactCanonicalManifestBytes: bytes,
		manifest: Object.freeze({ ...manifest, chunks: Object.freeze(chunks) }),
		manifestDigest,
	});
}

/** Computes the frozen index-bound digest for one exact snapshot chunk. */
export function snapshotChunkDigest(index: number, exactBytes: Uint8Array): string {
	if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("snapshot chunk index is invalid");
	const bytes = intrinsicReadableView(exactBytes, "snapshot chunk bytes");
	return hex(hashDomain(CHUNK_DOMAIN, encodeCanonical(index), bytes));
}

import { ed25519 } from "@noble/curves/ed25519.js";
import {
	CanonicalDecodingError,
	compareBytes,
	decodeCanonical,
	deepCloneCanonical,
	encodeCanonical,
	hashDomain,
} from "@ts-drp/canonical";
import { DRPError } from "@ts-drp/errors";
import { init as initializeModuleLexer, parse as parseModule } from "es-module-lexer";

import registryJson from "../registry/registry-v1.json" with { type: "json" };
import {
	type CertifiedSealAuthorityMaterial,
	certifiedSealAuthorityResolver,
	creatorAnchorTrustCheckpointPredecessorMinter,
	type CreatorAnchorTrustMaterial,
	creatorAnchorTrustResolver,
	creatorAnchorTrustSuccessorMinter,
} from "./internal/seal-authority-custody.js";
import blueprintArtifactProfileJson from "../supplements/blueprint-artifact-profile-v1/profile.json" with { type: "json" };

const intrinsicArray = Array;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicFloat32Array = Float32Array;
const intrinsicFloat64Array = Float64Array;
const intrinsicFunctionBind = Function.prototype.bind;
const intrinsicInt32Array = Int32Array;
const intrinsicMap = Map;
const intrinsicMapEntries = Map.prototype.entries;
const intrinsicMapSet = Map.prototype.set;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectDefineProperty = Object.defineProperty;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicObjectHasOwn = Object.hasOwn;
const intrinsicObjectPrototype = Object.prototype;
const intrinsicReflectApply = Reflect.apply;
const intrinsicReflectGet = Reflect.get;
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const intrinsicSet = Set;
const intrinsicSetAdd = Set.prototype.add;
const intrinsicSetHas = Set.prototype.has;
const intrinsicSetValues = Set.prototype.values;
const intrinsicString = String;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint32Array = Uint32Array;
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
const intrinsicArrayBufferPrototype = ArrayBuffer.prototype;
const intrinsicArrayBufferResizableGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
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
const intrinsicMapIteratorNext = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicObjectGetPrototypeOf(intrinsicReflectApply(intrinsicMapEntries, new intrinsicMap(), [])),
	"next"
)?.value as (this: MapIterator<unknown>) => IteratorResult<unknown>;
const intrinsicSetIteratorNext = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicObjectGetPrototypeOf(intrinsicReflectApply(intrinsicSetValues, new intrinsicSet(), [])),
	"next"
)?.value as (this: SetIterator<unknown>) => IteratorResult<unknown>;
const intrinsicSharedArrayBufferByteLengthGetter =
	typeof SharedArrayBuffer === "undefined"
		? undefined
		: intrinsicObjectGetOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

interface RegistryField {
	readonly name: string;
	readonly type: string;
	readonly const: unknown;
	readonly constraints: Readonly<Record<string, unknown>>;
	readonly required: boolean;
	readonly sortRule: string | null;
}

interface ProtocolRegistry {
	readonly domains: Readonly<Record<string, string>>;
	readonly kinds: Readonly<
		Record<
			string,
			{
				readonly domain: string;
				readonly fields: readonly RegistryField[];
			}
		>
	>;
	readonly cryptoSuites: {
		readonly active: readonly {
			readonly role: string;
			readonly suiteId: string;
		}[];
	};
}

export interface RawEd25519PublicKey {
	readonly bytes: Uint8Array;
	readonly format: "raw";
}

export const ANCHOR_TRUST_STATE_MAX_RECORD_BYTES = 8192 as const;

export interface CurrentAnchorTrust {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly profileId: "creator-trusted-v1";
}

export interface CertifiedAnchorTrust {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: 0;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly profileId: "attested-bft-v1" | "delegated-trusted-v1";
	readonly quorum: number;
	readonly signerCount: number;
}

export interface InstallCertifiedAnchorTrustRootInput {
	readonly exactCanonicalCertifiedGenesisCertificateBytes: Uint8Array;
	readonly exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly pinnedGenesisAnchorDigest: string;
}

export type InstallCertifiedAnchorTrustRootFailureReason =
	| "malformed-input"
	| "anchor-decode-failed"
	| "noncanonical-anchor"
	| "anchor-schema-invalid"
	| "inactive-crypto-suite"
	| "not-genesis-anchor"
	| "object-id-invalid"
	| "object-id-too-long"
	| "genesis-pin-mismatch"
	| "profile-digest-mismatch"
	| "signer-set-digest-mismatch"
	| "unsupported-trust-profile"
	| "signer-set-profile-mismatch"
	| "invalid-quorum"
	| "too-many-signers"
	| "signer-id-too-long"
	| "certificate-decode-failed"
	| "noncanonical-certificate"
	| "certificate-schema-invalid"
	| "certificate-binding-mismatch"
	| "certificate-signer-mismatch"
	| "invalid-signature"
	| "trust-state-too-large";

export type InstallCertifiedAnchorTrustRootResult =
	| { readonly ok: false; readonly reason: InstallCertifiedAnchorTrustRootFailureReason }
	| {
			readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
			readonly ok: true;
			readonly trust: CertifiedAnchorTrust;
	  };

export interface OpenCertifiedAnchorTrustInput {
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly expectedObjectId: string;
	readonly pinnedGenesisAnchorDigest: string;
}

export type OpenCertifiedAnchorTrustFailureReason =
	| InstallCertifiedAnchorTrustRootFailureReason
	| "record-decode-failed"
	| "noncanonical-record"
	| "record-schema-invalid"
	| "unsupported-trust-state-version"
	| "object-id-mismatch"
	| "trust-state-inconsistent";

export type OpenCertifiedAnchorTrustResult =
	| { readonly ok: false; readonly reason: OpenCertifiedAnchorTrustFailureReason }
	| { readonly ok: true; readonly trust: CertifiedAnchorTrust };

export interface InstallCreatorAnchorTrustRootInput {
	readonly detachedGenesisSignature: Uint8Array;
	readonly exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly pinnedGenesisAnchorDigest: string;
}

export type InstallCreatorAnchorTrustRootFailureReason =
	| "malformed-input"
	| "anchor-decode-failed"
	| "noncanonical-anchor"
	| "anchor-schema-invalid"
	| "inactive-crypto-suite"
	| "not-genesis-anchor"
	| "object-id-invalid"
	| "genesis-pin-mismatch"
	| "signer-set-digest-mismatch"
	| "profile-digest-mismatch"
	| "unsupported-trust-profile"
	| "signer-set-profile-mismatch"
	| "trust-state-too-large"
	| "invalid-signature";

export type InstallCreatorAnchorTrustRootResult =
	| { readonly ok: false; readonly reason: InstallCreatorAnchorTrustRootFailureReason }
	| {
			readonly ok: true;
			readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
			readonly trust: CurrentAnchorTrust;
	  };

export interface OpenCurrentAnchorTrustInput {
	readonly exactCanonicalTrustStateRecordBytes: Uint8Array;
	readonly expectedObjectId: string;
	readonly pinnedGenesisAnchorDigest: string;
}

export type OpenCurrentAnchorTrustFailureReason =
	| "malformed-input"
	| "record-decode-failed"
	| "noncanonical-record"
	| "record-schema-invalid"
	| "unsupported-trust-state-version"
	| "object-id-mismatch"
	| "genesis-pin-mismatch"
	| "unsupported-trust-profile"
	| "trust-state-inconsistent"
	| "invalid-signature";

export type OpenCurrentAnchorTrustResult =
	| { readonly ok: false; readonly reason: OpenCurrentAnchorTrustFailureReason }
	| { readonly ok: true; readonly trust: CurrentAnchorTrust };

export interface AuthenticateCurrentEpochAnchorInput {
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly trust: CurrentAnchorTrust;
}

export type AuthenticateCurrentEpochAnchorFailureReason =
	| "malformed-input"
	| "untrusted-context"
	| "anchor-decode-failed"
	| "noncanonical-anchor"
	| "anchor-schema-invalid"
	| "inactive-crypto-suite"
	| "object-id-mismatch"
	| "epoch-mismatch"
	| "profile-digest-mismatch"
	| "signer-set-digest-mismatch"
	| "anchor-not-current"
	| "invalid-signature";

export type AuthenticateCurrentEpochAnchorSuccessProvenance = Readonly<{
	readonly anchorDigest: string;
	readonly blueprintDigest: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly profileDigest: string;
	readonly signerSetDigest: string;
}>;

export type AuthenticateCurrentEpochAnchorResult =
	| { readonly ok: false; readonly reason: AuthenticateCurrentEpochAnchorFailureReason }
	| {
			readonly ok: true;
			readonly provenance: AuthenticateCurrentEpochAnchorSuccessProvenance;
	  };

export type CurrentEpochAuthorAuthorization = Readonly<{
	readonly aclDigest: string;
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly profileId: "creator-author-authorization-v1";
}>;

export type OpenCurrentEpochAuthorAuthorizationInput = Readonly<{
	readonly detachedAnchorSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalAuthorAuthorizationBytes: Uint8Array;
	readonly trust: CurrentAnchorTrust;
}>;

export type OpenCurrentEpochAuthorAuthorizationResult =
	| Readonly<{ ok: false; reason: "malformed-input" }>
	| Readonly<{
			cause: AuthenticateCurrentEpochAnchorFailureReason;
			ok: false;
			reason: "anchor-rejected";
	  }>
	| Readonly<{
			ok: false;
			reason:
				| "acl-decode-failed"
				| "noncanonical-acl"
				| "acl-schema-invalid"
				| "unsupported-acl-version"
				| "unsupported-acl-profile"
				| "object-id-mismatch"
				| "epoch-mismatch"
				| "acl-digest-mismatch";
	  }>
	| Readonly<{
			authorization: CurrentEpochAuthorAuthorization;
			ok: true;
			provenance: AuthenticateCurrentEpochAnchorSuccessProvenance;
	  }>;

export type ResolveCurrentEpochAuthorizedAuthorInput = Readonly<{
	readonly authorization: CurrentEpochAuthorAuthorization;
	readonly author: string;
}>;

export type ResolveCurrentEpochAuthorizedAuthorResult =
	| Readonly<{ ok: false; reason: "malformed-input" | "untrusted-context" | "author-not-authorized" }>
	| Readonly<{ ok: true; publicKey: RawEd25519PublicKey }>;

interface AnchorTrustPrivateState {
	readonly exactCanonicalCurrentAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly detachedCurrentAnchorSignature: Uint8Array;
	readonly publicKey: Uint8Array;
	readonly profileDigest: string;
	readonly quorum: 1;
	readonly signerSetDigest: string;
}

interface CertifiedAnchorTrustPrivateState {
	readonly exactCanonicalCertifiedGenesisCertificateBytes: Uint8Array;
	readonly exactCanonicalCurrentAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
}

interface CurrentEpochAuthorAuthorizationPrivateState {
	readonly authors: ReadonlySet<string>;
}

interface AnchorTrustApi {
	authenticateCurrentEpochAnchor(input: AuthenticateCurrentEpochAnchorInput): AuthenticateCurrentEpochAnchorResult;
	installCertifiedAnchorTrustRoot(input: InstallCertifiedAnchorTrustRootInput): InstallCertifiedAnchorTrustRootResult;
	installCreatorAnchorTrustRoot(input: InstallCreatorAnchorTrustRootInput): InstallCreatorAnchorTrustRootResult;
	isAnchorTrustStateRecordBytes(bytes: Uint8Array): boolean;
	openCertifiedAnchorTrust(input: OpenCertifiedAnchorTrustInput): OpenCertifiedAnchorTrustResult;
	openCurrentEpochAuthorAuthorization(
		input: OpenCurrentEpochAuthorAuthorizationInput
	): OpenCurrentEpochAuthorAuthorizationResult;
	openCurrentAnchorTrust(input: OpenCurrentAnchorTrustInput): OpenCurrentAnchorTrustResult;
	resolveCurrentEpochAuthorizedAuthor(
		input: ResolveCurrentEpochAuthorizedAuthorInput
	): ResolveCurrentEpochAuthorizedAuthorResult;
	[certifiedSealAuthorityResolver](trust: CertifiedAnchorTrust): CertifiedSealAuthorityMaterial | undefined;
	[creatorAnchorTrustCheckpointPredecessorMinter](
		genesisTrust: CurrentAnchorTrust,
		exactCanonicalPredecessorAnchorPreimageBytes: Uint8Array,
		detachedPredecessorAnchorSignature: Uint8Array
	): CurrentAnchorTrust | undefined;
	[creatorAnchorTrustResolver](trust: CurrentAnchorTrust): CreatorAnchorTrustMaterial | undefined;
	[creatorAnchorTrustSuccessorMinter](
		currentTrust: CurrentAnchorTrust,
		exactCanonicalSuccessorAnchorPreimageBytes: Uint8Array,
		detachedSuccessorAnchorSignature: Uint8Array
	): CurrentAnchorTrust | undefined;
}

const ANCHOR_DIGEST_DOMAIN = "ts-drp/epoch-anchor/v3";
const PROFILE_DIGEST_DOMAIN = "ts-drp/profile/v3";
const SIGNER_SET_DIGEST_DOMAIN = "ts-drp/signer-set/v3";
const ACTIVE_ANCHOR_SUITE = "ed25519-sha256-v3";
const ACTIVE_CERTIFIED_PROFILE_SUITE = "ed25519-seal-v3";
const CREATOR_PROFILE = "creator-trusted-v1";
const CERTIFIED_CERTIFICATE_KIND = "drp-certified-genesis-certificate";
const CERTIFIED_TRUST_STATE_KIND = "drp-certified-anchor-trust-state";
const CERTIFIED_TRUST_STATE_VERSION = 1;
const MAXIMUM_CERTIFIED_OBJECT_ID_BYTES = 1024;
const MAXIMUM_CERTIFIED_SIGNER_ID_BYTES = 64;
const MAXIMUM_CERTIFIED_SIGNERS = 8;
const AUTHOR_AUTHORIZATION_DOMAIN = "ts-drp/author-authorization/v3";
const AUTHOR_AUTHORIZATION_KIND = "drp-author-authorization";
const AUTHOR_AUTHORIZATION_PROFILE = "creator-author-authorization-v1";
const AUTHOR_AUTHORIZATION_MAX_BYTES = 8192;
const ZERO_DIGEST = "0".repeat(64);
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/u;
const ANCHOR_TRUST_INPUT_KEYS = [
	"detachedGenesisSignature",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"pinnedGenesisAnchorDigest",
] as const;
const CERTIFIED_ANCHOR_TRUST_INPUT_KEYS = [
	"exactCanonicalCertifiedGenesisCertificateBytes",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"pinnedGenesisAnchorDigest",
] as const;
const CERTIFIED_ANCHOR_TRUST_BYTE_KEYS = new Set([
	"exactCanonicalCertifiedGenesisCertificateBytes",
	"exactCanonicalGenesisAnchorPreimageBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
]);
const OPEN_TRUST_INPUT_KEYS = [
	"exactCanonicalTrustStateRecordBytes",
	"expectedObjectId",
	"pinnedGenesisAnchorDigest",
] as const;
const AUTHENTICATE_ANCHOR_INPUT_KEYS = ["detachedSignature", "exactCanonicalAnchorPreimageBytes", "trust"] as const;
const OPEN_AUTHOR_AUTHORIZATION_INPUT_KEYS = [
	"detachedAnchorSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalAuthorAuthorizationBytes",
	"trust",
] as const;
const OPEN_AUTHOR_AUTHORIZATION_BYTE_KEYS = new Set([
	"detachedAnchorSignature",
	"exactCanonicalAnchorPreimageBytes",
	"exactCanonicalAuthorAuthorizationBytes",
]);
const RESOLVE_AUTHORIZED_AUTHOR_INPUT_KEYS = ["authorization", "author"] as const;
const AUTHOR_AUTHORIZATION_KEYS = [
	"authors",
	"epoch",
	"kind",
	"objectId",
	"profileId",
	"protocolMajor",
	"version",
] as const;
const ANCHOR_KEYS = [
	"aclDigest",
	"archiveIndexRoot",
	"blueprintDigest",
	"cryptoSuiteId",
	"cutDigest",
	"epoch",
	"historyRoot",
	"historySize",
	"kind",
	"objectId",
	"parametersDigest",
	"previousAnchor",
	"profileDigest",
	"protocolMajor",
	"signerSetDigest",
	"stateDigest",
] as const;
const TRUST_RECORD_KEYS = [
	"currentAnchorDigest",
	"currentEpoch",
	"detachedCurrentAnchorSignature",
	"exactCanonicalCurrentAnchorPreimageBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"genesisAnchorDigest",
	"kind",
	"objectId",
	"profileId",
	"quorum",
	"version",
] as const;
const CERTIFIED_TRUST_RECORD_KEYS = [
	"currentAnchorDigest",
	"currentEpoch",
	"exactCanonicalCertifiedGenesisCertificateBytes",
	"exactCanonicalCurrentAnchorPreimageBytes",
	"exactCanonicalProfileBytes",
	"exactCanonicalSignerSetBytes",
	"genesisAnchorDigest",
	"kind",
	"objectId",
	"profileId",
	"quorum",
	"signerCount",
	"version",
] as const;
const CERTIFIED_PROFILE_KEYS = ["cryptoSuiteId", "profileId", "quorum", "signers"] as const;
const CERTIFIED_SIGNER_KEYS = ["publicKey", "signerId"] as const;
const CERTIFIED_CERTIFICATE_KEYS = [
	"genesisAnchorDigest",
	"kind",
	"profileDigest",
	"signatures",
	"signerSetDigest",
	"version",
] as const;
const CERTIFIED_SIGNATURE_KEYS = ["publicKey", "signature", "signerId"] as const;

type DecodeResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly reason: "decode" | "noncanonical" };

interface AnchorRecord extends Record<string, unknown> {
	readonly blueprintDigest: string;
	readonly cryptoSuiteId: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly profileDigest: string;
	readonly signerSetDigest: string;
}

interface TrustStateRecord extends Record<string, unknown> {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly detachedCurrentAnchorSignature: Uint8Array;
	readonly exactCanonicalCurrentAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly profileId: string;
	readonly quorum: number;
	readonly version: number;
}

function anchorTrustFailure<Reason extends string>(reason: Reason): Readonly<{ ok: false; reason: Reason }> {
	return Object.freeze({ ok: false as const, reason });
}

function hasSharedBacking(bytes: Uint8Array): boolean {
	return typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer;
}

function hasCapturedSharedBacking(bytes: Uint8Array): boolean {
	if (intrinsicSharedArrayBufferByteLengthGetter === undefined) return false;
	try {
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, bytes, []);
		intrinsicReflectApply(intrinsicSharedArrayBufferByteLengthGetter, buffer, []);
		return true;
	} catch {
		return false;
	}
}

function hasCapturedResizableBacking(bytes: Uint8Array): boolean {
	if (intrinsicArrayBufferResizableGetter === undefined) return false;
	try {
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, bytes, []);
		return intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []) === true;
	} catch {
		return false;
	}
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return compareBytes(left, right) === 0;
}

function isWellFormedUtf16Text(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function isSignerId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || !isWellFormedUtf16Text(value)) {
		return false;
	}
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return false;
	}
	return true;
}

function isStorageObjectIdText(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 1024 || !isWellFormedUtf16Text(value)) return false;
	const separator = value.indexOf(":");
	if (separator <= 0 || separator !== value.lastIndexOf(":")) return false;
	for (let index = 0; index < separator; index++) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
	}
	return /^[0-9a-f]{32}$/u.test(value.slice(separator + 1));
}

function isCapturedPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || intrinsicArrayIsArray(value)) return false;
	const prototype = intrinsicObjectGetPrototypeOf(value) as object | null;
	return prototype === intrinsicObjectPrototype || prototype === null;
}

function isClosedDataRecord(
	value: unknown,
	keys: readonly string[],
	useCapturedIntrinsics = false
): value is Record<string, unknown> {
	if (useCapturedIntrinsics ? !isCapturedPlainRecord(value) : !isPlainRecord(value)) return false;
	const record = value as object;
	try {
		if (!useCapturedIntrinsics) {
			const ownKeys = Reflect.ownKeys(record);
			if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
				return false;
			}
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(record, key);
				if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return false;
			}
			return true;
		}
		const ownKeys = intrinsicReflectOwnKeys(record);
		if (ownKeys.length !== keys.length) return false;
		for (const ownKey of ownKeys) {
			if (typeof ownKey !== "string") return false;
			let known = false;
			for (const key of keys) {
				if (ownKey === key) {
					known = true;
					break;
				}
			}
			if (!known) return false;
		}
		for (const key of keys) {
			const descriptor = intrinsicObjectGetOwnPropertyDescriptor(record, key);
			if (descriptor === undefined || !descriptor.enumerable || !intrinsicObjectHasOwn(descriptor, "value")) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function snapshotClosedInput(
	input: unknown,
	keys: readonly string[],
	byteKeys: ReadonlySet<string>,
	useCapturedIntrinsics = false
): Record<string, unknown> | undefined {
	if (!isClosedDataRecord(input, keys, useCapturedIntrinsics)) return undefined;
	const snapshot: Record<string, unknown> = useCapturedIntrinsics ? intrinsicObjectCreate(null) : {};
	try {
		for (const key of keys) {
			let value: unknown;
			if (useCapturedIntrinsics) {
				const descriptor = intrinsicObjectGetOwnPropertyDescriptor(input, key);
				if (descriptor === undefined || !intrinsicObjectHasOwn(descriptor, "value")) return undefined;
				value = descriptor.value;
			} else value = input[key];
			const isByteKey = useCapturedIntrinsics
				? intrinsicReflectApply(intrinsicSetHas, byteKeys, [key])
				: byteKeys.has(key);
			if (isByteKey) {
				if (useCapturedIntrinsics) {
					if (
						!(value instanceof intrinsicUint8Array) ||
						hasCapturedSharedBacking(value) ||
						hasCapturedResizableBacking(value)
					)
						return undefined;
					intrinsicObjectDefineProperty(snapshot, key, {
						configurable: true,
						enumerable: true,
						value: new intrinsicUint8Array(value),
						writable: true,
					});
				} else {
					if (!(value instanceof Uint8Array) || hasSharedBacking(value)) return undefined;
					snapshot[key] = new Uint8Array(value);
				}
			} else if (useCapturedIntrinsics) {
				intrinsicObjectDefineProperty(snapshot, key, {
					configurable: true,
					enumerable: true,
					value,
					writable: true,
				});
			} else snapshot[key] = value;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

function decodeExact(bytes: Uint8Array): DecodeResult {
	try {
		const value = decodeCanonical(bytes);
		if (!equalBytes(encodeCanonical(value), bytes)) return { ok: false, reason: "noncanonical" };
		return { ok: true, value };
	} catch (error) {
		if (
			error instanceof CanonicalDecodingError &&
			/(?:trailing bytes|non-minimal|canonical order|non-canonical|integral float)/u.test(error.message)
		) {
			return { ok: false, reason: "noncanonical" };
		}
		return { ok: false, reason: "decode" };
	}
}

function isSafeNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAnchorRecord(value: unknown): value is AnchorRecord {
	if (!isClosedDataRecord(value, ANCHOR_KEYS)) return false;
	if (value.kind !== "drp-epoch-anchor" || value.protocolMajor !== 3) return false;
	if (typeof value.objectId !== "string" || !isWellFormedUtf16Text(value.objectId) || value.objectId.length > 1024) {
		return false;
	}
	if (!isSafeNonnegative(value.epoch) || !isSafeNonnegative(value.historySize)) return false;
	for (const key of [
		"previousAnchor",
		"cutDigest",
		"stateDigest",
		"aclDigest",
		"historyRoot",
		"archiveIndexRoot",
		"blueprintDigest",
		"signerSetDigest",
		"parametersDigest",
		"profileDigest",
	] as const) {
		if (typeof value[key] !== "string" || !DIGEST_HEX.test(value[key])) return false;
	}
	return typeof value.cryptoSuiteId === "string";
}

interface AuthorAuthorizationCarrier extends Record<string, unknown> {
	readonly authors: readonly string[];
	readonly epoch: number;
	readonly kind: string;
	readonly objectId: string;
	readonly profileId: string;
	readonly protocolMajor: number;
	readonly version: number;
}

function isAuthorAuthorizationCarrier(value: unknown): value is AuthorAuthorizationCarrier {
	if (!isClosedDataRecord(value, AUTHOR_AUTHORIZATION_KEYS)) return false;
	if (
		value.kind !== AUTHOR_AUTHORIZATION_KIND ||
		value.protocolMajor !== 3 ||
		!isSafeNonnegative(value.epoch) ||
		!isSafeNonnegative(value.version) ||
		!isStorageObjectIdText(value.objectId) ||
		typeof value.profileId !== "string" ||
		!Array.isArray(value.authors) ||
		value.authors.length < 1 ||
		value.authors.length > 64
	) {
		return false;
	}
	let previous: string | undefined;
	for (const author of value.authors) {
		if (typeof author !== "string" || !PUBLIC_KEY_HEX.test(author) || (previous !== undefined && previous >= author)) {
			return false;
		}
		previous = author;
	}
	return true;
}

interface CreatorCarriers {
	readonly profileId: string;
	readonly publicKey: Uint8Array;
	readonly quorum: number;
	readonly signerSetMatchesProfile: boolean;
}

function decodeHexBytes(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}

function decodeCreatorCarriers(signerSetBytes: Uint8Array, profileBytes: Uint8Array): CreatorCarriers | undefined {
	const signerSetDecoded = decodeExact(signerSetBytes);
	const profileDecoded = decodeExact(profileBytes);
	if (!signerSetDecoded.ok || !profileDecoded.ok || !Array.isArray(signerSetDecoded.value)) return undefined;
	if (signerSetDecoded.value.length !== 1) return undefined;
	const signer = signerSetDecoded.value[0];
	if (!isClosedDataRecord(signer, ["publicKey", "signerId"])) return undefined;
	if (typeof signer.publicKey !== "string" || !PUBLIC_KEY_HEX.test(signer.publicKey)) return undefined;
	if (!isSignerId(signer.signerId)) return undefined;
	const profile = profileDecoded.value;
	if (!isClosedDataRecord(profile, ["cryptoSuiteId", "profileId", "quorum", "signers"])) return undefined;
	if (typeof profile.profileId !== "string" || typeof profile.cryptoSuiteId !== "string") return undefined;
	if (!isSafeNonnegative(profile.quorum) || !Array.isArray(profile.signers)) return undefined;
	let signerSetMatchesProfile = false;
	try {
		signerSetMatchesProfile = equalBytes(encodeCanonical(profile.signers), signerSetBytes);
	} catch {
		return undefined;
	}
	return {
		profileId: profile.profileId,
		publicKey: decodeHexBytes(signer.publicKey),
		quorum: profile.quorum,
		signerSetMatchesProfile: signerSetMatchesProfile && profile.cryptoSuiteId === ACTIVE_ANCHOR_SUITE,
	};
}

function decodedProfileId(profileBytes: Uint8Array): string | undefined {
	const decoded = decodeExact(profileBytes);
	if (!decoded.ok || !isClosedDataRecord(decoded.value, ["cryptoSuiteId", "profileId", "quorum", "signers"])) {
		return undefined;
	}
	return typeof decoded.value.profileId === "string" ? decoded.value.profileId : undefined;
}

function mintAnchorTrust(
	registry: WeakMap<CurrentAnchorTrust, AnchorTrustPrivateState>,
	fields: CurrentAnchorTrust,
	state: AnchorTrustPrivateState
): CurrentAnchorTrust {
	const trust = Object.freeze({ ...fields });
	registry.set(
		trust,
		Object.freeze({
			...state,
			detachedCurrentAnchorSignature: new Uint8Array(state.detachedCurrentAnchorSignature),
			exactCanonicalCurrentAnchorPreimageBytes: new Uint8Array(state.exactCanonicalCurrentAnchorPreimageBytes),
			exactCanonicalProfileBytes: new Uint8Array(state.exactCanonicalProfileBytes),
			exactCanonicalSignerSetBytes: new Uint8Array(state.exactCanonicalSignerSetBytes),
			publicKey: new Uint8Array(state.publicKey),
		})
	);
	return trust;
}

function verifyStrictSignature(signature: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): boolean {
	if (signature.byteLength !== 64 || publicKey.byteLength !== 32) return false;
	try {
		return ed25519.verify(signature, digest, publicKey, { zip215: false });
	} catch {
		return false;
	}
}

function trustRecordShape(value: unknown): value is TrustStateRecord {
	if (!isClosedDataRecord(value, TRUST_RECORD_KEYS)) return false;
	return (
		typeof value.kind === "string" &&
		typeof value.version === "number" &&
		typeof value.objectId === "string" &&
		typeof value.profileId === "string" &&
		typeof value.quorum === "number" &&
		typeof value.genesisAnchorDigest === "string" &&
		typeof value.currentEpoch === "number" &&
		typeof value.currentAnchorDigest === "string" &&
		value.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array &&
		value.detachedCurrentAnchorSignature instanceof Uint8Array &&
		value.exactCanonicalSignerSetBytes instanceof Uint8Array &&
		value.exactCanonicalProfileBytes instanceof Uint8Array
	);
}

type CertifiedProfileId = "attested-bft-v1" | "delegated-trusted-v1";

interface CertifiedSignerCarrier {
	readonly publicKey: string;
	readonly publicKeyBytes: Uint8Array;
	readonly signerId: string;
}

interface ValidatedCertifiedMaterial {
	readonly anchorBytes: Uint8Array;
	readonly anchorDigest: string;
	readonly certificateBytes: Uint8Array;
	readonly objectId: string;
	readonly profileBytes: Uint8Array;
	readonly profileId: CertifiedProfileId;
	readonly quorum: number;
	readonly signerCount: number;
	readonly signerSetBytes: Uint8Array;
}

type CertifiedMaterialValidation =
	| Readonly<{ ok: false; reason: InstallCertifiedAnchorTrustRootFailureReason }>
	| Readonly<{ material: ValidatedCertifiedMaterial; ok: true }>;

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isCertifiedProfileId(value: unknown): value is CertifiedProfileId {
	return value === "attested-bft-v1" || value === "delegated-trusted-v1";
}

function compareSignerIds(left: string, right: string): number {
	return compareBytes(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

function validateCertifiedMaterial(values: Readonly<Record<string, unknown>>): CertifiedMaterialValidation {
	const certificateBytes = values.exactCanonicalCertifiedGenesisCertificateBytes as Uint8Array;
	const anchorBytes = values.exactCanonicalGenesisAnchorPreimageBytes as Uint8Array;
	const profileBytes = values.exactCanonicalProfileBytes as Uint8Array;
	const signerSetBytes = values.exactCanonicalSignerSetBytes as Uint8Array;
	if (
		certificateBytes.byteLength === 0 ||
		anchorBytes.byteLength === 0 ||
		profileBytes.byteLength === 0 ||
		signerSetBytes.byteLength === 0 ||
		typeof values.pinnedGenesisAnchorDigest !== "string" ||
		!DIGEST_HEX.test(values.pinnedGenesisAnchorDigest)
	) {
		return anchorTrustFailure("malformed-input");
	}

	const anchorDecoded = decodeExact(anchorBytes);
	if (!anchorDecoded.ok) {
		return anchorTrustFailure(anchorDecoded.reason === "noncanonical" ? "noncanonical-anchor" : "anchor-decode-failed");
	}
	if (!isAnchorRecord(anchorDecoded.value)) return anchorTrustFailure("anchor-schema-invalid");
	const anchor = anchorDecoded.value;
	if (anchor.cryptoSuiteId !== ACTIVE_ANCHOR_SUITE) return anchorTrustFailure("inactive-crypto-suite");
	if (
		anchor.epoch !== 0 ||
		anchor.historySize !== 0 ||
		anchor.previousAnchor !== ZERO_DIGEST ||
		anchor.cutDigest !== ZERO_DIGEST
	) {
		return anchorTrustFailure("not-genesis-anchor");
	}
	if (!isStorageObjectIdText(anchor.objectId)) return anchorTrustFailure("object-id-invalid");
	if (utf8ByteLength(anchor.objectId) > MAXIMUM_CERTIFIED_OBJECT_ID_BYTES) {
		return anchorTrustFailure("object-id-too-long");
	}
	const anchorDigestBytes = hashDomain(ANCHOR_DIGEST_DOMAIN, anchorBytes);
	const anchorDigest = bytesToHex(anchorDigestBytes);
	if (anchorDigest !== values.pinnedGenesisAnchorDigest) return anchorTrustFailure("genesis-pin-mismatch");
	if (bytesToHex(hashDomain(PROFILE_DIGEST_DOMAIN, profileBytes)) !== anchor.profileDigest) {
		return anchorTrustFailure("profile-digest-mismatch");
	}
	if (bytesToHex(hashDomain(SIGNER_SET_DIGEST_DOMAIN, signerSetBytes)) !== anchor.signerSetDigest) {
		return anchorTrustFailure("signer-set-digest-mismatch");
	}

	const profileDecoded = decodeExact(profileBytes);
	const signerSetDecoded = decodeExact(signerSetBytes);
	const decodedProfileValue = profileDecoded.ok ? profileDecoded.value : undefined;
	if (
		!profileDecoded.ok ||
		!signerSetDecoded.ok ||
		!isClosedDataRecord(profileDecoded.value, CERTIFIED_PROFILE_KEYS) ||
		profileDecoded.value.cryptoSuiteId !== ACTIVE_CERTIFIED_PROFILE_SUITE ||
		!isCertifiedProfileId(profileDecoded.value.profileId) ||
		!isSafeNonnegative(profileDecoded.value.quorum) ||
		!Array.isArray(profileDecoded.value.signers) ||
		!Array.isArray(signerSetDecoded.value)
	) {
		return anchorTrustFailure(
			isClosedDataRecord(decodedProfileValue, CERTIFIED_PROFILE_KEYS) &&
				typeof decodedProfileValue.profileId === "string" &&
				!isCertifiedProfileId(decodedProfileValue.profileId)
				? "unsupported-trust-profile"
				: "signer-set-profile-mismatch"
		);
	}
	let encodedProfileSigners: Uint8Array;
	try {
		encodedProfileSigners = encodeCanonical(profileDecoded.value.signers);
	} catch {
		return anchorTrustFailure("signer-set-profile-mismatch");
	}
	if (!equalBytes(encodedProfileSigners, signerSetBytes)) {
		return anchorTrustFailure("signer-set-profile-mismatch");
	}
	const signerCount = signerSetDecoded.value.length;
	if (signerCount > MAXIMUM_CERTIFIED_SIGNERS) return anchorTrustFailure("too-many-signers");
	const profileId = profileDecoded.value.profileId;
	const quorum = profileDecoded.value.quorum;
	if (
		(profileId === "delegated-trusted-v1" && (signerCount < 2 || quorum < 2 || quorum > signerCount)) ||
		(profileId === "attested-bft-v1" &&
			(signerCount < 4 || signerCount > 8 || quorum !== Math.ceil((2 * signerCount) / 3)))
	) {
		return anchorTrustFailure("invalid-quorum");
	}

	const signers: CertifiedSignerCarrier[] = [];
	const signerIds = new Set<string>();
	const publicKeys = new Set<string>();
	for (const value of signerSetDecoded.value) {
		if (!isClosedDataRecord(value, CERTIFIED_SIGNER_KEYS)) {
			return anchorTrustFailure("signer-set-profile-mismatch");
		}
		if (typeof value.signerId === "string" && utf8ByteLength(value.signerId) > MAXIMUM_CERTIFIED_SIGNER_ID_BYTES) {
			return anchorTrustFailure("signer-id-too-long");
		}
		if (!isSignerId(value.signerId) || typeof value.publicKey !== "string" || !PUBLIC_KEY_HEX.test(value.publicKey)) {
			return anchorTrustFailure("signer-set-profile-mismatch");
		}
		if (signerIds.has(value.signerId) || publicKeys.has(value.publicKey)) {
			return anchorTrustFailure("signer-set-profile-mismatch");
		}
		signerIds.add(value.signerId);
		publicKeys.add(value.publicKey);
		signers.push({
			publicKey: value.publicKey,
			publicKeyBytes: decodeHexBytes(value.publicKey),
			signerId: value.signerId,
		});
	}
	for (let index = 1; index < signers.length; index++) {
		if (compareSignerIds(signers[index - 1].signerId, signers[index].signerId) >= 0) {
			return anchorTrustFailure("signer-set-profile-mismatch");
		}
	}

	const certificateDecoded = decodeExact(certificateBytes);
	if (!certificateDecoded.ok) {
		return anchorTrustFailure(
			certificateDecoded.reason === "noncanonical" ? "noncanonical-certificate" : "certificate-decode-failed"
		);
	}
	if (!isClosedDataRecord(certificateDecoded.value, CERTIFIED_CERTIFICATE_KEYS)) {
		return anchorTrustFailure("certificate-schema-invalid");
	}
	const certificate = certificateDecoded.value;
	if (
		certificate.kind !== CERTIFIED_CERTIFICATE_KIND ||
		certificate.version !== 1 ||
		typeof certificate.genesisAnchorDigest !== "string" ||
		typeof certificate.profileDigest !== "string" ||
		typeof certificate.signerSetDigest !== "string" ||
		!Array.isArray(certificate.signatures)
	) {
		return anchorTrustFailure("certificate-schema-invalid");
	}
	if (
		certificate.genesisAnchorDigest !== anchorDigest ||
		certificate.profileDigest !== anchor.profileDigest ||
		certificate.signerSetDigest !== anchor.signerSetDigest
	) {
		return anchorTrustFailure("certificate-binding-mismatch");
	}
	if (certificate.signatures.length !== signers.length) {
		return anchorTrustFailure("certificate-signer-mismatch");
	}
	for (let index = 0; index < signers.length; index++) {
		const signature = certificate.signatures[index];
		const signer = signers[index];
		if (
			!isClosedDataRecord(signature, CERTIFIED_SIGNATURE_KEYS) ||
			signature.signerId !== signer.signerId ||
			signature.publicKey !== signer.publicKey ||
			!(signature.signature instanceof Uint8Array) ||
			hasSharedBacking(signature.signature)
		) {
			return anchorTrustFailure("certificate-signer-mismatch");
		}
		if (!verifyStrictSignature(signature.signature, anchorDigestBytes, signer.publicKeyBytes)) {
			return anchorTrustFailure("invalid-signature");
		}
	}

	return Object.freeze({
		material: Object.freeze({
			anchorBytes: new Uint8Array(anchorBytes),
			anchorDigest,
			certificateBytes: new Uint8Array(certificateBytes),
			objectId: anchor.objectId,
			profileBytes: new Uint8Array(profileBytes),
			profileId,
			quorum,
			signerCount,
			signerSetBytes: new Uint8Array(signerSetBytes),
		}),
		ok: true as const,
	});
}

function mintCertifiedAnchorTrust(
	registry: WeakMap<CertifiedAnchorTrust, CertifiedAnchorTrustPrivateState>,
	material: ValidatedCertifiedMaterial
): CertifiedAnchorTrust {
	const trust = Object.freeze({
		currentAnchorDigest: material.anchorDigest,
		currentEpoch: 0 as const,
		genesisAnchorDigest: material.anchorDigest,
		objectId: material.objectId,
		profileId: material.profileId,
		quorum: material.quorum,
		signerCount: material.signerCount,
	});
	registry.set(
		trust,
		Object.freeze({
			exactCanonicalCertifiedGenesisCertificateBytes: new Uint8Array(material.certificateBytes),
			exactCanonicalCurrentAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
			exactCanonicalProfileBytes: new Uint8Array(material.profileBytes),
			exactCanonicalSignerSetBytes: new Uint8Array(material.signerSetBytes),
		})
	);
	return trust;
}

/**
 * Creates one public-module-scoped creator trust capability registry.
 * @returns The pure creator trust API bound to that private registry.
 */
export function createAnchorTrustApi(): AnchorTrustApi {
	const registry = new WeakMap<CurrentAnchorTrust, AnchorTrustPrivateState>();
	const certifiedRegistry = new WeakMap<CertifiedAnchorTrust, CertifiedAnchorTrustPrivateState>();
	const authorizationRegistry = new WeakMap<
		CurrentEpochAuthorAuthorization,
		CurrentEpochAuthorAuthorizationPrivateState
	>();

	const isAnchorTrustStateRecordBytes = (bytes: Uint8Array): boolean => {
		try {
			if (
				!(bytes instanceof Uint8Array) ||
				hasSharedBacking(bytes) ||
				bytes.byteLength === 0 ||
				bytes.byteLength > ANCHOR_TRUST_STATE_MAX_RECORD_BYTES
			)
				return false;
			const decoded = decodeExact(new Uint8Array(bytes));
			return (
				decoded.ok &&
				isClosedDataRecord(decoded.value, TRUST_RECORD_KEYS) &&
				decoded.value.kind === "drp-anchor-trust-state"
			);
		} catch {
			return false;
		}
	};

	const installCertifiedAnchorTrustRoot = (
		input: InstallCertifiedAnchorTrustRootInput
	): InstallCertifiedAnchorTrustRootResult => {
		try {
			const values = snapshotClosedInput(input, CERTIFIED_ANCHOR_TRUST_INPUT_KEYS, CERTIFIED_ANCHOR_TRUST_BYTE_KEYS);
			if (values === undefined) return anchorTrustFailure("malformed-input");
			const validation = validateCertifiedMaterial(values);
			if (!validation.ok) return validation;
			const material = validation.material;
			const recordBytes = encodeCanonical({
				currentAnchorDigest: material.anchorDigest,
				currentEpoch: 0,
				exactCanonicalCertifiedGenesisCertificateBytes: material.certificateBytes,
				exactCanonicalCurrentAnchorPreimageBytes: material.anchorBytes,
				exactCanonicalProfileBytes: material.profileBytes,
				exactCanonicalSignerSetBytes: material.signerSetBytes,
				genesisAnchorDigest: material.anchorDigest,
				kind: CERTIFIED_TRUST_STATE_KIND,
				objectId: material.objectId,
				profileId: material.profileId,
				quorum: material.quorum,
				signerCount: material.signerCount,
				version: CERTIFIED_TRUST_STATE_VERSION,
			});
			if (recordBytes.byteLength > ANCHOR_TRUST_STATE_MAX_RECORD_BYTES) {
				return anchorTrustFailure("trust-state-too-large");
			}
			const trust = mintCertifiedAnchorTrust(certifiedRegistry, material);
			return Object.freeze({
				exactCanonicalTrustStateRecordBytes: new Uint8Array(recordBytes),
				ok: true as const,
				trust,
			});
		} catch {
			return anchorTrustFailure("malformed-input");
		}
	};

	const openCertifiedAnchorTrust = (input: OpenCertifiedAnchorTrustInput): OpenCertifiedAnchorTrustResult => {
		try {
			const values = snapshotClosedInput(
				input,
				OPEN_TRUST_INPUT_KEYS,
				new Set(["exactCanonicalTrustStateRecordBytes"])
			);
			if (
				values === undefined ||
				!isStorageObjectIdText(values.expectedObjectId) ||
				typeof values.pinnedGenesisAnchorDigest !== "string" ||
				!DIGEST_HEX.test(values.pinnedGenesisAnchorDigest)
			) {
				return anchorTrustFailure("malformed-input");
			}
			const recordBytes = values.exactCanonicalTrustStateRecordBytes as Uint8Array;
			if (recordBytes.byteLength > ANCHOR_TRUST_STATE_MAX_RECORD_BYTES) {
				return anchorTrustFailure("trust-state-too-large");
			}
			if (recordBytes.byteLength === 0) return anchorTrustFailure("malformed-input");
			const decoded = decodeExact(recordBytes);
			if (!decoded.ok) {
				return anchorTrustFailure(decoded.reason === "noncanonical" ? "noncanonical-record" : "record-decode-failed");
			}
			if (!isClosedDataRecord(decoded.value, CERTIFIED_TRUST_RECORD_KEYS)) {
				return anchorTrustFailure("record-schema-invalid");
			}
			const record = decoded.value;
			if (record.kind !== CERTIFIED_TRUST_STATE_KIND) return anchorTrustFailure("record-schema-invalid");
			if (record.version !== CERTIFIED_TRUST_STATE_VERSION) {
				return anchorTrustFailure("unsupported-trust-state-version");
			}
			if (record.objectId !== values.expectedObjectId) return anchorTrustFailure("object-id-mismatch");
			if (record.genesisAnchorDigest !== values.pinnedGenesisAnchorDigest) {
				return anchorTrustFailure("genesis-pin-mismatch");
			}
			if (
				!(record.exactCanonicalCertifiedGenesisCertificateBytes instanceof Uint8Array) ||
				!(record.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
				!(record.exactCanonicalProfileBytes instanceof Uint8Array) ||
				!(record.exactCanonicalSignerSetBytes instanceof Uint8Array)
			) {
				return anchorTrustFailure("record-schema-invalid");
			}
			const validation = validateCertifiedMaterial({
				exactCanonicalCertifiedGenesisCertificateBytes: record.exactCanonicalCertifiedGenesisCertificateBytes,
				exactCanonicalGenesisAnchorPreimageBytes: record.exactCanonicalCurrentAnchorPreimageBytes,
				exactCanonicalProfileBytes: record.exactCanonicalProfileBytes,
				exactCanonicalSignerSetBytes: record.exactCanonicalSignerSetBytes,
				pinnedGenesisAnchorDigest: record.genesisAnchorDigest,
			});
			if (!validation.ok) return anchorTrustFailure("trust-state-inconsistent");
			const material = validation.material;
			if (
				record.currentAnchorDigest !== material.anchorDigest ||
				record.currentEpoch !== 0 ||
				record.genesisAnchorDigest !== material.anchorDigest ||
				record.objectId !== material.objectId ||
				record.profileId !== material.profileId ||
				record.quorum !== material.quorum ||
				record.signerCount !== material.signerCount
			) {
				return anchorTrustFailure("trust-state-inconsistent");
			}
			const trust = mintCertifiedAnchorTrust(certifiedRegistry, material);
			return Object.freeze({ ok: true as const, trust });
		} catch {
			return anchorTrustFailure("malformed-input");
		}
	};

	const installCreatorAnchorTrustRoot = (
		input: InstallCreatorAnchorTrustRootInput
	): InstallCreatorAnchorTrustRootResult => {
		try {
			const values = snapshotClosedInput(
				input,
				ANCHOR_TRUST_INPUT_KEYS,
				new Set([
					"detachedGenesisSignature",
					"exactCanonicalGenesisAnchorPreimageBytes",
					"exactCanonicalProfileBytes",
					"exactCanonicalSignerSetBytes",
				])
			);
			if (
				values === undefined ||
				typeof values.pinnedGenesisAnchorDigest !== "string" ||
				!DIGEST_HEX.test(values.pinnedGenesisAnchorDigest)
			) {
				return anchorTrustFailure("malformed-input");
			}
			const signature = values.detachedGenesisSignature as Uint8Array;
			const anchorBytes = values.exactCanonicalGenesisAnchorPreimageBytes as Uint8Array;
			const profileBytes = values.exactCanonicalProfileBytes as Uint8Array;
			const signerSetBytes = values.exactCanonicalSignerSetBytes as Uint8Array;
			if (
				signature.byteLength !== 64 ||
				anchorBytes.byteLength === 0 ||
				profileBytes.byteLength === 0 ||
				signerSetBytes.byteLength === 0
			) {
				return anchorTrustFailure("malformed-input");
			}
			const anchorDecoded = decodeExact(anchorBytes);
			if (!anchorDecoded.ok) {
				return anchorTrustFailure(
					anchorDecoded.reason === "noncanonical" ? "noncanonical-anchor" : "anchor-decode-failed"
				);
			}
			if (!isAnchorRecord(anchorDecoded.value)) return anchorTrustFailure("anchor-schema-invalid");
			const anchor = anchorDecoded.value;
			if (anchor.cryptoSuiteId !== ACTIVE_ANCHOR_SUITE) return anchorTrustFailure("inactive-crypto-suite");
			if (
				anchor.epoch !== 0 ||
				anchor.historySize !== 0 ||
				anchor.previousAnchor !== ZERO_DIGEST ||
				anchor.cutDigest !== ZERO_DIGEST
			) {
				return anchorTrustFailure("not-genesis-anchor");
			}
			if (!isStorageObjectIdText(anchor.objectId)) return anchorTrustFailure("object-id-invalid");
			const anchorDigestBytes = hashDomain(ANCHOR_DIGEST_DOMAIN, anchorBytes);
			const anchorDigest = bytesToHex(anchorDigestBytes);
			if (anchorDigest !== values.pinnedGenesisAnchorDigest) return anchorTrustFailure("genesis-pin-mismatch");
			if (bytesToHex(hashDomain(SIGNER_SET_DIGEST_DOMAIN, signerSetBytes)) !== anchor.signerSetDigest) {
				return anchorTrustFailure("signer-set-digest-mismatch");
			}
			if (bytesToHex(hashDomain(PROFILE_DIGEST_DOMAIN, profileBytes)) !== anchor.profileDigest) {
				return anchorTrustFailure("profile-digest-mismatch");
			}
			const profileId = decodedProfileId(profileBytes);
			if (profileId !== undefined && profileId !== CREATOR_PROFILE) {
				return anchorTrustFailure("unsupported-trust-profile");
			}
			const carriers = decodeCreatorCarriers(signerSetBytes, profileBytes);
			if (carriers === undefined || carriers.quorum !== 1 || !carriers.signerSetMatchesProfile) {
				return anchorTrustFailure("signer-set-profile-mismatch");
			}
			const recordBytes = encodeCanonical({
				currentAnchorDigest: anchorDigest,
				currentEpoch: 0,
				detachedCurrentAnchorSignature: signature,
				exactCanonicalCurrentAnchorPreimageBytes: anchorBytes,
				exactCanonicalProfileBytes: profileBytes,
				exactCanonicalSignerSetBytes: signerSetBytes,
				genesisAnchorDigest: anchorDigest,
				kind: "drp-anchor-trust-state",
				objectId: anchor.objectId,
				profileId: CREATOR_PROFILE,
				quorum: 1,
				version: 1,
			});
			if (recordBytes.byteLength > ANCHOR_TRUST_STATE_MAX_RECORD_BYTES) {
				return anchorTrustFailure("trust-state-too-large");
			}
			if (!verifyStrictSignature(signature, anchorDigestBytes, carriers.publicKey)) {
				return anchorTrustFailure("invalid-signature");
			}
			const trust = mintAnchorTrust(
				registry,
				{
					currentAnchorDigest: anchorDigest,
					currentEpoch: 0,
					genesisAnchorDigest: anchorDigest,
					objectId: anchor.objectId,
					profileId: CREATOR_PROFILE,
				},
				{
					detachedCurrentAnchorSignature: signature,
					exactCanonicalCurrentAnchorPreimageBytes: anchorBytes,
					exactCanonicalProfileBytes: profileBytes,
					exactCanonicalSignerSetBytes: signerSetBytes,
					publicKey: carriers.publicKey,
					profileDigest: anchor.profileDigest,
					quorum: 1,
					signerSetDigest: anchor.signerSetDigest,
				}
			);
			return Object.freeze({
				exactCanonicalTrustStateRecordBytes: new Uint8Array(recordBytes),
				ok: true as const,
				trust,
			});
		} catch {
			return anchorTrustFailure("malformed-input");
		}
	};

	const openCurrentAnchorTrust = (input: OpenCurrentAnchorTrustInput): OpenCurrentAnchorTrustResult => {
		try {
			const values = snapshotClosedInput(
				input,
				OPEN_TRUST_INPUT_KEYS,
				new Set(["exactCanonicalTrustStateRecordBytes"])
			);
			if (
				values === undefined ||
				!isStorageObjectIdText(values.expectedObjectId) ||
				typeof values.pinnedGenesisAnchorDigest !== "string" ||
				!DIGEST_HEX.test(values.pinnedGenesisAnchorDigest)
			) {
				return anchorTrustFailure("malformed-input");
			}
			const recordBytes = values.exactCanonicalTrustStateRecordBytes as Uint8Array;
			if (recordBytes.byteLength === 0 || recordBytes.byteLength > ANCHOR_TRUST_STATE_MAX_RECORD_BYTES) {
				return anchorTrustFailure("malformed-input");
			}
			const decoded = decodeExact(recordBytes);
			if (!decoded.ok) {
				return anchorTrustFailure(decoded.reason === "noncanonical" ? "noncanonical-record" : "record-decode-failed");
			}
			if (!trustRecordShape(decoded.value) || decoded.value.kind !== "drp-anchor-trust-state") {
				return anchorTrustFailure("record-schema-invalid");
			}
			const record = decoded.value;
			if (record.version !== 1) return anchorTrustFailure("unsupported-trust-state-version");
			if (record.objectId !== values.expectedObjectId) return anchorTrustFailure("object-id-mismatch");
			if (record.genesisAnchorDigest !== values.pinnedGenesisAnchorDigest)
				return anchorTrustFailure("genesis-pin-mismatch");
			if (record.profileId !== CREATOR_PROFILE) return anchorTrustFailure("unsupported-trust-profile");

			const anchorBytes = new Uint8Array(record.exactCanonicalCurrentAnchorPreimageBytes);
			const signature = new Uint8Array(record.detachedCurrentAnchorSignature);
			const signerSetBytes = new Uint8Array(record.exactCanonicalSignerSetBytes);
			const profileBytes = new Uint8Array(record.exactCanonicalProfileBytes);
			const anchorDecoded = decodeExact(anchorBytes);
			const profileId = decodedProfileId(profileBytes);
			if (profileId !== undefined && profileId !== CREATOR_PROFILE) {
				return anchorTrustFailure("unsupported-trust-profile");
			}
			const carriers = decodeCreatorCarriers(signerSetBytes, profileBytes);
			if (
				!anchorDecoded.ok ||
				!isAnchorRecord(anchorDecoded.value) ||
				anchorDecoded.value.cryptoSuiteId !== ACTIVE_ANCHOR_SUITE
			) {
				return anchorTrustFailure("trust-state-inconsistent");
			}
			const anchor = anchorDecoded.value;
			const anchorDigestBytes = hashDomain(ANCHOR_DIGEST_DOMAIN, anchorBytes);
			const anchorDigest = bytesToHex(anchorDigestBytes);
			if (
				!isStorageObjectIdText(record.objectId) ||
				!DIGEST_HEX.test(record.genesisAnchorDigest) ||
				!isSafeNonnegative(record.currentEpoch) ||
				!DIGEST_HEX.test(record.currentAnchorDigest) ||
				record.quorum !== 1 ||
				carriers === undefined ||
				carriers.quorum !== 1 ||
				!carriers.signerSetMatchesProfile ||
				record.currentAnchorDigest !== record.genesisAnchorDigest ||
				record.currentEpoch !== 0 ||
				anchor.objectId !== record.objectId ||
				anchor.epoch !== record.currentEpoch ||
				anchor.historySize !== 0 ||
				anchor.previousAnchor !== ZERO_DIGEST ||
				anchor.cutDigest !== ZERO_DIGEST ||
				anchorDigest !== record.currentAnchorDigest ||
				bytesToHex(hashDomain(SIGNER_SET_DIGEST_DOMAIN, signerSetBytes)) !== anchor.signerSetDigest ||
				bytesToHex(hashDomain(PROFILE_DIGEST_DOMAIN, profileBytes)) !== anchor.profileDigest
			) {
				return anchorTrustFailure("trust-state-inconsistent");
			}
			if (!verifyStrictSignature(signature, anchorDigestBytes, carriers.publicKey)) {
				return anchorTrustFailure("invalid-signature");
			}
			const trust = mintAnchorTrust(
				registry,
				{
					currentAnchorDigest: record.currentAnchorDigest,
					currentEpoch: record.currentEpoch,
					genesisAnchorDigest: record.genesisAnchorDigest,
					objectId: record.objectId,
					profileId: CREATOR_PROFILE,
				},
				{
					detachedCurrentAnchorSignature: signature,
					exactCanonicalCurrentAnchorPreimageBytes: anchorBytes,
					exactCanonicalProfileBytes: profileBytes,
					exactCanonicalSignerSetBytes: signerSetBytes,
					publicKey: carriers.publicKey,
					profileDigest: anchor.profileDigest,
					quorum: 1,
					signerSetDigest: anchor.signerSetDigest,
				}
			);
			return Object.freeze({ ok: true as const, trust });
		} catch {
			return anchorTrustFailure("malformed-input");
		}
	};

	const authenticateCurrentEpochAnchor = (
		input: AuthenticateCurrentEpochAnchorInput
	): AuthenticateCurrentEpochAnchorResult => {
		try {
			const values = snapshotClosedInput(
				input,
				AUTHENTICATE_ANCHOR_INPUT_KEYS,
				new Set(["detachedSignature", "exactCanonicalAnchorPreimageBytes"])
			);
			if (values === undefined) return anchorTrustFailure("malformed-input");
			const signature = values.detachedSignature as Uint8Array;
			const anchorBytes = values.exactCanonicalAnchorPreimageBytes as Uint8Array;
			if (signature.byteLength !== 64 || anchorBytes.byteLength === 0) return anchorTrustFailure("malformed-input");
			const trust = values.trust as CurrentAnchorTrust;
			const state = typeof trust === "object" && trust !== null ? registry.get(trust) : undefined;
			if (state === undefined) return anchorTrustFailure("untrusted-context");
			const decoded = decodeExact(anchorBytes);
			if (!decoded.ok) {
				return anchorTrustFailure(decoded.reason === "noncanonical" ? "noncanonical-anchor" : "anchor-decode-failed");
			}
			if (!isAnchorRecord(decoded.value)) return anchorTrustFailure("anchor-schema-invalid");
			const anchor = decoded.value;
			if (anchor.cryptoSuiteId !== ACTIVE_ANCHOR_SUITE) return anchorTrustFailure("inactive-crypto-suite");
			if (anchor.objectId !== trust.objectId) return anchorTrustFailure("object-id-mismatch");
			if (anchor.epoch !== trust.currentEpoch) return anchorTrustFailure("epoch-mismatch");
			if (anchor.profileDigest !== state.profileDigest) return anchorTrustFailure("profile-digest-mismatch");
			if (anchor.signerSetDigest !== state.signerSetDigest) return anchorTrustFailure("signer-set-digest-mismatch");
			const anchorDigestBytes = hashDomain(ANCHOR_DIGEST_DOMAIN, anchorBytes);
			const anchorDigest = bytesToHex(anchorDigestBytes);
			if (anchorDigest !== trust.currentAnchorDigest) return anchorTrustFailure("anchor-not-current");
			if (!verifyStrictSignature(signature, anchorDigestBytes, state.publicKey)) {
				return anchorTrustFailure("invalid-signature");
			}
			const provenance = Object.freeze({
				anchorDigest,
				blueprintDigest: anchor.blueprintDigest,
				epoch: anchor.epoch,
				objectId: anchor.objectId,
				parametersDigest: anchor.parametersDigest,
				profileDigest: anchor.profileDigest,
				signerSetDigest: anchor.signerSetDigest,
			});
			return Object.freeze({ ok: true as const, provenance });
		} catch {
			return anchorTrustFailure("malformed-input");
		}
	};

	const openCurrentEpochAuthorAuthorization = (
		input: OpenCurrentEpochAuthorAuthorizationInput
	): OpenCurrentEpochAuthorAuthorizationResult => {
		try {
			const values = snapshotClosedInput(
				input,
				OPEN_AUTHOR_AUTHORIZATION_INPUT_KEYS,
				OPEN_AUTHOR_AUTHORIZATION_BYTE_KEYS,
				true
			);
			if (values === undefined) return anchorTrustFailure("malformed-input");
			const detachedAnchorSignature = values.detachedAnchorSignature as Uint8Array;
			const exactCanonicalAnchorPreimageBytes = values.exactCanonicalAnchorPreimageBytes as Uint8Array;
			const exactCanonicalAuthorAuthorizationBytes = values.exactCanonicalAuthorAuthorizationBytes as Uint8Array;
			if (
				detachedAnchorSignature.byteLength !== 64 ||
				exactCanonicalAnchorPreimageBytes.byteLength === 0 ||
				exactCanonicalAuthorAuthorizationBytes.byteLength === 0 ||
				exactCanonicalAuthorAuthorizationBytes.byteLength > AUTHOR_AUTHORIZATION_MAX_BYTES
			) {
				return anchorTrustFailure("malformed-input");
			}
			const trust = values.trust as CurrentAnchorTrust;
			const authenticated = authenticateCurrentEpochAnchor({
				detachedSignature: detachedAnchorSignature,
				exactCanonicalAnchorPreimageBytes,
				trust,
			});
			if (!authenticated.ok) {
				return Object.freeze({
					cause: authenticated.reason,
					ok: false as const,
					reason: "anchor-rejected" as const,
				});
			}

			const anchorDecoded = decodeExact(exactCanonicalAnchorPreimageBytes);
			if (!anchorDecoded.ok || !isAnchorRecord(anchorDecoded.value)) {
				return Object.freeze({
					cause: "anchor-schema-invalid" as const,
					ok: false as const,
					reason: "anchor-rejected" as const,
				});
			}
			const authorizationDecoded = decodeExact(exactCanonicalAuthorAuthorizationBytes);
			if (!authorizationDecoded.ok) {
				let hasNonzeroByte = false;
				for (const byte of exactCanonicalAuthorAuthorizationBytes) {
					if (byte !== 0) {
						hasNonzeroByte = true;
						break;
					}
				}
				return anchorTrustFailure(
					authorizationDecoded.reason === "noncanonical" && hasNonzeroByte ? "noncanonical-acl" : "acl-decode-failed"
				);
			}
			if (!isAuthorAuthorizationCarrier(authorizationDecoded.value)) {
				return anchorTrustFailure("acl-schema-invalid");
			}
			const carrier = authorizationDecoded.value;
			if (carrier.version !== 1) return anchorTrustFailure("unsupported-acl-version");
			if (carrier.profileId !== AUTHOR_AUTHORIZATION_PROFILE) {
				return anchorTrustFailure("unsupported-acl-profile");
			}
			if (carrier.objectId !== trust.objectId) return anchorTrustFailure("object-id-mismatch");
			if (carrier.epoch !== trust.currentEpoch) return anchorTrustFailure("epoch-mismatch");
			const aclDigest = bytesToHex(hashDomain(AUTHOR_AUTHORIZATION_DOMAIN, exactCanonicalAuthorAuthorizationBytes));
			if (aclDigest !== anchorDecoded.value.aclDigest) return anchorTrustFailure("acl-digest-mismatch");

			const authorization = Object.freeze({
				aclDigest,
				currentAnchorDigest: trust.currentAnchorDigest,
				epoch: carrier.epoch,
				objectId: carrier.objectId,
				profileId: AUTHOR_AUTHORIZATION_PROFILE,
			});
			const authors = new intrinsicSet<string>();
			for (const author of carrier.authors) intrinsicReflectApply(intrinsicSetAdd, authors, [author]);
			authorizationRegistry.set(authorization, Object.freeze({ authors }));
			return Object.freeze({ authorization, ok: true as const, provenance: authenticated.provenance });
		} catch {
			return anchorTrustFailure("malformed-input");
		}
	};

	const resolveCurrentEpochAuthorizedAuthor = (
		input: ResolveCurrentEpochAuthorizedAuthorInput
	): ResolveCurrentEpochAuthorizedAuthorResult => {
		try {
			const values = snapshotClosedInput(input, RESOLVE_AUTHORIZED_AUTHOR_INPUT_KEYS, new intrinsicSet(), true);
			if (values === undefined) return anchorTrustFailure("malformed-input");
			const authorization = values.authorization as CurrentEpochAuthorAuthorization;
			const state =
				typeof authorization === "object" && authorization !== null
					? authorizationRegistry.get(authorization)
					: undefined;
			if (state === undefined) return anchorTrustFailure("untrusted-context");
			const author = values.author;
			if (typeof author !== "string" || !PUBLIC_KEY_HEX.test(author)) {
				return anchorTrustFailure("malformed-input");
			}
			if (!intrinsicReflectApply(intrinsicSetHas, state.authors, [author])) {
				return anchorTrustFailure("author-not-authorized");
			}
			const publicKey = Object.freeze({ bytes: decodeHexBytes(author), format: "raw" as const });
			return Object.freeze({ ok: true as const, publicKey });
		} catch {
			return anchorTrustFailure("malformed-input");
		}
	};

	const resolveCertifiedSealMaterial = (trust: CertifiedAnchorTrust): CertifiedSealAuthorityMaterial | undefined => {
		const state = certifiedRegistry.get(trust);
		if (state === undefined) return undefined;
		return Object.freeze({
			currentAnchorDigest: trust.currentAnchorDigest,
			currentEpoch: 0 as const,
			exactCanonicalSignerSetBytes: new intrinsicUint8Array(state.exactCanonicalSignerSetBytes),
			objectId: trust.objectId,
			quorum: trust.quorum,
		});
	};

	const resolveCreatorAnchorTrustMaterial = (trust: CurrentAnchorTrust): CreatorAnchorTrustMaterial | undefined => {
		const state = registry.get(trust);
		if (state === undefined) return undefined;
		return Object.freeze({
			currentAnchorDigest: trust.currentAnchorDigest,
			currentEpoch: trust.currentEpoch,
			detachedCurrentAnchorSignature: new intrinsicUint8Array(state.detachedCurrentAnchorSignature),
			exactCanonicalCurrentAnchorPreimageBytes: new intrinsicUint8Array(state.exactCanonicalCurrentAnchorPreimageBytes),
			exactCanonicalProfileBytes: new intrinsicUint8Array(state.exactCanonicalProfileBytes),
			exactCanonicalSignerSetBytes: new intrinsicUint8Array(state.exactCanonicalSignerSetBytes),
			genesisAnchorDigest: trust.genesisAnchorDigest,
			objectId: trust.objectId,
			publicKey: new intrinsicUint8Array(state.publicKey),
			quorum: 1 as const,
		});
	};

	const mintCreatorAnchorTrustCheckpointPredecessor = (
		genesisTrust: CurrentAnchorTrust,
		exactCanonicalPredecessorAnchorPreimageBytes: Uint8Array,
		detachedPredecessorAnchorSignature: Uint8Array
	): CurrentAnchorTrust | undefined => {
		try {
			const genesisState = registry.get(genesisTrust);
			if (genesisState === undefined || genesisTrust.currentEpoch !== 0) return undefined;
			const anchorBytes = new intrinsicUint8Array(exactCanonicalPredecessorAnchorPreimageBytes);
			const signature = new intrinsicUint8Array(detachedPredecessorAnchorSignature);
			const decoded = decodeExact(anchorBytes);
			if (!decoded.ok || !isAnchorRecord(decoded.value)) return undefined;
			const anchor = decoded.value;
			const anchorDigestBytes = hashDomain(ANCHOR_DIGEST_DOMAIN, anchorBytes);
			const anchorDigest = bytesToHex(anchorDigestBytes);
			if (
				anchor.cryptoSuiteId !== ACTIVE_ANCHOR_SUITE ||
				anchor.objectId !== genesisTrust.objectId ||
				anchor.epoch < 1 ||
				anchor.profileDigest !== genesisState.profileDigest ||
				anchor.signerSetDigest !== genesisState.signerSetDigest ||
				!verifyStrictSignature(signature, anchorDigestBytes, genesisState.publicKey)
			) {
				return undefined;
			}
			return mintAnchorTrust(
				registry,
				{
					currentAnchorDigest: anchorDigest,
					currentEpoch: anchor.epoch,
					genesisAnchorDigest: genesisTrust.genesisAnchorDigest,
					objectId: genesisTrust.objectId,
					profileId: CREATOR_PROFILE,
				},
				{
					detachedCurrentAnchorSignature: signature,
					exactCanonicalCurrentAnchorPreimageBytes: anchorBytes,
					exactCanonicalProfileBytes: genesisState.exactCanonicalProfileBytes,
					exactCanonicalSignerSetBytes: genesisState.exactCanonicalSignerSetBytes,
					publicKey: genesisState.publicKey,
					profileDigest: genesisState.profileDigest,
					quorum: 1,
					signerSetDigest: genesisState.signerSetDigest,
				}
			);
		} catch {
			return undefined;
		}
	};

	const mintCreatorAnchorTrustSuccessor = (
		currentTrust: CurrentAnchorTrust,
		exactCanonicalSuccessorAnchorPreimageBytes: Uint8Array,
		detachedSuccessorAnchorSignature: Uint8Array
	): CurrentAnchorTrust | undefined => {
		try {
			const currentState = registry.get(currentTrust);
			if (currentState === undefined) return undefined;
			const anchorBytes = new intrinsicUint8Array(exactCanonicalSuccessorAnchorPreimageBytes);
			const signature = new intrinsicUint8Array(detachedSuccessorAnchorSignature);
			const decoded = decodeExact(anchorBytes);
			if (!decoded.ok || !isAnchorRecord(decoded.value)) return undefined;
			const anchor = decoded.value;
			const anchorDigestBytes = hashDomain(ANCHOR_DIGEST_DOMAIN, anchorBytes);
			const anchorDigest = bytesToHex(anchorDigestBytes);
			if (
				anchor.cryptoSuiteId !== ACTIVE_ANCHOR_SUITE ||
				anchor.objectId !== currentTrust.objectId ||
				anchor.epoch !== currentTrust.currentEpoch + 1 ||
				anchor.previousAnchor !== currentTrust.currentAnchorDigest ||
				anchor.profileDigest !== currentState.profileDigest ||
				anchor.signerSetDigest !== currentState.signerSetDigest ||
				!verifyStrictSignature(signature, anchorDigestBytes, currentState.publicKey)
			) {
				return undefined;
			}
			return mintAnchorTrust(
				registry,
				{
					currentAnchorDigest: anchorDigest,
					currentEpoch: anchor.epoch,
					genesisAnchorDigest: currentTrust.genesisAnchorDigest,
					objectId: currentTrust.objectId,
					profileId: CREATOR_PROFILE,
				},
				{
					detachedCurrentAnchorSignature: signature,
					exactCanonicalCurrentAnchorPreimageBytes: anchorBytes,
					exactCanonicalProfileBytes: currentState.exactCanonicalProfileBytes,
					exactCanonicalSignerSetBytes: currentState.exactCanonicalSignerSetBytes,
					publicKey: currentState.publicKey,
					profileDigest: currentState.profileDigest,
					quorum: 1,
					signerSetDigest: currentState.signerSetDigest,
				}
			);
		} catch {
			return undefined;
		}
	};

	return Object.freeze({
		authenticateCurrentEpochAnchor,
		installCertifiedAnchorTrustRoot,
		installCreatorAnchorTrustRoot,
		isAnchorTrustStateRecordBytes,
		openCertifiedAnchorTrust,
		openCurrentEpochAuthorAuthorization,
		openCurrentAnchorTrust,
		resolveCurrentEpochAuthorizedAuthor,
		[certifiedSealAuthorityResolver]: resolveCertifiedSealMaterial,
		[creatorAnchorTrustCheckpointPredecessorMinter]: mintCreatorAnchorTrustCheckpointPredecessor,
		[creatorAnchorTrustResolver]: resolveCreatorAnchorTrustMaterial,
		[creatorAnchorTrustSuccessorMinter]: mintCreatorAnchorTrustSuccessor,
	});
}

export interface VerifyReceivedVertexInput {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

export interface RegisteredVertexVerification {
	readonly accepted: boolean;
	readonly digest?: Uint8Array;
}

export interface EquivocationScope {
	readonly author: string;
	readonly authorSequence: number;
	readonly objectId: string;
}

export interface PersistedVertexWitness {
	readonly digest: Uint8Array;
	readonly witness: Omit<VerifyReceivedVertexInput, "resolveAuthorPublicKey">;
}

export interface PersistedEquivocationProof {
	readonly canonicalProofBytes: Uint8Array;
	readonly proofId: string;
}

export interface MaterializeCurrentEquivocationProofInput {
	readonly scope: EquivocationScope;
	readonly vertices: readonly [PersistedVertexWitness, PersistedVertexWitness];
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
}

export interface AuthorProjectionSlot {
	readonly scope: EquivocationScope;
	readonly digestHexes: readonly string[];
}

export interface PendingEquivocationPair {
	readonly scope: EquivocationScope;
	readonly lesserDigestHex: string;
	readonly greaterDigestHex: string;
	readonly pairId: string;
}

export interface DurableAuthorProjectionState {
	readonly slots: readonly AuthorProjectionSlot[];
	readonly pending: readonly PendingEquivocationPair[];
}

export interface AuthorProjectionDecision<Result> {
	readonly state: DurableAuthorProjectionState;
	readonly result: Result;
}

export interface DurableAuthorEquivocationProjectionOptions {
	readCommittedSlotState(scope: EquivocationScope): Promise<PersistedEquivocationState>;
	enumerateCommittedAuthorSlots(author: string): Promise<readonly EquivocationScope[]>;
	transactAuthorProjection<Result>(
		author: string,
		apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
	): Promise<Result>;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	handoffProof(proof: PersistedEquivocationProof): Promise<void>;
}

export interface ReconcileAuthorProjectionResult {
	readonly enqueuedPairIds: readonly string[];
	readonly newDigestCount: number;
}

export interface RecoverAuthorProjectionResult {
	readonly reconciledSlotCount: number;
}

export interface DrainAuthorProjectionResult {
	readonly handedOff: boolean;
	readonly remainingPending: number;
}

export interface DurableAuthorEquivocationProjection {
	reconcile(scope: EquivocationScope): Promise<ReconcileAuthorProjectionResult>;
	recover(author: string): Promise<RecoverAuthorProjectionResult>;
	drainOne(author: string): Promise<DrainAuthorProjectionResult>;
}

export type DetachedAuthorGossipSlot = AuthorProjectionSlot;

export interface DetachedAuthorGossipProjection {
	readonly author: string;
	readonly slots: readonly DetachedAuthorGossipSlot[];
}

export interface AuthorGossipBudgetPolicy {
	readonly maxGossipPairCount: number;
}

export interface AuthorGossipPair {
	readonly scope: EquivocationScope;
	readonly lesserDigestHex: string;
	readonly greaterDigestHex: string;
}

export interface AuthorGossipBudgetComposition {
	readonly author: string;
	readonly selectedPairs: readonly AuthorGossipPair[];
	readonly totalPairCount: number;
	readonly suppressedPairCount: number;
	readonly saturated: boolean;
}

export type DetachedAuthorReputationSlot = AuthorProjectionSlot;

export interface DetachedAuthorReputationProjection {
	readonly author: string;
	readonly slots: readonly DetachedAuthorReputationSlot[];
}

export interface AuthorAclReputationPolicy {
	readonly maxReputationPenalty: number;
}

export interface AuthorAclReputationComposition {
	readonly author: string;
	readonly equivocatingSlotCount: number;
	readonly totalCanonicalPairCount: number;
	readonly reputationPenalty: number;
	readonly saturated: boolean;
}

export interface SlotAdvisorySignal {
	readonly author: string;
	readonly observedForkCount: number;
	readonly advisoryLimitReached: boolean;
	readonly withinAdvisoryLimitProofCount: number;
	readonly overAdvisoryLimitProofCount: number;
}

export interface EquivocationResolution {
	readonly orderedDigests: readonly string[];
	readonly preferredDigest: string;
}

export interface PersistedEquivocationState {
	readonly proofs: readonly PersistedEquivocationProof[];
	readonly slotSignal: SlotAdvisorySignal;
	readonly vertices: readonly PersistedVertexWitness[];
}

export interface RemoteObservationResult {
	readonly admitted: boolean;
	readonly disposition: "duplicate" | "equivocation" | "invalid" | "new";
	readonly digest?: Uint8Array;
	readonly newlyPersistedProofIds: readonly string[];
	readonly resolution?: EquivocationResolution;
	readonly slotSignal?: SlotAdvisorySignal;
}

export interface EquivocationTransactionDecision {
	readonly result: RemoteObservationResult;
	readonly state: PersistedEquivocationState;
}

export type ApplyEquivocationPolicy = (state: PersistedEquivocationState) => EquivocationTransactionDecision;

export type TransactObservation = (
	scope: EquivocationScope,
	apply: ApplyEquivocationPolicy
) => Promise<RemoteObservationResult>;

export interface RemoteEquivocationObserver {
	observe(input: VerifyReceivedVertexInput): Promise<RemoteObservationResult>;
}

export interface RemoteEquivocationObserverOptions {
	readonly perSlotAdvisoryProofLimit: number;
	readonly transactObservation: TransactObservation;
}

export interface VerifyEquivocationProofInput {
	readonly canonicalProofBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
}

export interface EquivocationProofVerification {
	readonly digests?: readonly [string, string];
	readonly proofId?: string;
	readonly scope?: EquivocationScope;
	readonly verified: boolean;
}

export interface IssueScope {
	readonly author: string;
	readonly objectId: string;
}

export interface LocalVertexInput {
	readonly anchor: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly logicalTime: number;
	readonly objectId: string;
	readonly operation: Readonly<Record<string, unknown>>;
}

export interface SignedVertexEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

export interface IssuedVertexRecord {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly scope: IssueScope;
}

export interface IssuanceOutboxEntry {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly scope: IssueScope;
}

export interface IssueCommit {
	readonly authorSequence: number;
	readonly envelope: SignedVertexEnvelope;
	readonly issuedRecord: IssuedVertexRecord;
	readonly outboxEntry: IssuanceOutboxEntry;
}

export type BuildAndSign = (authorSequence: number) => Promise<IssueCommit>;

export type TransactIssue = (scope: IssueScope, buildAndSign: BuildAndSign) => Promise<IssueCommit>;

export type SignRegisteredVertexDigest = (registeredDigest: Uint8Array) => Promise<Uint8Array>;

export interface TransactionalVertexIssuer {
	issue(input: LocalVertexInput): Promise<IssueCommit>;
}

export interface TransactionalIssuerOptions {
	readonly author: string;
	readonly privateKeySeed: Uint8Array;
	readonly publicKey: RawEd25519PublicKey;
	readonly transactIssue: TransactIssue;
}

interface AdmitReceivedVertexInputFields {
	readonly domain: string;
	readonly expectedAnchor: string;
	readonly preparedBlueprintAdmission: PreparedBlueprintAdmission;
	readonly receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	readonly signature: Uint8Array;
	readonly suiteId: string;
}

export type AdmitReceivedVertexInput = Readonly<AdmitReceivedVertexInputFields>;

export interface AdmissionDecision {
	readonly admitted: boolean;
	readonly digest?: Uint8Array;
}

export type ExtractAdmittedReceivedVertexFailureReason = "malformed-input" | "not-authenticated" | "admission-rejected";

export interface AdmittedReceivedVertexView {
	readonly kind: "drp-vertex";
	readonly protocolMajor: 3;
	readonly objectId: string;
	readonly epoch: number;
	readonly anchor: string;
	readonly author: string;
	readonly authorSequence: number;
	readonly logicalTime: number;
	readonly dependencies: readonly string[];
	readonly operation: Readonly<Record<string, unknown>>;
	readonly digest: Uint8Array;
}

export type ExtractAdmittedReceivedVertexResult =
	| Readonly<{ readonly ok: false; readonly reason: ExtractAdmittedReceivedVertexFailureReason }>
	| Readonly<{ readonly ok: true; readonly vertex: AdmittedReceivedVertexView }>;

type AdmissionBoundTransactionalIssuerCommonOptions = Readonly<{
	readonly author: string;
	readonly preparedBlueprintAdmission: PreparedBlueprintAdmission;
	readonly publicKey: RawEd25519PublicKey;
	readonly transactIssue: TransactIssue;
}>;

export type AdmissionBoundTransactionalIssuerOptions = AdmissionBoundTransactionalIssuerCommonOptions &
	(
		| Readonly<{
				privateKeySeed: Uint8Array;
				signRegisteredVertexDigest?: never;
		  }>
		| Readonly<{
				privateKeySeed?: never;
				signRegisteredVertexDigest: SignRegisteredVertexDigest;
		  }>
	);

export interface BlueprintPreparationInput {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
}

export interface BlueprintRuntimePreparationInput {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly exactArtifactBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
	readonly preparedBlueprintAdmission: PreparedBlueprintAdmission;
}

/**
 * An admission capability prepared from a canonical, digest-bound blueprint package.
 *
 * Its public digest is informational. Consumer authorization is established by
 * module-private runtime provenance, so copying or reconstructing this value
 * does not produce a usable capability.
 */
export interface PreparedBlueprintAdmission {
	readonly blueprintDigest: string;
}

/**
 * A package-owned runtime capability bound to exact package and artifact bytes.
 *
 * Public fields are informational. Module-private provenance, distinct from the
 * admission capability provenance, establishes whether the capability is genuine.
 */
export interface PreparedBlueprintRuntime {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly reducers: Readonly<
		Record<
			string,
			(input: { readonly operation: unknown; readonly state: unknown }) => {
				readonly output: unknown;
				readonly state: unknown;
			}
		>
	>;
	readonly runtimeProfile: string;
}

/** A value does not satisfy the registered protocol-v3 vertex field contract. */
export class VertexValidationError extends TypeError {}

type BlueprintArgumentType = "canonical-object" | "safe-integer" | "string";

interface CompiledArgumentField {
	readonly name: string;
	readonly required: boolean;
	readonly type: BlueprintArgumentType;
}

interface CompiledOperationSchema {
	readonly allowedNames: ReadonlySet<string>;
	readonly fields: readonly CompiledArgumentField[];
	readonly maxCanonicalOperationBytes?: number;
}

interface PreparedBlueprintAdmissionState {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly blueprintDigest: string;
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly discriminator: string;
	readonly operations: ReadonlyMap<string, CompiledOperationSchema>;
	readonly runtimeProfile: string;
}

interface CompiledBlueprintPackage {
	readonly artifactDigest: string;
	readonly artifactId: string;
	readonly discriminator: string;
	readonly operations: ReadonlyMap<string, CompiledOperationSchema>;
	readonly runtimeProfile: string;
}

interface PreparedBlueprintRuntimeState {
	readonly admission: PreparedBlueprintAdmissionState;
	readonly exactArtifactBytes: Uint8Array;
	readonly namespace: object;
	readonly reducers: PreparedBlueprintRuntime["reducers"];
}

interface BlueprintArtifactProfile {
	readonly artifactDigestDomain: string;
	readonly runtimeProfile: string;
}

interface AuthenticatedReceivedVertex {
	readonly digest: Uint8Array;
	readonly preimage: Readonly<Record<string, unknown>>;
}

const registry = registryJson as ProtocolRegistry;
const vertexRegistry = registry.kinds.vertex;
if (vertexRegistry === undefined) throw new Error("protocol-v3 registry is missing the vertex kind");

const VERTEX_DOMAIN = registry.domains.vertex;
if (VERTEX_DOMAIN === undefined || VERTEX_DOMAIN !== vertexRegistry.domain) {
	throw new Error("protocol-v3 registry has inconsistent vertex domains");
}

const identitySuite = registry.cryptoSuites.active.find(({ role }) => role === "identityAndVertex");
if (identitySuite === undefined) {
	throw new Error("protocol-v3 registry is missing the active identityAndVertex suite");
}

const VERTEX_SUITE_ID = identitySuite.suiteId;
const BLUEPRINT_ADMISSION_DOMAIN = "ts-drp/blueprint-admission/v3";
const EQUIVOCATION_PROFILE_ID = "equivocation-digest-identity-v1";
const EQUIVOCATION_PROOF_KIND = "drp-equivocation-proof";
const EQUIVOCATION_PROOF_DOMAIN = "ts-drp/equivocation-proof/v1";
const textEncoder = new TextEncoder();
const blueprintArtifactProfile = compileBlueprintArtifactProfile(blueprintArtifactProfileJson);
const BLUEPRINT_ARTIFACT_DOMAIN = blueprintArtifactProfile.artifactDigestDomain;
const BLUEPRINT_RUNTIME_PROFILE = blueprintArtifactProfile.runtimeProfile;
const vertexFields = vertexRegistry.fields;
const vertexFieldNames = new Set(vertexFields.map(({ name }) => name));
const anchorFieldCandidate = vertexFields.find(({ name }) => name === "anchor");
if (anchorFieldCandidate === undefined) throw new Error("protocol-v3 vertex registry is missing anchor");
const anchorField: RegistryField = anchorFieldCandidate;

const preparedBlueprintAdmissions = new WeakMap<object, PreparedBlueprintAdmissionState>();
const preparedBlueprintRuntimes = new WeakMap<object, PreparedBlueprintRuntimeState>();

function ownDataProperty(input: Readonly<Record<string, unknown>>, name: string, context: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(input, name);
	if (descriptor === undefined) throw new TypeError(`${context}.${name} is required`);
	if (!Object.hasOwn(descriptor, "value")) {
		throw new TypeError(`${context}.${name} must be an own data property`);
	}
	return descriptor.value;
}

function assertClosedRecord(
	value: unknown,
	expectedKeys: readonly string[],
	context: string
): asserts value is Readonly<Record<string, unknown>> {
	if (!isPlainRecord(value)) throw new TypeError(`${context} must be a plain object`);
	const expected = new Set(expectedKeys);
	const keys = Reflect.ownKeys(value);
	if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
		throw new TypeError(`${context} must contain exactly ${expectedKeys.join(", ")}`);
	}
	for (const key of expectedKeys) ownDataProperty(value, key, context);
}

function assertNonEmptyString(value: unknown, context: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${context} must be a non-empty string`);
	}
	assertWellFormedString(value, context);
}

function assertClosedStringArray(value: unknown, context: string): asserts value is readonly string[] {
	if (!Array.isArray(value)) throw new TypeError(`${context} must be an array`);
	let previous: string | undefined;
	for (const entry of value) {
		assertNonEmptyString(entry, `${context} entry`);
		if (previous !== undefined && compareCodePointStrings(previous, entry) >= 0) {
			throw new TypeError(`${context} must contain unique strings in codepoint order`);
		}
		previous = entry;
	}
}

function compileBlueprintArtifactProfile(value: unknown): BlueprintArtifactProfile {
	assertClosedRecord(
		value,
		[
			"schemaVersion",
			"profileId",
			"protocolMajor",
			"artifactDigestDomain",
			"runtimeProfiles",
			"pureAllowlist",
			"frozenTuple",
		],
		"blueprint artifact profile"
	);
	if (
		ownDataProperty(value, "schemaVersion", "blueprint artifact profile") !== "ts-drp-blueprint-artifact-profile-v1" ||
		ownDataProperty(value, "profileId", "blueprint artifact profile") !== "ts-drp-blueprint-artifact-profile-v1" ||
		ownDataProperty(value, "protocolMajor", "blueprint artifact profile") !== 3
	) {
		throw new TypeError("blueprint artifact profile identity is unsupported");
	}
	const artifactDigestDomain = ownDataProperty(value, "artifactDigestDomain", "blueprint artifact profile");
	assertNonEmptyString(artifactDigestDomain, "blueprint artifact profile.artifactDigestDomain");
	const runtimeProfiles = ownDataProperty(value, "runtimeProfiles", "blueprint artifact profile");
	assertClosedStringArray(runtimeProfiles, "blueprint artifact profile.runtimeProfiles");
	if (runtimeProfiles.length !== 1) {
		throw new TypeError("blueprint artifact profile must define exactly one runtime profile");
	}

	const pureAllowlist = ownDataProperty(value, "pureAllowlist", "blueprint artifact profile");
	assertClosedRecord(pureAllowlist, ["identifiers", "mathMembers"], "blueprint artifact profile.pureAllowlist");
	assertClosedStringArray(
		ownDataProperty(pureAllowlist, "identifiers", "blueprint artifact profile.pureAllowlist"),
		"blueprint artifact profile.pureAllowlist.identifiers"
	);
	assertClosedStringArray(
		ownDataProperty(pureAllowlist, "mathMembers", "blueprint artifact profile.pureAllowlist"),
		"blueprint artifact profile.pureAllowlist.mathMembers"
	);
	const frozenTuple = ownDataProperty(value, "frozenTuple", "blueprint artifact profile");
	assertClosedRecord(
		frozenTuple,
		["checkpoint", "freezePolicyPath", "freezePolicySha256", "protectedPathCount", "protectedPathStatesSha256"],
		"blueprint artifact profile.frozenTuple"
	);
	assertNonEmptyString(
		ownDataProperty(frozenTuple, "checkpoint", "blueprint artifact profile.frozenTuple"),
		"blueprint artifact profile.frozenTuple.checkpoint"
	);
	assertNonEmptyString(
		ownDataProperty(frozenTuple, "freezePolicyPath", "blueprint artifact profile.frozenTuple"),
		"blueprint artifact profile.frozenTuple.freezePolicyPath"
	);
	assertDigestHexValue(
		ownDataProperty(frozenTuple, "freezePolicySha256", "blueprint artifact profile.frozenTuple"),
		"blueprint artifact profile.frozenTuple.freezePolicySha256"
	);
	if (ownDataProperty(frozenTuple, "protectedPathCount", "blueprint artifact profile.frozenTuple") !== 47) {
		throw new TypeError("blueprint artifact profile.frozenTuple.protectedPathCount is unsupported");
	}
	assertDigestHexValue(
		ownDataProperty(frozenTuple, "protectedPathStatesSha256", "blueprint artifact profile.frozenTuple"),
		"blueprint artifact profile.frozenTuple.protectedPathStatesSha256"
	);
	return Object.freeze({ artifactDigestDomain, runtimeProfile: runtimeProfiles[0] as string });
}

function assertDigestHexValue(value: unknown, context: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
		throw new TypeError(`${context} must be 32-byte lowercase digest hex`);
	}
}

function bytesToHex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function detachCanonicalRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const detached = decodeCanonical(encodeCanonical(value));
	if (!isPlainRecord(detached)) {
		throw new VertexValidationError("operation must be a canonical object");
	}
	return detached;
}

function assertWellFormedString(value: string, fieldName: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new VertexValidationError(`${fieldName} contains an unpaired surrogate`);
			}
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new VertexValidationError(`${fieldName} contains an unpaired surrogate`);
		}
	}
}

function numericConstraint(field: RegistryField, name: string): number | undefined {
	const value = field.constraints[name];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new Error(`protocol-v3 registry ${field.name}.${name} must be a safe integer`);
	}
	return value;
}

function validateString(field: RegistryField, value: unknown): asserts value is string {
	if (typeof value !== "string") throw new VertexValidationError(`${field.name} must be a string`);
	assertWellFormedString(value, field.name);
	const minimum = numericConstraint(field, "minimumUtf16Units");
	const maximum = numericConstraint(field, "maximumUtf16Units");
	if (minimum !== undefined && value.length < minimum) {
		throw new VertexValidationError(`${field.name} is shorter than its registry minimum`);
	}
	if (maximum !== undefined && value.length > maximum) {
		throw new VertexValidationError(`${field.name} exceeds its registry maximum`);
	}
}

function validateSafeInteger(field: RegistryField, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new VertexValidationError(`${field.name} must be a safe integer`);
	}
	const minimum = numericConstraint(field, "minimum");
	const maximum = numericConstraint(field, "maximum");
	if (minimum !== undefined && value < minimum) {
		throw new VertexValidationError(`${field.name} is below its registry minimum`);
	}
	if (maximum !== undefined && value > maximum) {
		throw new VertexValidationError(`${field.name} exceeds its registry maximum`);
	}
}

function validateDigestHex(field: RegistryField, value: unknown): asserts value is string {
	if (typeof value !== "string") {
		throw new VertexValidationError(`${field.name} must be lowercase digest hex`);
	}
	const bytes = numericConstraint(field, "bytes");
	if (bytes === undefined) throw new Error(`protocol-v3 registry ${field.name} is missing digest width`);
	if (field.constraints.case !== "lower") {
		throw new Error(`protocol-v3 registry ${field.name} must require lowercase digest hex`);
	}
	if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u").test(value)) {
		throw new VertexValidationError(`${field.name} must be ${bytes}-byte lowercase digest hex`);
	}
}

function compareCodePointStrings(left: string, right: string): number {
	return compareBytes(textEncoder.encode(left), textEncoder.encode(right));
}

function validateDigestArray(
	field: RegistryField,
	value: unknown,
	requireRegisteredOrder: boolean
): asserts value is string[] {
	if (!Array.isArray(value)) throw new VertexValidationError(`${field.name} must be an array`);
	const minimumItems = numericConstraint(field, "minimumItems");
	if (minimumItems !== undefined && value.length < minimumItems) {
		throw new VertexValidationError(`${field.name} has fewer than its registry minimum items`);
	}

	const itemField: RegistryField = {
		name: `${field.name} item`,
		type: "digest-hex",
		const: null,
		constraints: { bytes: 32, case: "lower" },
		required: true,
		sortRule: null,
	};
	const seen = new Set<string>();
	for (const item of value) {
		validateDigestHex(itemField, item);
		if (seen.has(item)) throw new VertexValidationError(`${field.name} must be unique`);
		seen.add(item);
	}

	if (field.constraints.unique !== true) {
		throw new Error(`protocol-v3 registry ${field.name} must require uniqueness`);
	}
	if (field.sortRule !== "codepoint") {
		throw new Error(`protocol-v3 registry ${field.name} must use codepoint order`);
	}
	if (requireRegisteredOrder) {
		for (let index = 1; index < value.length; index++) {
			if (compareCodePointStrings(value[index - 1] as string, value[index] as string) >= 0) {
				throw new VertexValidationError(`${field.name} are not in registry order`);
			}
		}
	}
}

function validateField(field: RegistryField, value: unknown, requireRegisteredOrder: boolean): void {
	if (field.const !== null && !Object.is(value, field.const)) {
		throw new VertexValidationError(`${field.name} must equal registry constant ${String(field.const)}`);
	}

	switch (field.type) {
		case "string":
			validateString(field, value);
			return;
		case "safe-integer":
			validateSafeInteger(field, value);
			return;
		case "digest-hex":
			validateDigestHex(field, value);
			return;
		case "array<digest-hex>":
			validateDigestArray(field, value, requireRegisteredOrder);
			return;
		case "canonical-object":
			if (!isPlainRecord(value)) {
				throw new VertexValidationError(`${field.name} must be a canonical object`);
			}
			return;
		default:
			throw new Error(`unsupported protocol-v3 vertex field type ${field.type}`);
	}
}

function ownDataValue(
	input: Readonly<Record<string, unknown>>,
	field: RegistryField,
	allowConstantDefault: boolean
): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(input, field.name);
	if (descriptor === undefined) {
		if (allowConstantDefault && field.const !== null) return field.const;
		throw new VertexValidationError(`${field.name} is required`);
	}
	if (!Object.hasOwn(descriptor, "value")) {
		throw new VertexValidationError(`${field.name} must be an own data property`);
	}
	return descriptor.value;
}

function registeredVertex(
	input: unknown,
	options: {
		readonly allowConstantDefaults: boolean;
		readonly rejectUnknownFields: boolean;
		readonly requireRegisteredOrder: boolean;
		readonly sortRegisteredArrays: boolean;
	}
): Readonly<Record<string, unknown>> {
	if (!isPlainRecord(input)) throw new VertexValidationError("vertex preimage must be a plain object");
	if (Object.getOwnPropertySymbols(input).length !== 0) {
		throw new VertexValidationError("vertex preimage cannot contain symbol fields");
	}
	if (options.rejectUnknownFields) {
		for (const key of Object.keys(input)) {
			if (!vertexFieldNames.has(key)) {
				throw new VertexValidationError(`vertex preimage contains unregistered field ${key}`);
			}
		}
	}

	const output: Record<string, unknown> = {};
	for (const field of vertexFields) {
		const value = ownDataValue(input, field, options.allowConstantDefaults);
		validateField(field, value, options.requireRegisteredOrder);
		output[field.name] =
			options.sortRegisteredArrays && field.sortRule === "codepoint"
				? [...(value as string[])].sort(compareCodePointStrings)
				: value;
	}
	return output;
}

function compileArgumentField(value: unknown, context: string): CompiledArgumentField {
	assertClosedRecord(value, ["name", "required", "type"], context);
	const name = ownDataProperty(value, "name", context);
	const required = ownDataProperty(value, "required", context);
	const type = ownDataProperty(value, "type", context);
	assertNonEmptyString(name, `${context}.name`);
	if (typeof required !== "boolean") throw new TypeError(`${context}.required must be a boolean`);
	if (type !== "canonical-object" && type !== "safe-integer" && type !== "string") {
		throw new TypeError(`${context}.type is unsupported`);
	}
	return Object.freeze({ name, required, type });
}

function compileOperation(
	value: unknown,
	discriminator: string,
	previousOperationName: string | undefined,
	hasWorkBudget: boolean,
	context: string
): readonly [string, CompiledOperationSchema] {
	assertClosedRecord(
		value,
		hasWorkBudget ? ["name", "argumentSchema", "maxCanonicalOperationBytes"] : ["name", "argumentSchema"],
		context
	);
	const name = ownDataProperty(value, "name", context);
	const argumentSchema = ownDataProperty(value, "argumentSchema", context);
	assertNonEmptyString(name, `${context}.name`);
	if (previousOperationName !== undefined && compareCodePointStrings(previousOperationName, name) >= 0) {
		throw new TypeError("blueprint manifest operations must have unique names in codepoint order");
	}
	let maxCanonicalOperationBytes: number | undefined;
	if (hasWorkBudget) {
		const candidate = ownDataProperty(value, "maxCanonicalOperationBytes", context);
		if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
			throw new RangeError(`${context}.maxCanonicalOperationBytes must be a positive safe integer`);
		}
		maxCanonicalOperationBytes = candidate as number;
	}
	assertClosedRecord(argumentSchema, ["kind", "fields"], `${context}.argumentSchema`);
	if (ownDataProperty(argumentSchema, "kind", `${context}.argumentSchema`) !== "closed-record") {
		throw new TypeError(`${context}.argumentSchema.kind must be closed-record`);
	}
	const fields = ownDataProperty(argumentSchema, "fields", `${context}.argumentSchema`);
	if (!Array.isArray(fields)) throw new TypeError(`${context}.argumentSchema.fields must be an array`);

	const compiledFields: CompiledArgumentField[] = [];
	let previousFieldName: string | undefined;
	for (let index = 0; index < fields.length; index++) {
		const compiled = compileArgumentField(fields[index], `${context}.argumentSchema.fields[${index}]`);
		if (compiled.name === discriminator) {
			throw new TypeError(`${context} cannot redeclare the operation discriminator`);
		}
		if (previousFieldName !== undefined && compareCodePointStrings(previousFieldName, compiled.name) >= 0) {
			throw new TypeError(`${context} argument fields must have unique names in codepoint order`);
		}
		compiledFields.push(compiled);
		previousFieldName = compiled.name;
	}
	const allowedNames = new Set<string>([discriminator, ...compiledFields.map((field) => field.name)]);
	return Object.freeze([
		name,
		Object.freeze({
			allowedNames,
			fields: Object.freeze(compiledFields),
			...(maxCanonicalOperationBytes === undefined ? {} : { maxCanonicalOperationBytes }),
		}),
	]);
}

function compileBlueprintPackage(value: unknown): CompiledBlueprintPackage {
	assertClosedRecord(
		value,
		["kind", "protocolMajor", "schemaVersion", "implementation", "manifest"],
		"blueprint package"
	);
	if (ownDataProperty(value, "kind", "blueprint package") !== "drp-blueprint-admission-package") {
		throw new TypeError("blueprint package.kind is unsupported");
	}
	if (ownDataProperty(value, "protocolMajor", "blueprint package") !== 3) {
		throw new TypeError("blueprint package.protocolMajor must be 3");
	}
	if (ownDataProperty(value, "schemaVersion", "blueprint package") !== 1) {
		throw new TypeError("blueprint package.schemaVersion must be 1");
	}

	const implementation = ownDataProperty(value, "implementation", "blueprint package");
	assertClosedRecord(
		implementation,
		["artifactId", "artifactDigest", "runtimeProfile"],
		"blueprint package.implementation"
	);
	const artifactId = ownDataProperty(implementation, "artifactId", "blueprint package.implementation");
	const artifactDigest = ownDataProperty(implementation, "artifactDigest", "blueprint package.implementation");
	const runtimeProfile = ownDataProperty(implementation, "runtimeProfile", "blueprint package.implementation");
	assertNonEmptyString(artifactId, "blueprint package.implementation.artifactId");
	assertDigestHexValue(artifactDigest, "blueprint package.implementation.artifactDigest");
	assertNonEmptyString(runtimeProfile, "blueprint package.implementation.runtimeProfile");

	const manifest = ownDataProperty(value, "manifest", "blueprint package");
	if (!isPlainRecord(manifest)) {
		throw new TypeError("blueprint package.manifest must be a plain object");
	}
	const manifestSchemaVersion = ownDataProperty(manifest, "schemaVersion", "blueprint package.manifest");
	const hasWorkBudget = manifestSchemaVersion === 2;
	assertClosedRecord(
		manifest,
		hasWorkBudget
			? ["schemaVersion", "operationDiscriminator", "workBudgetProfile", "operations"]
			: ["schemaVersion", "operationDiscriminator", "operations"],
		"blueprint package.manifest"
	);
	if (manifestSchemaVersion !== 1 && manifestSchemaVersion !== 2) {
		throw new TypeError("blueprint package.manifest.schemaVersion is unsupported");
	}
	if (
		hasWorkBudget &&
		ownDataProperty(manifest, "workBudgetProfile", "blueprint package.manifest") !== "blueprint-work-budget-v1"
	) {
		throw new TypeError("blueprint package.manifest.workBudgetProfile is unsupported");
	}
	const discriminator = ownDataProperty(manifest, "operationDiscriminator", "blueprint package.manifest");
	assertNonEmptyString(discriminator, "blueprint package.manifest.operationDiscriminator");
	const operations = ownDataProperty(manifest, "operations", "blueprint package.manifest");
	if (!Array.isArray(operations) || operations.length === 0) {
		throw new TypeError("blueprint package.manifest.operations must be a non-empty array");
	}

	const compiledOperations = new Map<string, CompiledOperationSchema>();
	let previousOperationName: string | undefined;
	for (let index = 0; index < operations.length; index++) {
		const [name, schema] = compileOperation(
			operations[index],
			discriminator,
			previousOperationName,
			hasWorkBudget,
			`blueprint package.manifest.operations[${index}]`
		);
		compiledOperations.set(name, schema);
		previousOperationName = name;
	}
	return Object.freeze({
		artifactDigest,
		artifactId,
		discriminator,
		operations: compiledOperations,
		runtimeProfile,
	});
}

function preparedAdmissionState(value: unknown): PreparedBlueprintAdmissionState | undefined {
	return value !== null && typeof value === "object" ? preparedBlueprintAdmissions.get(value) : undefined;
}

function consumerPreparedAdmissionState(input: object): PreparedBlueprintAdmissionState | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(input, "preparedBlueprintAdmission");
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
	return preparedAdmissionState(descriptor.value);
}

function operationSchemaForPreparedAdmission(
	operation: unknown,
	state: PreparedBlueprintAdmissionState
): CompiledOperationSchema | undefined {
	if (!isPlainRecord(operation) || Object.getOwnPropertySymbols(operation).length !== 0) return undefined;
	const discriminatorDescriptor = Object.getOwnPropertyDescriptor(operation, state.discriminator);
	if (
		discriminatorDescriptor === undefined ||
		!Object.hasOwn(discriminatorDescriptor, "value") ||
		typeof discriminatorDescriptor.value !== "string"
	) {
		return undefined;
	}
	const schema = state.operations.get(discriminatorDescriptor.value);
	if (schema === undefined) return undefined;

	const keys = Reflect.ownKeys(operation);
	if (keys.some((key) => typeof key !== "string" || !schema.allowedNames.has(key))) return undefined;

	for (const field of schema.fields) {
		const descriptor = Object.getOwnPropertyDescriptor(operation, field.name);
		if (descriptor === undefined) {
			if (field.required) return undefined;
			continue;
		}
		if (!Object.hasOwn(descriptor, "value")) return undefined;
		switch (field.type) {
			case "canonical-object":
				if (!isPlainRecord(descriptor.value)) return undefined;
				break;
			case "safe-integer":
				if (typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value)) return undefined;
				break;
			case "string":
				if (typeof descriptor.value !== "string") return undefined;
				try {
					assertWellFormedString(descriptor.value, field.name);
				} catch {
					return undefined;
				}
				break;
		}
	}
	return schema;
}

function operationWithinCanonicalByteBudget(
	operation: Readonly<Record<string, unknown>>,
	schema: CompiledOperationSchema
): boolean {
	return (
		schema.maxCanonicalOperationBytes === undefined ||
		encodeCanonical(operation).byteLength <= schema.maxCanonicalOperationBytes
	);
}

/**
 * Prepares an unforgeable admission capability from exact canonical package bytes.
 * @param input - Canonical package bytes and the digest proven by the caller.
 * @returns A capability accepted by admitReceivedVertex and createAdmissionBoundTransactionalVertexIssuer.
 */
export function prepareBlueprintAdmission(input: BlueprintPreparationInput): PreparedBlueprintAdmission {
	assertClosedRecord(
		input,
		["canonicalBlueprintPackageBytes", "expectedBlueprintDigest"],
		"blueprint preparation input"
	);
	const suppliedBytes = ownDataProperty(input, "canonicalBlueprintPackageBytes", "blueprint preparation input");
	const expectedBlueprintDigest = ownDataProperty(input, "expectedBlueprintDigest", "blueprint preparation input");
	if (!(suppliedBytes instanceof Uint8Array)) {
		throw new TypeError("canonicalBlueprintPackageBytes must be a Uint8Array");
	}
	assertDigestHexValue(expectedBlueprintDigest, "expectedBlueprintDigest");

	const canonicalBlueprintPackageBytes = new Uint8Array(suppliedBytes);
	const decoded = decodeCanonical(canonicalBlueprintPackageBytes);
	const reencoded = encodeCanonical(decoded);
	if (compareBytes(reencoded, canonicalBlueprintPackageBytes) !== 0) {
		throw new TypeError("blueprint package bytes must use the canonical encoding");
	}
	const actualBlueprintDigest = bytesToHex(hashDomain(BLUEPRINT_ADMISSION_DOMAIN, canonicalBlueprintPackageBytes));
	if (actualBlueprintDigest !== expectedBlueprintDigest) {
		throw new TypeError("blueprint package digest does not match expectedBlueprintDigest");
	}

	const compiled = compileBlueprintPackage(decoded);
	const prepared = Object.freeze({ blueprintDigest: actualBlueprintDigest });
	preparedBlueprintAdmissions.set(
		prepared,
		Object.freeze({
			...compiled,
			blueprintDigest: actualBlueprintDigest,
			canonicalBlueprintPackageBytes,
		})
	);
	return prepared;
}

function bytesToBase64(bytes: Uint8Array): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		const packed = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
		output += alphabet[(packed >>> 18) & 0x3f];
		output += alphabet[(packed >>> 12) & 0x3f];
		output += second === undefined ? "=" : alphabet[(packed >>> 6) & 0x3f];
		output += third === undefined ? "=" : alphabet[packed & 0x3f];
	}
	return output;
}

function assertSamePreparedPackage(
	actualBlueprintDigest: string,
	canonicalBlueprintPackageBytes: Uint8Array,
	compiled: CompiledBlueprintPackage,
	prepared: PreparedBlueprintAdmissionState,
	expectedBlueprintDigest: string
): void {
	if (
		actualBlueprintDigest !== expectedBlueprintDigest ||
		actualBlueprintDigest !== prepared.blueprintDigest ||
		compareBytes(canonicalBlueprintPackageBytes, prepared.canonicalBlueprintPackageBytes) !== 0 ||
		compiled.artifactDigest !== prepared.artifactDigest ||
		compiled.artifactId !== prepared.artifactId ||
		compiled.runtimeProfile !== prepared.runtimeProfile
	) {
		throw new TypeError("blueprint package does not match the prepared admission capability");
	}
}

function prepareReducerTable(
	value: unknown,
	expectedOperationNames: readonly string[]
): PreparedBlueprintRuntime["reducers"] {
	assertClosedRecord(value, expectedOperationNames, "blueprint export.reducers");
	const prepared = Object.create(null) as Record<string, (...arguments_: readonly unknown[]) => unknown>;
	for (const name of expectedOperationNames) {
		const reducer = ownDataProperty(value, name, "blueprint export.reducers");
		if (typeof reducer !== "function" || Object.getPrototypeOf(reducer) !== Function.prototype) {
			throw new TypeError(`blueprint export.reducers.${name} must be a synchronous non-generator function`);
		}
		prepared[name] = reducer as (...arguments_: readonly unknown[]) => unknown;
	}
	return Object.freeze(prepared) as PreparedBlueprintRuntime["reducers"];
}

function prepareRuntimeExport(
	namespace: Readonly<Record<string, unknown>>,
	expectedOperationNames: readonly string[],
	compiled: CompiledBlueprintPackage
): PreparedBlueprintRuntime["reducers"] {
	const namespaceKeys = Object.getOwnPropertyNames(namespace);
	if (namespaceKeys.length !== 1 || namespaceKeys[0] !== "blueprint") {
		throw new TypeError("blueprint artifact must export only blueprint");
	}
	const envelope = ownDataProperty(namespace, "blueprint", "blueprint artifact namespace");
	assertClosedRecord(envelope, ["exportSchemaVersion", "artifactId", "runtimeProfile", "reducers"], "blueprint export");
	if (ownDataProperty(envelope, "exportSchemaVersion", "blueprint export") !== 1) {
		throw new TypeError("blueprint export.exportSchemaVersion must be 1");
	}
	if (ownDataProperty(envelope, "artifactId", "blueprint export") !== compiled.artifactId) {
		throw new TypeError("blueprint export.artifactId does not match the canonical package");
	}
	if (ownDataProperty(envelope, "runtimeProfile", "blueprint export") !== compiled.runtimeProfile) {
		throw new TypeError("blueprint export.runtimeProfile does not match the canonical package");
	}
	return prepareReducerTable(ownDataProperty(envelope, "reducers", "blueprint export"), expectedOperationNames);
}

/**
 * Prepares a runtime capability from a genuine admission capability, its exact
 * canonical package bytes, and the exact self-contained ESM artifact bytes.
 *
 * Both byte arrays are copied before the first asynchronous boundary. The
 * package digest, known runtime profile, artifact digest, UTF-8 source, import
 * closure and export shape are then checked in that order before reducers are
 * exposed. Reducers are never invoked by this preparation step.
 * @param input - The closed package-owned runtime preparation input.
 * @returns A distinct runtime capability carrying exact-byte provenance.
 */
export async function prepareBlueprintRuntime(
	input: BlueprintRuntimePreparationInput
): Promise<PreparedBlueprintRuntime> {
	assertClosedRecord(
		input,
		["preparedBlueprintAdmission", "canonicalBlueprintPackageBytes", "expectedBlueprintDigest", "exactArtifactBytes"],
		"blueprint runtime preparation input"
	);
	const preparedBlueprintAdmission = ownDataProperty(
		input,
		"preparedBlueprintAdmission",
		"blueprint runtime preparation input"
	);
	const suppliedPackageBytes = ownDataProperty(
		input,
		"canonicalBlueprintPackageBytes",
		"blueprint runtime preparation input"
	);
	const expectedBlueprintDigest = ownDataProperty(
		input,
		"expectedBlueprintDigest",
		"blueprint runtime preparation input"
	);
	const suppliedArtifactBytes = ownDataProperty(input, "exactArtifactBytes", "blueprint runtime preparation input");
	if (!(suppliedPackageBytes instanceof Uint8Array)) {
		throw new TypeError("canonicalBlueprintPackageBytes must be a Uint8Array");
	}
	if (!(suppliedArtifactBytes instanceof Uint8Array)) {
		throw new TypeError("exactArtifactBytes must be a Uint8Array");
	}
	assertDigestHexValue(expectedBlueprintDigest, "expectedBlueprintDigest");

	const canonicalBlueprintPackageBytes = new Uint8Array(suppliedPackageBytes);
	const exactArtifactBytes = new Uint8Array(suppliedArtifactBytes);
	const preparedAdmission = preparedAdmissionState(preparedBlueprintAdmission);
	if (preparedAdmission === undefined) {
		throw new TypeError("preparedBlueprintAdmission must be produced by prepareBlueprintAdmission");
	}

	const decodedPackage = decodeCanonical(canonicalBlueprintPackageBytes);
	const reencodedPackage = encodeCanonical(decodedPackage);
	if (compareBytes(reencodedPackage, canonicalBlueprintPackageBytes) !== 0) {
		throw new TypeError("blueprint package bytes must use the canonical encoding");
	}
	const actualBlueprintDigest = bytesToHex(hashDomain(BLUEPRINT_ADMISSION_DOMAIN, canonicalBlueprintPackageBytes));
	const compiled = compileBlueprintPackage(decodedPackage);
	assertSamePreparedPackage(
		actualBlueprintDigest,
		canonicalBlueprintPackageBytes,
		compiled,
		preparedAdmission,
		expectedBlueprintDigest
	);

	if (compiled.runtimeProfile !== BLUEPRINT_RUNTIME_PROFILE) {
		throw new TypeError(`unsupported blueprint runtime profile: ${compiled.runtimeProfile}`);
	}
	const actualArtifactDigest = bytesToHex(hashDomain(BLUEPRINT_ARTIFACT_DOMAIN, exactArtifactBytes));
	if (actualArtifactDigest !== compiled.artifactDigest) {
		throw new TypeError("blueprint artifact digest does not match the canonical package");
	}
	if (exactArtifactBytes[0] === 0xef && exactArtifactBytes[1] === 0xbb && exactArtifactBytes[2] === 0xbf) {
		throw new TypeError("blueprint artifact must not begin with a UTF-8 BOM");
	}
	const source = new TextDecoder("utf-8", { fatal: true }).decode(exactArtifactBytes);

	await initializeModuleLexer;
	const [imports, exports] = parseModule(source);
	if (imports.length !== 0) {
		throw new TypeError("blueprint artifact imports and import.meta are forbidden");
	}
	if (exports.length !== 1 || exports[0]?.n !== "blueprint") {
		throw new TypeError("blueprint artifact must declare only the blueprint export");
	}

	const exactByteUrl = `data:text/javascript;base64,${bytesToBase64(exactArtifactBytes)}`;
	const namespace = (await import(exactByteUrl)) as Readonly<Record<string, unknown>>;
	const operationNames = [...preparedAdmission.operations.keys()];
	const reducers = prepareRuntimeExport(namespace, operationNames, compiled);
	const prepared = Object.freeze({
		artifactDigest: actualArtifactDigest,
		artifactId: compiled.artifactId,
		blueprintDigest: actualBlueprintDigest,
		reducers,
		runtimeProfile: compiled.runtimeProfile,
	});
	preparedBlueprintRuntimes.set(
		prepared,
		Object.freeze({
			admission: preparedAdmission,
			exactArtifactBytes,
			namespace,
			reducers,
		})
	);
	return prepared;
}

export interface ApplyPreparedBlueprintOperationInput {
	readonly expectedBlueprintDigest: string;
	readonly operation: unknown;
	readonly preparedBlueprintRuntime: PreparedBlueprintRuntime;
	readonly state: unknown;
}

export interface PreparedBlueprintOperationResult {
	readonly output: unknown;
	readonly state: unknown;
}

function applicationFailure(
	code:
		| "BLUEPRINT_DIGEST_MISMATCH"
		| "BLUEPRINT_OPERATION_INVALID"
		| "BLUEPRINT_REDUCER_ASYNC"
		| "BLUEPRINT_REDUCER_FAILED"
		| "BLUEPRINT_RESULT_INVALID"
		| "BLUEPRINT_RUNTIME_PROVENANCE",
	message: string,
	cause?: unknown
): never {
	throw new DRPError(code, message, cause === undefined ? undefined : { cause });
}

/**
 * Applies one schema-validated operation through a genuine prepared runtime.
 *
 * Reducer selection uses only the module-private prepared runtime state. Both
 * reducer inputs and both returned values cross canonical clone boundaries.
 * @param input - Prepared runtime, expected digest, application state, and operation.
 * @returns Detached next state and operation result.
 */
export function applyPreparedBlueprintOperation(
	input: ApplyPreparedBlueprintOperationInput
): PreparedBlueprintOperationResult {
	assertClosedRecord(
		input,
		["expectedBlueprintDigest", "operation", "preparedBlueprintRuntime", "state"],
		"blueprint application input"
	);
	const expectedBlueprintDigest = ownDataProperty(input, "expectedBlueprintDigest", "blueprint application input");
	const preparedBlueprintRuntime = ownDataProperty(input, "preparedBlueprintRuntime", "blueprint application input");
	const operation = ownDataProperty(input, "operation", "blueprint application input");
	const state = ownDataProperty(input, "state", "blueprint application input");
	if (typeof expectedBlueprintDigest !== "string") {
		return applicationFailure("BLUEPRINT_DIGEST_MISMATCH", "expected blueprint digest is invalid");
	}
	const runtimeState =
		preparedBlueprintRuntime !== null && typeof preparedBlueprintRuntime === "object"
			? preparedBlueprintRuntimes.get(preparedBlueprintRuntime)
			: undefined;
	if (runtimeState === undefined) {
		return applicationFailure(
			"BLUEPRINT_RUNTIME_PROVENANCE",
			"prepared blueprint runtime does not have module-private provenance"
		);
	}
	if (expectedBlueprintDigest !== runtimeState.admission.blueprintDigest) {
		return applicationFailure("BLUEPRINT_DIGEST_MISMATCH", "prepared blueprint digest does not match caller binding");
	}

	let operationSchema: CompiledOperationSchema | undefined;
	let detachedOperation: Readonly<Record<string, unknown>>;
	try {
		operationSchema = operationSchemaForPreparedAdmission(operation, runtimeState.admission);
		if (
			operationSchema === undefined ||
			!operationWithinCanonicalByteBudget(operation as Readonly<Record<string, unknown>>, operationSchema)
		) {
			return applicationFailure("BLUEPRINT_OPERATION_INVALID", "operation does not match the prepared schema");
		}
		detachedOperation = deepCloneCanonical(operation as Readonly<Record<string, unknown>>);
	} catch (error) {
		if (error instanceof DRPError) throw error;
		return applicationFailure("BLUEPRINT_OPERATION_INVALID", "operation is outside the canonical domain", error);
	}
	const discriminator = ownDataProperty(detachedOperation, runtimeState.admission.discriminator, "blueprint operation");
	const reducer = runtimeState.reducers[discriminator as string];
	if (typeof reducer !== "function") {
		return applicationFailure("BLUEPRINT_OPERATION_INVALID", "prepared reducer is unavailable");
	}

	let detachedState: unknown;
	try {
		detachedState = deepCloneCanonical(state);
	} catch (error) {
		return applicationFailure("BLUEPRINT_RESULT_INVALID", "application state is outside the canonical domain", error);
	}

	let result: unknown;
	try {
		result = intrinsicReflectApply(reducer, undefined, [
			Object.freeze({ operation: detachedOperation, state: detachedState }),
		]);
	} catch (error) {
		return applicationFailure("BLUEPRINT_REDUCER_FAILED", "blueprint reducer threw synchronously", error);
	}
	if (result !== null && (typeof result === "object" || typeof result === "function")) {
		try {
			if (typeof intrinsicReflectGet(result, "then") === "function") {
				return applicationFailure("BLUEPRINT_REDUCER_ASYNC", "blueprint reducer returned an asynchronous result");
			}
		} catch (error) {
			if (error instanceof DRPError) throw error;
			return applicationFailure("BLUEPRINT_REDUCER_ASYNC", "blueprint reducer returned a hostile thenable", error);
		}
	}

	try {
		assertClosedRecord(result, ["state", "output"], "blueprint reducer result");
		return Object.freeze({
			output: deepCloneCanonical(ownDataProperty(result, "output", "blueprint reducer result")),
			state: deepCloneCanonical(ownDataProperty(result, "state", "blueprint reducer result")),
		});
	} catch (error) {
		if (error instanceof DRPError) throw error;
		return applicationFailure("BLUEPRINT_RESULT_INVALID", "blueprint reducer returned an invalid result", error);
	}
}

/**
 * Derives the registry-v1 signed vertex field set in review order.
 *
 * Canonical object key order remains owned by `@ts-drp/canonical`; registry
 * order controls field selection and review only.
 * @param input - Candidate vertex fields.
 * @returns The validated registered field set in registry review order.
 */
export function vertexPreimage(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return registeredVertex(input, {
		allowConstantDefaults: true,
		rejectUnknownFields: false,
		requireRegisteredOrder: false,
		sortRegisteredArrays: true,
	});
}

/**
 * Encodes one validated registry-v1 vertex preimage.
 * @param input - Candidate vertex fields.
 * @returns Frozen-profile canonical bytes.
 */
export function vertexCanonicalBytes(input: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical(vertexPreimage(input));
}

/**
 * Computes the registered v3 vertex digest from a locally built preimage.
 * @param input - Candidate vertex fields.
 * @returns The registered 32-byte digest.
 */
export function vertexDigest(input: Readonly<Record<string, unknown>>): Uint8Array {
	return digestReceivedVertexPreimage(vertexCanonicalBytes(input));
}

/**
 * Hashes the exact supplied bytes using the registry-selected v3 vertex domain.
 * @param receivedCanonicalPreimageBytes - Exact received or locally encoded preimage bytes.
 * @returns The registered 32-byte digest.
 */
export function digestReceivedVertexPreimage(receivedCanonicalPreimageBytes: Uint8Array): Uint8Array {
	if (!(receivedCanonicalPreimageBytes instanceof Uint8Array)) {
		throw new TypeError("receivedCanonicalPreimageBytes must be a Uint8Array");
	}
	return hashDomain(VERTEX_DOMAIN, receivedCanonicalPreimageBytes);
}

/**
 * Verifies an Ed25519 signature under the protocol-v3 acceptance profile.
 *
 * The message is the raw registered digest, not its hexadecimal text or a
 * wrapper object. Shape errors and invalid encodings fail closed.
 * @param signature - The 64-byte `R || S` Ed25519 signature.
 * @param rawRegisteredDigest - The exact 32-byte registered digest.
 * @param publicKey - The 32-byte compressed Edwards-y public key.
 * @returns Whether noble 2.2.0 strict verification accepts the tuple.
 */
export function verifyEd25519RegisteredDigest(
	signature: Uint8Array,
	rawRegisteredDigest: Uint8Array,
	publicKey: Uint8Array
): boolean {
	if (
		!(signature instanceof Uint8Array) ||
		signature.byteLength !== 64 ||
		!(rawRegisteredDigest instanceof Uint8Array) ||
		rawRegisteredDigest.byteLength !== 32 ||
		!(publicKey instanceof Uint8Array) ||
		publicKey.byteLength !== 32
	) {
		return false;
	}

	try {
		return ed25519.verify(signature, rawRegisteredDigest, publicKey, { zip215: false });
	} catch {
		return false;
	}
}

/**
 * Creates a local v3 issuer over one injected transaction boundary.
 *
 * Sequence selection, atomic commit and durable storage remain owned by the
 * injected coordinator. The issuer only snapshots the request, builds the
 * registered bytes for the coordinator-selected ordinal and signs their exact
 * registered digest.
 * @param options - Author key material and transaction coordinator.
 * @returns A stateless transactional issuer.
 */
export function createTransactionalVertexIssuer(options: TransactionalIssuerOptions): TransactionalVertexIssuer {
	if (!(options.privateKeySeed instanceof intrinsicUint8Array) || options.privateKeySeed.byteLength !== 32) {
		throw new TypeError("private key seed must be a 32-byte Uint8Array");
	}
	const privateKeySeed = new intrinsicUint8Array(options.privateKeySeed);
	const common = captureTransactionalIssuerCommon(options);
	if (compareBytes(ed25519.getPublicKey(privateKeySeed), common.publicKeyBytes) !== 0) {
		throw new TypeError("public and private Ed25519 keys do not match");
	}
	return createTransactionalVertexIssuerCore(common, { kind: "private-key-seed", privateKeySeed });
}

interface TransactionalIssuerCommonState {
	readonly author: string;
	readonly publicKeyBytes: Uint8Array;
	readonly transactIssue: TransactIssue;
}

type TransactionalIssuerSigningState =
	| Readonly<{ readonly kind: "private-key-seed"; readonly privateKeySeed: Uint8Array }>
	| Readonly<{
			readonly kind: "registered-digest-callback";
			readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
	  }>;

function captureTransactionalIssuerCommon(
	options: Readonly<{
		readonly author: string;
		readonly publicKey: RawEd25519PublicKey;
		readonly transactIssue: TransactIssue;
	}>
): TransactionalIssuerCommonState {
	if (
		options.publicKey.format !== "raw" ||
		!(options.publicKey.bytes instanceof intrinsicUint8Array) ||
		options.publicKey.bytes.byteLength !== 32
	) {
		throw new TypeError("public key must be a 32-byte raw Ed25519 key");
	}
	if (typeof options.transactIssue !== "function") {
		throw new TypeError("transactIssue must be a function");
	}

	return {
		author: options.author,
		publicKeyBytes: new intrinsicUint8Array(options.publicKey.bytes),
		transactIssue: options.transactIssue,
	};
}

const SIGNER_RESULT_ERROR = "signRegisteredVertexDigest must return a 64-byte Uint8Array";

function copyExactRegisteredDigestSignature(value: unknown): Uint8Array {
	try {
		if (intrinsicObjectGetPrototypeOf(value) !== intrinsicUint8ArrayPrototype) {
			throw new TypeError(SIGNER_RESULT_ERROR);
		}
		const bytes = value as Uint8Array;
		if (
			intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, bytes, []) !== 0 ||
			intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, bytes, []) !== 64
		) {
			throw new TypeError(SIGNER_RESULT_ERROR);
		}
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, bytes, []);
		if (
			intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBufferPrototype ||
			intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []) !== 64 ||
			(intrinsicArrayBufferResizableGetter !== undefined &&
				intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []))
		) {
			throw new TypeError(SIGNER_RESULT_ERROR);
		}
		return new intrinsicUint8Array(bytes);
	} catch {
		throw new TypeError(SIGNER_RESULT_ERROR);
	}
}

function createTransactionalVertexIssuerCore(
	common: TransactionalIssuerCommonState,
	signingState: TransactionalIssuerSigningState,
	operationAdmission?: (operation: Readonly<Record<string, unknown>>) => CompiledOperationSchema | undefined
): TransactionalVertexIssuer {
	const { author, publicKeyBytes, transactIssue } = common;

	return {
		async issue(input: LocalVertexInput): Promise<IssueCommit> {
			if (operationAdmission !== undefined && operationAdmission(input.operation) === undefined) {
				throw new VertexValidationError("operation does not match the prepared blueprint ABI");
			}
			const operation = detachCanonicalRecord(input.operation);
			if (operationAdmission !== undefined) {
				const schema = operationAdmission(operation);
				if (schema === undefined) {
					throw new VertexValidationError("operation does not match the prepared blueprint ABI");
				}
				if (!operationWithinCanonicalByteBudget(operation, schema)) {
					throw new RangeError("operation exceeds the prepared blueprint canonical byte budget");
				}
			}
			const detachedInput: LocalVertexInput = {
				anchor: input.anchor,
				dependencies: [...input.dependencies],
				epoch: input.epoch,
				logicalTime: input.logicalTime,
				objectId: input.objectId,
				operation,
			};
			const scope: IssueScope = { author, objectId: detachedInput.objectId };

			return transactIssue(scope, async (authorSequence) => {
				const canonicalPreimageBytes = vertexCanonicalBytes({
					kind: "drp-vertex",
					protocolMajor: 3,
					objectId: detachedInput.objectId,
					epoch: detachedInput.epoch,
					anchor: detachedInput.anchor,
					author,
					authorSequence,
					logicalTime: detachedInput.logicalTime,
					dependencies: detachedInput.dependencies,
					operation: detachedInput.operation,
				});
				const digest = digestReceivedVertexPreimage(canonicalPreimageBytes);
				let signature: Uint8Array;
				if (signingState.kind === "private-key-seed") {
					signature = ed25519.sign(digest, signingState.privateKeySeed);
				} else {
					const retainedDigest = new intrinsicUint8Array(digest);
					const callbackDigest = new intrinsicUint8Array(digest);
					const callbackResult = await intrinsicReflectApply(signingState.signRegisteredVertexDigest, undefined, [
						callbackDigest,
					]);
					signature = copyExactRegisteredDigestSignature(callbackResult);
					if (!verifyEd25519RegisteredDigest(signature, retainedDigest, publicKeyBytes)) {
						throw new VertexValidationError("signRegisteredVertexDigest returned an invalid signature");
					}
				}
				const envelope: SignedVertexEnvelope = {
					canonicalPreimageBytes,
					digest,
					signature,
				};

				return {
					authorSequence,
					envelope,
					issuedRecord: { authorSequence, envelope, scope },
					outboxEntry: { authorSequence, envelope, scope },
				};
			});
		},
	};
}

/**
 * Creates an application issuer bound to a genuine prepared blueprint admission.
 *
 * Both the caller-provided operation and its canonical detached copy must match
 * the prepared ABI before the transaction coordinator is entered.
 * @param options - Prepared admission, author key material and transaction coordinator.
 * @returns A stateless admission-bound transactional issuer.
 */
export function createAdmissionBoundTransactionalVertexIssuer(
	options: AdmissionBoundTransactionalIssuerOptions
): TransactionalVertexIssuer {
	const preparedState = consumerPreparedAdmissionState(options);
	if (preparedState === undefined) {
		throw new TypeError("preparedBlueprintAdmission must be produced by prepareBlueprintAdmission");
	}
	let privateKeySeedDescriptor: PropertyDescriptor | undefined;
	let signerDescriptor: PropertyDescriptor | undefined;
	try {
		privateKeySeedDescriptor = intrinsicObjectGetOwnPropertyDescriptor(options, "privateKeySeed");
		signerDescriptor = intrinsicObjectGetOwnPropertyDescriptor(options, "signRegisteredVertexDigest");
	} catch {
		throw new TypeError("exactly one signing arm must be an own data property");
	}
	const hasPrivateKeySeed =
		privateKeySeedDescriptor !== undefined && intrinsicObjectHasOwn(privateKeySeedDescriptor, "value");
	const hasSigner = signerDescriptor !== undefined && intrinsicObjectHasOwn(signerDescriptor, "value");
	if (hasPrivateKeySeed === hasSigner) {
		throw new TypeError("exactly one signing arm must be an own data property");
	}

	const common = captureTransactionalIssuerCommon(options);
	let signingState: TransactionalIssuerSigningState;
	if (hasPrivateKeySeed) {
		if (privateKeySeedDescriptor === undefined) throw new TypeError("private key seed is unavailable");
		const privateKeySeed = privateKeySeedDescriptor.value;
		if (!(privateKeySeed instanceof intrinsicUint8Array) || privateKeySeed.byteLength !== 32) {
			throw new TypeError("private key seed must be a 32-byte Uint8Array");
		}
		const detachedPrivateKeySeed = new intrinsicUint8Array(privateKeySeed);
		if (compareBytes(ed25519.getPublicKey(detachedPrivateKeySeed), common.publicKeyBytes) !== 0) {
			throw new TypeError("public and private Ed25519 keys do not match");
		}
		signingState = { kind: "private-key-seed", privateKeySeed: detachedPrivateKeySeed };
	} else {
		if (signerDescriptor === undefined) throw new TypeError("registered digest signer is unavailable");
		const signer = signerDescriptor.value;
		if (typeof signer !== "function") throw new TypeError("signRegisteredVertexDigest must be a function");
		if (common.author !== bytesToHex(common.publicKeyBytes)) {
			throw new TypeError("author must equal the lowercase raw Ed25519 public key");
		}
		signingState = {
			kind: "registered-digest-callback",
			signRegisteredVertexDigest: signer as SignRegisteredVertexDigest,
		};
	}

	return createTransactionalVertexIssuerCore(common, signingState, (operation) =>
		operationSchemaForPreparedAdmission(operation, preparedState)
	);
}

function authenticateReceivedVertex(input: VerifyReceivedVertexInput): AuthenticatedReceivedVertex | undefined {
	if (
		input === null ||
		typeof input !== "object" ||
		input.domain !== VERTEX_DOMAIN ||
		input.suiteId !== VERTEX_SUITE_ID ||
		!(input.receivedCanonicalPreimageBytes instanceof Uint8Array) ||
		!(input.signature instanceof Uint8Array) ||
		input.signature.byteLength !== 64 ||
		typeof input.resolveAuthorPublicKey !== "function"
	) {
		return undefined;
	}

	try {
		validateDigestHex(anchorField, input.expectedAnchor);
		const decoded = decodeCanonical(input.receivedCanonicalPreimageBytes);
		const preimage = registeredVertex(decoded, {
			allowConstantDefaults: false,
			rejectUnknownFields: true,
			requireRegisteredOrder: true,
			sortRegisteredArrays: false,
		});
		if (preimage.anchor !== input.expectedAnchor) return undefined;

		const digest = digestReceivedVertexPreimage(input.receivedCanonicalPreimageBytes);
		const author = preimage.author;
		if (typeof author !== "string") return undefined;
		const publicKey = input.resolveAuthorPublicKey(author);
		if (publicKey?.format !== "raw" || !(publicKey.bytes instanceof Uint8Array) || publicKey.bytes.byteLength !== 32) {
			return undefined;
		}

		if (!verifyEd25519RegisteredDigest(input.signature, digest, publicKey.bytes)) {
			return undefined;
		}
		return { digest, preimage };
	} catch {
		return undefined;
	}
}

/**
 * Verifies a received v3 vertex without ever substituting re-encoded bytes.
 *
 * Domain, suite, signature shape, canonical syntax, registered fields and
 * anchor scope all fail closed before author-key resolution.
 * @param input - Received bytes, signature, expected scope and author-key resolver.
 * @returns Acceptance and, on success, the exact-received-byte digest.
 */
export function verifyReceivedVertex(input: VerifyReceivedVertexInput): RegisteredVertexVerification {
	const authenticated = authenticateReceivedVertex(input);
	return authenticated === undefined ? { accepted: false } : { accepted: true, digest: authenticated.digest };
}

function detachPersistedVertex(vertex: PersistedVertexWitness): PersistedVertexWitness {
	if (vertex === null || typeof vertex !== "object") {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	const digest = vertex.digest;
	const witness = vertex.witness;
	if (witness === null || typeof witness !== "object") {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	const domain = witness.domain;
	const expectedAnchor = witness.expectedAnchor;
	const receivedCanonicalPreimageBytes = witness.receivedCanonicalPreimageBytes;
	const signature = witness.signature;
	const suiteId = witness.suiteId;
	if (
		!(digest instanceof Uint8Array) ||
		digest.byteLength !== 32 ||
		typeof domain !== "string" ||
		typeof expectedAnchor !== "string" ||
		!(receivedCanonicalPreimageBytes instanceof Uint8Array) ||
		!(signature instanceof Uint8Array) ||
		signature.byteLength !== 64 ||
		typeof suiteId !== "string"
	) {
		throw new TypeError("persisted equivocation vertex is malformed");
	}
	return {
		digest: new Uint8Array(digest),
		witness: {
			domain,
			expectedAnchor,
			receivedCanonicalPreimageBytes: new Uint8Array(receivedCanonicalPreimageBytes),
			signature: new Uint8Array(signature),
			suiteId,
		},
	};
}

function canonicalWitnessBytes(vertex: PersistedVertexWitness): Uint8Array {
	return encodeCanonical({
		domain: vertex.witness.domain,
		expectedAnchor: vertex.witness.expectedAnchor,
		preimage: vertex.witness.receivedCanonicalPreimageBytes,
		signature: vertex.witness.signature,
		suiteId: vertex.witness.suiteId,
	});
}

function proofIdForDigests(left: Uint8Array, right: Uint8Array): string {
	const [first, second] = compareBytes(left, right) < 0 ? [left, right] : [right, left];
	return bytesToHex(hashDomain(EQUIVOCATION_PROOF_DOMAIN, first, second));
}

/**
 * Derives the frozen proof identity for an unordered pair of distinct digests.
 * @param leftDigest - One registered 32-byte vertex digest.
 * @param rightDigest - The other registered 32-byte vertex digest.
 * @returns The lowercase hexadecimal proof identity.
 */
export function deriveEquivocationProofId(leftDigest: Uint8Array, rightDigest: Uint8Array): string {
	if (!(leftDigest instanceof Uint8Array) || !(rightDigest instanceof Uint8Array)) {
		throw new TypeError("equivocation proof digests must be Uint8Array values");
	}
	const left = new Uint8Array(leftDigest);
	const right = new Uint8Array(rightDigest);
	if (left.byteLength !== 32 || right.byteLength !== 32) {
		throw new TypeError("equivocation proof digests must each be 32 bytes");
	}
	if (compareBytes(left, right) === 0) {
		throw new TypeError("equivocation proof digests must be distinct");
	}
	return proofIdForDigests(left, right);
}

function canonicalEquivocationProof(
	scope: EquivocationScope,
	left: PersistedVertexWitness,
	right: PersistedVertexWitness
): PersistedEquivocationProof {
	const [first, second] = compareBytes(left.digest, right.digest) < 0 ? [left, right] : [right, left];
	return {
		canonicalProofBytes: encodeCanonical({
			kind: EQUIVOCATION_PROOF_KIND,
			profile: EQUIVOCATION_PROFILE_ID,
			protocolMajor: 3,
			slot: scope,
			vertices: [first, second].map((vertex) => ({
				digest: vertex.digest,
				domain: vertex.witness.domain,
				expectedAnchor: vertex.witness.expectedAnchor,
				preimage: vertex.witness.receivedCanonicalPreimageBytes,
				signature: vertex.witness.signature,
				suiteId: vertex.witness.suiteId,
			})),
		}),
		proofId: proofIdForDigests(first.digest, second.digest),
	};
}

function detachCurrentEquivocationVertex(value: unknown): PersistedVertexWitness | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as PersistedVertexWitness;
	const capturedDigest = candidate.digest;
	if (!(capturedDigest instanceof Uint8Array)) return undefined;
	const digest = new Uint8Array(capturedDigest);
	if (digest.byteLength !== 32) return undefined;

	const capturedWitness = candidate.witness;
	if (capturedWitness === null || typeof capturedWitness !== "object") return undefined;
	const domain = capturedWitness.domain;
	const expectedAnchor = capturedWitness.expectedAnchor;
	const capturedPreimage = capturedWitness.receivedCanonicalPreimageBytes;
	if (!(capturedPreimage instanceof Uint8Array)) return undefined;
	const receivedCanonicalPreimageBytes = new Uint8Array(capturedPreimage);
	const capturedSignature = capturedWitness.signature;
	if (!(capturedSignature instanceof Uint8Array)) return undefined;
	const signature = new Uint8Array(capturedSignature);
	if (signature.byteLength !== 64) return undefined;
	const suiteId = capturedWitness.suiteId;
	if (typeof domain !== "string" || typeof expectedAnchor !== "string" || typeof suiteId !== "string") {
		return undefined;
	}
	return {
		digest,
		witness: {
			domain,
			expectedAnchor,
			receivedCanonicalPreimageBytes,
			signature,
			suiteId,
		},
	};
}

/**
 * Reconstructs the current canonical proof from two current persisted witnesses.
 * @param input - Current slot scope, witnesses and authoritative key resolver.
 * @returns A verifier-compatible canonical proof, or undefined when validation fails.
 */
export function materializeCurrentEquivocationProof(
	input: MaterializeCurrentEquivocationProofInput
): PersistedEquivocationProof | undefined {
	try {
		if (input === null || typeof input !== "object") return undefined;
		const capturedScope = input.scope;
		const capturedVertices = input.vertices;
		const capturedResolver = input.resolveAuthorPublicKey;
		if (
			capturedScope === null ||
			typeof capturedScope !== "object" ||
			!Array.isArray(capturedVertices) ||
			capturedVertices.length !== 2 ||
			typeof capturedResolver !== "function"
		) {
			return undefined;
		}

		const author = capturedScope.author;
		const authorSequence = capturedScope.authorSequence;
		const objectId = capturedScope.objectId;
		if (typeof author !== "string" || !Number.isSafeInteger(authorSequence) || typeof objectId !== "string") {
			return undefined;
		}
		const scope: EquivocationScope = { author, authorSequence, objectId };

		const first = detachCurrentEquivocationVertex(capturedVertices[0]);
		if (first === undefined) return undefined;
		const second = detachCurrentEquivocationVertex(capturedVertices[1]);
		if (second === undefined || compareBytes(first.digest, second.digest) === 0) return undefined;

		const resolveAuthorPublicKey = (candidateAuthor: string): RawEd25519PublicKey | undefined =>
			Reflect.apply(capturedResolver, input, [candidateAuthor]);
		for (const vertex of [first, second]) {
			const authenticated = authenticateReceivedVertex({
				domain: vertex.witness.domain,
				expectedAnchor: vertex.witness.expectedAnchor,
				receivedCanonicalPreimageBytes: vertex.witness.receivedCanonicalPreimageBytes,
				resolveAuthorPublicKey,
				signature: vertex.witness.signature,
				suiteId: vertex.witness.suiteId,
			});
			if (authenticated === undefined || compareBytes(authenticated.digest, vertex.digest) !== 0) {
				return undefined;
			}
			if (
				authenticated.preimage.author !== scope.author ||
				authenticated.preimage.authorSequence !== scope.authorSequence ||
				authenticated.preimage.objectId !== scope.objectId
			) {
				return undefined;
			}
		}
		return canonicalEquivocationProof(scope, first, second);
	} catch {
		return undefined;
	}
}

interface MutableDurableAuthorProjectionState {
	readonly slots: AuthorProjectionSlot[];
	readonly pending: PendingEquivocationPair[];
}

function captureAuthorProjectionScope(value: unknown): EquivocationScope | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as Partial<EquivocationScope>;
	const author = candidate.author;
	const authorSequence = candidate.authorSequence;
	const objectId = candidate.objectId;
	if (
		typeof author !== "string" ||
		!Number.isSafeInteger(authorSequence) ||
		(authorSequence as number) < 0 ||
		typeof objectId !== "string"
	) {
		return undefined;
	}
	return { author, authorSequence: authorSequence as number, objectId };
}

function copyAuthorProjectionScope(scope: EquivocationScope): EquivocationScope {
	return {
		author: scope.author,
		authorSequence: scope.authorSequence,
		objectId: scope.objectId,
	};
}

function equalAuthorProjectionScopes(left: EquivocationScope, right: EquivocationScope): boolean {
	return (
		left.author === right.author && left.authorSequence === right.authorSequence && left.objectId === right.objectId
	);
}

function isDigestHex(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function copyAuthorProjectionStrings(values: readonly string[]): string[] {
	const copied: string[] = [];
	const length = values.length;
	for (let index = 0; index < length; index++) {
		copied[index] = values[index] as string;
	}
	return copied;
}

function authorProjectionIncludes(values: readonly string[], sought: string): boolean {
	for (let index = 0; index < values.length; index++) {
		if (values[index] === sought) return true;
	}
	return false;
}

function copyDurableAuthorProjectionState(state: DurableAuthorProjectionState): MutableDurableAuthorProjectionState {
	if (state === null || typeof state !== "object") {
		throw new TypeError("durable author projection is malformed");
	}
	const capturedSlots = state.slots;
	const capturedPending = state.pending;
	if (!Array.isArray(capturedSlots) || !Array.isArray(capturedPending)) {
		throw new TypeError("durable author projection is malformed");
	}

	const slots: AuthorProjectionSlot[] = [];
	const slotCount = capturedSlots.length;
	for (let index = 0; index < slotCount; index++) {
		const candidate = capturedSlots[index] as AuthorProjectionSlot;
		if (candidate === null || typeof candidate !== "object") {
			throw new TypeError("durable author projection slot is malformed");
		}
		const scope = captureAuthorProjectionScope(candidate.scope);
		const capturedDigestHexes = candidate.digestHexes;
		if (scope === undefined || !Array.isArray(capturedDigestHexes)) {
			throw new TypeError("durable author projection slot is malformed");
		}
		const digestHexes: string[] = [];
		const digestCount = capturedDigestHexes.length;
		for (let digestIndex = 0; digestIndex < digestCount; digestIndex++) {
			const digestHex = capturedDigestHexes[digestIndex];
			if (!isDigestHex(digestHex)) {
				throw new TypeError("durable author projection digest is malformed");
			}
			digestHexes[digestIndex] = digestHex;
		}
		slots[index] = { scope, digestHexes };
	}

	const pending: PendingEquivocationPair[] = [];
	const pendingCount = capturedPending.length;
	for (let index = 0; index < pendingCount; index++) {
		const candidate = capturedPending[index] as PendingEquivocationPair;
		if (candidate === null || typeof candidate !== "object") {
			throw new TypeError("durable author projection pending row is malformed");
		}
		const scope = captureAuthorProjectionScope(candidate.scope);
		const lesserDigestHex = candidate.lesserDigestHex;
		const greaterDigestHex = candidate.greaterDigestHex;
		const pairId = candidate.pairId;
		if (
			scope === undefined ||
			typeof lesserDigestHex !== "string" ||
			typeof greaterDigestHex !== "string" ||
			typeof pairId !== "string"
		) {
			throw new TypeError("durable author projection pending row is malformed");
		}
		pending[index] = { scope, lesserDigestHex, greaterDigestHex, pairId };
	}
	return { pending, slots };
}

function captureAuthenticatedAuthorProjectionVertices(
	value: unknown,
	scope: EquivocationScope,
	resolveAuthorPublicKey: VerifyReceivedVertexInput["resolveAuthorPublicKey"]
): readonly PersistedVertexWitness[] | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const capturedVertices = (value as PersistedEquivocationState).vertices;
	if (!Array.isArray(capturedVertices)) return undefined;

	const vertices: PersistedVertexWitness[] = [];
	const vertexCount = capturedVertices.length;
	for (let index = 0; index < vertexCount; index++) {
		const vertex = detachCurrentEquivocationVertex(capturedVertices[index]);
		if (vertex === undefined) return undefined;
		vertices[index] = vertex;
	}

	for (let index = 0; index < vertexCount; index++) {
		const vertex = vertices[index] as PersistedVertexWitness;
		const authenticated = authenticateReceivedVertex({
			domain: vertex.witness.domain,
			expectedAnchor: vertex.witness.expectedAnchor,
			receivedCanonicalPreimageBytes: vertex.witness.receivedCanonicalPreimageBytes,
			resolveAuthorPublicKey,
			signature: vertex.witness.signature,
			suiteId: vertex.witness.suiteId,
		});
		if (authenticated === undefined || compareBytes(authenticated.digest, vertex.digest) !== 0) {
			return undefined;
		}
		if (
			authenticated.preimage.author !== scope.author ||
			authenticated.preimage.authorSequence !== scope.authorSequence ||
			authenticated.preimage.objectId !== scope.objectId
		) {
			return undefined;
		}
	}
	return vertices;
}

function canonicalAuthorProjectionPair(
	leftDigestHex: string,
	rightDigestHex: string
): readonly [lesserDigestHex: string, greaterDigestHex: string] | undefined {
	if (!isDigestHex(leftDigestHex) || !isDigestHex(rightDigestHex) || leftDigestHex === rightDigestHex) {
		return undefined;
	}
	return leftDigestHex < rightDigestHex ? [leftDigestHex, rightDigestHex] : [rightDigestHex, leftDigestHex];
}

function bytesFromDigestHex(value: string): Uint8Array | undefined {
	if (!isDigestHex(value)) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function authorProjectionPairId(
	pair: readonly [lesserDigestHex: string, greaterDigestHex: string]
): string | undefined {
	const lesser = bytesFromDigestHex(pair[0]);
	const greater = bytesFromDigestHex(pair[1]);
	if (lesser === undefined || greater === undefined) return undefined;
	return deriveEquivocationProofId(lesser, greater);
}

/**
 * Creates a deep-only durable projection over injected authoritative slot and author stores.
 * @param options - Authoritative reads, recovery enumeration, transaction, resolver and handoff capabilities.
 * @returns A coordinator with reconciliation, recovery and one-row draining operations.
 */
export function createDurableAuthorEquivocationProjection(
	options: DurableAuthorEquivocationProjectionOptions
): DurableAuthorEquivocationProjection {
	if (options === null || typeof options !== "object") {
		throw new TypeError("projection options are required");
	}
	const readCommittedSlotState = options.readCommittedSlotState;
	const enumerateCommittedAuthorSlots = options.enumerateCommittedAuthorSlots;
	const transactAuthorProjection = options.transactAuthorProjection;
	const resolveAuthorPublicKey = options.resolveAuthorPublicKey;
	const handoffProof = options.handoffProof;
	if (
		typeof readCommittedSlotState !== "function" ||
		typeof enumerateCommittedAuthorSlots !== "function" ||
		typeof transactAuthorProjection !== "function" ||
		typeof resolveAuthorPublicKey !== "function" ||
		typeof handoffProof !== "function"
	) {
		throw new TypeError("all projection capabilities are required");
	}

	const resolveAuthor = (author: string): RawEd25519PublicKey | undefined =>
		Reflect.apply(resolveAuthorPublicKey, options, [author]) as RawEd25519PublicKey | undefined;
	const readSlot = (scope: EquivocationScope): Promise<PersistedEquivocationState> =>
		Reflect.apply(readCommittedSlotState, options, [scope]) as Promise<PersistedEquivocationState>;
	const enumerateSlots = (author: string): Promise<readonly EquivocationScope[]> =>
		Reflect.apply(enumerateCommittedAuthorSlots, options, [author]) as Promise<readonly EquivocationScope[]>;
	const transact = <Result>(
		author: string,
		apply: (state: DurableAuthorProjectionState) => AuthorProjectionDecision<Result>
	): Promise<Result> => Reflect.apply(transactAuthorProjection, options, [author, apply]) as Promise<Result>;
	const handoff = (proof: PersistedEquivocationProof): Promise<void> =>
		Reflect.apply(handoffProof, options, [proof]) as Promise<void>;

	const reconcile = async (requestedScope: EquivocationScope): Promise<ReconcileAuthorProjectionResult> => {
		const scope = captureAuthorProjectionScope(requestedScope);
		if (scope === undefined) throw new TypeError("projection scope is malformed");
		const committed = await readSlot(copyAuthorProjectionScope(scope));
		const vertices = captureAuthenticatedAuthorProjectionVertices(committed, scope, resolveAuthor);
		if (vertices === undefined) {
			throw new TypeError("authoritative committed slot is invalid");
		}

		const committedDigestHexes: string[] = [];
		for (let index = 0; index < vertices.length; index++) {
			const digestHex = bytesToHex((vertices[index] as PersistedVertexWitness).digest);
			if (!authorProjectionIncludes(committedDigestHexes, digestHex)) {
				committedDigestHexes[committedDigestHexes.length] = digestHex;
			}
		}
		committedDigestHexes.sort();

		return transact(scope.author, (durableState) => {
			const next = copyDurableAuthorProjectionState(durableState);
			let slotIndex = -1;
			for (let index = 0; index < next.slots.length; index++) {
				if (equalAuthorProjectionScopes((next.slots[index] as AuthorProjectionSlot).scope, scope)) {
					slotIndex = index;
					break;
				}
			}

			const priorDigestHexes =
				slotIndex === -1
					? []
					: copyAuthorProjectionStrings((next.slots[slotIndex] as AuthorProjectionSlot).digestHexes);
			const newDigestHexes: string[] = [];
			for (let index = 0; index < committedDigestHexes.length; index++) {
				const digestHex = committedDigestHexes[index] as string;
				if (!authorProjectionIncludes(priorDigestHexes, digestHex)) {
					newDigestHexes[newDigestHexes.length] = digestHex;
				}
			}
			const postUnionDigestHexes = copyAuthorProjectionStrings(priorDigestHexes);
			for (let index = 0; index < committedDigestHexes.length; index++) {
				const digestHex = committedDigestHexes[index] as string;
				if (!authorProjectionIncludes(postUnionDigestHexes, digestHex)) {
					postUnionDigestHexes[postUnionDigestHexes.length] = digestHex;
				}
			}
			postUnionDigestHexes.sort();

			const enqueuedPairIds: string[] = [];
			for (let newIndex = 0; newIndex < newDigestHexes.length; newIndex++) {
				for (let unionIndex = 0; unionIndex < postUnionDigestHexes.length; unionIndex++) {
					const pair = canonicalAuthorProjectionPair(
						newDigestHexes[newIndex] as string,
						postUnionDigestHexes[unionIndex] as string
					);
					if (pair === undefined) continue;
					let pendingExists = false;
					for (let pendingIndex = 0; pendingIndex < next.pending.length; pendingIndex++) {
						const row = next.pending[pendingIndex] as PendingEquivocationPair;
						if (
							equalAuthorProjectionScopes(row.scope, scope) &&
							row.lesserDigestHex === pair[0] &&
							row.greaterDigestHex === pair[1]
						) {
							pendingExists = true;
							break;
						}
					}
					if (pendingExists) continue;
					const pairId = authorProjectionPairId(pair);
					if (pairId === undefined) continue;
					next.pending[next.pending.length] = {
						scope: copyAuthorProjectionScope(scope),
						lesserDigestHex: pair[0],
						greaterDigestHex: pair[1],
						pairId,
					};
					enqueuedPairIds[enqueuedPairIds.length] = pairId;
				}
			}

			const slot: AuthorProjectionSlot = {
				scope: copyAuthorProjectionScope(scope),
				digestHexes: postUnionDigestHexes,
			};
			if (slotIndex === -1) next.slots[next.slots.length] = slot;
			else next.slots[slotIndex] = slot;
			return {
				state: next,
				result: {
					enqueuedPairIds,
					newDigestCount: newDigestHexes.length,
				},
			};
		});
	};

	const recover = async (author: string): Promise<RecoverAuthorProjectionResult> => {
		if (typeof author !== "string") throw new TypeError("author is malformed");
		const enumerated = await enumerateSlots(author);
		if (!Array.isArray(enumerated)) {
			throw new TypeError("author recovery enumeration is malformed");
		}
		const scopeCount = enumerated.length;
		const scopes: EquivocationScope[] = [];
		for (let index = 0; index < scopeCount; index++) {
			const scope = captureAuthorProjectionScope(enumerated[index]);
			if (scope === undefined || scope.author !== author) {
				throw new TypeError("author recovery enumeration returned an invalid scope");
			}
			scopes[index] = scope;
		}
		for (let index = 0; index < scopeCount; index++) {
			await reconcile(scopes[index] as EquivocationScope);
		}
		return { reconciledSlotCount: scopeCount };
	};

	const pendingCount = (author: string): Promise<number> =>
		transact(author, (durableState) => {
			const captured = copyDurableAuthorProjectionState(durableState);
			return { state: durableState, result: captured.pending.length };
		});

	const drainOne = async (author: string): Promise<DrainAuthorProjectionResult> => {
		if (typeof author !== "string") throw new TypeError("author is malformed");
		const selection = await transact(author, (durableState) => {
			const captured = copyDurableAuthorProjectionState(durableState);
			return {
				state: durableState,
				result: {
					row: captured.pending[0],
				},
			};
		});
		const row = selection.row;
		if (row === undefined) return { handedOff: false, remainingPending: 0 };

		const scope = captureAuthorProjectionScope(row.scope);
		const pair = canonicalAuthorProjectionPair(row.lesserDigestHex, row.greaterDigestHex);
		const expectedPairId = pair === undefined ? undefined : authorProjectionPairId(pair);
		if (
			scope === undefined ||
			scope.author !== author ||
			pair === undefined ||
			row.lesserDigestHex !== pair[0] ||
			row.greaterDigestHex !== pair[1] ||
			row.pairId !== expectedPairId
		) {
			return { handedOff: false, remainingPending: await pendingCount(author) };
		}

		const committed = await readSlot(copyAuthorProjectionScope(scope));
		const vertices = captureAuthenticatedAuthorProjectionVertices(committed, scope, resolveAuthor);
		let lesser: PersistedVertexWitness | undefined;
		let greater: PersistedVertexWitness | undefined;
		if (vertices !== undefined) {
			for (let index = 0; index < vertices.length; index++) {
				const vertex = vertices[index] as PersistedVertexWitness;
				const digestHex = bytesToHex(vertex.digest);
				if (digestHex === pair[0]) lesser = vertex;
				if (digestHex === pair[1]) greater = vertex;
			}
		}
		if (lesser === undefined || greater === undefined) {
			return { handedOff: false, remainingPending: await pendingCount(author) };
		}

		const proof = materializeCurrentEquivocationProof({
			scope: copyAuthorProjectionScope(scope),
			vertices: [lesser, greater],
			resolveAuthorPublicKey: resolveAuthor,
		});
		if (proof === undefined || proof.proofId !== expectedPairId) {
			return { handedOff: false, remainingPending: await pendingCount(author) };
		}
		await handoff({
			canonicalProofBytes: new Uint8Array(proof.canonicalProofBytes),
			proofId: proof.proofId,
		});

		const remainingPending = await transact(author, (durableState) => {
			const next = copyDurableAuthorProjectionState(durableState);
			let removeIndex = -1;
			for (let index = 0; index < next.pending.length; index++) {
				const candidate = next.pending[index] as PendingEquivocationPair;
				if (
					equalAuthorProjectionScopes(candidate.scope, scope) &&
					candidate.lesserDigestHex === pair[0] &&
					candidate.greaterDigestHex === pair[1] &&
					candidate.pairId === expectedPairId
				) {
					removeIndex = index;
					break;
				}
			}
			if (removeIndex !== -1) next.pending.splice(removeIndex, 1);
			return { state: next, result: next.pending.length };
		});
		return { handedOff: true, remainingPending };
	};

	return { drainOne, reconcile, recover };
}

interface MutableDetachedAuthorGossipSlot {
	readonly scope: EquivocationScope;
	readonly digestHexes: string[];
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareAuthorGossipPairs(left: AuthorGossipPair, right: AuthorGossipPair): number {
	return (
		compareCodeUnits(left.scope.objectId, right.scope.objectId) ||
		left.scope.authorSequence - right.scope.authorSequence ||
		compareCodeUnits(left.lesserDigestHex, right.lesserDigestHex) ||
		compareCodeUnits(left.greaterDigestHex, right.greaterDigestHex)
	);
}

/**
 * Selects the canonical first N author-wide equivocation pairs from a detached projection.
 *
 * The policy bounds only the returned selection. Exact pair enumeration remains
 * quadratic in each normalized slot's digest count.
 * @param projection - Detached per-slot digest sets for exactly one author.
 * @param policy - Explicit nonnegative selection limit.
 * @returns A fresh deterministic composition with exact derived counts.
 */
export function composeAuthorGossipBudget(
	projection: DetachedAuthorGossipProjection,
	policy: AuthorGossipBudgetPolicy
): AuthorGossipBudgetComposition {
	if (projection === null || typeof projection !== "object" || policy === null || typeof policy !== "object") {
		throw new TypeError("gossip budget inputs are required");
	}

	const maxGossipPairCount = policy.maxGossipPairCount;
	if (!Number.isSafeInteger(maxGossipPairCount) || maxGossipPairCount < 0) {
		throw new RangeError("maxGossipPairCount must be a nonnegative safe integer");
	}

	const author = projection.author;
	const capturedSlots = projection.slots;
	if (typeof author !== "string" || !Array.isArray(capturedSlots)) {
		throw new TypeError("gossip projection is malformed");
	}

	const mergedSlots = new Map<string, Map<number, MutableDetachedAuthorGossipSlot>>();
	const slotCount = capturedSlots.length;
	for (let index = 0; index < slotCount; index++) {
		const candidate = capturedSlots[index];
		if (candidate === null || typeof candidate !== "object") {
			throw new TypeError("gossip projection slot is malformed");
		}
		const capturedScope = candidate.scope;
		const scope = captureAuthorProjectionScope(capturedScope);
		const capturedDigestHexes = candidate.digestHexes;
		if (scope === undefined || scope.author !== author || !Array.isArray(capturedDigestHexes)) {
			throw new TypeError("gossip projection slot is malformed");
		}

		const digestHexes: string[] = [];
		const digestCount = capturedDigestHexes.length;
		for (let digestIndex = 0; digestIndex < digestCount; digestIndex++) {
			const digestHex = capturedDigestHexes[digestIndex];
			if (!isDigestHex(digestHex)) {
				throw new TypeError("gossip projection digest is malformed");
			}
			digestHexes[digestIndex] = digestHex;
		}

		let sequences = mergedSlots.get(scope.objectId);
		if (sequences === undefined) {
			sequences = new Map<number, MutableDetachedAuthorGossipSlot>();
			mergedSlots.set(scope.objectId, sequences);
		}
		let merged = sequences.get(scope.authorSequence);
		if (merged === undefined) {
			merged = { scope: copyAuthorProjectionScope(scope), digestHexes: [] };
			sequences.set(scope.authorSequence, merged);
		}
		for (let digestIndex = 0; digestIndex < digestHexes.length; digestIndex++) {
			const digestHex = digestHexes[digestIndex] as string;
			if (!authorProjectionIncludes(merged.digestHexes, digestHex)) {
				merged.digestHexes[merged.digestHexes.length] = digestHex;
			}
		}
	}

	const pairs: AuthorGossipPair[] = [];
	for (const sequences of mergedSlots.values()) {
		for (const slot of sequences.values()) {
			slot.digestHexes.sort(compareCodeUnits);
			for (let lesserIndex = 0; lesserIndex < slot.digestHexes.length; lesserIndex++) {
				for (let greaterIndex = lesserIndex + 1; greaterIndex < slot.digestHexes.length; greaterIndex++) {
					pairs[pairs.length] = {
						scope: copyAuthorProjectionScope(slot.scope),
						lesserDigestHex: slot.digestHexes[lesserIndex] as string,
						greaterDigestHex: slot.digestHexes[greaterIndex] as string,
					};
				}
			}
		}
	}
	pairs.sort(compareAuthorGossipPairs);

	const totalPairCount = pairs.length;
	const selectedPairCount = Math.min(totalPairCount, maxGossipPairCount);
	const selectedPairs: AuthorGossipPair[] = [];
	for (let index = 0; index < selectedPairCount; index++) {
		const pair = pairs[index] as AuthorGossipPair;
		selectedPairs[index] = {
			scope: copyAuthorProjectionScope(pair.scope),
			lesserDigestHex: pair.lesserDigestHex,
			greaterDigestHex: pair.greaterDigestHex,
		};
	}
	return {
		author,
		selectedPairs,
		totalPairCount,
		suppressedPairCount: totalPairCount - selectedPairCount,
		saturated: totalPairCount > maxGossipPairCount,
	};
}

/**
 * Derives a pure ACL-visible reputation observation from detached author digest sets.
 * @param projection - Detached per-slot digest sets for exactly one author.
 * @param policy - Explicit nonnegative reputation-penalty cap.
 * @returns A fresh aggregate in canonical unordered distinct digest-pair units.
 */
export function composeAuthorAclReputation(
	projection: DetachedAuthorReputationProjection,
	policy: AuthorAclReputationPolicy
): AuthorAclReputationComposition {
	if (projection === null || typeof projection !== "object" || policy === null || typeof policy !== "object") {
		throw new TypeError("ACL reputation inputs are required");
	}

	const maxReputationPenalty = policy.maxReputationPenalty;
	if (!Number.isSafeInteger(maxReputationPenalty) || maxReputationPenalty < 0) {
		throw new RangeError("maxReputationPenalty must be a nonnegative safe integer");
	}

	const author = projection.author;
	const capturedSlots = projection.slots;
	if (typeof author !== "string" || !Array.isArray(capturedSlots)) {
		throw new TypeError("ACL reputation projection is malformed");
	}

	const normalizedScopes = new Map<string, Map<number, Set<string>>>();
	const slotCount = capturedSlots.length;
	for (let index = 0; index < slotCount; index++) {
		const candidate = capturedSlots[index];
		if (candidate === null || typeof candidate !== "object") {
			throw new TypeError("ACL reputation slot is malformed");
		}
		const scope = captureAuthorProjectionScope(candidate.scope);
		const capturedDigestHexes = candidate.digestHexes;
		if (scope === undefined || scope.author !== author || !Array.isArray(capturedDigestHexes)) {
			throw new TypeError("ACL reputation slot is malformed");
		}

		let sequences = normalizedScopes.get(scope.objectId);
		if (sequences === undefined) {
			sequences = new Map<number, Set<string>>();
			normalizedScopes.set(scope.objectId, sequences);
		}
		let digests = sequences.get(scope.authorSequence);
		if (digests === undefined) {
			digests = new Set<string>();
			sequences.set(scope.authorSequence, digests);
		}

		const digestCount = capturedDigestHexes.length;
		for (let digestIndex = 0; digestIndex < digestCount; digestIndex++) {
			const digestHex = capturedDigestHexes[digestIndex];
			if (!isDigestHex(digestHex)) {
				throw new TypeError("ACL reputation digest is malformed");
			}
			digests.add(digestHex);
		}
	}

	let equivocatingSlotCount = 0;
	let totalCanonicalPairCount = 0;
	for (const sequences of normalizedScopes.values()) {
		for (const digests of sequences.values()) {
			const digestCount = digests.size;
			const leftFactor = digestCount % 2 === 0 ? digestCount / 2 : digestCount;
			const rightFactor = digestCount % 2 === 0 ? digestCount - 1 : (digestCount - 1) / 2;
			const pairCount = leftFactor * rightFactor;
			if (!Number.isSafeInteger(pairCount) || pairCount > Number.MAX_SAFE_INTEGER - totalCanonicalPairCount) {
				throw new RangeError("canonical pair count exceeds safe integer");
			}
			if (pairCount > 0) equivocatingSlotCount++;
			totalCanonicalPairCount += pairCount;
		}
	}

	return {
		author,
		equivocatingSlotCount,
		totalCanonicalPairCount,
		reputationPenalty: Math.min(totalCanonicalPairCount, maxReputationPenalty),
		saturated: totalCanonicalPairCount > maxReputationPenalty,
	};
}

function allCanonicalEquivocationProofs(
	scope: EquivocationScope,
	vertices: readonly PersistedVertexWitness[]
): PersistedEquivocationProof[] {
	const proofs: PersistedEquivocationProof[] = [];
	for (let leftIndex = 0; leftIndex < vertices.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < vertices.length; rightIndex++) {
			proofs.push(
				canonicalEquivocationProof(
					scope,
					vertices[leftIndex] as PersistedVertexWitness,
					vertices[rightIndex] as PersistedVertexWitness
				)
			);
		}
	}
	return proofs.sort((left, right) => compareCodePointStrings(left.proofId, right.proofId));
}

function slotAdvisorySignal(
	author: string,
	vertexCount: number,
	proofCount: number,
	perSlotAdvisoryProofLimit: number
): SlotAdvisorySignal {
	const withinAdvisoryLimitProofCount = Math.min(proofCount, perSlotAdvisoryProofLimit);
	return {
		author,
		observedForkCount: Math.max(0, vertexCount - 1),
		advisoryLimitReached: proofCount >= perSlotAdvisoryProofLimit,
		withinAdvisoryLimitProofCount,
		overAdvisoryLimitProofCount: proofCount - withinAdvisoryLimitProofCount,
	};
}

function observationDecision(
	scope: EquivocationScope,
	candidate: PersistedVertexWitness,
	perSlotAdvisoryProofLimit: number,
	trustedProofs: readonly PersistedEquivocationProof[],
	authenticatedVertices: readonly PersistedVertexWitness[]
): EquivocationTransactionDecision {
	const previousProofIds = new Set(trustedProofs.map(({ proofId }) => proofId));
	const authenticatedVertexCount = authenticatedVertices.length;
	const vertices: PersistedVertexWitness[] = [];
	let existingIndex = -1;
	for (let index = 0; index < authenticatedVertexCount; index++) {
		const vertex = authenticatedVertices[index] as PersistedVertexWitness;
		vertices[index] = vertex;
		if (existingIndex === -1 && compareBytes(vertex.digest, candidate.digest) === 0) {
			existingIndex = index;
		}
	}
	const disposition = existingIndex === -1 ? (vertices.length === 0 ? "new" : "equivocation") : "duplicate";

	if (existingIndex === -1) {
		vertices[authenticatedVertexCount] = detachPersistedVertex(candidate);
	} else {
		const existing = vertices[existingIndex] as PersistedVertexWitness;
		if (compareBytes(canonicalWitnessBytes(candidate), canonicalWitnessBytes(existing)) < 0) {
			vertices[existingIndex] = detachPersistedVertex(candidate);
		}
	}
	vertices.sort((left, right) => compareBytes(left.digest, right.digest));

	const proofs = allCanonicalEquivocationProofs(scope, vertices);
	const slotSignal = slotAdvisorySignal(scope.author, vertices.length, proofs.length, perSlotAdvisoryProofLimit);
	const orderedDigests = vertices.map(({ digest }) => bytesToHex(digest));
	const result: RemoteObservationResult = {
		admitted: true,
		digest: new Uint8Array(candidate.digest),
		disposition,
		newlyPersistedProofIds: proofs.map(({ proofId }) => proofId).filter((proofId) => !previousProofIds.has(proofId)),
		resolution: {
			orderedDigests,
			preferredDigest: orderedDigests[0] as string,
		},
		slotSignal,
	};
	return {
		result,
		state: {
			proofs,
			slotSignal,
			vertices,
		},
	};
}

function assertPersistedVerticesAuthenticated(
	scope: EquivocationScope,
	state: PersistedEquivocationState,
	resolveAuthorPublicKey: VerifyReceivedVertexInput["resolveAuthorPublicKey"]
): readonly PersistedVertexWitness[] {
	if (state === null || typeof state !== "object") {
		throw new TypeError("persisted equivocation state is malformed");
	}
	const capturedVertices = state.vertices;
	if (!Array.isArray(capturedVertices)) {
		throw new TypeError("persisted equivocation state is malformed");
	}
	const capturedVertexCount = capturedVertices.length;
	const detachedVertices: PersistedVertexWitness[] = [];
	for (let index = 0; index < capturedVertexCount; index++) {
		const capturedVertex = capturedVertices[index] as PersistedVertexWitness;
		const vertex = detachPersistedVertex(capturedVertex);
		const digest = vertex.digest;
		const witness = vertex.witness;
		const domain = witness.domain;
		const expectedAnchor = witness.expectedAnchor;
		const receivedCanonicalPreimageBytes = witness.receivedCanonicalPreimageBytes;
		const signature = witness.signature;
		const suiteId = witness.suiteId;

		const authenticated = authenticateReceivedVertex({
			domain,
			expectedAnchor,
			receivedCanonicalPreimageBytes,
			resolveAuthorPublicKey,
			signature,
			suiteId,
		});
		if (authenticated === undefined || compareBytes(authenticated.digest, digest) !== 0) {
			throw new TypeError("persisted equivocation vertex digest is unauthenticated");
		}
		if (
			authenticated.preimage.author !== scope.author ||
			authenticated.preimage.authorSequence !== scope.authorSequence ||
			authenticated.preimage.objectId !== scope.objectId
		) {
			throw new TypeError("persisted equivocation vertex is outside transaction scope");
		}
		detachedVertices[index] = vertex;
	}
	return detachedVertices;
}

/**
 * Creates a stateless remote equivocation observer over an injected exact-slot transaction.
 *
 * Authentication and input detachment complete before the coordinator is entered.
 * The coordinator owns serialization and durability; this primitive supplies only
 * a pure deterministic transition over the coordinator-provided slot state.
 * @param options - Slot advisory accounting and transaction coordinator.
 * @returns A remote observer with no default or module-local store.
 */
export function createRemoteEquivocationObserver(
	options: RemoteEquivocationObserverOptions
): RemoteEquivocationObserver {
	if (options === null || typeof options !== "object") {
		throw new TypeError("observer options must be an object");
	}
	const perSlotAdvisoryProofLimit = options.perSlotAdvisoryProofLimit;
	const transactObservation = options.transactObservation;
	if (typeof transactObservation !== "function") {
		throw new TypeError("transactObservation must be a function");
	}
	if (!Number.isSafeInteger(perSlotAdvisoryProofLimit) || perSlotAdvisoryProofLimit < 1) {
		throw new TypeError("perSlotAdvisoryProofLimit must be a positive safe integer");
	}

	return {
		async observe(input: VerifyReceivedVertexInput): Promise<RemoteObservationResult> {
			let snapshot: VerifyReceivedVertexInput;
			try {
				if (input === null || typeof input !== "object") {
					throw new TypeError("received vertex input is malformed");
				}
				const domain = input.domain;
				const expectedAnchor = input.expectedAnchor;
				const receivedCanonicalPreimageBytes = input.receivedCanonicalPreimageBytes;
				const capturedResolver = input.resolveAuthorPublicKey;
				const signature = input.signature;
				const suiteId = input.suiteId;
				if (
					!(receivedCanonicalPreimageBytes instanceof Uint8Array) ||
					!(signature instanceof Uint8Array) ||
					signature.byteLength !== 64 ||
					typeof capturedResolver !== "function"
				) {
					throw new TypeError("received vertex input is malformed");
				}
				const resolveAuthorPublicKey = capturedResolver.bind(input);
				snapshot = {
					domain,
					expectedAnchor,
					receivedCanonicalPreimageBytes: new Uint8Array(receivedCanonicalPreimageBytes),
					resolveAuthorPublicKey,
					signature: new Uint8Array(signature),
					suiteId,
				};
			} catch {
				return { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] };
			}

			const authenticated = authenticateReceivedVertex(snapshot);
			if (authenticated === undefined) {
				return { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] };
			}

			const author = authenticated.preimage.author;
			const authorSequence = authenticated.preimage.authorSequence;
			const objectId = authenticated.preimage.objectId;
			if (typeof author !== "string" || typeof objectId !== "string" || typeof authorSequence !== "number") {
				return { admitted: false, disposition: "invalid", newlyPersistedProofIds: [] };
			}
			const scope: EquivocationScope = { author, authorSequence, objectId };
			const candidate: PersistedVertexWitness = {
				digest: new Uint8Array(authenticated.digest),
				witness: {
					domain: snapshot.domain,
					expectedAnchor: snapshot.expectedAnchor,
					receivedCanonicalPreimageBytes: new Uint8Array(snapshot.receivedCanonicalPreimageBytes),
					signature: new Uint8Array(snapshot.signature),
					suiteId: snapshot.suiteId,
				},
			};
			return transactObservation(scope, (state) => {
				const authenticatedVertices = assertPersistedVerticesAuthenticated(
					scope,
					state,
					snapshot.resolveAuthorPublicKey
				);
				// Coordinator proofs are a trusted residual until the phase 0o-b policy boundary.
				return observationDecision(scope, candidate, perSlotAdvisoryProofLimit, state.proofs, authenticatedVertices);
			});
		},
	};
}

function invalidEquivocationProof(): EquivocationProofVerification {
	return { verified: false };
}

/**
 * Verifies a canonical standalone same-slot equivocation proof.
 *
 * Both included exact preimages are authenticated through the strict received
 * vertex verifier and the caller's authoritative author-key resolver.
 * @param input - Canonical proof bytes and authoritative key resolver.
 * @returns The verified scope, ordered digest pair and pair-derived proof ID.
 */
export function verifyEquivocationProof(input: VerifyEquivocationProofInput): EquivocationProofVerification {
	if (input === null || typeof input !== "object") {
		return invalidEquivocationProof();
	}

	let capturedCanonicalProofBytes: unknown;
	let capturedResolver: unknown;
	let inputCaptureFailed = false;
	try {
		capturedCanonicalProofBytes = input.canonicalProofBytes;
	} catch {
		inputCaptureFailed = true;
	}
	try {
		capturedResolver = input.resolveAuthorPublicKey;
	} catch {
		inputCaptureFailed = true;
	}
	if (
		inputCaptureFailed ||
		!(capturedCanonicalProofBytes instanceof Uint8Array) ||
		typeof capturedResolver !== "function"
	) {
		return invalidEquivocationProof();
	}

	try {
		const canonicalProofBytes = new Uint8Array(capturedCanonicalProofBytes);
		const resolveAuthorPublicKey = capturedResolver.bind(input);
		const decoded = decodeCanonical(canonicalProofBytes);
		if (compareBytes(encodeCanonical(decoded), canonicalProofBytes) !== 0) {
			return invalidEquivocationProof();
		}
		assertClosedRecord(decoded, ["kind", "profile", "protocolMajor", "slot", "vertices"], "equivocation proof");
		if (
			ownDataProperty(decoded, "kind", "equivocation proof") !== EQUIVOCATION_PROOF_KIND ||
			ownDataProperty(decoded, "profile", "equivocation proof") !== EQUIVOCATION_PROFILE_ID ||
			ownDataProperty(decoded, "protocolMajor", "equivocation proof") !== 3
		) {
			return invalidEquivocationProof();
		}

		const slot = ownDataProperty(decoded, "slot", "equivocation proof");
		assertClosedRecord(slot, ["author", "authorSequence", "objectId"], "equivocation proof.slot");
		const author = ownDataProperty(slot, "author", "equivocation proof.slot");
		const authorSequence = ownDataProperty(slot, "authorSequence", "equivocation proof.slot");
		const objectId = ownDataProperty(slot, "objectId", "equivocation proof.slot");
		if (
			typeof author !== "string" ||
			typeof objectId !== "string" ||
			typeof authorSequence !== "number" ||
			!Number.isSafeInteger(authorSequence)
		) {
			return invalidEquivocationProof();
		}
		const scope: EquivocationScope = { author, authorSequence, objectId };

		const vertices = ownDataProperty(decoded, "vertices", "equivocation proof");
		if (!Array.isArray(vertices) || vertices.length !== 2) return invalidEquivocationProof();
		const verifiedDigests: Uint8Array[] = [];
		for (const [index, vertex] of vertices.entries()) {
			assertClosedRecord(
				vertex,
				["digest", "domain", "expectedAnchor", "preimage", "signature", "suiteId"],
				`equivocation proof.vertices[${index}]`
			);
			const digest = ownDataProperty(vertex, "digest", `equivocation proof.vertices[${index}]`);
			const domain = ownDataProperty(vertex, "domain", `equivocation proof.vertices[${index}]`);
			const expectedAnchor = ownDataProperty(vertex, "expectedAnchor", `equivocation proof.vertices[${index}]`);
			const preimageBytes = ownDataProperty(vertex, "preimage", `equivocation proof.vertices[${index}]`);
			const signature = ownDataProperty(vertex, "signature", `equivocation proof.vertices[${index}]`);
			const suiteId = ownDataProperty(vertex, "suiteId", `equivocation proof.vertices[${index}]`);
			if (
				!(digest instanceof Uint8Array) ||
				digest.byteLength !== 32 ||
				typeof domain !== "string" ||
				typeof expectedAnchor !== "string" ||
				!(preimageBytes instanceof Uint8Array) ||
				!(signature instanceof Uint8Array) ||
				typeof suiteId !== "string"
			) {
				return invalidEquivocationProof();
			}

			const authenticated = authenticateReceivedVertex({
				domain,
				expectedAnchor,
				receivedCanonicalPreimageBytes: preimageBytes,
				resolveAuthorPublicKey,
				signature,
				suiteId,
			});
			if (authenticated === undefined || compareBytes(authenticated.digest, digest) !== 0) {
				return invalidEquivocationProof();
			}
			if (
				authenticated.preimage.author !== scope.author ||
				authenticated.preimage.authorSequence !== scope.authorSequence ||
				authenticated.preimage.objectId !== scope.objectId
			) {
				return invalidEquivocationProof();
			}
			verifiedDigests.push(new Uint8Array(digest));
		}

		const left = verifiedDigests[0] as Uint8Array;
		const right = verifiedDigests[1] as Uint8Array;
		if (compareBytes(left, right) >= 0) return invalidEquivocationProof();
		const digests: [string, string] = [bytesToHex(left), bytesToHex(right)];
		return {
			digests,
			proofId: proofIdForDigests(left, right),
			scope,
			verified: true,
		};
	} catch {
		return invalidEquivocationProof();
	}
}

type ReceivedVertexDecision =
	| Readonly<{ readonly kind: "not-authenticated" }>
	| Readonly<{ readonly kind: "admission-rejected" }>
	| Readonly<{ readonly authenticated: AuthenticatedReceivedVertex; readonly kind: "admitted" }>;

const ADMIT_RECEIVED_VERTEX_INPUT_KEYS = [
	"domain",
	"expectedAnchor",
	"preparedBlueprintAdmission",
	"receivedCanonicalPreimageBytes",
	"resolveAuthorPublicKey",
	"signature",
	"suiteId",
] as const;
const ADMIT_RECEIVED_VERTEX_BYTE_KEYS = new Set<string>(["receivedCanonicalPreimageBytes", "signature"]);

function decideReceivedVertex(input: AdmitReceivedVertexInput): ReceivedVertexDecision {
	const authenticated = authenticateReceivedVertex(input);
	if (authenticated === undefined) return { kind: "not-authenticated" };
	const preparedState = consumerPreparedAdmissionState(input);
	if (preparedState === undefined) {
		return { kind: "admission-rejected" };
	}
	const operation = authenticated.preimage.operation;
	const schema = operationSchemaForPreparedAdmission(operation, preparedState);
	if (
		schema === undefined ||
		!operationWithinCanonicalByteBudget(operation as Readonly<Record<string, unknown>>, schema)
	) {
		return { kind: "admission-rejected" };
	}
	return { authenticated, kind: "admitted" };
}

function extractFailure(
	reason: ExtractAdmittedReceivedVertexFailureReason
): Readonly<{ readonly ok: false; readonly reason: ExtractAdmittedReceivedVertexFailureReason }> {
	return intrinsicObjectFreeze({ ok: false as const, reason });
}

function copyCanonicalForAdmittedView(value: unknown): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (value instanceof intrinsicUint8Array) return new intrinsicUint8Array(value);
	if (value instanceof intrinsicFloat32Array) return new intrinsicFloat32Array(value);
	if (value instanceof intrinsicFloat64Array) return new intrinsicFloat64Array(value);
	if (value instanceof intrinsicInt32Array) return new intrinsicInt32Array(value);
	if (value instanceof intrinsicUint32Array) return new intrinsicUint32Array(value);

	if (intrinsicArrayIsArray(value)) {
		const output = new intrinsicArray<unknown>(value.length);
		for (let index = 0; index < value.length; index++) {
			const key = intrinsicString(index);
			const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !intrinsicObjectHasOwn(descriptor, "value")) {
				throw new TypeError("canonical array must be dense data");
			}
			intrinsicObjectDefineProperty(output, key, {
				configurable: true,
				enumerable: true,
				value: copyCanonicalForAdmittedView(descriptor.value),
				writable: true,
			});
		}
		return intrinsicObjectFreeze(output);
	}

	if (value instanceof intrinsicMap) {
		const output = new intrinsicMap<unknown, unknown>();
		const iterator = intrinsicReflectApply(intrinsicMapEntries, value, []);
		for (;;) {
			const step = intrinsicReflectApply(intrinsicMapIteratorNext, iterator, []);
			if (step.done === true) break;
			const entry = step.value as [unknown, unknown];
			intrinsicReflectApply(intrinsicMapSet, output, [
				copyCanonicalForAdmittedView(entry[0]),
				copyCanonicalForAdmittedView(entry[1]),
			]);
		}
		return intrinsicObjectFreeze(output);
	}

	if (value instanceof intrinsicSet) {
		const output = new intrinsicSet<unknown>();
		const iterator = intrinsicReflectApply(intrinsicSetValues, value, []);
		for (;;) {
			const step = intrinsicReflectApply(intrinsicSetIteratorNext, iterator, []);
			if (step.done === true) break;
			intrinsicReflectApply(intrinsicSetAdd, output, [copyCanonicalForAdmittedView(step.value)]);
		}
		return intrinsicObjectFreeze(output);
	}

	if (value === null || typeof value !== "object") {
		throw new TypeError("unsupported canonical value");
	}
	const prototype = intrinsicObjectGetPrototypeOf(value);
	if (prototype !== intrinsicObjectPrototype && prototype !== null) {
		throw new TypeError("canonical record must be plain");
	}
	const output = intrinsicObjectCreate(intrinsicObjectPrototype) as Record<string, unknown>;
	const keys = intrinsicReflectOwnKeys(value);
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (typeof key !== "string") throw new TypeError("canonical record key must be a string");
		const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !descriptor.enumerable || !intrinsicObjectHasOwn(descriptor, "value")) {
			throw new TypeError("canonical record property must be enumerable data");
		}
		intrinsicObjectDefineProperty(output, key, {
			configurable: true,
			enumerable: true,
			value: copyCanonicalForAdmittedView(descriptor.value),
			writable: true,
		});
	}
	return intrinsicObjectFreeze(output);
}

function snapshotExtractInput(input: unknown): AdmitReceivedVertexInput | undefined {
	const snapshot = snapshotClosedInput(input, ADMIT_RECEIVED_VERTEX_INPUT_KEYS, ADMIT_RECEIVED_VERTEX_BYTE_KEYS, true);
	if (snapshot === undefined) return undefined;
	const domain = snapshot.domain;
	const expectedAnchor = snapshot.expectedAnchor;
	const preparedBlueprintAdmission = snapshot.preparedBlueprintAdmission;
	const receivedCanonicalPreimageBytes = snapshot.receivedCanonicalPreimageBytes;
	const capturedResolver = snapshot.resolveAuthorPublicKey;
	const signature = snapshot.signature;
	const suiteId = snapshot.suiteId;
	if (
		typeof domain !== "string" ||
		typeof expectedAnchor !== "string" ||
		!(receivedCanonicalPreimageBytes instanceof intrinsicUint8Array) ||
		receivedCanonicalPreimageBytes.byteLength === 0 ||
		typeof capturedResolver !== "function" ||
		!(signature instanceof intrinsicUint8Array) ||
		signature.byteLength !== 64 ||
		typeof suiteId !== "string"
	) {
		return undefined;
	}
	const resolveAuthorPublicKey = intrinsicReflectApply(intrinsicFunctionBind, capturedResolver, [input]) as (
		author: string
	) => RawEd25519PublicKey | undefined;
	return {
		domain,
		expectedAnchor,
		preparedBlueprintAdmission: preparedBlueprintAdmission as PreparedBlueprintAdmission,
		receivedCanonicalPreimageBytes,
		resolveAuthorPublicKey,
		signature,
		suiteId,
	};
}

function admittedVertexView(authenticated: AuthenticatedReceivedVertex): AdmittedReceivedVertexView | undefined {
	const preimage = authenticated.preimage;
	const read = (name: string): unknown => {
		const descriptor = intrinsicObjectGetOwnPropertyDescriptor(preimage, name);
		return descriptor !== undefined && descriptor.enumerable && intrinsicObjectHasOwn(descriptor, "value")
			? descriptor.value
			: undefined;
	};
	const kind = read("kind");
	const protocolMajor = read("protocolMajor");
	const objectId = read("objectId");
	const epoch = read("epoch");
	const anchor = read("anchor");
	const author = read("author");
	const authorSequence = read("authorSequence");
	const logicalTime = read("logicalTime");
	const sourceDependencies = read("dependencies");
	const sourceOperation = read("operation");
	if (
		kind !== "drp-vertex" ||
		protocolMajor !== 3 ||
		typeof objectId !== "string" ||
		typeof epoch !== "number" ||
		typeof anchor !== "string" ||
		typeof author !== "string" ||
		typeof authorSequence !== "number" ||
		typeof logicalTime !== "number" ||
		!intrinsicArrayIsArray(sourceDependencies) ||
		!isCapturedPlainRecord(sourceOperation)
	) {
		return undefined;
	}
	for (let index = 0; index < sourceDependencies.length; index++) {
		if (typeof sourceDependencies[index] !== "string") return undefined;
	}
	const dependencies = copyCanonicalForAdmittedView(sourceDependencies) as readonly string[];
	const operation = copyCanonicalForAdmittedView(sourceOperation) as Readonly<Record<string, unknown>>;
	const digest = new intrinsicUint8Array(authenticated.digest);
	return intrinsicObjectFreeze({
		kind,
		protocolMajor,
		objectId,
		epoch,
		anchor,
		author,
		authorSequence,
		logicalTime,
		dependencies,
		operation,
		digest,
	});
}

/**
 * Authenticates exact received bytes and then applies a genuine prepared ABI.
 * @param input - Received vertex data and prepared application admission.
 * @returns Admission and, on success, the exact-received-byte digest.
 */
export function admitReceivedVertex(input: AdmitReceivedVertexInput): AdmissionDecision {
	const decision = decideReceivedVertex(input);
	return decision.kind === "admitted" ? { admitted: true, digest: decision.authenticated.digest } : { admitted: false };
}

/**
 * Authenticates and admits exact received bytes into a detached registered view.
 * @param input - Received vertex data and prepared application admission.
 * @returns A closed failure or the detached admitted vertex.
 */
export function extractAdmittedReceivedVertex(input: AdmitReceivedVertexInput): ExtractAdmittedReceivedVertexResult {
	try {
		const snapshot = snapshotExtractInput(input);
		if (snapshot === undefined) return extractFailure("malformed-input");
		let decision: ReceivedVertexDecision;
		try {
			decision = decideReceivedVertex(snapshot);
		} catch {
			return extractFailure("admission-rejected");
		}
		if (decision.kind === "not-authenticated") return extractFailure("not-authenticated");
		if (decision.kind === "admission-rejected") return extractFailure("admission-rejected");
		try {
			const vertex = admittedVertexView(decision.authenticated);
			return vertex === undefined
				? extractFailure("not-authenticated")
				: intrinsicObjectFreeze({ ok: true as const, vertex });
		} catch {
			return extractFailure("not-authenticated");
		}
	} catch {
		return extractFailure("malformed-input");
	}
}

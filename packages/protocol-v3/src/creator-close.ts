import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { type CurrentAnchorTrust, verifyEd25519RegisteredDigest } from "./index.js";
import type { CreatorAnchorSigningRequest } from "./internal/creator-anchor-signing-request.js";
import {
	type CreatorAnchorTrustMaterial,
	mintCreatorAnchorSigningRequest,
	mintCreatorAnchorTrustSuccessor,
	resolveCreatorAnchorTrustMaterial,
} from "./internal/seal-authority-custody.js";
import { resolveSealAuthorityIdentity } from "./internal/seal-authority-identity.js";
import { openSealAuthority, verifySealQC } from "./seal.js";
import { settlementProfileFor } from "./settlement-profile.js";
import { decodeSnapshotManifest } from "./snapshot-transfer.js";
import registryJson from "../registry/registry-v1.json" with { type: "json" };

const registry = registryJson as unknown as {
	readonly kinds: Readonly<
		Record<
			string,
			Readonly<{
				readonly domain: string;
				readonly fields: readonly {
					name: string;
					required: boolean;
					type: string;
					const: unknown;
					constraints: Readonly<Record<string, unknown>>;
				}[];
			}>
		>
	>;
};
const intrinsicArrayBufferPrototype = ArrayBuffer.prototype;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicReflectApply = Reflect.apply;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
	intrinsicArrayBufferPrototype,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
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
const digestHex = /^[0-9a-f]{64}$/u;
const publicKeyHex = /^[0-9a-f]{64}$/u;
const trustRecordFields = Object.freeze([
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
]);
const closeInputFields = Object.freeze([
	"aclDigest",
	"archiveIndexRoot",
	"blueprintDigest",
	"closeReason",
	"closeSetCount",
	"closeSetRoot",
	"currentTrust",
	"exactCanonicalAvailabilityPolicyBytes",
	"exactCanonicalNextSignerSetBytes",
	"exactCanonicalParametersBytes",
	"exactCanonicalSnapshotManifestBytes",
	"historyRoot",
	"historySize",
	"snapshotManifestDigest",
	"stateDigest",
]);

declare const creatorAnchorPreparationBrand: unique symbol;
declare const creatorCloseBrand: unique symbol;

export interface CreatorAnchorPreparation {
	readonly [creatorAnchorPreparationBrand]: true;
}

export interface VerifiedCreatorClose {
	readonly [creatorCloseBrand]: true;
}

interface CreatorCloseState {
	readonly currentAnchor: Readonly<Record<string, unknown>>;
	readonly currentTrust: CurrentAnchorTrust;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly material: CreatorAnchorTrustMaterial;
	readonly valueDigest: string;
}

interface CreatorPreparationState {
	readonly anchorDigest: string;
	readonly currentTrust: CurrentAnchorTrust;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly material: CreatorAnchorTrustMaterial;
}

const closeStates = new WeakMap<VerifiedCreatorClose, CreatorCloseState>();
const preparationStates = new WeakMap<CreatorAnchorPreparation, CreatorPreparationState>();

export type CreatorHistoricalAnchorEnvelopeFailureReason =
	| "MALFORMED_HISTORICAL_ENVELOPE"
	| "UNTRUSTED_CURRENT_ANCHOR"
	| "HISTORICAL_ANCHOR_MISMATCH"
	| "HISTORICAL_PARAMETERS_MISMATCH"
	| "INVALID_HISTORICAL_SIGNATURE";

export interface InspectCreatorHistoricalAnchorEnvelopeInput {
	readonly successorTrust: CurrentAnchorTrust;
	readonly envelope: Readonly<{
		objectId: string;
		exactCanonicalAnchorPreimageBytes: Uint8Array;
		detachedAnchorSignature: Uint8Array;
		exactCanonicalParametersCarrierBytes: Uint8Array;
	}>;
}

export type InspectCreatorHistoricalAnchorEnvelopeResult =
	| Readonly<{ ok: false; reason: CreatorHistoricalAnchorEnvelopeFailureReason }>
	| Readonly<{
			ok: true;
			objectId: string;
			epoch: number;
			anchorDigest: string;
			aclDigest: string;
			parametersDigest: string;
			profileDigest: string;
			signerSetDigest: string;
			cryptoSuiteId: string;
			blueprintDigest: string;
	  }>;

function failure<Reason extends string>(reason: Reason): Readonly<{ ok: false; reason: Reason }> {
	return Object.freeze({ ok: false as const, reason });
}

function hex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Reflect.ownKeys(value);
	return (
		actual.length === keys.length &&
		actual.every((key) => typeof key === "string" && keys.includes(key)) &&
		keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable === true && "value" in descriptor;
		})
	);
}

function byteCarrierLength(value: unknown, expectedLength?: number, maximumLength = 268_435_456): number | undefined {
	try {
		if (intrinsicObjectGetPrototypeOf(value) !== intrinsicUint8ArrayPrototype) return undefined;
		const bytes = value as Uint8Array;
		const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, bytes, []);
		const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, bytes, []);
		const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, bytes, []);
		if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBufferPrototype) return undefined;
		const bufferByteLength = intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
		const resizable =
			intrinsicArrayBufferResizableGetter === undefined
				? false
				: intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []);
		if (byteOffset !== 0 || byteLength !== bufferByteLength || byteLength > maximumLength || resizable) {
			return undefined;
		}
		if (expectedLength !== undefined && byteLength !== expectedLength) return undefined;
		return byteLength;
	} catch {
		return undefined;
	}
}

function copyBytes(value: unknown, expectedLength?: number, maximumLength = 268_435_456): Uint8Array | undefined {
	const byteLength = byteCarrierLength(value, expectedLength, maximumLength);
	if (byteLength === undefined) return undefined;
	try {
		const output = new intrinsicUint8Array(byteLength);
		intrinsicReflectApply(intrinsicUint8ArraySet, output, [value]);
		return output;
	} catch {
		return undefined;
	}
}

function capturedRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	if (!plainRecord(value) || !exactKeys(value, fields)) return undefined;
	const captured: Record<string, unknown> = Object.create(null);
	for (const field of fields) {
		const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, field);
		if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
		captured[field] = descriptor.value;
	}
	return captured;
}

function validRegisteredAnchor(anchor: Readonly<Record<string, unknown>>): boolean {
	return (
		registry.kinds.epochAnchor?.fields.every((field) => {
			const value = anchor[field.name];
			if (field.const !== null && value !== field.const) return false;
			if (field.type === "digest-hex") return typeof value === "string" && digestHex.test(value);
			if (field.type === "safe-integer") return safeInteger(value, (field.constraints.minimum as number) ?? 0);
			if (field.type === "enum")
				return typeof value === "string" && (field.constraints.values as readonly string[]).includes(value);
			return (
				field.type === "string" &&
				typeof value === "string" &&
				value.length >= ((field.constraints.minimumUtf16Units as number) ?? 0) &&
				value.length <= ((field.constraints.maximumUtf16Units as number) ?? Number.MAX_SAFE_INTEGER)
			);
		}) === true
	);
}

function safeInteger(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function exactCanonicalRecord(bytes: Uint8Array, kind: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(bytes);
		const fields = registry.kinds[kind]?.fields.map(({ name }) => name);
		if (
			fields === undefined ||
			!plainRecord(decoded) ||
			!exactKeys(decoded, fields) ||
			compareBytes(encodeCanonical(decoded), bytes) !== 0
		) {
			return undefined;
		}
		return decoded;
	} catch {
		return undefined;
	}
}

function decodeCanonicalValue(bytes: Uint8Array): unknown {
	const value = decodeCanonical(bytes);
	if (compareBytes(encodeCanonical(value), bytes) !== 0) throw new TypeError("noncanonical carrier");
	return value;
}

function creatorSignerId(material: CreatorAnchorTrustMaterial): string | undefined {
	try {
		const signerSet = decodeCanonicalValue(material.exactCanonicalSignerSetBytes);
		if (!Array.isArray(signerSet) || signerSet.length !== 1 || !plainRecord(signerSet[0])) return undefined;
		const signer = signerSet[0];
		return typeof signer.signerId === "string" ? signer.signerId : undefined;
	} catch {
		return undefined;
	}
}

function successorAnchor(
	currentAnchor: Readonly<Record<string, unknown>>,
	cut: Readonly<Record<string, unknown>>
): Uint8Array {
	return encodeCanonical({
		aclDigest: cut.aclDigest,
		archiveIndexRoot: cut.archiveIndexRoot,
		blueprintDigest: cut.blueprintDigest,
		cryptoSuiteId: currentAnchor.cryptoSuiteId,
		cutDigest: hex(hashDomain(registry.kinds.cutValue?.domain ?? "", encodeCanonical(cut))),
		epoch: (cut.epoch as number) + 1,
		historyRoot: cut.historyRoot,
		historySize: cut.historySize,
		kind: "drp-epoch-anchor",
		objectId: cut.objectId,
		parametersDigest: currentAnchor.parametersDigest,
		previousAnchor: cut.previousAnchor,
		profileDigest: currentAnchor.profileDigest,
		protocolMajor: 3,
		signerSetDigest: currentAnchor.signerSetDigest,
		stateDigest: cut.stateDigest,
	});
}

function closedCutSuccessorEquation(
	material: CreatorAnchorTrustMaterial,
	anchorBytes: Uint8Array,
	cutBytes: Uint8Array
): Readonly<Record<string, unknown>> | undefined {
	const anchor = exactCanonicalRecord(anchorBytes, "epochAnchor");
	const cut = exactCanonicalRecord(cutBytes, "cutValue");
	if (
		anchor === undefined ||
		cut === undefined ||
		cut.kind !== "drp-hard-epoch-cut" ||
		cut.protocolMajor !== 3 ||
		cut.encodingVersion !== "drp-canonical-profile-1" ||
		cut.objectId !== material.objectId ||
		!safeInteger(cut.epoch) ||
		anchor.epoch !== cut.epoch + 1 ||
		anchor.previousAnchor !== cut.previousAnchor ||
		!safeInteger(cut.closeSetCount, 1) ||
		!safeInteger(cut.previousHistorySize) ||
		!safeInteger(cut.historySize) ||
		cut.historySize !== cut.previousHistorySize + cut.closeSetCount ||
		typeof cut.closeReason !== "string" ||
		cut.closeReason.length < 1 ||
		cut.closeReason.length > 128 ||
		compareBytes(encodeCanonical(cut.nextSignerSet), material.exactCanonicalSignerSetBytes) !== 0 ||
		!plainRecord(cut.parameters) ||
		!validClosedParameters(cut.parameters) ||
		hex(hashDomain("ts-drp/parameters/v3", encodeCanonical(cut.parameters))) !== anchor.parametersDigest ||
		anchor.profileDigest !== hex(hashDomain("ts-drp/profile/v3", material.exactCanonicalProfileBytes)) ||
		anchor.signerSetDigest !== hex(hashDomain("ts-drp/signer-set/v3", material.exactCanonicalSignerSetBytes)) ||
		anchor.cryptoSuiteId !== "ed25519-sha256-v3" ||
		compareBytes(successorAnchor(anchor, cut), anchorBytes) !== 0
	)
		return undefined;
	for (const field of [
		"aclDigest",
		"archiveIndexRoot",
		"availabilityPolicyDigest",
		"blueprintDigest",
		"closeSetRoot",
		"historyRoot",
		"previousAnchor",
		"previousCutDigest",
		"previousHistoryRoot",
		"snapshotManifestDigest",
		"stateDigest",
	]) {
		if (typeof cut[field] !== "string" || !digestHex.test(cut[field] as string)) return undefined;
	}
	return cut;
}

function validClosedParameters(value: Readonly<Record<string, unknown>>): boolean {
	const fields = registry.kinds.parameters?.fields;
	return (
		fields !== undefined &&
		Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.some((field) => field.name === key)) &&
		fields.every((field) => {
			if (!Object.hasOwn(value, field.name)) return !field.required;
			const candidate = value[field.name];
			return (
				safeInteger(candidate) &&
				candidate >= (field.constraints.minimum as number) &&
				candidate <= (field.constraints.maximum as number)
			);
		})
	);
}

/**
 * Authenticates original historical anchor material against genuine immediate successor custody.
 * @param input - Closed successor trust and the existing exact install envelope, without caller key authority.
 * @returns Frozen compact material identities or one typed refusal; never historical trust or replay authority.
 */
export function inspectCreatorHistoricalAnchorEnvelope(input: unknown): InspectCreatorHistoricalAnchorEnvelopeResult {
	try {
		const captured = capturedRecord(input, ["successorTrust", "envelope"]);
		if (captured === undefined) return failure("MALFORMED_HISTORICAL_ENVELOPE");
		const envelope = capturedRecord(captured.envelope, [
			"objectId",
			"exactCanonicalAnchorPreimageBytes",
			"detachedAnchorSignature",
			"exactCanonicalParametersCarrierBytes",
		]);
		if (
			envelope === undefined ||
			typeof envelope.objectId !== "string" ||
			byteCarrierLength(envelope.exactCanonicalAnchorPreimageBytes, undefined, 8192) === undefined ||
			byteCarrierLength(envelope.detachedAnchorSignature, 64, 64) === undefined ||
			byteCarrierLength(envelope.exactCanonicalParametersCarrierBytes, undefined, 65_536) === undefined
		)
			return failure("MALFORMED_HISTORICAL_ENVELOPE");
		const material = resolveCreatorAnchorTrustMaterial(captured.successorTrust as CurrentAnchorTrust);
		if (material === undefined) return failure("UNTRUSTED_CURRENT_ANCHOR");
		const anchorBytes = copyBytes(envelope.exactCanonicalAnchorPreimageBytes, undefined, 8192);
		const signature = copyBytes(envelope.detachedAnchorSignature, 64, 64);
		const parametersBytes = copyBytes(envelope.exactCanonicalParametersCarrierBytes, undefined, 65_536);
		if (anchorBytes === undefined || signature === undefined || parametersBytes === undefined)
			return failure("MALFORMED_HISTORICAL_ENVELOPE");
		const anchor = exactCanonicalRecord(anchorBytes, "epochAnchor");
		const successor = exactCanonicalRecord(material.exactCanonicalCurrentAnchorPreimageBytes, "epochAnchor");
		const anchorDigestBytes = hashDomain(registry.kinds.epochAnchor?.domain ?? "", anchorBytes);
		const anchorDigest = hex(anchorDigestBytes);
		if (
			anchor === undefined ||
			successor === undefined ||
			!validRegisteredAnchor(anchor) ||
			!validRegisteredAnchor(successor) ||
			envelope.objectId !== material.objectId ||
			anchor.objectId !== material.objectId ||
			successor.objectId !== material.objectId ||
			!safeInteger(material.currentEpoch, 1) ||
			successor.epoch !== material.currentEpoch ||
			anchor.epoch !== material.currentEpoch - 1 ||
			successor.previousAnchor !== anchorDigest ||
			hex(hashDomain(registry.kinds.epochAnchor?.domain ?? "", material.exactCanonicalCurrentAnchorPreimageBytes)) !==
				material.currentAnchorDigest ||
			anchor.cryptoSuiteId !== "ed25519-sha256-v3" ||
			anchor.cryptoSuiteId !== successor.cryptoSuiteId ||
			anchor.profileDigest !== successor.profileDigest ||
			anchor.profileDigest !== hex(hashDomain("ts-drp/profile/v3", material.exactCanonicalProfileBytes)) ||
			anchor.signerSetDigest !== successor.signerSetDigest ||
			anchor.signerSetDigest !== hex(hashDomain("ts-drp/signer-set/v3", material.exactCanonicalSignerSetBytes)) ||
			anchor.blueprintDigest !== successor.blueprintDigest
		)
			return failure("HISTORICAL_ANCHOR_MISMATCH");
		let parameters: unknown;
		try {
			parameters = decodeCanonicalValue(parametersBytes);
		} catch {
			return failure("HISTORICAL_PARAMETERS_MISMATCH");
		}
		const parametersDigest = hex(hashDomain(registry.kinds.parameters?.domain ?? "", parametersBytes));
		if (
			!plainRecord(parameters) ||
			!validClosedParameters(parameters) ||
			parametersDigest !== anchor.parametersDigest ||
			parametersDigest !== successor.parametersDigest
		)
			return failure("HISTORICAL_PARAMETERS_MISMATCH");
		if (!verifyEd25519RegisteredDigest(signature, anchorDigestBytes, material.publicKey))
			return failure("INVALID_HISTORICAL_SIGNATURE");
		return Object.freeze({
			ok: true as const,
			objectId: material.objectId,
			epoch: anchor.epoch as number,
			anchorDigest,
			aclDigest: anchor.aclDigest as string,
			parametersDigest,
			profileDigest: anchor.profileDigest as string,
			signerSetDigest: anchor.signerSetDigest as string,
			cryptoSuiteId: anchor.cryptoSuiteId as string,
			blueprintDigest: anchor.blueprintDigest as string,
		});
	} catch {
		return failure("MALFORMED_HISTORICAL_ENVELOPE");
	}
}

/**
 * Inspects exact closed-cut binding to genuine successor custody without minting old authority.
 * @param input - Closed genuine successor trust and canonical CutValue bytes.
 * @returns Detached identities or a frozen binding refusal.
 */
export function inspectCreatorClosedCutSuccessorBinding(input: unknown): Readonly<
	| { ok: false; reason: string }
	| {
			ok: true;
			cut: Readonly<Record<string, unknown>>;
			successorAnchor: Readonly<Record<string, unknown>>;
			successorAnchorDigest: string;
	  }
> {
	try {
		if (!plainRecord(input) || !exactKeys(input, ["successorTrust", "exactCanonicalCutValueBytes"]))
			return failure("CERTIFIED_VALUE_MISMATCH");
		const material = resolveCreatorAnchorTrustMaterial(input.successorTrust as CurrentAnchorTrust);
		const bytes = copyBytes(input.exactCanonicalCutValueBytes, undefined, 65_536);
		if (material === undefined) return failure("UNTRUSTED_CURRENT_ANCHOR");
		if (bytes === undefined) return failure("CERTIFIED_VALUE_MISMATCH");
		const cut = closedCutSuccessorEquation(material, material.exactCanonicalCurrentAnchorPreimageBytes, bytes);
		const anchor = exactCanonicalRecord(material.exactCanonicalCurrentAnchorPreimageBytes, "epochAnchor");
		return cut === undefined || anchor === undefined
			? failure("CERTIFIED_VALUE_MISMATCH")
			: Object.freeze({
					ok: true as const,
					cut,
					successorAnchor: anchor,
					successorAnchorDigest: material.currentAnchorDigest,
				});
	} catch {
		return failure("CERTIFIED_VALUE_MISMATCH");
	}
}

/**
 * Prepares a governed creator-anchor signing request from exact tuple carriers.
 * @param input - Exact anchor, profile, signer-set, and enrolled public-key carriers.
 * @returns A one-use request or a typed tuple failure.
 */
export function prepareCreatorAnchorSigningRequest(
	input: Readonly<{
		exactCanonicalAnchorPreimageBytes: Uint8Array;
		exactCanonicalProfileBytes: Uint8Array;
		exactCanonicalSignerSetBytes: Uint8Array;
		signerPublicKey: Uint8Array;
	}>
): Readonly<
	{ ok: false; reason: string } | { anchorDigest: string; ok: true; signingRequest: CreatorAnchorSigningRequest }
> {
	try {
		if (
			!plainRecord(input) ||
			!exactKeys(input, [
				"exactCanonicalAnchorPreimageBytes",
				"exactCanonicalProfileBytes",
				"exactCanonicalSignerSetBytes",
				"signerPublicKey",
			])
		) {
			return failure("ANCHOR_TUPLE_INVALID");
		}
		const anchorBytes = copyBytes(input.exactCanonicalAnchorPreimageBytes, undefined, 65_536);
		const profileBytes = copyBytes(input.exactCanonicalProfileBytes, undefined, 65_536);
		const signerSetBytes = copyBytes(input.exactCanonicalSignerSetBytes, undefined, 65_536);
		const signerPublicKey = copyBytes(input.signerPublicKey, 32, 32);
		if (
			anchorBytes === undefined ||
			profileBytes === undefined ||
			signerSetBytes === undefined ||
			signerPublicKey === undefined
		) {
			return failure("ANCHOR_TUPLE_INVALID");
		}
		const anchor = exactCanonicalRecord(anchorBytes, "epochAnchor");
		const profile = decodeCanonicalValue(profileBytes);
		const signerSet = decodeCanonicalValue(signerSetBytes);
		if (
			anchor === undefined ||
			anchor.kind !== "drp-epoch-anchor" ||
			anchor.protocolMajor !== 3 ||
			!plainRecord(profile) ||
			!exactKeys(profile, ["cryptoSuiteId", "profileId", "quorum", "signers"]) ||
			profile.cryptoSuiteId !== "ed25519-sha256-v3" ||
			typeof profile.profileId !== "string" ||
			(profile.profileId !== "creator-trusted-v1" && settlementProfileFor(profile.profileId) === "none") ||
			profile.quorum !== 1 ||
			!Array.isArray(profile.signers) ||
			!Array.isArray(signerSet) ||
			signerSet.length !== 1 ||
			compareBytes(encodeCanonical(profile.signers), signerSetBytes) !== 0
		) {
			return failure("ANCHOR_TUPLE_INVALID");
		}
		const signer = signerSet[0];
		if (
			!plainRecord(signer) ||
			!exactKeys(signer, ["publicKey", "signerId"]) ||
			typeof signer.publicKey !== "string" ||
			!publicKeyHex.test(signer.publicKey) ||
			signer.publicKey !== hex(signerPublicKey)
		) {
			return failure("SIGNER_NOT_AUTHORIZED");
		}
		if (
			anchor.signerSetDigest !== hex(hashDomain("ts-drp/signer-set/v3", signerSetBytes)) ||
			anchor.profileDigest !== hex(hashDomain("ts-drp/profile/v3", profileBytes))
		) {
			return failure("ANCHOR_TUPLE_INVALID");
		}
		const digest = hashDomain(registry.kinds.epochAnchor?.domain ?? "", anchorBytes);
		return Object.freeze({
			anchorDigest: hex(digest),
			ok: true as const,
			signingRequest: mintCreatorAnchorSigningRequest(digest),
		});
	} catch {
		return failure("ANCHOR_TUPLE_INVALID");
	}
}

/**
 * Composes compaction and snapshot facts into one exact creator CutValue.
 * @param input - Genuine current trust plus exact close, snapshot, and policy facts.
 * @returns An opaque verified close and detached CutValue bytes, or a typed failure.
 */
export function prepareCreatorClose(
	input: unknown
): Readonly<
	| { ok: false; reason: string }
	| { close: VerifiedCreatorClose; exactCanonicalCutValueBytes: Uint8Array; ok: true; valueDigest: string }
> {
	try {
		if (!plainRecord(input) || !exactKeys(input, closeInputFields)) return failure("CUT_VALUE_MISMATCH");
		const material = resolveCreatorAnchorTrustMaterial(input.currentTrust as CurrentAnchorTrust);
		if (material === undefined) return failure("UNTRUSTED_CURRENT_ANCHOR");
		const currentAnchor = exactCanonicalRecord(material.exactCanonicalCurrentAnchorPreimageBytes, "epochAnchor");
		const manifestBytes = copyBytes(input.exactCanonicalSnapshotManifestBytes, undefined, 212_387);
		const availabilityBytes = copyBytes(input.exactCanonicalAvailabilityPolicyBytes, undefined, 65_536);
		const signerSetBytes = copyBytes(input.exactCanonicalNextSignerSetBytes, undefined, 65_536);
		const parametersBytes = copyBytes(input.exactCanonicalParametersBytes, undefined, 65_536);
		if (
			currentAnchor === undefined ||
			manifestBytes === undefined ||
			availabilityBytes === undefined ||
			signerSetBytes === undefined ||
			parametersBytes === undefined ||
			typeof input.snapshotManifestDigest !== "string" ||
			!digestHex.test(input.snapshotManifestDigest)
		) {
			return failure("CUT_VALUE_MISMATCH");
		}
		let decodedManifest: ReturnType<typeof decodeSnapshotManifest>;
		try {
			decodedManifest = decodeSnapshotManifest({
				exactCanonicalManifestBytes: manifestBytes,
				expectedManifestDigest: input.snapshotManifestDigest,
				profile: {
					maxManifestBytes: 212_387,
					maxSnapshotBytes: 268_435_456,
					snapshotChunkBytes: 131_072,
				},
			});
		} catch {
			return failure("SNAPSHOT_BINDING_MISMATCH");
		}
		const manifest = decodedManifest.manifest;
		if (
			manifest.objectId !== material.objectId ||
			manifest.epoch !== material.currentEpoch ||
			manifest.anchor !== material.currentAnchorDigest ||
			manifest.stateDigest !== input.stateDigest ||
			manifest.aclDigest !== input.aclDigest
		) {
			return failure("SNAPSHOT_BINDING_MISMATCH");
		}
		if (
			input.blueprintDigest !== currentAnchor.blueprintDigest ||
			input.archiveIndexRoot !== currentAnchor.archiveIndexRoot ||
			input.closeReason !== "creator-requested" ||
			typeof input.closeSetRoot !== "string" ||
			!digestHex.test(input.closeSetRoot) ||
			typeof input.historyRoot !== "string" ||
			!digestHex.test(input.historyRoot) ||
			!safeInteger(input.closeSetCount, 1) ||
			!safeInteger(input.historySize, 1) ||
			!safeInteger(currentAnchor.historySize, 0) ||
			input.historySize !== currentAnchor.historySize + input.closeSetCount ||
			compareBytes(signerSetBytes, material.exactCanonicalSignerSetBytes) !== 0 ||
			hex(hashDomain("ts-drp/parameters/v3", parametersBytes)) !== currentAnchor.parametersDigest
		) {
			return failure("CUT_VALUE_MISMATCH");
		}
		const nextSignerSet = decodeCanonicalValue(signerSetBytes);
		const parameters = decodeCanonicalValue(parametersBytes);
		decodeCanonicalValue(availabilityBytes);
		const exactCanonicalCutValueBytes = encodeCanonical({
			aclDigest: input.aclDigest,
			archiveIndexRoot: input.archiveIndexRoot,
			availabilityPolicyDigest: hex(hashDomain("ts-drp/availability-policy/v3", availabilityBytes)),
			blueprintDigest: input.blueprintDigest,
			closeReason: input.closeReason,
			closeSetCount: input.closeSetCount,
			closeSetRoot: input.closeSetRoot,
			encodingVersion: "drp-canonical-profile-1",
			epoch: material.currentEpoch,
			historyRoot: input.historyRoot,
			historySize: input.historySize,
			kind: "drp-hard-epoch-cut",
			nextSignerSet,
			objectId: material.objectId,
			parameters,
			previousAnchor: material.currentAnchorDigest,
			previousCutDigest: currentAnchor.cutDigest,
			previousHistoryRoot: currentAnchor.historyRoot,
			previousHistorySize: currentAnchor.historySize,
			protocolMajor: 3,
			snapshotManifestDigest: input.snapshotManifestDigest,
			stateDigest: input.stateDigest,
		});
		const valueDigest = hex(hashDomain(registry.kinds.cutValue?.domain ?? "", exactCanonicalCutValueBytes));
		const close = Object.freeze({}) as VerifiedCreatorClose;
		closeStates.set(
			close,
			Object.freeze({
				currentAnchor,
				currentTrust: input.currentTrust as CurrentAnchorTrust,
				exactCanonicalCutValueBytes: Uint8Array.from(exactCanonicalCutValueBytes),
				material,
				valueDigest,
			})
		);
		return Object.freeze({
			close,
			exactCanonicalCutValueBytes: Uint8Array.from(exactCanonicalCutValueBytes),
			ok: true as const,
			valueDigest,
		});
	} catch {
		return failure("CUT_VALUE_MISMATCH");
	}
}

/**
 * Prepares the exact successor anchor only after a genuine commit QC verifies.
 * @param input - Opaque close and authority plus exact commit-QC bytes.
 * @returns A fieldless preparation/signing request pair, or a typed failure.
 */
export function prepareCreatorSuccessor(input: unknown): Readonly<
	| { ok: false; reason: string }
	| {
			anchorDigest: string;
			exactCanonicalAnchorPreimageBytes: Uint8Array;
			ok: true;
			preparation: CreatorAnchorPreparation;
			signingRequest: CreatorAnchorSigningRequest;
	  }
> {
	try {
		if (!plainRecord(input) || !exactKeys(input, ["authority", "close", "exactCanonicalCommitQcBytes"])) {
			return failure("COMMIT_QC_REJECTED");
		}
		const close = closeStates.get(input.close as VerifiedCreatorClose);
		const identity = resolveSealAuthorityIdentity(input.authority);
		const commitQcBytes = copyBytes(input.exactCanonicalCommitQcBytes, undefined, 65_536);
		if (commitQcBytes === undefined || commitQcBytes.byteLength === 0) return failure("COMMIT_QC_REQUIRED");
		if (
			close === undefined ||
			identity === undefined ||
			identity.anchor !== close.material.currentAnchorDigest ||
			identity.epoch !== close.material.currentEpoch ||
			identity.objectId !== close.material.objectId ||
			identity.signerId !== creatorSignerId(close.material)
		) {
			return failure("COMMIT_QC_REJECTED");
		}
		const verified = verifySealQC({ authority: input.authority as never, exactCanonicalQcBytes: commitQcBytes });
		if (!verified.ok) return failure("COMMIT_QC_REJECTED");
		if (verified.phase !== "commit") return failure("COMMIT_QC_REQUIRED");
		if (verified.valueDigest !== close.valueDigest) return failure("CERTIFIED_VALUE_MISMATCH");
		const cut = exactCanonicalRecord(close.exactCanonicalCutValueBytes, "cutValue");
		if (cut === undefined) return failure("CERTIFIED_VALUE_MISMATCH");
		const exactCanonicalAnchorPreimageBytes = successorAnchor(close.currentAnchor, cut);
		const prepared = prepareCreatorAnchorSigningRequest({
			exactCanonicalAnchorPreimageBytes,
			exactCanonicalProfileBytes: close.material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: close.material.exactCanonicalSignerSetBytes,
			signerPublicKey: close.material.publicKey,
		});
		if (!prepared.ok) return failure("CERTIFIED_VALUE_MISMATCH");
		const preparation = Object.freeze({}) as CreatorAnchorPreparation;
		preparationStates.set(
			preparation,
			Object.freeze({
				anchorDigest: prepared.anchorDigest,
				currentTrust: close.currentTrust,
				exactCanonicalAnchorPreimageBytes: Uint8Array.from(exactCanonicalAnchorPreimageBytes),
				material: close.material,
			})
		);
		return Object.freeze({
			anchorDigest: prepared.anchorDigest,
			exactCanonicalAnchorPreimageBytes: Uint8Array.from(exactCanonicalAnchorPreimageBytes),
			ok: true as const,
			preparation,
			signingRequest: prepared.signingRequest,
		});
	} catch {
		return failure("COMMIT_QC_REJECTED");
	}
}

/**
 * Completes one prepared successor into the frozen v1 trust carrier.
 * @param input - Opaque preparation and detached creator signature.
 * @returns Exact frozen trust-state bytes, or a typed signature failure.
 */
export function completeCreatorSuccessor(
	input: unknown
): Readonly<{ exactCanonicalTrustStateRecordBytes: Uint8Array; ok: true } | { ok: false; reason: string }> {
	try {
		if (!plainRecord(input) || !exactKeys(input, ["detachedSignature", "preparation"])) {
			return failure("INVALID_SUCCESSOR_SIGNATURE");
		}
		const state = preparationStates.get(input.preparation as CreatorAnchorPreparation);
		const signature = copyBytes(input.detachedSignature, 64, 64);
		if (state === undefined || signature === undefined) return failure("INVALID_SUCCESSOR_SIGNATURE");
		preparationStates.delete(input.preparation as CreatorAnchorPreparation);
		if (
			!verifyEd25519RegisteredDigest(
				signature,
				Uint8Array.from(state.anchorDigest.match(/../gu) ?? [], (part) => Number.parseInt(part, 16)),
				state.material.publicKey
			)
		) {
			return failure("INVALID_SUCCESSOR_SIGNATURE");
		}
		const anchor = exactCanonicalRecord(state.exactCanonicalAnchorPreimageBytes, "epochAnchor");
		if (anchor === undefined) return failure("CERTIFIED_VALUE_MISMATCH");
		const exactCanonicalTrustStateRecordBytes = encodeCanonical({
			currentAnchorDigest: state.anchorDigest,
			currentEpoch: anchor.epoch,
			detachedCurrentAnchorSignature: signature,
			exactCanonicalCurrentAnchorPreimageBytes: state.exactCanonicalAnchorPreimageBytes,
			exactCanonicalProfileBytes: state.material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: state.material.exactCanonicalSignerSetBytes,
			genesisAnchorDigest: state.material.genesisAnchorDigest,
			kind: "drp-anchor-trust-state",
			objectId: state.material.objectId,
			profileId: (decodeCanonicalValue(state.material.exactCanonicalProfileBytes) as Record<string, unknown>).profileId,
			quorum: 1,
			version: 1,
		});
		return Object.freeze({
			exactCanonicalTrustStateRecordBytes: Uint8Array.from(exactCanonicalTrustStateRecordBytes),
			ok: true as const,
		});
	} catch {
		return failure("INVALID_SUCCESSOR_SIGNATURE");
	}
}

/**
 * Reopens one exact successor only when its CutValue and commit QC certify it.
 * @param input - Current trust plus exact CutValue, commit-QC, and trust-state bytes.
 * @returns A singleton-minted successor trust capability, or a typed rejection.
 */
export function openCreatorSuccessorTrust(
	input: unknown
): Readonly<{ ok: false; reason: string } | { ok: true; trust: CurrentAnchorTrust }> {
	try {
		if (
			!plainRecord(input) ||
			!exactKeys(input, [
				"currentTrust",
				"exactCanonicalCommitQcBytes",
				"exactCanonicalCutValueBytes",
				"exactCanonicalTrustStateRecordBytes",
			])
		) {
			return failure("CERTIFIED_VALUE_MISMATCH");
		}
		const currentTrust = input.currentTrust as CurrentAnchorTrust;
		const material = resolveCreatorAnchorTrustMaterial(currentTrust);
		if (material === undefined) return failure("UNTRUSTED_CURRENT_ANCHOR");
		const recordBytes = copyBytes(input.exactCanonicalTrustStateRecordBytes, undefined, 8192);
		if (recordBytes === undefined) return failure("CERTIFIED_VALUE_MISMATCH");
		const decodedRecord = decodeCanonicalValue(recordBytes);
		if (!plainRecord(decodedRecord) || !exactKeys(decodedRecord, trustRecordFields)) {
			return failure("CERTIFIED_VALUE_MISMATCH");
		}
		if (decodedRecord.version !== 1) return failure("UNSUPPORTED_TRUST_STATE_VERSION");
		const anchorBytes = copyBytes(decodedRecord.exactCanonicalCurrentAnchorPreimageBytes, undefined, 65_536);
		const signature = copyBytes(decodedRecord.detachedCurrentAnchorSignature, 64, 64);
		const profileBytes = copyBytes(decodedRecord.exactCanonicalProfileBytes, undefined, 65_536);
		const signerSetBytes = copyBytes(decodedRecord.exactCanonicalSignerSetBytes, undefined, 65_536);
		const anchor = anchorBytes === undefined ? undefined : exactCanonicalRecord(anchorBytes, "epochAnchor");
		if (
			anchorBytes === undefined ||
			signature === undefined ||
			profileBytes === undefined ||
			signerSetBytes === undefined ||
			anchor === undefined ||
			decodedRecord.kind !== "drp-anchor-trust-state" ||
			decodedRecord.objectId !== material.objectId ||
			decodedRecord.genesisAnchorDigest !== material.genesisAnchorDigest ||
			decodedRecord.profileId !== currentTrust.profileId ||
			decodedRecord.quorum !== 1 ||
			compareBytes(profileBytes, material.exactCanonicalProfileBytes) !== 0 ||
			compareBytes(signerSetBytes, material.exactCanonicalSignerSetBytes) !== 0
		) {
			return failure("CERTIFIED_VALUE_MISMATCH");
		}
		const anchorDigestBytes = hashDomain(registry.kinds.epochAnchor?.domain ?? "", anchorBytes);
		const anchorDigest = hex(anchorDigestBytes);
		if (
			decodedRecord.currentAnchorDigest !== anchorDigest ||
			decodedRecord.currentEpoch !== anchor.epoch ||
			anchor.objectId !== material.objectId ||
			!verifyEd25519RegisteredDigest(signature, anchorDigestBytes, material.publicKey)
		) {
			return failure("CERTIFIED_VALUE_MISMATCH");
		}
		if ((anchor.epoch as number) > material.currentEpoch + 1) return failure("EPOCH_GAP");
		if ((anchor.epoch as number) === material.currentEpoch && anchorDigest !== material.currentAnchorDigest) {
			return failure("EPOCH_EQUIVOCATION");
		}
		if ((anchor.epoch as number) !== material.currentEpoch + 1) return failure("CERTIFIED_VALUE_MISMATCH");

		const cutBytes = copyBytes(input.exactCanonicalCutValueBytes, undefined, 65_536);
		const commitQcBytes = copyBytes(input.exactCanonicalCommitQcBytes, undefined, 65_536);
		if (commitQcBytes === undefined || commitQcBytes.byteLength === 0) return failure("COMMIT_QC_REQUIRED");
		if (cutBytes === undefined) return failure("CERTIFIED_VALUE_MISMATCH");
		const cut = exactCanonicalRecord(cutBytes, "cutValue");
		if (cut === undefined) return failure("CERTIFIED_VALUE_MISMATCH");
		const opened = openSealAuthority({ signerPublicKey: material.publicKey, trust: currentTrust });
		if (!opened.ok) return failure("COMMIT_QC_REJECTED");
		const verified = verifySealQC({ authority: opened.authority, exactCanonicalQcBytes: commitQcBytes });
		if (!verified.ok) return failure("COMMIT_QC_REJECTED");
		if (verified.phase !== "commit") return failure("COMMIT_QC_REQUIRED");
		const valueDigest = hex(hashDomain(registry.kinds.cutValue?.domain ?? "", cutBytes));
		if (verified.valueDigest !== valueDigest) return failure("CERTIFIED_VALUE_MISMATCH");
		const currentAnchor = exactCanonicalRecord(material.exactCanonicalCurrentAnchorPreimageBytes, "epochAnchor");
		if (
			currentAnchor === undefined ||
			cut.epoch !== material.currentEpoch ||
			cut.previousAnchor !== material.currentAnchorDigest ||
			cut.previousCutDigest !== currentAnchor.cutDigest ||
			cut.previousHistoryRoot !== currentAnchor.historyRoot ||
			cut.previousHistorySize !== currentAnchor.historySize ||
			compareBytes(successorAnchor(currentAnchor, cut), anchorBytes) !== 0 ||
			closedCutSuccessorEquation(material, anchorBytes, cutBytes) === undefined
		) {
			return failure("CERTIFIED_VALUE_MISMATCH");
		}
		const trust = mintCreatorAnchorTrustSuccessor(currentTrust, anchorBytes, signature);
		return trust === undefined ? failure("CERTIFIED_VALUE_MISMATCH") : Object.freeze({ ok: true as const, trust });
	} catch {
		return failure("CERTIFIED_VALUE_MISMATCH");
	}
}

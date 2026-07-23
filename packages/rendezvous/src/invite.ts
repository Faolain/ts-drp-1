import { publicKeyFromProtobuf, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import type { PrivateKey, PublicKey } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { base64url } from "multiformats/bases/base64";

import { classifyIpAddressScope } from "./address-policy.js";
import { reconcileValidatedRecords } from "./reconciliation.js";
import { type RecordValidator, type SignedDrpRecordV1 } from "./record.js";
import type { ValidatedDrpRecord } from "./registry.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const INVITE_KIND = "ts-drp-rendezvous-invite";
const MAX_CONTACTS = 8;
const MAX_INVITE_BYTES = 128 * 1024;

export interface InvitePayloadV1 {
	readonly contacts: readonly SignedDrpRecordV1[];
	readonly expiresAtMs: number;
	readonly issuedAtMs: number;
	readonly membershipCapability: string;
	readonly namespace: string;
	readonly registryEndpoints: readonly string[];
}

export interface VerifiedInvite {
	readonly contacts: readonly ValidatedDrpRecord[];
	readonly expiresAtMs: number;
	readonly issuedAtMs: number;
	readonly issuerPublicKey: string;
	readonly membershipCapability: string;
	readonly namespace: string;
	readonly registryEndpoints: readonly string[];
}

export type InviteEncodeErrorCode = "too-many-contacts" | "unsafe-contact-address";

/** A categorical invite-creation failure that never includes contact material. */
export class InviteEncodeError extends Error {
	readonly code: InviteEncodeErrorCode;

	/**
	 * @param code - Sanitized invite-creation failure category.
	 */
	constructor(code: InviteEncodeErrorCode) {
		super(code);
		this.name = "InviteEncodeError";
		this.code = code;
	}
}

export type InviteDecodeErrorCode =
	| "expired"
	| "invalid-contact"
	| "invalid-endpoint"
	| "invalid-issuer-signature"
	| "invalid-shape";

/** A categorical invite-consumption failure that never includes wire material. */
export class InviteDecodeError extends Error {
	readonly code: InviteDecodeErrorCode;

	/**
	 * @param code - Sanitized invite-consumption failure category.
	 */
	constructor(code: InviteDecodeErrorCode) {
		super(code);
		this.name = "InviteDecodeError";
		this.code = code;
	}
}

export interface InviteDecodeOptions {
	/** Explicit deterministic-fixture escape hatch; production invites remain HTTPS-only. */
	readonly allow_insecure_loopback_fixture?: boolean;
	clock?(): number;
	validatorFactory(): RecordValidator;
}

export interface InviteDirectoryOptions {
	clock?(): number;
	readonly invite: VerifiedInvite;
	validatorFactory(): RecordValidator;
}

interface UnsignedInviteWireV1 {
	readonly issuerPublicKey: string;
	readonly kind: typeof INVITE_KIND;
	readonly payload: InvitePayloadV1;
	readonly version: 1;
}

interface InviteWireV1 extends UnsignedInviteWireV1 {
	readonly signature: string;
}

/**
 * Encodes one bounded invite and signs its complete canonical unsigned envelope.
 * Public key material is protobuf-serialized and all binary fields use canonical base64url.
 * @param payload - Bounded invite contacts, endpoints, expiry, and membership capability.
 * @param signer - Invite issuer key and signing operation.
 * @returns Canonical base64url-encoded signed invite envelope.
 */
export async function encodeInvite(
	payload: InvitePayloadV1,
	signer: Pick<PrivateKey, "publicKey" | "sign">
): Promise<string> {
	if (payload.contacts.length > MAX_CONTACTS) throw new InviteEncodeError("too-many-contacts");
	if (!payload.contacts.every(hasOnlyPublicContactAddresses)) {
		throw new InviteEncodeError("unsafe-contact-address");
	}

	const unsignedWire: UnsignedInviteWireV1 = {
		issuerPublicKey: encodeBase64Url(publicKeyToProtobuf(signer.publicKey)),
		kind: INVITE_KIND,
		payload: canonicalizePayload(payload),
		version: 1,
	};
	const signature = await signer.sign(canonicalUnsignedEnvelopeBytes(unsignedWire));
	const wire: InviteWireV1 = { ...unsignedWire, signature: encodeBase64Url(signature) };
	return encodeBase64Url(encoder.encode(JSON.stringify(wire)));
}

/**
 * Authenticates an invite, applies the decoding client's endpoint/expiry policy,
 * and validates every embedded contact through the shared RecordValidator.
 * The issuer key is authenticated by self-signature but is not authorized here:
 * invites carry untrusted candidates, while DRP membership and connection
 * authentication own authorization (invariant 1).
 * @param encoded - Untrusted base64url invite envelope.
 * @param options - Client-owned clock, validator, and endpoint policy.
 * @returns Authenticated invite metadata and independently validated contacts.
 */
export async function decodeInvite(encoded: string, options: InviteDecodeOptions): Promise<VerifiedInvite> {
	const wire = parseWire(encoded);
	const canonicalPayload = canonicalizePayload(wire.payload);
	const issuer = decodeIssuer(wire.issuerPublicKey);
	const signature = decodeSignature(wire.signature);

	let verified = false;
	try {
		verified = await issuer.verify(
			canonicalUnsignedEnvelopeBytes({
				issuerPublicKey: wire.issuerPublicKey,
				kind: wire.kind,
				payload: canonicalPayload,
				version: wire.version,
			}),
			signature
		);
	} catch {
		throw new InviteDecodeError("invalid-issuer-signature");
	}
	if (!verified) throw new InviteDecodeError("invalid-issuer-signature");

	const now = (options.clock ?? Date.now)();
	if (canonicalPayload.expiresAtMs <= now) throw new InviteDecodeError("expired");
	if (!canonicalPayload.registryEndpoints.every((endpoint) => isAllowedEndpoint(endpoint, options))) {
		throw new InviteDecodeError("invalid-endpoint");
	}

	const contacts = await validateContacts(
		canonicalPayload.contacts,
		canonicalPayload.namespace,
		options.validatorFactory
	);
	return Object.freeze({
		contacts,
		expiresAtMs: canonicalPayload.expiresAtMs,
		issuedAtMs: canonicalPayload.issuedAtMs,
		issuerPublicKey: wire.issuerPublicKey,
		membershipCapability: canonicalPayload.membershipCapability,
		namespace: canonicalPayload.namespace,
		registryEndpoints: Object.freeze([...canonicalPayload.registryEndpoints]),
	});
}

/**
 * Revalidates an invite snapshot at each discovery boundary. The authenticated
 * issuer is not authorized here; contacts remain untrusted candidates until
 * independent record validation and downstream membership/connection auth
 * (invariant 1).
 */
export class InviteDirectory {
	readonly #clock: () => number;
	readonly #invite: VerifiedInvite;
	readonly #validatorFactory: () => RecordValidator;

	/**
	 * @param options - Verified invite snapshot, client clock, and validator factory.
	 */
	constructor(options: InviteDirectoryOptions) {
		this.#clock = options.clock ?? Date.now;
		this.#invite = options.invite;
		this.#validatorFactory = options.validatorFactory;
	}

	/**
	 * @param namespace - Expected opaque rendezvous namespace.
	 * @param signal - Caller-owned discovery cancellation signal.
	 * @returns Fresh contacts while the invite remains unexpired.
	 */
	async discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]> {
		signal.throwIfAborted();
		if (this.#invite.expiresAtMs <= this.#clock()) return [];
		if (namespace !== this.#invite.namespace) return [];
		const validator = this.#validatorFactory();
		const accepted: ValidatedDrpRecord[] = [];
		for (const candidate of this.#invite.contacts.slice(0, MAX_CONTACTS)) {
			signal.throwIfAborted();
			const input =
				typeof candidate === "object" && candidate !== null && "record" in candidate ? candidate.record : undefined;
			const result = await validator.validate(input, {
				admission: { accepted: true, mode: "invite" },
				expectedNamespace: namespace,
				signal,
			});
			if (result.accepted) {
				accepted.push({ admissionMode: result.admissionMode, record: result.record, sourceEndpointId: "invite" });
			}
		}
		return reconcileValidatedRecords([accepted], { maxRecords: MAX_CONTACTS, now: Number.NEGATIVE_INFINITY });
	}
}

async function validateContacts(
	contacts: readonly SignedDrpRecordV1[],
	namespace: string,
	validatorFactory: () => RecordValidator
): Promise<readonly ValidatedDrpRecord[]> {
	const validator = validatorFactory();
	const signal = new AbortController().signal;
	const accepted: ValidatedDrpRecord[] = [];
	for (const contact of contacts) {
		const result = await validator.validate(contact, {
			admission: { accepted: true, mode: "invite" },
			expectedNamespace: namespace,
			signal,
		});
		if (!result.accepted) throw new InviteDecodeError("invalid-contact");
		accepted.push({ admissionMode: result.admissionMode, record: result.record, sourceEndpointId: "invite" });
	}
	return reconcileValidatedRecords([accepted], { maxRecords: MAX_CONTACTS, now: Number.NEGATIVE_INFINITY });
}

function parseWire(encoded: string): InviteWireV1 {
	try {
		if (typeof encoded !== "string") throw new Error("not a string");
		const bytes = decodeCanonicalBase64Url(encoded);
		if (bytes.byteLength > MAX_INVITE_BYTES) throw new Error("invite is oversized");
		const value = JSON.parse(decoder.decode(bytes)) as unknown;
		if (!isExactObject(value, ["issuerPublicKey", "kind", "payload", "signature", "version"])) {
			throw new Error("invalid envelope");
		}
		if (
			value.kind !== INVITE_KIND ||
			value.version !== 1 ||
			typeof value.issuerPublicKey !== "string" ||
			typeof value.signature !== "string" ||
			!isPayload(value.payload)
		) {
			throw new Error("invalid envelope fields");
		}
		return value as unknown as InviteWireV1;
	} catch (error) {
		if (error instanceof InviteDecodeError) throw error;
		throw new InviteDecodeError("invalid-shape");
	}
}

function isPayload(value: unknown): value is InvitePayloadV1 {
	if (
		!isExactObject(value, [
			"contacts",
			"expiresAtMs",
			"issuedAtMs",
			"membershipCapability",
			"namespace",
			"registryEndpoints",
		])
	) {
		return false;
	}
	return (
		Array.isArray(value.contacts) &&
		value.contacts.length <= MAX_CONTACTS &&
		typeof value.expiresAtMs === "number" &&
		Number.isSafeInteger(value.expiresAtMs) &&
		typeof value.issuedAtMs === "number" &&
		Number.isSafeInteger(value.issuedAtMs) &&
		value.expiresAtMs > value.issuedAtMs &&
		typeof value.membershipCapability === "string" &&
		value.membershipCapability.length > 0 &&
		typeof value.namespace === "string" &&
		Array.isArray(value.registryEndpoints) &&
		value.registryEndpoints.every((endpoint) => typeof endpoint === "string")
	);
}

function canonicalizePayload(payload: InvitePayloadV1): InvitePayloadV1 {
	return {
		contacts: payload.contacts.map(canonicalizeContact),
		expiresAtMs: payload.expiresAtMs,
		issuedAtMs: payload.issuedAtMs,
		membershipCapability: payload.membershipCapability,
		namespace: payload.namespace,
		registryEndpoints: [...payload.registryEndpoints],
	};
}

function canonicalizeContact(record: SignedDrpRecordV1): SignedDrpRecordV1 {
	return {
		kind: record.kind,
		version: record.version,
		namespace: record.namespace,
		peerId: record.peerId,
		publicKey: record.publicKey,
		addresses: [...record.addresses],
		capabilities: [...record.capabilities],
		sequence: record.sequence,
		issuedAtMs: record.issuedAtMs,
		expiresAtMs: record.expiresAtMs,
		signature: record.signature,
	};
}

function canonicalUnsignedEnvelopeBytes(wire: UnsignedInviteWireV1): Uint8Array {
	return encoder.encode(
		JSON.stringify({
			kind: wire.kind,
			version: wire.version,
			issuerPublicKey: wire.issuerPublicKey,
			payload: canonicalizePayload(wire.payload),
		})
	);
}

function hasOnlyPublicContactAddresses(contact: SignedDrpRecordV1): boolean {
	try {
		return (
			contact.addresses.length > 0 &&
			contact.addresses.every((address) => {
				const host = multiaddr(address)
					.getComponents()
					.find((component) => ["ip4", "ip6", "dns", "dns4", "dns6", "dnsaddr"].includes(component.name));
				if (host === undefined) return false;
				if (["dns", "dns4", "dns6", "dnsaddr"].includes(host.name)) return true;
				return classifyIpAddressScope(host.value ?? "") === "public";
			})
		);
	} catch {
		return false;
	}
}

function isAllowedEndpoint(endpoint: string, options: InviteDecodeOptions): boolean {
	try {
		const url = new URL(endpoint);
		if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return false;
		if (url.protocol === "https:") return true;
		const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
		return options.allow_insecure_loopback_fixture === true && loopback && url.protocol === "http:";
	} catch {
		return false;
	}
}

function decodeIssuer(value: string): PublicKey {
	try {
		const key = publicKeyFromProtobuf(decodeCanonicalBase64Url(value));
		if (key.type !== "Ed25519" && key.type !== "secp256k1") throw new Error("unsupported issuer key");
		return key;
	} catch {
		throw new InviteDecodeError("invalid-issuer-signature");
	}
}

function decodeSignature(value: string): Uint8Array {
	try {
		return decodeCanonicalBase64Url(value);
	} catch {
		throw new InviteDecodeError("invalid-issuer-signature");
	}
}

function encodeBase64Url(bytes: Uint8Array): string {
	return base64url.baseEncode(bytes);
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
	const bytes = base64url.baseDecode(value);
	if (encodeBase64Url(bytes) !== value) throw new Error("non-canonical base64url");
	return bytes;
}

function isExactObject(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

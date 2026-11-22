import { ed25519 } from "@noble/curves/ed25519.js";

import type { CryptoSuiteId } from "./crypto-suite.js";

const REGISTERED_DIGEST_BYTES = 32;
const ED25519_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const IDENTITY_DOMAIN = "ts-drp/vertex/v2";
const SEAL_DOMAIN = "ts-drp/seal-vote/v2";

/**
 * Metadata binding a registered digest to its protocol scope.
 *
 * The verifier does not have the canonical preimage and cannot recompute `bytes`. The caller MUST
 * construct them with `hashDomain(domain, ...canonicalParts)` and MUST bind the anchor in that
 * registered preimage wherever the registry declares it. `domain` and `anchor` are scope metadata,
 * not a substitute for that cryptographic recomputation.
 */
export interface RegisteredDigest {
	anchor: string;
	bytes: Uint8Array;
	domain: string;
}

/** The protocol scope expected by a signature verifier. */
export interface SignatureScope {
	anchor: string;
	domain: string;
}

/** Encoded public-key material supplied to a suite-specific verifier. */
export interface SignaturePublicKey {
	bytes: Uint8Array;
	format: "raw" | "spki";
}

/** Input shared by the identity and seal suite verifiers. */
export interface RegisteredSignature {
	expectedScope: SignatureScope;
	publicKey: SignaturePublicKey;
	registeredDigest: RegisteredDigest;
	signature: Uint8Array;
	suiteId: CryptoSuiteId;
}

function hasLength(value: Uint8Array, length: number): boolean {
	return value.byteLength === length;
}

/** Signs the raw 32-byte registered digest with an Ed25519 identity key seed. */
export function signIdentityDigest(privateKeySeed: Uint8Array, registeredDigest: Uint8Array): Uint8Array {
	if (!hasLength(privateKeySeed, ED25519_KEY_BYTES)) {
		throw new TypeError(`Ed25519 private key seed must contain exactly ${ED25519_KEY_BYTES} bytes`);
	}
	if (!hasLength(registeredDigest, REGISTERED_DIGEST_BYTES)) {
		throw new TypeError(`registered digest must contain exactly ${REGISTERED_DIGEST_BYTES} bytes`);
	}
	return ed25519.sign(registeredDigest, privateKeySeed);
}

/**
 * Verifies a caller-recomputed registered digest under the explicitly named signature suite.
 *
 * Scope equality below is a metadata guard. The caller obligation documented on `RegisteredDigest`
 * is what connects those labels to the cryptographically framed digest bytes.
 */
export function verifyRegisteredSignature(input: RegisteredSignature): boolean {
	const { expectedScope, publicKey, registeredDigest, signature, suiteId } = input;
	if (
		registeredDigest.anchor !== expectedScope.anchor ||
		registeredDigest.domain !== expectedScope.domain ||
		!hasLength(registeredDigest.bytes, REGISTERED_DIGEST_BYTES) ||
		!hasLength(signature, SIGNATURE_BYTES)
	) {
		return false;
	}

	try {
		switch (suiteId) {
			case "ed25519-sha256-v1":
				return (
					registeredDigest.domain === IDENTITY_DOMAIN &&
					publicKey.format === "raw" &&
					hasLength(publicKey.bytes, ED25519_KEY_BYTES) &&
					ed25519.verify(signature, registeredDigest.bytes, publicKey.bytes, { zip215: false })
				);
			case "ed25519-seal-v1":
				return (
					registeredDigest.domain === SEAL_DOMAIN &&
					publicKey.format === "raw" &&
					hasLength(publicKey.bytes, ED25519_KEY_BYTES) &&
					ed25519.verify(signature, registeredDigest.bytes, publicKey.bytes, { zip215: false })
				);
			case "p256-sha256-v1":
				return false;
			default:
				return false;
		}
	} catch {
		return false;
	}
}

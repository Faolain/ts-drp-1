import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2";
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { hashDomain, type RegisteredDigest, signIdentityDigest, verifyRegisteredSignature } from "../src/index.js";

const IDENTITY_SUITE = "ed25519-sha256-v1" as const;
const SEAL_SUITE = "ed25519-seal-v1" as const;
const RESERVED_SUITE = "p256-sha256-v1" as const;
const IDENTITY_DOMAIN = "ts-drp/vertex/v2";
const SEAL_DOMAIN = "ts-drp/seal-vote/v2";
const ANCHOR = "a".repeat(64);
const WRONG_ANCHOR = "b".repeat(64);
const VECTOR_PART = new TextEncoder().encode("phase-minus-one-d");
const ED25519_SEED = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const ED25519_PUBLIC_KEY = fromHex("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
const FIXED_DIGEST = fromHex("504630d03b96c87bbf3e463ebd976562a692a4df1c9eb4b0e5af0b3498aa5d87");
const FIXED_SIGNATURE_HEX =
	"45efbb33d338d5134b196df829249444df18ddc3c2382861ead4d99ad2610a2b" +
	"ee4706d4876bece65b3d45d8f00177e4f647019fbe3124adcf05802c95fe730f";
const PKCS8_ED25519_SEED_PREFIX = fromHex("302e020100300506032b657004220420");

const ed25519PrivateKey = createPrivateKey({
	key: Buffer.concat([PKCS8_ED25519_SEED_PREFIX, ED25519_SEED]),
	format: "der",
	type: "pkcs8",
});
const ed25519PublicKey = createPublicKey(ed25519PrivateKey);
const SEAL_DIGEST = hashDomain(SEAL_DOMAIN, VECTOR_PART);
const SEAL_SIGNATURE = new Uint8Array(nodeSign(null, SEAL_DIGEST, ed25519PrivateKey));

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ed25519Signature(digest: Uint8Array): Uint8Array {
	return new Uint8Array(nodeSign(null, digest, ed25519PrivateKey));
}

function registeredDigest(bytes: Uint8Array, domain = IDENTITY_DOMAIN, anchor = ANCHOR): RegisteredDigest {
	return { anchor, bytes, domain };
}

const expectedIdentityScope = { anchor: ANCHOR, domain: IDENTITY_DOMAIN };
const expectedSealScope = { anchor: ANCHOR, domain: SEAL_DOMAIN };

describe("Phase -1d signature vectors", () => {
	it("pins one deterministic 64-byte Ed25519 signature and repeated-call stability", () => {
		expect(hex(hashDomain(IDENTITY_DOMAIN, VECTOR_PART))).toBe(hex(FIXED_DIGEST));

		const first = signIdentityDigest(ED25519_SEED, FIXED_DIGEST);
		const second = signIdentityDigest(ED25519_SEED, FIXED_DIGEST);

		expect(first).toHaveLength(64);
		expect(hex(first)).toBe(FIXED_SIGNATURE_HEX);
		expect(second).toEqual(first);
	});

	it("signs the raw registered digest bytes, never UTF8(hexDigest)", () => {
		const signature = signIdentityDigest(ED25519_SEED, FIXED_DIGEST);
		const hexDigestUtf8 = new TextEncoder().encode(hex(FIXED_DIGEST));

		expect(nodeVerify(null, FIXED_DIGEST, ed25519PublicKey, signature)).toBe(true);
		expect(nodeVerify(null, hexDigestUtf8, ed25519PublicKey, signature)).toBe(false);
	});

	it("rejects identity signing inputs whose key or digest is not exactly 32 bytes", () => {
		expect(() => signIdentityDigest(ED25519_SEED.subarray(0, 31), FIXED_DIGEST)).toThrow(/seed.*32 bytes/i);
		expect(() => signIdentityDigest(ED25519_SEED, FIXED_DIGEST.subarray(0, 31))).toThrow(/digest.*32 bytes/i);
		expect(() => signIdentityDigest(ED25519_SEED, new Uint8Array(33))).toThrow(/digest.*32 bytes/i);
	});

	it("rejects registered-digest metadata whose domain differs from expectedScope", () => {
		const signature = ed25519Signature(FIXED_DIGEST);

		expect(
			verifyRegisteredSignature({
				expectedScope: { ...expectedIdentityScope, domain: "ts-drp/foreign-vertex/v2" },
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(FIXED_DIGEST),
				signature,
				suiteId: IDENTITY_SUITE,
			})
		).toBe(false);
	});

	it("rejects registered-digest metadata whose anchor differs from expectedScope", () => {
		const wrongAnchorDigest = hashDomain(IDENTITY_DOMAIN, new TextEncoder().encode(WRONG_ANCHOR), VECTOR_PART);
		const signature = ed25519Signature(wrongAnchorDigest);

		expect(
			verifyRegisteredSignature({
				expectedScope: expectedIdentityScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(wrongAnchorDigest, IDENTITY_DOMAIN, WRONG_ANCHOR),
				signature,
				suiteId: IDENTITY_SUITE,
			})
		).toBe(false);
	});

	it("rejects a signature over SHA256(registeredDigest)", () => {
		const signature = ed25519Signature(sha256(FIXED_DIGEST));

		expect(
			verifyRegisteredSignature({
				expectedScope: expectedIdentityScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(FIXED_DIGEST),
				signature,
				suiteId: IDENTITY_SUITE,
			})
		).toBe(false);
	});

	it("accepts an Ed25519 seal signature under the seal suite", () => {
		expect(
			verifyRegisteredSignature({
				expectedScope: expectedSealScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(SEAL_DIGEST, SEAL_DOMAIN),
				signature: SEAL_SIGNATURE,
				suiteId: SEAL_SUITE,
			})
		).toBe(true);
	});

	it("rejects an Ed25519 seal-domain signature under the identity suite", () => {
		expect(
			verifyRegisteredSignature({
				expectedScope: expectedSealScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(SEAL_DIGEST, SEAL_DOMAIN),
				signature: SEAL_SIGNATURE,
				suiteId: IDENTITY_SUITE,
			})
		).toBe(false);
	});

	it("accepts an Ed25519 identity signature under the identity suite", () => {
		expect(
			verifyRegisteredSignature({
				expectedScope: expectedIdentityScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(FIXED_DIGEST),
				signature: ed25519Signature(FIXED_DIGEST),
				suiteId: IDENTITY_SUITE,
			})
		).toBe(true);
	});

	it("rejects an Ed25519 identity-domain signature under the seal suite", () => {
		expect(
			verifyRegisteredSignature({
				expectedScope: expectedIdentityScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(FIXED_DIGEST),
				signature: ed25519Signature(FIXED_DIGEST),
				suiteId: SEAL_SUITE,
			})
		).toBe(false);
	});

	it("cryptographically separates identity and seal domains for the same Ed25519 key", () => {
		const identitySignature = ed25519Signature(FIXED_DIGEST);
		const sealSignature = ed25519Signature(SEAL_DIGEST);

		expect(
			verifyRegisteredSignature({
				expectedScope: expectedSealScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(SEAL_DIGEST, SEAL_DOMAIN),
				signature: identitySignature,
				suiteId: SEAL_SUITE,
			})
		).toBe(false);
		expect(
			verifyRegisteredSignature({
				expectedScope: expectedIdentityScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" },
				registeredDigest: registeredDigest(FIXED_DIGEST),
				signature: sealSignature,
				suiteId: IDENTITY_SUITE,
			})
		).toBe(false);
	});

	it("rejects the reserved P-256 suite and an unrecognised suite with the boolean false", () => {
		const input = {
			expectedScope: expectedIdentityScope,
			publicKey: { bytes: ED25519_PUBLIC_KEY, format: "raw" as const },
			registeredDigest: registeredDigest(FIXED_DIGEST),
			signature: ed25519Signature(FIXED_DIGEST),
		};

		expect(verifyRegisteredSignature({ ...input, suiteId: RESERVED_SUITE })).toBe(false);
		expect(verifyRegisteredSignature({ ...input, suiteId: "future-suite-v1" as never })).toBe(false);
	});

	it("uses strict RFC 8032 verification rather than the wider ZIP-215 acceptance set", () => {
		const smallOrderPublicKey = new Uint8Array(32);
		smallOrderPublicKey[0] = 1;
		const smallOrderSignature = new Uint8Array(64);
		smallOrderSignature[0] = 1;
		expect(ed25519.verify(smallOrderSignature, FIXED_DIGEST, smallOrderPublicKey, { zip215: true })).toBe(true);

		expect(
			verifyRegisteredSignature({
				expectedScope: expectedIdentityScope,
				publicKey: { bytes: smallOrderPublicKey, format: "raw" },
				registeredDigest: registeredDigest(FIXED_DIGEST),
				signature: smallOrderSignature,
				suiteId: IDENTITY_SUITE,
			})
		).toBe(false);
		expect(ed25519.verify(smallOrderSignature, SEAL_DIGEST, smallOrderPublicKey, { zip215: true })).toBe(true);
		expect(
			verifyRegisteredSignature({
				expectedScope: expectedSealScope,
				publicKey: { bytes: smallOrderPublicKey, format: "raw" },
				registeredDigest: registeredDigest(SEAL_DIGEST, SEAL_DOMAIN),
				signature: smallOrderSignature,
				suiteId: SEAL_SUITE,
			})
		).toBe(false);
	});

	it("rejects raw Ed25519 bytes mislabeled with a non-raw key format under either active suite", () => {
		expect(
			verifyRegisteredSignature({
				expectedScope: expectedIdentityScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "spki" },
				registeredDigest: registeredDigest(FIXED_DIGEST),
				signature: ed25519Signature(FIXED_DIGEST),
				suiteId: IDENTITY_SUITE,
			})
		).toBe(false);
		expect(
			verifyRegisteredSignature({
				expectedScope: expectedSealScope,
				publicKey: { bytes: ED25519_PUBLIC_KEY, format: "spki" },
				registeredDigest: registeredDigest(SEAL_DIGEST, SEAL_DOMAIN),
				signature: SEAL_SIGNATURE,
				suiteId: SEAL_SUITE,
			})
		).toBe(false);
	});

	it("returns false when suite verification throws", () => {
		const throwingBytes = new Proxy(new Uint8Array(32), {});
		expect(() => throwingBytes.byteLength).toThrow();

		expect(
			verifyRegisteredSignature({
				expectedScope: expectedIdentityScope,
				publicKey: { bytes: throwingBytes, format: "raw" },
				registeredDigest: registeredDigest(FIXED_DIGEST),
				signature: ed25519Signature(FIXED_DIGEST),
				suiteId: IDENTITY_SUITE,
			})
		).toBe(false);
	});
});

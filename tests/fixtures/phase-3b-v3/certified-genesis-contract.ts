import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { createHash } from "node:crypto";

import contract from "./certified-genesis-contract.json" with { type: "json" };

const encoder = new TextEncoder();

export interface CertifiedSignerMaterial {
	readonly privateKey: Uint8Array;
	readonly publicKey: string;
	readonly signerId: string;
}

export interface CertifiedGenesisMaterial {
	readonly anchor: Readonly<Record<string, unknown>>;
	readonly anchorBytes: Uint8Array;
	readonly anchorDigest: string;
	readonly certificate: Readonly<Record<string, unknown>>;
	readonly certificateBytes: Uint8Array;
	readonly profile: Readonly<Record<string, unknown>>;
	readonly profileBytes: Uint8Array;
	readonly signerSet: readonly Readonly<Record<string, unknown>>[];
	readonly signerSetBytes: Uint8Array;
	readonly signers: readonly CertifiedSignerMaterial[];
}

export interface CertifiedGenesisOptions {
	readonly objectId?: string;
	readonly profileId?: "attested-bft-v1" | "delegated-trusted-v1";
	readonly quorum?: number;
	readonly signerIds?: readonly string[];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function unsignedBigEndian(value: number, bytes: 4 | 8): Uint8Array {
	const output = new Uint8Array(bytes);
	const view = new DataView(output.buffer);
	if (bytes === 4) view.setUint32(0, value, false);
	else view.setBigUint64(0, BigInt(value), false);
	return output;
}

/**
 * Independently frames and hashes one registered domain.
 * @param domain - Registered domain string.
 * @param parts - Exact framed byte parts.
 * @returns Raw SHA-256 digest bytes.
 */
export function independentHashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
	const domainBytes = encoder.encode(domain);
	return new Uint8Array(
		createHash("sha256")
			.update(
				concat([
					Uint8Array.of(0x44, 0x52, 0x50, 0),
					unsignedBigEndian(domainBytes.byteLength, 4),
					domainBytes,
					...parts.flatMap((part) => [unsignedBigEndian(part.byteLength, 8), part]),
				])
			)
			.digest()
	);
}

/**
 * Converts exact bytes to lowercase hexadecimal.
 * @param bytes - Exact input bytes.
 * @returns Lowercase hexadecimal.
 */
export function bytesHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates deterministic signer material without consulting production trust code.
 * @param index - Deterministic private-key index.
 * @param signerId - Exact signer identity.
 * @returns Independent signer material.
 */
export function makeSigner(
	index: number,
	signerId = `signer-${String(index).padStart(2, "0")}`
): CertifiedSignerMaterial {
	const privateKey = new Uint8Array(32);
	privateKey.fill(index + 1);
	return Object.freeze({
		privateKey,
		publicKey: bytesHex(ed25519.getPublicKey(privateKey)),
		signerId,
	});
}

/**
 * Authors one canonical certified genesis tuple with genuine detached signatures.
 * @param options - Exact profile, object and signer overrides.
 * @returns Canonical certified genesis material.
 */
export function makeCertifiedGenesis(options: CertifiedGenesisOptions = {}): CertifiedGenesisMaterial {
	const profileId = options.profileId ?? contract.delegatedProfileId;
	const defaultCount = profileId === "attested-bft-v1" ? 4 : 3;
	const signerIds = options.signerIds ?? Array.from({ length: defaultCount }, (_, index) => `signer-${index + 1}`);
	const signers = signerIds.map((signerId, index) => makeSigner(index, signerId));
	const signerSet = signers
		.map(({ publicKey, signerId }) => Object.freeze({ publicKey, signerId }))
		.sort((left, right) => Buffer.from(left.signerId).compare(Buffer.from(right.signerId)));
	const signerSetBytes = encodeCanonical(signerSet);
	const profile = Object.freeze({
		cryptoSuiteId: contract.profileSuiteId,
		profileId,
		quorum: options.quorum ?? (profileId === "attested-bft-v1" ? 3 : 2),
		signers: signerSet,
	});
	const profileBytes = encodeCanonical(profile);
	const anchor = Object.freeze({
		aclDigest: "2".repeat(64),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest: "4".repeat(64),
		cryptoSuiteId: contract.anchorSuiteId,
		cutDigest: contract.zeroDigest,
		epoch: 0,
		historyRoot: "5".repeat(64),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId: options.objectId ?? contract.objectId,
		parametersDigest: "6".repeat(64),
		previousAnchor: contract.zeroDigest,
		profileDigest: bytesHex(independentHashDomain(contract.profileDigestDomain, profileBytes)),
		protocolMajor: 3,
		signerSetDigest: bytesHex(independentHashDomain(contract.signerSetDigestDomain, signerSetBytes)),
		stateDigest: "7".repeat(64),
	});
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
	const signerById = new Map(signers.map((signer) => [signer.signerId, signer]));
	const signatures = signerSet.map(({ publicKey, signerId }) => {
		const signer = signerById.get(signerId);
		if (signer === undefined) throw new Error(`missing signer material for ${signerId}`);
		return Object.freeze({
			publicKey,
			signature: ed25519.sign(Uint8Array.from(Buffer.from(anchorDigest, "hex")), signer.privateKey),
			signerId,
		});
	});
	const certificate = Object.freeze({
		genesisAnchorDigest: anchorDigest,
		kind: contract.certificateKind,
		profileDigest: anchor.profileDigest,
		signatures,
		signerSetDigest: anchor.signerSetDigest,
		version: contract.certificateVersion,
	});
	const certificateBytes = encodeCanonical(certificate);
	return Object.freeze({
		anchor,
		anchorBytes,
		anchorDigest,
		certificate,
		certificateBytes,
		profile,
		profileBytes,
		signerSet,
		signerSetBytes,
		signers,
	});
}

/**
 * Builds the exact five-field public installation input.
 * @param material - Valid certified genesis material.
 * @returns Detached public installation input.
 */
export function installInput(material = makeCertifiedGenesis()): Readonly<Record<string, unknown>> {
	return Object.freeze({
		exactCanonicalCertifiedGenesisCertificateBytes: new Uint8Array(material.certificateBytes),
		exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		exactCanonicalProfileBytes: new Uint8Array(material.profileBytes),
		exactCanonicalSignerSetBytes: new Uint8Array(material.signerSetBytes),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	});
}

/**
 * Rewrites a canonical record with exact closed-field changes.
 * @param bytes - Exact canonical source bytes.
 * @param changes - Closed-field replacements.
 * @returns Re-encoded canonical bytes.
 */
export function mutateCanonical(bytes: Uint8Array, changes: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({ ...(decodeCanonical(bytes) as Record<string, unknown>), ...changes });
}

/**
 * Authors the exact expected thirteen-field durable record for sizing and open controls.
 * @param material - Valid certified genesis material.
 * @returns Canonical durable record bytes.
 */
export function makeExpectedTrustStateRecord(material = makeCertifiedGenesis()): Uint8Array {
	return encodeCanonical({
		currentAnchorDigest: material.anchorDigest,
		currentEpoch: 0,
		exactCanonicalCertifiedGenesisCertificateBytes: material.certificateBytes,
		exactCanonicalCurrentAnchorPreimageBytes: material.anchorBytes,
		exactCanonicalProfileBytes: material.profileBytes,
		exactCanonicalSignerSetBytes: material.signerSetBytes,
		genesisAnchorDigest: material.anchorDigest,
		kind: contract.trustStateKind,
		objectId: material.anchor.objectId,
		profileId: material.profile.profileId,
		quorum: material.profile.quorum,
		signerCount: material.signers.length,
		version: contract.trustStateVersion,
	});
}

/**
 * Authors the exact maximum-expansion object id admitted by Phase 3b.
 * @returns A syntactically valid 1024-byte object id.
 */
export function maximumObjectId(): string {
	return `${"x".repeat(991)}:${"a".repeat(32)}`;
}

export { contract };

import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical } from "@ts-drp/canonical";
import { createHash } from "node:crypto";

import contract from "./anchor-trust-contract.json" with { type: "json" };

const encoder = new TextEncoder();

export interface CreatorMaterial {
	readonly anchor: Readonly<Record<string, unknown>>;
	readonly anchorDigest: string;
	readonly anchorBytes: Uint8Array;
	readonly profile: Readonly<Record<string, unknown>>;
	readonly profileBytes: Uint8Array;
	readonly signature: Uint8Array;
	readonly signerSet: readonly Readonly<Record<string, unknown>>[];
	readonly signerSetBytes: Uint8Array;
}

export interface CreatorMaterialOptions {
	readonly objectId?: string;
	readonly privateKeySeedHex?: string;
	readonly profileId?: string;
	readonly profileQuorum?: number;
	readonly profileSigners?: readonly Readonly<Record<string, unknown>>[];
	readonly signerSet?: readonly Readonly<Record<string, unknown>>[];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
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
 * Independently frames and hashes a registered domain.
 * @param domain - Registered domain string.
 * @param parts - Exact byte parts.
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
 * Converts bytes to lowercase hexadecimal.
 * @param bytes - Exact input bytes.
 * @returns Lowercase hexadecimal.
 */
export function bytesHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Converts even-length hexadecimal to bytes.
 * @param value - Lowercase hexadecimal.
 * @returns Detached bytes.
 */
export function hexBytes(value: string): Uint8Array {
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * Authors one deterministic, valid creator genesis tuple.
 * @param options - Exact seed and independently authored carrier overrides.
 * @returns Independently authored material.
 */
export function makeCreatorMaterial(options: string | CreatorMaterialOptions = {}): CreatorMaterial {
	const normalized = typeof options === "string" ? { privateKeySeedHex: options } : options;
	const privateKey = hexBytes(normalized.privateKeySeedHex ?? contract.privateKeySeedHex);
	const publicKeyHex = bytesHex(ed25519.getPublicKey(privateKey));
	const signerSet = normalized.signerSet ?? [{ publicKey: publicKeyHex, signerId: contract.signerId }];
	const signerSetBytes = encodeCanonical(signerSet);
	const profile = {
		cryptoSuiteId: contract.cryptoSuiteId,
		profileId: normalized.profileId ?? contract.profileId,
		quorum: normalized.profileQuorum ?? 1,
		signers: normalized.profileSigners ?? signerSet,
	};
	const profileBytes = encodeCanonical(profile);
	const anchor = {
		aclDigest: "2".repeat(64),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest: contract.blueprintDigest,
		cryptoSuiteId: contract.cryptoSuiteId,
		cutDigest: contract.zeroDigest,
		epoch: 0,
		historyRoot: "5".repeat(64),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId: normalized.objectId ?? contract.objectId,
		parametersDigest: contract.parametersDigest,
		previousAnchor: contract.zeroDigest,
		profileDigest: bytesHex(independentHashDomain(contract.profileDigestDomain, profileBytes)),
		protocolMajor: 3,
		signerSetDigest: bytesHex(independentHashDomain(contract.signerSetDigestDomain, signerSetBytes)),
		stateDigest: "7".repeat(64),
	};
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = bytesHex(independentHashDomain(contract.anchorDigestDomain, anchorBytes));
	return {
		anchor,
		anchorBytes,
		anchorDigest,
		profile,
		profileBytes,
		signature: ed25519.sign(hexBytes(anchorDigest), privateKey),
		signerSet,
		signerSetBytes,
	};
}

/**
 * Authors one exact twelve-field local trust record.
 * @param material - Valid creator genesis material.
 * @param version - Local record version.
 * @returns Canonical record bytes.
 */
export function makeTrustStateRecord(material = makeCreatorMaterial(), version = 1): Uint8Array {
	return encodeCanonical({
		currentAnchorDigest: material.anchorDigest,
		currentEpoch: 0,
		detachedCurrentAnchorSignature: material.signature,
		exactCanonicalCurrentAnchorPreimageBytes: material.anchorBytes,
		exactCanonicalProfileBytes: material.profileBytes,
		exactCanonicalSignerSetBytes: material.signerSetBytes,
		genesisAnchorDigest: material.anchorDigest,
		kind: "drp-anchor-trust-state",
		objectId: material.anchor.objectId,
		profileId: contract.profileId,
		quorum: 1,
		version,
	});
}

export { contract };

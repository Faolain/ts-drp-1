import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical } from "@ts-drp/canonical";

import {
	contract as anchorContract,
	bytesHex,
	type CreatorMaterial,
	hexBytes,
	independentHashDomain,
	makeCreatorMaterial,
} from "../phase-3a0-v3/controlled-anchor-trust.js";

export const AUTHORIZATION_DOMAIN = "ts-drp/author-authorization/v3";
export const AUTHORIZATION_KIND = "drp-author-authorization";
export const AUTHORIZATION_PROFILE = "creator-author-authorization-v1";
export const AUTHORIZATION_MAX_BYTES = 8192;
export const PRIVATE_KEY = hexBytes(anchorContract.privateKeySeedHex);
export const AUTHOR = bytesHex(ed25519.getPublicKey(PRIVATE_KEY));

export interface AuthorizationCarrier {
	readonly authors: readonly string[];
	readonly epoch: number;
	readonly kind: string;
	readonly objectId: string;
	readonly profileId: string;
	readonly protocolMajor: number;
	readonly version: number;
}

export interface AuthorizationCreatorMaterial extends CreatorMaterial {
	readonly aclDigest: string;
}

/**
 *
 * @param overrides
 */
export function makeCarrier(overrides: Partial<AuthorizationCarrier> = {}): AuthorizationCarrier {
	return {
		authors: [AUTHOR],
		epoch: 0,
		kind: AUTHORIZATION_KIND,
		objectId: anchorContract.objectId,
		profileId: AUTHORIZATION_PROFILE,
		protocolMajor: 3,
		version: 1,
		...overrides,
	};
}

/**
 *
 * @param carrier
 */
export function canonicalCarrierBytes(carrier: AuthorizationCarrier = makeCarrier()): Uint8Array {
	return encodeCanonical(carrier);
}

/**
 *
 * @param bytes
 */
export function authorizationDigest(bytes: Uint8Array): string {
	return bytesHex(independentHashDomain(AUTHORIZATION_DOMAIN, bytes));
}

/**
 *
 * @param options
 * @param options.aclDigest
 * @param options.carrier
 */
export function makeAuthorizationCreatorMaterial(
	options: {
		readonly aclDigest?: string;
		readonly carrier?: AuthorizationCarrier;
	} = {}
): AuthorizationCreatorMaterial {
	const base = makeCreatorMaterial();
	const aclDigest = options.aclDigest ?? authorizationDigest(canonicalCarrierBytes(options.carrier));
	const anchor = { ...base.anchor, aclDigest };
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = bytesHex(independentHashDomain(anchorContract.anchorDigestDomain, anchorBytes));
	return {
		...base,
		aclDigest,
		anchor,
		anchorBytes,
		anchorDigest,
		signature: ed25519.sign(hexBytes(anchorDigest), PRIVATE_KEY),
	};
}

/**
 *
 * @param material
 */
export function installInput(material: AuthorizationCreatorMaterial): Readonly<Record<string, unknown>> {
	return {
		detachedGenesisSignature: new Uint8Array(material.signature),
		exactCanonicalGenesisAnchorPreimageBytes: new Uint8Array(material.anchorBytes),
		exactCanonicalProfileBytes: new Uint8Array(material.profileBytes),
		exactCanonicalSignerSetBytes: new Uint8Array(material.signerSetBytes),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	};
}

export { anchorContract };

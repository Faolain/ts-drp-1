import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

const RAW_CODEC = 0x55;
const NETWORK_ID_PATTERN = /^[A-Za-z0-9_-]{22,86}$/u;

export const PEER_NAMESPACE_PREFIX = "drp-network:v1:";
export const RELAY_NAMESPACE_PREFIX = "drp-relays:v1:";

/**
 * Builds the peer-rendezvous namespace for one opaque network identifier.
 * @param networkId - Opaque 22..86-character base64url network identifier.
 * @returns The versioned peer-rendezvous namespace.
 */
export function peerNamespace(networkId: string): string {
	return `${PEER_NAMESPACE_PREFIX}${validateNetworkId(networkId)}`;
}

/**
 * Builds the relay-service namespace for one opaque network identifier.
 * @param networkId - Opaque 22..86-character base64url network identifier.
 * @returns The versioned relay-service namespace.
 */
export function relayNamespace(networkId: string): string {
	return `${RELAY_NAMESPACE_PREFIX}${validateNetworkId(networkId)}`;
}

/**
 * Derives the deterministic relay-service CID for one network identifier.
 * @param networkId - Opaque 22..86-character base64url network identifier.
 * @returns The CIDv1 raw-codec SHA-256 identifier for the relay namespace.
 */
export async function relayNamespaceCid(networkId: string): Promise<CID> {
	return namespaceCid(relayNamespace(networkId));
}

/**
 * Derives a deterministic raw-codec CID without publishing the namespace text.
 * @param namespace - Namespace text containing 1..256 characters after trimming.
 * @returns The CIDv1 raw-codec SHA-256 identifier for the namespace.
 */
export async function namespaceCid(namespace: string): Promise<CID> {
	const value = namespace.trim();
	if (value.length < 1 || value.length > 256) throw new Error("namespace must contain 1..256 characters");
	return CID.createV1(RAW_CODEC, await sha256.digest(new TextEncoder().encode(value)));
}

function validateNetworkId(networkId: string): string {
	if (!NETWORK_ID_PATTERN.test(networkId)) {
		throw new Error("networkId must contain 22..86 base64url characters");
	}
	return networkId;
}

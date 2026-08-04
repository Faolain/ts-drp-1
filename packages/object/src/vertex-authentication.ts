import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { sha256 } from "@noble/hashes/sha2";
import { Signature } from "@noble/secp256k1";
import { type Vertex } from "@ts-drp/types";

import { detachStatePayload } from "./state-payload.js";

declare const authenticatedVertexBrand: unique symbol;

/** A detached vertex whose signature recovered to its claimed author. */
export type AuthenticatedVertex = Vertex & { readonly [authenticatedVertexBrand]: true };

export interface VertexAuthenticationResult {
	readonly authenticated: AuthenticatedVertex[];
	readonly invalid: string[];
	readonly offeredHashes: string[];
}

const authenticatedSnapshots = new WeakMap<object, AuthenticatedVertex>();

function snapshotVertex(vertex: Vertex, hash: string): Vertex {
	const peerId = vertex.peerId;
	const operation = detachStatePayload(vertex.operation);
	const dependencies = [...vertex.dependencies];
	const timestamp = vertex.timestamp;
	const signature = new Uint8Array(vertex.signature);
	return { hash, peerId, operation, dependencies, timestamp, signature };
}

function verifySnapshot(vertex: Vertex): boolean {
	if (vertex.signature.length === 0) return false;
	try {
		const hashData = sha256.create().update(vertex.hash).digest();
		const recovery = vertex.signature[0];
		const compactSignature = vertex.signature.slice(1);
		const signature = Signature.fromCompact(compactSignature).addRecoveryBit(recovery);
		const publicKey = publicKeyFromRaw(signature.recoverPublicKey(hashData).toRawBytes(true));
		return peerIdFromPublicKey(publicKey).toString() === vertex.peerId;
	} catch {
		return false;
	}
}

function issueAuthenticatedVertex(snapshot: Vertex): AuthenticatedVertex {
	const canonical = snapshot as AuthenticatedVertex;
	const handle = snapshotVertex(snapshot, snapshot.hash) as AuthenticatedVertex;
	authenticatedSnapshots.set(canonical, canonical);
	authenticatedSnapshots.set(handle, canonical);
	return handle;
}

/**
 * Stabilize and authenticate raw remotely supplied vertices.
 * Invalid offers are omitted; callers that need classification use
 * `classifyAuthenticatedVertices`.
 * @param vertices - Raw remotely supplied vertices.
 * @returns Detached handles for vertices whose signatures match their claimed authors.
 */
export function authenticateVertices(vertices: Vertex[]): AuthenticatedVertex[] {
	return classifyAuthenticatedVertices(vertices).authenticated;
}

/**
 * Authenticate a batch while preserving invalid input order.
 * @param vertices - Raw remotely supplied vertices.
 * @returns Authenticated handles, invalid hashes, and offered hashes.
 */
export function classifyAuthenticatedVertices(vertices: Vertex[]): VertexAuthenticationResult {
	return classifyNovelVertices(vertices, () => false);
}

/**
 * Authenticate only novel hashes. The hash is read exactly once, allowing the
 * object boundary to skip root/already-known offers without touching the rest
 * of a potentially hostile submitted object.
 * @param vertices - Raw remotely supplied vertices.
 * @param isTrustedHash - Whether a hash belongs to a root or already-known vertex.
 * @returns Authenticated handles, invalid hashes, and offered hashes.
 */
export function classifyNovelVertices(
	vertices: Vertex[],
	isTrustedHash: (hash: string) => boolean
): VertexAuthenticationResult {
	const authenticated: AuthenticatedVertex[] = [];
	const invalid: string[] = [];
	const offeredHashes: string[] = [];
	for (const submitted of vertices) {
		let hash: string;
		try {
			hash = submitted.hash;
		} catch {
			invalid.push("<unreadable-vertex>");
			offeredHashes.push("<unreadable-vertex>");
			continue;
		}
		offeredHashes.push(hash);
		if (isTrustedHash(hash)) continue;
		let snapshot: Vertex;
		try {
			snapshot = snapshotVertex(submitted, hash);
		} catch {
			invalid.push(hash);
			continue;
		}
		if (!verifySnapshot(snapshot)) {
			invalid.push(snapshot.hash);
			continue;
		}
		authenticated.push(issueAuthenticatedVertex(snapshot));
	}
	return { authenticated, invalid, offeredHashes };
}

/**
 * Runtime companion to the nominal internal brand.
 * @param vertex - Candidate authenticated handle.
 * @returns Whether the handle was issued by this module.
 */
export function hasAuthenticatedVertexProvenance(vertex: Vertex): boolean {
	return authenticatedSnapshots.has(vertex);
}

/**
 * Resolve the verifier-owned canonical snapshot bound to a public handle.
 * @param vertex - Verifier-issued public handle.
 * @returns Its verifier-owned canonical snapshot, if provenance remains valid.
 */
export function resolveAuthenticatedVertex(vertex: AuthenticatedVertex): AuthenticatedVertex | undefined {
	return authenticatedSnapshots.get(vertex);
}

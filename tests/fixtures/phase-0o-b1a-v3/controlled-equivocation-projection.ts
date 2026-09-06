import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import {
	type EquivocationScope,
	type PersistedEquivocationProof,
	type PersistedVertexWitness,
	type RawEd25519PublicKey,
	verifyEquivocationProof,
	verifyReceivedVertex,
} from "../../../packages/protocol-v3/src/index.js";

export interface MaterializeCurrentEquivocationProofInput {
	readonly scope: EquivocationScope;
	readonly vertices: readonly [PersistedVertexWitness, PersistedVertexWitness];
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
}

type Mutant =
	| "pair-order"
	| "wrong-domain"
	| "trusted-id"
	| "stale-carrier"
	| "skipped-authentication"
	| "wrong-scope-digest";

const PROOF_DOMAIN = "ts-drp/equivocation-proof/v1";
const PROFILE_ID = "equivocation-digest-identity-v1";
const PROOF_KIND = "drp-equivocation-proof";
const mutant = process.env.PHASE_0O_B1A_MUTANT as Mutant | undefined;
const staleProofs = new Map<string, PersistedEquivocationProof>();

function bytesToHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function detachVertex(value: unknown): PersistedVertexWitness | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const candidate = value as Partial<PersistedVertexWitness>;
	const capturedDigest = candidate.digest;
	if (!(capturedDigest instanceof Uint8Array) || capturedDigest.byteLength !== 32) return undefined;
	const digest = new Uint8Array(capturedDigest);
	const witness = candidate.witness;
	if (witness === undefined || typeof witness !== "object") return undefined;
	const domain = witness.domain;
	const expectedAnchor = witness.expectedAnchor;
	const capturedPreimageBytes = witness.receivedCanonicalPreimageBytes;
	if (!(capturedPreimageBytes instanceof Uint8Array)) return undefined;
	const receivedCanonicalPreimageBytes = new Uint8Array(capturedPreimageBytes);
	const capturedSignature = witness.signature;
	if (!(capturedSignature instanceof Uint8Array) || capturedSignature.byteLength !== 64) return undefined;
	const signature = new Uint8Array(capturedSignature);
	const suiteId = witness.suiteId;
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

function canonicalProofId(leftDigest: Uint8Array, rightDigest: Uint8Array, enableMutant: boolean): string {
	if (
		!(leftDigest instanceof Uint8Array) ||
		!(rightDigest instanceof Uint8Array) ||
		leftDigest.byteLength !== 32 ||
		rightDigest.byteLength !== 32
	) {
		throw new TypeError("equivocation proof digests must each be 32 bytes");
	}
	const left = new Uint8Array(leftDigest);
	const right = new Uint8Array(rightDigest);
	if (compareBytes(left, right) === 0) throw new TypeError("equivocation proof digests must be distinct");
	const ordered =
		(enableMutant && mutant === "pair-order") || compareBytes(left, right) < 0
			? ([left, right] as const)
			: ([right, left] as const);
	const domain = enableMutant && mutant === "wrong-domain" ? "ts-drp/equivocation-proof/v0" : PROOF_DOMAIN;
	return bytesToHex(hashDomain(domain, ordered[0], ordered[1]));
}

/**
 * Derives the frozen unordered-pair proof identity.
 * @param leftDigest - First registered digest.
 * @param rightDigest - Second registered digest.
 * @returns The lowercase hexadecimal proof identity.
 */
export function deriveEquivocationProofId(leftDigest: Uint8Array, rightDigest: Uint8Array): string {
	return canonicalProofId(leftDigest, rightDigest, true);
}

/**
 * Reconstructs the current canonical proof from detached authenticated witnesses.
 * @param input - Current scope, witnesses and authoritative resolver.
 * @returns The canonical proof or undefined when validation fails.
 */
export function materializeCurrentEquivocationProof(
	input: MaterializeCurrentEquivocationProofInput
): PersistedEquivocationProof | undefined {
	try {
		if (input === null || typeof input !== "object") return undefined;
		const capturedScope = input.scope;
		const capturedVertices = input.vertices;
		const capturedResolver = input.resolveAuthorPublicKey;
		if (capturedScope === null || typeof capturedScope !== "object") return undefined;
		const author = capturedScope.author;
		const authorSequence = capturedScope.authorSequence;
		const objectId = capturedScope.objectId;
		if (
			typeof author !== "string" ||
			typeof objectId !== "string" ||
			!Number.isSafeInteger(authorSequence) ||
			!Array.isArray(capturedVertices) ||
			capturedVertices.length !== 2 ||
			typeof capturedResolver !== "function"
		) {
			return undefined;
		}
		const scope: EquivocationScope = {
			author,
			authorSequence,
			objectId,
		};
		const first = detachVertex(capturedVertices[0]);
		const second = detachVertex(capturedVertices[1]);
		if (first === undefined || second === undefined) return undefined;
		const vertices =
			compareBytes(first.digest, second.digest) < 0 ? ([first, second] as const) : ([second, first] as const);
		if (compareBytes(vertices[0].digest, vertices[1].digest) === 0) return undefined;

		const resolveAuthorPublicKey = capturedResolver.bind(input);
		if (mutant !== "skipped-authentication") {
			for (const vertex of vertices) {
				const verified = verifyReceivedVertex({
					...vertex.witness,
					resolveAuthorPublicKey,
				});
				if (!verified.accepted || verified.digest === undefined || compareBytes(verified.digest, vertex.digest) !== 0) {
					return undefined;
				}
			}
		} else {
			for (const vertex of vertices) {
				if (vertex.witness.domain !== "ts-drp/vertex/v3" || vertex.witness.suiteId !== "ed25519-sha256-v3") {
					return undefined;
				}
				const digest = hashDomain(vertex.witness.domain, vertex.witness.receivedCanonicalPreimageBytes);
				if (compareBytes(digest, vertex.digest) !== 0) return undefined;
			}
		}
		if (mutant !== "wrong-scope-digest") {
			for (const vertex of vertices) {
				const preimage = decodeCanonical(vertex.witness.receivedCanonicalPreimageBytes) as Record<string, unknown>;
				if (
					preimage.author !== scope.author ||
					preimage.authorSequence !== scope.authorSequence ||
					preimage.objectId !== scope.objectId
				) {
					return undefined;
				}
			}
		}

		const canonicalProofBytes = encodeCanonical({
			kind: PROOF_KIND,
			profile: PROFILE_ID,
			protocolMajor: 3,
			slot: scope,
			vertices: vertices.map((vertex) => ({
				digest: vertex.digest,
				domain: vertex.witness.domain,
				expectedAnchor: vertex.witness.expectedAnchor,
				preimage: vertex.witness.receivedCanonicalPreimageBytes,
				signature: vertex.witness.signature,
				suiteId: vertex.witness.suiteId,
			})),
		});
		const callerProofId =
			mutant === "trusted-id"
				? (input as MaterializeCurrentEquivocationProofInput & { readonly proofId?: unknown }).proofId
				: undefined;
		const proofId =
			mutant === "trusted-id" && typeof callerProofId === "string"
				? callerProofId
				: canonicalProofId(vertices[0].digest, vertices[1].digest, false);
		const result = { canonicalProofBytes, proofId };
		if (mutant !== "skipped-authentication" && mutant !== "wrong-scope-digest") {
			const verification = verifyEquivocationProof({
				canonicalProofBytes,
				resolveAuthorPublicKey,
			});
			if (!verification.verified || verification.proofId !== proofId) return undefined;
		}
		if (mutant === "stale-carrier") {
			const stale = staleProofs.get(proofId);
			if (stale !== undefined) return structuredClone(stale);
			staleProofs.set(proofId, structuredClone(result));
		}
		return result;
	} catch {
		return undefined;
	}
}

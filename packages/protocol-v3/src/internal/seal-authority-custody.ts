export interface CertifiedSealAuthorityMaterial {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: 0;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly objectId: string;
	readonly quorum: number;
}

export interface CreatorAnchorTrustMaterial {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: number;
	readonly detachedCurrentAnchorSignature: Uint8Array;
	readonly exactCanonicalCurrentAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProfileBytes: Uint8Array;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly genesisAnchorDigest: string;
	readonly objectId: string;
	readonly publicKey: Uint8Array;
	readonly quorum: 1;
}

export interface CreatorAnchorSigningRequest {
	readonly __creatorAnchorSigningRequest?: never;
}

export const certifiedSealAuthorityResolver: unique symbol = Symbol("certifiedSealAuthorityResolver");
export const creatorAnchorTrustCheckpointPredecessorMinter: unique symbol = Symbol(
	"creatorAnchorTrustCheckpointPredecessorMinter"
);
export const creatorAnchorTrustResolver: unique symbol = Symbol("creatorAnchorTrustResolver");
export const creatorAnchorTrustSuccessorMinter: unique symbol = Symbol("creatorAnchorTrustSuccessorMinter");

type SealAuthorityResolver = (trust: CertifiedAnchorTrust) => CertifiedSealAuthorityMaterial | undefined;

let singletonResolver: SealAuthorityResolver | undefined;

type CreatorAnchorTrustResolver = (trust: CurrentAnchorTrust) => CreatorAnchorTrustMaterial | undefined;
type CreatorAnchorTrustSuccessorMinter = (
	currentTrust: CurrentAnchorTrust,
	exactCanonicalSuccessorAnchorPreimageBytes: Uint8Array,
	detachedSuccessorAnchorSignature: Uint8Array
) => CurrentAnchorTrust | undefined;
type CreatorAnchorTrustCheckpointPredecessorMinter = CreatorAnchorTrustSuccessorMinter;

let creatorResolver: CreatorAnchorTrustResolver | undefined;
let creatorCheckpointPredecessorMinter: CreatorAnchorTrustCheckpointPredecessorMinter | undefined;
let creatorSuccessorMinter: CreatorAnchorTrustSuccessorMinter | undefined;
const creatorAnchorRequestDigests = new WeakMap<CreatorAnchorSigningRequest, Uint8Array>();

/**
 * Installs the one resolver owned by the public anchor-trust singleton.
 * @param resolver - Resolver bound to the singleton's private WeakMap.
 */
export function installCertifiedSealAuthorityResolver(resolver: SealAuthorityResolver): void {
	if (singletonResolver !== undefined) throw new Error("certified seal authority resolver already installed");
	singletonResolver = resolver;
}

/**
 * Resolves seal material only through the installed singleton custody.
 * @param trust - Candidate certified trust capability.
 * @returns Detached epoch-zero material or undefined for foreign custody.
 */
export function resolveCertifiedSealAuthorityMaterial(
	trust: CertifiedAnchorTrust
): CertifiedSealAuthorityMaterial | undefined {
	return singletonResolver?.(trust);
}

/**
 * Installs creator-trust resolution and successor minting from the singleton registry.
 * @param resolver - Resolver bound to the singleton creator-trust WeakMap.
 * @param checkpointPredecessorMinter - Bounded checkpoint predecessor mint bound to the same WeakMap.
 * @param successorMinter - Successor mint bound to the same private WeakMap.
 */
export function installCreatorAnchorTrustCustody(
	resolver: CreatorAnchorTrustResolver,
	checkpointPredecessorMinter: CreatorAnchorTrustCheckpointPredecessorMinter,
	successorMinter: CreatorAnchorTrustSuccessorMinter
): void {
	if (
		creatorResolver !== undefined ||
		creatorCheckpointPredecessorMinter !== undefined ||
		creatorSuccessorMinter !== undefined
	) {
		throw new Error("creator anchor trust custody already installed");
	}
	creatorResolver = resolver;
	creatorCheckpointPredecessorMinter = checkpointPredecessorMinter;
	creatorSuccessorMinter = successorMinter;
}

/**
 * Resolves genuine creator trust through the singleton's private WeakMap.
 * @param trust - Candidate current creator trust.
 * @returns Detached immutable material, or undefined for foreign custody.
 */
export function resolveCreatorAnchorTrustMaterial(trust: CurrentAnchorTrust): CreatorAnchorTrustMaterial | undefined {
	return creatorResolver?.(trust);
}

/**
 * Mints a verified successor into the singleton's private creator-trust registry.
 * @param currentTrust - Genuine current creator-trust capability.
 * @param exactCanonicalSuccessorAnchorPreimageBytes - Exact verified successor-anchor preimage.
 * @param detachedSuccessorAnchorSignature - Exact creator signature over the successor digest.
 * @returns A new singleton creator-trust capability, or undefined for invalid custody.
 */
export function mintCreatorAnchorTrustSuccessor(
	currentTrust: CurrentAnchorTrust,
	exactCanonicalSuccessorAnchorPreimageBytes: Uint8Array,
	detachedSuccessorAnchorSignature: Uint8Array
): CurrentAnchorTrust | undefined {
	return creatorSuccessorMinter?.(
		currentTrust,
		exactCanonicalSuccessorAnchorPreimageBytes,
		detachedSuccessorAnchorSignature
	);
}

/**
 * Mints an already-authenticated checkpoint predecessor through singleton custody.
 * @param genesisTrust - Genuine creator genesis capability whose fixed carriers are inherited.
 * @param exactCanonicalPredecessorAnchorPreimageBytes - Exact verified predecessor-anchor preimage.
 * @param detachedPredecessorAnchorSignature - Exact creator signature over the predecessor digest.
 * @returns A checkpoint-local predecessor capability, or undefined for invalid/uninstalled custody.
 */
export function mintCreatorAnchorTrustCheckpointPredecessor(
	genesisTrust: CurrentAnchorTrust,
	exactCanonicalPredecessorAnchorPreimageBytes: Uint8Array,
	detachedPredecessorAnchorSignature: Uint8Array
): CurrentAnchorTrust | undefined {
	return creatorCheckpointPredecessorMinter?.(
		genesisTrust,
		exactCanonicalPredecessorAnchorPreimageBytes,
		detachedPredecessorAnchorSignature
	);
}

/**
 * Mints one creator-anchor request only after creator-close validates the full tuple.
 * @param digest - Exact registered epoch-anchor digest.
 * @returns Fieldless destructive-use signing request.
 */
export function mintCreatorAnchorSigningRequest(digest: Uint8Array): CreatorAnchorSigningRequest {
	const request = Object.freeze({}) as CreatorAnchorSigningRequest;
	creatorAnchorRequestDigests.set(request, Uint8Array.from(digest));
	return request;
}

/**
 * Destructively resolves one protocol-authored creator-anchor request.
 * @param request - Candidate fieldless signing request.
 * @returns Detached anchor digest, or undefined for foreign/already-consumed input.
 */
export function consumeCreatorAnchorSigningRequestDigest(request: unknown): Uint8Array | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const digest = creatorAnchorRequestDigests.get(request as CreatorAnchorSigningRequest);
	if (digest === undefined) return undefined;
	creatorAnchorRequestDigests.delete(request as CreatorAnchorSigningRequest);
	return Uint8Array.from(digest);
}
import type { CertifiedAnchorTrust, CurrentAnchorTrust } from "../index.js";

export interface CertifiedSealAuthorityMaterial {
	readonly currentAnchorDigest: string;
	readonly currentEpoch: 0;
	readonly exactCanonicalSignerSetBytes: Uint8Array;
	readonly objectId: string;
	readonly quorum: number;
}

export const certifiedSealAuthorityResolver: unique symbol = Symbol("certifiedSealAuthorityResolver");

type SealAuthorityResolver = (trust: CertifiedAnchorTrust) => CertifiedSealAuthorityMaterial | undefined;

let singletonResolver: SealAuthorityResolver | undefined;

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
import type { CertifiedAnchorTrust } from "../index.js";

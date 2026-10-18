import type { V3CreatorCloseRegistration } from "../creator-close.js";
type CreatorRecipientRegistration = Omit<
	V3CreatorCloseRegistration,
	| "abortSnapshotStage"
	| "captureCloseGraph"
	| "stageSnapshot"
	| "terminalize"
	| "previousHistorySnapshot"
	| "maxEpochBytes"
	| "maxEpochVertices"
>;

// This kernel reads the genuine live registry without claiming a finality signer or local close.
let resolver: ((plane: object) => CreatorRecipientRegistration | undefined) | undefined;
/**
 * Installs the one genuine live-registry resolver; callers cannot grant recipient provenance.
 * @param owner The live owner's private registry lookup.
 * @returns Whether this was the unique resolver installation.
 */
export function installCreatorRecipientResolver(
	owner: (plane: object) => CreatorRecipientRegistration | undefined
): boolean {
	if (resolver !== undefined) return false;
	resolver = owner;
	return true;
}
/**
 * Resolves only an existing genuine live plane, without claiming local close authority.
 * @param plane The actual recipient live plane identity.
 * @returns Its native registration, or undefined for copied/foreign identities.
 */
export function resolveCreatorRecipientRegistration(plane: object): CreatorRecipientRegistration | undefined {
	return resolver?.(plane);
}

export interface SealAuthorityIdentity {
	readonly anchor: string;
	readonly epoch: 0;
	readonly objectId: string;
	readonly signerId: string;
}

const identities = new WeakMap<object, SealAuthorityIdentity>();

/**
 * Registers the detached identity of one genuine seal authority.
 * @param authority - Genuine protocol-owned authority.
 * @param identity - Detached certified identity.
 */
export function registerSealAuthorityIdentity(authority: object, identity: SealAuthorityIdentity): void {
	identities.set(authority, Object.freeze({ ...identity }));
}

/**
 * Resolves a genuine authority to detached voter-enrollment identity.
 * @param authority - Candidate authority.
 * @returns Detached identity, or undefined for foreign custody.
 */
export function resolveSealAuthorityIdentity(authority: unknown): SealAuthorityIdentity | undefined {
	if (authority === null || typeof authority !== "object") return undefined;
	const identity = identities.get(authority);
	return identity === undefined ? undefined : Object.freeze({ ...identity });
}

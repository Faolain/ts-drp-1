/** Private one-use claim over one authenticated recovered v3 live payload. */
export type RecoveredV3LiveAuthorityClaim = Readonly<Record<never, never>>;

const recoveredAuthorities = new WeakMap<object, unknown>();
const recoveredClaims = new WeakMap<RecoveredV3LiveAuthorityClaim, unknown>();

function objectIdentity(value: unknown): object | undefined {
	return (typeof value === "object" && value !== null) || typeof value === "function" ? value : undefined;
}

/** Installs one freshly recovered payload behind its frozen public capability. */
export function installRecoveredV3LiveAuthority(capability: object, payload: unknown): void {
	recoveredAuthorities.set(capability, payload);
}

/** Consumes one recovered capability directly through the existing activation path. */
export function consumeRecoveredV3LiveAuthority<Payload>(capability: unknown): Payload | undefined {
	try {
		const identity = objectIdentity(capability);
		if (identity === undefined || !recoveredAuthorities.has(identity)) return undefined;
		const payload = recoveredAuthorities.get(identity) as Payload;
		recoveredAuthorities.delete(identity);
		return payload;
	} catch {
		return undefined;
	}
}

/** Moves one recovered capability into an opaque transfer-owned claim before any await. */
export function claimRecoveredV3LiveAuthority(capability: unknown): RecoveredV3LiveAuthorityClaim | undefined {
	const payload = consumeRecoveredV3LiveAuthority<unknown>(capability);
	if (payload === undefined) return undefined;
	const claim: RecoveredV3LiveAuthorityClaim = Object.freeze({});
	recoveredClaims.set(claim, payload);
	return claim;
}

/** Restores a claimed payload behind a fresh private capability for the existing D.100 activation owner. */
export function restoreRecoveredV3LiveAuthority(claim: RecoveredV3LiveAuthorityClaim): object | undefined {
	try {
		if (!recoveredClaims.has(claim)) return undefined;
		const payload = recoveredClaims.get(claim);
		recoveredClaims.delete(claim);
		const capability = Object.freeze({});
		recoveredAuthorities.set(capability, payload);
		return capability;
	} catch {
		return undefined;
	}
}

/** Irrevocably drops an unactivated transfer claim. */
export function discardRecoveredV3LiveAuthorityClaim(claim: RecoveredV3LiveAuthorityClaim): void {
	recoveredClaims.delete(claim);
}

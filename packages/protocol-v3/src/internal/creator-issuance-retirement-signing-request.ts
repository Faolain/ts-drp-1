import type { CurrentAnchorTrust } from "../index.js";
import { openSealAuthority, verifySealQC } from "../seal.js";
import { resolveCreatorAnchorTrustMaterial } from "./seal-authority-custody.js";
import { resolveSealAuthorityIdentity } from "./seal-authority-identity.js";
import {
	type CapturedSigningRequest,
	captureSigningRequestScope,
	type SigningNativeAdmissionFactory,
	type SigningRequestScope,
} from "./seal-signing-request.js";

/** Opaque one-use request for a protocol-authored issuance-retirement digest. */
export interface CreatorIssuanceRetirementSigningRequest {
	readonly __creatorIssuanceRetirementSigningRequest?: never;
}

const requestDigests = new WeakMap<CreatorIssuanceRetirementSigningRequest, CapturedSigningRequest>();

/**
 * Mints one fieldless request after the protocol validates the complete record preimage.
 * @param digest - Exact domain-separated retirement-record digest.
 * @returns One-use signing request.
 */
export function mintCreatorIssuanceRetirementSigningRequest(
	digest: Uint8Array
): CreatorIssuanceRetirementSigningRequest {
	const request = Object.freeze({}) as CreatorIssuanceRetirementSigningRequest;
	requestDigests.set(request, { digest: Uint8Array.from(digest), scope: undefined, admission: undefined });
	return request;
}

/**
 * Scope comes from the original authenticated current creator and verified closing QC.
 * @param input - Genuine current trust and exact closing Commit QC.
 * @returns Verified current identity and detached closing signing scope.
 */
export function captureCreatorIssuanceRetirementSigningContext(
	input: Readonly<{
		currentTrust: CurrentAnchorTrust;
		exactCanonicalCommitQcBytes: Uint8Array;
		valueDigest: string;
	}>
): Readonly<{
	identity: Readonly<{ anchor: string; epoch: number; objectId: string; signerId: string }>;
	scope: SigningRequestScope;
}> {
	const material = resolveCreatorAnchorTrustMaterial(input.currentTrust);
	if (material === undefined) throw new TypeError("UNTRUSTED_RETIREMENT_SIGNING_CONTEXT");
	const authority = openSealAuthority({ trust: input.currentTrust, signerPublicKey: material.publicKey });
	if (!authority.ok) throw new TypeError("UNTRUSTED_RETIREMENT_SIGNING_CONTEXT");
	const identity = resolveSealAuthorityIdentity(authority.authority);
	const qc = verifySealQC({ authority: authority.authority, exactCanonicalQcBytes: input.exactCanonicalCommitQcBytes });
	if (identity === undefined || !qc.ok || qc.phase !== "commit" || qc.valueDigest !== input.valueDigest)
		throw new TypeError("UNTRUSTED_RETIREMENT_SIGNING_CONTEXT");
	return Object.freeze({
		identity,
		scope: captureSigningRequestScope({
			objectId: identity.objectId,
			epoch: identity.epoch,
			round: qc.round,
			signerId: identity.signerId,
			publicKey: material.publicKey,
		}),
	});
}

/**
 * Original verified close/QC owner attaches the closing scope, never the successor age.
 * @param request - Genuine unscoped one-use request.
 * @param scope - Verified closing scope.
 */
export function scopeCreatorIssuanceRetirementSigningRequest(
	request: CreatorIssuanceRetirementSigningRequest,
	scope: SigningRequestScope
): void {
	const captured = requestDigests.get(request);
	if (captured === undefined || captured.scope !== undefined) throw new TypeError("UNTRUSTED_SIGNING_SCOPE_BINDING");
	requestDigests.set(request, { ...captured, scope: captureSigningRequestScope(scope) });
}

/**
 * Trusted original close owner binds its genuine native store/enrollment custody.
 * @param request - Genuine scoped one-use request.
 * @param admission - Original native store/enrollment admission factory.
 */
export function bindCreatorIssuanceRetirementSigningRequest(
	request: CreatorIssuanceRetirementSigningRequest,
	admission: SigningNativeAdmissionFactory
): void {
	const captured = requestDigests.get(request);
	if (captured?.scope === undefined || captured.admission !== undefined || typeof admission !== "function")
		throw new TypeError("UNTRUSTED_SIGNING_ADMISSION_BINDING");
	requestDigests.set(request, { ...captured, admission });
}

/**
 * Destructively resolves one genuine protocol-authored signing request.
 * @param request - Candidate opaque request.
 * @returns Detached digest and native signing custody, or undefined for foreign or consumed requests.
 */
export function consumeCreatorIssuanceRetirementSigningRequest(request: unknown): CapturedSigningRequest | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const captured = requestDigests.get(request as CreatorIssuanceRetirementSigningRequest);
	if (captured === undefined) return undefined;
	requestDigests.delete(request as CreatorIssuanceRetirementSigningRequest);
	return Object.freeze({
		...captured,
		digest: Uint8Array.from(captured.digest),
		scope: captured.scope === undefined ? undefined : captureSigningRequestScope(captured.scope),
	});
}

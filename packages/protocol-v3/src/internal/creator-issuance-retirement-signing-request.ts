/** Opaque one-use request for a protocol-authored issuance-retirement digest. */
export interface CreatorIssuanceRetirementSigningRequest {
	readonly __creatorIssuanceRetirementSigningRequest?: never;
}

const requestDigests = new WeakMap<CreatorIssuanceRetirementSigningRequest, Uint8Array>();

/**
 * Mints one fieldless request after the protocol validates the complete record preimage.
 * @param digest - Exact domain-separated retirement-record digest.
 * @returns One-use signing request.
 */
export function mintCreatorIssuanceRetirementSigningRequest(
	digest: Uint8Array
): CreatorIssuanceRetirementSigningRequest {
	const request = Object.freeze({}) as CreatorIssuanceRetirementSigningRequest;
	requestDigests.set(request, Uint8Array.from(digest));
	return request;
}

/**
 * Destructively resolves one genuine protocol-authored signing request.
 * @param request - Candidate opaque request.
 * @returns Detached digest, or undefined for foreign or consumed requests.
 */
export function consumeCreatorIssuanceRetirementSigningRequest(request: unknown): Uint8Array | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const digest = requestDigests.get(request as CreatorIssuanceRetirementSigningRequest);
	if (digest === undefined) return undefined;
	requestDigests.delete(request as CreatorIssuanceRetirementSigningRequest);
	return Uint8Array.from(digest);
}

export interface SealSigningRequest {
	readonly __sealSigningRequest?: never;
}

const requestDigests = new WeakMap<SealSigningRequest, Uint8Array>();

/**
 * Mints a one-use request for the exact digest authored by the seal codec owner.
 * @param digest - Detached registered seal-vote digest.
 * @returns Fieldless signing authority consumed by finality custody.
 */
export function mintSealSigningRequest(digest: Uint8Array): SealSigningRequest {
	const request = Object.freeze({}) as SealSigningRequest;
	requestDigests.set(request, Uint8Array.from(digest));
	return request;
}

/**
 * Destructively resolves one protocol-authored seal signing request.
 * @param request - Candidate request.
 * @returns Detached digest, or undefined for foreign/already-consumed input.
 */
export function consumeSealSigningRequest(request: unknown): Uint8Array | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const digest = requestDigests.get(request as SealSigningRequest);
	if (digest === undefined) return undefined;
	requestDigests.delete(request as SealSigningRequest);
	return Uint8Array.from(digest);
}

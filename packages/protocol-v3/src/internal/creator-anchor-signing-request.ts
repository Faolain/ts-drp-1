import {
	consumeCreatorAnchorSigningRequestDigest,
	type CreatorAnchorSigningRequest,
} from "./seal-authority-custody.js";

export type { CreatorAnchorSigningRequest } from "./seal-authority-custody.js";

/**
 * Destructively resolves one protocol-authored creator-anchor signing request.
 * @param request - Candidate fieldless signing request.
 * @returns Detached anchor digest, or undefined for foreign/already-consumed input.
 */
export function consumeCreatorAnchorSigningRequest(request: CreatorAnchorSigningRequest): Uint8Array | undefined {
	return consumeCreatorAnchorSigningRequestDigest(request);
}

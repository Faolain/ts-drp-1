import {
	consumeCreatorAnchorSigningRequestDigest,
	type CreatorAnchorSigningRequest,
} from "./seal-authority-custody.js";

export type { CreatorAnchorSigningRequest } from "./seal-authority-custody.js";
export { bindCreatorAnchorSigningRequest } from "./seal-authority-custody.js";
import type { CapturedSigningRequest } from "./seal-signing-request.js";

/**
 * Destructively resolves one protocol-authored creator-anchor signing request.
 * @param request - Candidate fieldless signing request.
 * @returns Detached anchor digest, or undefined for foreign/already-consumed input.
 */
export function consumeCreatorAnchorSigningRequest(
	request: CreatorAnchorSigningRequest
): CapturedSigningRequest | undefined {
	return consumeCreatorAnchorSigningRequestDigest(request);
}

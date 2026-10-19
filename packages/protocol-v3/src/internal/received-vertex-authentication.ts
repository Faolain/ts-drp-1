import { verifyEd25519 } from "./ed25519-verify.js";
import { decodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { CurrentAnchorTrust } from "../index.js";
import { mintCreatorAnchorTrustSourceContext, resolveCreatorAnchorTrustMaterial } from "./seal-authority-custody.js";

export { copyCanonicalForAdmittedView, digestReceivedVertexPreimage, openAuthorFenceOperation, vertexCanonicalBytes, verifyReceivedVertex } from "../index.js";

export type { RegisteredVertexVerification, VerifyReceivedVertexInput } from "../index.js";

/** Reads the original authenticated fixed creator identity; supplied signer functions grant nothing. */
export function resolveCreatorSettlementAuthor(trust: CurrentAnchorTrust): string | undefined {
	const creator = resolveCreatorAnchorTrustMaterial(trust);
	return creator === undefined ? undefined : Array.from(creator.publicKey, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Detached exact signed anchor from the genuine creator trust registry. */
export function readCreatorSettlementSourceAnchor(trust: CurrentAnchorTrust): Readonly<{anchorPreimage: Uint8Array; anchorSignature: Uint8Array}> | undefined {
	const creator = resolveCreatorAnchorTrustMaterial(trust);
	return creator === undefined ? undefined : {anchorPreimage: creator.exactCanonicalCurrentAnchorPreimageBytes,
		anchorSignature: creator.detachedCurrentAnchorSignature};
}

/** Exact source selection is current creator authorization, not evidence of past private timing. */
export function verifyCreatorSettlementSourceSelection(
	trust: CurrentAnchorTrust,
	exactCanonicalSelectionBytes: Uint8Array,
	signature: Uint8Array
): boolean {
	const creator = resolveCreatorAnchorTrustMaterial(trust);
	if (creator === undefined || signature.byteLength !== 64) return false;
	try {
		return verifyEd25519(signature, hashDomain("ts-drp/settlement-source-selection/v1", exactCanonicalSelectionBytes), creator.publicKey);
	} catch {
		return false;
	}
}

/** Source anchor opens only with the already authenticated fixed source creator/signer set. */
export function openCreatorSettlementSourceTrust(
	creatorTrust: CurrentAnchorTrust,
	anchorPreimage: Uint8Array,
	anchorSignature: Uint8Array,
	objectId: string,
	pinnedGenesisAnchorDigest: string
): CurrentAnchorTrust | undefined {
	const creator = resolveCreatorAnchorTrustMaterial(creatorTrust);
	if (creator === undefined) return undefined;
	try {
		const anchor = decodeCanonical(anchorPreimage) as Readonly<Record<string, unknown>>;
		const digest = Array.from(hashDomain("ts-drp/epoch-anchor/v3", anchorPreimage), b => b.toString(16).padStart(2, "0")).join("");
		if (creatorTrust.objectId !== objectId || creatorTrust.genesisAnchorDigest !== pinnedGenesisAnchorDigest ||
			anchor.objectId !== objectId) return undefined;
		const opened = mintCreatorAnchorTrustSourceContext(creatorTrust, anchorPreimage, anchorSignature);
		return opened?.currentAnchorDigest === digest ? opened : undefined;
	} catch { return undefined; }
}

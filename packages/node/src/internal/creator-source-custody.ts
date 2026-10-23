import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { isClosedDurableIssuanceRecord, type SettlementSourceContext } from "@ts-drp/issuance-store";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorSettlementSourceTrust, readCreatorSettlementSourceAnchor } from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import { openCanonicalLatchedAclSnapshot, type LatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";

const KIND = "creator-settlement-source-context-1";
const DOMAIN = "ts-drp/settlement-source-context/v1";
// Exact existing signed-anchor and settlement-ACL bounds, with canonical field overhead.
export const CREATOR_SOURCE_CONTEXT_MAX_BYTES = encodeCanonical({kind: KIND, version: 1,
	anchorPreimage: new Uint8Array(8192), anchorSignature: new Uint8Array(64), aclBytes: new Uint8Array(65536)}).byteLength;
const limits = {maxBytes: CREATOR_SOURCE_CONTEXT_MAX_BYTES, maxDepth: 2, maxItems: 32};

export interface VerifiedCreatorSourceCustody { readonly __verifiedCreatorSourceCustody?: never }
export interface CreatorSourceCustodyIdentity {
	readonly trust: CurrentAnchorTrust;
	readonly acl: LatchedAclSnapshot;
	readonly blueprintDigest: string;
	readonly context: SettlementSourceContext;
}
const verified = new WeakMap<object, CreatorSourceCustodyIdentity>();

/** Historical authority only: no inclusion, noninclusion, current Writer grant or native currency. */
export function openCreatorSourceCustody(input: Readonly<{
	currentTrust: CurrentAnchorTrust;
	context: SettlementSourceContext;
	expectedBlueprintDigest: string;
}>): VerifiedCreatorSourceCustody | undefined {
	try {
		const raw = input.context.exactCanonicalContextBytes;
		if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > CREATOR_SOURCE_CONTEXT_MAX_BYTES ||
			!(input.context.digest instanceof Uint8Array) || input.context.digest.byteLength !== 32) return undefined;
		const bytes = new Uint8Array(raw), digest = hashDomain(DOMAIN, bytes);
		if (compareBytes(digest, input.context.digest) !== 0) return undefined;
		const decoded = decodeCanonical(bytes, limits);
		if (!isClosedDurableIssuanceRecord(decoded, ["kind", "version", "anchorPreimage", "anchorSignature", "aclBytes"]) ||
			decoded.kind !== KIND || decoded.version !== 1 ||
			!(decoded.anchorPreimage instanceof Uint8Array) || decoded.anchorPreimage.byteLength === 0 || decoded.anchorPreimage.byteLength > 8192 ||
			!(decoded.anchorSignature instanceof Uint8Array) || decoded.anchorSignature.byteLength !== 64 ||
			!(decoded.aclBytes instanceof Uint8Array) || decoded.aclBytes.byteLength === 0 || decoded.aclBytes.byteLength > 65536) return undefined;
		const current = input.currentTrust;
		const trust = openCreatorSettlementSourceTrust(current, decoded.anchorPreimage, decoded.anchorSignature,
			current.objectId, current.genesisAnchorDigest);
		if (trust === undefined || trust.currentEpoch > current.currentEpoch) return undefined;
		const anchor = decodeCanonical(decoded.anchorPreimage) as Record<string, unknown>;
		if (anchor.blueprintDigest !== input.expectedBlueprintDigest || typeof anchor.aclDigest !== "string") return undefined;
		const opened = openCanonicalLatchedAclSnapshot({exactCanonicalLatchedAclBytes: decoded.aclBytes,
			expectedAclDigest: anchor.aclDigest, expectedEpoch: trust.currentEpoch, expectedObjectId: trust.objectId,
			expectedProfileId: trust.profileId});
		if (!opened.ok) return undefined;
		const capability = Object.freeze({});
		verified.set(capability, Object.freeze({trust, acl: opened.snapshot, blueprintDigest: input.expectedBlueprintDigest,
			context: Object.freeze({digest, exactCanonicalContextBytes: bytes})}));
		return capability;
	} catch { return undefined; }
}

/** Reads a genuine source capability without inferring a settlement disposition. */
export function resolveCreatorSourceCustody(capability: VerifiedCreatorSourceCustody): CreatorSourceCustodyIdentity | undefined {
	const identity = typeof capability === "object" && capability !== null ? verified.get(capability) : undefined;
	return identity === undefined ? undefined : {...identity, context: {digest: new Uint8Array(identity.context.digest),
		exactCanonicalContextBytes: new Uint8Array(identity.context.exactCanonicalContextBytes)}};
}

/** Captures the source while its current signed anchor and ACL still have an authenticated owner. */
export function captureCreatorSourceContext(trust: CurrentAnchorTrust, exactCanonicalAclBytes: Uint8Array,
	expectedBlueprintDigest: string): SettlementSourceContext {
	const anchor = readCreatorSettlementSourceAnchor(trust);
	if (anchor === undefined) throw new TypeError("creator source trust is unavailable");
	const bytes = encodeCanonical({kind: KIND, version: 1, ...anchor, aclBytes: exactCanonicalAclBytes}, limits);
	const context = {digest: hashDomain(DOMAIN, bytes), exactCanonicalContextBytes: bytes};
	const capability = openCreatorSourceCustody({currentTrust: trust, context, expectedBlueprintDigest});
	const identity = capability === undefined ? undefined : resolveCreatorSourceCustody(capability);
	if (identity === undefined) throw new TypeError("creator source context is not authenticated");
	return identity.context;
}

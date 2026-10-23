import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { isClosedDurableIssuanceRecord, type SettlementSourceContext } from "@ts-drp/issuance-store";
import type { IssuanceSourceCustodyGeometry } from "@ts-drp/issuance-store/maintenance";
import { AHE_BOUNDED_READ_LIMITS } from "@ts-drp/storage";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorSettlementSourceTrust, readCreatorSettlementSourceAnchor } from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import { openCanonicalLatchedAclSnapshot, type LatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import registry from "@ts-drp/protocol-v3/registry/registry-v1.json" with {type: "json"};

const KIND = "creator-settlement-source-context-1";
const DOMAIN = "ts-drp/settlement-source-context/v1";
const MAX_PARAMETERS = encodeCanonical(Object.fromEntries(registry.kinds.parameters.fields.map(field =>
	[field.name, field.constraints.maximum]))).byteLength;
// Exact existing anchor, ACL and registered parameter-schema bounds, with canonical field overhead.
export const CREATOR_SOURCE_CONTEXT_MAX_BYTES = encodeCanonical({kind: KIND, version: 1,
	anchorPreimage: new Uint8Array(8192), anchorSignature: new Uint8Array(64), aclBytes: new Uint8Array(65536),
	parametersBytes: new Uint8Array(MAX_PARAMETERS)}).byteLength;
const limits = {maxBytes: CREATOR_SOURCE_CONTEXT_MAX_BYTES, maxDepth: 2, maxItems: 32};

export interface VerifiedCreatorSourceCustody { readonly __verifiedCreatorSourceCustody?: never }
export interface CreatorSourceCustodyIdentity {
	readonly trust: CurrentAnchorTrust;
	readonly acl: LatchedAclSnapshot;
	readonly blueprintDigest: string;
	readonly exactCanonicalParametersBytes: Uint8Array;
	readonly context: SettlementSourceContext;
}
const verified = new WeakMap<object, CreatorSourceCustodyIdentity>();

/** The current source anchor and ACL are immutable, so their actual widths
 * bound custody for any accepted operation in this epoch. Parameters use the
 * registered complete domain. This creates no context, reference or plan. */
export function creatorSourceCustodyGeometryForSizing(trust: CurrentAnchorTrust,
	exactCanonicalAclBytes: Uint8Array): IssuanceSourceCustodyGeometry | undefined {
	if (trust.profileId !== "creator-trusted-settlement-v1") return undefined;
	const anchor = readCreatorSettlementSourceAnchor(trust);
	if (anchor === undefined) throw new TypeError("creator source sizing trust is unavailable");
	const fields = decodeCanonical(anchor.anchorPreimage) as Record<string, unknown>;
	const acl = openCanonicalLatchedAclSnapshot({exactCanonicalLatchedAclBytes: exactCanonicalAclBytes,
		expectedAclDigest: String(fields.aclDigest), expectedEpoch: trust.currentEpoch,
		expectedObjectId: trust.objectId, expectedProfileId: trust.profileId});
	if (!acl.ok) throw new TypeError("creator source sizing ACL is not authenticated");
	const varuintWidth = (value: number): number => { let width = 1; while (value >= 128) { value = Math.floor(value / 128); width++; } return width; };
	const emptyParameters = encodeCanonical({kind: KIND, version: 1, ...anchor, aclBytes: exactCanonicalAclBytes,
		parametersBytes: new Uint8Array()}).byteLength;
	return Object.freeze({maxContextByteLength: emptyParameters + MAX_PARAMETERS + varuintWidth(MAX_PARAMETERS) - 1,
		maxNativeReadByteLength: AHE_BOUNDED_READ_LIMITS.maxUnionBytes});
}

/** Historical authority only: no inclusion, noninclusion, current Writer grant or native currency. */
export function openCreatorSourceCustody(input: Readonly<{
	currentTrust: CurrentAnchorTrust;
	context: SettlementSourceContext;
	expectedBlueprintDigest?: string;
}>): VerifiedCreatorSourceCustody | undefined {
	try {
		const raw = input.context.exactCanonicalContextBytes;
		if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > CREATOR_SOURCE_CONTEXT_MAX_BYTES ||
			!(input.context.digest instanceof Uint8Array) || input.context.digest.byteLength !== 32) return undefined;
		const bytes = new Uint8Array(raw), digest = hashDomain(DOMAIN, bytes);
		if (compareBytes(digest, input.context.digest) !== 0) return undefined;
		const decoded = decodeCanonical(bytes, limits);
		if (!isClosedDurableIssuanceRecord(decoded, ["kind", "version", "anchorPreimage", "anchorSignature", "aclBytes", "parametersBytes"]) ||
			decoded.kind !== KIND || decoded.version !== 1 ||
			!(decoded.anchorPreimage instanceof Uint8Array) || decoded.anchorPreimage.byteLength === 0 || decoded.anchorPreimage.byteLength > 8192 ||
			!(decoded.anchorSignature instanceof Uint8Array) || decoded.anchorSignature.byteLength !== 64 ||
			!(decoded.aclBytes instanceof Uint8Array) || decoded.aclBytes.byteLength === 0 || decoded.aclBytes.byteLength > 65536 ||
			!(decoded.parametersBytes instanceof Uint8Array) || decoded.parametersBytes.byteLength === 0 ||
			decoded.parametersBytes.byteLength > MAX_PARAMETERS) return undefined;
		const current = input.currentTrust;
		const trust = openCreatorSettlementSourceTrust(current, decoded.anchorPreimage, decoded.anchorSignature,
			current.objectId, current.genesisAnchorDigest);
		if (trust === undefined || trust.currentEpoch > current.currentEpoch) return undefined;
		const anchor = decodeCanonical(decoded.anchorPreimage) as Record<string, unknown>;
		if (typeof anchor.blueprintDigest !== "string" || !/^[0-9a-f]{64}$/u.test(anchor.blueprintDigest) ||
			(input.expectedBlueprintDigest !== undefined && anchor.blueprintDigest !== input.expectedBlueprintDigest) ||
			typeof anchor.aclDigest !== "string" || typeof anchor.parametersDigest !== "string" ||
			Array.from(hashDomain("ts-drp/parameters/v3", decoded.parametersBytes), value => value.toString(16).padStart(2, "0")).join("") !==
				anchor.parametersDigest) return undefined;
		const parameters = decodeCanonical(decoded.parametersBytes);
		if (!isClosedDurableIssuanceRecord(parameters, registry.kinds.parameters.fields
			.filter(field => field.required || parameters !== null && typeof parameters === "object" && Object.hasOwn(parameters, field.name))
			.map(field => field.name)) ||
			registry.kinds.parameters.fields.some(field => (field.required || Object.hasOwn(parameters, field.name)) &&
				(!Number.isSafeInteger(parameters[field.name]) || Number(parameters[field.name]) < field.constraints.minimum ||
					Number(parameters[field.name]) > field.constraints.maximum))) return undefined;
		const opened = openCanonicalLatchedAclSnapshot({exactCanonicalLatchedAclBytes: decoded.aclBytes,
			expectedAclDigest: anchor.aclDigest, expectedEpoch: trust.currentEpoch, expectedObjectId: trust.objectId,
			expectedProfileId: trust.profileId});
		if (!opened.ok) return undefined;
		const capability = Object.freeze({});
		verified.set(capability, Object.freeze({trust, acl: opened.snapshot, blueprintDigest: anchor.blueprintDigest,
			exactCanonicalParametersBytes: new Uint8Array(decoded.parametersBytes),
			context: Object.freeze({digest, exactCanonicalContextBytes: bytes})}));
		return capability;
	} catch { return undefined; }
}

/** Reads a genuine source capability without inferring a settlement disposition. */
export function resolveCreatorSourceCustody(capability: VerifiedCreatorSourceCustody): CreatorSourceCustodyIdentity | undefined {
	const identity = typeof capability === "object" && capability !== null ? verified.get(capability) : undefined;
	return identity === undefined ? undefined : {...identity, exactCanonicalParametersBytes: new Uint8Array(identity.exactCanonicalParametersBytes),
		context: {digest: new Uint8Array(identity.context.digest),
		exactCanonicalContextBytes: new Uint8Array(identity.context.exactCanonicalContextBytes)}};
}

/** Captures the source while its current signed anchor and ACL still have an authenticated owner. */
export function captureCreatorSourceContext(trust: CurrentAnchorTrust, exactCanonicalAclBytes: Uint8Array,
	expectedBlueprintDigest: string, exactCanonicalParametersBytes: Uint8Array): SettlementSourceContext {
	const anchor = readCreatorSettlementSourceAnchor(trust);
	if (anchor === undefined) throw new TypeError("creator source trust is unavailable");
	const bytes = encodeCanonical({kind: KIND, version: 1, ...anchor, aclBytes: exactCanonicalAclBytes,
		parametersBytes: exactCanonicalParametersBytes}, limits);
	const context = {digest: hashDomain(DOMAIN, bytes), exactCanonicalContextBytes: bytes};
	const capability = openCreatorSourceCustody({currentTrust: trust, context, expectedBlueprintDigest});
	const identity = capability === undefined ? undefined : resolveCreatorSourceCustody(capability);
	if (identity === undefined) throw new TypeError("creator source context is not authenticated");
	return identity.context;
}

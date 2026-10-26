import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { canonicalRecordResourceForSizing, canonicalBytesResourceForSizing, canonicalArrayResourceForSizing,
	type CanonicalResourceFootprint } from "@ts-drp/canonical/resource";
import { isClosedDurableIssuanceRecord, type SettlementSourceContext } from "@ts-drp/issuance-store";
import type { IssuanceSourceCustodyGeometry } from "@ts-drp/issuance-store/maintenance";
import { AHE_BOUNDED_READ_LIMITS } from "@ts-drp/storage";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorSettlementSourceTrust, readCreatorSettlementSourceAnchor, readCreatorSettlementSourceConstants } from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import { openCanonicalLatchedAclSnapshot, type LatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { openCreatorSuccessorTrust, openCreatorForwardPromotionSuccessorTrust, creatorSuccessorAnchorFields, creatorSuccessorTrustFields } from "@ts-drp/protocol-v3/creator-close";
import { creatorCloseMembershipSubsetFields, creatorCloseMembershipSubsetMemberFields, openCreatorCloseMembership,
	captureCreatorCloseMembershipSubset, openCreatorCloseMembershipSubset } from "./creator-close-membership.js";
import { openReceivedCloseMembership, RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES } from "./creator-received-close-membership.js";
import {creatorQ1SealQcFields, creatorQ1SealVoteFields} from "@ts-drp/seal/creator";
import registry from "@ts-drp/protocol-v3/registry/registry-v1.json" with {type: "json"};
import { creatorSourceExpiryFields, verifyCreatorSourceExpiryReceipt, type CreatorSourceExpiryReceipt } from "@ts-drp/protocol-v3/internal/creator-source-expiry";

const KIND = "creator-settlement-source-context-1";
const DOMAIN = "ts-drp/settlement-source-context/v1";
const COMPLETION_KIND = "creator-settlement-source-completion-1";
const EXPIRY_KIND = "creator-settlement-source-expiry-1";
export { creatorSourceExpiryFields };
const MAX_PARAMETERS = encodeCanonical(Object.fromEntries(registry.kinds.parameters.fields.map(field =>
	[field.name, field.constraints.maximum]))).byteLength;
// Exact existing anchor, ACL and registered parameter-schema bounds, with canonical field overhead.
export const CREATOR_SOURCE_CONTEXT_MAX_BYTES = encodeCanonical({kind: KIND, version: 1,
	anchorPreimage: new Uint8Array(8192), anchorSignature: new Uint8Array(64), aclBytes: new Uint8Array(65536),
	parametersBytes: new Uint8Array(MAX_PARAMETERS)}).byteLength;
const limits = {maxBytes: CREATOR_SOURCE_CONTEXT_MAX_BYTES, maxDepth: 2, maxItems: 32};
const completionLimits = {maxBytes: 1_048_640, maxDepth: 4, maxItems: 64};
const expiryLimits = {maxBytes: 16_384, maxDepth: 4, maxItems: 64};
const sizingLimits = {...completionLimits, maxDepth: 32, maxItems: 65_536};

export interface VerifiedCreatorSourceCustody { readonly __verifiedCreatorSourceCustody?: never }
export interface CreatorSourceCustodyIdentity {
	readonly trust: CurrentAnchorTrust;
	readonly acl: LatchedAclSnapshot;
	readonly blueprintDigest: string;
	readonly exactCanonicalParametersBytes: Uint8Array;
	readonly context: SettlementSourceContext;
}
const verified = new WeakMap<object, CreatorSourceCustodyIdentity>();

/** Settlement work admitted at epoch E stays retained until the readiness
 * maintenance of epoch E+3 retires it (a closed row retires only once
 * throughEpoch - 2 covers it). Every adoption in between issues a mandatory
 * author fence, and any admission at E+2 projects the E+3 adoption fence, so
 * E's ordinary work reserves the adoption fence (E+1) plus these two later
 * fence-shaped records (E+2, E+3). The latter matters because an admission at
 * E+2 can be a received append (another writer's own mandatory fence), which
 * cannot be refused without stranding it in pending ingress. Received appends
 * add no issued row on this issuer, so the reserve does not scale with the
 * writer count. A fence keeps only its own single successor reserve. */
export const CREATOR_SETTLEMENT_RETAINED_FENCE_RESERVE = 2;

/** The current source anchor and ACL are immutable, so their actual widths
 * bound custody for any accepted operation in this epoch. Parameters use the
 * registered complete domain. This creates no context, reference or plan. */
export function creatorSourceCustodyGeometryForSizing(trust: CurrentAnchorTrust,
	exactCanonicalAclBytes: Uint8Array, maxEpochVertices: number): IssuanceSourceCustodyGeometry | undefined {
	if (trust.profileId !== "creator-trusted-settlement-v1") return undefined;
	const anchor = readCreatorSettlementSourceAnchor(trust);
	if (anchor === undefined) throw new TypeError("creator source sizing trust is unavailable");
	const fields = decodeCanonical(anchor.anchorPreimage) as Record<string, unknown>;
	const acl = openCanonicalLatchedAclSnapshot({exactCanonicalLatchedAclBytes: exactCanonicalAclBytes,
		expectedAclDigest: String(fields.aclDigest), expectedEpoch: trust.currentEpoch,
		expectedObjectId: trust.objectId, expectedProfileId: trust.profileId});
	if (!acl.ok) throw new TypeError("creator source sizing ACL is not authenticated");
	if (!Number.isSafeInteger(maxEpochVertices) || maxEpochVertices < 1) throw new TypeError("creator source sizing parameters are unavailable");
	const bytes = (length: number) => canonicalBytesResourceForSizing(length, sizingLimits);
	const record = (fields: Readonly<Record<string, unknown>>) =>
		canonicalRecordResourceForSizing(fields as Readonly<Record<string, CanonicalResourceFootprint | null | boolean | number | string>>, sizingLimits);
	const member = record(creatorCloseMembershipSubsetMemberFields({vertexDigest: bytes(32), leafIndex: Number.MAX_SAFE_INTEGER,
		treeSize: Number.MAX_SAFE_INTEGER, auditPath: bytes((Math.ceil(Math.log2(Math.max(1, maxEpochVertices - 1))) + 1) * 32)}));
	const membership = record(creatorCloseMembershipSubsetFields({cutValueDigest: "0".repeat(64),
		members: canonicalArrayResourceForSizing(0, member, sizingLimits)}));
	const constant = readCreatorSettlementSourceConstants(trust);
	const signerSet = constant === undefined ? undefined : decodeCanonical(constant.exactCanonicalSignerSetBytes);
	const signerId = Array.isArray(signerSet) && signerSet.length === 1 ? (signerSet[0] as Record<string, unknown>).signerId : undefined;
	if (constant === undefined || typeof signerId !== "string") throw new TypeError("creator source sizing signer is unavailable");
	const digest = "0".repeat(64), integer = Number.MAX_SAFE_INTEGER;
	const qc = record(creatorQ1SealQcFields({epoch: integer, objectId: trust.objectId, phase: "commit",
		proposalDigest: digest, proposalHash: digest, round: integer}, canonicalArrayResourceForSizing(1,
		record(creatorQ1SealVoteFields({signature: "0".repeat(128), signerId, voteDigest: digest})), sizingLimits)));
	const successorAnchor = record(creatorSuccessorAnchorFields({currentAnchor: fields, cut: {
		aclDigest: digest, archiveIndexRoot: digest, blueprintDigest: digest, historyRoot: digest, historySize: integer,
		objectId: trust.objectId, previousAnchor: digest}, cutDigest: digest, successorEpoch: integer, effectiveStateDigest: digest}));
	const successorTrust = record(creatorSuccessorTrustFields({currentAnchorDigest: digest, currentEpoch: integer,
		detachedCurrentAnchorSignature: bytes(64), exactCanonicalCurrentAnchorPreimageBytes: bytes(successorAnchor.byteLength),
		exactCanonicalProfileBytes: bytes(constant.exactCanonicalProfileBytes.byteLength),
		exactCanonicalSignerSetBytes: bytes(constant.exactCanonicalSignerSetBytes.byteLength),
		genesisAnchorDigest: digest, objectId: trust.objectId, profileId: trust.profileId}));
	// The variable Cut keeps its original opener ceiling. Fixed creator QC and
	// trust use their original schemas and the authenticated immutable constants.
	// The count and opaque subset BYTES can each grow from one to three
	// varuint bytes under the original native ceiling. No encoded proof is made.
	const maxCompletionByteLength = record({kind: COMPLETION_KIND, version: 1,
		exactCanonicalCutValueBytes: bytes(RECEIVED_CLOSE_AUTHORITY_MAX_RECORD_BYTES),
		exactCanonicalCommitQcBytes: bytes(qc.byteLength),
		exactCanonicalSuccessorTrustStateRecordBytes: bytes(successorTrust.byteLength),
		exactCanonicalMembershipSubsetBytes: bytes(membership.byteLength)}).byteLength + 4;
	const maxCompletionMemberByteLength = member.byteLength;
	const expiry = record(creatorSourceExpiryFields({objectId: trust.objectId, pinnedGenesisAnchorDigest: digest,
		sourceAuthor: digest, sourceSequence: integer, sourceDigest: bytes(32), sourceContextDigest: bytes(32),
		signingEpoch: integer, signingAnchorDigest: digest, signingNativeHeadDigest: bytes(32), signingFloorDigest: bytes(32)}));
	const maxExpiryByteLength = record({kind: EXPIRY_KIND, version: 1, exactCanonicalReceiptBytes: bytes(expiry.byteLength),
		detachedSignature: bytes(64)}).byteLength;
	const varuintWidth = (value: number): number => { let width = 1; while (value >= 128) { value = Math.floor(value / 128); width++; } return width; };
	const emptyParameters = encodeCanonical({kind: KIND, version: 1, ...anchor, aclBytes: exactCanonicalAclBytes,
		parametersBytes: new Uint8Array()}).byteLength;
	return Object.freeze({maxContextByteLength: emptyParameters + MAX_PARAMETERS + varuintWidth(MAX_PARAMETERS) - 1,
		maxCompletionByteLength, maxCompletionMemberByteLength, maxExpiryByteLength, maxNativeReadByteLength: AHE_BOUNDED_READ_LIMITS.maxUnionBytes});
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

/** Exact inclusion is immutable historical DATA. It grants no current role,
 * native currency, or permission to collect a source with remaining consumers. */
export async function openCreatorSourceCompletion(source: VerifiedCreatorSourceCustody,
	context: SettlementSourceContext): Promise<ReadonlySet<string> | undefined> {
	try {
		const identity = resolveCreatorSourceCustody(source);
		const bytes = new Uint8Array(context.exactCanonicalContextBytes);
		if (identity === undefined || compareBytes(hashDomain(DOMAIN, bytes), context.digest) !== 0) return undefined;
		const value = decodeCanonical(bytes, completionLimits);
		if (!isClosedDurableIssuanceRecord(value, ["kind", "version", "exactCanonicalCutValueBytes", "exactCanonicalCommitQcBytes",
			"exactCanonicalSuccessorTrustStateRecordBytes", "exactCanonicalMembershipSubsetBytes"]) ||
			value.kind !== COMPLETION_KIND || value.version !== 1 ||
			![value.exactCanonicalCutValueBytes, value.exactCanonicalCommitQcBytes, value.exactCanonicalSuccessorTrustStateRecordBytes,
				value.exactCanonicalMembershipSubsetBytes].every(field => field instanceof Uint8Array) ||
			compareBytes(bytes, encodeCanonical(value, completionLimits)) !== 0) return undefined;
		const cutBytes = value.exactCanonicalCutValueBytes as Uint8Array;
		const cut = decodeCanonical(cutBytes) as Record<string, unknown>;
		const successor = (cut.forwardPromotion === undefined ? openCreatorSuccessorTrust : openCreatorForwardPromotionSuccessorTrust)({
			currentTrust: identity.trust, exactCanonicalCutValueBytes: cutBytes,
			exactCanonicalCommitQcBytes: value.exactCanonicalCommitQcBytes,
			exactCanonicalTrustStateRecordBytes: value.exactCanonicalSuccessorTrustStateRecordBytes});
		if (!successor.ok || successor.trust.currentEpoch !== identity.trust.currentEpoch + 1 ||
			cut.epoch !== identity.trust.currentEpoch || cut.previousAnchor !== identity.trust.currentAnchorDigest) return undefined;
		const parameters = decodeCanonical(identity.exactCanonicalParametersBytes) as Record<string, unknown>;
		return openCreatorCloseMembershipSubset({bytes: value.exactCanonicalMembershipSubsetBytes as Uint8Array,
			exactCanonicalCutValueBytes: cutBytes, maxEpochVertices: Number(parameters.maxEpochVertices)});
	} catch {return undefined;}
}

/** Transfer the original signed received proof once per source epoch. Local
 * witnesses remain in their original issued rows; exact membership and all
 * signed close carriers stay together until the final plan consumer leaves. */
export async function captureCreatorSourceCompletion(source: VerifiedCreatorSourceCustody,
	exactCanonicalReceivedMembershipBytes: Uint8Array, vertexDigests: readonly Uint8Array[]): Promise<SettlementSourceContext> {
	const receivedBytes = new Uint8Array(exactCanonicalReceivedMembershipBytes), selectedDigests = vertexDigests.map(value => new Uint8Array(value));
	const identity = resolveCreatorSourceCustody(source), received = openReceivedCloseMembership(receivedBytes);
	if (identity === undefined || received === undefined) throw new TypeError("creator source completion is unavailable");
	const parameters = decodeCanonical(identity.exactCanonicalParametersBytes) as Record<string, unknown>;
	const membership = await openCreatorCloseMembership({bytes: receivedBytes,
		exactCanonicalCutValueBytes: received.exactCanonicalCutValueBytes, maxEpochVertices: Number(parameters.maxEpochVertices)});
	if (membership === undefined || compareBytes(membership.exactCanonicalLatchedAclBytes, encodeCanonical(identity.acl)) !== 0)
		throw new TypeError("creator source completion ACL differs");
	const subset = await captureCreatorCloseMembershipSubset({bytes: receivedBytes,
		exactCanonicalCutValueBytes: received.exactCanonicalCutValueBytes, maxEpochVertices: Number(parameters.maxEpochVertices), vertexDigests: selectedDigests});
	const bytes = encodeCanonical({kind: COMPLETION_KIND, version: 1,
		exactCanonicalCutValueBytes: received.exactCanonicalCutValueBytes, exactCanonicalCommitQcBytes: received.exactCanonicalCommitQcBytes,
		exactCanonicalSuccessorTrustStateRecordBytes: received.exactCanonicalSuccessorTrustStateRecordBytes,
		exactCanonicalMembershipSubsetBytes: subset}, completionLimits);
	const context = {digest: hashDomain(DOMAIN, bytes), exactCanonicalContextBytes: bytes};
	if (await openCreatorSourceCompletion(source, context) === undefined) throw new TypeError("creator source completion is not authenticated");
	return context;
}

/** Wraps the exact signed receipt as one retained plan context (no authority). */
export function captureCreatorSourceExpiry(exactCanonicalReceiptBytes: Uint8Array, detachedSignature: Uint8Array): SettlementSourceContext {
	if (!(exactCanonicalReceiptBytes instanceof Uint8Array) || !(detachedSignature instanceof Uint8Array) || detachedSignature.byteLength !== 64)
		throw new TypeError("creator source expiry carrier is invalid");
	const bytes = encodeCanonical({kind: EXPIRY_KIND, version: 1, exactCanonicalReceiptBytes: new Uint8Array(exactCanonicalReceiptBytes),
		detachedSignature: new Uint8Array(detachedSignature)}, expiryLimits);
	return {digest: hashDomain(DOMAIN, bytes), exactCanonicalContextBytes: bytes};
}

/** Exact signed local-author abandonment of one retained source. Historical
 * DATA only: the signer must be the source author, exactly one member of the
 * source epoch's authenticated ACL (not a current Writer), and sign after that
 * epoch. Head/floor/anchor digests are recorded identities, never freshness. */
export function openCreatorSourceExpiry(source: VerifiedCreatorSourceCustody, context: SettlementSourceContext,
	expected: Readonly<{sourceAuthor: string; sourceSequence: number; sourceDigest: Uint8Array}>): CreatorSourceExpiryReceipt | undefined {
	try {
		const identity = resolveCreatorSourceCustody(source);
		const bytes = new Uint8Array(context.exactCanonicalContextBytes);
		if (identity === undefined || !(context.digest instanceof Uint8Array) || compareBytes(hashDomain(DOMAIN, bytes), context.digest) !== 0) return undefined;
		const value = decodeCanonical(bytes, expiryLimits);
		if (!isClosedDurableIssuanceRecord(value, ["kind", "version", "exactCanonicalReceiptBytes", "detachedSignature"]) ||
			value.kind !== EXPIRY_KIND || value.version !== 1 || !(value.exactCanonicalReceiptBytes instanceof Uint8Array) ||
			!(value.detachedSignature instanceof Uint8Array) || value.detachedSignature.byteLength !== 64 ||
			compareBytes(bytes, encodeCanonical(value, expiryLimits)) !== 0) return undefined;
		const receipt = verifyCreatorSourceExpiryReceipt(value.exactCanonicalReceiptBytes, value.detachedSignature);
		if (receipt === undefined || receipt.objectId !== identity.trust.objectId ||
			receipt.pinnedGenesisAnchorDigest !== identity.trust.genesisAnchorDigest ||
			compareBytes(receipt.sourceContextDigest, identity.context.digest) !== 0 ||
			receipt.sourceAuthor !== expected.sourceAuthor || receipt.sourceSequence !== expected.sourceSequence ||
			!(expected.sourceDigest instanceof Uint8Array) || compareBytes(receipt.sourceDigest, expected.sourceDigest) !== 0 ||
			receipt.signingEpoch <= identity.trust.currentEpoch ||
			identity.acl.members.filter(member => member.author === receipt.sourceAuthor).length !== 1) return undefined;
		return receipt;
	} catch { return undefined; }
}

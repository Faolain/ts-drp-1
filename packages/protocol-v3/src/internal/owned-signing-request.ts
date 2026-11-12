import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { digestReceivedVertexPreimage, vertexCanonicalBytes } from "../index.js";
import { prepareCreatorAnchorSigningRequest } from "../creator-close.js";
import { decodeCreatorReattachmentCheckpoint } from "./creator-reattachment-checkpoint.js";
import { creatorSourceExpiryDigest, openCreatorSourceAuthorReceiptAuthor } from "./creator-source-expiry.js";

declare const ownedSigningRequestBrand: unique symbol;
export interface OwnedSigningRequest { readonly [ownedSigningRequestBrand]: true; }
export type CapturedOwnedSigningRequest = Readonly<{
	kind: "operation" | "genesis" | "creator-selection" | "source-expiry" | "possession" | "transport";
	digest: Uint8Array;
	publicKey: Uint8Array;
	genesis?: Readonly<{ objectId: string; bindingDigest: Uint8Array }>;
}>;
/** Private semantic-owner registries supply this admission, not caller receipts.
 * Challenge signatures prove possession/routing only, never protocol validity. */
export type OwnedIdentityChallengeAdmission = Readonly<{
	kind: "possession" | "transport";
	bytes: Uint8Array;
	publicKey: Uint8Array;
	checkWhile<T>(action: () => Promise<T>): Promise<T>;
}>;
const requests = new WeakMap<OwnedSigningRequest, CapturedOwnedSigningRequest>();

/** Routing frame ceilings shared by the transport and original signing admission. */
export const CREATOR_SUCCESSOR_TRANSPORT_LIMITS = Object.freeze({
	maxRequestBytes: 212_387,
	maxMembershipBytes: 2_097_152,
	maxResponseBytes: 212_387 + 2_097_152,
});

/** Internal semantic-owner turn. No arbitrary-digest constructor or public root export. */
async function withRequest<T>(captured: CapturedOwnedSigningRequest, action: (request: OwnedSigningRequest) => Promise<T>): Promise<T> {
	const request = Object.freeze({}) as OwnedSigningRequest;
	requests.set(request, captured);
	try { return await action(request); }
	finally { requests.delete(request); } // Unconsumed requests cannot escape the joined owner turn.
}

/** The existing genesis authoring owner supplies its exact tuple. This request
 * alone grants no freshness: the native consumer also requires its original
 * account-side durable create-if-never-seen reservation for this exact tuple. */
export function withAuthoredGenesisSigningRequest<T>(input: Readonly<{
	exactCanonicalAnchorPreimageBytes: Uint8Array;
	exactCanonicalProfileBytes: Uint8Array;
	exactCanonicalSignerSetBytes: Uint8Array;
	exactCanonicalLatchedAclBytes: Uint8Array;
	signerPublicKey: Uint8Array;
}>, action: (request: OwnedSigningRequest) => Promise<T>): Promise<T> {
	if (!(input.exactCanonicalLatchedAclBytes instanceof Uint8Array) || input.exactCanonicalLatchedAclBytes.byteLength > 65_536) throw new TypeError("OWNED_GENESIS_ACL_INVALID");
	const validated = prepareCreatorAnchorSigningRequest({ exactCanonicalAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
		exactCanonicalProfileBytes: input.exactCanonicalProfileBytes, exactCanonicalSignerSetBytes: input.exactCanonicalSignerSetBytes, signerPublicKey: input.signerPublicKey });
	if (!validated.ok) throw new TypeError(`OWNED_GENESIS_${validated.reason}`);
	const limits = { maxBytes: 65_536, maxDepth: 16, maxItems: 16_384 }; // Existing SDK carrier limits.
	const anchor = decodeCanonical(input.exactCanonicalAnchorPreimageBytes, limits) as Record<string, unknown>;
	const acl = decodeCanonical(input.exactCanonicalLatchedAclBytes, limits) as Record<string, unknown>;
	const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
	const author = hex(input.signerPublicKey);
	if (anchor.epoch !== 0 || anchor.previousAnchor !== "0".repeat(64) || anchor.historySize !== 0 || typeof anchor.objectId !== "string" ||
		anchor.aclDigest !== hex(hashDomain("ts-drp/latched-acl/v3", input.exactCanonicalLatchedAclBytes)) ||
		acl.kind !== "drp-v3-latched-acl" || acl.version !== 3 || acl.epoch !== 0 || acl.objectId !== anchor.objectId ||
		compareBytes(encodeCanonical(acl), input.exactCanonicalLatchedAclBytes) !== 0 || !Array.isArray(acl.members)) throw new TypeError("OWNED_GENESIS_ACL_INVALID");
	const enrolled = acl.members.filter((member: unknown) => member !== null && typeof member === "object" && Reflect.get(member, "author") === author);
	if (enrolled.length !== 1 || Reflect.get(enrolled[0], "finalityKey") !== author || !Array.isArray(Reflect.get(enrolled[0], "groups")) ||
		!["admin", "finality"].every(group => Reflect.get(enrolled[0], "groups").includes(group))) throw new TypeError("OWNED_GENESIS_IDENTITY_NOT_ENROLLED");
	// Exact creator enrollment is independent of ordinary-operation Writer
	// admission, as in the original creator bootstrap/migration owner.
	return withRequest({ kind: "genesis", digest: hashDomain("ts-drp/epoch-anchor/v3", input.exactCanonicalAnchorPreimageBytes), publicKey: Uint8Array.from(input.signerPublicKey),
		genesis: { objectId: anchor.objectId, bindingDigest: hashDomain("ts-drp/account-genesis-creation/v1", encodeCanonical({ exactCanonicalAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes, publicKey: input.signerPublicKey })) } }, action);
}

/** Native owner capture only. Reading does not grant admission or consume. */
export function inspectOwnedGenesisSigningRequest(request: unknown): CapturedOwnedSigningRequest | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const captured = requests.get(request as OwnedSigningRequest);
	return captured?.kind !== "genesis" ? undefined : { ...captured, digest: Uint8Array.from(captured.digest), publicKey: Uint8Array.from(captured.publicKey),
		genesis: { objectId: captured.genesis!.objectId, bindingDigest: Uint8Array.from(captured.genesis!.bindingDigest) } };
}

/** Authored bytes only, NOT source authority or native admission. The consumer
 * separately requires the native owner turn entered from v3-live's private
 * exact authenticated source-selection request. Caller checks grant nothing. */
export function withAuthoredCreatorSelectionSigningRequest<T>(input: Readonly<{
	exactCanonicalSelectionBytes: Uint8Array;
	signerPublicKey: Uint8Array;
}>, action: (request: OwnedSigningRequest) => Promise<T>): Promise<T> {
	if (Reflect.ownKeys(input).length !== 2 || !(input.exactCanonicalSelectionBytes instanceof Uint8Array) ||
		!(input.signerPublicKey instanceof Uint8Array) || input.signerPublicKey.byteLength !== 32) throw new TypeError("OWNED_SELECTION_PREIMAGE_INVALID");
	return withRequest({ kind: "creator-selection", digest: hashDomain("ts-drp/settlement-source-selection/v1", input.exactCanonicalSelectionBytes), publicKey: Uint8Array.from(input.signerPublicKey) }, action);
}

/** Authored local-author abandonment receipt, NOT abandonment authority. The
 * request carries no caller digest: it opens the exact closed canonical receipt,
 * requires the signer to be its own source author and computes the digest. The
 * native consumer separately requires v3-live's private admitted expiry turn. */
export function withAuthoredSourceExpirySigningRequest<T>(input: Readonly<{
	exactCanonicalReceiptBytes: Uint8Array;
	signerPublicKey: Uint8Array;
}>, action: (request: OwnedSigningRequest) => Promise<T>): Promise<T> {
	if (input === null || typeof input !== "object" || Reflect.ownKeys(input).length !== 2 ||
		!(input.exactCanonicalReceiptBytes instanceof Uint8Array) ||
		!(input.signerPublicKey instanceof Uint8Array) || input.signerPublicKey.byteLength !== 32) throw new TypeError("OWNED_SOURCE_EXPIRY_RECEIPT_INVALID");
	const bytes = Uint8Array.from(input.exactCanonicalReceiptBytes);
	// An expiry or a replaced-source resolution receipt (both the source author's own settlement statements).
	const receiptAuthor = openCreatorSourceAuthorReceiptAuthor(bytes);
	const author = Array.from(input.signerPublicKey, byte => byte.toString(16).padStart(2, "0")).join("");
	if (receiptAuthor === undefined || receiptAuthor !== author) throw new TypeError("OWNED_SOURCE_EXPIRY_RECEIPT_INVALID");
	return withRequest({ kind: "source-expiry", digest: creatorSourceExpiryDigest(bytes), publicKey: Uint8Array.from(input.signerPublicKey) }, action);
}

/** Canonical bytes alone are NOT native admission. Genuine creator-adoption /
 * transport owner admission must independently enter the exact challenge turn. */
export function withAuthoredIdentityChallengeSigningRequest<T>(input: Readonly<{
	kind: "possession" | "transport";
	exactCanonicalChallengeBytes: Uint8Array;
	signerPublicKey: Uint8Array;
}>, action: (request: OwnedSigningRequest) => Promise<T>): Promise<T> {
	if (Reflect.ownKeys(input).length !== 3 || !(input.exactCanonicalChallengeBytes instanceof Uint8Array) ||
		!(input.signerPublicKey instanceof Uint8Array) || input.signerPublicKey.byteLength !== 32 ||
		!["possession", "transport"].includes(input.kind)) throw new TypeError("OWNED_IDENTITY_CHALLENGE_INVALID");
	const limits = input.kind === "transport" ? { maxBytes: CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxResponseBytes, maxDepth: 2, maxItems: 64 } : { maxBytes: 65_536, maxDepth: 4, maxItems: 64 };
	const frame = decodeCanonical(input.exactCanonicalChallengeBytes, limits) as Record<string, unknown>;
	const author = Array.from(input.signerPublicKey, byte => byte.toString(16).padStart(2, "0")).join("");
	if (frame === null || typeof frame !== "object" || Array.isArray(frame) || frame.author !== author ||
		!(frame.nonce instanceof Uint8Array) || frame.nonce.byteLength !== 32 ||
		compareBytes(encodeCanonical(frame, limits), input.exactCanonicalChallengeBytes) !== 0 || Object.hasOwn(frame, "signature")) throw new TypeError("OWNED_IDENTITY_CHALLENGE_INVALID");
	if (input.kind === "possession") {
		const keys = ["kind", "version", "nonce", "author", "objectId", "epoch", "aclDigest", "profileId", "pinnedGenesisAnchorDigest", "currentAnchorDigest"];
		if (frame.version !== 1 || Object.keys(frame).sort().join(",") !== keys.sort().join(",") || frame.kind !== "creator-issuance-possession" ||
			typeof frame.objectId !== "string" || !Number.isSafeInteger(frame.epoch) || Number(frame.epoch) < 0 || typeof frame.profileId !== "string" ||
			[frame.aclDigest, frame.pinnedGenesisAnchorDigest, frame.currentAnchorDigest].some(value => typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))) throw new TypeError("OWNED_IDENTITY_CHALLENGE_INVALID");
	} else if (!["creator-successor-material-request", "creator-successor-material-response", "creator-successor-material-unavailable"].includes(String(frame.kind)) ||
		typeof frame.manifestDigest !== "string" || !/^[0-9a-f]{64}$/u.test(frame.manifestDigest) ||
		typeof frame.requesterPeer !== "string" || typeof frame.sourcePeer !== "string") throw new TypeError("OWNED_IDENTITY_CHALLENGE_INVALID");
	if (input.kind === "transport") {
		const membership = frame.exactCanonicalCloseMembershipBytes;
		const carriesMembership = Object.hasOwn(frame, "exactCanonicalCloseMembershipBytes");
		const carriesCheckpoint = Object.hasOwn(frame, "exactCanonicalReattachmentCheckpointBytes");
		const checkpointRequest = frame.kind === "creator-successor-material-request" &&
			frame.version === 2 && frame.materialKind === "checkpoint";
		const unavailable = frame.kind === "creator-successor-material-unavailable";
		const valid = unavailable
			? frame.version === 1 && frame.reason === "checkpoint-not-adopted" &&
				Object.keys(frame).sort().join(",") === ["kind", "version", "nonce", "manifestDigest", "requesterPeer", "sourcePeer", "author", "reason"].sort().join(",") &&
				input.exactCanonicalChallengeBytes.byteLength <= CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxRequestBytes
			: carriesCheckpoint
			? frame.kind === "creator-successor-material-response" && frame.version === 3 && !carriesMembership &&
				decodeCreatorReattachmentCheckpoint(frame.exactCanonicalReattachmentCheckpointBytes) !== undefined &&
				input.exactCanonicalChallengeBytes.byteLength <= CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxRequestBytes
			: carriesMembership
				? frame.kind === "creator-successor-material-response" && frame.version === 2 &&
					membership instanceof Uint8Array && membership.byteLength > 0 &&
					membership.byteLength <= CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxMembershipBytes
				: (checkpointRequest || (frame.version === 1 && !Object.hasOwn(frame, "materialKind"))) &&
					input.exactCanonicalChallengeBytes.byteLength <= CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxRequestBytes;
		if (!valid || (Object.hasOwn(frame, "materialKind") && !checkpointRequest))
			throw new TypeError("OWNED_IDENTITY_CHALLENGE_INVALID");
	}
	const domain = input.kind === "possession" ? "ts-drp/creator-issuance-possession/v1" : "ts-drp/creator-successor-transport/v1";
	return withRequest({ kind: input.kind, digest: hashDomain(domain, input.exactCanonicalChallengeBytes), publicKey: Uint8Array.from(input.signerPublicKey) }, action);
}

/** Called inside the original issuance owner's admitted signing continuation. */
export function withAuthoredOperationSigningRequest<T>(
	exactCanonicalPreimageBytes: Uint8Array,
	action: (request: OwnedSigningRequest) => Promise<T>
): Promise<T> {
	const decoded = decodeCanonical(exactCanonicalPreimageBytes);
	const canonical = vertexCanonicalBytes(decoded as Parameters<typeof vertexCanonicalBytes>[0]);
	if (compareBytes(canonical, exactCanonicalPreimageBytes) !== 0) throw new TypeError("OWNED_OPERATION_PREIMAGE_INVALID");
	const author = Reflect.get(decoded as object, "author");
	if (typeof author !== "string" || !/^[0-9a-f]{64}$/u.test(author)) throw new TypeError("OWNED_OPERATION_AUTHOR_INVALID");
	return withRequest({ kind: "operation", digest: digestReceivedVertexPreimage(canonical), publicKey: Uint8Array.from(author.match(/../gu)!.map(byte => Number.parseInt(byte, 16))) }, action);
}

/** Consumer only: genuine one-use identity, never a supplied digest/Boolean. */
export function consumeOwnedSigningRequest(request: unknown): CapturedOwnedSigningRequest | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const captured = requests.get(request as OwnedSigningRequest);
	requests.delete(request as OwnedSigningRequest);
	return captured === undefined ? undefined : { ...captured, digest: Uint8Array.from(captured.digest), publicKey: Uint8Array.from(captured.publicKey) };
}

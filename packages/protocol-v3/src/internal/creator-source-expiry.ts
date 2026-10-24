import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { hashDomain } from "@ts-drp/canonical";
import { verifyEd25519 } from "./ed25519-verify.js";

/** Original local-author abandonment receipt kind (single definition). */
export const CREATOR_SOURCE_EXPIRY_RECEIPT_KIND = "creator-source-expiry-1";
/** Detached Ed25519 signature domain over the exact canonical receipt bytes. */
export const CREATOR_SOURCE_EXPIRY_DOMAIN = "ts-drp/settlement-source-expiry/v1";
/** Recorded native-head identity domain (Q5: a new head-record domain). */
export const CREATOR_SOURCE_EXPIRY_HEAD_DOMAIN = "ts-drp/settlement-source-expiry-head/v1";
const KEYS = Object.freeze(["kind", "version", "objectId", "pinnedGenesisAnchorDigest", "sourceAuthor", "sourceSequence",
	"sourceDigest", "sourceContextDigest", "signingEpoch", "signingAnchorDigest", "signingNativeHeadDigest", "signingFloorDigest"]);
/** Receipt carriers are a closed flat record; this bounds decoding only. */
export const CREATOR_SOURCE_EXPIRY_RECEIPT_LIMITS = Object.freeze({ maxBytes: 16_384, maxDepth: 2, maxItems: 64 });

export interface CreatorSourceExpiryReceipt {
	readonly kind: typeof CREATOR_SOURCE_EXPIRY_RECEIPT_KIND;
	readonly version: 1;
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly sourceAuthor: string;
	readonly sourceSequence: number;
	readonly sourceDigest: Uint8Array;
	readonly sourceContextDigest: Uint8Array;
	readonly signingEpoch: number;
	readonly signingAnchorDigest: string;
	readonly signingNativeHeadDigest: Uint8Array;
	readonly signingFloorDigest: Uint8Array;
}

/** Original unsigned local-author abandonment schema, including exact current
 * native-head and whole-floor digests. These identities never grant freshness. */
export function creatorSourceExpiryFields(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return {kind: CREATOR_SOURCE_EXPIRY_RECEIPT_KIND, version: 1, objectId: input.objectId,
		pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest, sourceAuthor: input.sourceAuthor,
		sourceSequence: input.sourceSequence, sourceDigest: input.sourceDigest, sourceContextDigest: input.sourceContextDigest,
		signingEpoch: input.signingEpoch, signingAnchorDigest: input.signingAnchorDigest,
		signingNativeHeadDigest: input.signingNativeHeadDigest, signingFloorDigest: input.signingFloorDigest};
}

const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const bytes32 = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.byteLength === 32;
const ordinal = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/**
 * Opens the exact closed canonical receipt. Structure only: no signature, ACL,
 * plan or freshness authority.
 * @param exactCanonicalReceiptBytes - Candidate receipt bytes.
 * @returns The detached receipt, or undefined for any deviation.
 */
export function openCreatorSourceExpiryReceipt(exactCanonicalReceiptBytes: unknown): CreatorSourceExpiryReceipt | undefined {
	try {
		if (!(exactCanonicalReceiptBytes instanceof Uint8Array) ||
			exactCanonicalReceiptBytes.byteLength > CREATOR_SOURCE_EXPIRY_RECEIPT_LIMITS.maxBytes) return undefined;
		const bytes = new Uint8Array(exactCanonicalReceiptBytes);
		const value = decodeCanonical(bytes, CREATOR_SOURCE_EXPIRY_RECEIPT_LIMITS);
		if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype)) return undefined;
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length !== KEYS.length || !KEYS.every(key => Object.hasOwn(record, key)) ||
			record.kind !== CREATOR_SOURCE_EXPIRY_RECEIPT_KIND || record.version !== 1 ||
			typeof record.objectId !== "string" || record.objectId.length === 0 ||
			!hex64(record.pinnedGenesisAnchorDigest) || !hex64(record.sourceAuthor) || !ordinal(record.sourceSequence) ||
			!bytes32(record.sourceDigest) || !bytes32(record.sourceContextDigest) || !ordinal(record.signingEpoch) ||
			!hex64(record.signingAnchorDigest) || !bytes32(record.signingNativeHeadDigest) || !bytes32(record.signingFloorDigest) ||
			compareBytes(encodeCanonical(record, CREATOR_SOURCE_EXPIRY_RECEIPT_LIMITS), bytes) !== 0) return undefined;
		return Object.freeze({...record}) as unknown as CreatorSourceExpiryReceipt;
	} catch {
		return undefined;
	}
}

/**
 * Exact receipt digest that the source author signs.
 * @param exactCanonicalReceiptBytes - Exact closed canonical receipt bytes.
 * @returns The domain-separated digest.
 */
export function creatorSourceExpiryDigest(exactCanonicalReceiptBytes: Uint8Array): Uint8Array {
	return hashDomain(CREATOR_SOURCE_EXPIRY_DOMAIN, exactCanonicalReceiptBytes);
}

/**
 * Verifies the detached Ed25519 signature by the receipt's own source author.
 * Historical membership, plan identity and context belong to the native verifier.
 * @param exactCanonicalReceiptBytes - Exact closed canonical receipt bytes.
 * @param signature - Detached 64-byte signature.
 * @returns The opened receipt when the signature verifies.
 */
export function verifyCreatorSourceExpiryReceipt(exactCanonicalReceiptBytes: Uint8Array,
	signature: Uint8Array): CreatorSourceExpiryReceipt | undefined {
	const receipt = openCreatorSourceExpiryReceipt(exactCanonicalReceiptBytes);
	if (receipt === undefined || !(signature instanceof Uint8Array) || signature.byteLength !== 64) return undefined;
	try {
		const publicKey = Uint8Array.from(receipt.sourceAuthor.match(/../gu)!.map(byte => Number.parseInt(byte, 16)));
		return verifyEd25519(signature, creatorSourceExpiryDigest(exactCanonicalReceiptBytes), publicKey) ? receipt : undefined;
	} catch {
		return undefined;
	}
}

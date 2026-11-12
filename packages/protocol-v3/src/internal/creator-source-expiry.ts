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

/**
 * Replaced-source frontier resolution receipt (fix/creator-replaced-source-resolution): the source author's
 * signed statement that the creator's signed settlement frontier, installed at `signingEpoch`, proves a
 * source it already replaced (its plan entry completed by `replacementSequence`) settled: the frontier
 * passed it (`sourceSequence <= frontierTerminalThrough`), or it is displaced, fence-guarded
 * (`guardSequence`: the lowest own fence of its epoch at or below it, or null when it is the first
 * unsettled sequence) and past the settlement window. It is not an expiry of the move (the replacement
 * carries the move) and it authorizes nothing but the release of the source's retention. Signed under the
 * expiry domain by the same owned key (a distinct closed kind, never read as an expiry).
 */
export const CREATOR_REPLACED_SOURCE_RECEIPT_KIND = "creator-replaced-source-1";
const REPLACED_KEYS = Object.freeze(["kind", "version", "objectId", "pinnedGenesisAnchorDigest", "sourceAuthor", "sourceSequence",
	"sourceDigest", "sourceEpoch", "replacementSequence", "frontierCurrentEpoch", "frontierAdmissionEpoch", "frontierTerminalThrough",
	"guardSequence", "signingEpoch", "signingAnchorDigest", "signingNativeHeadDigest", "signingFloorDigest"]);

export interface CreatorReplacedSourceReceipt {
	readonly kind: typeof CREATOR_REPLACED_SOURCE_RECEIPT_KIND;
	readonly version: 1;
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly sourceAuthor: string;
	readonly sourceSequence: number;
	readonly sourceDigest: Uint8Array;
	readonly sourceEpoch: number;
	readonly replacementSequence: number;
	readonly frontierCurrentEpoch: number;
	readonly frontierAdmissionEpoch: number;
	readonly frontierTerminalThrough: number | null;
	readonly guardSequence: number | null;
	readonly signingEpoch: number;
	readonly signingAnchorDigest: string;
	readonly signingNativeHeadDigest: Uint8Array;
	readonly signingFloorDigest: Uint8Array;
}

/** Unsigned replaced-source receipt schema (single definition, also used for sizing). */
export function creatorReplacedSourceFields(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	return {kind: CREATOR_REPLACED_SOURCE_RECEIPT_KIND, version: 1, objectId: input.objectId,
		pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest, sourceAuthor: input.sourceAuthor,
		sourceSequence: input.sourceSequence, sourceDigest: input.sourceDigest, sourceEpoch: input.sourceEpoch,
		replacementSequence: input.replacementSequence, frontierCurrentEpoch: input.frontierCurrentEpoch,
		frontierAdmissionEpoch: input.frontierAdmissionEpoch, frontierTerminalThrough: input.frontierTerminalThrough,
		guardSequence: input.guardSequence, signingEpoch: input.signingEpoch, signingAnchorDigest: input.signingAnchorDigest,
		signingNativeHeadDigest: input.signingNativeHeadDigest, signingFloorDigest: input.signingFloorDigest};
}

/**
 * Opens the exact closed canonical replaced-source receipt. Structure only (no signature or authority);
 * the frontier statement must be internally consistent: the source epoch is closed in the frontier and
 * the frontier passed the source, or it is displaced, guarded and past `windowEpochs`.
 * @param exactCanonicalReceiptBytes - Candidate receipt bytes.
 * @param windowEpochs - The settlement window (V3_SETTLEMENT_OWN_WINDOW_EPOCHS).
 * @returns The detached receipt, or undefined for any deviation.
 */
export function openCreatorReplacedSourceReceipt(exactCanonicalReceiptBytes: unknown, windowEpochs = 4): CreatorReplacedSourceReceipt | undefined {
	try {
		if (!(exactCanonicalReceiptBytes instanceof Uint8Array) ||
			exactCanonicalReceiptBytes.byteLength > CREATOR_SOURCE_EXPIRY_RECEIPT_LIMITS.maxBytes) return undefined;
		const bytes = new Uint8Array(exactCanonicalReceiptBytes);
		const value = decodeCanonical(bytes, CREATOR_SOURCE_EXPIRY_RECEIPT_LIMITS);
		if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype)) return undefined;
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		const ordinalOrNull = (field: unknown): field is number | null => field === null || ordinal(field);
		if (keys.length !== REPLACED_KEYS.length || !REPLACED_KEYS.every(key => Object.hasOwn(record, key)) ||
			record.kind !== CREATOR_REPLACED_SOURCE_RECEIPT_KIND || record.version !== 1 ||
			typeof record.objectId !== "string" || record.objectId.length === 0 ||
			!hex64(record.pinnedGenesisAnchorDigest) || !hex64(record.sourceAuthor) || !ordinal(record.sourceSequence) ||
			!bytes32(record.sourceDigest) || !ordinal(record.sourceEpoch) || !ordinal(record.replacementSequence) ||
			!ordinal(record.frontierCurrentEpoch) || !ordinal(record.frontierAdmissionEpoch) ||
			!ordinalOrNull(record.frontierTerminalThrough) || !ordinalOrNull(record.guardSequence) || !ordinal(record.signingEpoch) ||
			!hex64(record.signingAnchorDigest) || !bytes32(record.signingNativeHeadDigest) || !bytes32(record.signingFloorDigest) ||
			compareBytes(encodeCanonical(record, CREATOR_SOURCE_EXPIRY_RECEIPT_LIMITS), bytes) !== 0) return undefined;
		const receipt = Object.freeze({...record}) as unknown as CreatorReplacedSourceReceipt;
		return creatorReplacedSourceSettled(receipt, windowEpochs) ? receipt : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The frontier statement a replaced-source receipt makes (held-anchor-retention.qnt `resolved`): the
 * source's epoch is closed in the frontier (signed at that frontier's epoch, which admits the author),
 * the replacement follows the source, and the frontier passed the source, or the source is displaced,
 * fence-guarded and past the settlement window.
 * @param receipt - An opened receipt.
 * @param windowEpochs - The settlement window.
 * @returns Whether the statement holds.
 */
export function creatorReplacedSourceSettled(receipt: CreatorReplacedSourceReceipt, windowEpochs: number): boolean {
	const tt = receipt.frontierTerminalThrough, guard = receipt.guardSequence;
	if (receipt.signingEpoch !== receipt.frontierCurrentEpoch || receipt.sourceEpoch >= receipt.frontierCurrentEpoch ||
		receipt.frontierAdmissionEpoch > receipt.frontierCurrentEpoch || receipt.replacementSequence <= receipt.sourceSequence) return false;
	if (tt !== null && receipt.sourceSequence <= tt) return guard === null;
	return receipt.sourceEpoch >= receipt.frontierAdmissionEpoch && receipt.sourceEpoch <= receipt.frontierCurrentEpoch - windowEpochs &&
		(guard === null ? receipt.sourceSequence === (tt ?? -1) + 1 : guard <= receipt.sourceSequence);
}

/**
 * Verifies the detached Ed25519 signature of a replaced-source receipt by its own source author.
 * @param exactCanonicalReceiptBytes - Exact closed canonical receipt bytes.
 * @param signature - Detached 64-byte signature.
 * @param windowEpochs - The settlement window.
 * @returns The opened receipt when the signature verifies.
 */
export function verifyCreatorReplacedSourceReceipt(exactCanonicalReceiptBytes: Uint8Array, signature: Uint8Array,
	windowEpochs = 4): CreatorReplacedSourceReceipt | undefined {
	const receipt = openCreatorReplacedSourceReceipt(exactCanonicalReceiptBytes, windowEpochs);
	if (receipt === undefined || !(signature instanceof Uint8Array) || signature.byteLength !== 64) return undefined;
	try {
		const publicKey = Uint8Array.from(receipt.sourceAuthor.match(/../gu)!.map(byte => Number.parseInt(byte, 16)));
		return verifyEd25519(signature, creatorSourceExpiryDigest(exactCanonicalReceiptBytes), publicKey) ? receipt : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The receipt kinds the owned source-author signing request admits (an expiry or a replaced-source
 * resolution), opened structurally.
 * @param exactCanonicalReceiptBytes - Candidate receipt bytes.
 * @returns The author of an admissible receipt, or undefined.
 */
export function openCreatorSourceAuthorReceiptAuthor(exactCanonicalReceiptBytes: unknown): string | undefined {
	return (openCreatorSourceExpiryReceipt(exactCanonicalReceiptBytes) ?? openCreatorReplacedSourceReceipt(exactCanonicalReceiptBytes))?.sourceAuthor;
}

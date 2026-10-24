import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { expect, it } from "vitest";
import {
	consumeOwnedSigningRequest,
	withAuthoredCreatorSelectionSigningRequest,
	withAuthoredSourceExpirySigningRequest,
} from "../packages/protocol-v3/src/internal/owned-signing-request.js";
import {
	CREATOR_SOURCE_EXPIRY_DOMAIN,
	creatorSourceExpiryFields,
	openCreatorSourceExpiryReceipt,
	verifyCreatorSourceExpiryReceipt,
} from "../packages/protocol-v3/src/internal/creator-source-expiry.js";

const seed = new Uint8Array(32).fill(9), key = ed25519.getPublicKey(seed);
const author = Buffer.from(key).toString("hex");
const receipt = (overrides: Record<string, unknown> = {}) => ({...creatorSourceExpiryFields({
	objectId: "creator:expiry-unit", pinnedGenesisAnchorDigest: "a".repeat(64), sourceAuthor: author,
	sourceSequence: 3, sourceDigest: new Uint8Array(32).fill(1), sourceContextDigest: new Uint8Array(32).fill(2),
	signingEpoch: 2, signingAnchorDigest: "b".repeat(64), signingNativeHeadDigest: new Uint8Array(32).fill(3),
	signingFloorDigest: new Uint8Array(32).fill(4)}), ...overrides});
const capture = async (bytes: Uint8Array, signerPublicKey = key) =>
	withAuthoredSourceExpirySigningRequest({exactCanonicalReceiptBytes: bytes, signerPublicKey}, async request => {
		const captured = consumeOwnedSigningRequest(request);
		expect(consumeOwnedSigningRequest(request)).toBeUndefined();
		return captured;
	});

it("authors a typed one-use source-expiry request whose digest it computes itself", async () => {
	const bytes = encodeCanonical(receipt());
	const captured = await capture(bytes);
	expect(captured?.kind).toBe("source-expiry");
	expect(captured?.digest).toEqual(hashDomain("ts-drp/settlement-source-expiry/v1", bytes));
	expect(CREATOR_SOURCE_EXPIRY_DOMAIN).toBe("ts-drp/settlement-source-expiry/v1");
	expect(captured?.publicKey).toEqual(key);
	expect(openCreatorSourceExpiryReceipt(bytes)).toMatchObject({sourceAuthor: author, sourceSequence: 3, signingEpoch: 2});
	// Domain separated from the creator source-selection request over the same bytes.
	const selection = await withAuthoredCreatorSelectionSigningRequest({exactCanonicalSelectionBytes: bytes, signerPublicKey: key},
		async request => consumeOwnedSigningRequest(request));
	expect(selection?.kind).toBe("creator-selection");
	expect(Buffer.from(selection!.digest).equals(Buffer.from(captured!.digest))).toBe(false);
});

it("refuses non-canonical, open, foreign-author, retyped and completion bytes and any supplied digest", async () => {
	const bytes = encodeCanonical(receipt());
	const refusals: Uint8Array[] = [
		Uint8Array.from([...bytes, 0]),
		encodeCanonical({...receipt(), extra: 1}),
		encodeCanonical(receipt({sourceAuthor: "c".repeat(64)})),
		encodeCanonical(receipt({sourceDigest: "01".repeat(32)})),
		encodeCanonical(receipt({sourceSequence: -1})),
		encodeCanonical(receipt({version: 2})),
		encodeCanonical(receipt({signingNativeHeadDigest: new Uint8Array(31)})),
		encodeCanonical({kind: "creator-settlement-source-completion-1", version: 1, exactCanonicalCutValueBytes: Uint8Array.of(1),
			exactCanonicalCommitQcBytes: Uint8Array.of(1), exactCanonicalSuccessorTrustStateRecordBytes: Uint8Array.of(1),
			exactCanonicalMembershipSubsetBytes: Uint8Array.of(1)}),
	];
	for (const value of refusals) await expect(capture(value)).rejects.toThrow("OWNED_SOURCE_EXPIRY_RECEIPT_INVALID");
	await expect(capture(bytes, ed25519.getPublicKey(new Uint8Array(32).fill(8)))).rejects.toThrow("OWNED_SOURCE_EXPIRY_RECEIPT_INVALID");
	await expect((async () => withAuthoredSourceExpirySigningRequest({exactCanonicalReceiptBytes: bytes, signerPublicKey: key,
		digest: new Uint8Array(32)} as never, async () => undefined))()).rejects.toThrow("OWNED_SOURCE_EXPIRY_RECEIPT_INVALID");
});

it("verifies the detached receipt signature against its own source author only", () => {
	const bytes = encodeCanonical(receipt());
	const signature = ed25519.sign(hashDomain(CREATOR_SOURCE_EXPIRY_DOMAIN, bytes), seed);
	expect(verifyCreatorSourceExpiryReceipt(bytes, signature)).toMatchObject({sourceAuthor: author});
	const flipped = Uint8Array.from(signature); flipped[0]! ^= 1;
	expect(verifyCreatorSourceExpiryReceipt(bytes, flipped)).toBeUndefined();
	const selectionSigned = ed25519.sign(hashDomain("ts-drp/settlement-source-selection/v1", bytes), seed);
	expect(verifyCreatorSourceExpiryReceipt(bytes, selectionSigned)).toBeUndefined();
	const foreign = encodeCanonical(receipt({sourceAuthor: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(8))).toString("hex")}));
	expect(verifyCreatorSourceExpiryReceipt(foreign, ed25519.sign(hashDomain(CREATOR_SOURCE_EXPIRY_DOMAIN, foreign), seed))).toBeUndefined();
	expect(verifyCreatorSourceExpiryReceipt(bytes, signature.subarray(0, 63))).toBeUndefined();
});

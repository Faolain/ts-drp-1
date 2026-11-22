import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { afterEach, expect, it } from "vitest";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { creatorSourceExpiryFields } from "../packages/protocol-v3/src/internal/creator-source-expiry.js";
import {
	captureCreatorSourceContext,
	captureCreatorSourceExpiry,
	creatorSourceCustodyGeometryForSizing,
	openCreatorSourceCompletion,
	openCreatorSourceCustody,
	openCreatorSourceExpiry,
} from "../packages/node/src/internal/creator-source-custody.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

it("authenticates exactly the source author's signed expiry of its own retained source", async () => {
	const fixture = await chatSharesRoomFixture({ members: ["genesis", "genesis"], format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes });
	await fixture.open(0); await fixture.open(1);
	const base = await fixture.readHead(1);
	const trustBytes = required(base.candidates.find(candidate => candidate.ref.digest === base.trustRef.digest)).bytes;
	const opened = openCurrentAnchorTrust({ exactCanonicalTrustStateRecordBytes: trustBytes,
		expectedObjectId: fixture.objectId, pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest });
	if (!opened.ok) throw new TypeError(opened.reason);
	const trust = opened.trust, acl = fixture.invite.exactCanonicalLatchedAclBytes;
	const blueprintDigest = String(Reflect.get(decodeCanonical(fixture.invite.exactCanonicalGenesisAnchorPreimageBytes) as object, "blueprintDigest"));
	const context = captureCreatorSourceContext(trust, acl, blueprintDigest, fixture.invite.exactCanonicalParametersCarrierBytes);
	const source = required(openCreatorSourceCustody({ currentTrust: trust, context }));
	const writer = required(fixture.identities[1]), other = required(fixture.identities[2]);
	const expected = { sourceAuthor: writer.author, sourceSequence: 4, sourceDigest: new Uint8Array(32).fill(6) };
	const fields = (overrides: Record<string, unknown> = {}) => ({ ...creatorSourceExpiryFields({ objectId: fixture.objectId,
		pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest, sourceAuthor: expected.sourceAuthor,
		sourceSequence: expected.sourceSequence, sourceDigest: expected.sourceDigest, sourceContextDigest: context.digest,
		signingEpoch: 1, signingAnchorDigest: "d".repeat(64), signingNativeHeadDigest: new Uint8Array(32).fill(7),
		signingFloorDigest: new Uint8Array(32).fill(8) }), ...overrides });
	const signed = (overrides: Record<string, unknown> = {}, seed = writer.seed) => {
		const bytes = encodeCanonical(fields(overrides));
		return captureCreatorSourceExpiry(bytes, ed25519.sign(hashDomain("ts-drp/settlement-source-expiry/v1", bytes), seed));
	};
	const genuine = signed();
	expect(genuine.digest).toEqual(hashDomain("ts-drp/settlement-source-context/v1", genuine.exactCanonicalContextBytes));
	expect(openCreatorSourceExpiry(source, genuine, expected)).toMatchObject({ sourceAuthor: writer.author, sourceSequence: 4, signingEpoch: 1 });
	// The reserved native width bounds the real receipt carrier.
	const geometry = required(creatorSourceCustodyGeometryForSizing(trust, acl, 8192));
	expect(genuine.exactCanonicalContextBytes.byteLength).toBeLessThanOrEqual(geometry.maxExpiryByteLength);
	// Forgeries and mismatches.
	const wrapper = decodeCanonical(genuine.exactCanonicalContextBytes) as Record<string, unknown>;
	const flipped = Uint8Array.from(wrapper.detachedSignature as Uint8Array); flipped[0]! ^= 1;
	const rewrap = (value: Record<string, unknown>) => { const bytes = encodeCanonical(value);
		return { digest: hashDomain("ts-drp/settlement-source-context/v1", bytes), exactCanonicalContextBytes: bytes }; };
	expect(openCreatorSourceExpiry(source, rewrap({ ...wrapper, detachedSignature: flipped }), expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, { ...genuine, digest: new Uint8Array(32) }, expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, rewrap({ ...wrapper, extra: 1 }), expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, rewrap({ ...wrapper, version: 2 }), expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, genuine, { ...expected, sourceSequence: 5 })).toBeUndefined();
	expect(openCreatorSourceExpiry(source, genuine, { ...expected, sourceDigest: new Uint8Array(32).fill(9) })).toBeUndefined();
	expect(openCreatorSourceExpiry(source, genuine, { ...expected, sourceAuthor: other.author })).toBeUndefined();
	expect(openCreatorSourceExpiry(source, signed({ sourceDigest: new Uint8Array(32).fill(9) }), expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, signed({ sourceContextDigest: new Uint8Array(32).fill(1) }), expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, signed({ objectId: "creator:other-room" }), expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, signed({ pinnedGenesisAnchorDigest: "e".repeat(64) }), expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, signed({ signingEpoch: 0 }), expected)).toBeUndefined();
	// Another enrolled member cannot sign this author's expiry, nor the creator.
	expect(openCreatorSourceExpiry(source, signed({}, other.seed), expected)).toBeUndefined();
	expect(openCreatorSourceExpiry(source, signed({}, required(fixture.identities[0]).seed), expected)).toBeUndefined();
	// An author absent from the historical ACL is refused even with its own key.
	const outsiderSeed = new Uint8Array(32).fill(0x7a), outsider = Buffer.from(ed25519.getPublicKey(outsiderSeed)).toString("hex");
	expect(openCreatorSourceExpiry(source, signed({ sourceAuthor: outsider }, outsiderSeed), { ...expected, sourceAuthor: outsider })).toBeUndefined();
	// Completion and expiry are distinct resolution kinds.
	const completion = rewrap({ kind: "creator-settlement-source-completion-1", version: 1, exactCanonicalCutValueBytes: Uint8Array.of(1),
		exactCanonicalCommitQcBytes: Uint8Array.of(1), exactCanonicalSuccessorTrustStateRecordBytes: Uint8Array.of(1),
		exactCanonicalMembershipSubsetBytes: Uint8Array.of(1) });
	expect(openCreatorSourceExpiry(source, completion, expected)).toBeUndefined();
	expect(await openCreatorSourceCompletion(source, genuine)).toBeUndefined();
	expect(() => captureCreatorSourceExpiry(encodeCanonical(fields()), new Uint8Array(63))).toThrow();
}, 120_000);

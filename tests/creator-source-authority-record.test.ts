import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { afterEach, expect, it } from "vitest";

import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { SETTLEMENT_SOURCE_AUTHORITY_LIMITS } from "../packages/issuance-store/src/types.js";
import {
	captureCreatorSourceContext,
	CREATOR_SOURCE_CONTEXT_MAX_BYTES,
	creatorSourceCustodyGeometryForSizing,
	openCreatorSourceAuthority,
} from "../packages/node/src/internal/creator-source-custody.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

// fix/browser-rollover-member-stall (cold reopen): a settlement source-authority record's bytes are one
// creator source context of the source epoch (its anchor, the creator's signature, ACL and parameters).
// Node reopens them on every plane (G5) against the plane's current trust: the anchor by the fixed
// creator signer, the ACL by the anchor's aclDigest. A tampered record opens nothing, so its row has no
// authority (as before the record existed). Its width is within the open context width the issuance
// sizing charges for the potential record (G22).
it("authenticates a source-authority record against the current trust and refuses tampered bytes", async () => {
	const fixture = await chatSharesRoomFixture({
		members: ["genesis", "genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	await fixture.open(0);
	await fixture.open(1);
	const base = await fixture.readHead(1);
	const trustBytes = required(base.candidates.find((candidate) => candidate.ref.digest === base.trustRef.digest)).bytes;
	const opened = openCurrentAnchorTrust({
		exactCanonicalTrustStateRecordBytes: trustBytes,
		expectedObjectId: fixture.objectId,
		pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
	});
	if (!opened.ok) throw new TypeError(opened.reason);
	const trust = opened.trust,
		acl = fixture.invite.exactCanonicalLatchedAclBytes;
	const blueprintDigest = String(
		Reflect.get(decodeCanonical(fixture.invite.exactCanonicalGenesisAnchorPreimageBytes) as object, "blueprintDigest")
	);
	const bytes = captureCreatorSourceContext(
		trust,
		acl,
		blueprintDigest,
		fixture.invite.exactCanonicalParametersCarrierBytes
	).exactCanonicalContextBytes;
	const genuine = required(openCreatorSourceAuthority(trust, bytes, blueprintDigest));
	expect(genuine.trust.currentEpoch).toBe(trust.currentEpoch);
	expect(genuine.trust.currentAnchorDigest).toBe(trust.currentAnchorDigest);
	expect(encodeCanonical(genuine.acl)).toEqual(acl);
	// Sizing domination: the record is within the open context width charged for it.
	const geometry = required(creatorSourceCustodyGeometryForSizing(trust, acl, 8192));
	expect(bytes.byteLength).toBeLessThanOrEqual(geometry.maxContextByteLength);
	// Every genuine context fits the store's record bound.
	expect(CREATOR_SOURCE_CONTEXT_MAX_BYTES).toBeLessThanOrEqual(SETTLEMENT_SOURCE_AUTHORITY_LIMITS.maxBytes);
	// Another blueprint, a flipped byte anywhere, a forged signature or ACL: nothing opens.
	expect(openCreatorSourceAuthority(trust, bytes, "f".repeat(64))).toBeUndefined();
	const wrapper = decodeCanonical(bytes) as Record<string, unknown>;
	const rewrap = (value: Record<string, unknown>) => encodeCanonical(value);
	const flipped = (field: string) => {
		const value = Uint8Array.from(wrapper[field] as Uint8Array);
		value[value.byteLength - 1]! ^= 1;
		return rewrap({ ...wrapper, [field]: value });
	};
	for (const field of ["anchorPreimage", "anchorSignature", "aclBytes", "parametersBytes"])
		expect(openCreatorSourceAuthority(trust, flipped(field), blueprintDigest), field).toBeUndefined();
	expect(openCreatorSourceAuthority(trust, rewrap({ ...wrapper, extra: 1 }), blueprintDigest)).toBeUndefined();
	expect(openCreatorSourceAuthority(trust, rewrap({ ...wrapper, version: 2 }), blueprintDigest)).toBeUndefined();
	expect(openCreatorSourceAuthority(trust, new Uint8Array(0), blueprintDigest)).toBeUndefined();
}, 120_000);

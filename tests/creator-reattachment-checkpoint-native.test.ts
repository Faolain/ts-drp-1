import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { ed25519 } from "@noble/curves/ed25519.js";
import { openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { afterEach, describe, expect, it } from "vitest";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { openCreatorCheckpointTrust, encodeCreatorReattachmentCheckpoint, decodeCreatorReattachmentCheckpoint } from "../packages/protocol-v3/src/creator-checkpoint.js";
import { openCreatorCheckpointAttachment, resolveCreatorCheckpointAttachment } from "../packages/node/src/internal/creator-transition-advance.js";
import { receiveCreatorSuccessorMaterial } from "../packages/node/src/internal/creator-successor-transport.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

describe("native current-checkpoint reattachment proof", () => {
	it("exports bounded current authority after a gap and rejects signed-carrier substitutions", async () => {
		const fixture = await chatSharesRoomFixture({ members: ["genesis"], format: "window",
			genesisStateBytes: createShippingChatWindowGenesisStateBytes });
		const creator = await fixture.open(0);
		await fixture.open(1);
		const localBase = await fixture.readHead(1);
		const localTrustBytes = required(localBase.candidates.find(candidate => candidate.ref.digest === localBase.trustRef.digest)).bytes;
		const local = openCurrentAnchorTrust({ exactCanonicalTrustStateRecordBytes: localTrustBytes,
			expectedObjectId: fixture.objectId, pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest });
		if (!local.ok) throw new TypeError(`local genesis trust unavailable: ${local.reason}`);
		for (let epoch = 0; epoch < 2; epoch++) {
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		}
		const exported = await fixture.readExport();
		const carrierBytes = Reflect.get(exported.material, "exactCanonicalReattachmentCheckpointBytes");
		expect(carrierBytes).toBeInstanceOf(Uint8Array);
		expect(carrierBytes.byteLength).toBeLessThanOrEqual(106_686);
		const carrier = decodeCanonical(carrierBytes) as Record<string, unknown>;
		expect(carrier).toMatchObject({ kind: "creator-reattachment-checkpoint-1", version: 1,
			exactCanonicalPredecessorTrustStateRecordBytes: expect.any(Uint8Array),
			exactCanonicalPredecessorAclBytes: expect.any(Uint8Array),
			exactCanonicalPredecessorSettlementBytes: expect.any(Uint8Array) });
		const trust = decodeCanonical(exported.offer.exactCanonicalTrustStateRecordBytes) as Record<string, unknown>;
		const input = {
			detachedGenesisSignature: fixture.invite.detachedGenesisSignature,
			exactCanonicalGenesisAnchorPreimageBytes: fixture.invite.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalCommitQcBytes: exported.offer.exactCanonicalCommitQcBytes,
			exactCanonicalCurrentTrustStateRecordBytes: exported.offer.exactCanonicalTrustStateRecordBytes,
			exactCanonicalCutValueBytes: exported.offer.exactCanonicalCutValueBytes,
			exactCanonicalPredecessorTrustStateRecordBytes: carrier.exactCanonicalPredecessorTrustStateRecordBytes,
			expectedCurrentHead: { objectId: fixture.objectId, epoch: trust.currentEpoch,
				currentAnchorDigest: trust.currentAnchorDigest },
			expectedObjectId: fixture.objectId,
			pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
		};
		expect(openCreatorCheckpointTrust(input)).toMatchObject({ ok: true,
			predecessorTrust: { currentEpoch: 1 }, currentTrust: { currentEpoch: 2 } });
		expect(openCreatorCheckpointTrust({ ...input, pinnedGenesisAnchorDigest: "00".repeat(32) }).ok).toBe(false);
		const predecessor = decodeCanonical(carrier.exactCanonicalPredecessorTrustStateRecordBytes as Uint8Array) as Record<string, unknown>;
		expect(openCreatorCheckpointTrust({ ...input,
			exactCanonicalPredecessorTrustStateRecordBytes: encodeCanonical({ ...predecessor, currentEpoch: 0 }) }).ok).toBe(false);
		const cut = decodeCanonical(input.exactCanonicalCutValueBytes) as Record<string, unknown>;
		expect(openCreatorCheckpointTrust({ ...input,
			exactCanonicalCutValueBytes: encodeCanonical({ ...cut, snapshotManifestDigest: "00".repeat(32) }) }).ok).toBe(false);

		const payload = Uint8Array.from(Buffer.concat(exported.chunks));
		const attachmentInput = { localBaseHead: localBase.head, localTrust: local.trust,
			exactCanonicalGenesisAnchorPreimageBytes: fixture.invite.exactCanonicalGenesisAnchorPreimageBytes,
			detachedGenesisSignature: fixture.invite.detachedGenesisSignature,
			exactCanonicalReattachmentCheckpointBytes: carrierBytes,
			...exported.offer, exactCanonicalSnapshotPayloadBytes: payload,
			exactCanonicalSettlementBytes: exported.material.exactCanonicalSettlementBytes };
		const attachment = openCreatorCheckpointAttachment(attachmentInput);
		expect(attachment).toMatchObject({ ok: true });
		if (!attachment.ok) throw new TypeError(attachment.reason);
		expect(resolveCreatorCheckpointAttachment(attachment.capability)).toMatchObject({ kind: "checkpoint",
			sourceClassification: "unknown", localBase: { head: localBase.head, trust: { currentEpoch: 0 } },
			remoteCheckpoint: { predecessorTrust: { currentEpoch: 1 } }, target: { trust: { currentEpoch: 2 } } });
		expect(resolveCreatorCheckpointAttachment({})).toBeUndefined();
		const point = required(decodeCreatorReattachmentCheckpoint(carrierBytes));
		const predecessorAcl = decodeCanonical(point.exactCanonicalPredecessorAclBytes) as Record<string, unknown>;
		const predecessorSettlement = decodeCanonical(point.exactCanonicalPredecessorSettlementBytes) as Record<string, unknown>;
		const settlement = decodeCanonical(required(exported.material.exactCanonicalSettlementBytes)) as Record<string, unknown>;
		for (const change of [
			{ localTrust: { ...local.trust } },
			{ localBaseHead: { ...localBase.head, objectId: "creator:alien" } },
			{ exactCanonicalReattachmentCheckpointBytes: encodeCreatorReattachmentCheckpoint({ ...point,
				exactCanonicalPredecessorAclBytes: encodeCanonical({ ...predecessorAcl, epoch: 0 }) }) },
			{ exactCanonicalReattachmentCheckpointBytes: encodeCreatorReattachmentCheckpoint({ ...point,
				exactCanonicalPredecessorSettlementBytes: encodeCanonical({ ...predecessorSettlement, frontiers: [] }) }) },
			{ exactCanonicalSettlementBytes: encodeCanonical({ ...settlement, frontiers: [] }) },
			{ exactCanonicalSnapshotPayloadBytes: Uint8Array.from([...payload.slice(0, -1), payload[payload.length - 1]! ^ 1]) },
			{ localTrust: required(resolveCreatorCheckpointAttachment(attachment.capability)).target.trust },
		]) expect(openCreatorCheckpointAttachment({ ...attachmentInput, ...change }).ok).toBe(false);

		const transfer = await fixture.successorDelivery(1);
		const recipient = required(fixture.identities[1]), sender = required(fixture.identities[0]);
		const received = await receiveCreatorSuccessorMaterial({ transport: transfer.port, peers: transfer.peers,
			manifestDigest: exported.declaration.scope.manifestDigest, materialKind: "checkpoint",
			identity: { author: recipient.author, sign: digest => Promise.resolve(ed25519.sign(digest, recipient.seed)),
				isAuthorizedAuthor: author => author === sender.author } });
		expect(received.exactCanonicalReattachmentCheckpointBytes).toEqual(carrierBytes);
		expect(received.exactCanonicalCloseMembershipBytes).toBeUndefined();
	}, 120_000);
});

import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { ed25519 } from "@noble/curves/ed25519.js";
import { openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { afterEach, describe, expect, it } from "vitest";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { openCreatorCheckpointTrust, encodeCreatorReattachmentCheckpoint, decodeCreatorReattachmentCheckpoint } from "../packages/protocol-v3/src/creator-checkpoint.js";
import { openCreatorCheckpointAttachment, resolveCreatorCheckpointAttachment, inspectCreatorCheckpointTransition, CREATOR_CHECKPOINT_PROOF_MAX_BYTES, reconstructCreatorReattachmentCheckpoint, openCreatorSnapshotRecoverySourceTrust } from "../packages/node/src/internal/creator-transition-advance.js";
import { CreatorCheckpointMaterialUnavailable, receiveCreatorSuccessorMaterial } from "../packages/node/src/internal/creator-successor-transport.js";
import { captureCreatorSourceContext, openCreatorSourceCustody, resolveCreatorSourceCustody } from "../packages/node/src/internal/creator-source-custody.js";
import { AHE_BOUNDED_READ_LIMITS, digestBlob, encodeHeadRecordV1 } from "@ts-drp/storage";
import { SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES } from "@ts-drp/storage/snapshot-transfer";
import { openReceivedCertificate } from "../packages/node/src/creator-adoption.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

describe("native current-checkpoint reattachment proof", () => {
	it("fits the maximum compact proof in the existing seventh native reference", () => {
		const proof = encodeCanonical({kind: "creator-reattachment-proof-1", version: 1,
			exactCanonicalPredecessorTrustStateRecordBytes: new Uint8Array(8192),
			exactCanonicalPredecessorSettlementBytes: new Uint8Array(32768)});
		expect(proof.byteLength).toBe(CREATOR_CHECKPOINT_PROOF_MAX_BYTES);
		expect(proof.byteLength).toBeLessThanOrEqual(AHE_BOUNDED_READ_LIMITS.maxBlobBytes);
	});
	it("serves adjacent sealed material and retries a typed gap refusal through creator recovery", async () => {
		const fixture = await chatSharesRoomFixture({ members: ["genesis"], format: "window",
			genesisStateBytes: createShippingChatWindowGenesisStateBytes });
		let creator = await fixture.open(0);
		await fixture.open(1);
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		const sealed = await fixture.readExport();
		expect(sealed.material.exactCanonicalReattachmentCheckpointBytes).toBeUndefined();
		let delivery = await fixture.successorDelivery(1);
		const recipient = required(fixture.identities[1]), sender = required(fixture.identities[0]);
		const identity = { author: recipient.author, sign: (digest: Uint8Array) => Promise.resolve(ed25519.sign(digest, recipient.seed)),
			isAuthorizedAuthor: (author: string) => author === sender.author };
		const common = { identity, peers: delivery.peers, manifestDigest: sealed.declaration.scope.manifestDigest };
		expect((await receiveCreatorSuccessorMaterial({ ...common, transport: delivery.port })).exactCanonicalSettlementBytes)
			.toEqual(sealed.material.exactCanonicalSettlementBytes);
		try {
			await receiveCreatorSuccessorMaterial({ ...common, transport: delivery.port, materialKind: "checkpoint" });
			throw new Error("missing checkpoint appeared available");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).cause).toBeInstanceOf(CreatorCheckpointMaterialUnavailable);
			expect((error as AggregateError).cause).toMatchObject({ code: "creator-checkpoint-not-adopted", retryClass: "transient" });
		}
		let unavailableObserved!: () => void;
		const unavailable = new Promise<void>(resolve => { unavailableObserved = resolve; });
		let attempts = 0;
		const transport = { ...delivery.port, open: async (...args: Parameters<typeof delivery.port.open>) => {
			attempts++;
			const stream = await delivery.port.open(...args);
			return { ...stream, read: async (...readArgs: Parameters<typeof stream.read>) => {
				const bytes = await stream.read(...readArgs);
				if (Reflect.get(decodeCanonical(bytes) as object, "kind") === "creator-successor-material-unavailable") unavailableObserved();
				return bytes;
			} };
		} };
		const lifetime = new AbortController();
		const timer = setTimeout(() => lifetime.abort(new Error("checkpoint adoption retry timed out")), 20_000);
		const pending = receiveCreatorSuccessorMaterial({ ...common, transport, materialKind: "checkpoint", retryUntil: lifetime.signal });
		try {
			await unavailable;
			await fixture.stop(creator);
			creator = await fixture.open(0, { reopen: true });
			expect(creator.room.authority()?.epoch).toBe(2);
			delivery = await fixture.successorDelivery(1);
			expect(delivery.offer).toEqual(sealed.offer);
			const received = await pending;
			expect(received.exactCanonicalReattachmentCheckpointBytes).toBeInstanceOf(Uint8Array);
			expect(received.exactCanonicalCloseMembershipBytes).toBeUndefined();
			expect(attempts).toBeGreaterThan(1);
		} finally { clearTimeout(timer); lifetime.abort(); await pending.catch(() => undefined); }
	}, 120_000);

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
		const localAcl = fixture.invite.exactCanonicalLatchedAclBytes;
		const blueprintDigest = String(Reflect.get(decodeCanonical(fixture.invite.exactCanonicalGenesisAnchorPreimageBytes) as object, "blueprintDigest"));
		const sourceContext = captureCreatorSourceContext(local.trust, localAcl, blueprintDigest, fixture.invite.exactCanonicalParametersCarrierBytes);
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
		const targetTrust = required(resolveCreatorCheckpointAttachment(attachment.capability)).target.trust;
		const boundPoint = required(resolveCreatorCheckpointAttachment(attachment.capability));
		const compact = required(boundPoint.proofCandidates.find(candidate =>
			Reflect.get(decodeCanonical(candidate.bytes) as object, "kind") === "creator-reattachment-proof-1"));
		const aclBytes = carrier.exactCanonicalPredecessorAclBytes as Uint8Array, aclDigest = digestBlob(aclBytes);
		if (!aclDigest.ok) throw new TypeError("ACL reference unavailable");
		const reconstructed = [compact, {bytes: aclBytes, ref: {digest: aclDigest.value, byteLength: aclBytes.byteLength}}];
		const reconstruction = [...reconstructed, required(boundPoint.proofCandidates.find(candidate =>
			Reflect.get(decodeCanonical(candidate.bytes) as object, "kind") === "drp-anchor-trust-state"))];
		expect(reconstructCreatorReattachmentCheckpoint({candidates: reconstruction, closure: reconstruction.map(row => row.ref)})).toEqual(carrierBytes);
		expect(reconstructCreatorReattachmentCheckpoint({candidates: reconstructed, closure: reconstructed.map(row => row.ref)})).toBeUndefined();
		expect(boundPoint.proofCandidates.every(row => row.bytes.byteLength <= AHE_BOUNDED_READ_LIMITS.maxBlobBytes)).toBe(true);
		expect(boundPoint.proofCandidates.filter(row => Reflect.get(decodeCanonical(row.bytes) as object, "kind") === "drp-anchor-trust-state")).toHaveLength(1);
		const creatorHead = await fixture.readHead(0), remoteProjection = required(creatorHead.candidates.find(row =>
			Reflect.get(decodeCanonical(row.bytes) as object, "kind") === "v3-live-generation-2"));
		const retainedCandidates = [...boundPoint.proofCandidates, remoteProjection, reconstructed[1]!];
		const retained = {candidates: retainedCandidates, closure: retainedCandidates.map(row => row.ref)};
		expect(openCreatorSnapshotRecoverySourceTrust({currentTrust: targetTrust, closure: retained, anchorChain: [],
			exactCanonicalPinnedGenesisTrustStateRecordBytes: localTrustBytes})).toMatchObject({ok: true,
			trust: {currentEpoch: 2}, predecessorTrust: {currentEpoch: 1}});
		const corruptProofRecord = decodeCanonical(compact.bytes) as Record<string, unknown>;
		const corruptSettlement = new Uint8Array(corruptProofRecord.exactCanonicalPredecessorSettlementBytes as Uint8Array);
		corruptSettlement[corruptSettlement.length - 1] ^= 1;
		const corruptProof = encodeCanonical({...corruptProofRecord, exactCanonicalPredecessorSettlementBytes: corruptSettlement});
		const corruptDigest = digestBlob(corruptProof); if (!corruptDigest.ok) throw new TypeError("proof digest unavailable");
		const corrupted = retainedCandidates.map(row => row === compact ? {bytes: corruptProof,
			ref: {digest: corruptDigest.value, byteLength: corruptProof.byteLength}} : row);
		expect(openCreatorSnapshotRecoverySourceTrust({currentTrust: targetTrust,
			closure: {candidates: corrupted, closure: corrupted.map(row => row.ref)}, anchorChain: [],
			exactCanonicalPinnedGenesisTrustStateRecordBytes: localTrustBytes}).ok).toBe(false);
		const historyBytes = exported.material.exactCanonicalHistoryBytes;
		const historyRef = digestBlob(historyBytes);
		if (!historyRef.ok) throw new TypeError("history reference unavailable");
		const localProjection = required(localBase.candidates.find(candidate =>
			Reflect.get(decodeCanonical(candidate.bytes) as object, "kind") === "v3-live-generation-1"));
		const pointCandidates = [...boundPoint.proofCandidates, localProjection,
			{bytes: historyBytes, ref: {digest: historyRef.value, byteLength: historyBytes.byteLength}}]
			.sort((a,b) => a.ref.digest.localeCompare(b.ref.digest));
		const transitionInput = {checkpoint: attachment.capability, localHead: localBase.head, currentTrust: local.trust,
			current: {candidates: localBase.candidates, closure: localBase.references},
			proposed: {candidates: pointCandidates, closure: pointCandidates.map(candidate => candidate.ref)}};
		expect(pointCandidates).toHaveLength(AHE_BOUNDED_READ_LIMITS.maxClosureReferences);
		expect(inspectCreatorCheckpointTransition(transitionInput)).toBe(true);
		expect(inspectCreatorCheckpointTransition({...transitionInput, checkpoint: {}})).toBe(false);
		expect(inspectCreatorCheckpointTransition({...transitionInput, currentTrust: targetTrust})).toBe(false);
		expect(inspectCreatorCheckpointTransition({...transitionInput, localHead: {...localBase.head, revision: localBase.head.revision + 1}})).toBe(false);
		expect(inspectCreatorCheckpointTransition({...transitionInput,
			proposed: {candidates: pointCandidates.slice(1), closure: pointCandidates.slice(1).map(candidate => candidate.ref)}})).toBe(false);
		const receipt = {kind: "creator-received-checkpoint-certificate-1", pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
			exactCanonicalOldHeadBytes: encodeHeadRecordV1(localBase.head), currentTrustRef: localBase.trustRef,
			exactCanonicalCutValueBytes: exported.offer.exactCanonicalCutValueBytes,
			exactCanonicalCommitQcBytes: exported.offer.exactCanonicalCommitQcBytes,
			exactCanonicalTrustStateRecordBytes: exported.offer.exactCanonicalTrustStateRecordBytes,
			exactCanonicalSettlementBytes: exported.material.exactCanonicalSettlementBytes,
			exactCanonicalHistoryBytes: historyBytes, exactCanonicalReattachmentCheckpointBytes: carrierBytes,
			sealedReplayDigest: "00".repeat(32), sealedReplayRowCount: 0, sealedReplayByteCharge: 0,
			candidateGenerationId: localBase.head.generationId, candidateClosureDigest: localBase.head.closureDigest};
		const receiptBytes = encodeCanonical(receipt);
		expect(receiptBytes.byteLength).toBeLessThanOrEqual(SNAPSHOT_RECEIVED_CERTIFICATE_MAX_BYTES);
		expect(openReceivedCertificate(receiptBytes)).toEqual(receipt);
		expect(() => openReceivedCertificate(encodeCanonical({...receipt, kind: "creator-received-recovery-certificate-1"}))).toThrow();
		expect(() => openReceivedCertificate(encodeCanonical({...receipt, exactCanonicalSettlementBytes: null}))).toThrow();
		const sourceCustody = required(openCreatorSourceCustody({currentTrust: targetTrust, context: sourceContext,
			expectedBlueprintDigest: blueprintDigest}));
		expect(resolveCreatorSourceCustody(sourceCustody)?.trust).toMatchObject({currentEpoch: 0, currentAnchorDigest: local.trust.currentAnchorDigest});
		expect(resolveCreatorSourceCustody({})).toBeUndefined();
		const sourceFields = decodeCanonical(sourceContext.exactCanonicalContextBytes) as Record<string, unknown>;
		const sourceParameters = encodeCanonical({...decodeCanonical(fixture.invite.exactCanonicalParametersCarrierBytes) as object,
			maxDependencies: 8});
		const signedSourceAnchor = encodeCanonical({...decodeCanonical(predecessor.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array) as object,
			parametersDigest: Buffer.from(hashDomain("ts-drp/parameters/v3", sourceParameters)).toString("hex")});
		const signedSourceFields = {...sourceFields, anchorPreimage: signedSourceAnchor,
			anchorSignature: ed25519.sign(hashDomain("ts-drp/epoch-anchor/v3", signedSourceAnchor), required(fixture.identities[0]).seed),
			aclBytes: carrier.exactCanonicalPredecessorAclBytes, parametersBytes: sourceParameters};
		const signedContext = (fields: Record<string, unknown>) => {
			const exactCanonicalContextBytes = encodeCanonical(fields);
			return {exactCanonicalContextBytes, digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes)};
		};
		const distinctSource = required(openCreatorSourceCustody({currentTrust: targetTrust, context: signedContext(signedSourceFields)}));
		expect(resolveCreatorSourceCustody(distinctSource)?.exactCanonicalParametersBytes).toEqual(sourceParameters);
		expect(openCreatorSourceCustody({currentTrust: targetTrust, context: signedContext({...signedSourceFields,
			parametersBytes: fixture.invite.exactCanonicalParametersCarrierBytes})})).toBeUndefined();
		const otherBlueprintAnchor = encodeCanonical({...decodeCanonical(signedSourceAnchor) as object, blueprintDigest: "ab".repeat(32)});
		const otherBlueprint = signedContext({...signedSourceFields, anchorPreimage: otherBlueprintAnchor,
			anchorSignature: ed25519.sign(hashDomain("ts-drp/epoch-anchor/v3", otherBlueprintAnchor), required(fixture.identities[0]).seed)});
		expect(resolveCreatorSourceCustody(required(openCreatorSourceCustody({currentTrust: targetTrust, context: otherBlueprint})))?.blueprintDigest)
			.toBe("ab".repeat(32));
		expect(openCreatorSourceCustody({currentTrust: targetTrust, context: otherBlueprint, expectedBlueprintDigest: blueprintDigest})).toBeUndefined();
		for (const changes of [{anchorSignature: new Uint8Array(64)}, {aclBytes: encodeCanonical({...decodeCanonical(localAcl) as object, epoch: 1})},
			{anchorPreimage: fixture.invite.exactCanonicalGenesisAnchorPreimageBytes.slice(1)},
			{parametersBytes: encodeCanonical({...decodeCanonical(fixture.invite.exactCanonicalParametersCarrierBytes) as object, maxDependencies: 1})}]) {
			const exactCanonicalContextBytes = encodeCanonical({...sourceFields, ...changes});
			expect(openCreatorSourceCustody({currentTrust: targetTrust, expectedBlueprintDigest: blueprintDigest,
				context: {exactCanonicalContextBytes, digest: hashDomain("ts-drp/settlement-source-context/v1", exactCanonicalContextBytes)}})).toBeUndefined();
		}
		expect(openCreatorSourceCustody({currentTrust: {...targetTrust}, context: sourceContext, expectedBlueprintDigest: blueprintDigest})).toBeUndefined();
		expect(openCreatorSourceCustody({currentTrust: targetTrust, context: sourceContext, expectedBlueprintDigest: "00".repeat(32)})).toBeUndefined();
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

import { encodeCanonical } from "@ts-drp/canonical";
import "fake-indexeddb/auto";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { contract } from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import { createGenuinePreparedV3Fixture } from "./fixtures/phase-3a1b-p3/live-fixture.js";
import { createRecoveryInput, fakeNetwork, recover } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { runNativeHistoricalReplacement, runNativeReplacementMissingSource } from "./fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.js";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	recoverV3LiveReplica,
	routeV3RetainedIngress,
} from "../packages/node/src/v3-live.js";

describe("Phase 4a live blueprint fold", () => {
	it("source-bound native split progress retains completed exact source through cold custody", async () => {
		const result = await runNativeHistoricalReplacement(false, false, false, false, false, false, true);
		expect(result.replacement, JSON.stringify(result)).toMatchObject({ ok: true, authorSequence: 3 });
		expect(result.finalSplitReplacement, JSON.stringify(result)).toMatchObject({ ok: true, authorSequence: 4 });
		expect(result.signerCalls).toBe(2);
		expect(result.localReopened).toBe(true);
		expect(result.plan).toMatchObject({
			entries: [
				{
					sourceSequence: 1,
					replacementSequence: 4,
					replacementProgress: {
						intentCount: 2,
						chunks: [
							{ replacementSequence: 3, throughIntent: 1 },
							{ replacementSequence: 4, throughIntent: 2 },
						],
					},
				},
			],
		});
	}, 30_000);
	 it("diagnostic portable source membership refuses newly fabricated correctly signed old-context intent",async()=>{
		const result=await runNativeHistoricalReplacement(true,false,false,false,false,true);
		console.log("native-fabricated-source-membership",JSON.stringify(result));
		expect(result.diagnostic).toEqual({journal:0,sink:0});
	},30_000);
	 it("source-bound remote former Writer fallback retains native refusal and reopens with fresh recipient admission",async()=>{
		const result=await runNativeHistoricalReplacement(true,false,false,false,true);
		console.log("native-portable-source-fallback",JSON.stringify(result));
		expect(result.persistedPreparation).toEqual(expect.objectContaining({entries:[expect.objectContaining({disposition:"transform",replacementSequence:null,transformRefusal:expect.objectContaining({kind:"admission-refused",reason:"capacity"})})]}));
		expect(result.plan).toEqual(expect.objectContaining({entries:[expect.objectContaining({disposition:"transform",replacementSequence:3,transformRefusal:expect.objectContaining({kind:"admission-refused",reason:"capacity"})})]}));
		expect((result.admission as {refusals:number;committed:number}).refusals).toBeGreaterThan(0);
		expect((result.admission as {refusals:number;committed:number}).committed).toBeGreaterThan(0);
		expect((result.admission as {targetRefusals:number}).targetRefusals).toBe(1);
		expect(result.remote,JSON.stringify(result)).toEqual(expect.objectContaining({accepted:{journal:1,sink:1},deliveredOperations:[{action:"add",value:10}],duplicate:{journal:1,sink:1},reopened:true,continuation:expect.objectContaining({ok:true})}));
		for(const outcome of Object.values((result.remote as {negativeResults:Record<string,unknown>}).negativeResults))expect(outcome).toEqual({journal:0,sink:0});
	},30_000);
	it("source-bound remote replacement joins pending graph work when fence arrives later",async()=>{
		const result=await runNativeHistoricalReplacement(true,false,false,true);
		expect(result.remote,JSON.stringify(result)).toEqual(expect.objectContaining({queued:{journal:0,sink:0},accepted:{journal:1,sink:1},duplicate:{journal:1,sink:1},reopened:true,continuation:expect.objectContaining({ok:true})}));
	},30_000);
	it("source-bound remote replacement refuses moved native whole-floor before received effects",async()=>{
		const result=await runNativeHistoricalReplacement(true,false,true);
		expect(result.remote,JSON.stringify(result)).toEqual(expect.objectContaining({staleFloor:{journal:0,sink:0,unchanged:true}}));
	},30_000);
	it("source-bound remote replacement recovers exact native commit after interrupted acknowledgement",async()=>{
		const result=await runNativeHistoricalReplacement(true,true);
		console.log("native-portable-source-interrupted",JSON.stringify(result));
		expect(result.remote,JSON.stringify(result)).toEqual(expect.objectContaining({interrupted:{journal:1,sink:0},accepted:{journal:1,sink:1},duplicate:{journal:1,sink:1},reopened:true,continuation:expect.objectContaining({ok:true})}));
		for(const outcome of Object.values((result.remote as {negativeResults:Record<string,unknown>}).negativeResults))expect(outcome).toEqual({journal:0,sink:0});
	},30_000);
	it("source-bound remote former Writer replacement persists and reopens with independent native recipient",async()=>{
		const result=await runNativeHistoricalReplacement(true);
		console.log("native-portable-source-replacement",JSON.stringify(result));
		expect(result.remote,JSON.stringify(result)).toEqual(expect.objectContaining({accepted:{journal:1,sink:1},duplicate:{journal:1,sink:1},reopened:true,continuation:expect.objectContaining({ok:true})}));
		for(const outcome of Object.values((result.remote as {negativeResults:Record<string,unknown>}).negativeResults))expect(outcome).toEqual({journal:0,sink:0});
	},30_000);
	it("source-bound browser owners functional preparation preserves historical Referee intervals",async()=>{
		const {runSourceBinding}=await import("./fixtures/startup-discovery/r8-source-binding.js");
		const value=await runSourceBinding("r8-functional-"+crypto.randomUUID());
		expect(value,JSON.stringify(value)).toEqual(expect.objectContaining({prefix:expect.objectContaining({ok:true}),suffix:expect.objectContaining({ok:true}),newSignCalls:0,negativeSignCalls:0,signCalls:2}));
	},30_000);
	it("source-bound local replacement preserves genuine historical former Writer current Referee", async () => {
		const result=await runNativeHistoricalReplacement();
		console.log("native-historical-source-replacement",JSON.stringify(result));
		expect(result.replacement,JSON.stringify(result)).toEqual(expect.objectContaining({ok:true,authorSequence:3}));
		expect(result.signerCalls).toBe(1);
		expect(result.localReopened).toBe(true);
		expect(result.custodyRefusals).toEqual([
			expect.objectContaining({ok:false,detail:"creator issuance ACL authority is invalid"}),
			expect.objectContaining({ok:false,detail:"creator issuance possession proof failed"}),
			expect.objectContaining({ok:false,detail:"creator issuance lineage is invalid"}),
		]);
	},30_000);
	it("source-bound local replacement refuses unrelated native candidate despite exact signed Admin source", async () => {
		const result = await runNativeReplacementMissingSource(true);
		console.log("native-unrelated-source-replacement", JSON.stringify(result));
		expect(result.cleanupJoined).toBe(true);
		expect(result.sourceBefore).toBe(false);
		expect(result.sourceAfter).toBe(false);
		expect({
			issued: result.issued,
			signerCalls: result.signerCalls,
			lineageBefore: result.lineageBefore,
			lineageAfter: result.lineageAfter,
			outboxDelta: result.outboxDelta,
			journalDelta: result.journalDelta,
			sinkDelta: result.sinkDelta,
			planAfter: result.planAfter,
		}).toEqual({
			issued: expect.objectContaining({ ok: false }),
			signerCalls: 0,
			lineageBefore: 2,
			lineageAfter: 2,
			outboxDelta: 0,
			journalDelta: 0,
			sinkDelta: 0,
			planAfter: result.planBefore,
		});
	});
	it("source-bound local replacement refuses a fenced plan without authenticated source before native effects", async () => {
		const result = await runNativeReplacementMissingSource();
		console.log("native-missing-source-replacement", JSON.stringify(result));
		expect(result.cleanupJoined).toBe(true);
		expect(result.sourceBefore).toBe(true);
		expect(result.sourceAfter).toBe(true);
		expect({
			issued: result.issued,
			signerCalls: result.signerCalls,
			lineageBefore: result.lineageBefore,
			lineageAfter: result.lineageAfter,
			outboxDelta: result.outboxDelta,
			journalDelta: result.journalDelta,
			sinkDelta: result.sinkDelta,
			planAfter: result.planAfter,
		}).toEqual({
			issued: expect.objectContaining({ ok: false }),
			signerCalls: 0,
			lineageBefore: 2,
			lineageAfter: 2,
			outboxDelta: 0,
			journalDelta: 0,
			sinkDelta: 0,
			planAfter: result.planBefore,
		});
	});
	it("settlement source binding preserves admission-rejected after an original unknown native issue", async () => {
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			creatorTrustProfileId: "creator-trusted-settlement-v1",
			exactCanonicalInitialStateBytes: encodeCanonical(0),
			latchedAclGroups: ["admin", "finality", "referee", "writer"],
			latchedAclVersion: 3,
		});
		let activation: ReturnType<typeof activateV3LivePlane> | undefined;
		try {
			const recovered = await recover(fixture, fixture.capability);
			activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:settlement-source-binding:halt"),
				onAdmittedVertex: vi.fn(),
			});
			if (!activation.ok) throw new TypeError("activation failed");
			const transaction = vi.mocked(recovered.issuanceStore.transactIssue);
			const original = transaction.getMockImplementation();
			if (original === undefined) throw new TypeError("original transaction unavailable");
			transaction.mockImplementationOnce(async (scope, buildAndSign) => {
				await original(scope, buildAndSign);
				throw Object.assign(new Error("controlled native unknown outcome"), { code: "ISSUANCE_OUTCOME_UNKNOWN" });
			});
			const signer = vi.fn(fixture.signRegisteredVertexDigest);
			expect(
				await activation.handle.issueLocal({
					operations: [{ logicalTime: 2, operation: { action: "add", value: 2 } }],
					signRegisteredVertexDigest: signer,
				})
			).toMatchObject({ ok: false, kind: "issuance-rejected" });
			const callsAfterUnknown = transaction.mock.calls.length;
			const signaturesAfterUnknown = signer.mock.calls.length;
			expect(
				await activation.handle.issueLocal({
					operations: [{ logicalTime: 3, operation: { action: "add", value: 3 } }],
					signRegisteredVertexDigest: signer,
				})
			).toEqual({ ok: false, kind: "admission-rejected", detail: "v3 operation admission is halted until recovery" });
			expect(transaction).toHaveBeenCalledTimes(callsAfterUnknown);
			expect(signer).toHaveBeenCalledTimes(signaturesAfterUnknown);
		} finally {
			if (activation?.ok) activation.handle.deactivate();
			await fixture.close();
		}
	});
	it.each([false, true])(
		"settlement source binding refuses unrelated local NEW work with current Writer=%s",
		async (writer) => {
			const fixture = await createGenuinePreparedV3Fixture({
				authorizationMode: "latched-acl",
				creatorTrustProfileId: "creator-trusted-settlement-v1",
				exactCanonicalInitialStateBytes: encodeCanonical(0),
				latchedAclGroups: writer ? ["admin", "finality", "referee", "writer"] : ["admin", "finality", "referee"],
				latchedAclVersion: 3,
			});
			let activation: ReturnType<typeof activateV3LivePlane> | undefined;
			try {
				const recovered = await recover(fixture, fixture.capability, {
					action: "acl",
					group: "writer",
					kind: "grant",
					target: fixture.author,
				});
				const sink = vi.fn();
				activation = activateV3LivePlane({
					capability: recovered.capability,
					messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork("peer:settlement-source-binding:local:" + writer),
					onAdmittedVertex: sink,
				});
				if (!activation.ok) throw new TypeError("activation failed");
				// No historical source or settlement effect is supplied. A staged
				// future Writer grant and current Referee membership cannot authorize it.
				expect(
					await recovered.issuanceStore.readSettlementPlan({ author: fixture.author, objectId: fixture.objectId })
				).toBeNull();
				const signer = vi.fn(fixture.signRegisteredVertexDigest);
				const beforeJournal = vi.mocked(recovered.journal.appendAccepted).mock.calls.length;
				const beforeIssue = vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length;
				const result = await activation.handle.issueLocal({
					operations: [{ logicalTime: 2, operation: { action: "add", value: 2 } }],
					signRegisteredVertexDigest: signer,
				});
				console.log(
					"settlement-source-binding-local",
					JSON.stringify({
						writer,
						result,
						signerCalls: signer.mock.calls.length,
						issueCalls: vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length - beforeIssue,
						journalCalls: vi.mocked(recovered.journal.appendAccepted).mock.calls.length - beforeJournal,
						sinkCalls: sink.mock.calls.length,
					})
				);
				if (writer) expect(result.ok).toBe(true);
				else {
					expect({
						result,
						signerCalls: signer.mock.calls.length,
						issueCalls: vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length - beforeIssue,
						journalCalls: vi.mocked(recovered.journal.appendAccepted).mock.calls.length - beforeJournal,
						sinkCalls: sink.mock.calls.length,
					}).toEqual({
						result: expect.objectContaining({ ok: false, kind: "authorization-rejected" }),
						signerCalls: 0,
						issueCalls: 0,
						journalCalls: 0,
						sinkCalls: 0,
					});
				}
			} finally {
				if (activation?.ok) activation.handle.deactivate();
				await fixture.close();
			}
		}
	);
	it.each([false, true])(
		"settlement source binding refuses unrelated signed ingress NEW work with current Writer=%s",
		async (writer) => {
			const fixture = await createGenuinePreparedV3Fixture({
				authorizationMode: "latched-acl",
				creatorTrustProfileId: "creator-trusted-settlement-v1",
				exactCanonicalInitialStateBytes: encodeCanonical(0),
				latchedAclGroups: writer ? ["admin", "finality", "referee", "writer"] : ["admin", "finality", "referee"],
				latchedAclVersion: 3,
			});
			let activation: ReturnType<typeof activateV3LivePlane> | undefined;
			try {
				const recovered = await recover(fixture, fixture.capability, {
					action: "acl",
					group: "writer",
					kind: "grant",
					target: fixture.author,
				});
				const sink = vi.fn();
				activation = activateV3LivePlane({
					capability: recovered.capability,
					messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork("peer:settlement-source-binding:ingress:" + writer),
					onAdmittedVertex: sink,
				});
				if (!activation.ok) throw new TypeError("activation failed");
				const carrier = fixture.createRegisteredVertex({
					authorSequence: 1,
					dependencies: [fixture.anchorDigest],
					logicalTime: 2,
					operation: { action: "add", value: 2 },
					privateKeySeedHex: contract.privateKeySeedHex,
				});
				const beforeJournal = vi.mocked(recovered.journal.appendAccepted).mock.calls.length;
				const beforeIssue = vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length;
				expect(
					routeV3RetainedIngress(
						activation.handle,
						Message.create({
							data: V3Envelope.encode({
								canonicalPreimage: carrier.canonicalPreimageBytes,
								signature: carrier.signature,
							}).finish(),
							objectId: activation.handle.topic,
							sender: "peer:authenticated-current-referee",
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
						})
					)
				).toBe(true);
				expect((await activation.handle.publishPending()).ok).toBe(true);
				console.log(
					"settlement-source-binding-ingress",
					JSON.stringify({
						writer,
						issueCalls: vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length - beforeIssue,
						journalCalls: vi.mocked(recovered.journal.appendAccepted).mock.calls.length - beforeJournal,
						sinkCalls: sink.mock.calls.length,
					})
				);
				expect({
					issueCalls: vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length - beforeIssue,
					journalCalls: vi.mocked(recovered.journal.appendAccepted).mock.calls.length - beforeJournal,
					sinkCalls: sink.mock.calls.length,
				}).toEqual({ issueCalls: 0, journalCalls: writer ? 1 : 0, sinkCalls: writer ? 1 : 0 });
			} finally {
				if (activation?.ok) activation.handle.deactivate();
				await fixture.close();
			}
		}
	);
	it.each([false, true])(
		"early current authority authenticates ingress with current Writer=%s before effects",
		async (writer) => {
			const fixture = await createGenuinePreparedV3Fixture({
				authorizationMode: "latched-acl",
				exactCanonicalInitialStateBytes: encodeCanonical(0),
				latchedAclGroups: writer ? ["admin", "finality", "writer"] : ["admin", "finality"],
			});
			let activation: ReturnType<typeof activateV3LivePlane> | undefined;
			try {
				const recovered = await recover(fixture, fixture.capability, {
					action: "acl",
					group: "writer",
					kind: "grant",
					target: fixture.author,
				});
				const sink = vi.fn();
				activation = activateV3LivePlane({
					capability: recovered.capability,
					messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork("peer:early-authority:ingress:" + writer),
					onAdmittedVertex: sink,
				});
				if (!activation.ok) throw new TypeError("activation failed");
				const carrier = fixture.createRegisteredVertex({
					authorSequence: 1,
					dependencies: [fixture.anchorDigest],
					logicalTime: 2,
					operation: { action: "add", value: 2 },
					privateKeySeedHex: contract.privateKeySeedHex,
				});
				const journalBefore = vi.mocked(recovered.journal.appendAccepted).mock.calls.length;
				const issueBefore = vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length;
				// Routing accepts an authenticated packet into the owned queue; it is
				// not the admission outcome. Joining that queue must enforce CURRENT
				// Writer, even though its authentic replay stages a future Writer grant.
				expect(
					routeV3RetainedIngress(
						activation.handle,
						Message.create({
							data: V3Envelope.encode({
								canonicalPreimage: carrier.canonicalPreimageBytes,
								signature: carrier.signature,
							}).finish(),
							objectId: activation.handle.topic,
							sender: "peer:authenticated-current-member",
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
						})
					)
				).toBe(true);
				expect((await activation.handle.publishPending()).ok).toBe(true);
				expect(vi.mocked(recovered.journal.appendAccepted).mock.calls.length - journalBefore).toBe(writer ? 1 : 0);
				expect(sink).toHaveBeenCalledTimes(writer ? 1 : 0);
				expect(vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length).toBe(issueBefore);
			} finally {
				if (activation?.ok) activation.handle.deactivate();
				await fixture.close();
			}
		}
	);

	it("early current authority refuses before genuine multi-tip frontier reduction", async () => {
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: encodeCanonical(0),
			latchedAclGroups: ["admin", "finality"],
		});
		let activation: ReturnType<typeof activateV3LivePlane> | undefined;
		try {
			const acl = { action: "acl", group: "writer", kind: "grant", target: fixture.author };
			const recovered = await recover(fixture, fixture.capability, acl);
			const sink = vi.fn();
			activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:early-authority:frontier"),
				onAdmittedVertex: sink,
			});
			if (!activation.ok) throw new TypeError("activation failed");
			for (let sequence = 1; sequence <= fixture.parameters.maxDependencies + 1; sequence++) {
				const carrier = fixture.createRegisteredVertex({
					authorSequence: sequence,
					dependencies: [fixture.anchorDigest],
					logicalTime: sequence + 1,
					operation: acl,
					privateKeySeedHex: contract.privateKeySeedHex,
				});
				expect(
					routeV3RetainedIngress(
						activation.handle,
						Message.create({
							data: V3Envelope.encode({
								canonicalPreimage: carrier.canonicalPreimageBytes,
								signature: carrier.signature,
							}).finish(),
							objectId: activation.handle.topic,
							sender: "peer:authenticated-admin",
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
						})
					)
				).toBe(true);
			}
			// Original publication joins the serialized ingress prefix without
			// editing dependencies or collapsing the received frontier.
			expect((await activation.handle.publishPending()).ok).toBe(true);
			expect(sink).toHaveBeenCalledTimes(fixture.parameters.maxDependencies + 1);
			const signer = vi.fn(fixture.signRegisteredVertexDigest);
			const journalBefore = vi.mocked(recovered.journal.appendAccepted).mock.calls.length;
			const issueBefore = vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length;
			expect(
				await activation.handle.issueLocal({
					operations: [{ logicalTime: 100, operation: { action: "add", value: 2 } }],
					signRegisteredVertexDigest: signer,
				})
			).toEqual(expect.objectContaining({ kind: "authorization-rejected", ok: false }));
			expect(signer).not.toHaveBeenCalled();
			expect(vi.mocked(recovered.journal.appendAccepted).mock.calls.length).toBe(journalBefore);
			expect(vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length).toBe(issueBefore);
			expect(sink).toHaveBeenCalledTimes(fixture.parameters.maxDependencies + 1);
		} finally {
			if (activation?.ok) activation.handle.deactivate();
			await fixture.close();
		}
	});

	it("early current authority refuses direct nonwriter issuance before signing or durable effects", async () => {
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: encodeCanonical(0),
			latchedAclGroups: ["admin", "finality"],
		});
		let activation: ReturnType<typeof activateV3LivePlane> | undefined;
		try {
			// A genuine Admin operation is replayable, but its next-epoch Writer
			// grant must not authorize application work in the current epoch.
			const recovered = await recover(fixture, fixture.capability, {
				action: "acl",
				group: "writer",
				kind: "grant",
				target: fixture.author,
			});
			const sink = vi.fn();
			activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:early-authority:nonwriter"),
				onAdmittedVertex: sink,
			});
			if (!activation.ok) throw new TypeError("activation failed");
			const signer = vi.fn(fixture.signRegisteredVertexDigest);
			const beforeJournal = vi.mocked(recovered.journal.appendAccepted).mock.calls.length;
			const beforeIssue = vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length;
			const beforeSink = sink.mock.calls.length;
			const result = await activation.handle.issueLocal({
				operations: [{ logicalTime: 2, operation: { action: "add", value: 2 } }],
				signRegisteredVertexDigest: signer,
			});
			expect({
				issueCalls: vi.mocked(recovered.issuanceStore.transactIssue).mock.calls.length - beforeIssue,
				journalCalls: vi.mocked(recovered.journal.appendAccepted).mock.calls.length - beforeJournal,
				result,
				signerCalls: signer.mock.calls.length,
				sinkCalls: sink.mock.calls.length - beforeSink,
			}).toEqual({
				issueCalls: 0,
				journalCalls: 0,
				result: expect.objectContaining({ ok: false, kind: "authorization-rejected" }),
				signerCalls: 0,
				sinkCalls: 0,
			});
		} finally {
			if (activation?.ok) activation.handle.deactivate();
			await fixture.close();
		}
	});

	it("early current authority permits Admin-only ACL replay and fold without granting ordinary Writer", async () => {
		const initialState = encodeCanonical(0);
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: initialState,
			latchedAclGroups: ["admin", "finality"],
		});
		let activation: ReturnType<typeof activateV3LivePlane> | undefined;
		try {
			const recovered = await recover(fixture, fixture.capability, {
				action: "acl",
				group: "writer",
				kind: "grant",
				target: fixture.author,
			});
			activation = activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork("peer:early-authority:admin-fold"),
				onAdmittedVertex: vi.fn(),
			});
			if (!activation.ok) throw new TypeError("activation failed");
			const binding = bindV3BlueprintLivePlane({
				exactCanonicalInitialStateBytes: initialState,
				plane: activation.handle,
			});
			if (!binding.ok) throw new TypeError("binding failed");
			const folded = await binding.handle.stageBlueprintEpoch();
			expect(folded.ok).toBe(true);
			if (!folded.ok) throw new TypeError("authorized Admin fold failed");
			expect(folded.outputs).toEqual([null]);
			expect(folded.staged.exactCanonicalStateBytes).toEqual(initialState);
			expect(folded.adopt().ok).toBe(true);
		} finally {
			if (activation?.ok) activation.handle.deactivate();
			await fixture.close();
		}
	});

	it("binds signed genesis and converges two independent recovered peers", async () => {
		const initialStateBytes = encodeCanonical(0);
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: initialStateBytes,
		});
		try {
			const secondPrepared = await fixture.prepareAgain();
			const stalePrepared = await fixture.prepareAgain();
			const recovered = await Promise.all([
				recover(fixture, fixture.capability),
				recover(fixture, secondPrepared.capability),
				recover(fixture, stalePrepared.capability),
			]);
			const activations = recovered.map((entry, index) =>
				activateV3LivePlane({
					capability: entry.capability,
					messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork(`peer:phase4a:${index}`),
					onAdmittedVertex: vi.fn(),
				})
			);
			expect(activations.every((entry) => entry.ok)).toBe(true);
			if (!activations[0]?.ok || !activations[1]?.ok) throw new TypeError("activation failed");
			expect(
				bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: encodeCanonical(9), plane: activations[0].handle })
			).toEqual({ detail: "v3 signed genesis state is invalid", kind: "malformed-input", ok: false });
			const bindings = activations.map((entry) =>
				bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialStateBytes, plane: entry.handle })
			);
			expect(bindings.every((entry) => entry.ok)).toBe(true);
			if (!bindings[0]?.ok || !bindings[1]?.ok || !bindings[2]?.ok) throw new TypeError("binding failed");

			if (!activations[2]?.ok) throw new TypeError("closed fold setup failed");
			const issuedPromise = activations[2].handle.issueLocal({
				operations: Object.freeze([
					Object.freeze({ logicalTime: 2, operation: Object.freeze({ action: "add", value: 2 }) }),
				]),
				signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
			});
			const closedStagePromise = bindings[2].handle.stageBlueprintEpoch();
			const [issued, closedStage] = await Promise.all([issuedPromise, closedStagePromise]);
			expect(issued.ok).toBe(true);
			if (!closedStage.ok) throw new TypeError("closed fold failed");
			expect(closedStage.outputs).toEqual([1, 3]);
			expect(closedStage.adopt().ok).toBe(true);
			expect(
				await activations[2].handle.issueLocal({
					operations: Object.freeze([
						Object.freeze({ logicalTime: 3, operation: Object.freeze({ action: "add", value: 4 }) }),
					]),
					signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
				})
			).toEqual({
				detail: "v3 plane is not accepting local issues",
				kind: "not-active",
				ok: false,
			});

			const staged = await Promise.all(bindings.slice(0, 2).map((entry) => entry.handle.stageBlueprintEpoch()));
			if (!staged[0]?.ok || !staged[1]?.ok) {
				throw new TypeError(`fold failed: ${JSON.stringify(staged)}`);
			}
			expect(staged[0].order).toEqual(staged[1].order);
			expect(staged[0].outputs).toEqual([1]);
			expect(staged[0].staged.stateDigest).toBe(staged[1].staged.stateDigest);
			expect(staged[0].staged.exactCanonicalStateBytes).toEqual(staged[1].staged.exactCanonicalStateBytes);

			const adopted = staged.map((entry) => entry.adopt());
			expect(adopted.every((entry) => entry.ok)).toBe(true);
			if (!adopted[0]?.ok || !adopted[1]?.ok) throw new TypeError("adoption failed");
			expect(adopted[0].snapshot).toEqual(adopted[1].snapshot);
			expect(staged[0].adopt()).toEqual({
				detail: "v3 blueprint fold result was already used",
				kind: "already-adopted",
				ok: false,
			});
			expect(await bindings[0].handle.stageBlueprintEpoch()).toEqual({
				detail: "v3 blueprint epoch was already folded",
				kind: "already-folded",
				ok: false,
			});

			activations[1].handle.deactivate();
			expect(bindings[1].handle.blueprintSnapshot()).toBeUndefined();
		} finally {
			await fixture.close();
		}
	});

	it("rejects an authenticated latched member without application-writer authority before replay activation", async () => {
		const initialStateBytes = encodeCanonical(0);
		const fixture = await createGenuinePreparedV3Fixture({
			authorizationMode: "latched-acl",
			exactCanonicalInitialStateBytes: initialStateBytes,
			latchedAclGroups: ["admin", "finality"],
		});
		try {
			// The previously accepted late fold refusal remains historical evidence.
			// This stronger boundary must refuse the same signed persisted row before
			// handing out a recovered activation capability; it never rewrites it.
			const bindings = await createRecoveryInput(fixture, fixture.capability);
			expect(await recoverV3LiveReplica(bindings.input)).toEqual(
				expect.objectContaining({ kind: "authorization-rejected", ok: false })
			);
			expect(bindings.journal.appendAccepted).not.toHaveBeenCalled();
		} finally {
			await fixture.close();
		}
	});
});

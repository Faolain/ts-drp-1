import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CompactMerkleAccumulator } from "@ts-drp/compaction";
import type { DurableIssuanceStore, DurableIssueScope, SettlementPlan } from "@ts-drp/issuance-store";
import { MessageQueueManager } from "@ts-drp/message-queue";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

import { reopenCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption-activate.js";

import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	recoverV3LiveReplica,
	routeV3Ingress,
	routeV3RetainedIngress,
	type V3LocalIssueResult,
	type V3PlaneHandle,
} from "../../../packages/node/src/v3-live.js";
import { createNodeDurableIssuanceStore } from "../../../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/src/live-journal.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { createNodeSnapshotQuarantineStore } from "../../../packages/storage-node/src/snapshot-transfer.js";
import { createCreatorSuccessorMaterialServer, readCreatorSuccessorExport, receiveCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption.js";
import { stageCreatorSuccessorAdoption, publishStagedCreatorSuccessorAdoption } from "../../../packages/node/src/creator-adoption-stage.js";
import { parseStorageObjectId, type AheDurableStore } from "../../../packages/storage/src/index.js";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "../../../packages/network/src/snapshot-transfer.js";
import { ScriptedSnapshotChunkPort } from "../phase-4c-v3/snapshot-pull-transport.js";
import { createGenuinePreparedV3Fixture } from "../phase-3a1b-p3/live-fixture.js";
import { fakeNetwork, recover } from "../phase-4b-v3/live-snapshot.js";
import { contract, hexBytes } from "../phase-3a0-v3/controlled-anchor-trust.js";
import { commitGenuineCreatorAdoptionFixture, defaultCreatorAdoptionFixtureModules, openGenuineCreatorAdoptionFixture } from "../phase-6a-v3/creator-adoption-contract.js";

export const AUTHOR_FENCE_ACTION = "$drp.author-fence.v1";

/** Actual old Writer issuance, genuine close, then current Referee cold adoption. */
export async function runNativeHistoricalReplacement(
	remote = false,
	interrupt = false,
	staleFloor = false,
	reverse = false,
	fallback = false,
	fabricatedMembership = false,
	splitProgress = false
): Promise<Readonly<Record<string, unknown>>> {
	const directory = mkdtempSync(path.join(tmpdir(), "drp-r8-historical-source-"));
	const followerSeed = "42".repeat(32);
	const follower = Buffer.from(ed25519.getPublicKey(hexBytes(followerSeed))).toString("hex");
	const receiverSeed = "43".repeat(32),
		receiverAuthor = Buffer.from(ed25519.getPublicKey(hexBytes(receiverSeed))).toString("hex");
	const options = {
		applicationBatch: splitProgress,
		authorizationMode: "latched-acl" as const,
		creatorTrustProfileId: "creator-trusted-settlement-v1" as const,
		authorizedPrivateKeySeedHexes: [contract.privateKeySeedHex, followerSeed, ...(remote ? [receiverSeed] : [])],
		latchedAclVersion: 3 as const,
		latchedAclWriterOnlyRoster: true,
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		historyRoot: Buffer.from(new CompactMerkleAccumulator().root()).toString("hex"),
		historySize: 0,
	};
	const original = await createGenuinePreparedV3Fixture(options);
	const issuanceStore = createNodeDurableIssuanceStore({ primaryFilename: path.join(directory, "issuance.sqlite") });
	const journal = createNodeDurableLiveJournalStore({ primaryFilename: path.join(directory, "journal.sqlite") });
	const scope = { author: follower, objectId: original.objectId };
	const signer = async (value: Uint8Array): Promise<Uint8Array> => ed25519.sign(value, hexBytes(followerSeed));
	const admission = { refusals: 0, targetRefusals: 0, committed: 0, released: 0 };
	let refuseRecipientOriginal = false;
	const createOperationAdmissionPolicy = () => ({
		reserve: (operation: Readonly<Record<string, unknown>>) => {
			if (refuseRecipientOriginal && operation.action === "add" && operation.value === 10) {
				admission.targetRefusals++;
				return { kind: "rejected" as const, reason: "capacity" as const };
			}
			if (operation.action === "add" && operation.value === 99) {
				admission.refusals++;
				return { kind: "rejected" as const, reason: "capacity" as const };
			}
			return {
				kind: "fresh" as const,
				commit: () => {
					admission.committed++;
					return "committed" as const;
				},
				release: () => {
					admission.released++;
				},
			};
		},
	});
	let old: V3PlaneHandle | undefined;
	let current: V3PlaneHandle | undefined;
	let creator: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>> | undefined;
	let floor: ReturnType<typeof createNodeRoomHeadAuthority> | undefined;
	let recipient: V3PlaneHandle | undefined;
	let recipientIssuance: ReturnType<typeof createNodeDurableIssuanceStore> | undefined;
	let recipientJournal: ReturnType<typeof createNodeDurableLiveJournalStore> | undefined;
	let recipientFloor: ReturnType<typeof createNodeRoomHeadAuthority> | undefined;
	let recipientFixture: Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>> | undefined;
	let recipientStore: AheDurableStore | undefined;
	let recipientSnapshots: ReturnType<typeof createNodeSnapshotQuarantineStore> | undefined;
	let recipientPort: SnapshotChunkProtocolPort | undefined;
	let interruptNextReceived = false;
	try {
		const bootstrap = original.createRegisteredVertex({
			authorSequence: 0,
			dependencies: [original.anchorDigest],
			logicalTime: 1,
			operation: { action: "add", value: 0 },
			privateKeySeedHex: followerSeed,
		});
		const bootstrapEnvelope = {
			canonicalPreimageBytes: bootstrap.canonicalPreimageBytes,
			digest: bootstrap.digest,
			signature: bootstrap.signature,
		};
		await issuanceStore.transactIssue(scope, () =>
			Promise.resolve({
				authorSequence: 0,
				envelope: bootstrapEnvelope,
				issuedRecord: { authorSequence: 0, envelope: bootstrapEnvelope, scope },
				outboxEntry: { authorSequence: 0, envelope: bootstrapEnvelope, scope },
			})
		);
		const installed = await journal.installGenesis({
			detachedAnchorSignature: original.detachedAnchorSignature,
			exactCanonicalAnchorPreimageBytes: original.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: original.exactCanonicalParametersCarrierBytes,
			objectId: original.objectId,
		});
		if (!installed.ok) throw new TypeError("historical source genesis journal refused");
		const recovered = await recoverV3LiveReplica({
			capability: original.capability,
			exactCanonicalLatchedAclBytes: original.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore,
			liveJournalStore: journal,
		});
		if (!recovered.ok) throw new TypeError(`historical source recovery refused:${recovered.kind}`);
		const active = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: fakeNetwork(`historical-old-${crypto.randomUUID()}`),
			onAdmittedVertex: () => {},
		});
		if (!active.ok) throw new TypeError(`historical source activation refused:${active.kind}`);
		old = active.handle;
		const bound = bindV3BlueprintLivePlane({ plane: old, exactCanonicalInitialStateBytes: encodeCanonical(0) });
		if (!bound.ok) throw new TypeError(`historical source blueprint refused:${bound.kind}`);
		const bootstrapPublished = await old.publishPending();
		if (!bootstrapPublished.ok)
			throw new TypeError(`historical pinned bootstrap publication refused:${bootstrapPublished.kind}`);
		const sourceIssued = await old.issueLocal({
			operations: splitProgress ? [
				{ logicalTime: 2, operation: { action: "add", value: 10 } },
				{ logicalTime: 3, operation: { action: "add", value: 20 } },
			] : [{ logicalTime: 2, operation: { action: "add", value: 10 } }],
			signRegisteredVertexDigest: signer,
		});
		if (!sourceIssued.ok) throw new TypeError(`historical source ordinary issue refused:${sourceIssued.kind}`);
		old.deactivate();
		const modules = await defaultCreatorAdoptionFixtureModules();
		creator = await openGenuineCreatorAdoptionFixture({
			applicationBatch: splitProgress,
			nativeAheOwner: true,
			nativeStorageOwners: true,
			modules,
			creatorTrustProfileId: options.creatorTrustProfileId,
			authorizedPrivateKeySeedHexes: options.authorizedPrivateKeySeedHexes,
			latchedAclWriterOnlyRoster: true,
			beforeCreatorClose: async (input) => {
				const granted = await input.plane.issueLocal({
					operations: [
						{ logicalTime: 3, operation: { action: "acl", group: "referee", kind: "grant", target: follower } },
					],
					signRegisteredVertexDigest: input.signRegisteredVertexDigest,
				});
				if (!granted.ok) throw new TypeError(`historical Referee grant refused:${granted.kind}`);
				const revoked = await input.plane.issueLocal({
					operations: [
						{ logicalTime: 4, operation: { action: "acl", group: "writer", kind: "revoke", target: follower } },
					],
					signRegisteredVertexDigest: input.signRegisteredVertexDigest,
				});
				if (!revoked.ok) throw new TypeError(`historical Writer revoke refused:${revoked.kind}`);
				return { authorSequence: revoked.authorSequence, digest: revoked.digest };
			},
		});
		if (creator.scope.anchorDigest !== original.anchorDigest)
			throw new TypeError("historical recipient genesis differs from genuine creator");
		const committed = await commitGenuineCreatorAdoptionFixture(creator);
		if (committed.ok !== true) throw new TypeError(`historical creator commit refused:${String(committed.kind)}`);
		const successor = creator.evidence.proposed;
		const trust = creator.evidence.closeResult;
		const nextEpoch = 1;
		const blueprintDigest = original.descriptor.blueprintDigest;
		const settlementPolicy = {
			blueprintDigest,
			derive: (operations: readonly Readonly<Record<string, unknown>>[]) =>
				fallback
					? { disposition: "transform" as const, operations: [{ action: "add", value: 99 }] }
					: { disposition: "rebase" as const, operations },
		};
		const stable = { objectId: original.objectId, epoch: nextEpoch, currentAnchorDigest: trust.successorAnchorDigest };
		floor = createNodeRoomHeadAuthority({
			filename: path.join(directory, "floor.sqlite"),
			initialization: { kind: "migrate", head: stable },
		});
		const installedFloor = await floor.migrate({
			scope: { objectId: original.objectId, pinnedGenesisAnchorDigest: original.anchorDigest },
			stable,
		});
		if (!installedFloor.ok) throw new TypeError("historical native successor floor refused");
		const openCurrent = (overrides: Partial<Parameters<typeof reopenCreatorSuccessorAdoption>[0]> = {}) => reopenCreatorSuccessorAdoption({
			authenticationProfile: "creator-only",
			author: follower,
			catalog: original.catalog,
			detachedSignature: original.detachedAnchorSignature,
			exactCanonicalAnchorPreimageBytes: original.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: original.exactCanonicalParametersCarrierBytes,
			exactCanonicalPinnedGenesisBootstrapOperationBytes: encodeCanonical({ action: "add", value: 0 }),
			expectedRoomHead: {
				objectId: original.objectId,
				epoch: nextEpoch,
				currentAnchorDigest: trust.successorAnchorDigest,
			},
			issuanceStore,
			liveJournalStore: journal,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: fakeNetwork(`historical-current-${crypto.randomUUID()}`),
			onAdmittedVertex: () => {},
			pinnedGenesisAnchorDigest: original.anchorDigest,
			signRegisteredVertexDigest: signer,
			snapshotStore: creator.evidence.snapshotStore,
			store: creator.evidence.aheBackend,
			settlementFloor: floor,
			settlementPolicy,
			...(fallback ? { createOperationAdmissionPolicy } : {}),
			...overrides,
		});
		const reopened = await openCurrent();
		if (reopened.ok !== true) {
			console.log("historical-native-reopen", reopened, successor, trust);
			throw new TypeError(`historical recipient reopen refused:${String(reopened.kind)}:${String(reopened.detail)}`);
		}
		current = reopened.handle as V3PlaneHandle;
		let newSignerCalls = 0;
		const beforeNew = await issuanceStore.readLineage(scope);
		const ordinaryNew = await current.issueLocal({
			operations: [{ logicalTime: 5, operation: { action: "add", value: 99 } }],
			signRegisteredVertexDigest: async (value) => {
				newSignerCalls++;
				return signer(value);
			},
		});
		const afterNew = await issuanceStore.readLineage(scope);
		let source:
			| Extract<Awaited<ReturnType<V3PlaneHandle["readRebaseOutbox"]>>, { ok: true; kind: "displaced" }>["source"]
			| undefined;
		for (let index = 0; index < 3; index++) {
			const page = await current.readRebaseOutbox();
			if (!page.ok) throw new TypeError(`historical source read refused:${page.kind}`);
			if (page.kind === "empty") break;
			if (page.source.authorSequence === 1) {
				source = page.source;
				break;
			}
		}
		if (source === undefined) throw new TypeError("historical actual source not returned");
		await writeSettlementPlan(issuanceStore, settlementPlan(scope, { empty: true }));
		const prior = await issuanceStore.readSettlementPlan(scope);
		if (prior === null) throw new TypeError("historical native plan missing");
		if (fallback) {
			await issuanceStore.transactWriteSettlementPlan({
				expectedRevision: prior.revision,
				scope,
				plan: {
					...prior,
					revision: prior.revision + 1,
					entries: [
						{
							sourceSequence: 1,
							sourceDigest: hexBytes(source.vertexDigest),
							disposition: "transform",
							replacementSequence: null,
						},
					],
				},
			});
			const prepared = await source.prepareReplacement();
			const registered = await issuanceStore.readSettlementPlan(scope);
			if (registered === null || prepared.transformRefusal === undefined)
				throw new TypeError("native original transform refusal missing");
			const persisted = await issuanceStore.transactWriteSettlementPlan({
				expectedRevision: registered.revision,
				scope,
				plan: {
					...registered,
					revision: registered.revision + 1,
					entries: [
						{
							sourceSequence: 1,
							sourceDigest: hexBytes(source.vertexDigest),
							disposition: prepared.disposition,
							replacementSequence: null,
							transformRefusal: prepared.transformRefusal,
						},
					],
				},
			});
			if (persisted.entries[0]?.transformRefusal?.reason !== "capacity")
				throw new TypeError("native original transform refusal persistence refused");
		}
		const fence = await current.issueLocal({
			operations: [{ logicalTime: 5, operation: { action: AUTHOR_FENCE_ACTION, fenceSequence: 2, version: 1 } }],
			signRegisteredVertexDigest: signer,
		});
		if (!fence.ok) throw new TypeError(`historical fence refused:${fence.kind}`);
		if (!fallback) {
			const fenced = await issuanceStore.readSettlementPlan(scope);
			if (fenced === null) throw new TypeError("historical fenced native plan missing");
			await issuanceStore.transactWriteSettlementPlan({
				expectedRevision: fenced.revision,
				scope,
				plan: {
					...fenced,
					revision: fenced.revision + 1,
					entries: [
						{
							sourceSequence: 1,
							sourceDigest: hexBytes(source.vertexDigest),
							disposition: "rebase",
							replacementSequence: null,
						},
					],
				},
			});
		}
		const persistedPreparation = await issuanceStore.readSettlementPlan(scope);
		const splitIntentDigest = hashDomain("ts-drp/settlement-replacement-intents/v1",
			encodeCanonical([{action:"add",value:10},{action:"add",value:20}]));
		if(splitProgress) {
			const plan=await issuanceStore.readSettlementPlan(scope);
			if(plan===null)throw new TypeError("split source native plan missing");
			await issuanceStore.transactWriteSettlementPlan({scope,expectedRevision:plan.revision,
				plan:{...plan,revision:plan.revision+1,entries:plan.entries.map(entry=>entry.sourceSequence===1?
					{...entry,replacementProgress:{version:1,intentCount:2,intentDigest:splitIntentDigest,chunks:[]}}:entry)}});
		}
		if (remote) await source.authorizeReplacement(async ({digest}) => ed25519.sign(digest, hexBytes(contract.privateKeySeedHex)));
		let signerCalls = 0;
		const replacement = await source.issueReplacement({
			operations: [{ logicalTime: 6, operation: { action: "add", value: 10 } }],
			planEffect: splitProgress ? {kind:"replacement",sourceSequence:1,fromIntent:0,throughIntent:1,intentDigest:splitIntentDigest} :
				{ kind: "replacement", sourceSequence: 1 },
			signRegisteredVertexDigest: async (value) => {
				signerCalls++;
				return signer(value);
			},
		});
		let finalSplitReplacement: Awaited<ReturnType<typeof source.issueReplacement>> | undefined;
		if(splitProgress) {
			if(!replacement.ok)throw new TypeError(`native first split chunk refused:${JSON.stringify(replacement)}`);
			finalSplitReplacement=await source.issueReplacement({
				operations:[{logicalTime:7,operation:{action:"add",value:20}}],
				planEffect:{kind:"replacement",sourceSequence:1,fromIntent:1,throughIntent:2,intentDigest:splitIntentDigest},
				signRegisteredVertexDigest:async value=>{signerCalls++;return signer(value);},
			});
			if(!finalSplitReplacement.ok)throw new TypeError(`native final split chunk refused:${JSON.stringify(finalSplitReplacement)}`);
		}
		let remoteResult: Readonly<Record<string, unknown>> | undefined;
		if (remote) {
			if (!replacement.ok) throw new TypeError(`portable sender replacement refused:${JSON.stringify(replacement)}`);
			recipientIssuance = createNodeDurableIssuanceStore({
				primaryFilename: path.join(directory, "recipient-issuance.sqlite"),
			});
			const rawRecipientJournal = createNodeDurableLiveJournalStore({
				primaryFilename: path.join(directory, "recipient-journal.sqlite"),
			});
			recipientJournal = {
				...rawRecipientJournal,
				appendAccepted: async (input) => {
					const outcome = await rawRecipientJournal.appendAccepted(input);
					if (interruptNextReceived && input.sourceKind === "received" && outcome.ok && !outcome.idempotent) {
						interruptNextReceived = false;
						throw new Error("portable native received commit acknowledgement interrupted");
					}
					return outcome;
				},
			};
			const initialHead = { objectId: original.objectId, epoch: 0, currentAnchorDigest: original.anchorDigest };
			recipientFloor = createNodeRoomHeadAuthority({
				filename: path.join(directory, "recipient-floor.sqlite"),
				initialization: { kind: "migrate", head: initialHead },
			});
			const recipientFloorInstalled = await recipientFloor.migrate({
				scope: { objectId: original.objectId, pinnedGenesisAnchorDigest: original.anchorDigest },
				stable: initialHead,
			});
			if (!recipientFloorInstalled.ok) throw new TypeError("portable recipient native floor refused");
			const recipientGenesis = await recipientJournal.installGenesis({
				detachedAnchorSignature: original.detachedAnchorSignature,
				exactCanonicalAnchorPreimageBytes: original.exactCanonicalAnchorPreimageBytes,
				exactCanonicalParametersCarrierBytes: original.exactCanonicalParametersCarrierBytes,
				objectId: original.objectId,
			});
			if (!recipientGenesis.ok) throw new TypeError("portable recipient genesis refused");
			recipientFixture = await createGenuinePreparedV3Fixture({
				...options,
				storeDecorator: (store) => {
					recipientStore = store;
					return store;
				},
			});
			if (recipientFixture.anchorDigest !== original.anchorDigest || recipientStore === undefined)
				throw new TypeError("portable recipient genuine genesis differs");
			recipientSnapshots = createNodeSnapshotQuarantineStore({
				primaryFilename: path.join(directory, "recipient-snapshots.sqlite"),
			});
			const sink = vi.fn();
			const receiverSigner = async (value: Uint8Array) => ed25519.sign(value, hexBytes(receiverSeed));
			const ownBootstrap = recipientFixture.createRegisteredVertex({
				authorSequence: 0,
				dependencies: [original.anchorDigest],
				logicalTime: 1,
				operation: { action: "add", value: 0 },
				privateKeySeedHex: receiverSeed,
			});
			const recipientScope = { objectId: original.objectId, author: receiverAuthor },
				ownEnvelope = {
					canonicalPreimageBytes: ownBootstrap.canonicalPreimageBytes,
					digest: ownBootstrap.digest,
					signature: ownBootstrap.signature,
				};
			await recipientIssuance.transactIssue(recipientScope, () =>
				Promise.resolve({
					authorSequence: 0,
					envelope: ownEnvelope,
					issuedRecord: { authorSequence: 0, envelope: ownEnvelope, scope: recipientScope },
					outboxEntry: { authorSequence: 0, envelope: ownEnvelope, scope: recipientScope },
				})
			);
			const recoveredRecipient = await recoverV3LiveReplica({
				capability: recipientFixture.capability,
				exactCanonicalLatchedAclBytes: recipientFixture.exactCanonicalLatchedAclBytes,
				issuanceScope: { objectId: original.objectId, author: receiverAuthor },
				issuanceStore: recipientIssuance,
				liveJournalStore: recipientJournal,
			});
			if (!recoveredRecipient.ok)
				throw new TypeError(`portable initial recipient refused:${JSON.stringify(recoveredRecipient)}`);
			const activeRecipient = activateV3LivePlane({
				capability: recoveredRecipient.capability,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode: fakeNetwork(`portable-initial-${crypto.randomUUID()}`),
				onAdmittedVertex: sink,
			});
			if (!activeRecipient.ok) throw new TypeError("portable initial recipient activation refused");
			recipient = activeRecipient.handle;
			if (!(await recipient.publishPending()).ok)
				throw new TypeError("portable recipient bootstrap publication refused");
			const object = parseStorageObjectId(original.objectId);
			if (!object.ok) throw new TypeError("portable native object invalid");
			const exported = await readCreatorSuccessorExport({
				store: creator.evidence.aheBackend,
				snapshotStore: creator.evidence.snapshotStore,
				objectId: object.value,
				pinnedGenesisAnchorDigest: original.anchorDigest,
				exactCanonicalGenesisAnchorPreimageBytes: original.exactCanonicalAnchorPreimageBytes,
				detachedGenesisSignature: original.detachedAnchorSignature,
				catalog: original.catalog,
			});
			const scripted = new ScriptedSnapshotChunkPort(
				{ declaration: creator.evidence.declaration, chunks: creator.evidence.chunks } as ConstructorParameters<
					typeof ScriptedSnapshotChunkPort
				>[0],
				new Map([["portable-source", "honest"]]),
				"portable-recipient"
			);
			const server = createCreatorSuccessorMaterialServer({
				identity: {
					author: original.author,
					sign: original.signRegisteredVertexDigest,
					isAuthorizedAuthor: (author) => original.authors.includes(author),
				},
				localPeerId: "portable-source",
				manifestDigest: exported.declaration.scope.manifestDigest,
				material: exported.material,
				connectedPeers: () => ["portable-recipient"],
			});
			recipientPort = {
				localPeerId: "portable-recipient",
				connectedPeers: () => ["portable-source"],
				close: () => scripted.close(),
				serve: (handler) => scripted.serve(handler),
				open: async (peer) => {
					const stream = await scripted.open(peer),
						frames: Uint8Array[] = [];
					let materialRequest = false;
					return {
						peerId: peer,
						abort: (reason) => stream.abort(reason),
						close: () => stream.close(),
						read: async (maximum, request) => {
							if (!materialRequest) return stream.read(maximum, request);
							request.signal.throwIfAborted();
							const frame = frames.shift();
							if (frame === undefined || frame.byteLength > maximum)
								throw new TypeError("portable material frame invalid");
							return frame;
						},
						write: async (bytes, request) => {
							const value = decodeCanonical(bytes) as Record<string, unknown>;
							if (value.kind !== "creator-successor-material-request") return stream.write(bytes, request);
							materialRequest = true;
							const inbound: SnapshotChunkProtocolStream = {
								peerId: "portable-recipient",
								abort: () => {},
								close: () => Promise.resolve(),
								read: () => Promise.reject(new TypeError("portable material reread")),
								write: (frame) => {
									frames.push(new Uint8Array(frame));
									return Promise.resolve();
								},
							};
							if (!(await server.control(inbound, bytes))) throw new TypeError("portable signed material refused");
						},
					};
				},
			};
			const received = await receiveCreatorSuccessorAdoption({
				plane: recipient,
				catalog: original.catalog,
				offer: exported.offer,
				expectedRoomHead: initialHead,
				snapshotStore: recipientSnapshots,
				transport: recipientPort,
				peers: ["portable-source"],
				author: receiverAuthor,
				signRegisteredVertexDigest: receiverSigner,
				exactCanonicalGenesisAnchorPreimageBytes: original.exactCanonicalAnchorPreimageBytes,
				detachedGenesisSignature: original.detachedAnchorSignature,
			});
			const staged = await stageCreatorSuccessorAdoption({ handle: received.handle, intent: received.verified.intent });
			if (staged.ok !== true) throw new TypeError(`portable recipient stage refused:${JSON.stringify(staged)}`);
			const published = await publishStagedCreatorSuccessorAdoption({
				handle: received.handle,
				capability: staged.capability,
			});
			if (published.ok !== true) throw new TypeError(`portable recipient publish refused:${JSON.stringify(published)}`);
			await recipient.deactivate();
			const floorScope = { objectId: original.objectId, pinnedGenesisAnchorDigest: original.anchorDigest };
			const preparedFloor = await recipientFloor.begin({
				scope: floorScope,
				expected: { stable: initialHead, pending: null },
				next: stable,
			});
			if (!preparedFloor.ok || preparedFloor.state === null)
				throw new TypeError("portable recipient target floor begin refused");
			const advancedFloor = await recipientFloor.commit({ scope: floorScope, expected: preparedFloor.state });
			if (!advancedFloor.ok) throw new TypeError("portable recipient target floor commit refused");
			const openRecipient = () =>
				reopenCreatorSuccessorAdoption({
					authenticationProfile: "creator-only",
					author: receiverAuthor,
					catalog: original.catalog,
					detachedSignature: original.detachedAnchorSignature,
					exactCanonicalAnchorPreimageBytes: original.exactCanonicalAnchorPreimageBytes,
					exactCanonicalParametersCarrierBytes: original.exactCanonicalParametersCarrierBytes,
					exactCanonicalPinnedGenesisBootstrapOperationBytes: encodeCanonical({ action: "add", value: 0 }),
					expectedRoomHead: stable,
					issuanceStore: recipientIssuance!,
					liveJournalStore: recipientJournal!,
					messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork(`portable-recipient-${crypto.randomUUID()}`),
					onAdmittedVertex: sink,
					pinnedGenesisAnchorDigest: original.anchorDigest,
					signRegisteredVertexDigest: receiverSigner,
					snapshotStore: recipientSnapshots!,
					store: recipientStore!,
					settlementFloor: recipientFloor!,
					settlementPolicy,
					...(fallback ? { createOperationAdmissionPolicy } : {}),
				});
			const opened = await openRecipient();
			if (!opened.ok) throw new TypeError(`portable recipient reopen refused:${JSON.stringify(opened)}`);
			recipient = opened.handle;
			const journalCount = () => {
				const db = new DatabaseSync(path.join(directory, "recipient-journal.sqlite.drp-live-journal-v1.sqlite"), {
					readOnly: true,
				});
				try {
					return Number(
						db
							.prepare(
								"SELECT count(*) AS n FROM accepted_entries WHERE object_id=? AND epoch=1 AND source_kind='received'"
							)
							.get(original.objectId)!.n
					);
				} finally {
					db.close();
				}
			};
			const transfer = async (sequence: number) => {
				const issued = await issuanceStore.readIssued(scope, sequence);
				if (issued === null) throw new TypeError("portable carrier missing");
				if (
					!routeV3RetainedIngress(
						recipient!,
						Message.create({
							data: V3Envelope.encode({
								canonicalPreimage: issued.envelope.canonicalPreimageBytes,
								signature: issued.envelope.signature,
							}).finish(),
							objectId: recipient!.topic,
							sender: "peer:source-bound-sender",
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
						})
					)
				)
					throw new TypeError("portable route refused");
				await recipient!.publishPending();
			};
			let queued: Readonly<{ journal: number; sink: number }> | undefined;
			let beforeReordered: Readonly<{ journal: number; sink: number }> | undefined;
			if (reverse) {
				beforeReordered = { journal: journalCount(), sink: sink.mock.calls.length };
				await transfer(3);
				queued = {
					journal: journalCount() - beforeReordered.journal,
					sink: sink.mock.calls.length - beforeReordered.sink,
				};
			}
			await transfer(2);
			const replacementRecord = await issuanceStore.readIssued(scope, 3);
			if (replacementRecord === null) throw new TypeError("portable signed replacement missing");
			const sendSigned = async (vertex: Readonly<Record<string, unknown>>, seed = followerSeed) => {
				const preimage = encodeCanonical(vertex),
					signature = ed25519.sign(hashDomain("ts-drp/vertex/v3", preimage), hexBytes(seed));
				if (
					!routeV3RetainedIngress(
						recipient!,
						Message.create({
							data: V3Envelope.encode({ canonicalPreimage: preimage, signature }).finish(),
							objectId: recipient!.topic,
							sender: "peer:signed-negative-control",
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
						})
					)
				)
					throw new TypeError("portable signed control route refused");
				await recipient!.publishPending();
			};
			const negativeResults: Record<string, Readonly<{ journal: number; sink: number }>> = {};
			const reject = async (
				name: string,
				mutate: (vertex: Record<string, unknown>, proof: Record<string, unknown>) => void,
				seed = followerSeed,
				creatorReselect = false
			) => {
				const vertex = decodeCanonical(replacementRecord.envelope.canonicalPreimageBytes) as Record<string, unknown>,
					proof = vertex.settlementSource as Record<string, unknown>;
				mutate(vertex, proof);
				if (creatorReselect) {
					const selection:Record<string,unknown>={};
					for(const [key,value] of Object.entries(proof))if(key!=="creatorSelectionSignature"&&key!=="fromIntent"&&key!=="throughIntent")selection[key]=value;
					proof.creatorSelectionSignature=ed25519.sign(hashDomain("ts-drp/settlement-source-selection/v1",encodeCanonical(selection)),hexBytes(contract.privateKeySeedHex));
				}
				const previous = { journal: journalCount(), sink: sink.mock.calls.length };
				await sendSigned(vertex, seed);
				negativeResults[name] = {
					journal: journalCount() - previous.journal,
					sink: sink.mock.calls.length - previous.sink,
				};
			};
			if(fabricatedMembership){
				await reject("fabricatedAcceptedMembership",(vertex,proof)=>{
					const originalSource=decodeCanonical(proof.sourcePreimage as Uint8Array) as Record<string,unknown>;
					originalSource.operation={action:"add",value:11};
					const preimage=encodeCanonical(originalSource),digest=hashDomain("ts-drp/vertex/v3",preimage);
					proof.sourcePreimage=preimage;
					proof.sourceSignature=ed25519.sign(digest,hexBytes(followerSeed));
					proof.sourceDigest=Buffer.from(digest).toString("hex");
					proof.intentDigest=Buffer.from(hashDomain("ts-drp/settlement-replacement-intents/v1",encodeCanonical([{action:"add",value:11}]))).toString("hex");
					vertex.operation={action:"add",value:11};
				});
				return {diagnostic:negativeResults.fabricatedAcceptedMembership,directory};
			}
			await reject("foreignSource", (_vertex, proof) => {
				proof.sourceObjectId = "creator:" + "bb".repeat(16);
			});
			await reject("absentCreatorSelection",(_vertex,proof)=>{proof.creatorSelectionSignature=null;});
			await reject("foreignCreatorSelection",(_vertex,proof)=>{proof.creatorSelectionSignature=ed25519.sign(new Uint8Array(32),hexBytes(receiverSeed));});
			await reject("selectedForeignSource",(_vertex,proof)=>{proof.sourceObjectId="creator:"+"bb".repeat(16);},followerSeed,true);
			await reject("selectedMissingDependency",(_vertex,proof)=>{proof.dependencyVertices=[];},followerSeed,true);
			await reject("selectedAlteredSourceAcl",(_vertex,proof)=>{const acl=decodeCanonical(proof.sourceAclBytes as Uint8Array) as Record<string,unknown>;acl.epoch=1;proof.sourceAclBytes=encodeCanonical(acl);},followerSeed,true);
			await reject("foreignSourceAnchor", (_vertex, proof) => {
				proof.sourceAnchor = "bb".repeat(32);
			});
			await reject("foreignTarget", (_vertex, proof) => {
				proof.targetObjectId = "creator:" + "bb".repeat(16);
			});
			await reject("foreignTargetAnchor", (_vertex, proof) => {
				proof.targetAnchor = "bb".repeat(32);
			});
			await reject("staleTargetAuthorization", (_vertex, proof) => {
				proof.targetEpoch = 0;
			});
			await reject("tamperedSourceProof", (_vertex, proof) => {
				const signature = proof.sourceSignature as Uint8Array;
				signature[0] = (signature[0] ?? 0) ^ 1;
			});
			await reject("missingProtectedDependency", (_vertex, proof) => {
				proof.dependencyVertices = [];
			});
			await reject("conflictingDependencyIdentity", (_vertex, proof) => {
				const dependencies = proof.dependencyVertices as unknown[];
				dependencies.push(dependencies[0]);
			});
			await reject("wrongIntents", (vertex) => {
				vertex.operation = { action: "add", value: 99 };
			});
			if (fallback) {
				await reject("forgedRefusalDigest", (_vertex, proof) => {
					(proof.transformRefusal as Record<string, unknown>).proposedIntentDigest = new Uint8Array(32);
				});
				await reject("forgedRefusalSchema", (_vertex, proof) => {
					(proof.transformRefusal as Record<string, unknown>).portableAuthority = true;
				});
			}
			await reject("noncontiguousRange", (_vertex, proof) => {
				proof.fromIntent = 1;
				proof.throughIntent = 2;
			});
			await reject(
				"currentWriterCannotIgnoreProof",
				(vertex) => {
					vertex.author = receiverAuthor;
					vertex.authorSequence = 1;
				},
				receiverSeed
			);
			const before =
				beforeReordered === undefined
					? { journal: journalCount(), sink: sink.mock.calls.length }
					: { journal: beforeReordered.journal + 1, sink: beforeReordered.sink };
			if (staleFloor) {
				const next = { ...stable, epoch: 2, currentAnchorDigest: "bb".repeat(32) };
				const pending = await recipientFloor.begin({ scope: floorScope, expected: { stable, pending: null }, next });
				if (!pending.ok || pending.state === null) throw new TypeError("portable stale floor preparation refused");
				const advanced = await recipientFloor.commit({ scope: floorScope, expected: pending.state });
				if (!advanced.ok) throw new TypeError("portable stale floor monotone commit refused");
				const pinnedBefore = await recipientFloor.readRetirementImage({ scope: floorScope });
				await transfer(3);
				const pinnedAfter = await recipientFloor.readRetirementImage({ scope: floorScope });
				return {
					remote: {
						staleFloor: {
							journal: journalCount() - before.journal,
							sink: sink.mock.calls.length - before.sink,
							unchanged: Buffer.from(encodeCanonical(pinnedBefore)).equals(Buffer.from(encodeCanonical(pinnedAfter))),
						},
						negativeResults,
					},
				};
			}
			interruptNextReceived = interrupt;
			if (fallback) {
				refuseRecipientOriginal = true;
				await transfer(3);
				negativeResults.freshTargetRefusal = {
					journal: journalCount() - before.journal,
					sink: sink.mock.calls.length - before.sink,
				};
				refuseRecipientOriginal = false;
			}
			await transfer(3);
			let interrupted: Readonly<Record<string, unknown>> | undefined;
			if (interrupt) {
				interrupted = { journal: journalCount() - before.journal, sink: sink.mock.calls.length - before.sink };
				await recipient.deactivate();
				const recoveredInterrupted = await openRecipient();
				if (!recoveredInterrupted.ok)
					throw new TypeError(`portable interrupted replay refused:${JSON.stringify(recoveredInterrupted)}`);
				recipient = recoveredInterrupted.handle;
			}
			const accepted = { journal: journalCount() - before.journal, sink: sink.mock.calls.length - before.sink };
			const deliveredOperations = sink.mock.calls
				.slice(before.sink)
				.map(([delivery]) => (delivery as { vertex: { operation: unknown } }).vertex.operation);
			await transfer(3);
			const duplicate = { journal: journalCount() - before.journal, sink: sink.mock.calls.length - before.sink };
			await reject("reusedRange", (vertex) => {
				vertex.authorSequence = 4;
				vertex.logicalTime = 7;
				vertex.dependencies = [replacement.digest];
			});
			await recipient.deactivate();
			const cold = await openRecipient();
			if (!cold.ok) throw new TypeError(`portable recipient persisted reopen refused:${JSON.stringify(cold)}`);
			recipient = cold.handle;
			const continuation = await recipient.issueLocal({
				operations: [{ logicalTime: 8, operation: { action: "add", value: 1 } }],
				signRegisteredVertexDigest: async (value) => ed25519.sign(value, hexBytes(receiverSeed)),
			});
			remoteResult = {
				accepted,
				deliveredOperations,
				duplicate,
				reopened: true,
				continuation,
				negativeResults,
				...(interrupted === undefined ? {} : { interrupted }),
				...(queued === undefined ? {} : { queued }),
			};
		}
		let localReopened=false;
		let custodyRefusals:readonly unknown[]|undefined;
		if(!remote && replacement.ok) {
			await current.deactivate();
			const foreignSeed="44".repeat(32), foreignAuthor=Buffer.from(ed25519.getPublicKey(hexBytes(foreignSeed))).toString("hex");
			custodyRefusals=[
				await openCurrent({author:foreignAuthor,signRegisteredVertexDigest:async digest=>ed25519.sign(digest,hexBytes(foreignSeed))}),
				await openCurrent({signRegisteredVertexDigest:async digest=>ed25519.sign(digest,hexBytes(foreignSeed))}),
				await openCurrent({issuanceStore:{...issuanceStore,readLineage:async selectedScope=>({...await issuanceStore.readLineage(selectedScope),next:-1})}}),
			];
			const cold=await openCurrent();
			if(!cold.ok)throw new TypeError(`local nonportable exact native replay refused:${JSON.stringify(cold)}`);
			current=cold.handle;
			localReopened=true;
			const after=await current.issueLocal({operations:[{logicalTime:9,operation:{action:"add",value:11}}],signRegisteredVertexDigest:signer});
			if(after.ok)throw new TypeError("local native recovery granted unauthorized NEW work");
		}
		return {
			localReopened,
			custodyRefusals,
			directory,
			admission,
			persistedPreparation,
			sourceIssued,
			replacement,
			...(finalSplitReplacement===undefined?{}:{finalSplitReplacement}),
			signerCalls,
			ordinaryNew,
			newSignerCalls,
			beforeNew,
			afterNew,
			sourceEpoch: 0,
			currentEpoch: 1,
			author: follower,
			plan: await issuanceStore.readSettlementPlan(scope),
			lineage: await issuanceStore.readLineage(scope),
			...(remoteResult === undefined ? {} : { remote: remoteResult }),
		};
	} finally {
		recipient?.deactivate();
		current?.deactivate();
		old?.deactivate();
		await Promise.all([
			creator?.close(),
			journal.close(),
			issuanceStore.close(),
			original.close(),
			floor?.close(),
			recipientIssuance?.close(),
			recipientJournal?.close(),
			recipientFloor?.close(),
			recipientPort?.close(),
			recipientSnapshots?.close(),
			recipientFixture?.close(),
		]);
	}
}

export interface NativeReplacementSourceResult {
	readonly cleanupJoined: boolean;
	readonly directory: string;
	readonly issued: V3LocalIssueResult;
	readonly sourceBefore: boolean;
	readonly sourceAfter: boolean;
	readonly signatureValid: boolean;
	readonly signerCalls: number;
	readonly lineageBefore: number;
	readonly lineageAfter: number;
	readonly outboxDelta: number;
	readonly planBefore: SettlementPlan | null;
	readonly planAfter: SettlementPlan | null;
	readonly journalDelta: number | null;
	readonly sinkDelta: number;
}

/**
 * Exercises the original raw replacement seam with no authenticated source.
 * All three stores and the registered signature are genuine; the plan is
 * deliberately a structural caller input, never settlement authority.
 * @param sourcePresent - Use the genuine signed Admin-only source instead of absent bytes.
 * @returns Reached issuer outcome and exact before/after native effects.
 */
export async function runNativeReplacementMissingSource(sourcePresent = false): Promise<NativeReplacementSourceResult> {
	const directory = mkdtempSync(path.join(tmpdir(), "drp-f5b0b-missing-source-"));
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "latched-acl",
		creatorTrustProfileId: "creator-trusted-settlement-v1",
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		latchedAclGroups: ["admin", "finality", "referee"],
		latchedAclVersion: 3,
	});
	const issuanceStore = createNodeDurableIssuanceStore({ primaryFilename: path.join(directory, "issuance.sqlite") });
	const journal = createNodeDurableLiveJournalStore({ primaryFilename: path.join(directory, "journal.sqlite") });
	let active: V3PlaneHandle | undefined;
	let cleanupJoined = false;
	let result: Omit<NativeReplacementSourceResult, "cleanupJoined" | "directory"> | undefined;
	try {
		const scope = Object.freeze({ author: fixture.author, objectId: fixture.objectId });
		const operation = { action: "acl", group: "writer", kind: "grant", target: fixture.author };
		const canonicalPreimageBytes = encodeCanonical({
			anchor: fixture.anchorDigest,
			author: fixture.author,
			authorSequence: 0,
			dependencies: [fixture.anchorDigest],
			epoch: 0,
			kind: "drp-vertex",
			logicalTime: 1,
			objectId: fixture.objectId,
			operation,
			protocolMajor: 3,
		});
		const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
		const signature = await fixture.signRegisteredVertexDigest(digest);
		await issuanceStore.transactIssue(scope, (authorSequence) => {
			if (authorSequence !== 0) throw new TypeError("native missing-source bootstrap sequence differs");
			const envelope = Object.freeze({ canonicalPreimageBytes, digest, signature });
			return Promise.resolve(
				Object.freeze({
					authorSequence,
					envelope,
					issuedRecord: Object.freeze({ authorSequence, envelope, scope }),
					outboxEntry: Object.freeze({ authorSequence, envelope, scope }),
				})
			);
		});
		const installed = await journal.installGenesis({
			detachedAnchorSignature: fixture.detachedAnchorSignature,
			exactCanonicalAnchorPreimageBytes: fixture.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: fixture.exactCanonicalParametersCarrierBytes,
			objectId: fixture.objectId,
		});
		if (!installed.ok) throw new TypeError("native missing-source journal install refused");
		const recovered = await recoverV3LiveReplica({
			capability: fixture.capability,
			exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore,
			liveJournalStore: journal,
		});
		if (!recovered.ok) throw new TypeError(`native missing-source recovery refused: ${recovered.kind}`);
		const sink = vi.fn();
		const activation = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: fakeNetwork("peer:d110c:f5b0b:native-missing-source"),
			onAdmittedVertex: sink,
		});
		if (!activation.ok) throw new TypeError("native missing-source activation refused");
		active = activation.handle;
		const bound = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: encodeCanonical(0), plane: active });
		if (!bound.ok) throw new TypeError("native missing-source blueprint bind refused");
		await writeSettlementPlan(issuanceStore, settlementPlan(scope, { empty: true }));
		const fence = await active.issueLocal({
			operations: [{ logicalTime: 2, operation: { action: AUTHOR_FENCE_ACTION, fenceSequence: 1, version: 1 } }],
			signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
		});
		if (!fence.ok) {
			console.log("native-missing-source-fence-refusal", { directory, fence });
			throw new TypeError(`native missing-source fence refused: ${fence.kind}`);
		}
		const fencedPlan = await issuanceStore.readSettlementPlan(scope);
		if (fencedPlan === null || fencedPlan.fenceSequence !== 1)
			throw new TypeError("native missing-source fence plan was not committed");
		await issuanceStore.transactWriteSettlementPlan({
			expectedRevision: fencedPlan.revision,
			plan: {
				...settlementPlan(scope, { disposition: "rebase", sourceSequence: sourcePresent ? 0 : 10, fenceSequence: 1 }),
				...(sourcePresent
					? { entries: [{ disposition: "rebase", replacementSequence: null, sourceDigest: digest, sourceSequence: 0 }] }
					: {}),
				revision: fencedPlan.revision + 1,
			},
			scope,
		});
		const journalScope = { anchorDigest: fixture.anchorDigest, epoch: 0, objectId: fixture.objectId };
		const before = {
			lineage: await issuanceStore.readLineage(scope),
			outbox: await issuanceStore.readOutboxPage({ scope }),
			plan: await issuanceStore.readSettlementPlan(scope),
			journal: await journal.readiness({ scope: journalScope }),
			source: await issuanceStore.readIssued(scope, sourcePresent ? 0 : 10),
			sinkCalls: sink.mock.calls.length,
		};
		const signer = vi.fn(fixture.signRegisteredVertexDigest);
		const issued = await active.issueLocal({
			operations: [{ logicalTime: 3, operation: { action: "add", value: 10 } }],
			planEffect: { kind: "replacement", sourceSequence: sourcePresent ? 0 : 10 },
			signRegisteredVertexDigest: signer,
		} as Parameters<V3PlaneHandle["issueLocal"]>[0]);
		const after = {
			lineage: await issuanceStore.readLineage(scope),
			outbox: await issuanceStore.readOutboxPage({ scope }),
			plan: await issuanceStore.readSettlementPlan(scope),
			journal: await journal.readiness({ scope: journalScope }),
			source: await issuanceStore.readIssued(scope, sourcePresent ? 0 : 10),
			sinkCalls: sink.mock.calls.length,
		};
		const replacement = issued.ok ? await issuanceStore.readIssued(scope, issued.authorSequence) : null;
		result = {
			issued,
			sourceBefore: before.source === null,
			sourceAfter: after.source === null,
			signatureValid:
				replacement !== null &&
				ed25519.verify(replacement.envelope.signature, replacement.envelope.digest, fixture.authorPublicKey, {
					zip215: false,
				}),
			signerCalls: signer.mock.calls.length,
			lineageBefore: before.lineage.next,
			lineageAfter: after.lineage.next,
			outboxDelta: after.outbox.length - before.outbox.length,
			planBefore: before.plan,
			planAfter: after.plan,
			journalDelta:
				before.journal.ok && before.journal.ready && after.journal.ok && after.journal.ready
					? after.journal.rowCount - before.journal.rowCount
					: null,
			sinkDelta: after.sinkCalls - before.sinkCalls,
		};
	} finally {
		active?.deactivate();
		const joined = await Promise.allSettled([journal.close(), issuanceStore.close(), fixture.close()]);
		cleanupJoined = joined.every((entry) => entry.status === "fulfilled");
		// Preserve failed artifacts and their exact native databases for inspection.
	}
	if (result === undefined) throw new TypeError("native replacement observation is unavailable");
	return { ...result, cleanupJoined, directory };
}

function isExactFenceOperation(value: unknown, fenceSequence: number): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	if (prototype !== Object.prototype && prototype !== null) return false;
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== 3 ||
		!keys.every((key) => typeof key === "string" && ["action", "fenceSequence", "version"].includes(key))
	) {
		return false;
	}
	const action = Object.getOwnPropertyDescriptor(value, "action");
	const sequence = Object.getOwnPropertyDescriptor(value, "fenceSequence");
	const version = Object.getOwnPropertyDescriptor(value, "version");
	return (
		action !== undefined &&
		Object.hasOwn(action, "value") &&
		action.enumerable === true &&
		action.value === AUTHOR_FENCE_ACTION &&
		sequence !== undefined &&
		Object.hasOwn(sequence, "value") &&
		sequence.enumerable === true &&
		sequence.value === fenceSequence &&
		version !== undefined &&
		Object.hasOwn(version, "value") &&
		version.enumerable === true &&
		version.value === 1
	);
}

export interface OpenSettlementNode {
	readonly blueprint: Extract<ReturnType<typeof bindV3BlueprintLivePlane>, { readonly ok: true }>["handle"];
	close(): Promise<void>;
	readonly fixture: Awaited<ReturnType<typeof createGenuinePreparedV3Fixture>>;
	readonly issuanceStore: DurableIssuanceStore;
	readonly journal: Awaited<ReturnType<typeof recover>>["journal"];
	readonly network: DRPNetworkNode;
	readonly plane: V3PlaneHandle;
	readonly sink: ReturnType<typeof vi.fn>;
	readonly scope: DurableIssueScope;
}

/**
 * Builds one closed deterministic settlement plan.
 * @param scope - Author/object durable scope.
 * @param input - Optional deterministic plan mutations.
 * @returns A closed revision-zero plan.
 */
export function settlementPlan(
	scope: DurableIssueScope,
	input: Readonly<{
		readonly disposition?: "expire" | "manual-review" | "rebase" | "transform";
		readonly empty?: boolean;
		readonly fenceSequence?: number | null;
		readonly sourceSequence?: number;
	}> = {}
): SettlementPlan {
	return Object.freeze({
		entries: Object.freeze(
			input.empty === true
				? []
				: [
						Object.freeze({
							disposition: input.disposition ?? "expire",
							replacementSequence: null,
							sourceDigest: new Uint8Array(32).fill(0xd1),
							sourceSequence: input.sourceSequence ?? 10,
						}),
					]
		),
		fenceSequence: input.fenceSequence ?? null,
		revision: 0,
		scope,
	});
}

/**
 * Writes the fixture plan through the public durable CAS seam.
 * @param store - Durable issuance owner.
 * @param plan - Initial plan to install.
 */
export async function writeSettlementPlan(store: DurableIssuanceStore, plan: SettlementPlan): Promise<void> {
	await store.transactWriteSettlementPlan({ expectedRevision: null, plan, scope: plan.scope });
}

/**
 * Opens an authenticated live Node plane using the selected trust profile.
 * @param profileId - Settlement or compatibility trust profile.
 * @param applicationBatch - Whether the genuine catalog admits Node application batches.
 * @returns Authenticated live plane and durable owners.
 */
export async function openSettlementNode(
	profileId: "creator-trusted-settlement-v1" | "creator-trusted-v1" = "creator-trusted-settlement-v1",
	applicationBatch = false
): Promise<OpenSettlementNode> {
	const initialState = encodeCanonical(0);
	const fixture = await createGenuinePreparedV3Fixture({
		applicationBatch,
		authorizationMode: "latched-acl",
		creatorTrustProfileId: profileId,
		exactCanonicalInitialStateBytes: initialState,
		latchedAclVersion: profileId === "creator-trusted-settlement-v1" ? 3 : 1,
	});
	const recovered = await recover(fixture, fixture.capability);
	const network = fakeNetwork(`peer:d110c:f5b0b:${profileId}`);
	const sink = vi.fn();
	const activation = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
		networkNode: network,
		onAdmittedVertex: sink,
	});
	if (!activation.ok) {
		await fixture.close();
		throw new TypeError(`settlement activation failed: ${activation.kind}`);
	}
	const binding = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialState, plane: activation.handle });
	if (!binding.ok) {
		activation.handle.deactivate();
		await fixture.close();
		throw new TypeError(`settlement blueprint binding failed: ${binding.kind}`);
	}
	return Object.freeze({
		blueprint: binding.handle,
		close: async (): Promise<void> => {
			activation.handle.deactivate();
			await fixture.close();
		},
		fixture,
		issuanceStore: recovered.issuanceStore,
		journal: recovered.journal,
		network,
		plane: activation.handle,
		sink,
		scope: Object.freeze({ author: fixture.author, objectId: fixture.objectId }),
	});
}

export interface RoutedOperationResult {
	readonly claimed: boolean;
	readonly digest: string;
	readonly journalRowsAfter: number;
	readonly journalRowsBefore: number;
}

/**
 * Routes one genuinely signed remote operation through transport and admission.
 * @param node - Active authenticated fixture plane.
 * @param operation - Canonical operation payload.
 * @param authorSequence - Outer author slot.
 * @param logicalTime - Outer logical time.
 * @param anchor - Exact outer anchor digest.
 * @returns Transport claim and durable journal delta.
 */
export async function routeSignedOperation(
	node: OpenSettlementNode,
	operation: Readonly<Record<string, unknown>>,
	authorSequence: number,
	logicalTime = 3,
	anchor = node.fixture.anchorDigest
): Promise<RoutedOperationResult> {
	const bootstrap = await node.issuanceStore.readIssued(node.scope, 0);
	if (bootstrap === null) throw new TypeError("settlement ingress bootstrap is unavailable");
	const preimage = encodeCanonical({
		anchor,
		author: node.fixture.author,
		authorSequence,
		dependencies: [Buffer.from(bootstrap.envelope.digest).toString("hex")],
		epoch: 0,
		kind: "drp-vertex",
		logicalTime,
		objectId: node.fixture.objectId,
		operation,
		protocolMajor: 3,
	});
	const digestBytes = hashDomain("ts-drp/vertex/v3", preimage);
	const signature = await node.fixture.signRegisteredVertexDigest(digestBytes);
	const envelope = V3Envelope.encode({ canonicalPreimage: preimage, signature }).finish();
	const readinessBefore = await node.journal.readiness({
		scope: { anchorDigest: node.fixture.anchorDigest, epoch: 0, objectId: node.fixture.objectId },
	});
	if (!readinessBefore.ok || !readinessBefore.ready) throw new TypeError("settlement ingress journal is unavailable");
	const gossipTopicFor = node.network.gossipTopicFor as ReturnType<typeof vi.fn>;
	gossipTopicFor.mockReturnValue(node.plane.topic);
	const claimed = routeV3Ingress(
		node.network,
		Message.create({
			data: envelope,
			objectId: node.plane.topic,
			sender: "settlement-peer",
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		})
	);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const readiness = await node.journal.readiness({
			scope: { anchorDigest: node.fixture.anchorDigest, epoch: 0, objectId: node.fixture.objectId },
		});
		if (readiness.ok && readiness.ready && readiness.rowCount !== readinessBefore.rowCount) {
			return Object.freeze({
				claimed,
				digest: Buffer.from(digestBytes).toString("hex"),
				journalRowsAfter: readiness.rowCount,
				journalRowsBefore: readinessBefore.rowCount,
			});
		}
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
	}
	const readinessAfter = await node.journal.readiness({
		scope: { anchorDigest: node.fixture.anchorDigest, epoch: 0, objectId: node.fixture.objectId },
	});
	return Object.freeze({
		claimed,
		digest: Buffer.from(digestBytes).toString("hex"),
		journalRowsAfter: readinessAfter.ok && readinessAfter.ready ? readinessAfter.rowCount : -1,
		journalRowsBefore: readinessBefore.rowCount,
	});
}

/**
 * Reopens the same durable issuance and journal truth with a fresh prepared capability.
 * @param node - Previously active settlement fixture.
 * @returns Fresh active handle over the same durable stores.
 */
export async function reopenSettlementNode(node: OpenSettlementNode): Promise<V3PlaneHandle> {
	node.plane.deactivate();
	const prepared = await node.fixture.prepareAgain();
	const recovered = await recoverV3LiveReplica({
		capability: prepared.capability,
		exactCanonicalLatchedAclBytes: node.fixture.exactCanonicalLatchedAclBytes,
		issuanceScope: node.scope,
		issuanceStore: node.issuanceStore,
		liveJournalStore: node.journal,
	} as Parameters<typeof recoverV3LiveReplica>[0]);
	if (!recovered.ok) throw new TypeError(`settlement reopen failed: ${recovered.kind}`);
	const activation = activateV3LivePlane({
		capability: recovered.capability,
		messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
		networkNode: fakeNetwork("peer:d110c:f5b0b:restart"),
		onAdmittedVertex: vi.fn(),
	});
	if (!activation.ok) throw new TypeError(`settlement reactivation failed: ${activation.kind}`);
	const binding = bindV3BlueprintLivePlane({
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		plane: activation.handle,
	});
	if (!binding.ok) throw new TypeError(`settlement rebind failed: ${binding.kind}`);
	return activation.handle;
}

/**
 * Reopens settlement recovery over an outbox row whose issued twin was corrupted after commit.
 * @param node - Active settlement fixture with genuine durable owners.
 * @returns The shipped recovery decision.
 */
export async function recoverSettlementIssuedOutboxMismatch(
	node: OpenSettlementNode
): Promise<Awaited<ReturnType<typeof recoverV3LiveReplica>>> {
	const bootstrap = await node.issuanceStore.readIssued(node.scope, 0);
	if (bootstrap === null) throw new TypeError("settlement mismatch bootstrap is unavailable");
	await node.issuanceStore.transactIssue(node.scope, async (authorSequence) => {
		const canonicalPreimageBytes = encodeCanonical({
			anchor: node.fixture.anchorDigest,
			author: node.fixture.author,
			authorSequence,
			dependencies: [Buffer.from(bootstrap.envelope.digest).toString("hex")],
			epoch: 0,
			kind: "drp-vertex",
			logicalTime: 3,
			objectId: node.fixture.objectId,
			operation: Object.freeze({ action: "add", value: 9 }),
			protocolMajor: 3,
		});
		const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
		const signature = await node.fixture.signRegisteredVertexDigest(digest);
		const envelope = Object.freeze({ canonicalPreimageBytes, digest, signature });
		return Object.freeze({
			authorSequence,
			envelope,
			issuedRecord: Object.freeze({ authorSequence, envelope, scope: node.scope }),
			outboxEntry: Object.freeze({ authorSequence, envelope, scope: node.scope }),
		});
	});
	node.plane.deactivate();
	const prepared = await node.fixture.prepareAgain();
	const mismatchedStore: DurableIssuanceStore = Object.freeze({
		close: () => Promise.resolve(),
		compareAndMarkOutboxPublished: (input) => node.issuanceStore.compareAndMarkOutboxPublished(input),
		readIssued: async (scope, authorSequence) => {
			const current = await node.issuanceStore.readIssued(scope, authorSequence);
			if (current === null || authorSequence !== 1) return current;
			const digest = new Uint8Array(current.envelope.digest);
			digest[0] = (digest[0] ?? 0) ^ 1;
			const envelope = Object.freeze({ ...current.envelope, digest });
			return Object.freeze({
				...current,
				envelope,
				issuedRecord: Object.freeze({ ...current.issuedRecord, envelope }),
				outboxEntry: Object.freeze({ ...current.outboxEntry, envelope }),
			});
		},
		readLineage: (scope) => node.issuanceStore.readLineage(scope),
		readOutboxPage: (input) => node.issuanceStore.readOutboxPage(input),
		readSettlementPlan: (scope) => node.issuanceStore.readSettlementPlan(scope),
		transactIssue: (scope, buildAndSign) => node.issuanceStore.transactIssue(scope, buildAndSign),
		transactWriteSettlementPlan: (input) => node.issuanceStore.transactWriteSettlementPlan(input),
	});
	return recoverV3LiveReplica({
		capability: prepared.capability,
		exactCanonicalLatchedAclBytes: node.fixture.exactCanonicalLatchedAclBytes,
		issuanceScope: node.scope,
		issuanceStore: mismatchedStore,
		liveJournalStore: node.journal,
	} as Parameters<typeof recoverV3LiveReplica>[0]);
}

export interface DurableFenceRestartResult {
	readonly fenceSequence?: number | null;
	readonly firstIssue: V3LocalIssueResult;
	readonly lineageNext?: number;
	readonly pendingFenceCount?: number;
	readonly replayedFence?: boolean;
}

/**
 * Crashes after a real SQLite fence transaction and reopens both durable adapters.
 * @returns First issue plus post-reopen durable census when issuance succeeds.
 */
export async function runDurableFenceRestart(): Promise<DurableFenceRestartResult> {
	const directory = mkdtempSync(path.join(tmpdir(), "drp-f5b0b-fence-restart-"));
	const issuanceFilename = path.join(directory, "issuance.sqlite");
	const journalFilename = path.join(directory, "journal.sqlite");
	const fixture = await createGenuinePreparedV3Fixture({
		authorizationMode: "latched-acl",
		creatorTrustProfileId: "creator-trusted-settlement-v1",
		exactCanonicalInitialStateBytes: encodeCanonical(0),
		latchedAclVersion: 3,
	});
	let issuanceStore = createNodeDurableIssuanceStore({ primaryFilename: issuanceFilename });
	let journal = createNodeDurableLiveJournalStore({ primaryFilename: journalFilename });
	let active: V3PlaneHandle | undefined;
	try {
		const scope = Object.freeze({ author: fixture.author, objectId: fixture.objectId });
		const carrier = fixture.createRecoveryVertex(0, [fixture.anchorDigest]);
		await issuanceStore.transactIssue(scope, (authorSequence) => {
			if (authorSequence !== 0) throw new TypeError("durable restart genesis sequence mismatch");
			const envelope = Object.freeze({
				canonicalPreimageBytes: carrier.canonicalPreimageBytes,
				digest: carrier.digest,
				signature: carrier.signature,
			});
			return Promise.resolve(
				Object.freeze({
					authorSequence,
					envelope,
					issuedRecord: Object.freeze({ authorSequence, envelope, scope }),
					outboxEntry: Object.freeze({ authorSequence, envelope, scope }),
				})
			);
		});
		const installed = await journal.installGenesis({
			detachedAnchorSignature: fixture.detachedAnchorSignature,
			exactCanonicalAnchorPreimageBytes: fixture.exactCanonicalAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes: fixture.exactCanonicalParametersCarrierBytes,
			objectId: fixture.objectId,
		});
		if (!installed.ok) throw new TypeError(`durable restart journal install failed: ${installed.kind}`);
		const recovered = await recoverV3LiveReplica({
			capability: fixture.capability,
			exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore,
			liveJournalStore: journal,
		} as Parameters<typeof recoverV3LiveReplica>[0]);
		if (!recovered.ok) throw new TypeError(`durable restart recovery failed: ${recovered.kind}`);
		const activation = activateV3LivePlane({
			capability: recovered.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: fakeNetwork("peer:d110c:f5b0b:durable-before-crash"),
			onAdmittedVertex: vi.fn(),
		});
		if (!activation.ok) throw new TypeError(`durable restart activation failed: ${activation.kind}`);
		active = activation.handle;
		const bound = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: encodeCanonical(0), plane: active });
		if (!bound.ok) throw new TypeError(`durable restart binding failed: ${bound.kind}`);
		await writeSettlementPlan(issuanceStore, settlementPlan(scope, { empty: true }));
		const firstIssue = await active.issueLocal({
			operations: [{ logicalTime: 2, operation: { action: AUTHOR_FENCE_ACTION, fenceSequence: 1, version: 1 } }],
			signRegisteredVertexDigest: fixture.signRegisteredVertexDigest,
		});
		if (!firstIssue.ok) return Object.freeze({ firstIssue });
		active.deactivate();
		active = undefined;
		await journal.close();
		await issuanceStore.close();
		issuanceStore = createNodeDurableIssuanceStore({ primaryFilename: issuanceFilename });
		journal = createNodeDurableLiveJournalStore({ primaryFilename: journalFilename });
		const preparedAgain = await fixture.prepareAgain();
		const reopened = await recoverV3LiveReplica({
			capability: preparedAgain.capability,
			exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes,
			issuanceScope: scope,
			issuanceStore,
			liveJournalStore: journal,
		} as Parameters<typeof recoverV3LiveReplica>[0]);
		if (!reopened.ok) throw new TypeError(`durable restart reopen failed: ${reopened.kind}`);
		const plan = await issuanceStore.readSettlementPlan(scope);
		const lineage = await issuanceStore.readLineage(scope);
		const rows = await issuanceStore.readOutboxPage({ scope });
		const fenceSequence = plan?.fenceSequence;
		const pendingFenceCount = rows.filter((row) => {
			if (fenceSequence === null || fenceSequence === undefined) return false;
			if (row.publishState !== "pending" || row.commit.authorSequence !== fenceSequence) return false;
			const envelope = row.commit.envelope;
			const digest = hashDomain("ts-drp/vertex/v3", envelope.canonicalPreimageBytes);
			if (
				digest.byteLength !== envelope.digest.byteLength ||
				!digest.every((byte, index) => byte === envelope.digest[index])
			) {
				return false;
			}
			if (!ed25519.verify(envelope.signature, digest, fixture.authorPublicKey, { zip215: false })) return false;
			const preimage = decodeCanonical(envelope.canonicalPreimageBytes);
			if (
				typeof preimage !== "object" ||
				preimage === null ||
				Reflect.get(preimage, "author") !== scope.author ||
				Reflect.get(preimage, "objectId") !== scope.objectId ||
				Reflect.get(preimage, "authorSequence") !== fenceSequence
			) {
				return false;
			}
			return isExactFenceOperation(Reflect.get(preimage, "operation"), fenceSequence);
		}).length;
		return Object.freeze({
			fenceSequence: plan?.fenceSequence,
			firstIssue,
			lineageNext: lineage.next,
			pendingFenceCount,
			replayedFence: reopened.descriptor.recoveredVertices.some(
				(vertex) => vertex.authorSequence === firstIssue.authorSequence
			),
		});
	} finally {
		active?.deactivate();
		await Promise.allSettled([journal.close(), issuanceStore.close(), fixture.close()]);
		rmSync(directory, { force: true, recursive: true });
	}
}

/**
 * Issues the reserved fence operation through the existing callable local issue seam.
 * @param node - Active settlement fixture.
 * @param logicalTime - Outer logical time.
 * @returns Local issue decision.
 */
export function issueFence(node: OpenSettlementNode, logicalTime = 2): Promise<V3LocalIssueResult> {
	return node.plane.issueLocal({
		operations: Object.freeze([
			Object.freeze({
				logicalTime,
				operation: Object.freeze({ action: AUTHOR_FENCE_ACTION, fenceSequence: 1, version: 1 }),
			}),
		]),
		signRegisteredVertexDigest: node.fixture.signRegisteredVertexDigest,
	});
}

/**
 * Issues one ordinary replacement with the durable source link on the callable local seam.
 * @param node - Active settlement fixture.
 * @param sourceSequence - Durable displaced-source key.
 * @param logicalTime - Outer logical time.
 * @returns Local issue decision.
 */
export function issueReplacement(
	node: OpenSettlementNode,
	sourceSequence = 10,
	logicalTime = 3
): Promise<V3LocalIssueResult> {
	return node.plane.issueLocal({
		operations: Object.freeze([
			Object.freeze({ logicalTime, operation: Object.freeze({ action: "add", value: sourceSequence }) }),
		]),
		planEffect: Object.freeze({ kind: "replacement", sourceSequence }),
		signRegisteredVertexDigest: node.fixture.signRegisteredVertexDigest,
	} as Parameters<V3PlaneHandle["issueLocal"]>[0]);
}

export interface NodeSettlementSourceAudit {
	readonly applicationControlSplit: boolean;
	readonly dedicatedFencePlanEffect: boolean;
	readonly settlementCompletionProfileGate: boolean;
	readonly settlementReaderOwnRows: boolean;
	readonly legacyFenceAdmissionGuard: boolean;
	readonly anchorAgnosticOlderEpochClassification: boolean;
}

/**
 * Static owner audit complements the executable live seam without importing a future export.
 * @returns Presence decisions for the exact Node-owned settlement obligations.
 */
export function auditNodeSettlementSource(): NodeSettlementSourceAudit {
	const source = readFileSync(resolve("packages/node/src/v3-live.ts"), "utf8");
	const settlementReader = /(?:function|const)\s+readSettlementSources\b/u.test(source);
	const fenceIssueZone = source.match(/(?:function|const)\s+issueAuthorFence[\s\S]{0,6000}/u)?.[0] ?? "";
	const completionZone = source.match(/async function completeRebaseSource[\s\S]{0,1800}/u)?.[0] ?? "";
	return Object.freeze({
		anchorAgnosticOlderEpochClassification:
			settlementReader &&
			/authenticated(?:Outbox|Issuance).*row/iu.test(source) &&
			/epoch\s*<\s*(?:current|registration)/u.test(source),
		applicationControlSplit:
			/closeVertices/u.test(source) &&
			/controlVertices/u.test(source) &&
			!/retainApplicationVertex\([\s\S]{0,160}AUTHOR_FENCE_ACTION/u.test(source),
		dedicatedFencePlanEffect:
			fenceIssueZone.includes("readSettlementPlan") &&
			fenceIssueZone.includes("transactIssue") &&
			fenceIssueZone.includes('kind: "fence"'),
		legacyFenceAdmissionGuard: /settlementProfileFor\([^)]*\)[\s\S]{0,500}AUTHOR_FENCE_ACTION/u.test(source),
		settlementCompletionProfileGate:
			completionZone.includes("settlementProfileFor") && completionZone.includes("not-active"),
		settlementReaderOwnRows:
			settlementReader &&
			/terminalThrough/u.test(source) &&
			!/(?:readSettlementSources[\s\S]{0,5000})(?:publishState\s*!==\s*["']pending["']|publishState\s*===\s*["']published["'])/u.test(
				source
			),
	});
}

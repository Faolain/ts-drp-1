/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- shared test-fixture helpers are intentionally untyped JavaScript */
import { MessageQueueManager } from "@ts-drp/message-queue";
/* eslint-disable import/no-unresolved -- the exact built subpath is intentionally absent in RED */
import {
	activateCreatorSuccessorAdoption,
	reopenCreatorSuccessorAdoption,
} from "@ts-drp/node/creator-adoption-activate";
import { republishV3RetainedTo } from "@ts-drp/node/v3-live";
/* eslint-enable import/no-unresolved */
import { createSqliteAheDurableStore } from "@ts-drp/storage-node";
import { createNodeDurableIssuanceStore } from "@ts-drp/storage-node/issuance";
import { createNodeDurableLiveJournalStore } from "@ts-drp/storage-node/live-journal";
import { createNodeSnapshotQuarantineStore } from "@ts-drp/storage-node/snapshot-transfer";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [, , mode] = process.argv;

function send(value) {
	if (typeof process.send === "function") process.send(value);
}

/** Detaches the byte carriers transferred over IPC. */
export function unpack(value) {
	if (Array.isArray(value)) return value.map(unpack);
	if (value !== null && typeof value === "object") {
		if (Object.keys(value).length === 1 && typeof value.bytesBase64 === "string") {
			return Uint8Array.from(Buffer.from(value.bytesBase64, "base64"));
		}
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unpack(entry)]));
	}
	return value;
}

/** Extracts one successful durable-store result. */
export function successful(result, label) {
	if (!result.ok) throw new Error(`${label}: ${result.reason ?? result.kind ?? "failed"}`);
	return result.value;
}

function signFixtureVertex(digest) {
	const seed = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex");
	const key = createPrivateKey({
		format: "der",
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
		type: "pkcs8",
	});
	return Promise.resolve(new Uint8Array(sign(null, Buffer.from(digest), key)));
}

async function putGeneration(store, generation, blobs, expectedHead) {
	await successful(
		await store.beginGeneration({
			baseExpectedHead: expectedHead,
			closure: generation.closure,
			generationId: generation.generationId,
			objectId: generation.objectId,
		}),
		"beginGeneration"
	);
	for (const ref of generation.closure) {
		const bytes = blobs.get(ref.digest);
		if (bytes === undefined) throw new Error(`missing durable blob ${ref.digest}`);
		await successful(
			await store.putCachedBlob({
				bytes,
				digest: ref.digest,
				generationId: generation.generationId,
				objectId: generation.objectId,
			}),
			"putCachedBlob"
		);
	}
	for (const ref of generation.closure) {
		await successful(
			await store.promoteReference({
				digest: ref.digest,
				generationId: generation.generationId,
				objectId: generation.objectId,
			}),
			"promoteReference"
		);
	}
	await successful(
		await store.completeGeneration({ generationId: generation.generationId, objectId: generation.objectId }),
		"completeGeneration"
	);
	return successful(
		await store.swapHead({
			expectedHead,
			generationId: generation.generationId,
			objectId: generation.objectId,
		}),
		"swapHead"
	).head;
}

/** Creates the deterministic network double shared by the fresh-process fixtures. */
export function network(events, publications, targetPeerId) {
	const topics = new Set();
	return {
		peerId: `d108d1-child-${process.pid}`,
		membershipVerifier: undefined,
		start: () => Promise.resolve(),
		stop: () => Promise.resolve(),
		restart: () => Promise.resolve(),
		isDialable: () => Promise.resolve(true),
		changeTopicScoreParams: () => undefined,
		removeTopicScoreParams: () => undefined,
		subscribe: (topic) => {
			events.push("subscribe");
			topics.add(topic);
		},
		unsubscribe: (topic) => topics.delete(topic),
		connectToBootstraps: () => Promise.resolve(),
		connect: () => Promise.resolve(),
		disconnect: () => Promise.resolve(),
		getPeerMultiaddrs: () => Promise.resolve([]),
		getBootstrapNodes: () => [],
		getSubscribedTopics: () => [...topics],
		getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"],
		getAllPeers: () => [targetPeerId],
		getGroupPeers: () => [],
		broadcastMessage: (...args) => {
			publications.push(args);
			return Promise.resolve();
		},
		publishMessage: (...args) => {
			publications.push(args);
			return Promise.resolve(true);
		},
		sendMessage: (peerId, message) => {
			publications.push(["send", peerId, message]);
			return Promise.resolve();
		},
		sendMessageToRandomPeer: () => Promise.resolve(),
		sendGroupMessage: () => Promise.resolve(),
		subscribeToMessageQueue: () => undefined,
		onGroupPeerChange: () => () => undefined,
		gossipTopicFor: () => undefined,
	};
}

/** Seeds one genuine native AHE custody set. */
export async function seedAhe(material, effects, suffix = "") {
	const raw = createSqliteAheDurableStore({ filename: join(material.directory, `ahe${suffix}.sqlite`) });
	const blobs = new Map();
	for (const candidate of material.blobs) blobs.set(candidate.ref.digest, candidate.bytes);
	blobs.set(material.active.projection.ref.digest, material.active.projection.bytes);
	const objectId = material.proposed.head.objectId;
	const none = { kind: "none", objectId };
	const currentGeneration = {
		closure: material.current.references,
		generationId: material.current.head.generationId,
		objectId,
	};
	const currentHead = await putGeneration(raw, currentGeneration, blobs, none);
	const proposedGeneration = {
		closure: material.proposed.references,
		generationId: material.proposed.head.generationId,
		objectId,
	};
	const proposedHead = await putGeneration(raw, proposedGeneration, blobs, currentHead);
	await putGeneration(
		raw,
		{ closure: material.active.closure, generationId: material.active.generationId, objectId },
		blobs,
		proposedHead
	);
	let adoptionSwapCount = 0;
	const store = new Proxy(raw, {
		get(target, property, receiver) {
			if (property === "recoverActiveGeneration") {
				return (...args) => {
					effects.aheRecoverCount += 1;
					return target.recoverActiveGeneration(...args);
				};
			}
			if (property !== "swapHead") return Reflect.get(target, property, receiver);
			return (...args) => {
				adoptionSwapCount += 1;
				return target.swapHead(...args);
			};
		},
	});
	return { adoptionSwapCount: () => adoptionSwapCount, raw, store };
}

async function seedIssuance(material, suffix = "") {
	const store = createNodeDurableIssuanceStore({
		primaryFilename: join(material.directory, `issuance${suffix}.sqlite`),
	});
	for (const row of material.issuance.outbox) {
		await store.transactIssue(material.issuance.scope, (authorSequence) => {
			if (authorSequence !== row.commit.authorSequence) throw new Error("issuance sequence diverged");
			return Promise.resolve(row.commit);
		});
		if (row.publishState === "published") {
			await store.compareAndMarkOutboxPublished({
				authorSequence: row.commit.authorSequence,
				digest: row.commit.envelope.digest,
				scope: material.issuance.scope,
			});
		}
	}
	return store;
}

/** Seeds one genuine native live-journal custody set. */
export async function seedJournal(material, effects, suffix = "") {
	const raw = createNodeDurableLiveJournalStore({
		primaryFilename: join(material.directory, `journal${suffix}.sqlite`),
	});
	const installed = await raw.installGenesis({
		detachedAnchorSignature: material.creatorGenesis.detachedSignature,
		exactCanonicalAnchorPreimageBytes: material.creatorGenesis.exactCanonicalAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes: material.creatorGenesis.exactCanonicalParametersCarrierBytes,
		objectId: material.proposed.head.objectId,
	});
	if (!installed.ok) throw new Error(`journal genesis rejected: ${installed.kind}`);
	for (const row of material.journalRows) {
		const { journalSequence: _journalSequence, ...input } = row;
		const appended = await raw.appendAccepted(input);
		if (!appended.ok) throw new Error(`journal row rejected: ${appended.kind}`);
	}
	return {
		raw,
		store: new Proxy(
			{},
			{
				get(_target, property) {
					if (property !== "installEpochAnchor") return Reflect.get(raw, property, raw);
					return (...args) => {
						effects.installEpochAnchorCount += 1;
						return raw.installEpochAnchor(...args);
					};
				},
			}
		),
	};
}

/** Seeds one genuine native snapshot quarantine. */
export async function seedSnapshot(material, events, effects, suffix = "", selectedMode = "cold") {
	const raw = createNodeSnapshotQuarantineStore({
		primaryFilename: join(material.directory, `snapshot${suffix}.sqlite`),
	});
	const scope = await raw.openScope(material.snapshot.declaration);
	const port = scope.verificationQuarantine.open(new AbortController().signal);
	for (let index = 0; index < material.snapshot.declaration.chunks.length; index += 1) {
		await port.write(material.snapshot.declaration.chunks[index], material.snapshot.chunks[index]);
	}
	await port.discard();
	await scope.release();
	const persistedScope = await raw.openScope(material.snapshot.declaration);
	const persistedPort = persistedScope.verificationQuarantine.open(new AbortController().signal);
	for (let index = 0; index < material.snapshot.declaration.chunks.length; index += 1) {
		const persisted = await persistedPort.read(material.snapshot.declaration.chunks[index]);
		if (persisted === undefined || !Buffer.from(persisted).equals(Buffer.from(material.snapshot.chunks[index]))) {
			throw new Error(`snapshot chunk ${index} did not persist after port discard`);
		}
	}
	const expiresAt = (await persistedScope.status()).expiresAt;
	await persistedPort.discard();
	await persistedScope.release();
	const verificationRaw = createNodeSnapshotQuarantineStore({
		primaryFilename: join(material.directory, `snapshot-verification${suffix}.sqlite`),
	});
	const expirationScope = await verificationRaw.openScope(material.snapshot.declaration);
	await expirationScope.release();
	const directReads = [];
	const completionDerivedReads = [];
	let completeAfterReads = false;
	const store = new Proxy(
		{},
		{
			get(_target, property) {
				if (property !== "openScope") return Reflect.get(verificationRaw, property, verificationRaw);
				return async (...args) => {
					effects.snapshotOpenCount += 1;
					events.push("snapshot:open-scope");
					const sourceOpened = await raw.openScope(...args);
					let opened;
					try {
						opened = await verificationRaw.openScope(...args);
					} catch (error) {
						await sourceOpened.release();
						throw error;
					}
					let quarantineAccessCount = 0;
					return new Proxy(
						{},
						{
							get(_scopeTarget, scopeProperty) {
								if (scopeProperty === "verificationQuarantine") {
									quarantineAccessCount += 1;
									if (quarantineAccessCount > 1) return opened.verificationQuarantine;
									const quarantine = sourceOpened.verificationQuarantine;
									return Object.freeze({
										open(...openArgs) {
											const openedPort = quarantine.open(...openArgs);
											return Object.freeze({
												discard: (...discardArgs) => openedPort.discard(...discardArgs),
												async read(descriptor) {
													const bytes = await openedPort.read(descriptor);
													if (bytes !== undefined && selectedMode !== "declaration-loop-mutant") {
														directReads.push({
															byteLength: descriptor.byteLength,
															digest: descriptor.digest,
															index: descriptor.index,
															observedBodySha256: createHash("sha256").update(bytes).digest("hex"),
															observedByteLength: bytes.byteLength,
															readInvocationOrdinal: directReads.length + 1,
															source: "verification-quarantine-port",
														});
														events.push(`snapshot:read:${descriptor.index}`);
													}
													return bytes;
												},
												write: (...writeArgs) => openedPort.write(...writeArgs),
											});
										},
									});
								}
								if (scopeProperty === "release") {
									return async () => {
										await Promise.all([sourceOpened.release(), opened.release()]);
									};
								}
								if (scopeProperty !== "complete") return Reflect.get(opened, scopeProperty, opened);
								return async (...completeArgs) => {
									if (quarantineAccessCount !== 2) {
										throw new Error(
											`verification quarantine access contract changed: expected 2, received ${quarantineAccessCount}`
										);
									}
									completeAfterReads = directReads.length === material.snapshot.declaration.chunks.length;
									const completed = await opened.complete(...completeArgs);
									if (selectedMode === "declaration-loop-mutant") {
										for (const [index, descriptor] of material.snapshot.declaration.chunks.entries()) {
											const bytes = material.snapshot.chunks[index];
											completionDerivedReads.push({
												byteLength: descriptor.byteLength,
												digest: descriptor.digest,
												index: descriptor.index,
												observedBodySha256: createHash("sha256").update(bytes).digest("hex"),
												observedByteLength: bytes.byteLength,
												readInvocationOrdinal: index + 1,
												source: "verification-quarantine-port",
											});
										}
									}
									events.push("snapshot:complete");
									return completed;
								};
							},
						}
					);
				};
			},
		}
	);
	return {
		expiresAt,
		raw: {
			async close() {
				await Promise.all([raw.close(), verificationRaw.close()]);
			},
		},
		store,
		telemetry(completeBeforeSubscribe) {
			const reads = selectedMode === "declaration-loop-mutant" ? completionDerivedReads : directReads;
			return {
				completeAfterReads,
				completeBeforeSubscribe,
				declaredChunkCount: material.snapshot.declaration.chunks.length,
				directReadInvocationCount: directReads.length,
				reads,
				telemetrySource: "awaited-port-read",
			};
		},
	};
}

function containsDigest(value, expected) {
	if (value instanceof Uint8Array) return Buffer.from(value).equals(expected);
	if (Array.isArray(value)) return value.some((entry) => containsDigest(entry, expected));
	if (value !== null && typeof value === "object") {
		return Object.values(value).some((entry) => containsDigest(entry, expected));
	}
	return false;
}

async function cold(material, selectedMode) {
	const events = [];
	const publications = [];
	const effects = {
		aheRecoverCount: 0,
		installEpochAnchorCount: 0,
		snapshotOpenCount: 0,
	};
	const ahe = await seedAhe(material, effects);
	const issuanceStore = await seedIssuance(material);
	const liveJournal = await seedJournal(material, effects);
	const snapshot = await seedSnapshot(material, events, effects, "", selectedMode);
	const secondStores =
		material.d108d1aIdentity === true
			? {
					ahe: await seedAhe(material, effects, "-second"),
					issuanceStore: await seedIssuance(material, "-second"),
					liveJournal: await seedJournal(material, effects, "-second"),
					snapshot: await seedSnapshot(material, events, effects, "-second"),
				}
			: undefined;
	const catalog = Object.freeze({
		blueprintDigests: Object.freeze([...material.catalog.blueprintDigests]),
		catalogDigest: material.catalog.catalogDigest,
		resolve(blueprintDigest) {
			if (blueprintDigest !== material.catalog.resolved.blueprintDigest) throw new Error("blueprint not catalogued");
			return material.catalog.resolved;
		},
	});
	const targetPeerId = `d108d1a-cold-target-${process.pid}`;
	const node = network(events, publications, targetPeerId);
	const adoptionSwapCount = () =>
		ahe.adoptionSwapCount() + (secondStores === undefined ? 0 : secondStores.ahe.adoptionSwapCount());
	let activeHandle;
	const originalNow = Date.now;
	try {
		if (selectedMode === "ttl-expired") Date.now = () => snapshot.expiresAt + 1;
		const reopenWith = (stores) =>
			reopenCreatorSuccessorAdoption({
				...material.creatorGenesis,
				author: material.issuance.scope.author,
				...(selectedMode === "divergent-genesis" ? { pinnedGenesisAnchorDigest: "f".repeat(64) } : {}),
				...(selectedMode === "extra-epoch" ? { epoch: 1 } : {}),
				catalog,
				...(selectedMode === "d110c-no-floor"
					? {}
					: {
							expectedRoomHead: {
								currentAnchorDigest:
									selectedMode === "d110c-wrong-floor" ? "f".repeat(64) : material.oracle.anchorDigest,
								epoch: material.oracle.epoch,
								objectId: material.oracle.objectId,
							},
						}),
				issuanceStore: stores.issuanceStore,
				liveJournalStore: stores.liveJournal.store,
				messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
				networkNode: node,
				onAdmittedVertex: () => undefined,
				signRegisteredVertexDigest: signFixtureVertex,
				snapshotDeclaration: material.snapshot.declaration,
				snapshotStore: stores.snapshot.store,
				store: stores.ahe.store,
			});
		const reopen = () => reopenWith({ ahe, issuanceStore, liveJournal, snapshot });
		const result = await reopen();
		if (!result.ok) {
			return {
				effects: {
					...effects,
					adoptionSwapCount: adoptionSwapCount(),
					publicationCount: publications.length,
					subscribeCount: events.filter((event) => event === "subscribe").length,
				},
				failure: { detail: result.detail, kind: result.kind, ok: false },
				pid: process.pid,
			};
		}
		activeHandle = result.handle;
		let firstIdentity;
		if (material.d108d1aIdentity === true) {
			const firstIssue = await result.handle.issueLocal({
				operations: [{ logicalTime: 30, operation: { action: "add", value: 13 } }],
				signRegisteredVertexDigest: signFixtureVertex,
			});
			if (!firstIssue.ok) throw new Error(`first cold identity issue failed: ${firstIssue.kind}`);
			firstIdentity = await republishV3RetainedTo(result.handle, targetPeerId);
			if (!firstIdentity.ok || firstIdentity.kind !== "published") {
				throw new Error(`first cold identity replay failed: ${firstIdentity.kind}`);
			}
		}
		const displaced = await result.handle.readRebaseOutbox();
		await result.handle.publishPending();
		const oldDigest = Buffer.from(
			material.issuance.outbox.find((row) => row.publishState === "pending").commit.envelope.digest
		);
		const subscribeIndex = events.indexOf("subscribe");
		const snapshotCompletionIndex = events.lastIndexOf("snapshot:complete");
		const snapshotReadCount = events.filter((event) => event.startsWith("snapshot:read:")).length;
		let identityReopens;
		if (material.d108d1aIdentity === true) {
			await Promise.resolve(result.handle.deactivate());
			activeHandle = undefined;
			if (secondStores === undefined) throw new Error("second cold identity stores are unavailable");
			const second = await reopenWith(secondStores);
			if (!second.ok) throw new Error(`second cold reopen failed: ${second.kind}: ${second.detail}`);
			activeHandle = second.handle;
			const secondIssue = await second.handle.issueLocal({
				operations: [{ logicalTime: 40, operation: { action: "add", value: 17 } }],
				signRegisteredVertexDigest: signFixtureVertex,
			});
			if (!secondIssue.ok) throw new Error(`second cold identity issue failed: ${secondIssue.kind}`);
			const secondIdentity = await republishV3RetainedTo(second.handle, targetPeerId);
			if (!secondIdentity.ok || secondIdentity.kind !== "published") {
				throw new Error(`second cold identity replay failed: ${secondIdentity.kind}`);
			}
			identityReopens = {
				first: firstIdentity.kind,
				second: secondIdentity.kind,
				sentCount: publications.filter((publication) => publication[0] === "send").length,
				targetPeerId,
			};
		}
		return {
			activation: {
				epoch: result.handle.epoch,
				lifecycle: result.lifecycle,
				ok: result.ok,
				recovery: result.recovery,
			},
			adoptionSwapCount: adoptionSwapCount(),
			...(identityReopens === undefined ? {} : { identityReopens }),
			pid: process.pid,
			oldOutbox: {
				classified: displaced.kind,
				publishedAsEpochOne: publications.some((publication) => containsDigest(publication, oldDigest)),
			},
			snapshotReadTelemetry: snapshot.telemetry(
				snapshotCompletionIndex >= 0 && snapshotCompletionIndex < subscribeIndex
			),
			snapshotImportedBeforeActivation:
				snapshotReadCount === material.snapshot.declaration.chunks.length &&
				snapshotCompletionIndex >= 0 &&
				snapshotCompletionIndex < subscribeIndex,
			trust: result.trust,
			...(selectedMode === "declaration-loop-mutant" ? { telemetryMutant: "declaration-loop" } : {}),
		};
	} finally {
		Date.now = originalNow;
		await Promise.resolve(activeHandle?.deactivate());
		await Promise.allSettled([
			snapshot.raw.close(),
			liveJournal.raw.close(),
			issuanceStore.close(),
			ahe.raw.close(),
			...(secondStores === undefined
				? []
				: [
						secondStores.snapshot.raw.close(),
						secondStores.liveJournal.raw.close(),
						secondStores.issuanceStore.close(),
						secondStores.ahe.raw.close(),
					]),
		]);
	}
}

function receiveMaterial() {
	return new Promise((resolve) => process.once("message", (message) => resolve(unpack(message))));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void (async () => {
		if (mode === "probe") {
			send({
				kind: "proof",
				proof: {
					exports: [
						typeof activateCreatorSuccessorAdoption === "function" ? "activateCreatorSuccessorAdoption" : "missing",
						typeof reopenCreatorSuccessorAdoption === "function" ? "reopenCreatorSuccessorAdoption" : "missing",
					],
					package: "@ts-drp/node/creator-adoption-activate",
				},
			});
			return;
		}
		const material = await receiveMaterial();
		send({ kind: "proof", proof: await cold(material, mode) });
	})().catch((error) => {
		send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	});
}

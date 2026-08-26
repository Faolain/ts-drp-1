/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { MessageQueueManager } from "@ts-drp/message-queue";
/* eslint-disable import/no-unresolved -- the exact built subpath is intentionally absent in RED */
import {
	activateCreatorSuccessorAdoption,
	reopenCreatorSuccessorAdoption,
} from "@ts-drp/node/creator-adoption-activate";
/* eslint-enable import/no-unresolved */
import { createSqliteAheDurableStore } from "@ts-drp/storage-node";
import { createNodeDurableIssuanceStore } from "@ts-drp/storage-node/issuance";
import { createNodeDurableLiveJournalStore } from "@ts-drp/storage-node/live-journal";
import { createNodeSnapshotQuarantineStore } from "@ts-drp/storage-node/snapshot-transfer";
import { join } from "node:path";

const [, , mode] = process.argv;

function send(value) {
	if (typeof process.send === "function") process.send(value);
}

function unpack(value) {
	if (Array.isArray(value)) return value.map(unpack);
	if (value !== null && typeof value === "object") {
		if (Object.keys(value).length === 1 && typeof value.bytesBase64 === "string") {
			return Uint8Array.from(Buffer.from(value.bytesBase64, "base64"));
		}
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unpack(entry)]));
	}
	return value;
}

function successful(result, label) {
	if (!result.ok) throw new Error(`${label}: ${result.reason ?? result.kind ?? "failed"}`);
	return result.value;
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

function network(events, publications) {
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
		getAllPeers: () => [],
		getGroupPeers: () => [],
		broadcastMessage: (...args) => {
			publications.push(args);
			return Promise.resolve();
		},
		publishMessage: (...args) => {
			publications.push(args);
			return Promise.resolve(true);
		},
		sendMessage: () => Promise.resolve(),
		sendMessageToRandomPeer: () => Promise.resolve(),
		sendGroupMessage: () => Promise.resolve(),
		subscribeToMessageQueue: () => undefined,
		onGroupPeerChange: () => () => undefined,
		gossipTopicFor: () => undefined,
	};
}

async function seedAhe(material, effects) {
	const raw = createSqliteAheDurableStore({ filename: join(material.directory, "ahe.sqlite") });
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

async function seedIssuance(material) {
	const store = createNodeDurableIssuanceStore({ primaryFilename: join(material.directory, "issuance.sqlite") });
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

async function seedJournal(material, effects) {
	const raw = createNodeDurableLiveJournalStore({ primaryFilename: join(material.directory, "journal.sqlite") });
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

async function seedSnapshot(material, events, effects) {
	const raw = createNodeSnapshotQuarantineStore({ primaryFilename: join(material.directory, "snapshot.sqlite") });
	const scope = await raw.openScope(material.snapshot.declaration);
	const port = scope.verificationQuarantine.open(new AbortController().signal);
	for (let index = 0; index < material.snapshot.declaration.chunks.length; index += 1) {
		await port.write(material.snapshot.declaration.chunks[index], material.snapshot.chunks[index]);
	}
	await port.discard();
	const expiresAt = (await scope.status()).expiresAt;
	await scope.release();
	const persistedScope = await raw.openScope(material.snapshot.declaration);
	const persistedPort = persistedScope.verificationQuarantine.open(new AbortController().signal);
	for (let index = 0; index < material.snapshot.declaration.chunks.length; index += 1) {
		const persisted = await persistedPort.read(material.snapshot.declaration.chunks[index]);
		if (persisted === undefined || !Buffer.from(persisted).equals(Buffer.from(material.snapshot.chunks[index]))) {
			throw new Error(`snapshot chunk ${index} did not persist after port discard`);
		}
	}
	await persistedPort.discard();
	await persistedScope.release();
	const store = new Proxy(
		{},
		{
			get(_target, property) {
				if (property !== "openScope") return Reflect.get(raw, property, raw);
				return async (...args) => {
					effects.snapshotOpenCount += 1;
					events.push("snapshot:open-scope");
					const opened = await raw.openScope(...args);
					return new Proxy(
						{},
						{
							get(_scopeTarget, scopeProperty) {
								if (scopeProperty === "verificationQuarantine") return opened.verificationQuarantine;
								if (scopeProperty !== "complete") return Reflect.get(opened, scopeProperty, opened);
								return async (...completeArgs) => {
									const completed = await opened.complete(...completeArgs);
									for (const descriptor of material.snapshot.declaration.chunks) {
										events.push(`snapshot:read:${descriptor.index}`);
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
	return { expiresAt, raw, store };
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
	const snapshot = await seedSnapshot(material, events, effects);
	const catalog = Object.freeze({
		blueprintDigests: Object.freeze([...material.catalog.blueprintDigests]),
		catalogDigest: material.catalog.catalogDigest,
		resolve(blueprintDigest) {
			if (blueprintDigest !== material.catalog.resolved.blueprintDigest) throw new Error("blueprint not catalogued");
			return material.catalog.resolved;
		},
	});
	const node = network(events, publications);
	let activeHandle;
	const originalNow = Date.now;
	try {
		if (selectedMode === "ttl-expired") Date.now = () => snapshot.expiresAt + 1;
		const result = await reopenCreatorSuccessorAdoption({
			...material.creatorGenesis,
			...(selectedMode === "divergent-genesis" ? { pinnedGenesisAnchorDigest: "f".repeat(64) } : {}),
			...(selectedMode === "extra-epoch" ? { epoch: 1 } : {}),
			catalog,
			issuanceStore,
			liveJournalStore: liveJournal.store,
			messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
			networkNode: node,
			onAdmittedVertex: () => undefined,
			snapshotDeclaration: material.snapshot.declaration,
			snapshotStore: snapshot.store,
			store: ahe.store,
		});
		if (!result.ok) {
			return {
				effects: {
					...effects,
					adoptionSwapCount: ahe.adoptionSwapCount(),
					publicationCount: publications.length,
					subscribeCount: events.filter((event) => event === "subscribe").length,
				},
				failure: { detail: result.detail, kind: result.kind, ok: false },
				pid: process.pid,
			};
		}
		activeHandle = result.handle;
		const displaced = await result.handle.readRebaseOutbox();
		await result.handle.publishPending();
		const oldDigest = Buffer.from(
			material.issuance.outbox.find((row) => row.publishState === "pending").commit.envelope.digest
		);
		const subscribeIndex = events.indexOf("subscribe");
		const snapshotCompletionIndex = events.lastIndexOf("snapshot:complete");
		const snapshotReadCount = events.filter((event) => event.startsWith("snapshot:read:")).length;
		return {
			activation: {
				epoch: result.handle.epoch,
				lifecycle: result.lifecycle,
				ok: result.ok,
				recovery: result.recovery,
			},
			adoptionSwapCount: ahe.adoptionSwapCount(),
			pid: process.pid,
			oldOutbox: {
				classified: displaced.kind,
				publishedAsEpochOne: publications.some((publication) => containsDigest(publication, oldDigest)),
			},
			snapshotImportedBeforeActivation:
				snapshotReadCount === material.snapshot.declaration.chunks.length &&
				snapshotCompletionIndex >= 0 &&
				snapshotCompletionIndex < subscribeIndex,
			trust: result.trust,
		};
	} finally {
		Date.now = originalNow;
		await Promise.resolve(activeHandle?.deactivate());
		await Promise.allSettled([snapshot.raw.close(), liveJournal.raw.close(), issuanceStore.close(), ahe.raw.close()]);
	}
}

function receiveMaterial() {
	return new Promise((resolve) => process.once("message", (message) => resolve(unpack(message))));
}

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

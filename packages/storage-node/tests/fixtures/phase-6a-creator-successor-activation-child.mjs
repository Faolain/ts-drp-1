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

const [, , mode, encodedInput] = process.argv;

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

async function seedAhe(material) {
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

async function seedJournal(material) {
	const store = createNodeDurableLiveJournalStore({ primaryFilename: join(material.directory, "journal.sqlite") });
	const installed = await store.installGenesis({
		detachedAnchorSignature: material.creatorGenesis.detachedSignature,
		exactCanonicalAnchorPreimageBytes: material.creatorGenesis.exactCanonicalAnchorPreimageBytes,
		exactCanonicalParametersCarrierBytes: material.creatorGenesis.exactCanonicalParametersCarrierBytes,
		objectId: material.proposed.head.objectId,
	});
	if (!installed.ok) throw new Error(`journal genesis rejected: ${installed.kind}`);
	for (const row of material.journalRows) {
		const { journalSequence: _journalSequence, ...input } = row;
		const appended = await store.appendAccepted(input);
		if (!appended.ok) throw new Error(`journal row rejected: ${appended.kind}`);
	}
	return store;
}

async function seedSnapshot(material, events) {
	const raw = createNodeSnapshotQuarantineStore({ primaryFilename: join(material.directory, "snapshot.sqlite") });
	const scope = await raw.openScope(material.snapshot.declaration);
	const port = scope.verificationQuarantine.open(new AbortController().signal);
	for (let index = 0; index < material.snapshot.declaration.chunks.length; index += 1) {
		await port.write(material.snapshot.declaration.chunks[index], material.snapshot.chunks[index]);
	}
	await port.discard();
	await scope.release();
	return new Proxy(raw, {
		get(target, property, receiver) {
			if (property !== "openScope") return Reflect.get(target, property, receiver);
			return (...args) => {
				events.push("snapshot-open");
				return target.openScope(...args);
			};
		},
	});
}

async function cold(material) {
	const events = [];
	const publications = [];
	const ahe = await seedAhe(material);
	const issuanceStore = await seedIssuance(material);
	const liveJournalStore = await seedJournal(material);
	const snapshotStore = await seedSnapshot(material, events);
	const catalog = Object.freeze({
		blueprintDigests: Object.freeze([...material.catalog.blueprintDigests]),
		catalogDigest: material.catalog.catalogDigest,
		resolve(blueprintDigest) {
			if (blueprintDigest !== material.catalog.resolved.blueprintDigest) throw new Error("blueprint not catalogued");
			return material.catalog.resolved;
		},
	});
	const node = network(events, publications);
	try {
		const result = await reopenCreatorSuccessorAdoption({
			...material.creatorGenesis,
			catalog,
			issuanceStore,
			liveJournalStore,
			messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
			networkNode: node,
			onAdmittedVertex: () => undefined,
			snapshotDeclaration: material.snapshot.declaration,
			snapshotStore,
			store: ahe.store,
		});
		if (!result.ok) throw new Error(`cold reopen rejected: ${result.kind}`);
		const displaced = await result.handle.readRebaseOutbox();
		await result.handle.publishPending();
		const oldDigest = Buffer.from(
			material.issuance.outbox.find((row) => row.publishState === "pending").commit.envelope.digest
		).toString("hex");
		const publicationText = JSON.stringify(publications, (_key, value) =>
			value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value
		);
		return {
			activation: {
				epoch: result.handle.epoch,
				lifecycle: result.lifecycle,
				ok: result.ok,
				recovery: result.recovery,
			},
			adoptionSwapCount: ahe.adoptionSwapCount(),
			freshProcess: true,
			oldOutbox: {
				classified: displaced.kind,
				publishedAsEpochOne: publicationText.includes(oldDigest),
			},
			snapshotImportedBeforeActivation:
				events.indexOf("snapshot-open") >= 0 && events.indexOf("snapshot-open") < events.indexOf("subscribe"),
		};
	} finally {
		await Promise.allSettled([snapshotStore.close(), liveJournalStore.close(), issuanceStore.close(), ahe.raw.close()]);
	}
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
	const material = unpack(JSON.parse(Buffer.from(encodedInput ?? "", "base64url").toString("utf8")));
	send({ kind: "proof", proof: await cold(material) });
})().catch((error) => {
	send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
});

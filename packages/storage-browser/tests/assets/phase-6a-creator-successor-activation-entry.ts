import { reopenCreatorSuccessorAdoption } from "@ts-drp/node/creator-adoption-activate";

import { createBrowserAheDurableStore } from "../../src/index.js";
import { createBrowserDurableIssuanceStore } from "../../src/issuance.js";
import { createBrowserDurableLiveJournalStore } from "../../src/live-journal.js";
import { createBrowserSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";

type PlainRecord = Readonly<Record<string, unknown>>;
type Closeable = Readonly<{ close(): Promise<void> }>;

const FIXTURE_AUTHOR_SEED = Uint8Array.from(
	"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20".match(/.{2}/gu) ?? [],
	(pair) => Number.parseInt(pair, 16)
);
const WRONG_AUTHOR_SEED = Uint8Array.from(
	"2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40".match(/.{2}/gu) ?? [],
	(pair) => Number.parseInt(pair, 16)
);
const ED25519_PKCS8_PREFIX = Uint8Array.from("302e020100300506032b657004220420".match(/.{2}/gu) ?? [], (pair) =>
	Number.parseInt(pair, 16)
);

async function signPossession(bytes: Uint8Array, seed: Uint8Array): Promise<Uint8Array> {
	const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.byteLength + FIXTURE_AUTHOR_SEED.byteLength);
	pkcs8.set(ED25519_PKCS8_PREFIX);
	pkcs8.set(seed, ED25519_PKCS8_PREFIX.byteLength);
	const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("Ed25519", key, new Uint8Array(bytes)));
}

interface ContenderResult {
	readonly detail?: string;
	readonly epoch?: number;
	readonly kind?: string;
	readonly lockHeld: boolean;
	readonly ok: boolean;
	readonly publicationCount: number;
	readonly recovery?: string;
	readonly signerCount: number;
	readonly verificationCount: number;
}

type PossessionSignerMode = "throw" | "valid" | "wrong-key";

declare global {
	interface Window {
		phase6aCreatorSuccessorActivation: Readonly<{
			openContender(
				databaseName: string,
				packedMaterial: unknown,
				signerMode?: PossessionSignerMode
			): Promise<ContenderResult>;
			probeAuthorityFailure(databaseName: string, packedMaterial: unknown): Promise<readonly ContenderResult[]>;
			probePossessionFailure(databaseName: string, packedMaterial: unknown): Promise<readonly ContenderResult[]>;
			release(): Promise<boolean>;
			seed(databaseName: string, packedMaterial: unknown): Promise<void>;
		}>;
	}
}

let activeHandle: Readonly<{ deactivate(): void | Promise<void> }> | undefined;
let activeStores: readonly Closeable[] = [];

class BrowserTestMessageQueueManager {
	private readonly queues = new Set<string>(["general"]);

	close(queueId: string): void {
		this.queues.delete(queueId === "" ? "general" : queueId);
	}

	enqueue(): Promise<void> {
		return Promise.resolve();
	}

	hasQueue(queueId: string): boolean {
		return this.queues.has(queueId === "" ? "general" : queueId);
	}

	subscribe(queueId: string): void {
		this.queues.add(queueId === "" ? "general" : queueId);
	}
}

function unpack(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(unpack);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (Object.keys(record).length === 1 && typeof record.bytesBase64 === "string") {
			return Uint8Array.from(atob(record.bytesBase64), (character) => character.charCodeAt(0));
		}
		return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, unpack(entry)]));
	}
	return value;
}

function successful(value: unknown, label: string): PlainRecord {
	const result = value as PlainRecord;
	if (result.ok !== true) throw new TypeError(`D.108d1 browser ${label} failed`);
	return result.value as PlainRecord;
}

async function putGeneration(
	store: Awaited<ReturnType<typeof createBrowserAheDurableStore>>,
	generation: PlainRecord,
	blobs: ReadonlyMap<string, Uint8Array>,
	expectedHead: PlainRecord
): Promise<PlainRecord> {
	successful(
		await store.beginGeneration({
			baseExpectedHead: expectedHead as never,
			closure: generation.closure as never,
			generationId: generation.generationId as never,
			objectId: generation.objectId as never,
		}),
		"beginGeneration"
	);
	for (const ref of generation.closure as readonly PlainRecord[]) {
		const bytes = blobs.get(String(ref.digest));
		if (bytes === undefined) throw new TypeError("D.108d1 browser blob missing");
		successful(
			await store.putCachedBlob({
				bytes,
				digest: ref.digest as never,
				generationId: generation.generationId as never,
				objectId: generation.objectId as never,
			}),
			"putCachedBlob"
		);
	}
	for (const ref of generation.closure as readonly PlainRecord[]) {
		successful(
			await store.promoteReference({
				digest: ref.digest as never,
				generationId: generation.generationId as never,
				objectId: generation.objectId as never,
			}),
			"promoteReference"
		);
	}
	successful(
		await store.completeGeneration({
			generationId: generation.generationId as never,
			objectId: generation.objectId as never,
		}),
		"completeGeneration"
	);
	return successful(
		await store.swapHead({
			expectedHead: expectedHead as never,
			generationId: generation.generationId as never,
			objectId: generation.objectId as never,
		}),
		"swapHead"
	).head as PlainRecord;
}

function trustedCatalog(material: PlainRecord): PlainRecord {
	const catalog = material.catalog as PlainRecord;
	const resolved = catalog.resolved as PlainRecord;
	return Object.freeze({
		blueprintDigests: catalog.blueprintDigests,
		catalogDigest: catalog.catalogDigest,
		resolve(blueprintDigest: string): PlainRecord {
			if (blueprintDigest !== resolved.blueprintDigest) throw new TypeError("blueprint not catalogued");
			return resolved;
		},
	});
}

function network(publications: unknown[]): PlainRecord {
	const topics = new Set<string>();
	return {
		peerId: `d108d1-browser-${crypto.randomUUID()}`,
		membershipVerifier: undefined,
		start: () => Promise.resolve(),
		stop: () => Promise.resolve(),
		restart: () => Promise.resolve(),
		isDialable: () => Promise.resolve(true),
		changeTopicScoreParams: () => undefined,
		removeTopicScoreParams: () => undefined,
		subscribe: (topic: string) => topics.add(topic),
		unsubscribe: (topic: string) => topics.delete(topic),
		connectToBootstraps: () => Promise.resolve(),
		connect: () => Promise.resolve(),
		disconnect: () => Promise.resolve(),
		getPeerMultiaddrs: () => Promise.resolve([]),
		getBootstrapNodes: () => [],
		getSubscribedTopics: () => [...topics],
		getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"],
		getAllPeers: () => [],
		getGroupPeers: () => [],
		broadcastMessage: (...args: unknown[]): Promise<void> => {
			publications.push(args);
			return Promise.resolve();
		},
		publishMessage: (...args: unknown[]): Promise<boolean> => {
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

async function openStores(databaseName: string): Promise<
	Readonly<{
		issuanceStore: Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>;
		liveJournalStore: Awaited<ReturnType<typeof createBrowserDurableLiveJournalStore>>;
		snapshotStore: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>>;
		store: Awaited<ReturnType<typeof createBrowserAheDurableStore>>;
	}>
> {
	const [issuanceStore, liveJournalStore, snapshotStore, store] = await Promise.all([
		createBrowserDurableIssuanceStore({ primaryDatabaseName: `${databaseName}-issuance` }),
		createBrowserDurableLiveJournalStore({ primaryDatabaseName: `${databaseName}-journal` }),
		createBrowserSnapshotQuarantineStore({ primaryDatabaseName: `${databaseName}-snapshot` }),
		createBrowserAheDurableStore({ databaseName: `${databaseName}-ahe` }),
	]);
	return {
		issuanceStore,
		liveJournalStore,
		snapshotStore,
		store,
	};
}

async function seed(databaseName: string, packedMaterial: unknown): Promise<void> {
	const material = unpack(packedMaterial) as PlainRecord;
	const stores = await openStores(databaseName);
	try {
		const blobs = new Map<string, Uint8Array>();
		for (const candidate of material.blobs as readonly PlainRecord[]) {
			const ref = candidate.ref as PlainRecord;
			blobs.set(String(ref.digest), candidate.bytes as Uint8Array);
		}
		const active = material.active as PlainRecord;
		const projection = active.projection as PlainRecord;
		const projectionRef = projection.ref as PlainRecord;
		blobs.set(String(projectionRef.digest), projection.bytes as Uint8Array);
		const current = material.current as PlainRecord;
		const proposed = material.proposed as PlainRecord;
		const objectId = (proposed.head as PlainRecord).objectId;
		const currentHead = await putGeneration(
			stores.store,
			{ closure: current.references, generationId: (current.head as PlainRecord).generationId, objectId },
			blobs,
			{ kind: "none", objectId }
		);
		const proposedHead = await putGeneration(
			stores.store,
			{ closure: proposed.references, generationId: (proposed.head as PlainRecord).generationId, objectId },
			blobs,
			currentHead
		);
		await putGeneration(
			stores.store,
			{ closure: active.closure, generationId: active.generationId, objectId },
			blobs,
			proposedHead
		);

		const issuance = material.issuance as PlainRecord;
		for (const row of issuance.outbox as readonly PlainRecord[]) {
			const commit = row.commit as PlainRecord;
			await stores.issuanceStore.transactIssue(issuance.scope as never, (sequence) => {
				if (sequence !== commit.authorSequence) throw new TypeError("D.108d1 browser issuance diverged");
				return Promise.resolve(commit as never);
			});
			if (row.publishState === "published") {
				await stores.issuanceStore.compareAndMarkOutboxPublished({
					authorSequence: commit.authorSequence as number,
					digest: (commit.envelope as PlainRecord).digest as Uint8Array,
					scope: issuance.scope as never,
				});
			}
		}

		const creatorGenesis = material.creatorGenesis as PlainRecord;
		const installed = await stores.liveJournalStore.installGenesis({
			detachedAnchorSignature: creatorGenesis.detachedSignature as Uint8Array,
			exactCanonicalAnchorPreimageBytes: creatorGenesis.exactCanonicalAnchorPreimageBytes as Uint8Array,
			exactCanonicalParametersCarrierBytes: creatorGenesis.exactCanonicalParametersCarrierBytes as Uint8Array,
			objectId: String(objectId) as never,
		});
		if (!installed.ok) throw new TypeError("D.108d1 browser journal genesis failed");
		for (const row of material.journalRows as readonly PlainRecord[]) {
			const { journalSequence: _journalSequence, ...input } = row;
			const appended = await stores.liveJournalStore.appendAccepted(input as never);
			if (!appended.ok) throw new TypeError("D.108d1 browser journal row failed");
		}

		const snapshot = material.snapshot as PlainRecord;
		const scope = await stores.snapshotStore.openScope(snapshot.declaration as never);
		const port = scope.verificationQuarantine.open(new AbortController().signal);
		for (let index = 0; index < (snapshot.chunks as readonly Uint8Array[]).length; index += 1) {
			await port.write(
				((snapshot.declaration as PlainRecord).chunks as readonly unknown[])[index] as never,
				(snapshot.chunks as readonly Uint8Array[])[index] as Uint8Array
			);
		}
		await port.discard();
		await scope.release();
		const persistedScope = await stores.snapshotStore.openScope(snapshot.declaration as never);
		const persistedPort = persistedScope.verificationQuarantine.open(new AbortController().signal);
		for (let index = 0; index < (snapshot.chunks as readonly Uint8Array[]).length; index += 1) {
			const persisted = await persistedPort.read(
				((snapshot.declaration as PlainRecord).chunks as readonly unknown[])[index] as never
			);
			const expected = (snapshot.chunks as readonly Uint8Array[])[index] as Uint8Array;
			if (persisted === undefined || indexedDB.cmp(persisted, expected) !== 0) {
				throw new TypeError(`D.108d1 browser snapshot chunk ${index} did not persist after port discard`);
			}
		}
		await persistedPort.discard();
		await persistedScope.release();
	} finally {
		await Promise.allSettled([
			stores.snapshotStore.close(),
			stores.liveJournalStore.close(),
			stores.issuanceStore.close(),
			stores.store.close(),
		]);
	}
}

async function openContender(
	databaseName: string,
	packedMaterial: unknown,
	signerMode: PossessionSignerMode = "valid"
): Promise<ContenderResult> {
	if (activeHandle !== undefined) {
		return {
			kind: "authority-unavailable",
			lockHeld: false,
			ok: false,
			publicationCount: 0,
			signerCount: 0,
			verificationCount: 0,
		};
	}
	const material = unpack(packedMaterial) as PlainRecord;
	const stores = await openStores(databaseName);
	const publications: unknown[] = [];
	let signerCount = 0;
	let verificationCount = 0;
	const countedStore = new Proxy(stores.store, {
		get(target, property, receiver): unknown {
			if (property !== "recoverActiveGeneration") return Reflect.get(target, property, receiver);
			return (...args: unknown[]): ReturnType<typeof target.recoverActiveGeneration> => {
				verificationCount += 1;
				return target.recoverActiveGeneration(...(args as Parameters<typeof target.recoverActiveGeneration>));
			};
		},
	});
	const signRegisteredVertexDigest = async (bytes: Uint8Array): Promise<Uint8Array> => {
		signerCount += 1;
		if (signerMode === "throw") throw new TypeError("D.108d1b browser signer threw");
		return signPossession(bytes, signerMode === "wrong-key" ? WRONG_AUTHOR_SEED : FIXTURE_AUTHOR_SEED);
	};
	try {
		const result = await reopenCreatorSuccessorAdoption({
			...(material.creatorGenesis as PlainRecord),
			author: (material.issuance as PlainRecord).scope
				? String(((material.issuance as PlainRecord).scope as PlainRecord).author)
				: "",
			catalog: trustedCatalog(material),
			issuanceStore: stores.issuanceStore,
			liveJournalStore: stores.liveJournalStore,
			messageQueueManager: new BrowserTestMessageQueueManager(),
			networkNode: network(publications),
			onAdmittedVertex: () => undefined,
			signRegisteredVertexDigest,
			snapshotDeclaration: (material.snapshot as PlainRecord).declaration,
			snapshotStore: stores.snapshotStore,
			store: countedStore,
		});
		if (result.ok !== true) {
			await Promise.allSettled([
				stores.snapshotStore.close(),
				stores.liveJournalStore.close(),
				stores.issuanceStore.close(),
				stores.store.close(),
			]);
			return {
				detail: String(result.detail),
				kind: String(result.kind),
				lockHeld: false,
				ok: false,
				publicationCount: publications.length,
				signerCount,
				verificationCount,
			};
		}
		const handle = result.handle as PlainRecord & Readonly<{ deactivate(): void | Promise<void> }>;
		activeHandle = handle;
		activeStores = [stores.snapshotStore, stores.liveJournalStore, stores.issuanceStore, stores.store];
		return {
			epoch: Number(handle.epoch),
			lockHeld: true,
			ok: true,
			publicationCount: publications.length,
			recovery: String(result.recovery),
			signerCount,
			verificationCount,
		};
	} catch (error) {
		await Promise.allSettled([
			stores.snapshotStore.close(),
			stores.liveJournalStore.close(),
			stores.issuanceStore.close(),
			stores.store.close(),
		]);
		throw error;
	}
}

async function probePossessionFailure(
	databaseName: string,
	packedMaterial: unknown
): Promise<readonly ContenderResult[]> {
	return Promise.all([
		openContender(databaseName, packedMaterial, "wrong-key"),
		openContender(databaseName, packedMaterial, "throw"),
	]);
}

async function probeAuthorityFailure(
	databaseName: string,
	packedMaterial: unknown
): Promise<readonly ContenderResult[]> {
	const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
	try {
		Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
		const missing = await openContender(databaseName, packedMaterial);
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: Object.freeze({ request: () => Promise.reject(new Error("D108D1_LOCK_REJECTED")) }),
		});
		const rejecting = await openContender(databaseName, packedMaterial);
		return [missing, rejecting];
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(navigator, "locks");
		else Object.defineProperty(navigator, "locks", descriptor);
	}
}

async function release(): Promise<boolean> {
	if (activeHandle === undefined) return false;
	await Promise.resolve(activeHandle.deactivate());
	activeHandle = undefined;
	const stores = activeStores;
	activeStores = [];
	await Promise.allSettled(stores.map((store) => store.close()));
	return true;
}

if (typeof window !== "undefined") {
	window.phase6aCreatorSuccessorActivation = Object.freeze({
		openContender,
		probeAuthorityFailure,
		probePossessionFailure,
		release,
		seed,
	});
}

import type { SnapshotExportFixture } from "./snapshot-transfer-fixture.js";
import { createV3ChatApplication } from "../../../examples/v3-chat/src/index.js";
import { createV3RoomCreatorInviteMaterial } from "../../../examples/v3-room/src/index.js";
import { encodeCanonical, hashDomain } from "../../../packages/canonical/src/index.js";
import { createCurrentAnchorTrustStore } from "../../../packages/control-plane/src/index.js";
import { Keychain } from "../../../packages/keychain/src/index.js";
import { MessageQueueManager } from "../../../packages/message-queue/src/index.js";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	prepareV3LiveGeneration,
	type RecoveredV3Live,
	recoverV3LiveReplica,
	type V3AdmittedVertexSink,
	type V3PlaneHandle,
} from "../../../packages/node/src/v3-live.js";
import {
	createAdmissionBoundTransactionalVertexIssuer,
	prepareBlueprintAdmission,
} from "../../../packages/protocol-v3/src/public.js";
import { parseStorageObjectId } from "../../../packages/storage/src/index.js";
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/src/index.js";
import { createBrowserDurableIssuanceStore } from "../../../packages/storage-browser/src/issuance.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/src/live-journal.js";
import type { DRPNetworkNode, Message } from "../../../packages/types/src/index.js";

const PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

interface SnapshotBlueprintHandle {
	exportSnapshotPayload(): Readonly<
		| ({ readonly kind: "exported"; readonly ok: true } & SnapshotExportFixture)
		| { readonly detail: string; readonly ok: false }
	>;
	stageBlueprintEpoch(): Promise<Readonly<{ readonly ok: boolean; adopt?(): Readonly<{ readonly ok: boolean }> }>>;
}

export interface BrowserRecoveredSnapshotAuthority {
	readonly capability: RecoveredV3Live;
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	readonly onAdmittedVertex: V3AdmittedVertexSink;
}

export interface BrowserLiveSnapshotFixture {
	readonly exported: SnapshotExportFixture;
	readonly sourceHandle: SnapshotBlueprintHandle;
	readonly sourcePlane: V3PlaneHandle;
	close(): Promise<void>;
	freshRecovered(label: string): Promise<BrowserRecoveredSnapshotAuthority>;
}

function lowerHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(hex: string): Uint8Array {
	if (!/^[0-9a-f]{64}$/u.test(hex)) throw new TypeError("browser snapshot author is invalid");
	return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function fakeNetwork(peerId: string): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId,
		membershipVerifier: undefined,
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		changeTopicScoreParams: (): void => undefined,
		connect: (): Promise<void> => Promise.resolve(),
		connectToBootstraps: (): Promise<void> => Promise.resolve(),
		disconnect: (): Promise<void> => Promise.resolve(),
		getAllPeers: (): string[] => [],
		getBootstrapNodes: (): [] => [],
		getGroupPeers: (): [] => [],
		getMultiaddrs: (): string[] => ["/ip4/127.0.0.1/tcp/1"],
		getPeerMultiaddrs: (): Promise<[]> => Promise.resolve([]),
		getSubscribedTopics: (): string[] => [...topics],
		gossipTopicFor: (): undefined => undefined,
		isDialable: (): Promise<boolean> => Promise.resolve(true),
		onGroupPeerChange: (): (() => void) => () => undefined,
		publishMessage: (): Promise<true> => Promise.resolve(true),
		removeTopicScoreParams: (): void => undefined,
		restart: (): Promise<void> => Promise.resolve(),
		sendGroupMessage: (): Promise<void> => Promise.resolve(),
		sendMessage: (): Promise<void> => Promise.resolve(),
		sendMessageToRandomPeer: (): Promise<void> => Promise.resolve(),
		start: (): Promise<void> => Promise.resolve(),
		stop: (): Promise<void> => Promise.resolve(),
		subscribe: (topic: string): void => {
			topics.add(topic);
		},
		subscribeToMessageQueue: (): void => undefined,
		unsubscribe: (topic: string): void => {
			topics.delete(topic);
		},
	} as unknown as DRPNetworkNode;
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onerror = (): void => reject(request.error);
		request.onblocked = (): void => reject(new TypeError(`browser snapshot database is still open: ${name}`));
		request.onsuccess = (): void => resolvePromise();
	});
}

/**
 * Creates one browser-native signed, prepared, recovered and folded v3 snapshot fixture.
 * @param databasePrefix - Unique database namespace owned by this fixture.
 * @returns Genuine source export plus fresh recovered-authority factory and cleanup.
 */
export async function createBrowserLiveSnapshotFixture(databasePrefix: string): Promise<BrowserLiveSnapshotFixture> {
	const objectId = `creator:${"c".repeat(32)}`;
	const initialState = encodeCanonical([]);
	const application = createV3ChatApplication("alice");
	const keychain = new Keychain({ private_key_seed: "phase-4c-c-browser-live-snapshot" });
	await keychain.start();
	const author = keychain.localAuthorId;
	const signerSet = Object.freeze([Object.freeze({ publicKey: author, signerId: "creator" })]);
	const exactCanonicalSignerSetBytes = encodeCanonical(signerSet);
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: Object.freeze([
			Object.freeze({
				author,
				finalityKey: author,
				groups: Object.freeze(["admin", "finality", "writer"]),
			}),
		]),
		objectId,
		permissionless: false,
		version: 1,
	});
	const exactCanonicalParametersCarrierBytes = encodeCanonical(PARAMETERS);
	const material = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: lowerHex(hashDomain("ts-drp/blueprint-admission/v3", application.canonicalBlueprintPackageBytes)),
		exactCanonicalApplicationStateBytes: initialState,
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-v1",
			quorum: 1,
			signers: signerSet,
		}),
		exactCanonicalSignerSetBytes,
		objectId,
		signGenesisAnchorDigest: (digest) => keychain.signWithLocalAuthor(digest),
	});
	const parsedObjectId = parseStorageObjectId(objectId);
	if (!parsedObjectId.ok) throw new TypeError("browser snapshot object id is invalid");
	const trustedObjectId = parsedObjectId.value as unknown as Parameters<typeof prepareV3LiveGeneration>[0]["objectId"];
	const closers: Array<() => Promise<void>> = [];
	const databaseNames = new Set<string>();
	let sequence = 0;

	const freshRecovered = async (label: string): Promise<BrowserRecoveredSnapshotAuthority> => {
		const primary = `${databasePrefix}--${label}-${sequence}`;
		sequence += 1;
		const aheName = `${primary}--ahe`;
		databaseNames.add(aheName);
		databaseNames.add(`${primary}--drp-issuance-v1`);
		databaseNames.add(`${primary}--drp-live-journal-v1`);
		const aheStore = await createBrowserAheDurableStore({ databaseName: aheName });
		const issuanceStore = await createBrowserDurableIssuanceStore({ primaryDatabaseName: primary });
		const journalStore = await createBrowserDurableLiveJournalStore({ primaryDatabaseName: primary });
		closers.push(
			() => aheStore.close(),
			() => issuanceStore.close(),
			() => journalStore.close()
		);
		const trust = createCurrentAnchorTrustStore({
			objectId: trustedObjectId,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			store: aheStore,
		});
		const installed = await trust.install({
			detachedGenesisSignature: material.detachedGenesisSignature,
			exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalProfileBytes: material.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: material.exactCanonicalSignerSetBytes,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
		});
		if (!installed.ok) throw new TypeError(`browser snapshot trust install failed: ${installed.reason}`);
		const prepared = await prepareV3LiveGeneration({
			authenticationProfile: "creator-only",
			catalog: application.catalog,
			detachedSignature: material.detachedGenesisSignature,
			exactCanonicalAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalParametersCarrierBytes,
			objectId: trustedObjectId,
			pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
			store: aheStore,
		});
		if (!prepared.ok) throw new TypeError(`browser snapshot preparation failed: ${prepared.kind}`);
		const admission = prepareBlueprintAdmission({
			canonicalBlueprintPackageBytes: application.canonicalBlueprintPackageBytes,
			expectedBlueprintDigest: prepared.descriptor.blueprintDigest,
		});
		const issuanceScope = Object.freeze({ author, objectId });
		const issuer = createAdmissionBoundTransactionalVertexIssuer({
			author,
			preparedBlueprintAdmission: admission,
			publicKey: Object.freeze({ bytes: bytes(author), format: "raw" as const }),
			signRegisteredVertexDigest: (digest) => keychain.signWithLocalAuthor(digest),
			transactIssue: (scope, buildAndSign) => issuanceStore.transactIssue(scope, buildAndSign),
		});
		await issuer.issue({
			anchor: material.pinnedGenesisAnchorDigest,
			dependencies: [material.pinnedGenesisAnchorDigest],
			epoch: 0,
			logicalTime: 1,
			objectId,
			operation: application.bootstrapOperation,
		});
		const recovered = await recoverV3LiveReplica({
			capability: prepared.capability,
			exactCanonicalLatchedAclBytes: material.exactCanonicalLatchedAclBytes,
			issuanceScope,
			issuanceStore,
			liveJournalStore: journalStore,
		});
		if (!recovered.ok) throw new TypeError(`browser snapshot recovery failed: ${recovered.kind}`);
		return Object.freeze({
			capability: recovered.capability,
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode: fakeNetwork(`${primary}--peer`),
			onAdmittedVertex: (): void => undefined,
		});
	};

	const source = await freshRecovered("source");
	const activated = activateV3LivePlane(
		Object.freeze({
			capability: source.capability,
			messageQueueManager: source.messageQueueManager,
			networkNode: source.networkNode,
			onAdmittedVertex: source.onAdmittedVertex,
		}) as unknown as Parameters<typeof activateV3LivePlane>[0]
	);
	if (!activated.ok) throw new TypeError(`browser source activation failed: ${activated.kind}`);
	const binding = bindV3BlueprintLivePlane({ exactCanonicalInitialStateBytes: initialState, plane: activated.handle });
	if (!binding.ok) throw new TypeError("browser source blueprint binding failed");
	for (let index = 0; index < 5; index += 1) {
		const issued = await activated.handle.issueLocal({
			operations: Object.freeze([
				Object.freeze({
					logicalTime: 3 + index * 2,
					operation: Object.freeze({
						action: "message",
						clientOperationId: `phase-4c-c-browser-message-${index}`,
						text: String(index).repeat(4_000),
					}),
				}),
			]),
			signRegisteredVertexDigest: (digest) => keychain.signWithLocalAuthor(digest),
		});
		if (!issued.ok) throw new TypeError(`browser source durable issue failed: ${issued.kind}`);
	}
	const staged = await binding.handle.stageBlueprintEpoch();
	if (!staged.ok || staged.adopt === undefined) {
		throw new TypeError(`browser source fold failed: ${Reflect.get(staged, "kind")}:${Reflect.get(staged, "detail")}`);
	}
	const adopted = staged.adopt();
	if (!adopted.ok) {
		throw new TypeError(
			`browser source adoption failed: ${Reflect.get(adopted, "kind")}:${Reflect.get(adopted, "detail")}`
		);
	}
	const exported = binding.handle.exportSnapshotPayload();
	if (!exported.ok) throw new TypeError(`browser source snapshot export failed: ${exported.detail}`);

	return Object.freeze({
		exported,
		sourceHandle: binding.handle,
		sourcePlane: activated.handle,
		freshRecovered,
		close: async (): Promise<void> => {
			activated.handle.deactivate();
			for (const close of closers.splice(0).reverse()) await close();
			for (const name of databaseNames) await deleteDatabase(name);
		},
	});
}

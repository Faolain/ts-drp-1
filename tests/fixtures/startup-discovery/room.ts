import { ed25519 } from "@noble/curves/ed25519.js";

import { requireValue } from "./assert.js";
import { authority } from "./floor.js";
import { event } from "./observation.js";
import type { Bootstrap } from "./types.js";
import { createV3ChatApplication } from "../../../examples/v3-chat/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomSession,
	type V3RoomTransport,
} from "../../../examples/v3-room/src/index.js";
import { encodeCanonical, hashDomain } from "../../../packages/canonical/dist/src/index.js";
import { createEphemeralChannel } from "../../../packages/ephemeral/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import { parseStorageObjectId } from "../../../packages/storage/dist/src/index.js";
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/dist/src/index.js";

export const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
/**
 *
 * @param value
 */
export function hex(value: Uint8Array): string {
	return Array.from(value, (v) => v.toString(16).padStart(2, "0")).join("");
}
/**
 *
 * @param identity
 */
export function seed(identity: string): Uint8Array {
	return hashDomain("ts-drp/startup-red-author/v1", new TextEncoder().encode(identity));
}
/**
 *
 * @param identity
 * @param profile
 */
export async function bootstrap(
	identity: string,
	profile: Bootstrap["profile"] = "creator-trusted-v1"
): Promise<Bootstrap> {
	const key = seed(identity),
		author = hex(ed25519.getPublicKey(key));
	const objectId =
		"creator:" + hex(hashDomain("ts-drp/startup-red-object/v1", new TextEncoder().encode(identity))).slice(0, 32);
	const app = createV3ChatApplication("alice");
	const signers = Object.freeze([Object.freeze({ publicKey: author, signerId: "creator" })]);
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: requireValue(app.catalog.blueprintDigests[0], "STARTUP_FIXTURE_PRECONDITION"),
		exactCanonicalApplicationStateBytes: encodeCanonical([]),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
			objectId,
			permissionless: false,
			version: profile === "creator-trusted-v1" ? 1 : 3,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: profile,
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: async (value) => Promise.resolve(ed25519.sign(value, key)),
	});
	return Object.freeze({ identity, invite, objectId, profile });
}
/**
 *
 * @param author
 * @param ephemeral
 */
export function transport(author: string, ephemeral = false): CreateV3RoomSessionInput["openTransport"] {
	return (): V3RoomTransport => {
		event("transport-open");
		const topics = new Set<string>();
		const networkNode = {
			broadcastMessage: async (): Promise<undefined> => Promise.resolve(undefined),
			changeTopicScoreParams: (): undefined => undefined,
			connect: async (): Promise<undefined> => Promise.resolve(undefined),
			connectToBootstraps: async (): Promise<undefined> => Promise.resolve(undefined),
			disconnect: async (): Promise<undefined> => Promise.resolve(undefined),
			getAllPeers: (): never[] => [],
			getBootstrapNodes: (): never[] => [],
			getGroupPeers: (): never[] => [],
			getMultiaddrs: (): never[] => [],
			getPeerMultiaddrs: async (): Promise<never[]> => Promise.resolve([]),
			getSubscribedTopics: (): string[] => [...topics],
			gossipTopicFor: (): undefined => undefined,
			isDialable: async (): Promise<boolean> => Promise.resolve(true),
			membershipVerifier: undefined,
			peerId: author,
			publishMessage: async (): Promise<boolean> => Promise.resolve(true),
			removeTopicScoreParams: (): undefined => undefined,
			restart: async (): Promise<undefined> => Promise.resolve(undefined),
			sendGroupMessageRandomPeer: async (): Promise<undefined> => Promise.resolve(undefined),
			sendMessage: async (): Promise<undefined> => Promise.resolve(undefined),
			start: async (): Promise<undefined> => Promise.resolve(undefined),
			stop: async (): Promise<undefined> => Promise.resolve(undefined),
			subscribe: (topic: string): void => {
				topics.add(topic);
			},
			subscribeToMessageQueue: (): undefined => undefined,
			unsubscribe: (topic: string): void => {
				topics.delete(topic);
			},
		};
		return {
			close: () => {
				event("transport-close");
			},
			networkNode,
			openEphemeral: (
				provider: Parameters<V3RoomTransport["openEphemeral"]>[0],
				options: Parameters<V3RoomTransport["openEphemeral"]>[1]
			): ReturnType<typeof createEphemeralChannel> => {
				if (!ephemeral) throw new Error("STARTUP_FIXTURE_EPHEMERAL_OUT_OF_SCOPE");
				// Real ephemeral channel; its local transport has no remote peers or traffic.
				const port = {
					localPeerId: author,
					authorizedPeers: (): never[] => [],
					isAuthorized: (): boolean => false,
					maxEnvelopeBytes: (): number => 65536,
					onMessage: () => (): undefined => undefined,
					send: async (): Promise<boolean> => Promise.resolve(false),
					authorForPeer: provider.authorForPeer,
					currentAuthority: provider.currentAuthority,
					isCurrentWriter: provider.isCurrentWriter,
					onPeerDisconnect: () => (): undefined => undefined,
				};
				return createEphemeralChannel(port, options);
			},
			requestRetainedHistory: () => {
				event("retained-request");
			},
			setIngressHandler: () => undefined,
			setRetainedPublisher: () => undefined,
		} as unknown as ReturnType<CreateV3RoomSessionInput["openTransport"]>;
	};
}
/**
 *
 * @param b
 * @param kind
 * @param signer
 */
export async function roomInput(
	b: Bootstrap,
	kind: "create" | "reopen",
	signer = true
): Promise<
	CreateV3RoomSessionInput<ReturnType<ReturnType<typeof createV3ChatApplication>["projectAcceptedOperations"]>>
> {
	const key = seed(b.identity),
		publicKeyBytes = ed25519.getPublicKey(key),
		author = hex(publicKeyBytes);
	const finality = await createRecoverableFinalitySigner({ seed: key });
	const original = createV3ChatApplication("alice");
	const application = Object.freeze({
		...original,
		projectAcceptedOperations: (input: Parameters<typeof original.projectAcceptedOperations>[0]) => {
			event("project", {
				baseEpoch: input.authenticatedBase?.epoch ?? null,
				operations: input.currentEpochOperations.length,
			});
			return original.projectAcceptedOperations(input);
		},
	});
	return {
		application,
		author,
		...(signer
			? { creatorFinalitySigner: finality.signer as unknown as CreateV3RoomSessionInput["creatorFinalitySigner"] }
			: {}),
		creatorInvite: b.invite,
		databaseName: b.identity,
		initialLogicalTime: 3,
		issuanceDatabaseName: b.identity,
		migrationDatabaseNamespace: b.identity,
		objectId: b.objectId,
		onAcceptedVertex: async (vertex): Promise<void> => {
			event("accepted", { authorSequence: vertex.authorSequence, action: Reflect.get(vertex.operation, "action") });

			return Promise.resolve();
		},
		onProjection: (): void => {
			event("projection");
		},
		openTransport: transport(author),
		publicKeyBytes,
		roomHeadAuthority: authority(b.identity, kind),
		signRegisteredVertexDigest: async (value): Promise<Uint8Array<ArrayBufferLike> & Uint8Array<ArrayBuffer>> => {
			event("sign");
			return Promise.resolve(ed25519.sign(value, key));
		},
	};
}
/**
 *
 * @param b
 * @param kind
 * @param signer
 * @param oldHint
 */
export async function openRoom(
	b: Bootstrap,
	kind: "create" | "reopen",
	signer = true,
	oldHint = false
): Promise<V3RoomSession<ReturnType<ReturnType<typeof createV3ChatApplication>["projectAcceptedOperations"]>>> {
	const input = await roomInput(b, kind, signer);
	// Diagnostic control contains no declaration/manifest/chunk/payload. The obsolete
	// selector only observes presence; product recovery must succeed without this key.
	type Projection = ReturnType<ReturnType<typeof createV3ChatApplication>["projectAcceptedOperations"]>;
	return createV3RoomSession<Projection>(
		(oldHint ? { ...input, successorSnapshotDeclaration: {} } : input) as CreateV3RoomSessionInput<Projection>
	);
}
/**
 *
 * @param id
 */
export function message(id: string): Readonly<{ action: "message"; clientOperationId: string; text: string }> {
	return Object.freeze({ action: "message", clientOperationId: id, text: id });
}
/**
 *
 * @param b
 */
export async function durableHead(
	b: Bootstrap
): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof createBrowserAheDurableStore>>["readHead"]>>> {
	const objectId = parseStorageObjectId(b.objectId);
	if (!objectId.ok) throw new Error("STARTUP_OBJECT_SCOPE");
	const store = await createBrowserAheDurableStore({ databaseName: b.identity + "--ahe" });
	try {
		return await store.readHead(objectId.value);
	} finally {
		await store.close();
	}
}

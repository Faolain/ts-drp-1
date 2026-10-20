/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";

import {
	createBrowserV3RoomDatabaseStorageHost,
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	waitForV3RoomStartupForDiagnostics,
} from "../../../../examples/v3-room/src/index.js";
import { toCanvasWireOperation } from "../../../../packages/blueprints/src/v3-canvas.js";
import { createRecoverableFinalitySigner } from "../../../../packages/keychain/src/finality.js";
import { type CanvasProjection, createV3CanvasApplication } from "../../../../packages/node/src/applications/canvas.js";
import { readCreatorSuccessorExport } from "../../../../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../../../../packages/storage/src/index.js";
import { createBrowserRoomHeadAuthority } from "../../../../packages/storage-browser/src/room-head.js";
import { ScriptedSnapshotChunkPort } from "../../phase-4c-v3/snapshot-pull-transport.js";
import { hex, jsonable, stable } from "./dump.js";

// Track M, slice 14f: the browser counterpart of tests/fixtures/track-m/room-retention-fixture.ts.
// The SAME room set-up (one canvas creator and one receive-only observer on the opt-in
// room-database host, a fake network, genuine rollover = gameplay, seal, adopt, install,
// then both lulls), with node-only pieces replaced: native IndexedDB instead of
// fake-indexeddb, the browser host floor (`createBrowserRoomHeadAuthority`, its own
// IndexedDB database) instead of the SQLite floor, random names instead of temporary
// directories, an Ed25519 key (as the healthy native Grid uses) instead of the Keychain,
// and small asserts instead of vitest. Product code is unchanged and comes from source.

export function required<Value>(value: Value | null | undefined, detail = "TRACK_M_14F_REQUIRED"): Value {
	if (value === undefined || value === null) throw new TypeError(detail);
	return value;
}

export function check(condition: boolean, detail: string): void {
	if (!condition) throw new Error(`TRACK_M_14F_CHECK: ${detail}`);
}

/** Recursive subset match (vitest toMatchObject semantics, enough for this fixture). */
export function matches(actual: unknown, expected: unknown): boolean {
	if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
	if (actual === null || typeof actual !== "object") return false;
	if (Array.isArray(expected))
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((item, index) => matches(actual[index], item))
		);
	return Object.entries(expected).every(([key, item]) => matches((actual as Record<string, unknown>)[key], item));
}

export function sameJson(left: unknown, right: unknown): boolean {
	const text = (value: unknown) =>
		JSON.stringify(value, (_key, item: unknown) => (item instanceof Uint8Array ? hex(item) : item));
	return text(left) === text(right);
}

export const paint = (id: string, rgb: [number, number, number]) =>
	toCanvasWireOperation({ action: "paint", offset: [1, 1], rgb }, id);
export const epochOf = (row: DurableIssueCommit) =>
	(decodeCanonical(row.envelope.canonicalPreimageBytes) as Record<string, unknown>).epoch;

/** The fake network of tests/fixtures/phase-4b-v3/live-snapshot.ts with call recording off (no vitest). */
export function fakeNetwork(peerId: string): DRPNetworkNode {
	const topics = new Set<string>();
	return {
		peerId,
		membershipVerifier: undefined,
		start: (): Promise<void> => Promise.resolve(),
		stop: (): Promise<void> => Promise.resolve(),
		restart: (): Promise<void> => Promise.resolve(),
		isDialable: (): Promise<boolean> => Promise.resolve(true),
		changeTopicScoreParams: (): undefined => undefined,
		removeTopicScoreParams: (): undefined => undefined,
		subscribe: (topic: string): Set<string> => topics.add(topic),
		unsubscribe: (topic: string): boolean => topics.delete(topic),
		connectToBootstraps: (): Promise<void> => Promise.resolve(),
		connect: (): Promise<void> => Promise.resolve(),
		disconnect: (): Promise<void> => Promise.resolve(),
		getPeerMultiaddrs: (): Promise<never[]> => Promise.resolve([]),
		getBootstrapNodes: (): never[] => [],
		getSubscribedTopics: (): string[] => [...topics],
		getMultiaddrs: (): string[] => ["/ip4/127.0.0.1/tcp/1"],
		getAllPeers: (): never[] => [],
		getGroupPeers: (): never[] => [],
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		publishMessage: (): Promise<boolean> => Promise.resolve(true),
		sendMessage: (): Promise<void> => Promise.resolve(),
		sendMessageToRandomPeer: (): Promise<void> => Promise.resolve(),
		sendGroupMessage: (): Promise<void> => Promise.resolve(),
		subscribeToMessageQueue: (): undefined => undefined,
		onGroupPeerChange: (): (() => void) => () => undefined,
		gossipTopicFor: (): undefined => undefined,
	} as unknown as DRPNetworkNode;
}

/** A deterministic Ed25519 identity (the healthy native Grid's identity shape). */
export function identity(seed: string) {
	const key = hashDomain("track-m-14f-identity/v1", new TextEncoder().encode(seed));
	const publicKey = ed25519.getPublicKey(key);
	let finality: Promise<Awaited<ReturnType<typeof createRecoverableFinalitySigner>>> | undefined;
	return Object.freeze({
		localAuthorId: hex(publicKey),
		publicKey,
		sign: (digest: Uint8Array) => Promise.resolve(ed25519.sign(digest, key)),
		// Cached like the Keychain's local author finality signer; the seed copy is consumed.
		finalitySigner: async () =>
			(await (finality ??= createRecoverableFinalitySigner({ seed: Uint8Array.from(key) }))).signer,
	});
}
export type Identity = ReturnType<typeof identity>;

/** A session wrapper a test installs to observe or interrupt the node's room transactions. */
export type SessionWrap = (
	session: Record<string, unknown>,
	label: string,
	database: string
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface RoomHostOptions {
	readonly retention: boolean;
	/** Database prefix (unique per case; stable across a crash and its recovery). */
	readonly prefix: string;
	readonly seed: string;
	/** Supply the ordinary resource bound reader so the creator's explicit lull runs. */
	readonly creatorLull?: boolean;
	/** The creator's invite, when this realm is the recipient's. */
	readonly invite?: Awaited<ReturnType<typeof createV3RoomCreatorInviteMaterial>>;
}

export const rooms = new Set<Readonly<{ close(): Promise<void> }>>();
export const heads = new Set<Readonly<{ close(): Promise<void> }>>();
export const ports = new Set<SnapshotChunkProtocolPort>();

export async function closeFixtures(): Promise<unknown[]> {
	const joined = await Promise.allSettled([...rooms].map((room) => room.close()));
	rooms.clear();
	const floorJoined = await Promise.allSettled([...heads].map((head) => head.close()));
	heads.clear();
	const portJoined = await Promise.allSettled([...ports].map((port) => port.close()));
	ports.clear();
	return [...joined, ...floorJoined, ...portJoined].flatMap((result) =>
		result.status === "rejected" ? [result.reason] : []
	);
}

export async function lullFixture(options: RoomHostOptions) {
	const creator = identity(`${options.seed}-creator`);
	const observer = identity(`${options.seed}-recipient`);
	const canvas = createV3CanvasApplication(2, 2);
	// As in the node fixture: a generous true upper bound for a 2x2 canvas lets the creator's explicit lull run.
	const application: typeof canvas =
		options.creatorLull === true
			? Object.freeze({
					...canvas,
					readOrdinaryApplicationResourceBound: Object.assign(
						() => Object.freeze({ byteLength: 65_536, items: 4096, maxDepth: 16 }),
						{}
					),
				})
			: canvas;
	const objectId = `creator:${hex(hashDomain("track-m-object/v1", new TextEncoder().encode(options.prefix))).slice(0, 32)}`;
	const signers = [{ publicKey: creator.localAuthorId, signerId: "creator" }];
	const invite =
		options.invite ??
		(await createV3RoomCreatorInviteMaterial({
			blueprintDigest: required(application.catalog.blueprintDigests[0]),
			exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
				application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
			),
			exactCanonicalLatchedAclBytes: encodeCanonical({
				epoch: 0,
				kind: "drp-v3-latched-acl",
				members: [
					{
						author: creator.localAuthorId,
						finalityKey: creator.localAuthorId,
						groups: ["admin", "finality", "writer"],
					},
				],
				objectId,
				permissionless: false,
				version: 1,
			}),
			exactCanonicalParametersCarrierBytes: encodeCanonical({
				maxDependencies: 16,
				maxEpochBytes: 8_388_608,
				maxEpochVertices: 8192,
				maxPendingBytes: 16_777_216,
				maxPendingEntries: 4096,
				maxSnapshotBytes: 268_435_456,
				snapshotChunkBytes: 131_072,
			}),
			exactCanonicalProfileBytes: encodeCanonical({
				cryptoSuiteId: "ed25519-sha256-v3",
				profileId: "creator-trusted-v1",
				quorum: 1,
				signers,
			}),
			exactCanonicalSignerSetBytes: encodeCanonical(signers),
			objectId,
			signGenesisAnchorDigest: (digest) => creator.sign(digest),
		}));
	const host = roomHost(options.prefix, options);
	const floorName = (name: string) => host.database(`${name}-floor`);
	const open = async (name: string, who: Identity, openOptions: { reopen?: boolean; receiveOnly?: true } = {}) => {
		const floor = await createBrowserRoomHeadAuthority({
			databaseName: floorName(name),
			initialization: { kind: openOptions.reopen === true ? "reopen" : "create" },
		});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		let publisher: ((targetPeerId?: string) => Promise<void>) | undefined;
		let retainedRequests = 0;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const peer = who === creator ? "canvas-creator" : "canvas-observer";
		const networkNode = fakeNetwork(peer);
		const input: CreateV3RoomSessionInput<CanvasProjection> & { receiveOnly?: true } = {
			application,
			storageHost: host.storageHost,
			author: who.localAuthorId,
			...(openOptions.receiveOnly ? { receiveOnly: true as const } : {}),
			...(who === creator ? { creatorFinalitySigner: await creator.finalitySigner() } : {}),
			creatorInvite: invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: Uint8Array.from(who.publicKey),
			roomHeadAuthority: floor,
			signRegisteredVertexDigest: (digest) => who.sign(digest),
			onProjection: () => undefined,
			onAcceptedVertex: (vertex) => {
				const digest = hex(vertex.digest);
				accepted.add(digest);
				acknowledged.get(digest)?.();
			},
			openTransport: () => {
				Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
				return {
					networkNode,
					close: () => undefined,
					openEphemeral: () => {
						throw new TypeError("TRACK_M_EPHEMERAL_UNUSED");
					},
					requestRetainedHistory: () => {
						retainedRequests++;
					},
					setRetainedPublisher: (selected) => {
						publisher = selected;
					},
					setIngressHandler: (selectedTopic, handler) => {
						topic = selectedTopic;
						ingress = handler;
					},
				};
			},
		};
		const room = await createV3RoomSession(input);
		rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		const receive = async (envelopes: readonly Envelope[], finalDigest: string) => {
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("TRACK_M_REMOTE_ADMISSION_TIMEOUT")), 120_000);
			});
			try {
				for (const envelope of envelopes)
					required(ingress)(
						Message.create({
							objectId: required(topic),
							sender: "canvas-creator",
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
							data: V3Envelope.encode({
								canonicalPreimage: envelope.canonicalPreimageBytes,
								signature: envelope.signature,
							}).finish(),
						})
					);
				await joined;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				acknowledged.delete(finalDigest);
			}
		};
		return {
			room,
			floor,
			networkNode,
			receive,
			publisher: () => required(publisher),
			retainedRequests: () => retainedRequests,
		};
	};
	const issued = async () => {
		const store = await host.storageHost.openIssuance("creator");
		try {
			const scope = { author: creator.localAuthorId, objectId };
			const lineage = await store.readLineage(scope);
			const rows: DurableIssueCommit[] = [];
			for (let sequence = 0; sequence < lineage.next; sequence++)
				rows.push(required(await store.readIssued(scope, sequence)));
			return rows;
		} finally {
			await store.close();
		}
	};
	const stop = async (opened: Awaited<ReturnType<typeof open>>) => {
		await opened.room.close();
		rooms.delete(opened.room);
		await opened.floor.close();
		heads.delete(opened.floor);
	};
	const declarations = new Map<number, unknown>();
	return { creator, observer, objectId, invite, host, application, open, issued, stop, declarations, floorName };
}

export type LullFixture = Awaited<ReturnType<typeof lullFixture>>;
export type OpenedRoom = Awaited<ReturnType<LullFixture["open"]>>;

export type Envelope = Readonly<{ canonicalPreimageBytes: Uint8Array; signature: Uint8Array }>;

/**
 * The recipient as the creator's realm drives it: in its own origin (the product admits
 * one live owner per object per origin), reached through `rpc.ts`.
 */
export interface Recipient {
	receive(envelopes: readonly Envelope[], finalDigest: string): Promise<void>;
	/** `stable` text of the projection state. */
	state(): Promise<string>;
	install(offer: unknown, peers: readonly string[]): Promise<unknown>;
	lull(): Promise<unknown>;
}

let successorFrames: ((bytes: Uint8Array) => Promise<readonly Uint8Array[]>) | undefined;
/** Creator side: the frames the creator's scripted successor host answers for one recipient write. */
export function dispatchSuccessorFrames(bytes: Uint8Array): Promise<readonly Uint8Array[]> {
	return required(successorFrames, "TRACK_M_14F_NO_SUCCESSOR_HOST")(bytes);
}

/** Creator side: serves the adopted successor (offer, and a scripted snapshot host). */
export async function serveSuccessor(fixture: LullFixture, creator: OpenedRoom) {
	const object = parseStorageObjectId(fixture.objectId);
	if (!object.ok) throw new TypeError("TRACK_M_INVALID_OBJECT");
	const store = await fixture.host.storageHost.openAhe("creator--ahe");
	const snapshots = await fixture.host.storageHost.openSnapshots("creator");
	try {
		const exported = await readCreatorSuccessorExport({
			store,
			snapshotStore: snapshots,
			catalog: fixture.application.catalog,
			objectId: object.value,
			pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
			exactCanonicalGenesisAnchorPreimageBytes: fixture.invite.exactCanonicalGenesisAnchorPreimageBytes,
			detachedGenesisSignature: fixture.invite.detachedGenesisSignature,
		});
		const scope = await snapshots.openScope(exported.declaration);
		const read = scope.verificationQuarantine.open(new AbortController().signal);
		const chunks: Uint8Array[] = [];
		try {
			for (const descriptor of exported.declaration.chunks) chunks.push(required(await read.read(descriptor)));
		} finally {
			await read.discard();
			await scope.release();
		}
		const scripted = new ScriptedSnapshotChunkPort(
			{ declaration: exported.declaration, chunks } as ConstructorParameters<typeof ScriptedSnapshotChunkPort>[0],
			new Map([["canvas-observer", "honest"]]),
			"canvas-creator"
		);
		Reflect.set(creator.networkNode, "createSnapshotChunkProtocolHost", () => scripted);
		const offer = await creator.room.exportCreatorSuccessor();
		ports.add(scripted);
		successorFrames = (bytes) => scripted.dispatch("canvas-observer", [bytes]);
		fixture.declarations.set(exported.declaration.scope.epoch, exported.declaration);
		return { offer, peers: ["canvas-creator"] };
	} finally {
		await snapshots.close();
		await store.close();
	}
}

/** Recipient side: the observer's snapshot port; every write is answered by the creator's host. */
export function recipientPort(
	dispatch: (bytes: Uint8Array) => Promise<readonly Uint8Array[]>
): SnapshotChunkProtocolPort {
	return {
		localPeerId: "canvas-observer",
		connectedPeers: () => ["canvas-creator"],
		close: () => Promise.resolve(),
		serve: () => () => undefined,
		open: (peer) => {
			const frames: Uint8Array[] = [];
			let closed = false;
			return Promise.resolve({
				peerId: peer,
				abort: () => {
					closed = true;
				},
				close: () => {
					closed = true;
					return Promise.resolve();
				},
				read: (maximum, readOptions) =>
					Promise.resolve().then(() => {
						readOptions.signal.throwIfAborted();
						if (closed) throw new TypeError("TRACK_M_STREAM_CLOSED");
						const frame = required(frames.shift());
						if (frame.byteLength > maximum) throw new TypeError("TRACK_M_MATERIAL_FRAME_LIMIT");
						return frame;
					}),
				write: async (bytes, writeOptions) => {
					writeOptions.signal.throwIfAborted();
					if (closed) throw new TypeError("TRACK_M_STREAM_CLOSED");
					frames.push(...(await dispatch(Uint8Array.from(bytes))));
				},
			});
		},
	};
}

/** Recipient side: the opened observer room behind the `Recipient` operations. */
export function localRecipient(
	opened: OpenedRoom,
	dispatch: (bytes: Uint8Array) => Promise<readonly Uint8Array[]>
): Recipient {
	return {
		receive: (envelopes, finalDigest) => opened.receive(envelopes, finalDigest),
		state: () => Promise.resolve(stable(opened.room.projection().state)),
		install: async (offer, peers) => {
			const port = recipientPort(dispatch);
			ports.add(port);
			Reflect.set(opened.networkNode, "createSnapshotChunkProtocolHost", () => port);
			await opened.room.installCreatorSuccessor({
				offer: offer as Parameters<OpenedRoom["room"]["installCreatorSuccessor"]>[0]["offer"],
				peers,
			});
			return jsonable(opened.room.authority());
		},
		lull: () => opened.room.maintainRecoveryPool(),
	};
}

/** Delivers every authenticated creator row of one epoch, in issue order, to the recipient. */
export async function deliverEpoch(fixture: LullFixture, recipient: Recipient, epoch: number) {
	const rows = (await fixture.issued()).filter((row) => epochOf(row) === epoch);
	await recipient.receive(
		rows.map((row) => ({
			canonicalPreimageBytes: row.envelope.canonicalPreimageBytes,
			signature: row.envelope.signature,
		})),
		hex(required(rows.at(-1)).envelope.digest)
	);
}

/** Gameplay, seal, adopt and install of one epoch (no lull). */
export async function transition(
	fixture: LullFixture,
	creator: OpenedRoom,
	recipient: Recipient,
	epoch: number,
	step: (name: string) => void = () => undefined
) {
	step("issue");
	await creator.room.issue(paint(`paint-${epoch}-a`, [1, 2, 3]));
	await creator.room.issue(paint(`paint-${epoch}-b`, [3, 2, 1]));
	step("deliver");
	await deliverEpoch(fixture, recipient, epoch);
	check((await recipient.state()) === stable(creator.room.projection().state), `projection ${epoch}`);
	step("seal");
	const sealed = await creator.room.sealEpoch();
	check(matches(sealed, { ok: true, epoch, successorEpoch: epoch + 1 }), `seal ${epoch} ${JSON.stringify(sealed)}`);
	step("adopt");
	await creator.room.adoptCreatorSuccessor();
	step("install");
	const transfer = await serveSuccessor(fixture, creator);
	const authority = await recipient.install(transfer.offer, transfer.peers);
	check(
		matches(authority, { epoch: epoch + 1, objectId: fixture.objectId }),
		`install ${epoch} ${JSON.stringify(authority)}`
	);
}

/** The integrated Grid's rollover with the opt-in lull: transition, then both lulls. */
export async function rollover(
	fixture: LullFixture,
	creator: OpenedRoom,
	recipient: Recipient,
	epoch: number,
	step: (name: string) => void = () => undefined
) {
	await transition(fixture, creator, recipient, epoch, step);
	step("creator-lull");
	const creatorLull = await creator.room.maintainRecoveryPool();
	step("recipient-lull");
	const recipientLull = await recipient.lull();
	return { creatorLull, recipientLull };
}

/**
 * The room database host under test, each fixture's databases under its own prefix.
 * Observation only, unless a test installs `wrap`: then every room retirement session
 * the node opens passes through it (crash and interruption injection).
 */
export function roomHost(prefix: string, options: Pick<RoomHostOptions, "retention">) {
	const base = createBrowserV3RoomDatabaseStorageHost(options.retention ? { roomRetention: true } : {});
	const name = (value: string) => `${prefix}-${value}`;
	const opened: string[] = [];
	let wrap: SessionWrap | undefined;
	const storageHost = Object.freeze({
		openAhe: (value: string) => base.openAhe(name(value)),
		openIssuance: (value: string) => base.openIssuance(name(value)),
		openJournal: (value: string) => base.openJournal(name(value)),
		openSnapshots: (value: string) => base.openSnapshots(name(value)),
		openSealVote: (value: string) => base.openSealVote(name(value)),
		openSealEvidence: (value: string) => base.openSealEvidence(name(value)),
		openCreatorSigningStores: (value: string) => required(base.openCreatorSigningStores)(name(value)),
		openRoomHead: (value: string, initialization: Parameters<typeof base.openRoomHead>[1]) =>
			base.openRoomHead(name(value), initialization),
		openRoomRetirement: async (value: string) => {
			const session = await required(base.openRoomRetirement)(name(value));
			opened.push(value);
			const selected = wrap;
			if (selected === undefined) return session;
			return (await selected(
				session as unknown as Record<string, unknown>,
				value,
				name(value)
			)) as unknown as typeof session;
		},
		...(options.retention ? { roomRetention: true as const } : {}),
	});
	return Object.freeze({
		storageHost,
		database: (value: string) => name(value),
		setWrap: (selected: SessionWrap | undefined) => {
			wrap = selected;
		},
		opened: () => [...opened],
	});
}

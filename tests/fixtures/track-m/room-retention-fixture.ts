/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

import {
	createBrowserV3RoomDatabaseStorageHost,
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import { toCanvasWireOperation } from "../../../packages/blueprints/src/v3-canvas.js";
import { Keychain } from "../../../packages/keychain/src/keychain.js";
import { type CanvasProjection, createV3CanvasApplication } from "../../../packages/node/src/applications/canvas.js";
import { readCreatorSuccessorExport } from "../../../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../../../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "../phase-4c-v3/snapshot-pull-transport.js";
import { creatorCurrency } from "../creator-currency.js";

// Track M (slice 14b): the R3 room-database lull fixture (tests/room-database-retirement-
// native.test.ts), shared by the Track M tests. One creator and one receive-only recipient
// on the browser ROOM DATABASE host (fake-indexeddb: mechanism evidence only; the native
// engines are slice 14f), with the same genuine rollover, lull, persisted close and reopen.
// `retention` opts the host into verified retention decisions; without it the host runs
// the existing per-class passes on the same room database.

export const directories = new Set<string>();
export const rooms = new Set<Readonly<{ close(): Promise<void> }>>();
export const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
export const keychains = new Set<Keychain>();
export const ports = new Set<SnapshotChunkProtocolPort>();
export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("TRACK_M_REQUIRED_FIXTURE_VALUE");
	return value;
}
export const paint = (id: string, rgb: [number, number, number]) =>
	toCanvasWireOperation({ action: "paint", offset: [1, 1], rgb }, id);
export const epochOf = (row: DurableIssueCommit) =>
	(decodeCanonical(row.envelope.canonicalPreimageBytes) as Record<string, unknown>).epoch;

/** Joins every owner a test opened; call from afterEach. */
export async function closeFixtures(): Promise<unknown[]> {
	const joined = await Promise.allSettled([...rooms].map((room) => room.close()));
	rooms.clear();
	const floorJoined = await Promise.allSettled([...heads].map((head) => head.close()));
	heads.clear();
	const portJoined = await Promise.allSettled([...ports].map((port) => port.close()));
	ports.clear();
	const keyJoined = await Promise.allSettled([...keychains].map((keychain) => keychain.stop()));
	keychains.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	return [...joined, ...floorJoined, ...portJoined, ...keyJoined].flatMap((result) =>
		result.status === "rejected" ? [result.reason] : []
	);
}

/** A session wrapper a test installs to observe or interrupt the node's room transactions. */
export type SessionWrap = (
	session: Record<string, unknown>,
	label: string,
	database: string
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface RoomHostOptions {
	readonly retention: boolean;
	readonly seed?: string;
	/** Supply the ordinary resource bound reader so the creator's explicit lull runs. */
	readonly creatorLull?: boolean;
}

export async function lullFixture(options: RoomHostOptions) {
	const directory = mkdtempSync(join(tmpdir(), "track-m-room-retention-"));
	directories.add(directory);
	const seed = options.seed ?? "track-m";
	const creator = new Keychain({ private_key_seed: `${seed}-creator` });
	const observer = new Keychain({ private_key_seed: `${seed}-recipient` });
	keychains.add(creator);
	keychains.add(observer);
	await Promise.all([creator.start(), observer.start()]);
	const canvas = createV3CanvasApplication(2, 2);
	// The creator's explicit lull needs the application's ordinary resource bound reader
	// (the Grid's zone application supplies one). A 2x2 canvas's whole projection is far
	// below this fixed footprint, so it is a true (generous) upper bound for every paint.
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
	const objectId = `creator:${hex(hashDomain("track-m-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const signers = [{ publicKey: creator.localAuthorId, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [
				{ author: creator.localAuthorId, finalityKey: creator.localAuthorId, groups: ["admin", "finality", "writer"] },
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
		signGenesisAnchorDigest: (digest) => creator.signWithLocalAuthor(digest),
	});
	const host = roomHost(
		`tm-${hex(hashDomain("track-m-room-host/v1", new TextEncoder().encode(directory))).slice(0, 16)}`,
		options
	);
	let creatorRoom: Awaited<ReturnType<typeof createV3RoomSession<CanvasProjection>>> | undefined;
	const open = async (name: string, identity: Keychain, openOptions: { reopen?: boolean; receiveOnly?: true } = {}) => {
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: openOptions.reopen ? "reopen" : "create" },
		});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		let publisher: ((targetPeerId?: string) => Promise<void>) | undefined;
		let retainedRequests = 0;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const peer = identity === creator ? "canvas-creator" : "canvas-observer";
		const networkNode = fakeNetwork(peer, false);
		const input: CreateV3RoomSessionInput<CanvasProjection> & { receiveOnly?: true } = {
			application,
			storageHost: host.storageHost,
			author: identity.localAuthorId,
			...(openOptions.receiveOnly ? { receiveOnly: true as const } : {}),
			...(identity === creator ? { creatorFinalitySigner: await creator.acquireLocalAuthorFinalitySigner() } : {}),
			creatorInvite: invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: Uint8Array.from(Buffer.from(identity.localAuthorId, "hex")),
			roomHeadAuthority: floor,
			signRegisteredVertexDigest: (digest) => identity.signWithLocalAuthor(digest),
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
		if (identity === creator) creatorRoom = room;
		// Decision B (sync before sending): a reopened Writer signs nothing until it is current. The
		// pages' successor delivery hands it the creator's statement on bind; this fixture does it.
		else if (openOptions.reopen && !openOptions.receiveOnly && creatorRoom !== undefined && rooms.has(creatorRoom)) {
			const statement = creatorRoom.currencyStatement?.();
			if (statement !== undefined) await room.confirmCurrent?.(statement);
		}
		const receive = async (envelopes: readonly DurableIssueCommit["envelope"][], finalDigest: string) => {
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("TRACK_M_REMOTE_ADMISSION_TIMEOUT")), 30_000);
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
	// Each successor declaration the creator exported, by its scope epoch (stale-writer probes).
	const declarations = new Map<number, unknown>();
	return { creator, observer, objectId, invite, host, application, open, issued, stop, directory, declarations };
}

export type LullFixture = Awaited<ReturnType<typeof lullFixture>>;
export type OpenedRoom = Awaited<ReturnType<LullFixture["open"]>>;

export async function delivery(fixture: LullFixture, creator: OpenedRoom) {
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
		const port: SnapshotChunkProtocolPort = {
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
						frames.push(...(await scripted.dispatch("canvas-observer", [bytes])));
					},
				});
			},
		};
		ports.add(port);
		fixture.declarations.set(exported.declaration.scope.epoch, exported.declaration);
		return { offer, port, peers: ["canvas-creator"] };
	} finally {
		await snapshots.close();
		await store.close();
	}
}

/** Delivers every authenticated creator row of one epoch, in issue order, to the recipient. */
export async function deliverEpoch(fixture: LullFixture, recipient: OpenedRoom, epoch: number) {
	const rows = (await fixture.issued()).filter((row) => epochOf(row) === epoch);
	await recipient.receive(
		rows.map((row) => row.envelope),
		hex(required(rows.at(-1)).envelope.digest)
	);
}

/** Gameplay, seal, adopt and install of one epoch (no lull). */
export async function transition(fixture: LullFixture, creator: OpenedRoom, recipient: OpenedRoom, epoch: number) {
	await creator.room.issue(paint(`paint-${epoch}-a`, [1, 2, 3]));
	await creator.room.issue(paint(`paint-${epoch}-b`, [3, 2, 1]));
	await deliverEpoch(fixture, recipient, epoch);
	expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
	await creator.room.adoptCreatorSuccessor();
	const transfer = await delivery(fixture, creator);
	Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers, ...creatorCurrency(creator.room) });
	expect(recipient.room.authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
}

/** The integrated Grid's rollover with the opt-in lull: transition, then both lulls. */
export async function rollover(fixture: LullFixture, creator: OpenedRoom, recipient: OpenedRoom, epoch: number) {
	await transition(fixture, creator, recipient, epoch);
	const creatorLull = await creator.room.maintainRecoveryPool();
	const recipientLull = await recipient.room.maintainRecoveryPool();
	return { creatorLull, recipientLull };
}

/**
 * The room database host under test, each fixture's databases under its own prefix.
 * Observation only, unless a test installs `wrap`: then every room retirement session
 * the node opens passes through it (crash and interruption injection).
 */
export function roomHost(prefix: string, options: RoomHostOptions) {
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
		dbNames: () => ({ creator: name("creator"), observer: name("observer") }),
		database: (value: string) => name(value),
		setWrap: (selected: SessionWrap | undefined) => {
			wrap = selected;
		},
		opened: () => [...opened],
	});
}

// Web Locks for this process, as the browser snapshot owner needs for its retirement
// exclusion: FIFO per name, exclusive and shared modes, ifAvailable and signal. Real
// browsers supply the native manager; node has none (as R3's tests install).
type LockMode = "exclusive" | "shared";
export function createProcessLockManager() {
	const held = new Map<string, { mode: LockMode; count: number }>();
	const queues = new Map<string, { mode: LockMode; grant: () => void }[]>();
	const compatible = (lockName: string, mode: LockMode) => {
		const current = held.get(lockName);
		return current === undefined || (current.mode === "shared" && mode === "shared");
	};
	const pump = (lockName: string) => {
		const queue = queues.get(lockName) ?? [];
		while (queue.length > 0 && compatible(lockName, required(queue[0]).mode)) required(queue.shift()).grant();
		if (queue.length === 0) queues.delete(lockName);
	};
	const request = async (lockName: string, ...rest: unknown[]) => {
		const callback = rest.at(-1) as (lock: unknown) => unknown;
		const lockOptions = (rest.length > 1 ? rest[0] : {}) as {
			mode?: LockMode;
			ifAvailable?: boolean;
			signal?: AbortSignal;
		};
		const mode = lockOptions.mode ?? "exclusive";
		if (lockOptions.ifAvailable === true && (!compatible(lockName, mode) || queues.has(lockName)))
			return await callback(null);
		await new Promise<void>((resolve, reject) => {
			const queue = queues.get(lockName) ?? [];
			const entry = {
				mode,
				grant: () => {
					held.set(lockName, { mode, count: (held.get(lockName)?.count ?? 0) + 1 });
					resolve();
				},
			};
			const signal = lockOptions.signal;
			if (signal !== undefined) {
				signal.throwIfAborted();
				signal.addEventListener(
					"abort",
					() => {
						const index = queue.indexOf(entry);
						if (index < 0) return;
						queue.splice(index, 1);
						reject(signal.reason);
					},
					{ once: true }
				);
			}
			queue.push(entry);
			queues.set(lockName, queue);
			pump(lockName);
		});
		try {
			return await callback(Object.freeze({ name: lockName, mode }));
		} finally {
			const current = required(held.get(lockName));
			if (current.count === 1) held.delete(lockName);
			else held.set(lockName, { mode: current.mode, count: current.count - 1 });
			pump(lockName);
		}
	};
	const query = async () => ({
		held: [...held].map(([lockName, { mode }]) => ({ name: lockName, mode })),
		pending: [...queues].flatMap(([lockName, queue]) => queue.map(({ mode }) => ({ name: lockName, mode }))),
	});
	return Object.freeze({ request, query });
}

/** Installs the process lock manager and an event observer; returns the restore. */
export function installEnvironment(observe: (event: Readonly<Record<string, unknown>>) => void) {
	const previousObserver = Reflect.get(globalThis, "__warmProofEvent");
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		if (event !== null && typeof event === "object") observe(event);
	});
	const previousLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
	Object.defineProperty(navigator, "locks", { configurable: true, value: createProcessLockManager() });
	return () => {
		Reflect.set(globalThis, "__warmProofEvent", previousObserver);
		Reflect.deleteProperty(globalThis, "__roomRetentionMode");
		Reflect.deleteProperty(globalThis, "__roomRetentionLimits");
		if (previousLocks === undefined) Reflect.deleteProperty(navigator, "locks");
		else Object.defineProperty(navigator, "locks", previousLocks);
	};
}

/** Every row of every object store of one room database (observation only). */
export async function dumpDatabase(database: string): Promise<Record<string, [unknown, unknown][]>> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(database);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		const names = [...db.objectStoreNames];
		const out: Record<string, [unknown, unknown][]> = {};
		if (names.length === 0) return out;
		const tx = db.transaction(names, "readonly");
		await Promise.all(
			names.map(
				(store) =>
					new Promise<void>((resolve, reject) => {
						const keys = tx.objectStore(store).getAllKeys();
						const values = tx.objectStore(store).getAll();
						values.onsuccess = () => {
							out[store] = (keys.result as unknown[]).map((key, index) => [key, (values.result as unknown[])[index]]);
							resolve();
						};
						values.onerror = () => reject(values.error);
					})
			)
		);
		return out;
	} finally {
		db.close();
	}
}

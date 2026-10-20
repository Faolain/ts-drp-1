/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "./fixtures/phase-4c-v3/snapshot-pull-transport.js";
import {
	createBrowserV3RoomDatabaseStorageHost,
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import { toCanvasWireOperation } from "../packages/blueprints/src/v3-canvas.js";
import { Keychain } from "../packages/keychain/src/keychain.js";
import { type CanvasProjection, createV3CanvasApplication } from "../packages/node/src/applications/canvas.js";
import { readCreatorSuccessorExport } from "../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// Track R3, slice 14a in the node: the same genuine rollover, lull, persisted close and
// reopen scenario as recipient-lull-reopen-close-native.test.ts (whose fixture this file
// copies), on the browser ROOM DATABASE host: every owner of a room in one version-7
// IndexedDB database (fake-indexeddb here: mechanism evidence only; the native engines
// are slice 14f). Its retirement session must carry every install of both peers, keep
// each peer playing through a persisted reopen, and leave a crash between the session's
// two transactions resumable: an active intent at a recipient's reopen must complete
// through the original received reconstruction instead of halting the room for good.
const directories = new Set<string>();
const rooms = new Set<V3RoomSession<CanvasProjection>>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const keychains = new Set<Keychain>();
const ports = new Set<SnapshotChunkProtocolPort>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("R3_ROOM_REQUIRED_FIXTURE_VALUE");
	return value;
}
const paint = (id: string, rgb: [number, number, number]) =>
	toCanvasWireOperation({ action: "paint", offset: [1, 1], rgb }, id);
const epochOf = (row: DurableIssueCommit) =>
	(decodeCanonical(row.envelope.canonicalPreimageBytes) as Record<string, unknown>).epoch;

afterEach(async () => {
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
	expect(
		[...joined, ...floorJoined, ...portJoined, ...keyJoined].filter((result) => result.status === "rejected"),
		"native admitted work and owners join"
	).toEqual([]);
});

async function lullFixture() {
	const directory = mkdtempSync(join(tmpdir(), "r3-room-retirement-"));
	directories.add(directory);
	const creator = new Keychain({ private_key_seed: "lull-reopen-creator" });
	const observer = new Keychain({ private_key_seed: "lull-reopen-recipient" });
	keychains.add(creator);
	keychains.add(observer);
	await Promise.all([creator.start(), observer.start()]);
	const application = createV3CanvasApplication(2, 2);
	const objectId = `creator:${hex(hashDomain("lull-reopen-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
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
	const host = roomHost(`r3-${hex(hashDomain("r3-room-host/v1", new TextEncoder().encode(directory))).slice(0, 16)}`);
	const open = async (name: string, identity: Keychain, options: { reopen?: boolean; receiveOnly?: true } = {}) => {
		const selectedHost = host;
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: options.reopen ? "reopen" : "create" },
		});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		let publisher: ((targetPeerId?: string) => Promise<void>) | undefined;
		let retainedRequests = 0;
		let transportRevoked = false;
		let revoked!: () => void;
		const revocation = new Promise<void>((resolve) => {
			revoked = resolve;
		});
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const peer = identity === creator ? "canvas-creator" : "canvas-observer";
		const networkNode = fakeNetwork(peer, false);
		const input: CreateV3RoomSessionInput<CanvasProjection> & { receiveOnly?: true } = {
			application,
			storageHost: selectedHost,
			author: identity.localAuthorId,
			...(options.receiveOnly ? { receiveOnly: true as const } : {}),
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
					close: () => {
						transportRevoked = true;
						revoked();
					},
					openEphemeral: () => {
						throw new TypeError("R3_ROOM_EPHEMERAL_UNUSED");
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
		const receive = async (envelopes: readonly DurableIssueCommit["envelope"][], finalDigest: string) => {
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("R3_ROOM_REMOTE_ADMISSION_TIMEOUT")), 30_000);
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
			transportRevoked: () => transportRevoked,
			revocation,
		};
	};
	const issued = async () => {
		const store = await host.openIssuance("creator");
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
	// Native observation only: the AHE retirement control the lull completed, never a grant.
	const retirementControl = async (name: string) => {
		const object = parseStorageObjectId(objectId);
		if (!object.ok) throw new TypeError("R3_ROOM_INVALID_OBJECT");
		const store = await host.openAhe(`${name}--ahe`);
		try {
			if (store.readRetirementControl === undefined) throw new TypeError("R3_ROOM_RETIREMENT_CONTROL_UNAVAILABLE");
			const result = await store.readRetirementControl(object.value);
			if (!result.ok) throw new TypeError(`R3_ROOM_RETIREMENT_CONTROL_${result.kind}`);
			return result.value;
		} finally {
			await store.close();
		}
	};
	return { creator, observer, objectId, invite, host, application, open, issued, stop, retirementControl };
}

type LullFixture = Awaited<ReturnType<typeof lullFixture>>;
type OpenedRoom = Awaited<ReturnType<LullFixture["open"]>>;

async function delivery(fixture: LullFixture, creator: OpenedRoom) {
	const object = parseStorageObjectId(fixture.objectId);
	if (!object.ok) throw new TypeError("R3_ROOM_INVALID_OBJECT");
	const store = await fixture.host.openAhe("creator--ahe");
	const snapshots = await fixture.host.openSnapshots("creator");
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
					read: (maximum, options) =>
						Promise.resolve().then(() => {
							options.signal.throwIfAborted();
							if (closed) throw new TypeError("R3_ROOM_STREAM_CLOSED");
							const frame = required(frames.shift());
							if (frame.byteLength > maximum) throw new TypeError("R3_ROOM_MATERIAL_FRAME_LIMIT");
							return frame;
						}),
					write: async (bytes, options) => {
						options.signal.throwIfAborted();
						if (closed) throw new TypeError("R3_ROOM_STREAM_CLOSED");
						frames.push(...(await scripted.dispatch("canvas-observer", [bytes])));
					},
				});
			},
		};
		ports.add(port);
		return { offer, port, peers: ["canvas-creator"] };
	} finally {
		await snapshots.close();
		await store.close();
	}
}

// Deliver every authenticated creator row of one epoch, in issue order, to the recipient.
async function deliverEpoch(fixture: LullFixture, recipient: OpenedRoom, epoch: number) {
	const rows = (await fixture.issued()).filter((row) => epochOf(row) === epoch);
	await recipient.receive(
		rows.map((row) => row.envelope),
		hex(required(rows.at(-1)).envelope.digest)
	);
}

// The integrated Grid's rollover with the opt-in lull: gameplay, seal, adopt, install,
// then the creator's lull and the recipient's lull at the new epoch.
async function rollover(fixture: LullFixture, creator: OpenedRoom, recipient: OpenedRoom, epoch: number) {
	await creator.room.issue(paint(`paint-${epoch}-a`, [1, 2, 3]));
	await creator.room.issue(paint(`paint-${epoch}-b`, [3, 2, 1]));
	await deliverEpoch(fixture, recipient, epoch);
	expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
	await creator.room.adoptCreatorSuccessor();
	const transfer = await delivery(fixture, creator);
	Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	expect(recipient.room.authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
	const creatorLull = await creator.room.maintainRecoveryPool();
	const requestsBefore = recipient.retainedRequests();
	const recipientLull = await recipient.room.maintainRecoveryPool();
	return { creatorLull, recipientLull, repairRequested: recipient.retainedRequests() > requestsBefore };
}

// The room database host under test, with each fixture's databases under its own
// prefix. Observation only: it records each session the node opens, and can make ONE
// armed session fail at its final commit after discarding that transaction, which is
// what a crash between the session's two transactions leaves durable.
function roomHost(prefix: string) {
	const base = createBrowserV3RoomDatabaseStorageHost();
	const name = (value: string) => `${prefix}-${value}`;
	const armed = new Map<string, string>();
	const opened: string[] = [];
	return Object.freeze({
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
			const crash = armed.get(value);
			if (crash === undefined) return session;
			armed.delete(value);
			return Object.freeze({
				...session,
				commit: async () => {
					await session.abort(new Error(crash));
					throw new Error(crash);
				},
			});
		},
		armCrash: (value: string, reason: string) => {
			armed.set(value, reason);
		},
		opened: () => [...opened],
	});
}

// Web Locks for this process, as the browser snapshot owner needs for its retirement
// exclusion: FIFO per name, exclusive and shared modes, ifAvailable and signal. Real
// browsers (the Grid and the .pw.ts suites) supply the native manager; node has none,
// and without one every browser host refuses a recipient lull with recovery-full.
type LockMode = "exclusive" | "shared";
function createProcessLockManager() {
	const held = new Map<string, { mode: LockMode; count: number }>();
	const queues = new Map<string, { mode: LockMode; grant: () => void }[]>();
	const compatible = (name: string, mode: LockMode) => {
		const current = held.get(name);
		return current === undefined || (current.mode === "shared" && mode === "shared");
	};
	const pump = (name: string) => {
		const queue = queues.get(name) ?? [];
		while (queue.length > 0 && compatible(name, required(queue[0]).mode)) required(queue.shift()).grant();
		if (queue.length === 0) queues.delete(name);
	};
	const request = async (name: string, ...rest: unknown[]) => {
		const callback = rest.at(-1) as (lock: unknown) => unknown;
		const options = (rest.length > 1 ? rest[0] : {}) as {
			mode?: LockMode;
			ifAvailable?: boolean;
			signal?: AbortSignal;
		};
		const mode = options.mode ?? "exclusive";
		if (options.ifAvailable === true && (!compatible(name, mode) || queues.has(name))) return await callback(null);
		await new Promise<void>((resolve, reject) => {
			const queue = queues.get(name) ?? [];
			const entry = {
				mode,
				grant: () => {
					held.set(name, { mode, count: (held.get(name)?.count ?? 0) + 1 });
					resolve();
				},
			};
			const signal = options.signal;
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
			queues.set(name, queue);
			pump(name);
		});
		try {
			return await callback(Object.freeze({ name, mode }));
		} finally {
			const current = required(held.get(name));
			if (current.count === 1) held.delete(name);
			else held.set(name, { mode: current.mode, count: current.count - 1 });
			pump(name);
		}
	};
	const query = async () => ({
		held: [...held].map(([name, { mode }]) => ({ name, mode })),
		pending: [...queues].flatMap(([name, queue]) => queue.map(({ mode }) => ({ name, mode }))),
	});
	return Object.freeze({ request, query });
}

const events: Readonly<Record<string, unknown>>[] = [];
let previousObserver: unknown;
let previousLocks: PropertyDescriptor | undefined;
beforeEach(() => {
	events.length = 0;
	previousObserver = Reflect.get(globalThis, "__warmProofEvent");
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		if (event?.kind === "closed-retirement-room-session") events.push(event);
	});
	previousLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
	Object.defineProperty(navigator, "locks", { configurable: true, value: createProcessLockManager() });
});
afterEach(() => {
	Reflect.set(globalThis, "__warmProofEvent", previousObserver);
	if (previousLocks === undefined) Reflect.deleteProperty(navigator, "locks");
	else Object.defineProperty(navigator, "locks", previousLocks);
});

for (const epochs of [4, 5])
	it(`both peers retire inside one room session per install and keep playing after a persisted reopen (${epochs} rollovers)`, async () => {
		const fixture = await lullFixture();
		let creator = await fixture.open("creator", fixture.creator);
		let recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
		const lulls: Awaited<ReturnType<typeof rollover>>[] = [];
		for (let epoch = 0; epoch < epochs; epoch++) lulls.push(await rollover(fixture, creator, recipient, epoch));
		expect(lulls.at(-1)?.recipientLull, JSON.stringify(lulls)).toEqual({ kind: "maintained" });
		const control = required(await fixture.retirementControl("observer"));
		expect(control.active).toBeNull();
		expect(control.completed?.throughEpoch).toBe(epochs - 1);
		// Every retirement install ran in a room session, and every session committed.
		expect(fixture.host.opened()).toContain("observer");
		expect(events.map((event) => event.outcome)).toEqual(fixture.host.opened().map(() => "committed"));
		const world = recipient.room.projection().state;
		expect(world).toEqual(creator.room.projection().state);

		await fixture.stop(recipient);
		await fixture.stop(creator);
		recipient = await fixture.open("observer", fixture.observer, { reopen: true, receiveOnly: true });
		creator = await fixture.open("creator", fixture.creator, { reopen: true });
		expect(recipient.room.authority()).toMatchObject({ epoch: epochs, objectId: fixture.objectId });
		expect(recipient.room.projection().state).toEqual(world);

		await creator.room.issue(paint("after-reopen", [9, 8, 7]));
		await deliverEpoch(fixture, recipient, epochs);
		expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
		const next = await rollover(fixture, creator, recipient, epochs);
		expect(next.recipientLull.kind).not.toBe("deferred");
		await creator.room.issue(paint("after-next-rollover", [4, 5, 6]));
		await deliverEpoch(fixture, recipient, epochs + 1);
		expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
		// Both peers' retirements ran in their own room's session, and all committed.
		expect(new Set(fixture.host.opened())).toEqual(new Set(["creator", "observer"]));
		expect(events.map((event) => event.outcome)).toEqual(fixture.host.opened().map(() => "committed"));
	}, 900_000);

it("an active intent left by a crash between the session's transactions resumes at the recipient's reopen", async () => {
	const epochs = 5;
	const fixture = await lullFixture();
	let creator = await fixture.open("creator", fixture.creator);
	let recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	for (let epoch = 0; epoch < epochs - 1; epoch++) await rollover(fixture, creator, recipient, epoch);
	// The final rollover, with the recipient's lull crashing after its first room
	// transaction and the floor effects committed, before the second one commits.
	const epoch = epochs - 1;
	await creator.room.issue(paint(`paint-${epoch}-a`, [1, 2, 3]));
	await deliverEpoch(fixture, recipient, epoch);
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epochs });
	await creator.room.adoptCreatorSuccessor();
	const transfer = await delivery(fixture, creator);
	Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	await creator.room.maintainRecoveryPool();
	fixture.host.armCrash("observer", "R3_INJECTED_CRASH_BEFORE_SECOND_COMMIT");
	await expect(recipient.room.maintainRecoveryPool()).rejects.toThrow();
	const crashed = required(await fixture.retirementControl("observer"));
	expect(crashed.active, "the crash left one durable unfinished intent").not.toBeNull();
	const world = recipient.room.projection().state;

	await fixture.stop(recipient);
	await fixture.stop(creator);
	recipient = await fixture.open("observer", fixture.observer, { reopen: true, receiveOnly: true });
	creator = await fixture.open("creator", fixture.creator, { reopen: true });
	// Startup completed that intent through the original received reconstruction.
	const resumed = required(await fixture.retirementControl("observer"));
	expect(resumed.active).toBeNull();
	expect(resumed.completed?.throughEpoch).toBe(epochs - 1);
	expect(recipient.room.authority()).toMatchObject({ epoch: epochs, objectId: fixture.objectId });
	expect(recipient.room.projection().state).toEqual(world);

	await creator.room.issue(paint("after-resume", [9, 8, 7]));
	await deliverEpoch(fixture, recipient, epochs);
	expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
	const next = await rollover(fixture, creator, recipient, epochs);
	expect(next.recipientLull.kind).not.toBe("deferred");
	await creator.room.issue(paint("after-next-rollover", [4, 5, 6]));
	await deliverEpoch(fixture, recipient, epochs + 1);
	expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
}, 900_000);

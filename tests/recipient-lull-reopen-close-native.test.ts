/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "./fixtures/phase-4c-v3/snapshot-pull-transport.js";
import {
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
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// The opt-in recovery-pool lull on genuine SQLite, Ed25519, catalog and room owners
// with scripted native-byte transport. A receive-only recipient installs each successor
// and then runs its own lull, as the integrated Grid does after every rollover. Two
// behaviours follow a maintained lull: the room must keep admitting moves after a
// persisted close and reopen, and an orderly close must not turn the lull's retained
// repair, which its peers are still serving, into a transport fault.
const directories = new Set<string>();
const rooms = new Set<V3RoomSession<CanvasProjection>>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const keychains = new Set<Keychain>();
const ports = new Set<SnapshotChunkProtocolPort>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("LULL_REOPEN_REQUIRED_FIXTURE_VALUE");
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
	const directory = mkdtempSync(join(tmpdir(), "lull-reopen-recipient-"));
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
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });
	const open = async (name: string, identity: Keychain, options: { reopen?: boolean; receiveOnly?: true } = {}) => {
		const selectedHost = options.reopen
			? createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" })
			: host;
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: options.reopen ? "reopen" : "create" },
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
					close: () => undefined,
					openEphemeral: () => {
						throw new TypeError("LULL_REOPEN_EPHEMERAL_UNUSED");
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
				timer = setTimeout(() => reject(new TypeError("LULL_REOPEN_REMOTE_ADMISSION_TIMEOUT")), 30_000);
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
		if (!object.ok) throw new TypeError("LULL_REOPEN_INVALID_OBJECT");
		const store = await host.openAhe(`${name}--ahe`);
		try {
			if (store.readRetirementControl === undefined) throw new TypeError("LULL_REOPEN_RETIREMENT_CONTROL_UNAVAILABLE");
			const result = await store.readRetirementControl(object.value);
			if (!result.ok) throw new TypeError(`LULL_REOPEN_RETIREMENT_CONTROL_${result.kind}`);
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
	if (!object.ok) throw new TypeError("LULL_REOPEN_INVALID_OBJECT");
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
							if (closed) throw new TypeError("LULL_REOPEN_STREAM_CLOSED");
							const frame = required(frames.shift());
							if (frame.byteLength > maximum) throw new TypeError("LULL_REOPEN_MATERIAL_FRAME_LIMIT");
							return frame;
						}),
					write: async (bytes, options) => {
						options.signal.throwIfAborted();
						if (closed) throw new TypeError("LULL_REOPEN_STREAM_CLOSED");
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

// Enough rollovers for the recipient lull to find turnover due and complete a retirement
// at the final epoch (it is maintained from the third rollover on). LULL_REOPEN_EPOCHS=4
// reproduces a separate reopen refusal, RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE, recorded in
// docs/realtime-latency/tracks/22-track-l-reopen-and-close/RESULT.md.
const EPOCHS = Number(process.env.LULL_REOPEN_EPOCHS ?? 5);

it("a recipient whose lull completed a retirement admits the creator's next move after a persisted reopen", async () => {
	const fixture = await lullFixture();
	let creator = await fixture.open("creator", fixture.creator);
	let recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	const lulls: Awaited<ReturnType<typeof rollover>>[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) lulls.push(await rollover(fixture, creator, recipient, epoch));
	expect(lulls.at(-1)?.recipientLull, JSON.stringify(lulls)).toEqual({ kind: "maintained" });
	// The maintained lull completed the recipient's own retirement at this epoch.
	const control = required(await fixture.retirementControl("observer"));
	expect(control.active).toBeNull();
	expect(control.completed?.throughEpoch).toBe(EPOCHS - 1);
	const world = recipient.room.projection().state;
	expect(world).toEqual(creator.room.projection().state);

	await fixture.stop(recipient);
	await fixture.stop(creator);
	recipient = await fixture.open("observer", fixture.observer, { reopen: true, receiveOnly: true });
	creator = await fixture.open("creator", fixture.creator, { reopen: true });
	expect(recipient.room.authority()).toMatchObject({ epoch: EPOCHS, objectId: fixture.objectId });
	expect(recipient.room.projection().state).toEqual(world);

	// Continued gameplay: the reopened recipient admits the creator's next move.
	await creator.room.issue(paint("after-reopen", [9, 8, 7]));
	await deliverEpoch(fixture, recipient, EPOCHS);
	expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
	// ... and keeps following the room through its next rollover and lull.
	const next = await rollover(fixture, creator, recipient, EPOCHS);
	expect(next.recipientLull.kind).not.toBe("deferred");
	await creator.room.issue(paint("after-next-rollover", [4, 5, 6]));
	await deliverEpoch(fixture, recipient, EPOCHS + 1);
	expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
}, 900_000);

it("an orderly close cancels the retained repair it is serving after a recipient lull instead of failing it", async () => {
	const fixture = await lullFixture();
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	const lulls: Awaited<ReturnType<typeof rollover>>[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) lulls.push(await rollover(fixture, creator, recipient, epoch));
	const last = required(lulls.at(-1));
	expect(last.recipientLull, JSON.stringify(lulls)).toEqual({ kind: "maintained" });
	// The maintained lull fired its unawaited retained repair at the recipient's transport.
	expect(last.repairRequested).toBe(true);
	// Current-epoch rows for the creator to republish.
	await creator.room.issue(paint("served-a", [7, 7, 7]));
	await creator.room.issue(paint("served-b", [8, 8, 8]));
	await deliverEpoch(fixture, recipient, EPOCHS);

	// The transport serves that request on the creator by calling the room's own retained
	// publisher with the requester, as the integrated transport does. A transport counts a
	// rejected publisher callback as an operation failure, which fails its close join.
	const network = creator.networkNode;
	const peers = () => ["canvas-observer"];
	Reflect.set(network, "getAllPeers", peers);
	const send = network.sendMessage.bind(network);
	// A genuine delivery failure outside any close is still a fault.
	Reflect.set(network, "sendMessage", () => Promise.reject(new TypeError("LULL_REOPEN_SEND_FAILED")));
	await expect(creator.publisher()("canvas-observer")).rejects.toThrow("publish-failed");
	// An absent requester outside any close is still reported.
	Reflect.set(network, "getAllPeers", () => []);
	await expect(creator.publisher()("canvas-observer")).rejects.toThrow("not-active");
	Reflect.set(network, "getAllPeers", peers);

	// Hold the first retained send; a second request queues behind it in the plane's FIFO.
	let entered!: () => void;
	const sending = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = false;
	Reflect.set(network, "sendMessage", async (...args: Parameters<typeof send>) => {
		if (!held) {
			held = true;
			entered();
			await released;
		}
		return send(...args);
	});
	// The orderly close retires the plane (its topic leaves the network) while both are in flight.
	let retired!: () => void;
	const retirement = new Promise<void>((resolve) => {
		retired = resolve;
	});
	const unsubscribe = network.unsubscribe.bind(network);
	Reflect.set(network, "unsubscribe", (topic: string) => {
		retired();
		return unsubscribe(topic);
	});
	const outcomes: PromiseSettledResult<void>[] = [];
	const served = [creator.publisher()("canvas-observer"), creator.publisher()("canvas-observer")].map((task) =>
		task.then(
			() => void outcomes.push({ status: "fulfilled", value: undefined }),
			(reason: unknown) => void outcomes.push({ status: "rejected", reason })
		)
	);
	await sending;
	const closing = fixture.stop(creator);
	await retirement;
	release();
	await closing;
	await Promise.all(served);
	expect(
		outcomes.filter((outcome) => outcome.status === "rejected"),
		"transport operation failures"
	).toEqual([]);
	expect(outcomes).toHaveLength(2);
}, 900_000);

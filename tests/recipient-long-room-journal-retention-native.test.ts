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

// Long-room recipient retention on genuine SQLite, Ed25519, catalog and room
// owners with scripted native-byte transport. A recipient installs every
// successor through its own bounded recovery turnover; the room must keep
// passing epochs without its retained journal scopes growing with room age.
const directories = new Set<string>();
const rooms = new Set<V3RoomSession<CanvasProjection>>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const keychains = new Set<Keychain>();
const ports = new Set<SnapshotChunkProtocolPort>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("LONG_ROOM_REQUIRED_FIXTURE_VALUE");
	return value;
}
const paint = (id: string, rgb: [number, number, number]) =>
	toCanvasWireOperation({ action: "paint", offset: [1, 1], rgb }, id);

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

async function longRoomFixture() {
	const directory = mkdtempSync(join(tmpdir(), "long-room-recipient-"));
	directories.add(directory);
	const creator = new Keychain({ private_key_seed: "long-room-creator" });
	const observer = new Keychain({ private_key_seed: "long-room-recipient" });
	keychains.add(creator);
	keychains.add(observer);
	await Promise.all([creator.start(), observer.start()]);
	const application = createV3CanvasApplication(2, 2);
	const objectId = `creator:${hex(hashDomain("long-room-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
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
	const open = async (name: string, identity: Keychain, options: { receiveOnly?: true } = {}) => {
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: "create" },
		});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const networkNode = fakeNetwork(identity === creator ? "canvas-creator" : "canvas-observer", false);
		const input: CreateV3RoomSessionInput<CanvasProjection> & { receiveOnly?: true } = {
			application,
			storageHost: host,
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
						throw new TypeError("LONG_ROOM_EPHEMERAL_UNUSED");
					},
					requestRetainedHistory: () => undefined,
					setRetainedPublisher: () => undefined,
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
				timer = setTimeout(() => reject(new TypeError("LONG_ROOM_REMOTE_ADMISSION_TIMEOUT")), 30_000);
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
		return { room, networkNode, receive };
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
	// Native census only: the journal's own retirement image, never a grant.
	const journalScopes = async (name: string) => {
		const journal = await host.openJournal(name);
		try {
			const result = await required(journal.readRetirementImage)({ objectId });
			if (!result.ok) throw new TypeError(`LONG_ROOM_JOURNAL_IMAGE_${result.kind}`);
			const epochs = new Set<number>();
			const membership = new Set<number>();
			for (const bytes of result.value.canonicalRows) {
				const frame = decodeCanonical(bytes) as unknown[];
				if (frame[0] !== "scopes" || !Array.isArray(frame[1])) continue;
				epochs.add(Number(frame[1][1]));
				const header = frame[2] as Record<string, unknown>;
				if ((header.closed_membership_bytes ?? header.closedMembershipBytes) !== undefined)
					membership.add(Number(frame[1][1]));
			}
			const completed = result.value.control?.completed ?? null;
			return {
				scopeCount: result.value.image.scopeCount,
				rowCount: result.value.image.rowCount,
				epochs: [...epochs].sort((a, b) => a - b),
				membershipEpochs: [...membership].sort((a, b) => a - b),
				throughEpoch: completed?.throughEpoch ?? null,
				protectedEpochs: completed?.protectedScopes.map((scope) => scope.epoch) ?? null,
			};
		} finally {
			await journal.close();
		}
	};
	return { creator, observer, objectId, invite, host, application, open, issued, journalScopes };
}

async function delivery(
	fixture: Awaited<ReturnType<typeof longRoomFixture>>,
	creator: Awaited<ReturnType<Awaited<ReturnType<typeof longRoomFixture>>["open"]>>
) {
	const object = parseStorageObjectId(fixture.objectId);
	if (!object.ok) throw new TypeError("LONG_ROOM_INVALID_OBJECT");
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
							if (closed) throw new TypeError("LONG_ROOM_STREAM_CLOSED");
							const frame = required(frames.shift());
							if (frame.byteLength > maximum) throw new TypeError("LONG_ROOM_MATERIAL_FRAME_LIMIT");
							return frame;
						}),
					write: async (bytes, options) => {
						options.signal.throwIfAborted();
						if (closed) throw new TypeError("LONG_ROOM_STREAM_CLOSED");
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

// Enough successive transitions to pass the original epoch-8 journal ceiling and the
// 9 -> 10 decimal boundary of the snapshot protected-hole order (first used at epoch 11).
const EPOCHS = Number(process.env.LONG_ROOM_EPOCHS ?? 16);
const STEADY_EPOCH = 8;
type JournalCensus = Awaited<ReturnType<Awaited<ReturnType<typeof longRoomFixture>>["journalScopes"]>>;
const verbose = (line: string): void => {
	if (process.env.LONG_ROOM_VERBOSE === "1") process.stdout.write(`${line}\n`);
};

/** Hot journal state is a fixed window behind the current epoch, never the room's age:
 * the native protected set holds at most the two scopes behind the current rollback
 * pair, only the pinned genesis header survives outside a recent window, and from
 * the steady epoch on, scope and row counts never grow. */
function expectBoundedJournal(label: string, rows: readonly Readonly<{ epoch: number; journal: JournalCensus }>[]): void {
	const steady = rows.filter((row) => row.epoch >= STEADY_EPOCH);
	expect(steady.length, `${label} steady census`).toBeGreaterThanOrEqual(4);
	const first = required(steady[0]);
	for (const { epoch, journal } of steady) {
		const at = `${label} journal at epoch ${epoch}`;
		expect(journal.throughEpoch, at).toBe(epoch - 2);
		expect(journal.protectedEpochs, at).not.toBeNull();
		expect(required(journal.protectedEpochs).length, at).toBeLessThanOrEqual(2);
		expect(required(journal.protectedEpochs).every((value) => value >= epoch - 3), at).toBe(true);
		expect(journal.epochs.filter((value) => value !== 0).every((value) => value > epoch - STEADY_EPOCH), at).toBe(true);
		expect(journal.scopeCount, at).toBe(first.journal.scopeCount);
		expect(journal.rowCount, at).toBe(first.journal.rowCount);
	}
}

it(`a recipient installs ${EPOCHS} successive successors with bounded retained journal scopes`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(STEADY_EPOCH + 4);
	const fixture = await longRoomFixture();
	const creator = await fixture.open("creator", fixture.creator);
	const recipient = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	const recipientCensus: { epoch: number; journal: JournalCensus }[] = [];
	const creatorCensus: { epoch: number; journal: JournalCensus }[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await creator.room.issue(paint(`paint-${epoch}-a`, [1, 2, 3]));
		await creator.room.issue(paint(`paint-${epoch}-b`, [3, 2, 1]));
		// Every authenticated row of this epoch in issue order, as the original fixture delivers them.
		const rows = (await fixture.issued()).filter(
			(row) => (decodeCanonical(row.envelope.canonicalPreimageBytes) as Record<string, unknown>).epoch === epoch
		);
		await recipient.receive(
			rows.map((row) => row.envelope),
			hex(required(rows.at(-1)).envelope.digest)
		);
		expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
		expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
		await creator.room.adoptCreatorSuccessor();
		const transfer = await delivery(fixture, creator);
		Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(recipient.room.authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
		expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
		const recipientJournal = await fixture.journalScopes("observer");
		const creatorJournal = await fixture.journalScopes("creator");
		recipientCensus.push({ epoch: epoch + 1, journal: recipientJournal });
		creatorCensus.push({ epoch: epoch + 1, journal: creatorJournal });
		// The recipient records its own exact closed-membership carrier at each install.
		expect(recipientJournal.membershipEpochs, `recipient carrier at epoch ${epoch + 1}`).toContain(epoch);
		verbose(`LONG_ROOM_JOURNAL ${JSON.stringify({ epoch: epoch + 1, recipient: recipientJournal, creator: creatorJournal })}`);
	}
	expectBoundedJournal("recipient", recipientCensus);
	expectBoundedJournal("creator", creatorCensus);
}, 900_000);

it(`a creator seals and adopts ${EPOCHS} successive epochs with bounded retained journal scopes`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(STEADY_EPOCH + 4);
	const fixture = await longRoomFixture();
	const creator = await fixture.open("creator", fixture.creator);
	const census: { epoch: number; journal: JournalCensus }[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await creator.room.issue(paint(`paint-${epoch}-a`, [1, 2, 3]));
		await creator.room.issue(paint(`paint-${epoch}-b`, [3, 2, 1]));
		expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
		await creator.room.adoptCreatorSuccessor();
		expect(creator.room.authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
		const journal = await fixture.journalScopes("creator");
		census.push({ epoch: epoch + 1, journal });
		verbose(`LONG_ROOM_CREATOR_JOURNAL ${JSON.stringify({ epoch: epoch + 1, creator: journal })}`);
	}
	expectBoundedJournal("creator", census);
}, 900_000);

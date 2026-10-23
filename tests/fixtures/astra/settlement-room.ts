// Review fixture copied from Track X 128b066e.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createV3ZoneApplication } from "../../../examples/grid/src/v3-zone.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	waitForV3RoomStartupForDiagnostics,
} from "../../../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import {
	createCreatorSuccessorMaterialServer,
	readCreatorSuccessorExport,
} from "../../../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../../../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../../../packages/storage-node/src/room-head.js";
import { fakeNetwork } from "../phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "../phase-4c-v3/snapshot-pull-transport.js";
import { directories, heads, hex, ports, required, roomHost, rooms } from "../track-m/room-retention-fixture.js";

// Track M: Track N's long-room settlement room (tests/recipient-long-room-issuance-retention-
// native.test.ts: Grid zone application, the settlement-v1 creator profile, the creator and
// one Writer recipient issuing every epoch, scripted native-byte successor transport) on the
// room-database host, with or without the slice 14b retention option. The recipient's cold
// issuance drain at activation (`cleanupCreatorSettlementSuccessor`, Track N) runs here, so
// the retention decisions' issuance and AHE labels meet it. Mechanism evidence only
// (fake-indexeddb); the object id is fixed per name so two histories share their row keys.

const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
export const vertexOf = (row: DurableIssuanceOutboxRecord) =>
	decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as Record<string, unknown>;

export async function settlementRoom(options: Readonly<{ retention: boolean; name: string }>) {
	const directory = mkdtempSync(join(tmpdir(), "track-m-settlement-"));
	directories.add(directory);
	const identities = [0x71, 0x72].map((byte) => {
		const seed = new Uint8Array(32).fill(byte);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const roster = identities.map(({ author }, order) => ({ author, order, peerId: `track-m-peer-${order}` }));
	const application = createV3ZoneApplication(roster, required(roster[0]).peerId, creator.author);
	const objectId = `creator:${hex(hashDomain("track-m-settlement-object/v1", new TextEncoder().encode(options.name))).slice(0, 32)}`;
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: identities
				.map(({ author }, index) => ({
					author,
					finalityKey: index === 0 ? author : null,
					groups: index === 0 ? ["admin", "finality", "writer"] : ["writer"],
				}))
				.sort((left, right) => left.author.localeCompare(right.author)),
			objectId,
			permissionless: false,
			version: 3,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-settlement-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
	});
	const host = roomHost(
		`tm-s-${hex(hashDomain("track-m-settlement-host/v1", new TextEncoder().encode(directory))).slice(0, 16)}`,
		options.retention ? { retention: true, creatorLull: true } : { retention: false, creatorLull: true }
	);
	const open = async (index: number, openOptions: { reopen?: boolean } = {}) => {
		const identity = required(identities[index]);
		const name = `peer-${index}`;
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: openOptions.reopen ? "reopen" : "create" },
		});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const networkNode = fakeNetwork(required(roster[index]).peerId, false);
		const input: CreateV3RoomSessionInput<ReturnType<typeof application.projectAcceptedOperations>> = {
			application,
			storageHost: host.storageHost,
			author: identity.author,
			...(index === 0
				? { creatorFinalitySigner: (await createRecoverableFinalitySigner({ seed: creator.seed })).signer }
				: {}),
			creatorInvite: invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: ed25519.getPublicKey(identity.seed),
			roomHeadAuthority: floor,
			signRegisteredVertexDigest: (digest) => Promise.resolve(ed25519.sign(digest, identity.seed)),
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
						throw new TypeError("TRACK_M_SETTLEMENT_EPHEMERAL_UNUSED");
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
		// Authenticated signed rows of another peer, in issue order; the final ordinary
		// move's application acceptance joins the delivery.
		const receive = async (rows: readonly DurableIssuanceOutboxRecord[], sender: number) => {
			const finalDigest = hex(required(rows.at(-1)).commit.envelope.digest);
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("TRACK_M_SETTLEMENT_ADMISSION_TIMEOUT")), 60_000);
			});
			try {
				for (const row of rows)
					required(ingress)(
						Message.create({
							objectId: required(topic),
							sender: required(roster[sender]).peerId,
							type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
							data: V3Envelope.encode({
								canonicalPreimage: row.commit.envelope.canonicalPreimageBytes,
								signature: row.commit.envelope.signature,
							}).finish(),
						})
					);
				await joined;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				acknowledged.delete(finalDigest);
			}
		};
		return { index, name, room, floor, networkNode, receive };
	};
	const stop = async (opened: Awaited<ReturnType<typeof open>>) => {
		await opened.room.close();
		rooms.delete(opened.room);
		await opened.floor.close();
		heads.delete(opened.floor);
	};
	// Every published row above the last delivered ordinal, in issue order.
	const publishedAfter = async (index: number, after: number | null) => {
		const store = await host.storageHost.openIssuance(`peer-${index}`);
		try {
			const author = required(identities[index]).author;
			const rows = await store.readOutboxPage({
				scope: { objectId, author },
				afterKey: after === null ? null : [objectId, author, after],
				limit: 128,
			});
			if (!rows.every((row) => row.publishState === "published"))
				throw new TypeError("TRACK_M_SETTLEMENT_UNPUBLISHED_ROW");
			return rows;
		} finally {
			await store.close();
		}
	};
	return {
		identities,
		roster,
		application,
		objectId,
		invite,
		host,
		open,
		stop,
		publishedAfter,
		database: (index: number) => host.database(`peer-${index}`),
	};
}

export type SettlementRoom = Awaited<ReturnType<typeof settlementRoom>>;

/**
 * The creator's genuine successor export over scripted native bytes (Track N's transport); no authority.
 * @param fixture - The room fixture.
 * @param receiverIndex - The installing Writer's roster index (default 1; Track X row 60 adds a second Writer).
 * @returns The offer, the receiver's port and the source peers.
 */
export async function settlementDelivery(fixture: SettlementRoom, receiverIndex = 1) {
	const object = parseStorageObjectId(fixture.objectId);
	if (!object.ok) throw new TypeError("TRACK_M_SETTLEMENT_INVALID_OBJECT");
	const store = await fixture.host.storageHost.openAhe("peer-0--ahe");
	const snapshotStore = await fixture.host.storageHost.openSnapshots("peer-0");
	const journalStore = await fixture.host.storageHost.openJournal("peer-0");
	try {
		const exported = await readCreatorSuccessorExport({
			store,
			journalStore,
			snapshotStore,
			catalog: fixture.application.catalog,
			objectId: object.value,
			pinnedGenesisAnchorDigest: fixture.invite.pinnedGenesisAnchorDigest,
			exactCanonicalGenesisAnchorPreimageBytes: fixture.invite.exactCanonicalGenesisAnchorPreimageBytes,
			detachedGenesisSignature: fixture.invite.detachedGenesisSignature,
		});
		const scope = await snapshotStore.openScope(exported.declaration);
		const read = scope.verificationQuarantine.open(new AbortController().signal);
		const chunks: Uint8Array[] = [];
		try {
			for (const descriptor of exported.declaration.chunks) chunks.push(required(await read.read(descriptor)));
		} finally {
			await read.discard();
			await scope.release();
		}
		const sender = required(fixture.roster[0]).peerId;
		const receiver = required(fixture.roster[receiverIndex]).peerId;
		const creator = required(fixture.identities[0]);
		const scripted = new ScriptedSnapshotChunkPort(
			{ declaration: exported.declaration, chunks } as ConstructorParameters<typeof ScriptedSnapshotChunkPort>[0],
			new Map([[sender, "honest"]]),
			receiver
		);
		ports.add(scripted);
		const server = createCreatorSuccessorMaterialServer({
			identity: {
				author: creator.author,
				sign: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
				isAuthorizedAuthor: (author) => fixture.identities.some((identity) => identity.author === author),
			},
			localPeerId: sender,
			manifestDigest: exported.declaration.scope.manifestDigest,
			material: exported.material,
			connectedPeers: () => [receiver],
		});
		const port: SnapshotChunkProtocolPort = {
			localPeerId: receiver,
			connectedPeers: () => [sender],
			close: () => scripted.close(),
			serve: (handler) => scripted.serve(handler),
			open: async (peer) => {
				const stream = await scripted.open(peer);
				const frames: Uint8Array[] = [];
				let materialRequest = false;
				return {
					peerId: peer,
					abort: (reason) => stream.abort(reason),
					close: () => stream.close(),
					read: async (maximum, readOptions) => {
						if (!materialRequest) return stream.read(maximum, readOptions);
						readOptions.signal.throwIfAborted();
						const frame = frames.shift();
						if (frame === undefined || frame.byteLength > maximum)
							throw new TypeError("TRACK_M_SETTLEMENT_MATERIAL_FRAME_INVALID");
						return frame;
					},
					write: async (bytes, writeOptions) => {
						const request = decodeCanonical(bytes) as Record<string, unknown>;
						if (request.kind !== "creator-successor-material-request") return stream.write(bytes, writeOptions);
						materialRequest = true;
						const inbound: SnapshotChunkProtocolStream = {
							peerId: receiver,
							abort: () => undefined,
							close: () => Promise.resolve(),
							read: () => Promise.reject(new TypeError("TRACK_M_SETTLEMENT_MATERIAL_REREAD")),
							write: (frame) => {
								frames.push(new Uint8Array(frame));
								return Promise.resolve();
							},
						};
						if (!(await server.control(inbound, bytes))) throw new TypeError("TRACK_M_SETTLEMENT_MATERIAL_REFUSED");
					},
				};
			},
		};
		ports.add(port);
		return { offer: exported.offer, port, peers: [sender] };
	} finally {
		await journalStore.close();
		await snapshotStore.close();
		await store.close();
	}
}

type Opened = Awaited<ReturnType<SettlementRoom["open"]>>;

/**
 * One Track N rollover without the lull: two ordinary moves per Writer (each delivered
 * before the next), seal, adoption and the recipient's install.
 */
export async function settlementTransition(
	fixture: SettlementRoom,
	peers: readonly [Opened, Opened],
	delivered: (number | null)[],
	epoch: number
) {
	const flush = async (from: number) => {
		const rows = await fixture.publishedAfter(from, delivered[from] ?? null);
		if (rows.length === 0) return;
		await required(peers[1 - from]).receive(rows, from);
		delivered[from] = required(rows.at(-1)).commit.authorSequence;
	};
	for (let ordinal = 0; ordinal < 4; ordinal++) {
		const index = ordinal % 2;
		await required(peers[index]).room.issue({
			action: "placeBlock",
			id: `block-${index}-${ordinal >> 1}`,
			kind: "stone",
			x: epoch,
			y: index,
		});
		await flush(index);
	}
	const [creator, recipient] = peers;
	// Harness only: let the creator's own post-admission work release the journal's native
	// read reservation before the seal. Sealing immediately after a received move can refuse
	// internal-invariant (NATIVE_READ_RESERVATION_BUSY) on base 5c6b949d too (a pre-existing
	// race on the browser journal store under fake-indexeddb, recorded in Track M's result).
	await new Promise((resolve) => setTimeout(resolve, Number(process.env.TRACK_M_SETTLE_MS ?? 300)));
	const sealed = await creator.room.sealEpoch();
	if (!(sealed as { ok?: boolean }).ok) throw new TypeError(`TRACK_M_SETTLEMENT_SEAL ${JSON.stringify(sealed)}`);
	await creator.room.adoptCreatorSuccessor();
	const transfer = await settlementDelivery(fixture);
	Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
}

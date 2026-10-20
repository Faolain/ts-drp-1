/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { ISSUANCE_RETIREMENT_LIMITS } from "@ts-drp/issuance-store/maintenance";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "./fixtures/phase-4c-v3/snapshot-pull-transport.js";
import { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";
import {
	createCreatorSuccessorMaterialServer,
	readCreatorSuccessorExport,
} from "../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { nodeIssuancePruningMaintenanceForStore } from "../packages/storage-node/src/internal/node-issuance-store.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Track N: long-room issuance retention on genuine SQLite, Ed25519, Grid application,
// settlement-v1 creator profile and room owners with scripted native-byte transport.
// The creator and one Writer recipient each issue ordinary moves every epoch (plus the
// settlement profile's author fence at every successor), exchange their signed rows,
// and the recipient installs every successor. Neither peer's local issuance store may
// grow with room age: the issued records and outbox rows it keeps are a fixed window
// behind the current epoch, exactly as the creator's already are.
const directories = new Set<string>();
const rooms = new Set<V3RoomSession>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const ports = new Set<SnapshotChunkProtocolPort>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("LONG_ROOM_ISSUANCE_REQUIRED_FIXTURE_VALUE");
	return value;
}
const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const vertexOf = (row: DurableIssuanceOutboxRecord) =>
	decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as Record<string, unknown>;
const actionOf = (row: DurableIssuanceOutboxRecord) =>
	Reflect.get(vertexOf(row).operation as object, "action") as string;

afterEach(async () => {
	const joined = await Promise.allSettled([...rooms].map((room) => room.close()));
	rooms.clear();
	const floorJoined = await Promise.allSettled([...heads].map((head) => head.close()));
	heads.clear();
	const portJoined = await Promise.allSettled([...ports].map((port) => port.close()));
	ports.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	expect(
		[...joined, ...floorJoined, ...portJoined].filter((result) => result.status === "rejected"),
		"native admitted work and owners join"
	).toEqual([]);
});

async function longRoomFixture() {
	const directory = mkdtempSync(join(tmpdir(), "long-room-issuance-"));
	directories.add(directory);
	const identities = [0x71, 0x72].map((byte) => {
		const seed = new Uint8Array(32).fill(byte);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const roster = identities.map(({ author }, order) => ({ author, order, peerId: `long-room-peer-${order}` }));
	const application = createV3ZoneApplication(roster, required(roster[0]).peerId, creator.author);
	const objectId = `creator:${hex(hashDomain("long-room-issuance-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
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
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });
	const open = async (index: number) => {
		const identity = required(identities[index]);
		const name = `peer-${index}`;
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: "create" },
		});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const networkNode = fakeNetwork(required(roster[index]).peerId, false);
		const input: CreateV3RoomSessionInput<ReturnType<typeof application.projectAcceptedOperations>> = {
			application,
			storageHost: host,
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
						throw new TypeError("LONG_ROOM_ISSUANCE_EPHEMERAL_UNUSED");
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
		// Delivers authenticated signed rows of another peer in issue order. The final
		// row is an ordinary move, whose application acceptance joins the delivery; a
		// preceding reserved author fence has no application callback of its own.
		const receive = async (rows: readonly DurableIssuanceOutboxRecord[], sender: number) => {
			const finalDigest = hex(required(rows.at(-1)).commit.envelope.digest);
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("LONG_ROOM_ISSUANCE_REMOTE_ADMISSION_TIMEOUT")), 60_000);
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
		return { index, name, room, networkNode, receive };
	};
	// Native census only: the issuance owner's own bounded recovery image and pruning
	// watermark, never a grant.
	const issuance = async (index: number) => {
		const store = await host.openIssuance(`peer-${index}`);
		try {
			const scope = { objectId, author: required(identities[index]).author };
			const maintenance = required(nodeIssuancePruningMaintenanceForStore(store));
			const census = await maintenance.readBoundedRecoveryCensus({ objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
			const state = await maintenance.inspectPruningState(scope);
			const rows = await store.readOutboxPage({ scope, limit: 128 });
			const epochs = rows.map((row) => Number(vertexOf(row).epoch));
			return {
				issuedCount: census.image.issuedCount,
				outboxCount: census.image.outboxCount,
				logicalBytes: census.image.logicalBytes,
				next: state.lineage.next,
				prunedThrough: state.prunedThroughAuthorSequence,
				pending: rows.filter((row) => row.publishState === "pending").length,
				oldestEpoch: epochs.length === 0 ? null : Math.min(...epochs),
				fences: rows.filter((row) => actionOf(row) === "$drp.author-fence.v1").length,
			};
		} finally {
			await store.close();
		}
	};
	// Every published row above the last delivered ordinal, in issue order.
	const publishedAfter = async (index: number, after: number | null) => {
		const store = await host.openIssuance(`peer-${index}`);
		try {
			const author = required(identities[index]).author;
			const rows = await store.readOutboxPage({
				scope: { objectId, author },
				afterKey: after === null ? null : [objectId, author, after],
				limit: 128,
			});
			expect(rows.every((row) => row.publishState === "published")).toBe(true);
			return rows;
		} finally {
			await store.close();
		}
	};
	return { identities, roster, application, objectId, invite, host, open, issuance, publishedAfter };
}

type Fixture = Awaited<ReturnType<typeof longRoomFixture>>;

// The creator's genuine successor export served by the original signed material server
// over scripted native bytes; it grants no authority.
async function successorDelivery(fixture: Fixture) {
	const object = parseStorageObjectId(fixture.objectId);
	if (!object.ok) throw new TypeError("LONG_ROOM_ISSUANCE_INVALID_OBJECT");
	const store = await fixture.host.openAhe("peer-0--ahe");
	const snapshotStore = await fixture.host.openSnapshots("peer-0");
	try {
		const exported = await readCreatorSuccessorExport({
			store,
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
		const receiver = required(fixture.roster[1]).peerId;
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
					read: async (maximum, options) => {
						if (!materialRequest) return stream.read(maximum, options);
						options.signal.throwIfAborted();
						const frame = frames.shift();
						if (frame === undefined || frame.byteLength > maximum)
							throw new TypeError("LONG_ROOM_ISSUANCE_MATERIAL_FRAME_INVALID");
						return frame;
					},
					write: async (bytes, options) => {
						const request = decodeCanonical(bytes) as Record<string, unknown>;
						if (request.kind !== "creator-successor-material-request") return stream.write(bytes, options);
						materialRequest = true;
						const inbound: SnapshotChunkProtocolStream = {
							peerId: receiver,
							abort: () => undefined,
							close: () => Promise.resolve(),
							read: () => Promise.reject(new TypeError("LONG_ROOM_ISSUANCE_MATERIAL_REREAD")),
							write: (frame) => {
								frames.push(new Uint8Array(frame));
								return Promise.resolve();
							},
						};
						if (!(await server.control(inbound, bytes))) throw new TypeError("LONG_ROOM_ISSUANCE_MATERIAL_REFUSED");
					},
				};
			},
		};
		ports.add(port);
		return { offer: exported.offer, port, peers: [sender] };
	} finally {
		await snapshotStore.close();
		await store.close();
	}
}

// Enough successive transitions to pass the first full recovery pool (epoch 4), Track K's
// journal ceiling (epoch 8) and the 9 -> 10 decimal boundary, with a long steady tail.
const EPOCHS = Number(process.env.LONG_ROOM_EPOCHS ?? 16);
const STEADY_EPOCH = 8;
type IssuanceCensus = Awaited<ReturnType<Fixture["issuance"]>>;
const verbose = (line: string): void => {
	if (process.env.LONG_ROOM_VERBOSE === "1") process.stdout.write(`${line}\n`);
};

/**
 * Local issuance is a fixed window behind the current epoch, never the room's age. From
 * the steady epoch on, the issued and outbox row counts never grow while the author keeps
 * issuing every epoch (so the bound is not vacuous), and no kept row is older than a
 * window that does not move with room age.
 * @param label - Peer named in assertion messages.
 * @param rows - Native issuance census after each install or adoption.
 */
function expectBoundedIssuance(label: string, rows: readonly Readonly<{ epoch: number; issuance: IssuanceCensus }>[]) {
	const steady = rows.filter((row) => row.epoch >= STEADY_EPOCH);
	expect(steady.length, `${label} steady census`).toBeGreaterThanOrEqual(4);
	const first = required(steady[0]);
	for (const { epoch, issuance } of steady) {
		const at = `${label} issuance at epoch ${epoch}`;
		expect(issuance.next, `${at}: the author keeps issuing`).toBeGreaterThan(
			first.issuance.next + (epoch - first.epoch) * 2 - 1
		);
		expect(issuance.pending, at).toBe(0);
		expect(issuance.issuedCount, at).toBe(first.issuance.issuedCount);
		expect(issuance.outboxCount, at).toBe(first.issuance.outboxCount);
		expect(issuance.outboxCount, at).toBe(issuance.issuedCount);
	}
	for (const { epoch, issuance } of steady)
		expect(required(issuance.oldestEpoch), `${label} oldest kept issuance at epoch ${epoch}`).toBeGreaterThan(
			epoch - STEADY_EPOCH
		);
}

it(`a Writer recipient and the creator keep bounded local issuance through ${EPOCHS} successive successors`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(STEADY_EPOCH + 4);
	const fixture = await longRoomFixture();
	const peers = [await fixture.open(0), await fixture.open(1)];
	const creator = required(peers[0]);
	const recipient = required(peers[1]);
	const delivered: (number | null)[] = [null, null];
	// Delivers every newly published row of one peer to the other, in issue order.
	const flush = async (from: number) => {
		const rows = await fixture.publishedAfter(from, delivered[from] ?? null);
		if (rows.length === 0) return;
		await required(peers[1 - from]).receive(rows, from);
		delivered[from] = required(rows.at(-1)).commit.authorSequence;
	};
	const recipientCensus: { epoch: number; issuance: IssuanceCensus }[] = [];
	const creatorCensus: { epoch: number; issuance: IssuanceCensus }[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		// Two ordinary moves per Writer, interleaved, each delivered before the next.
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
		expect(recipient.room.projection()).toEqual(creator.room.projection());
		expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
		await creator.room.adoptCreatorSuccessor();
		const transfer = await successorDelivery(fixture);
		Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(recipient.room.authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
		expect(recipient.room.projection()).toEqual(creator.room.projection());
		const recipientIssuance = await fixture.issuance(1);
		const creatorIssuance = await fixture.issuance(0);
		recipientCensus.push({ epoch: epoch + 1, issuance: recipientIssuance });
		creatorCensus.push({ epoch: epoch + 1, issuance: creatorIssuance });
		verbose(
			`LONG_ROOM_ISSUANCE ${JSON.stringify({ epoch: epoch + 1, recipient: recipientIssuance, creator: creatorIssuance })}`
		);
	}
	expectBoundedIssuance("creator", creatorCensus);
	expectBoundedIssuance("recipient", recipientCensus);
}, 1_800_000);

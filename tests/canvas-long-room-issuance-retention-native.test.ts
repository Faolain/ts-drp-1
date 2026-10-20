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
import { StatementSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";

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
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";
import { type CanvasProjection, createV3CanvasApplication } from "../packages/node/src/applications/canvas.js";
import {
	createCreatorSuccessorMaterialServer,
	readCreatorSuccessorExport,
} from "../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { nodeIssuancePruningMaintenanceForStore } from "../packages/storage-node/src/internal/node-issuance-store.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Track P: the shipped Canvas composition (createV3CanvasApplication, signed ACL v1, the
// creator-trusted-v1 profile, which has no settlement profile) as a long room on genuine
// SQLite, Ed25519 and room owners with scripted native-byte transport. The creator and one
// Writer recipient each issue two ordinary moves every epoch, exchange their signed rows,
// and the recipient installs every successor. Neither peer's local issuance store may grow
// with room age, and neither peer's per-move issue may do more issuance work as the room
// ages (Track M findings 12 and 13).
const directories = new Set<string>();
const rooms = new Set<V3RoomSession>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const ports = new Set<SnapshotChunkProtocolPort>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("CANVAS_LONG_ROOM_REQUIRED_FIXTURE_VALUE");
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
const CANVAS_SIDE = 10;
const vertexOf = (row: DurableIssuanceOutboxRecord) =>
	decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as Record<string, unknown>;

// Observation only: counts the issuance owner's native SQL work while one move is issued.
// Every issued-record point read is one row a caller (the filtered recovery store, the
// publisher or the census) asked the native owner to pair with an outbox row it was
// authenticating; `outboxScanRows` are the rows the native page query visited. Nothing is
// changed, granted or reordered: each patched method forwards to the original.
const ISSUED_POINT_READ =
	"SELECT object_id,author,author_sequence,canonical_preimage,digest,signature FROM issued_records WHERE object_id=? AND author=? AND author_sequence=?";
const OUTBOX_PAGE_SCAN = "SELECT i.object_id,i.author,i.author_sequence,i.canonical_preimage,i.digest,i.signature,";
const sqlWork = { issuedPointReads: 0, outboxPageScans: 0, outboxScanRows: 0 };
const originalGet = StatementSync.prototype.get;
const originalIterate = StatementSync.prototype.iterate;
beforeAll(() => {
	StatementSync.prototype.get = function (this: StatementSync, ...rest: unknown[]) {
		if (this.sourceSQL === ISSUED_POINT_READ) sqlWork.issuedPointReads += 1;
		return Reflect.apply(originalGet, this, rest) as ReturnType<StatementSync["get"]>;
	} as typeof originalGet;
	StatementSync.prototype.iterate = function (this: StatementSync, ...rest: unknown[]) {
		const rows = Reflect.apply(originalIterate, this, rest) as ReturnType<StatementSync["iterate"]>;
		if (!this.sourceSQL.startsWith(OUTBOX_PAGE_SCAN)) return rows;
		sqlWork.outboxPageScans += 1;
		const next = rows.next.bind(rows);
		return Object.assign(rows, {
			next: () => {
				const step = next();
				if (step.done !== true) sqlWork.outboxScanRows += 1;
				return step;
			},
		});
	} as typeof originalIterate;
});
afterAll(() => {
	StatementSync.prototype.get = originalGet;
	StatementSync.prototype.iterate = originalIterate;
});
const snapshotWork = () => ({ ...sqlWork });
const workSince = (before: typeof sqlWork) => ({
	issuedPointReads: sqlWork.issuedPointReads - before.issuedPointReads,
	outboxPageScans: sqlWork.outboxPageScans - before.outboxPageScans,
	outboxScanRows: sqlWork.outboxScanRows - before.outboxScanRows,
});

// One long room serves both assertions below; its owners close once, after both.
afterAll(async () => {
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

async function canvasLongRoomFixture() {
	const directory = mkdtempSync(join(tmpdir(), "canvas-long-room-issuance-"));
	directories.add(directory);
	const identities = [0x61, 0x62].map((byte) => {
		const seed = new Uint8Array(32).fill(byte);
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const peers = ["canvas-creator", "canvas-recipient"] as const;
	const application = createV3CanvasApplication(CANVAS_SIDE, CANVAS_SIDE);
	const objectId = `creator:${hex(hashDomain("canvas-long-room-issuance-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		// The shipped Canvas signs ACL version 1 with the creator and its Writers.
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
			version: 1,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
	});
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "create" });
	// A persisted reopen recreates the owner over the SAME databases and external floor.
	const open = async (index: number, options: { reopen?: boolean } = {}) => {
		const identity = required(identities[index]);
		const name = `peer-${index}`;
		const floor = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-external-floor.sqlite`),
			initialization: { kind: options.reopen ? "reopen" : "create" },
		});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		const accepted = new Set<string>();
		const acknowledged = new Map<string, () => void>();
		const networkNode = fakeNetwork(required(peers[index]), false);
		const input: CreateV3RoomSessionInput<CanvasProjection> = {
			application,
			storageHost: options.reopen ? createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" }) : host,
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
						throw new TypeError("CANVAS_LONG_ROOM_EPHEMERAL_UNUSED");
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
		// Delivers authenticated signed rows of the other peer in issue order; the final row's
		// application acceptance joins the delivery.
		const receive = async (rows: readonly DurableIssuanceOutboxRecord[], sender: number) => {
			const finalDigest = hex(required(rows.at(-1)).commit.envelope.digest);
			if (accepted.has(finalDigest)) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const joined = new Promise<void>((resolve, reject) => {
				acknowledged.set(finalDigest, resolve);
				timer = setTimeout(() => reject(new TypeError("CANVAS_LONG_ROOM_REMOTE_ADMISSION_TIMEOUT")), 60_000);
			});
			try {
				for (const row of rows)
					required(ingress)(
						Message.create({
							objectId: required(topic),
							sender: required(peers[sender]),
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
	// Native census only: the issuance owner's own bounded recovery image and pruning
	// watermark, never a grant.
	const issuance = async (index: number) => {
		const store = await host.openIssuance(`peer-${index}`);
		try {
			const scope = { objectId, author: required(identities[index]).author };
			const maintenance = required(nodeIssuancePruningMaintenanceForStore(store));
			const census = await maintenance.readBoundedRecoveryCensus({ objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
			const state = await maintenance.inspectPruningState(scope);
			const rows: DurableIssuanceOutboxRecord[] = [];
			for (;;) {
				const last = rows.at(-1)?.commit.authorSequence;
				const page = await store.readOutboxPage({
					scope,
					afterKey: last === undefined ? null : [objectId, scope.author, last],
					limit: 128,
				});
				rows.push(...page);
				if (page.length < 128) break;
			}
			const epochs = rows.map((row) => Number(vertexOf(row).epoch));
			return {
				issuedCount: census.image.issuedCount,
				outboxCount: census.image.outboxCount,
				logicalBytes: census.image.logicalBytes,
				next: state.lineage.next,
				prunedThrough: state.prunedThroughAuthorSequence,
				pending: rows.filter((row) => row.publishState === "pending").length,
				oldestEpoch: epochs.length === 0 ? null : Math.min(...epochs),
				// The retirement owner's completed classification (observation only).
				retirementThroughEpoch: census.control?.completed?.throughEpoch ?? null,
				protectedRecords:
					census.control?.completed?.protectedRecords.filter((hole) => hole.author === scope.author).length ?? null,
				holeSequences:
					census.control?.completed?.protectedRecords
						.filter((hole) => hole.author === scope.author)
						.map((hole) => hole.authorSequence) ?? null,
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
	return { identities, peers, application, objectId, invite, host, open, stop, issuance, publishedAfter };
}

type Fixture = Awaited<ReturnType<typeof canvasLongRoomFixture>>;

// The creator's genuine successor export served by the original signed material server
// over scripted native bytes; it grants no authority.
async function successorDelivery(fixture: Fixture) {
	const object = parseStorageObjectId(fixture.objectId);
	if (!object.ok) throw new TypeError("CANVAS_LONG_ROOM_INVALID_OBJECT");
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
		const [sender, receiver] = fixture.peers;
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
							throw new TypeError("CANVAS_LONG_ROOM_MATERIAL_FRAME_INVALID");
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
							read: () => Promise.reject(new TypeError("CANVAS_LONG_ROOM_MATERIAL_REREAD")),
							write: (frame) => {
								frames.push(new Uint8Array(frame));
								return Promise.resolve();
							},
						};
						if (!(await server.control(inbound, bytes))) throw new TypeError("CANVAS_LONG_ROOM_MATERIAL_REFUSED");
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
// journal ceiling (epoch 8) and the 9 -> 10 decimal boundary, with a steady tail; then a
// persisted reopen at the last epoch and one more successor.
const EPOCHS = Number(process.env.CANVAS_LONG_ROOM_EPOCHS ?? 16);
const STEADY_EPOCH = 8;
const MOVES = 2;
// Track M's finding 5: a seal right after a received move can meet the creator's native
// read reservation still held on some hosts. Its fixtures yield 300 ms before each seal.
const SETTLE_MS = Number(process.env.CANVAS_LONG_ROOM_SETTLE_MS ?? 300);
const verbose = (line: string): void => {
	if (process.env.CANVAS_LONG_ROOM_VERBOSE === "1") process.stdout.write(`${line}\n`);
};
type IssuanceCensus = Awaited<ReturnType<Fixture["issuance"]>>;
type IssueWork = ReturnType<typeof workSince>;
interface EpochRecord {
	readonly epoch: number;
	readonly creator: IssuanceCensus;
	readonly recipient: IssuanceCensus;
	readonly lulls: Readonly<{ creator: unknown; recipient: unknown }>;
}
interface LongRoomRun {
	readonly records: readonly EpochRecord[];
	/** Per-move native issuance work, by the epoch the move was issued in. */
	readonly hot: readonly Readonly<{ epoch: number; creator: IssueWork[]; recipient: IssueWork[] }>[];
	/** The same moves at the last epoch, issued by the owners a persisted reopen recreated. */
	readonly cold: Readonly<{ epoch: number; creator: IssueWork[]; recipient: IssueWork[] }>;
}

// The shipped product order: gameplay, seal, adoption, install, native census, then the
// creator's and the recipient's recovery-pool lull at the new epoch.
async function runCanvasLongRoom(): Promise<LongRoomRun> {
	const fixture = await canvasLongRoomFixture();
	const opened = [await fixture.open(0), await fixture.open(1)];
	const delivered: (number | null)[] = [null, null];
	const flush = async (from: number) => {
		const rows = await fixture.publishedAfter(from, delivered[from] ?? null);
		if (rows.length === 0) return;
		await required(opened[1 - from]).receive(rows, from);
		delivered[from] = required(rows.at(-1)).commit.authorSequence;
	};
	// Both Writers paint MOVES cells each, interleaved; each issue is measured alone.
	const play = async (epoch: number) => {
		const work = { epoch, creator: [] as IssueWork[], recipient: [] as IssueWork[] };
		for (let ordinal = 0; ordinal < MOVES * 2; ordinal++) {
			const index = ordinal % 2;
			const before = snapshotWork();
			await required(opened[index]).room.issue(
				toCanvasWireOperation(
					{ action: "paint", offset: [(epoch + ordinal) % CANVAS_SIDE, index], rgb: [1 + index, 2 + ordinal, 3] },
					`paint-${index}-${epoch}-${ordinal}`
				)
			);
			(index === 0 ? work.creator : work.recipient).push(workSince(before));
			await flush(index);
		}
		expect(required(opened[1]).room.projection().state).toEqual(required(opened[0]).room.projection().state);
		return work;
	};
	const records: EpochRecord[] = [];
	const rollover = async (epoch: number) => {
		const creator = required(opened[0]);
		const recipient = required(opened[1]);
		await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
		expect(await creator.room.sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
		await creator.room.adoptCreatorSuccessor();
		const transfer = await successorDelivery(fixture);
		Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(recipient.room.authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
		expect(recipient.room.projection().state).toEqual(creator.room.projection().state);
		const census = { creator: await fixture.issuance(0), recipient: await fixture.issuance(1) };
		const lullKind = (result: Readonly<{ kind: string; reason?: string }>) =>
			result.reason === undefined ? result.kind : `${result.kind}:${result.reason}`;
		const lulls = {
			creator: lullKind(await creator.room.maintainRecoveryPool()),
			recipient: lullKind(await recipient.room.maintainRecoveryPool()),
		};
		const record = { epoch: epoch + 1, ...census, lulls };
		records.push(record);
		return record;
	};
	const hot: LongRoomRun["hot"][number][] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		const work = await play(epoch);
		hot.push(work);
		verbose(`CANVAS_LONG_ROOM ${JSON.stringify({ ...(await rollover(epoch)), work })}`);
	}

	// A persisted reopen recreates both owners over the same databases at the last epoch.
	const kept = { creator: await fixture.issuance(0), recipient: await fixture.issuance(1) };
	const world = required(opened[0]).room.projection().state;
	await fixture.stop(required(opened[1]));
	await fixture.stop(required(opened[0]));
	opened[0] = await fixture.open(0, { reopen: true });
	opened[1] = await fixture.open(1, { reopen: true });
	expect(required(opened[1]).room.authority()).toMatchObject({ epoch: EPOCHS, objectId: fixture.objectId });
	expect(required(opened[0]).room.projection().state).toEqual(world);
	expect(required(opened[1]).room.projection().state).toEqual(world);
	// Reopen neither resurrects nor drops a kept issuance row.
	expect({ creator: await fixture.issuance(0), recipient: await fixture.issuance(1) }).toEqual(kept);
	const cold = await play(EPOCHS);
	verbose(`CANVAS_LONG_ROOM ${JSON.stringify({ ...(await rollover(EPOCHS)), work: cold, reopened: true })}`);
	return { records, hot, cold };
}

let longRoom: Promise<LongRoomRun> | undefined;
const canvasLongRoom = (): Promise<LongRoomRun> => (longRoom ??= runCanvasLongRoom());
const peak = (work: readonly IssueWork[], field: keyof IssueWork): number =>
	Math.max(...work.map((move) => move[field]));

// Track M finding 13, the compounding part. Every successor's filtered recovery store must
// read the native issuance owner itself, as the store a persisted reopen builds does, so
// the native outbox pages one issue reads do not grow with the number of successors the
// owner has lived through. (Each read here pages a whole outbox of under 64 rows, one
// native page per pass, so a growing page count is a growing number of passes.)
it(`a Canvas owner's per-move native outbox reads do not compound across ${EPOCHS} hot successors`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(STEADY_EPOCH + 4);
	const { hot } = await canvasLongRoom();
	for (const peer of ["creator", "recipient"] as const) {
		const steady = hot.filter((work) => work.epoch >= STEADY_EPOCH);
		const first = peak(required(steady[0])[peer], "outboxPageScans");
		for (const work of steady)
			expect(
				peak(work[peer], "outboxPageScans"),
				`${peer} outbox pages per move at epoch ${work.epoch}`
			).toBeLessThanOrEqual(first);
	}
}, 1_800_000);

// Track M findings 12 and 13. Canvas runs creator-trusted-v1, which has no settlement
// profile. Neither the creator's nor the Writer recipient's local issuance may grow with
// room age, and so neither may the issuance work of one move.
it(`a Canvas creator and Writer recipient keep bounded issuance and flat per-move work through ${EPOCHS} successors and a reopen`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(STEADY_EPOCH + 4);
	const { records, hot, cold } = await canvasLongRoom();
	for (const peer of ["creator", "recipient"] as const) {
		const steady = records.filter((record) => record.epoch >= STEADY_EPOCH);
		const first = required(steady[0]);
		for (const record of steady) {
			const at = `${peer} issuance at epoch ${record.epoch}`;
			const issuance = record[peer];
			// The author keeps issuing every epoch, so the bound is not vacuous.
			expect(issuance.next, `${at}: the author keeps issuing`).toBe(
				first[peer].next + (record.epoch - first.epoch) * MOVES
			);
			expect(issuance.pending, at).toBe(0);
			expect(issuance.issuedCount, at).toBe(first[peer].issuedCount);
			expect(issuance.outboxCount, at).toBe(first[peer].outboxCount);
			expect(required(issuance.oldestEpoch), `${at}: oldest kept row`).toBeGreaterThan(record.epoch - STEADY_EPOCH);
		}
		const work = [...hot.filter((moves) => moves.epoch >= STEADY_EPOCH), cold];
		const firstWork = required(work[0])[peer];
		for (const moves of work)
			for (const field of ["issuedPointReads", "outboxScanRows"] as const)
				expect(peak(moves[peer], field), `${peer} ${field} per move at epoch ${moves.epoch}`).toBeLessThanOrEqual(
					peak(firstWork, field)
				);
	}
}, 1_800_000);

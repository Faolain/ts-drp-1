/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { ISSUANCE_RETIREMENT_LIMITS } from "@ts-drp/issuance-store/maintenance";
import { Keychain } from "@ts-drp/keychain";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import type { DRPNode } from "@ts-drp/node";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "./fixtures/phase-4c-v3/snapshot-pull-transport.js";
import { GRID_GENESIS_PROFILE } from "../examples/grid/src/profile.js";
import { createV3ZoneApi, type V3ZoneApi } from "../examples/grid/src/v3-zone.js";
import {
	type createV3RoomSession,
	type V3RoomCreatorInviteMaterial,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import {
	createCreatorSuccessorMaterialServer,
	readCreatorSuccessorExport,
} from "../packages/node/src/creator-adoption.js";
import { settlementProfileFor } from "../packages/protocol-v3/src/settlement-profile.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { nodeIssuancePruningMaintenanceForStore } from "../packages/storage-node/src/internal/node-issuance-store.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Track V: the shipped Grid composition as a long room. Both peers run the real
// createV3ZoneApi (examples/grid/src/v3-zone.ts): its own genesis (the profile and ACL
// version of examples/grid/src/profile.ts, the zone parameters, the creator plus one
// enrolled Writer), its outcome-commit admission policy, its database names, its ephemeral
// plane and its seal, adoption and install calls. Only the host wiring a browser page would
// supply is replaced: each peer's room opens on genuine SQLite in its own directory (the
// zone names its databases per zone, not per peer), the external room-head floor is the
// native one, and signed rows travel over scripted native bytes. The shipped zone exposes
// no recovery-pool lull, so none runs here.
//
// GRID_LONG_ROOM_MEASUREMENT=1 records the per-epoch census, per-move native work and
// latency of whatever profile the zone signs (for base-against-head runs) and asserts no
// bound. GRID_LONG_ROOM_VERBOSE=1 prints the same lines during the bounded run.
type RoomInput = Parameters<typeof createV3RoomSession>[0];
type StorageHost = ReturnType<typeof createNodeV3RoomStorageHost>;
const wiring = vi.hoisted(() => ({
	hosts: new Map<string, unknown>(),
	accepted: new Map<string, (digest: string) => void>(),
	opened: [] as { author: string; input: unknown; session: Promise<unknown> }[],
}));
// Host wiring only: the zone's own input reaches the original room owner unchanged, plus
// the peer's native storage host and an observer of accepted vertices.
vi.mock("@ts-drp/example-v3-room", async (original) => {
	const actual = await original<{ readonly createV3RoomSession: typeof createV3RoomSession }>();
	return {
		...actual,
		createV3RoomSession: (input: RoomInput): Promise<unknown> => {
			const storageHost = wiring.hosts.get(input.author);
			if (storageHost === undefined) throw new TypeError("GRID_LONG_ROOM_HOST_UNWIRED");
			const session = actual.createV3RoomSession({
				...input,
				storageHost,
				onAcceptedVertex: (vertex) => {
					void input.onAcceptedVertex?.(vertex);
					wiring.accepted.get(input.author)?.(Buffer.from(vertex.digest).toString("hex"));
				},
			} as RoomInput);
			wiring.opened.push({ author: input.author, input, session });
			return session;
		},
	};
});

const MEASUREMENT = process.env.GRID_LONG_ROOM_MEASUREMENT === "1";
beforeEach((context) => {
	if (MEASUREMENT && !context.task.name.startsWith("measurement")) context.skip();
});
const directories = new Set<string>();
const zones = new Set<V3ZoneApi>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const ports = new Set<SnapshotChunkProtocolPort>();
const keychains = new Set<Keychain>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("GRID_LONG_ROOM_REQUIRED_FIXTURE_VALUE");
	return value;
}
const vertexOf = (row: DurableIssuanceOutboxRecord) =>
	decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as Record<string, unknown>;

// Observation only, as Track P's Canvas long room: counts the issuance owner's native SQL
// work while one move is issued. Each patched method forwards to the original.
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

// One long room serves every assertion below; its owners close once, after all of them.
afterAll(async () => {
	const joined = await Promise.allSettled([...zones].map((zone) => zone.close()));
	zones.clear();
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

// The idle ephemeral plane a page without peers has: the shipped zone opens it on every
// room open and projection; nothing is published or received.
const idleEphemeralChannel = () => ({
	close: () => undefined,
	publish: () => Promise.resolve(false),
	publishTo: () => Promise.resolve(false),
	resetReliable: () => Promise.resolve(),
	restartUnreliable: () => Promise.resolve(),
	stats: () => ({ overLimit: 0 }),
	subscribe: () => () => undefined,
});

interface Peer {
	readonly index: number;
	readonly peerId: string;
	readonly keychain: Keychain;
	readonly author: string;
	readonly directory: string;
	readonly host: StorageHost;
	readonly accepted: Set<string>;
	readonly acknowledged: Map<string, () => void>;
	zone?: V3ZoneApi;
	room?: V3RoomSession<never>;
	/** The issuance database the zone opened for this peer (its own: one room database per player). */
	issuanceDatabaseName?: string;
	floor?: ReturnType<typeof createNodeRoomHeadAuthority>;
	networkNode?: DRPNetworkNode;
	ingress?(message: Message): void;
	topic?: string;
}

async function gridLongRoomFixture() {
	const root = mkdtempSync(join(tmpdir(), "grid-long-room-issuance-"));
	directories.add(root);
	const peers: Peer[] = [];
	for (const [index, peerId] of ["grid-creator", "grid-recipient"].entries()) {
		const keychain = new Keychain({ private_key_seed: `track-v-${peerId}` });
		await keychain.start();
		keychains.add(keychain);
		const directory = join(root, peerId);
		mkdirSync(directory);
		peers.push({
			index,
			peerId,
			keychain,
			author: keychain.localAuthorId,
			directory,
			host: createNodeV3RoomStorageHost({ directory, initialization: () => "create" }),
			accepted: new Set(),
			acknowledged: new Map(),
		});
	}
	const creator = required(peers[0]);
	// The shipped zone API over one peer's host wiring. A persisted reopen recreates the API
	// over the SAME databases and external floor, as a page reload does.
	const zoneFor = (peer: Peer, options: { reopen?: boolean } = {}) => {
		wiring.hosts.set(
			peer.author,
			options.reopen
				? createNodeV3RoomStorageHost({ directory: peer.directory, initialization: () => "reopen" })
				: peer.host
		);
		wiring.accepted.set(peer.author, (digest) => {
			peer.accepted.add(digest);
			peer.acknowledged.get(digest)?.();
		});
		const node = {
			keychain: peer.keychain,
			networkNode: { peerId: peer.peerId },
			ephemeralUnreliableWebRtcSnapshot: () => undefined,
			openRoomNetwork: () => {
				const networkNode = fakeNetwork(peer.peerId, false);
				Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
				peer.networkNode = networkNode;
				return {
					networkNode,
					close: () => undefined,
					openEphemeral: idleEphemeralChannel,
					requestRetainedHistory: () => undefined,
					setRetainedPublisher: () => undefined,
					setIngressHandler: (topic: string, handler: (message: Message) => void) => {
						peer.topic = topic;
						peer.ingress = handler;
					},
				};
			},
		} as unknown as DRPNode;
		const zone = createV3ZoneApi(
			node,
			() => undefined,
			() => {
				const floor = createNodeRoomHeadAuthority({
					filename: join(peer.directory, "external-floor.sqlite"),
					initialization: { kind: options.reopen ? "reopen" : "create" },
				});
				heads.add(floor);
				peer.floor = floor;
				return floor;
			}
		);
		zones.add(zone);
		peer.zone = zone;
		return zone;
	};
	// The room the zone just opened, once its live plane is up.
	const settleOpen = async (peer: Peer) => {
		const opened = required(wiring.opened.findLast((entry) => entry.author === peer.author));
		peer.room = (await opened.session) as V3RoomSession<never>;
		await waitForV3RoomStartupForDiagnostics(peer.room);
		peer.issuanceDatabaseName = (opened.input as RoomInput).issuanceDatabaseName;
		return opened.input as RoomInput;
	};
	// The shipped page order: the member's page enrolls, the creator creates the zone with
	// that enrollment, and the member joins with the creator's invite.
	const recipient = required(peers[1]);
	const recipientZone = zoneFor(recipient);
	const creatorZone = zoneFor(creator);
	await creatorZone.create(recipientZone.snapshot().enrollment);
	const creatorInput = await settleOpen(creator);
	const invite = creatorZone.snapshot().invite;
	await recipientZone.join(invite);
	await settleOpen(recipient);
	const material = creatorInput.creatorInvite as V3RoomCreatorInviteMaterial;
	const objectId = creatorInput.objectId;
	const application = creatorInput.application as {
		readonly catalog: Parameters<typeof readCreatorSuccessorExport>[0]["catalog"];
	};
	const signedProfile = decodeCanonical(material.exactCanonicalProfileBytes) as Record<string, unknown>;
	const signedAcl = decodeCanonical(material.exactCanonicalLatchedAclBytes) as Record<string, unknown>;
	const signed = Object.freeze({ profileId: String(signedProfile.profileId), aclVersion: Number(signedAcl.version) });

	const stop = async (peer: Peer) => {
		const zone = required(peer.zone);
		await zone.close();
		zones.delete(zone);
		const floor = required(peer.floor);
		await floor.close();
		heads.delete(floor);
	};
	const reopen = async (peer: Peer) => {
		await zoneFor(peer, { reopen: true }).join(invite);
		await settleOpen(peer);
		// Decision B (sync before sending): a reopened Writer signs nothing until it is current. This
		// harness passes successor offers by hand, so it also hands over the creator's statement, as
		// the pages' successor delivery does on bind.
		if (peer !== creator && creator.room !== undefined) {
			const statement = creator.room.currencyStatement?.();
			if (statement !== undefined) await required(peer.room).confirmCurrent?.(statement);
		}
	};
	// Delivers authenticated signed rows of the other peer in issue order; the final row's
	// application acceptance joins the delivery.
	const receive = async (peer: Peer, rows: readonly DurableIssuanceOutboxRecord[], sender: Peer) => {
		const finalDigest = hex(required(rows.at(-1)).commit.envelope.digest);
		if (peer.accepted.has(finalDigest)) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const joined = new Promise<void>((resolve, reject) => {
			peer.acknowledged.set(finalDigest, resolve);
			timer = setTimeout(() => reject(new TypeError("GRID_LONG_ROOM_REMOTE_ADMISSION_TIMEOUT")), 60_000);
		});
		try {
			for (const row of rows)
				required(peer.ingress)(
					Message.create({
						objectId: required(peer.topic),
						sender: sender.peerId,
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
			peer.acknowledged.delete(finalDigest);
		}
	};
	// Native census only: the issuance owner's own bounded recovery image and pruning
	// watermark, never a grant; plus the bytes the peer's directory holds on disk.
	const issuance = async (peer: Peer) => {
		const store = await peer.host.openIssuance(required(peer.issuanceDatabaseName));
		try {
			const scope = { objectId, author: peer.author };
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
				retirementThroughEpoch: census.control?.completed?.throughEpoch ?? null,
			};
		} finally {
			await store.close();
		}
	};
	// Database files and write-ahead logs apart: SQLite truncates a log only at a checkpoint.
	const diskBytes = (peer: Peer) =>
		readdirSync(peer.directory).reduce(
			(total, name) => {
				const size = statSync(join(peer.directory, name)).size;
				if (name.endsWith("-wal")) total.wal += size;
				else if (!name.endsWith("-shm")) total.files += size;
				return total;
			},
			{ files: 0, wal: 0 }
		);
	// Every published row above the last delivered ordinal, in issue order.
	const publishedAfter = async (peer: Peer, after: number | null) => {
		const store = await peer.host.openIssuance(required(peer.issuanceDatabaseName));
		try {
			const rows = await store.readOutboxPage({
				scope: { objectId, author: peer.author },
				afterKey: after === null ? null : [objectId, peer.author, after],
				limit: 128,
			});
			expect(rows.every((row) => row.publishState === "published")).toBe(true);
			return rows;
		} finally {
			await store.close();
		}
	};
	// The creator's genuine successor export served by the original signed material server
	// over scripted native bytes; it grants no authority.
	const successorDelivery = async () => {
		const object = parseStorageObjectId(objectId);
		if (!object.ok) throw new TypeError("GRID_LONG_ROOM_INVALID_OBJECT");
		const store = await creator.host.openAhe(`${creatorInput.databaseName}--ahe`);
		const snapshotStore = await creator.host.openSnapshots(creatorInput.databaseName);
		try {
			const exported = await readCreatorSuccessorExport({
				store,
				snapshotStore,
				catalog: application.catalog,
				objectId: object.value,
				pinnedGenesisAnchorDigest: material.pinnedGenesisAnchorDigest,
				exactCanonicalGenesisAnchorPreimageBytes: material.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: material.detachedGenesisSignature,
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
			const sender = creator.peerId;
			const receiver = recipient.peerId;
			const scripted = new ScriptedSnapshotChunkPort(
				{ declaration: exported.declaration, chunks } as ConstructorParameters<typeof ScriptedSnapshotChunkPort>[0],
				new Map([[sender, "honest"]]),
				receiver
			);
			ports.add(scripted);
			const server = createCreatorSuccessorMaterialServer({
				identity: {
					author: creator.author,
					sign: (digest) => creator.keychain.signWithLocalAuthor(digest),
					isAuthorizedAuthor: (author) => peers.some((peer) => peer.author === author),
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
								throw new TypeError("GRID_LONG_ROOM_MATERIAL_FRAME_INVALID");
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
								read: () => Promise.reject(new TypeError("GRID_LONG_ROOM_MATERIAL_REREAD")),
								write: (frame) => {
									frames.push(new Uint8Array(frame));
									return Promise.resolve();
								},
							};
							if (!(await server.control(inbound, bytes))) throw new TypeError("GRID_LONG_ROOM_MATERIAL_REFUSED");
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
	};
	return { peers, objectId, signed, stop, reopen, receive, issuance, diskBytes, publishedAfter, successorDelivery };
}

// Enough successive transitions to pass the first full recovery pool (epoch 4), Track K's
// journal ceiling (epoch 8) and the 9 -> 10 decimal boundary, with a steady tail; then a
// persisted reopen at the last epoch and one more successor.
const EPOCHS = Number(process.env.GRID_LONG_ROOM_EPOCHS ?? 16);
const STEADY_EPOCH = 8;
const MOVES = 2;
// Track M's finding 5: a seal right after a received move can meet the creator's native
// read reservation still held on some hosts. Its fixtures yield 300 ms before each seal.
const SETTLE_MS = Number(process.env.GRID_LONG_ROOM_SETTLE_MS ?? 300);
const verbose = (line: string): void => {
	if (MEASUREMENT || process.env.GRID_LONG_ROOM_VERBOSE === "1") process.stdout.write(`${line}\n`);
};
type Fixture = Awaited<ReturnType<typeof gridLongRoomFixture>>;
type IssuanceCensus = Awaited<ReturnType<Fixture["issuance"]>>;
type IssueWork = ReturnType<typeof workSince>;
interface MoveSample {
	readonly epoch: number;
	readonly creator: IssueWork[];
	readonly recipient: IssueWork[];
	readonly issueMs: { creator: number[]; recipient: number[] };
}
interface EpochRecord {
	readonly epoch: number;
	readonly creator: IssuanceCensus;
	readonly recipient: IssuanceCensus;
	readonly disk: Readonly<{ creator: ReturnType<Fixture["diskBytes"]>; recipient: ReturnType<Fixture["diskBytes"]> }>;
	readonly ms: Readonly<{ seal: number; adoption: number; delivery: number; install: number }>;
}
interface LongRoomRun {
	readonly signed: Fixture["signed"];
	readonly records: readonly EpochRecord[];
	/** Per-move native issuance work and latency, by the epoch the move was issued in. */
	readonly hot: readonly MoveSample[];
	/** The same moves at the last epoch, issued by the owners a persisted reopen recreated. */
	readonly cold: MoveSample;
	readonly reopen: Readonly<{ kept: unknown; reopened: unknown; ms: number }>;
}

// The shipped order: gameplay, seal, adoption, install, native census. No lull: the shipped
// zone API exposes none.
async function runGridLongRoom(): Promise<LongRoomRun> {
	const fixture = await gridLongRoomFixture();
	const [creator, recipient] = [required(fixture.peers[0]), required(fixture.peers[1])];
	const delivered: (number | null)[] = [null, null];
	const flush = async (from: Peer) => {
		const rows = await fixture.publishedAfter(from, delivered[from.index] ?? null);
		if (rows.length === 0) return;
		await fixture.receive(from === creator ? recipient : creator, rows, from);
		delivered[from.index] = required(rows.at(-1)).commit.authorSequence;
	};
	// Both Writers place MOVES blocks each, interleaved; each issue is measured alone. The
	// same block ids move every epoch, so the zone state stays the same size.
	const play = async (epoch: number): Promise<MoveSample> => {
		const sample: MoveSample = { epoch, creator: [], recipient: [], issueMs: { creator: [], recipient: [] } };
		for (let ordinal = 0; ordinal < MOVES * 2; ordinal++) {
			const peer = ordinal % 2 === 0 ? creator : recipient;
			const label = peer === creator ? "creator" : "recipient";
			const before = snapshotWork();
			const started = performance.now();
			await required(peer.zone).placeBlock({
				id: `block-${peer.index}-${ordinal >> 1}`,
				kind: "stone",
				x: epoch,
				y: peer.index,
			});
			sample.issueMs[label].push(performance.now() - started);
			sample[label].push(workSince(before));
			await flush(peer);
		}
		expect(required(recipient.zone).snapshot().blocks).toEqual(required(creator.zone).snapshot().blocks);
		return sample;
	};
	const records: EpochRecord[] = [];
	const rollover = async (epoch: number) => {
		await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
		let started = performance.now();
		expect(await required(creator.zone).sealEpoch()).toMatchObject({ ok: true, epoch, successorEpoch: epoch + 1 });
		const seal = performance.now() - started;
		started = performance.now();
		await required(creator.zone).adoptCreatorSuccessor();
		const adoption = performance.now() - started;
		started = performance.now();
		const transfer = await fixture.successorDelivery();
		const delivery = performance.now() - started;
		Reflect.set(required(recipient.networkNode), "createSnapshotChunkProtocolHost", () => transfer.port);
		started = performance.now();
		await required(recipient.zone).installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		const install = performance.now() - started;
		expect(required(recipient.room).authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
		expect(required(recipient.zone).snapshot().blocks).toEqual(required(creator.zone).snapshot().blocks);
		const record: EpochRecord = {
			epoch: epoch + 1,
			creator: await fixture.issuance(creator),
			recipient: await fixture.issuance(recipient),
			disk: { creator: fixture.diskBytes(creator), recipient: fixture.diskBytes(recipient) },
			ms: { seal, adoption, delivery, install },
		};
		records.push(record);
		return record;
	};
	const hot: MoveSample[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		const sample = await play(epoch);
		hot.push(sample);
		verbose(`GRID_LONG_ROOM ${JSON.stringify({ signed: fixture.signed, ...(await rollover(epoch)), sample })}`);
	}

	// A persisted reopen recreates both zone APIs over the same databases at the last epoch.
	const kept = { creator: await fixture.issuance(creator), recipient: await fixture.issuance(recipient) };
	const world = required(creator.zone).snapshot().blocks;
	await fixture.stop(recipient);
	await fixture.stop(creator);
	const reopenStarted = performance.now();
	await fixture.reopen(creator);
	await fixture.reopen(recipient);
	const reopenMs = performance.now() - reopenStarted;
	expect(required(recipient.room).authority()).toMatchObject({ epoch: EPOCHS, objectId: fixture.objectId });
	expect(required(creator.zone).snapshot().blocks).toEqual(world);
	expect(required(recipient.zone).snapshot().blocks).toEqual(world);
	const reopened = { creator: await fixture.issuance(creator), recipient: await fixture.issuance(recipient) };
	const cold = await play(EPOCHS);
	verbose(
		`GRID_LONG_ROOM ${JSON.stringify({ signed: fixture.signed, ...(await rollover(EPOCHS)), sample: cold, reopened: true, reopenMs })}`
	);
	return { signed: fixture.signed, records, hot, cold, reopen: { kept, reopened, ms: reopenMs } };
}

let longRoom: Promise<LongRoomRun> | undefined;
const gridLongRoom = (): Promise<LongRoomRun> => (longRoom ??= runGridLongRoom());
const peak = (work: readonly IssueWork[], field: keyof IssueWork): number =>
	Math.max(...work.map((move) => move[field]));

it("the shipped Grid zone signs the settlement profile and the ACL version it requires", async () => {
	const { signed } = await gridLongRoom();
	expect(signed).toEqual({
		profileId: GRID_GENESIS_PROFILE.profileId,
		aclVersion: GRID_GENESIS_PROFILE.latchedAclVersion,
	});
	expect(settlementProfileFor(signed.profileId)).toBe("v1");
}, 1_800_000);

// Track M finding 13, the compounding part, for the shipped Grid: the native outbox pages
// one issue reads do not grow with the number of successors the owner has lived through.
it(`a shipped Grid owner's per-move native outbox reads do not compound across ${EPOCHS} hot successors`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(STEADY_EPOCH + 4);
	const { hot } = await gridLongRoom();
	for (const peer of ["creator", "recipient"] as const) {
		const steady = hot.filter((sample) => sample.epoch >= STEADY_EPOCH);
		const first = peak(required(steady[0])[peer], "outboxPageScans");
		for (const sample of steady)
			expect(
				peak(sample[peer], "outboxPageScans"),
				`${peer} outbox pages per move at epoch ${sample.epoch}`
			).toBeLessThanOrEqual(first);
	}
}, 1_800_000);

// Track M findings 12 and 13 for the shipped Grid. Its settlement lets the existing
// retirement drain issued rows (Track V; before it, Grid signed creator-trusted-v1 and kept
// every row). Neither the creator's nor the Writer recipient's local issuance may grow with
// zone age, and so neither may the issuance work of one move.
it(`a shipped Grid creator and Writer recipient keep bounded issuance and flat per-move work through ${EPOCHS} successors and a reopen`, async () => {
	expect(EPOCHS).toBeGreaterThanOrEqual(STEADY_EPOCH + 4);
	const { signed, records, hot, cold, reopen } = await gridLongRoom();
	// Under the settlement profile each Writer also issues one author fence per successor.
	const fencesPerSuccessor = settlementProfileFor(signed.profileId) === "v1" ? 1 : 0;
	// Reopen neither resurrects nor drops a kept issuance row.
	expect(reopen.reopened).toEqual(reopen.kept);
	for (const peer of ["creator", "recipient"] as const) {
		const steady = records.filter((record) => record.epoch >= STEADY_EPOCH);
		const first = required(steady[0]);
		for (const record of steady) {
			const at = `${peer} issuance at epoch ${record.epoch}`;
			const issuance = record[peer];
			// The author keeps issuing every epoch, so the bound is not vacuous.
			expect(issuance.next, `${at}: the author keeps issuing`).toBe(
				first[peer].next + (record.epoch - first.epoch) * (MOVES + fencesPerSuccessor)
			);
			expect(issuance.pending, at).toBe(0);
			expect(issuance.issuedCount, at).toBe(first[peer].issuedCount);
			expect(issuance.outboxCount, at).toBe(first[peer].outboxCount);
			expect(required(issuance.oldestEpoch), `${at}: oldest kept row`).toBeGreaterThan(record.epoch - STEADY_EPOCH);
		}
		const work = [...hot.filter((sample) => sample.epoch >= STEADY_EPOCH), cold];
		const firstWork = required(work[0])[peer];
		for (const sample of work)
			for (const field of ["issuedPointReads", "outboxScanRows"] as const)
				expect(peak(sample[peer], field), `${peer} ${field} per move at epoch ${sample.epoch}`).toBeLessThanOrEqual(
					peak(firstWork, field)
				);
	}
}, 1_800_000);

// Measurement only (GRID_LONG_ROOM_MEASUREMENT=1): the per-epoch census, per-move work and
// latency of whatever profile the zone signs, printed as GRID_LONG_ROOM lines while the
// room runs. Nothing here asserts a bound.
it.runIf(MEASUREMENT)(
	`measurement: shipped Grid census, work and latency through ${EPOCHS} successors and a reopen`,
	async () => {
		const { signed, records, reopen } = await gridLongRoom();
		process.stdout.write(`GRID_LONG_ROOM_SUMMARY ${JSON.stringify({ signed, epochs: records.length, reopen })}\n`);
	},
	1_800_000
);

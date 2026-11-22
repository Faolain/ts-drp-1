/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { DRPNode } from "../packages/node/src/index.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Genuine SQLite, Ed25519, catalog and room owners. Most controls use scripted
// native-byte transport; the explicit two-node case uses real local libp2p.
// Neither transport scope establishes device or distributed performance acceptance.
const directories = new Set<string>();
const rooms = new Set<V3RoomSession<CanvasProjection>>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const keychains = new Set<Keychain>();
const ports = new Set<SnapshotChunkProtocolPort>();
const nativeNodes = new Set<DRPNode>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("R9_CANVAS_REQUIRED_FIXTURE_VALUE");
	return value;
}
const paint = (id: string, rgb: [number, number, number] = [200, 101, 7]) =>
	toCanvasWireOperation({ action: "paint", offset: [1, 1], rgb }, id);

async function canvasFixture(realNetwork = false) {
	const directory = mkdtempSync(join(tmpdir(), "r9-canvas-observer-"));
	directories.add(directory);
	const startNode = async (seed: string) => {
		const node = new DRPNode({
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
		});
		nativeNodes.add(node);
		await node.start();
		return node;
	};
	const creatorNode = realNetwork ? await startNode("r9-canvas-creator") : undefined;
	const observerNode = realNetwork ? await startNode("r9-canvas-independent-observer") : undefined;
	const creator = creatorNode?.keychain ?? new Keychain({ private_key_seed: "r9-canvas-creator" });
	const observer = observerNode?.keychain ?? new Keychain({ private_key_seed: "r9-canvas-independent-observer" });
	if (!realNetwork) {
		keychains.add(creator);
		keychains.add(observer);
		await Promise.all([creator.start(), observer.start()]);
	} else {
		await required(observerNode).networkNode.connect(required(creatorNode).networkNode.getMultiaddrs());
		await expect
			.poll(() => required(creatorNode).networkNode.getAllPeers())
			.toContain(required(observerNode).networkNode.peerId);
	}
	const application = createV3CanvasApplication(2, 2);
	const objectId = `${creatorNode?.networkNode.peerId ?? "creator"}:${hex(hashDomain("r9-canvas-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
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
	const open = async (
		name: string,
		identity = creator,
		options: {
			reopen?: boolean;
			receiveOnly?: true;
			protocol?: SnapshotChunkProtocolPort;
			creatorInvite?: typeof invite;
			objectId?: string;
			onAccepted?(): Promise<void>;
			onJournalPage?(): Promise<void>;
			onJournalRelease?(): Promise<void>;
		} = {}
	) => {
		const selectedHost = options.reopen
			? createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" })
			: host;
		const floor = realNetwork
			? await selectedHost.openRoomHead(name, { kind: options.reopen ? "reopen" : "create" })
			: createNodeRoomHeadAuthority({
					filename: join(directory, `${name}-external-floor.sqlite`),
					initialization: { kind: options.reopen ? "reopen" : "create" },
				});
		heads.add(floor);
		let ingress: ((message: Message) => void) | undefined;
		let topic: string | undefined;
		const accepted = new Set<string>();
		let retainedRequests = 0;
		const acknowledged = new Map<string, () => void>();
		const peer = identity === creator ? "canvas-creator" : "canvas-observer";
		const networkNode = fakeNetwork(peer, false);
		const actualNode = identity === creator ? creatorNode : observerNode;
		const input: CreateV3RoomSessionInput<CanvasProjection> & { receiveOnly?: true } = {
			application,
			storageHost: {
				...(options.reopen ? createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" }) : host),
				openJournal: async (selectedName) => {
					const native = await (
						options.reopen ? createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" }) : host
					).openJournal(selectedName);
					return options.onJournalPage === undefined && options.onJournalRelease === undefined
						? native
						: Object.freeze({
								...native,
								acquireNativeReadReservation: async (selector) => {
									const reservation = await native.acquireNativeReadReservation(selector);
									return Object.freeze({
										check: reservation.check,
										release: async () => {
											await options.onJournalRelease?.();
											await reservation.release();
										},
									});
								},
								readPage: async (page) => {
									const result = await native.readPage(page);
									await options.onJournalPage?.();
									return result;
								},
							});
				},
			},
			author: identity.localAuthorId,
			...(options.receiveOnly ? { receiveOnly: true as const } : {}),
			...(identity === creator ? { creatorFinalitySigner: await creator.acquireLocalAuthorFinalitySigner() } : {}),
			creatorInvite: options.creatorInvite ?? invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId: options.objectId ?? objectId,
			publicKeyBytes: Uint8Array.from(Buffer.from(identity.localAuthorId, "hex")),
			roomHeadAuthority: floor,
			signRegisteredVertexDigest: (digest) => identity.signWithLocalAuthor(digest),
			onProjection: () => undefined,
			onAcceptedVertex: (vertex) => {
				const digest = hex(vertex.digest);
				accepted.add(digest);
				acknowledged.get(digest)?.();
				return options.onAccepted?.();
			},
			openTransport: () => {
				if (actualNode !== undefined) return actualNode.openRoomNetwork(options.objectId ?? objectId);
				Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
				if (options.protocol) Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => options.protocol);
				return {
					networkNode,
					close: () => undefined,
					openEphemeral: () => {
						throw new TypeError("R9_CANVAS_EPHEMERAL_UNUSED");
					},
					requestRetainedHistory: () => {
						retainedRequests++;
					},
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
				timer = setTimeout(() => reject(new TypeError("R9_CANVAS_REMOTE_ADMISSION_TIMEOUT")), 10_000);
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
			input,
			floor,
			receive,
			networkNode: actualNode?.networkNode ?? networkNode,
			accepted,
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
	// A second native issuance owner beside a LIVE room: the room's retained replay may
	// hold the native writer reservation across a network send (in production its own
	// writers queue behind it in the plane FIFO). This harness connection's synchronous
	// SQLite busy wait blocks the event loop, so the in-process holder cannot release
	// during it; yield and retry only that transient admission refusal.
	const openObserverIssuance = async (name: string) => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await host.openIssuance(name);
			} catch (error) {
				if (attempt >= 20 || (error as { retryClass?: unknown }).retryClass !== "transient") throw error;
				await new Promise<void>((resolve) => setTimeout(resolve, 25));
			}
		}
	};
	const observerEffects = async (name: string) => {
		const store = await openObserverIssuance(name);
		try {
			const scope = { author: observer.localAuthorId, objectId };
			return {
				lineage: await store.readLineage(scope),
				issued: await store.readIssued(scope, 0),
				outbox: await store.readOutboxPage({ scope, limit: 32 }),
				settlement: await store.readSettlementPlan(scope),
			};
		} finally {
			await store.close();
		}
	};
	return {
		directory,
		creator,
		observer,
		creatorNode,
		observerNode,
		application,
		objectId,
		invite,
		host,
		open,
		issued,
		stop,
		observerEffects,
	};
}

async function delivery(
	fixture: Awaited<ReturnType<typeof canvasFixture>>,
	creator: Awaited<ReturnType<Awaited<ReturnType<typeof canvasFixture>>["open"]>>
) {
	const object = parseStorageObjectId(fixture.objectId);
	if (!object.ok) throw new TypeError("R9_CANVAS_INVALID_OBJECT");
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
		// Install the real room's server, not a fixture that grants public reading.
		// Its authenticated request/reader policy and source signatures are reached.
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
							if (closed) throw new TypeError("R9_CANVAS_STREAM_CLOSED");
							const frame = required(frames.shift());
							if (frame.byteLength > maximum) throw new TypeError("R9_CANVAS_MATERIAL_FRAME_LIMIT");
							return frame;
						}),
					write: async (bytes, options) => {
						options.signal.throwIfAborted();
						if (closed) throw new TypeError("R9_CANVAS_STREAM_CLOSED");
						frames.push(...(await scripted.dispatch("canvas-observer", [bytes])));
					},
				});
			},
		};
		ports.add(port);
		return { offer, port, peers: ["canvas-creator"], chunks };
	} finally {
		await snapshots.close();
		await store.close();
	}
}

afterEach(async () => {
	const joined = await Promise.allSettled([...rooms].map((room) => room.close()));
	rooms.clear();
	const floorJoined = await Promise.allSettled([...heads].map((head) => head.close()));
	heads.clear();
	const portJoined = await Promise.allSettled([...ports].map((port) => port.close()));
	ports.clear();
	const nodeJoined = await Promise.allSettled([...nativeNodes].map((node) => node.stop()));
	nativeNodes.clear();
	const keyJoined = await Promise.allSettled([...keychains].map((keychain) => keychain.stop()));
	keychains.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	expect(
		[...joined, ...floorJoined, ...portJoined, ...nodeJoined, ...keyJoined].filter(
			(result) => result.status === "rejected"
		),
		"native admitted work and owners join"
	).toEqual([]);
});

it("native retained query pages exact authenticated local and received hashes with honest scope and stale-cursor refusal", async () => {
	const f = await canvasFixture();
	const creator = await f.open("creator");
	const observer = await f.open("observer", f.observer, { receiveOnly: true });
	for (let i = 0; i < 3; i++) await creator.room.issue(paint(`query-${i}`));
	const issued = await f.issued();
	await observer.receive(
		issued.map((row) => row.envelope),
		hex(required(issued.at(-1)).envelope.digest)
	);
	const expected = issued.map((row) => hex(row.envelope.digest));
	for (const opened of [creator, observer]) {
		let page = await opened.room.queryRetainedHashes({ limit: 1 });
		const entries = [...page.entries];
		expect(page.coverage).toBe("current-epoch-retained-accepted-window");
		expect(page.scope).toEqual({ objectId: f.objectId, epoch: 0, anchorDigest: f.invite.pinnedGenesisAnchorDigest });
		expect(page.retainedRowCount).toBe(expected.length);
		const cursor = required(page.continuation);
		await expect(
			opened.room.queryRetainedHashes({
				limit: 1,
				cursor: { ...cursor, objectId: "creator:00112233445566778899aabbccddeeff" },
			})
		).rejects.toThrow("cursor is stale");
		await expect(
			opened.room.queryRetainedHashes({ limit: 1, cursor: { ...cursor, snapshotDigest: "0".repeat(64) } })
		).rejects.toThrow("cursor is stale");
		await expect(opened.room.queryRetainedHashes({ limit: 129 })).rejects.toThrow("query is invalid");
		while (page.continuation !== null) {
			page = await opened.room.queryRetainedHashes({ limit: 1, cursor: page.continuation });
			expect(page.entries.length).toBeLessThanOrEqual(1);
			entries.push(...page.entries);
		}
		expect(entries.map((entry) => entry.vertexDigest)).toEqual(expected);
		expect(entries.map((entry) => entry.journalSequence)).toEqual(expected.map((_, i) => i));
	}
	const cursor = required((await creator.room.queryRetainedHashes({ limit: 1 })).continuation);
	await creator.room.issue(paint("query-new-window"));
	await expect(creator.room.queryRetainedHashes({ limit: 1, cursor })).rejects.toThrow("cursor is stale");
	expect((await creator.room.queryRetainedHashes({ limit: 128 })).retainedRowCount).toBe(expected.length + 1);
}, 120_000);

it("native retained repair requests actual history and sends original signed retained bytes only to a connected target", async () => {
	const f = await canvasFixture();
	const creator = await f.open("creator");
	await creator.room.issue(paint("repair"));
	const issued = await f.issued(),
		sent: Message[] = [];
	Reflect.set(creator.networkNode, "getAllPeers", () => ["canvas-observer"]);
	Reflect.set(creator.networkNode, "sendMessage", (peer: string, message: Message) => {
		expect(peer).toBe("canvas-observer");
		sent.push(message);
		return Promise.resolve();
	});
	const before = creator.retainedRequests();
	await expect(creator.room.requestRetainedRepair({ targetPeerId: "unconnected" })).rejects.toThrow(
		"target is unavailable"
	);
	expect(creator.retainedRequests()).toBe(before);
	expect(sent).toEqual([]);
	expect(await creator.room.requestRetainedRepair({ targetPeerId: "canvas-observer" })).toEqual({ kind: "scheduled" });
	expect(creator.retainedRequests()).toBe(before + 1);
	expect(sent).toHaveLength(issued.length);
	for (let i = 0; i < sent.length; i++) {
		const envelope = V3Envelope.decode(required(sent[i]).data);
		expect(envelope.canonicalPreimage).toEqual(required(issued[i]).envelope.canonicalPreimageBytes);
		expect(envelope.signature).toEqual(required(issued[i]).envelope.signature);
	}
	expect(await creator.room.requestRetainedRepair()).toEqual({ kind: "scheduled" });
	expect(creator.retainedRequests()).toBe(before + 2);
}, 120_000);

it("native retained query refuses altered stored received signatures without changing the safety floor or projection", async () => {
	const f = await canvasFixture();
	const creator = await f.open("creator");
	const observer = await f.open("observer", f.observer, { receiveOnly: true });
	await creator.room.issue(paint("query-signature"));
	const rows = await f.issued();
	await observer.receive(
		rows.map((row) => row.envelope),
		hex(required(rows.at(-1)).envelope.digest)
	);
	const before = encodeCanonical(observer.room.projection().state);
	const scope = { objectId: f.objectId, pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest };
	const floor = await observer.floor.read({ scope });
	const key = createHash("sha256")
		.update(JSON.stringify(["journal", "observer"]))
		.digest("hex");
	const db = new DatabaseSync(join(f.directory, `${key}.sqlite.drp-live-journal-v1.sqlite`));
	try {
		// Existing foreign-corruption fixture mechanism: permit only this exact
		// unfenced native scope, never active/completed retirement control.
		db.function("journal_retirement_allows", (objectId, epoch, anchorDigest) =>
			objectId === f.objectId &&
			epoch === 0 &&
			anchorDigest === f.invite.pinnedGenesisAnchorDigest &&
			db.prepare("SELECT count(*) AS n FROM retirement_controls").get()?.n === 0
				? 1
				: 0
		);
		const changed = db
			.prepare("UPDATE accepted_entries SET received_signature=? WHERE journal_sequence=?")
			.run(new Uint8Array(64), rows.length - 1);
		expect(changed.changes).toBe(1);
	} finally {
		db.close();
	}
	await expect(observer.room.queryRetainedHashes({ limit: 128 })).rejects.toThrow("not authenticated");
	expect(encodeCanonical(observer.room.projection().state)).toEqual(before);
	expect(await observer.floor.read({ scope })).toEqual(floor);
	expect(await f.observerEffects("observer")).toMatchObject({ lineage: { next: 0 }, issued: null });
}, 120_000);

it("native retained query and repair refuse an advanced host floor before delivering old-window results or requesting repair", async () => {
	const f = await canvasFixture();
	const creator = await f.open("creator");
	const scope = { objectId: f.objectId, pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest };
	const current = await creator.floor.read({ scope });
	if (!current.ok || current.state === null) throw new TypeError("required current floor");
	const next = { ...current.state.stable, epoch: 1, currentAnchorDigest: "f".repeat(64) };
	const pending = await creator.floor.begin({ scope, expected: current.state, next });
	if (!pending.ok || pending.state === null) throw new TypeError("required pending floor");
	expect(await creator.floor.commit({ scope, expected: pending.state })).toMatchObject({ ok: true });
	const advanced = await creator.floor.read({ scope }),
		requests = creator.retainedRequests();
	await expect(creator.room.queryRetainedHashes({ limit: 1 })).rejects.toThrow("head or floor is stale");
	await expect(creator.room.requestRetainedRepair()).rejects.toThrow("head or floor is stale");
	expect(creator.retainedRequests()).toBe(requests);
	expect(await creator.floor.read({ scope })).toEqual(advanced);
}, 120_000);

it("native retained read-control admission remains finite and close joins queued work behind an admitted callback", async () => {
	const f = await canvasFixture();
	const creator = await f.open("creator");
	let hold = false,
		release!: () => void;
	const joined = new Promise<void>((resolve) => {
		release = resolve;
	});
	const observer = await f.open("observer", f.observer, {
		receiveOnly: true,
		onAccepted: async () => {
			if (hold) await joined;
		},
	});
	let rows = await f.issued();
	await observer.receive(
		rows.map((row) => row.envelope),
		hex(required(rows.at(-1)).envelope.digest)
	);
	hold = true;
	await creator.room.issue(paint("query-held-callback"));
	rows = await f.issued();
	await observer.receive([required(rows.at(-1)).envelope], hex(required(rows.at(-1)).envelope.digest));
	const work = Array.from({ length: 32 }, () =>
		observer.room.queryRetainedHashes({ limit: 1 }).then(
			() => "delivered",
			(error) => String(error)
		)
	);
	await expect(observer.room.queryRetainedHashes({ limit: 1 })).rejects.toThrow("capacity exhausted");
	let closed = false;
	const closing = observer.room.close().then(() => {
		closed = true;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
		expect(() => observer.room.queryRetainedHashes({ limit: 1 })).toThrow("session is closed");
	} finally {
		release();
	}
	const outcomes = await Promise.all(work);
	// Close retires the plane's retained read phase (f7e1f3a2): every queued query is
	// refused by the retired phase; none is delivered.
	expect(outcomes).toEqual(Array.from({ length: 32 }, () => "TypeError: v3 retained query read phase is unavailable"));
	await closing;
	expect(closed).toBe(true);
}, 120_000);

it("native retained entered read keeps original SQLite exclusion until close joins and refuses delivery after revocation", async () => {
	const f = await canvasFixture();
	let hold = false,
		release!: () => void,
		entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const creator = await f.open("creator", f.creator, {
		onJournalPage: async () => {
			if (hold) {
				entered();
				await held;
			}
		},
	});
	hold = true;
	const query = creator.room.queryRetainedHashes({ limit: 1 }).then(
		() => "delivered",
		(error) => String(error)
	);
	await started;
	const key = createHash("sha256")
		.update(JSON.stringify(["journal", "creator"]))
		.digest("hex");
	const raw = new DatabaseSync(join(f.directory, `${key}.sqlite.drp-live-journal-v1.sqlite`));
	let closed = false;
	const closing = creator.room.close().then(() => {
		closed = true;
	});
	try {
		raw.exec("PRAGMA busy_timeout=0");
		expect(() => raw.exec("BEGIN IMMEDIATE")).toThrow("locked");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
		expect(() => raw.exec("BEGIN IMMEDIATE")).toThrow("locked");
	} finally {
		release();
	}
	expect(await query).toContain("stale");
	await closing;
	expect(closed).toBe(true);
	try {
		raw.exec("BEGIN IMMEDIATE");
		raw.exec("ROLLBACK");
	} finally {
		raw.close();
	}
}, 120_000);

it("native retained query refuses delivery when revocation occurs during joined reservation release", async () => {
	const f = await canvasFixture();
	let hold = false,
		release!: () => void,
		entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const creator = await f.open("creator", f.creator, {
		onJournalRelease: async () => {
			if (hold) {
				entered();
				await held;
			}
		},
	});
	hold = true;
	const query = creator.room.queryRetainedHashes({ limit: 1 }).then(
		() => "delivered",
		(error) => String(error)
	);
	await started; // Page authentication/currentness completed; native release has not joined.
	let closed = false;
	const closing = creator.room.close().then(() => {
		closed = true;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
	} finally {
		release();
	}
	expect(await query).toContain("stale");
	await closing;
	expect(closed).toBe(true);
}, 120_000);

it("native retained query follows healthy recipient adoption and persisted reopen without claiming snapshot history as live hashes", async () => {
	const f = await canvasFixture();
	const creator = await f.open("creator");
	const observer = await f.open("observer", f.observer, { receiveOnly: true });
	await creator.room.issue(paint("query-source-epoch"));
	const rows = await f.issued();
	await observer.receive(
		rows.map((row) => row.envelope),
		hex(required(rows.at(-1)).envelope.digest)
	);
	const oldCursor = required((await observer.room.queryRetainedHashes({ limit: 1 })).continuation);
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
	await creator.room.adoptCreatorSuccessor();
	const transfer = await delivery(f, creator);
	Reflect.set(observer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await observer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	await expect(observer.room.queryRetainedHashes({ limit: 1, cursor: oldCursor })).rejects.toThrow("cursor is stale");
	const empty = await observer.room.queryRetainedHashes({ limit: 128 });
	expect(empty).toMatchObject({
		scope: { objectId: f.objectId, epoch: 1 },
		entries: [],
		retainedRowCount: 0,
		continuation: null,
	});
	expect(observer.room.projection().state.counters[3]).toEqual([200, 101, 7]);
	await f.stop(observer);
	const reopened = await f.open("observer", f.observer, { reopen: true, receiveOnly: true });
	expect(await reopened.room.queryRetainedHashes({ limit: 128 })).toMatchObject({
		scope: { epoch: 1 },
		entries: [],
		retainedRowCount: 0,
	});
	await creator.room.issue(paint("query-target-epoch"));
	const currentRows = (await f.issued()).filter(
		(row) => (decodeCanonical(row.envelope.canonicalPreimageBytes) as Record<string, unknown>).epoch === 1
	);
	await reopened.receive(
		currentRows.map((row) => row.envelope),
		hex(required(currentRows.at(-1)).envelope.digest)
	);
	const page = await reopened.room.queryRetainedHashes({ limit: 128 });
	expect(page.entries.map((entry) => entry.vertexDigest)).toEqual(currentRows.map((row) => hex(row.envelope.digest)));
	expect(page.retainedRowCount).toBe(currentRows.length);
	expect(reopened.room.projection().state.counters[3]).toEqual([400, 202, 14]);
}, 120_000);

it("native configured Canvas two-node loopback executes healthy recipient rollover reopen and continued gameplay", async () => {
	const f = await canvasFixture(true);
	const creator = await f.open("creator");
	const observer = await f.open("observer", f.observer, { receiveOnly: true });
	const sourcePeer = required(f.creatorNode).networkNode.peerId;
	const recipientPeer = required(f.observerNode).networkNode.peerId;
	expect(sourcePeer).not.toBe(recipientPeer);
	expect(
		required(f.creatorNode)
			.networkNode.getMultiaddrs()
			.every((address) => address.includes("127.0.0.1"))
	).toBe(true);
	await expect
		.poll(() => required(f.observerNode).networkNode.getAllPeers(), { timeout: 15_000 })
		.toContain(sourcePeer);
	await creator.room.issue(paint("loopback-source-paint", [9, 8, 7]));
	// The retained channel is reached through the actual authenticated V3 room,
	// never an injected obsolete object/ACL lookup or a bare Node activation.
	const currentChannel = creator.room.openEphemeral({
		maxMessageBytes: 1024,
		maxSequencedKeys: 2,
		maxSequencedSenders: 8,
	});
	expect(currentChannel.authorityGeneration?.()).toBe(0);
	expect(currentChannel.authorizedPeers()).not.toContain(recipientPeer);
	currentChannel.close();
	const sourceDigest = hex(required((await f.issued()).at(-1)).envelope.digest);
	await expect.poll(() => observer.accepted.has(sourceDigest), { timeout: 30_000 }).toBe(true);
	expect(observer.room.projection().state).toEqual(creator.room.projection().state);
	expect(observer.room.projection().state.counters[3]).toEqual([9, 8, 7]);
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
	await creator.room.adoptCreatorSuccessor();
	const offer = await creator.room.exportCreatorSuccessor();
	const manifest = decodeCanonical(offer.exactCanonicalSnapshotManifestBytes) as Record<string, unknown>;
	expect((manifest.chunks as unknown[]).length).toBeGreaterThan(0);
	// Actual libp2p material and chunk protocol hosts are used unchanged. There
	// is no scripted stream, fixture database copy or healthy-session recreation.
	await observer.room.installCreatorSuccessor({ offer, peers: [sourcePeer] });
	expect(observer.room.authority()).toMatchObject({ objectId: f.objectId, epoch: 1 });
	expect(observer.room.projection().state).toEqual(creator.room.projection().state);
	expect(await observer.room.queryRetainedHashes({ limit: 128 })).toMatchObject({
		scope: { epoch: 1 },
		retainedRowCount: 0,
	});
	const noAuthoredWork = { lineage: { next: 0, exhausted: false }, issued: null, outbox: [], settlement: null };
	expect(await f.observerEffects("observer")).toEqual(noAuthoredWork);
	await expect(observer.room.issue(paint("loopback-observer-illegal"))).rejects.toThrow();
	await f.stop(observer);
	const reopened = await f.open("observer", f.observer, { reopen: true, receiveOnly: true });
	expect(reopened.room.authority()).toMatchObject({ epoch: 1 });
	expect(reopened.room.projection().state.counters[3]).toEqual([9, 8, 7]);
	await creator.room.issue(paint("loopback-target-paint", [3, 2, 1]));
	const targetDigest = hex(required((await f.issued()).at(-1)).envelope.digest);
	await expect.poll(() => reopened.accepted.has(targetDigest), { timeout: 30_000 }).toBe(true);
	expect(reopened.room.projection().state.counters[3]).toEqual([12, 10, 8]);
	expect(reopened.room.projection().state).toEqual(creator.room.projection().state);
	expect(await f.observerEffects("observer")).toEqual(noAuthoredWork);
}, 120_000);

it("native Canvas unknown observer opens without authoring bootstrap or gaining Writer authority", async () => {
	const fixture = await canvasFixture();
	await fixture.open("creator");
	const observer = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	expect(observer.room.previewLatchedAcl()).toMatchObject({
		current: { permissionless: false, members: [{ author: fixture.creator.localAuthorId }] },
	});
	const empty = { lineage: { next: 0, exhausted: false }, issued: null, outbox: [], settlement: null };
	expect(await fixture.observerEffects("observer")).toEqual(empty);
	const before = encodeCanonical(observer.room.projection().state);
	await expect(observer.room.issue(paint("observer-illegal"))).rejects.toThrow();
	await expect(observer.room.sealEpoch()).rejects.toThrow();
	await expect(
		observer.room.rehearseMigration({ rehearsalNonce: new Uint8Array(32).fill(7), targetCreatorInvite: fixture.invite })
	).rejects.toThrow();
	await expect(
		observer.room.activateMigration({
			exactCanonicalRecordBytes: new Uint8Array([1]),
			recordVertexDigest: "0".repeat(64),
			targetCreatorInvite: fixture.invite,
		})
	).rejects.toThrow();
	expect(encodeCanonical(observer.room.projection().state)).toEqual(before);
	expect(await fixture.observerEffects("observer")).toEqual(empty);
}, 120_000);

it("native Canvas observer preserves additive counters through recipient rollover, persisted reopen and continued creator gameplay", async () => {
	const fixture = await canvasFixture();
	expect(Reflect.get(fixture.application, "snapshotReadPolicy")).toBe("authenticated-public");
	const creator = await fixture.open("creator");
	const observer = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	await creator.room.issue(paint("paint-one"));
	await creator.room.issue(paint("paint-two"));
	const rows = await fixture.issued();
	await observer.receive(
		rows.map((row) => row.envelope),
		hex(required(rows.at(-1)).envelope.digest)
	);
	expect(observer.room.projection().state.counters[3]).toEqual([400, 202, 14]);
	expect(observer.room.projection().state).toEqual(creator.room.projection().state);
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
	await creator.room.adoptCreatorSuccessor();
	const transfer = await delivery(fixture, creator);
	expect(transfer.chunks.length).toBeGreaterThan(0);
	Reflect.set(observer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	await observer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
	await fixture.stop(creator); // Join source custody; no database copying/recreation.
	expect(observer.room.authority()).toMatchObject({ epoch: 1, objectId: fixture.objectId });
	expect(observer.room.projection().state.counters[3]).toEqual([400, 202, 14]);
	expect(await fixture.observerEffects("observer")).toEqual({
		lineage: { next: 0, exhausted: false },
		issued: null,
		outbox: [],
		settlement: null,
	});
	await fixture.stop(observer);
	const reopened = await fixture.open("observer", fixture.observer, { reopen: true, receiveOnly: true });
	expect(reopened.room.projection().state.counters[3]).toEqual([400, 202, 14]);
	await expect(reopened.room.issue(paint("reopened-observer-illegal"))).rejects.toThrow();
	const continued = await fixture.open("creator", fixture.creator, { reopen: true });
	await continued.room.issue(paint("paint-three", [9, 8, 7]));
	const targetRows = (await fixture.issued()).filter(
		(row) => (decodeCanonical(row.envelope.canonicalPreimageBytes) as Record<string, unknown>).epoch === 1
	);
	await reopened.receive(
		targetRows.map((row) => row.envelope),
		hex(required(targetRows.at(-1)).envelope.digest)
	);
	expect(reopened.room.projection().state.counters[3]).toEqual([409, 210, 21]);
	expect(reopened.room.projection().state).toEqual(continued.room.projection().state);
	expect(await fixture.observerEffects("observer")).toEqual({
		lineage: { next: 0, exhausted: false },
		issued: null,
		outbox: [],
		settlement: null,
	});
}, 120_000);

it("native Canvas observer refuses foreign object and tampered genesis invite without local issuance effects", async () => {
	const fixture = await canvasFixture();
	await fixture.open("creator");
	await expect(
		fixture.open("foreign", fixture.observer, {
			receiveOnly: true,
			objectId: "foreign:00112233445566778899aabbccddeeff",
		})
	).rejects.toThrow();
	const signature = new Uint8Array(fixture.invite.detachedGenesisSignature);
	signature[0] = (signature[0] ?? 0) ^ 1;
	await expect(
		fixture.open("altered", fixture.observer, {
			receiveOnly: true,
			creatorInvite: { ...fixture.invite, detachedGenesisSignature: signature },
		})
	).rejects.toThrow();
	for (const name of ["foreign", "altered"])
		expect(await fixture.observerEffects(name)).toEqual({
			lineage: { next: 0, exhausted: false },
			issued: null,
			outbox: [],
			settlement: null,
		});
}, 120_000);

it("native Canvas retains creator-only admission and rejects a genuinely signed unknown-author paint before effects", async () => {
	const fixture = await canvasFixture();
	const creator = await fixture.open("creator");
	await expect(fixture.open("not-receive-only", fixture.observer)).rejects.toThrow();
	const observer = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	await creator.room.issue(paint("creator-valid-barrier"));
	const rows = await fixture.issued();
	const source = required(rows.at(-1)).envelope;
	const preimage = decodeCanonical(source.canonicalPreimageBytes) as Record<string, unknown>;
	const bytes = encodeCanonical({ ...preimage, author: fixture.observer.localAuthorId, authorSequence: 0 });
	const digest = hashDomain("ts-drp/vertex/v3", bytes);
	const unauthorized = {
		canonicalPreimageBytes: bytes,
		digest,
		signature: await fixture.observer.signWithLocalAuthor(digest),
	};
	// A valid subsequent creator delivery is the queue-completion barrier; no
	// speculative sleep or source-only rejection substitutes for native replay.
	await observer.receive([unauthorized, ...rows.map((row) => row.envelope)], hex(source.digest));
	expect(observer.room.projection().state.counters[3]).toEqual([200, 101, 7]);
	expect(observer.room.projection().state).toEqual(creator.room.projection().state);
	expect(await fixture.observerEffects("observer")).toEqual({
		lineage: { next: 0, exhausted: false },
		issued: null,
		outbox: [],
		settlement: null,
	});
}, 120_000);

it("native Canvas receive-only reopen refuses preexisting local issuance debt unchanged", async () => {
	const fixture = await canvasFixture();
	await fixture.open("creator");
	const observer = await fixture.open("observer", fixture.observer, { receiveOnly: true });
	await fixture.stop(observer);
	const source = required((await fixture.issued())[0]);
	const preimage = decodeCanonical(source.envelope.canonicalPreimageBytes) as Record<string, unknown>;
	const store = await fixture.host.openIssuance("observer");
	try {
		const scope = { author: fixture.observer.localAuthorId, objectId: fixture.objectId };
		// Negative durable premise, not portable Writer authority: the native
		// mechanical owner can retain signed debt from a previous local mode.
		// Receive-only recovery must refuse it rather than author, erase or publish.
		await store.transactIssue(scope, async (authorSequence, nativeAdmission) => {
			const bytes = encodeCanonical({ ...preimage, author: scope.author, authorSequence });
			const digest = hashDomain("ts-drp/vertex/v3", bytes);
			const sign = () => fixture.observer.signWithLocalAuthor(digest);
			const signature = nativeAdmission === undefined ? await sign() : await nativeAdmission(bytes, sign);
			const envelope = { canonicalPreimageBytes: bytes, digest, signature };
			return {
				authorSequence,
				envelope,
				issuedRecord: { authorSequence, envelope, scope },
				outboxEntry: { authorSequence, envelope, scope },
			};
		});
	} finally {
		await store.close();
	}
	const before = encodeCanonical(await fixture.observerEffects("observer"));
	expect((await fixture.observerEffects("observer")).lineage.next).toBe(1);
	await expect(fixture.open("observer", fixture.observer, { reopen: true, receiveOnly: true })).rejects.toThrow();
	expect(encodeCanonical(await fixture.observerEffects("observer"))).toEqual(before);
}, 120_000);

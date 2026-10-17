/* eslint-disable @typescript-eslint/explicit-function-return-type -- Existing fixture capability inference is preserved. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { openTrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { verifyInclusion } from "@ts-drp/compaction";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { ScriptedSnapshotChunkPort } from "./fixtures/phase-4c-v3/snapshot-pull-transport.js";
import {
	createShippingChatAdmissionPolicy,
	createShippingV3ChatApplication,
	shippingChatCanonicalStateBytes,
	type ShippingChatProjection,
} from "../examples/chat/src/v3-chat-application.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import { Keychain } from "../packages/keychain/src/keychain.js";
import {
	createCreatorSuccessorMaterialServer,
	readCreatorSuccessorExport,
} from "../packages/node/src/creator-adoption.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeArchiveStorage } from "../packages/storage-node/src/archive.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

const directories = new Set<string>();
const rooms = new Set<V3RoomSession<ShippingChatProjection>>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const keychains = new Set<Keychain>();
const protocolPorts = new Set<SnapshotChunkProtocolPort>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
// The accepted small native archive policy, not a new production resource ceiling.
const archiveFixtureCapacity = Object.freeze({ maxArtifactBytes: 4096, maxTotalEncodedBytes: 65536,
	maxArtifacts: 32, maxAppendArtifacts: 8, maxAppendEncodedBytes: 16384, maxControlBytes: 8192,
	maxReadPageEntries: 4, maxReadPageBytes: 8192, maxReadHandles: 1, maxQueuedCalls: 8 });
const send = (id: string, text = "棋 ♟ café", displayTimeMs = 1791662400000) =>
	Object.freeze({ action: "message", clientOperationId: id, displayTimeMs, text });

afterEach(async () => {
	for (const room of rooms) await room.close();
	rooms.clear();
	for (const port of protocolPorts) await port.close();
	protocolPorts.clear();
	for (const head of heads) await head.close();
	heads.clear();
	for (const keychain of keychains) await keychain.stop();
	keychains.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
});

async function fixture(roleShape?: "same-target" | "distinct-target", archiveEnabled = false, interruptArchiveCommitOnce = false) {
	const catalogDirectory = process.env.SHIPPING_CHAT_CATALOG_DIR;
	if (catalogDirectory === undefined) throw new TypeError("SHIPPING_CHAT_CATALOG_DIR must name genuine nightly output");
	const catalog = openTrustedBlueprintCatalog({ catalogDirectory });
	const blueprintDigest = catalog.blueprintDigests[0];
	if (blueprintDigest === undefined || catalog.blueprintDigests.length !== 1)
		throw new TypeError("expected exact shipping Chat catalog");
	const application = await createShippingV3ChatApplication({ catalog, blueprintDigest });
	const directory = mkdtempSync(join(tmpdir(), "shipping-chat-room-"));
	directories.add(directory);
	const keychain = new Keychain({ private_key_seed: "shipping-chat-native-creator-v2" });
	await keychain.start();
	keychains.add(keychain);
	const recipientKeychain =
		roleShape === undefined ? undefined : new Keychain({ private_key_seed: "shipping-chat-native-recipient-v2" });
	if (recipientKeychain !== undefined) {
		await recipientKeychain.start();
		keychains.add(recipientKeychain);
	}
	const enrolled = recipientKeychain === undefined ? [keychain] : [keychain, recipientKeychain];
	const identities = enrolled.map((owner) => ({ author: owner.localAuthorId }));
	const signing = enrolled.map(() => 0);
	const publications = enrolled.map(() => 0);
	const ingress = new Map<number, (message: Message) => void>();
	const ingressTopics = new Map<number, string>();
	const transferPorts = new Map<number, SnapshotChunkProtocolPort>();
	const accepted = enrolled.map(() => new Set<string>());
	const objectId = `creator:${hex(hashDomain("shipping-chat-native-object/v2", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const signers = [{ publicKey: keychain.localAuthorId, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest,
		exactCanonicalApplicationStateBytes: shippingChatCanonicalStateBytes([]),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			objectId,
			members: [
				{
					author: keychain.localAuthorId,
					finalityKey: keychain.localAuthorId,
					groups: roleShape === "same-target" ? ["admin", "finality"] : ["admin", "finality", "writer"],
				},
				...(recipientKeychain === undefined
					? []
					: [
							{
								author: recipientKeychain.localAuthorId,
								finalityKey: null,
								groups: roleShape === "same-target" ? ["admin", "writer"] : ["admin"],
							},
						]),
			].sort((left, right) => left.author.localeCompare(right.author)),
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
		signGenesisAnchorDigest: (digest) => keychain.signWithLocalAuthor(digest),
	});
	const open = async (reopen = false, index = 0, protocol?: SnapshotChunkProtocolPort) => {
		const owner = enrolled[index];
		if (owner === undefined) throw new TypeError("missing enrolled native Chat identity");
		const name = index === 0 ? "shipping-chat" : "shipping-chat-recipient";
		const head = createNodeRoomHeadAuthority({
			filename: join(directory, index === 0 ? "external-floor.sqlite" : "recipient-external-floor.sqlite"),
			initialization: { kind: reopen ? "reopen" : "create" },
		});
		heads.add(head);
		const networkNode = fakeNetwork(index === 0 ? "r9-grid-peer-0" : "r9-grid-peer-1", false);
		Reflect.set(networkNode, "publishMessage", () => {
			publications[index] = (publications[index] ?? 0) + 1;
			return Promise.resolve(true);
		});
		Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
		if (protocol !== undefined) transferPorts.set(index, protocol);
		if (roleShape !== undefined && index === 1)
			Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => required(transferPorts.get(index)));
		const room = await createV3RoomSession({
			application,
			storageHost: createNodeV3RoomStorageHost({ directory, initialization: () => (reopen ? "reopen" : "create") }),
			author: owner.localAuthorId,
			creatorInvite: invite,
			...(index === 0 ? { creatorFinalitySigner: await keychain.acquireLocalAuthorFinalitySigner() } : {}),
			...(index !== 0 || !archiveEnabled ? {} : { openCreatorArchive: (scope: Readonly<{ databaseName: string;
				objectId: string; pinnedGenesisAnchorDigest: string }>) => {
				const store = createNodeArchiveStorage({ filename: join(directory, "source-archive.sqlite"),
					initialization: reopen ? "reopen" : "create", objectId: scope.objectId,
					pinnedGenesisAnchorDigest: scope.pinnedGenesisAnchorDigest, capacity: archiveFixtureCapacity });
				return { store: !interruptArchiveCommitOnce ? store : Object.freeze({ ...store,
					commitPreparedAppend: (append: Parameters<typeof store.commitPreparedAppend>[0]) => {
						if (interruptArchiveCommitOnce) {
							interruptArchiveCommitOnce = false;
							return Promise.reject(new Error("R12_ARCHIVE_COMMIT_INTERRUPT"));
						}
						return store.commitPreparedAppend(append);
					} }), limits: { maxSegmentBytes: 4096, maxRecordsPerSegment: 2,
					chunkBytes: 1024, maxChunks: 4, maxSegments: 4 } };
			} }),
			createOperationAdmissionPolicy: (context) => createShippingChatAdmissionPolicy(context),
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: Uint8Array.from(Buffer.from(owner.localAuthorId, "hex")),
			roomHeadAuthority: head,
			signRegisteredVertexDigest: (digest) => {
				signing[index] = (signing[index] ?? 0) + 1;
				return owner.signWithLocalAuthor(digest);
			},
			onAcceptedVertex: (vertex) => {
				accepted[index]?.add(hex(vertex.digest));
			},
			onProjection: () => undefined,
			openTransport: () => ({
				networkNode,
				close: () => undefined,
				requestRetainedHistory: () => undefined,
				setIngressHandler: (topic, handler) => {
					ingress.set(index, handler);
					ingressTopics.set(index, topic);
				},
				setRetainedPublisher: () => undefined,
				openEphemeral: () => {
					throw new TypeError("ephemeral not exercised");
				},
			}),
		});
		rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		return { room, head, index, name };
	};
	const nextOrdinal = async () => {
		const store = await createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" }).openIssuance(
			"shipping-chat"
		);
		try {
			return (await store.readLineage({ author: keychain.localAuthorId, objectId })).next;
		} finally {
			await store.close();
		}
	};
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const ownRows = async (index: number) => {
		const name = index === 0 ? "shipping-chat" : "shipping-chat-recipient";
		const store = await host.openIssuance(name);
		try {
			return await store.readOutboxPage({
				scope: { author: required(enrolled[index]).localAuthorId, objectId },
				limit: 128,
			});
		} finally {
			await store.close();
		}
	};
	const receiveRows = async (index: number, rows: Awaited<ReturnType<typeof ownRows>>) => {
		const handler = ingress.get(index);
		if (handler === undefined) throw new TypeError("missing genuine native Chat ingress");
		for (const row of rows)
			handler(
				Message.create({
					data: V3Envelope.encode({
						canonicalPreimage: row.commit.envelope.canonicalPreimageBytes,
						signature: row.commit.envelope.signature,
					}).finish(),
					objectId: required(ingressTopics.get(index)),
					sender: index === 0 ? "r9-grid-peer-1" : "r9-grid-peer-0",
					type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
				})
			);
		await vi.waitFor(
			() => {
				for (const row of rows)
					expect(
						accepted[index]?.has(hex(row.commit.envelope.digest)),
						"authenticated role ingress peer=" +
							index +
							" action=" +
							String(
								Reflect.get(
									Reflect.get(
										decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as object,
										"operation"
									) as object,
									"action"
								)
							)
					).toBe(true);
			},
			{ timeout: 15_000 }
		);
	};
	// Exact logical native image, using the existing SQLite dump pattern; no
	// database copying, synthetic owner or hard-memory policy is introduced.
	const nativeImage = () =>
		encodeCanonical(
			readdirSync(directory)
				.filter((name) => name.endsWith(".sqlite"))
				.sort()
				.map((name) => {
					const database = new DatabaseSync(join(directory, name), { readOnly: true });
					try {
						const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
						return {
							name,
							tables: tables.map((row) => {
								const table = row.name as string;
								const escaped = '"' + table.replaceAll('"', '""') + '"';
								const order = database
									.prepare("PRAGMA table_info(" + escaped + ")")
									.all()
									.map((column) => '"' + (column.name as string).replaceAll('"', '""') + '"')
									.join(",");
								return { table, rows: database.prepare("SELECT * FROM " + escaped + " ORDER BY " + order).all() };
							}),
						};
					} finally {
						database.close();
					}
				})
		);
	return {
		open,
		keychain,
		nextOrdinal,
		host,
		application,
		invite,
		directory,
		identities,
		enrolled,
		signing,
		publications,
		objectId,
		ownRows,
		receiveRows,
		nativeImage,
		transferPorts,
	};
}

async function readNativeArchive(f: Awaited<ReturnType<typeof fixture>>) {
	const archive = createNodeArchiveStorage({ filename: join(f.directory, "source-archive.sqlite"),
		initialization: "reopen", objectId: f.objectId, pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest,
		capacity: archiveFixtureCapacity });
	try {
		const status = await archive.inspect();
		const reader = await archive.acquireRead(status.position);
		try {
			const entries = await reader.readIndexPage({ afterLeafIndex: null, limit: 4 });
			for (const entry of entries) expect(verifyInclusion(entry.exactCanonicalEntryBytes,
				entry.proof, Uint8Array.from(Buffer.from(status.position.root, "hex")))).toBe(true);
			await reader.check();
			return { status, entries };
		} finally { await reader.release(); }
	} finally { await archive.close(); }
}

it("R12 actual source archive certifies target root through healthy creator/recipient adoption and SQLite reopen", async () => {
	const f = await fixture("distinct-target", true);
	let creator = await f.open();
	let recipient = await f.open(false, 1);
	await creator.room.issue(send("archive-original", "original source-bound history"));
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: required(f.enrolled[1]).localAuthorId });
	await f.receiveRows(1, await f.ownRows(0));
	const sealed = await creator.room.sealEpoch();
	expect(sealed).toMatchObject({ ok: true });
	await creator.room.adoptCreatorSuccessor();
	const delivery = await recipientSource(f, "shipping-chat", f.objectId, f.invite);
	const cut = decodeCanonical(delivery.offer.exactCanonicalCutValueBytes) as Record<string, unknown>;
	const native = await readNativeArchive(f);
	expect(cut.archiveAppend).toMatchObject({ sourceEpoch: 0, targetArchiveIndexRoot: native.status.position.root });
	expect(cut.archiveIndexRoot).toBe(native.status.position.root);
	expect(native.entries.length).toBeGreaterThan(0);
	f.transferPorts.set(1, delivery.port);
	await recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
	expect(recipient.room.projection().messages).toEqual(creator.room.projection().messages);
	for (const current of [creator, recipient]) {
		await current.room.close(); rooms.delete(current.room);
		await current.head.close(); heads.delete(current.head);
	}
	creator = await f.open(true);
	recipient = await f.open(true, 1);
	expect(recipient.room.projection().messages).toEqual(creator.room.projection().messages);
	expect((await readNativeArchive(f)).status.position).toEqual(native.status.position);
	await recipient.room.issue(send("archive-target-gameplay", "after recipient native reopen"));
	expect(recipient.room.projection().messages.map(message => message.clientOperationId).sort())
		.toEqual(["archive-original", "archive-target-gameplay"]);
	await delivery.port.close(); protocolPorts.delete(delivery.port);
}, 120_000);

it("R12 exact Complete-Q cold reopen finishes original archive intent/CAS then snapshot-backed adoption without re-signing", async () => {
	const f = await fixture(undefined, true, true);
	let current = await f.open();
	await current.room.issue(send("archive-interrupted", "original source before Complete-Q interruption"));
	await expect(current.room.sealEpoch()).rejects.toThrow("R12_ARCHIVE_COMMIT_INTERRUPT");
	const store = await f.host.openAhe("shipping-chat--ahe");
	let original: Awaited<ReturnType<typeof store.readGenerationPage>>;
	try {
		const object = parseStorageObjectId(f.objectId);
		if (!object.ok) throw new TypeError("invalid archive recovery fixture object");
		original = await store.readGenerationPage({ objectId: object.value, limit: 32 });
		expect(original.ok).toBe(true);
	} finally { await store.close(); }
	if (!original.ok) throw new TypeError("archive original Complete census is unavailable");
	const complete = original.value.generations.filter(generation => generation.state === "Complete");
	expect(complete).toHaveLength(1);
	const originalQ = required(complete[0]);
	const prepared = await readNativeArchive(f);
	expect(prepared.status.pending?.prepared).toBe(true);
	expect(prepared.status.position.size).toBe(0);
	const finality = vi.spyOn(f.keychain, "acquireLocalAuthorFinalitySigner");
	await current.room.close(); rooms.delete(current.room);
	await current.head.close(); heads.delete(current.head);
	current = await f.open(true);
	expect(current.room.projection().messages.map(message => message.clientOperationId)).toEqual(["archive-interrupted"]);
	const readback = await f.host.openAhe("shipping-chat--ahe");
	try {
		const object = parseStorageObjectId(f.objectId);
		if (!object.ok) throw new TypeError("invalid archive recovery fixture object");
		const rows = await readback.readGenerationPage({ objectId: object.value, limit: 32 });
		if (!rows.ok) throw new TypeError("archive recovery native readback unavailable");
		const q = required(rows.value.generations.find(generation => generation.generationId === originalQ.generationId));
		expect(q.baseExpectedHead).toEqual(originalQ.baseExpectedHead);
		expect(q.closure).toEqual(originalQ.closure);
		expect(q.closureDigest).toBe(originalQ.closureDigest);
		expect(q.state).toBe("Superseded"); // original Q CAS occurred before original L adoption.
	} finally { await readback.close(); }
	expect((await readNativeArchive(f)).status.position.size).toBeGreaterThan(0);
	// This spy only records signer acquisition; the exact original Q refs above
	// are the no-re-sign evidence. No new epoch is signed to recover the old Q.
	expect(finality).toHaveBeenCalledTimes(1);
	await current.room.issue(send("archive-continued", "target gameplay after exact cold continuation"));
	expect(current.room.projection().messages).toHaveLength(2);
	await current.room.sealEpoch();
	await current.room.adoptCreatorSuccessor();
	expect((await readNativeArchive(f)).status.position.size).toBeGreaterThan(prepared.status.position.size);
}, 120_000);

it("genuine shipping Chat preserves authenticated sender/time and exact retry across healthy rollover and SQLite reopen", async () => {
	const f = await fixture();
	let { room, head } = await f.open();
	const initialOrdinal = await f.nextOrdinal();
	await room.issue(send("immutable-1"));
	expect(await f.nextOrdinal()).toBe(initialOrdinal + 1);
	await room.issue(send("independent-2"));
	await room.issue(send("immutable-1"));
	expect(await f.nextOrdinal()).toBe(initialOrdinal + 3);
	const expected = ["immutable-1", "independent-2"].sort().map((clientOperationId) => ({
		author: f.keychain.localAuthorId,
		clientOperationId,
		displayTimeMs: 1791662400000,
		text: "棋 ♟ café",
	}));
	expect(room.projection().messages).toEqual(expected);
	await expect(room.issue(send("immutable-1", "conflict"))).rejects.toThrow();
	expect(await f.nextOrdinal()).toBe(initialOrdinal + 3);
	expect(room.projection().messages).toEqual(expected);
	const sealed = await room.sealEpoch();
	expect(sealed).toMatchObject({ ok: true });
	await room.adoptCreatorSuccessor();
	expect(room.projection().messages).toEqual(expected);
	await room.close();
	rooms.delete(room);
	await head.close();
	heads.delete(head);
	({ room, head } = await f.open(true));
	expect(room.projection().messages).toEqual(expected);
	const reopenedOrdinal = await f.nextOrdinal();
	await room.issue(send("immutable-1"));
	expect(await f.nextOrdinal()).toBe(reopenedOrdinal + 1);
	expect(room.projection().messages).toEqual(expected);
	await expect(room.issue({ ...send("immutable-1"), author: "b".repeat(64) })).rejects.toThrow();
	await expect(room.issue(send("immutable-1", "棋 ♟ café", 1791662400001))).rejects.toThrow();
	expect(await f.nextOrdinal()).toBe(reopenedOrdinal + 1);
	await room.issue(send("continued-3", "after native reopen", 1791662400002));
	expect(await f.nextOrdinal()).toBe(reopenedOrdinal + 2);
	expect(room.projection().messages).toHaveLength(3);
	expect(room.projection().messages.find(({ clientOperationId }) => clientOperationId === "continued-3")).toEqual({
		author: f.keychain.localAuthorId,
		clientOperationId: "continued-3",
		displayTimeMs: 1791662400002,
		text: "after native reopen",
	});
}, 20_000);

type NativeChatFixture = Awaited<ReturnType<typeof fixture>>;
function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("SHIPPING_CHAT_ROLE_FIXTURE_REQUIRED");
	return value;
}
async function recipientSource(
	fixture: NativeChatFixture,
	name: string,
	objectId: string,
	invite: NativeChatFixture["invite"],
	variant: "valid" | "foreign" | "tampered" = "valid"
) {
	const object = parseStorageObjectId(objectId);
	if (!object.ok) throw new TypeError("R9_TEST_OBJECT_INVALID");
	const store = await fixture.host.openAhe(`${name}--ahe`),
		snapshotStore = await fixture.host.openSnapshots(name);
	try {
		const exported = await readCreatorSuccessorExport({
			store,
			snapshotStore,
			catalog: fixture.application.catalog,
			objectId: object.value,
			pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
			exactCanonicalGenesisAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
			detachedGenesisSignature: invite.detachedGenesisSignature,
		});
		const scope = await snapshotStore.openScope(exported.declaration);
		const read = scope.verificationQuarantine.open(new AbortController().signal);
		const chunks: Uint8Array[] = [];
		try {
			for (const descriptor of exported.declaration.chunks) {
				const chunk = await read.read(descriptor);
				if (chunk === undefined) throw new TypeError("R9_NATIVE_SOURCE_SNAPSHOT_MISSING");
				chunks.push(chunk);
			}
		} finally {
			await read.discard();
			await scope.release();
		}
		const sender = "r9-grid-peer-0",
			receiver = "r9-grid-peer-1",
			creator = required(fixture.identities[0]);
		const foreign =
			variant === "foreign"
				? new Keychain({ private_key_seed: "shipping-chat-native-foreign-material-v2" })
				: undefined;
		if (foreign !== undefined) {
			await foreign.start();
			keychains.add(foreign);
		}
		const material = exported.material;
		const scripted = new ScriptedSnapshotChunkPort(
			{ declaration: exported.declaration, chunks } as ConstructorParameters<typeof ScriptedSnapshotChunkPort>[0],
			new Map([[sender, "honest"]]),
			receiver
		);
		const server = createCreatorSuccessorMaterialServer({
			identity: {
				author: foreign?.localAuthorId ?? creator.author,
				sign: (digest) => (foreign ?? fixture.keychain).signWithLocalAuthor(digest),
				isAuthorizedAuthor: (author) => fixture.identities.some((identity) => identity.author === author),
			},
			localPeerId: sender,
			manifestDigest: exported.declaration.scope.manifestDigest,
			material,
			connectedPeers: () => [receiver],
		});
		const requestDigests: Uint8Array[] = [];
		const port: SnapshotChunkProtocolPort = {
			localPeerId: receiver,
			connectedPeers: () => [sender],
			close: () => scripted.close(),
			serve: (handler) => scripted.serve(handler),
			open: async (peer) => {
				const stream = await scripted.open(peer),
					frames: Uint8Array[] = [];
				let materialRequest = false;
				return {
					peerId: peer,
					abort: (reason) => stream.abort(reason),
					close: () => stream.close(),
					read: async (maximum, options) => {
						if (!materialRequest) return stream.read(maximum, options);
						options.signal.throwIfAborted();
						const frame = frames.shift();
						if (frame === undefined || frame.byteLength > maximum) throw new TypeError("R9_MATERIAL_FRAME_INVALID");
						return frame;
					},
					write: async (bytes, options) => {
						const request = decodeCanonical(bytes) as Record<string, unknown>;
						if (request.kind !== "creator-successor-material-request") return stream.write(bytes, options);
						materialRequest = true;
						const proof = { ...request };
						delete proof.signature;
						requestDigests.push(hashDomain("ts-drp/creator-successor-transport/v1", encodeCanonical(proof)));
						const inbound: SnapshotChunkProtocolStream = {
							peerId: receiver,
							abort: () => undefined,
							close: () => Promise.resolve(),
							read: () => Promise.reject(new TypeError("R9_MATERIAL_REREAD")),
							write: (frame) => {
								if (variant === "tampered") {
									const response = decodeCanonical(frame) as Record<string, unknown>;
									const history = new Uint8Array(response.exactCanonicalHistoryBytes as Uint8Array);
									history[0] = (history[0] ?? 0) ^ 1;
									frames.push(encodeCanonical({ ...response, exactCanonicalHistoryBytes: history }));
								} else frames.push(new Uint8Array(frame));
								return Promise.resolve();
							},
						};
						if (!(await server.control(inbound, bytes))) throw new TypeError("R9_SIGNED_MATERIAL_REFUSED");
					},
				};
			},
		};

		protocolPorts.add(port);
		return { offer: exported.offer, port, peers: [sender], requestDigests };
	} finally {
		await snapshotStore.close();
		await store.close();
	}
}

it.each(["same-target", "distinct-target"] as const)(
	"original recipient role activation authenticates next ACL and survives SQLite reopen (%s)",
	async (shape) => {
		const f = await fixture(shape);
		const creator = await f.open(),
			recipient = await f.open(false, 1);
		const nonWriterIndex = shape === "same-target" ? 0 : 1;
		expect(f.signing[nonWriterIndex]).toBe(0);
		expect(await f.ownRows(nonWriterIndex)).toEqual([]);
		const recipientAuthor = required(f.identities[1]).author;
		const granted = shape === "same-target" ? creator : recipient;
		const grantedAuthor = shape === "same-target" ? f.keychain.localAuthorId : recipientAuthor;
		const finalityTarget = f.keychain.localAuthorId;
		const initial = recipient.room.previewLatchedAcl().current;
		const before = { native: f.nativeImage(), signing: [...f.signing], publications: [...f.publications] };
		await expect(granted.room.issue(send("not-yet-writer"))).rejects.toThrow();
		// In this none-settlement profile causalJoin remains ordinary, reserved,
		// blueprint-folded work; opening an Admin must not grant it Writer.
		await expect(granted.room.issue({ action: "causalJoin" })).rejects.toThrow();
		await expect(
			granted.room.issue({
				action: "causalJoin",
				clientOperationId: "malformed-control-must-not-bypass-writer",
				text: "not a no-op control",
			})
		).rejects.toThrow();
		expect(f.nativeImage()).toEqual(before.native);
		expect(f.signing).toEqual(before.signing);
		expect(f.publications).toEqual(before.publications);
		await Promise.all([
			recipient.room.issue({ action: "acl", group: "writer", kind: "grant", target: grantedAuthor }),
			creator.room.issue({ action: "acl", group: "finality", kind: "revoke", target: finalityTarget }),
		]);
		const grantRows = await f.ownRows(1),
			revokeRows = await f.ownRows(0);
		const grant = required(grantRows.at(-1)),
			revoke = required(revokeRows.at(-1));
		const grantPreimage = decodeCanonical(grant.commit.envelope.canonicalPreimageBytes) as { dependencies: string[] };
		const revokePreimage = decodeCanonical(revoke.commit.envelope.canonicalPreimageBytes) as { dependencies: string[] };
		expect(grantPreimage.dependencies).not.toContain(hex(revoke.commit.envelope.digest));
		expect(revokePreimage.dependencies).not.toContain(hex(grant.commit.envelope.digest));
		await f.receiveRows(0, grantRows);
		await f.receiveRows(1, revokeRows);
		expect(recipient.room.previewLatchedAcl().current).toEqual(initial);
		await creator.room.issue({ action: "acl", group: "admin", kind: "revoke", target: recipientAuthor });
		await f.receiveRows(1, await f.ownRows(0));
		const expectedAcl = creator.room.previewLatchedAcl().next;
		expect(expectedAcl).toEqual({
			epoch: 1,
			kind: "drp-v3-latched-acl",
			members: [
				{ author: f.keychain.localAuthorId, finalityKey: null, groups: ["admin", "writer"] },
				{ author: recipientAuthor, finalityKey: null, groups: ["writer"] },
			].sort((left, right) => left.author.localeCompare(right.author)),
			objectId: f.objectId,
			permissionless: false,
			version: 1,
		});
		expect(creator.room.previewLatchedAcl().nextSigners).toEqual([]);
		expect(recipient.room.previewLatchedAcl().next).toEqual(expectedAcl);
		const sealed = await creator.room.sealEpoch();
		expect(sealed).toMatchObject({ ok: true, successorEpoch: 1 });
		await creator.room.adoptCreatorSuccessor();
		const delivery = await recipientSource(f, "shipping-chat", f.objectId, f.invite);
		// Reuse the genuine material/chunk port on the already-open recipient;
		// this does not recreate a session or copy a fixture database.
		f.transferPorts.set(1, delivery.port);
		const native = await f.host.openAhe("shipping-chat--ahe");
		const snapshot = await f.host.openSnapshots("shipping-chat");
		try {
			const object = parseStorageObjectId(f.objectId);
			if (!object.ok) throw new TypeError("invalid role fixture object");
			const exported = await readCreatorSuccessorExport({
				store: native,
				snapshotStore: snapshot,
				catalog: f.application.catalog,
				objectId: object.value,
				pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest,
				exactCanonicalGenesisAnchorPreimageBytes: f.invite.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: f.invite.detachedGenesisSignature,
			});
			const trust = decodeCanonical(exported.offer.exactCanonicalTrustStateRecordBytes) as Record<string, unknown>;
			expect(trust.currentEpoch).toBe(sealed.successorEpoch);
			expect(trust.exactCanonicalSignerSetBytes).toEqual(f.invite.exactCanonicalSignerSetBytes);
			expect(trust.exactCanonicalProfileBytes).toEqual(f.invite.exactCanonicalProfileBytes);
			expect(
				ed25519.verify(
					trust.detachedCurrentAnchorSignature as Uint8Array,
					Buffer.from(sealed.successorAnchorDigest, "hex"),
					Buffer.from(f.keychain.localAuthorId, "hex"),
					{ zip215: false }
				)
			).toBe(true);
			const qc = decodeCanonical(exported.offer.exactCanonicalCommitQcBytes) as Record<string, unknown>;
			expect(qc).toMatchObject({ epoch: sealed.epoch, objectId: f.objectId, phase: "commit" });
			const votes = qc.votes as { signerId: string; signature: string; voteDigest: string }[];
			expect(votes).toHaveLength(1);
			for (const vote of votes) {
				expect(vote.signerId).toBe("creator");
				const digest = hashDomain(
					"ts-drp/seal-vote/v3",
					encodeCanonical({
						epoch: qc.epoch,
						kind: "drp-seal-vote",
						objectId: qc.objectId,
						phase: qc.phase,
						proposalDigest: qc.proposalDigest,
						proposalHash: qc.proposalHash,
						round: qc.round,
						signerId: vote.signerId,
					})
				);
				expect(hex(digest)).toBe(vote.voteDigest);
				expect(
					ed25519.verify(Buffer.from(vote.signature, "hex"), digest, Buffer.from(f.keychain.localAuthorId, "hex"), {
						zip215: false,
					})
				).toBe(true);
			}
		} finally {
			await snapshot.close();
			await native.close();
		}
		if (shape === "same-target") {
			for (const variant of ["foreign", "tampered"] as const) {
				const refused = await recipientSource(f, "shipping-chat", f.objectId, f.invite, variant);
				f.transferPorts.set(1, refused.port);
				const before = f.nativeImage(),
					signatures = f.signing[1];
				await expect(
					recipient.room.installCreatorSuccessor({ offer: refused.offer, peers: refused.peers })
				).rejects.toThrow("creator successor material transport failed");
				expect(f.nativeImage()).toEqual(before);
				expect(refused.requestDigests).toHaveLength(1);
				expect(f.signing[1]).toBe((signatures ?? 0) + 1);
				expect(recipient.room.previewLatchedAcl().current).toEqual(initial);
				await refused.port.close();
				protocolPorts.delete(refused.port);
			}
			f.transferPorts.set(1, delivery.port);
		}
		await recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
		expect(recipient.room.previewLatchedAcl().current).toEqual(expectedAcl);
		expect(recipient.room.authority()?.aclDigest).toBe(
			hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(expectedAcl)))
		);
		const revoked = {
			native: f.nativeImage(),
			signing: [...f.signing],
			publications: [...f.publications],
			state: shippingChatCanonicalStateBytes(recipient.room.projection().messages),
		};
		await expect(
			recipient.room.issue({ action: "acl", group: "admin", kind: "grant", target: recipientAuthor })
		).rejects.toThrow();
		expect(f.nativeImage()).toEqual(revoked.native);
		expect(f.signing).toEqual(revoked.signing);
		expect(f.publications).toEqual(revoked.publications);
		expect(shippingChatCanonicalStateBytes(recipient.room.projection().messages)).toEqual(revoked.state);
		await recipient.room.issue(send("writer-after-recipient-activation"));
		expect(recipient.room.projection().messages).toHaveLength(1);
		await recipient.room.close();
		rooms.delete(recipient.room);
		await recipient.head.close();
		heads.delete(recipient.head);
		const reopened = await f.open(true, 1);
		expect(reopened.room.previewLatchedAcl().current).toEqual(expectedAcl);
		expect(reopened.room.projection().messages).toHaveLength(1);
		const reopenedRefusal = { native: f.nativeImage(), signing: [...f.signing], publications: [...f.publications] };
		await expect(
			reopened.room.issue({ action: "acl", group: "admin", kind: "grant", target: recipientAuthor })
		).rejects.toThrow();
		expect(f.nativeImage()).toEqual(reopenedRefusal.native);
		expect(f.signing).toEqual(reopenedRefusal.signing);
		expect(f.publications).toEqual(reopenedRefusal.publications);
		await reopened.room.issue(
			send("writer-after-recipient-reopen", "after authenticated native reopen", 1791662400002)
		);
		expect(
			reopened.room
				.projection()
				.messages.map(({ clientOperationId }) => clientOperationId)
				.sort()
		).toEqual(["writer-after-recipient-activation", "writer-after-recipient-reopen"]);
		await delivery.port.close();
	},
	120_000
);

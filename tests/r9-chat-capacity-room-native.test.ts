/* eslint-disable @typescript-eslint/explicit-function-return-type -- Existing fixture capability inference is preserved. */

import { ed25519 } from "@noble/curves/ed25519.js";
import { openTrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
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
	createShippingChatGenesisStateBytes,
	createShippingV3ChatApplication,
	type ShippingChatProjection,
} from "../examples/chat/src/v3-chat-application.js";
import {
	reallocateShippingChatCapacity,
	shippingChatCapacityStateBytes,
} from "../examples/chat/src/v3-chat-capacity.js";
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
import type {
	V3SettlementSourceSelectionApproval,
	V3SettlementSourceSelectionRequest,
} from "../packages/node/src/v3-live.js";
import { digestReceivedVertexPreimage, vertexCanonicalBytes } from "../packages/protocol-v3/src/index.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

const directories = new Set<string>();
const rooms = new Set<V3RoomSession<ShippingChatProjection>>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const keychains = new Set<Keychain>();
const protocolPorts = new Set<SnapshotChunkProtocolPort>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
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

async function fixture(
	roleShape?: "same-target" | "distinct-target" | "both-writers",
	governedTransform = false,
	governedProfile = governedTransform,
	interruptRefusal = false,
	observeAdmission = false
) {
	const catalogDirectory = process.env.SHIPPING_CHAT_CATALOG_DIR;
	if (catalogDirectory === undefined) throw new TypeError("SHIPPING_CHAT_CATALOG_DIR must name genuine nightly output");
	const catalog = openTrustedBlueprintCatalog({ catalogDirectory });
	const blueprintDigest = catalog.blueprintDigests[0];
	if (blueprintDigest === undefined || catalog.blueprintDigests.length !== 1)
		throw new TypeError("expected exact shipping Chat catalog");

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
	let failCreatorPublication = false;
	const ingress = new Map<number, (message: Message) => void>();
	const retainedIngress = new Map<number, (message: Message) => void>();
	const retainedMessages = new WeakSet<Message>();
	const ingressTopics = new Map<number, string>();
	const transferPorts = new Map<number, SnapshotChunkProtocolPort>();
	const accepted = enrolled.map(() => new Set<string>());
	const admissions: {
		index: number;
		operationBytes: string;
		author: string | undefined;
		kind: string;
		reason: string | undefined;
	}[] = [];
	let refusalInterrupted = false;
	let migrationTarget: V3RoomSession<ShippingChatProjection> | undefined;
	const objectId = `creator:${hex(hashDomain("shipping-chat-native-object/v2", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const signers = [{ publicKey: keychain.localAuthorId, signerId: "creator" }];
	const exactCanonicalLatchedAclBytes = encodeCanonical({
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
							groups: roleShape === "same-target" || roleShape === "both-writers" ? ["admin", "writer"] : ["admin"],
						},
					]),
		].sort((left, right) => left.author.localeCompare(right.author)),
		permissionless: false,
		version: governedProfile ? 3 : 1,
	});
	const ordinaryApplication = await createShippingV3ChatApplication({
		catalog,
		blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: exactCanonicalLatchedAclBytes,
	});
	const application = governedTransform
		? Object.freeze({
				...ordinaryApplication,
				displacementPolicies: Object.freeze({ message: "transform" as const }),
				transformDisplacedOperation(operation: Readonly<Record<string, unknown>>) {
					return Object.freeze({ ...operation, text: String(operation.text) + "x" });
				},
			})
		: ordinaryApplication;
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest,
		exactCanonicalApplicationStateBytes: createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes }),
		exactCanonicalLatchedAclBytes,
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
			profileId: governedProfile ? "creator-trusted-settlement-v1" : "creator-trusted-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => keychain.signWithLocalAuthor(digest),
	});
	const open = async (
		reopen = false,
		index = 0,
		protocol?: SnapshotChunkProtocolPort,
		authorizeSettlementSource?: (
			request: Readonly<{ exactCanonicalSelectionBytes: Uint8Array; digest: Uint8Array }>
		) => Promise<Uint8Array>,
		approveSettlementSourceSelection?: (request: V3SettlementSourceSelectionApproval) => Promise<boolean>
	) => {
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
			return Promise.resolve(index !== 0 || !failCreatorPublication);
		});
		Reflect.set(networkNode, "gossipTopicFor", (message: Message) =>
			retainedMessages.has(message) ? undefined : message.objectId
		);
		if (protocol !== undefined) transferPorts.set(index, protocol);
		if (roleShape !== undefined && index === 1)
			Reflect.set(networkNode, "createSnapshotChunkProtocolHost", () => required(transferPorts.get(index)));
		const normalHost = createNodeV3RoomStorageHost({ directory, initialization: () => (reopen ? "reopen" : "create") });
		const room = await createV3RoomSession({
			application,
			onMigrationTarget: (target) => {
				migrationTarget = target;
				rooms.add(target);
			},
			storageHost: normalHost,
			author: owner.localAuthorId,
			creatorInvite: invite,
			...(authorizeSettlementSource === undefined ? {} : { authorizeSettlementSource }),
			...(approveSettlementSourceSelection === undefined ? {} : { approveSettlementSourceSelection }),
			...(index === 0 ? { creatorFinalitySigner: await keychain.acquireLocalAuthorFinalitySigner() } : {}),
			createOperationAdmissionPolicy: observeAdmission
				? (context) => {
						const policy = application.createOperationAdmissionPolicy(context);
						return Object.freeze({
							reserve(
								operation: Parameters<typeof policy.reserve>[0],
								authenticated: Parameters<typeof policy.reserve>[1]
							) {
								const reservation = policy.reserve(operation, authenticated);
								admissions.push({
									index,
									operationBytes: hex(encodeCanonical(operation)),
									author: authenticated?.author,
									kind: reservation.kind,
									reason: reservation.kind === "rejected" ? reservation.reason : undefined,
								});
								// Observation only: the owning policy's exact reservation and
								// commit/release behavior remain unchanged.
								return reservation;
							},
						});
					}
				: application.createOperationAdmissionPolicy,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: Uint8Array.from(Buffer.from(owner.localAuthorId, "hex")),
			roomHeadAuthority: head,
			signRegisteredVertexDigest: async (digest) => {
				if (interruptRefusal && index === 1 && !refusalInterrupted) {
					const observation = await createNodeV3RoomStorageHost({
						directory,
						initialization: () => "reopen",
					}).openIssuance(name);
					try {
						const plan = await observation.readSettlementPlan({ author: owner.localAuthorId, objectId });
						if (plan?.fenceSequence === null && plan.entries.some((row) => row.transformRefusal !== undefined)) {
							refusalInterrupted = true;
							throw new TypeError("CHAT_TEST_INTERRUPTED_AFTER_DURABLE_REFUSAL");
						}
					} finally {
						await observation.close();
					}
				}
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
				setIngressHandler: (topic, handler, retainedHandler) => {
					ingress.set(index, handler);
					if (retainedHandler !== undefined) retainedIngress.set(index, retainedHandler);
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
	const deliverEnvelope = (index: number, canonicalPreimage: Uint8Array, signature: Uint8Array, retained = false) => {
		const handler = (retained ? retainedIngress : ingress).get(index);
		if (handler === undefined) throw new TypeError("missing genuine native Chat ingress");
		const message = Message.create({
			data: V3Envelope.encode({
				canonicalPreimage,
				signature,
			}).finish(),
			objectId: required(ingressTopics.get(index)),
			sender: index === 0 ? "r9-grid-peer-1" : "r9-grid-peer-0",
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		});
		if (retained) retainedMessages.add(message);
		handler(message);
	};
	const receiveRows = async (index: number, rows: Awaited<ReturnType<typeof ownRows>>, retained = false) => {
		for (const row of rows)
			deliverEnvelope(index, row.commit.envelope.canonicalPreimageBytes, row.commit.envelope.signature, retained);
		await vi.waitFor(
			() => {
				for (const row of rows) {
					const operation = (
						decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: Record<string, unknown> }
					).operation;
					// v1 causalJoin is authenticated protocol control, not an app notification.
					if (governedProfile && (operation.action === "causalJoin" || operation.action === "$drp.author-fence.v1"))
						continue;
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
				}
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
		blueprintDigest,
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
		setCreatorPublicationFailure: (value: boolean) => {
			failCreatorPublication = value;
		},
		objectId,
		ownRows,
		ingressTopic: (index: number) => ingressTopics.get(index),
		receiveRows,
		deliverEnvelope,
		admissions,
		accepted,
		nativeImage,
		transferPorts,
		wasRefusalInterrupted: () => refusalInterrupted,
		migrationTarget: () => migrationTarget,
	};
}

function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("CHAT_CAPACITY_FIXTURE_REQUIRED");
	return value;
}
type NativeChatFixture = Awaited<ReturnType<typeof fixture>>;
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

it.each([
	["direct", "text"],
	["direct", "metadata"],
	["batch", "text"],
	["batch", "metadata"],
] as const)(
	"native remote current-Writer %s %s exact+1 capacity refuses before effects and continues after reopen",
	async (shape, component) => {
		const f = await fixture("both-writers", false, true, false, true);
		let creator = await f.open();
		const recipient = await f.open(false, 1);
		await f.receiveRows(1, await f.ownRows(0));
		const recipientBootstrap = await f.ownRows(1);
		await f.receiveRows(0, recipientBootstrap);
		const writer = required(f.enrolled[1]),
			author = writer.localAuthorId,
			ceiling = required(creator.room.projection().capacity.allocations.find((row) => row[0] === author))[1];
		if (shape === "batch")
			await Promise.all([
				recipient.room.issue(send("remote-prefix", "small first message")),
				recipient.room.issue(send("remote-final", "valid same-sequence continuation")),
			]);
		else await recipient.room.issue(send("remote-final", "valid same-sequence continuation"));
		const bootstrapDigests = new Set(recipientBootstrap.map((row) => hex(row.commit.envelope.digest)));
		const rows = (await f.ownRows(1)).filter((row) => !bootstrapDigests.has(hex(row.commit.envelope.digest)));
		expect(rows).toHaveLength(1);
		const exemplar = required(rows[0]),
			preimage = decodeCanonical(exemplar.commit.envelope.canonicalPreimageBytes) as Record<string, unknown>,
			operation = preimage.operation as Record<string, unknown>;
		expect(operation.action).toBe(shape === "batch" ? "applicationBatch" : "message");
		const batch = operation.batch as
			| { version: number; entries: { logicalTime: number; operation: Record<string, unknown> }[] }
			| undefined;
		const intents = shape === "batch" ? required(batch).entries.map((entry) => entry.operation) : [operation];
		const last = required(intents.at(-1));
		const recordBytes = (intent: Readonly<Record<string, unknown>>) =>
			encodeCanonical({
				author,
				clientOperationId: intent.clientOperationId,
				displayTimeMs: intent.displayTimeMs,
				text: intent.text,
			}).byteLength;
		const prefixCharge = intents.slice(0, -1).reduce((total, intent) => total + recordBytes(intent), 0);
		let text = "x";
		while (prefixCharge + recordBytes({ ...last, text }) < ceiling) text += "x";
		const exact = { ...last, text };
		expect(prefixCharge + recordBytes(exact)).toBe(ceiling);
		const oversized =
			component === "text"
				? { ...exact, text: text + "x" }
				: { ...exact, clientOperationId: String(exact.clientOperationId) + "x" };
		expect(prefixCharge + recordBytes(oversized)).toBe(ceiling + 1);
		const candidateOperation =
			shape === "batch"
				? {
						...operation,
						batch: {
							...required(batch),
							entries: required(batch).entries.map((entry, index) => ({
								...entry,
								operation: index === intents.length - 1 ? oversized : entry.operation,
							})),
						},
					}
				: oversized;
		expect(encodeCanonical(candidateOperation).byteLength).toBeLessThan(65_536);
		// Only the operation differs from a genuine native-issued current-context
		// preimage. The installed registry and enrolled Writer sign the exact bytes.
		const candidateBytes = vertexCanonicalBytes({ ...preimage, operation: candidateOperation }),
			digest = digestReceivedVertexPreimage(candidateBytes),
			signature = await writer.signWithLocalAuthor(digest);
		expect(ed25519.verify(signature, digest, Uint8Array.from(Buffer.from(author, "hex")))).toBe(true);
		const beforeImage = f.nativeImage(),
			beforeMessages = creator.room.projection().messages,
			beforeSink = [...required(f.accepted[0])],
			beforeOrdinal = await f.nextOrdinal();
		f.deliverEnvelope(0, candidateBytes, signature);
		await vi.waitFor(
			() => {
				expect(f.admissions).toContainEqual({
					index: 0,
					operationBytes: hex(encodeCanonical(candidateOperation)),
					author,
					kind: "rejected",
					reason: "capacity",
				});
			},
			{ timeout: 15_000 }
		);
		expect(f.nativeImage()).toEqual(beforeImage);
		expect(creator.room.projection().messages).toEqual(beforeMessages);
		expect([...required(f.accepted[0])]).toEqual(beforeSink);
		expect(required(f.accepted[0]).has(hex(digest))).toBe(false);
		expect(await f.nextOrdinal()).toBe(beforeOrdinal);
		// Refusal does not consume the sender sequence: its original valid native
		// exemplar must still authenticate and commit at that same sequence.
		await f.receiveRows(0, rows);
		expect(creator.room.projection().messages).toEqual(recipient.room.projection().messages);
		expect(creator.room.projection().messages).toHaveLength(shape === "batch" ? 2 : 1);
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		await creator.room.close();
		rooms.delete(creator.room);
		await creator.head.close();
		heads.delete(creator.head);
		creator = await f.open(true);
		expect(creator.room.projection().messages).toEqual(recipient.room.projection().messages);
		await creator.room.issue(send("remote-refusal-continued", "new valid issue after persisted reopen"));
		expect(creator.room.projection().messages).toHaveLength(shape === "batch" ? 3 : 2);
	},
	60_000
);

it("native concurrent full-entitlement Writers converge in opposite order and retain exact retries after rollover/reopen", async () => {
	const f = await fixture("both-writers", false, true, false, true);
	let creator = await f.open();
	let recipient = await f.open(false, 1);
	await f.receiveRows(1, await f.ownRows(0));
	await f.receiveRows(0, await f.ownRows(1));
	const peers = [creator, recipient],
		bootstrapDigests = new Set(
			(await Promise.all([f.ownRows(0), f.ownRows(1)])).flat().map((row) => hex(row.commit.envelope.digest))
		);
	const commands = f.enrolled.map((writer, index) => {
		const author = writer.localAuthorId,
			ceiling = required(creator.room.projection().capacity.allocations.find((row) => row[0] === author))[1],
			id = "full-writer-" + index,
			time = 1791662400000;
		let text = "x";
		while (encodeCanonical({ author, clientOperationId: id, displayTimeMs: time, text }).byteLength < ceiling)
			text += "x";
		expect(encodeCanonical({ author, clientOperationId: id, displayTimeMs: time, text }).byteLength).toBe(ceiling);
		return send(id, text, time);
	});
	// Independently accepted native work, before either peer receives the other's
	// message. Neither admission can depend on the remote arrival order.
	await Promise.all(peers.map((peer, index) => peer.room.issue(required(commands[index]))));
	const rows = (await Promise.all([f.ownRows(0), f.ownRows(1)]))
		.flat()
		.filter((row) => !bootstrapDigests.has(hex(row.commit.envelope.digest)));
	expect(rows).toHaveLength(2);
	await f.receiveRows(0, [required(rows[1]), required(rows[0])]);
	await f.receiveRows(1, [required(rows[0]), required(rows[1])]);
	const fullState = required(f.application.migration).canonicalStateBytes(creator.room.projection());
	expect(required(f.application.migration).canonicalStateBytes(recipient.room.projection())).toEqual(fullState);
	expect(fullState.byteLength).toBeLessThanOrEqual(32_768);
	expect(creator.room.projection().messages).toHaveLength(2);
	expect(creator.room.projection().capacity).toEqual(recipient.room.projection().capacity);
	for (const [author, ceiling] of creator.room.projection().capacity.allocations)
		expect(
			creator.room
				.projection()
				.messages.filter((message) => message.author === author)
				.reduce((sum, message) => sum + encodeCanonical(message).byteLength, 0)
		).toBe(ceiling);
	const ordinal = async (index: number) => {
		const store = await f.host.openIssuance(index === 0 ? "shipping-chat" : "shipping-chat-recipient");
		try {
			return (await store.readLineage({ author: required(f.enrolled[index]).localAuthorId, objectId: f.objectId }))
				.next;
		} finally {
			await store.close();
		}
	};
	const beforeOrdinals = await Promise.all([ordinal(0), ordinal(1)]),
		beforeImage = f.nativeImage(),
		extras = [send("small-extra-0", "x"), send("small-extra-1", "x")];
	const refused = await Promise.allSettled(peers.map((peer, index) => peer.room.issue(required(extras[index]))));
	expect(refused.map((result) => result.status)).toEqual(["rejected", "rejected"]);
	for (let index = 0; index < peers.length; index++)
		expect(f.admissions).toContainEqual({
			index,
			operationBytes: hex(encodeCanonical(required(extras[index]))),
			author: required(f.enrolled[index]).localAuthorId,
			kind: "rejected",
			reason: "capacity",
		});
	expect(await Promise.all([ordinal(0), ordinal(1)])).toEqual(beforeOrdinals);
	expect(f.nativeImage()).toEqual(beforeImage);
	expect(required(f.application.migration).canonicalStateBytes(creator.room.projection())).toEqual(fullState);
	expect(required(f.application.migration).canonicalStateBytes(recipient.room.projection())).toEqual(fullState);
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const delivery = await recipientSource(f, "shipping-chat", f.objectId, f.invite);
	f.transferPorts.set(1, delivery.port);
	await recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
	for (const peer of [creator, recipient]) {
		expect(required(f.application.migration).canonicalStateBytes(peer.room.projection())).toEqual(fullState);
		await peer.room.close();
		rooms.delete(peer.room);
		await peer.head.close();
		heads.delete(peer.head);
	}
	creator = await f.open(true);
	recipient = await f.open(true, 1, delivery.port);
	const reopenedOrdinals = await Promise.all([ordinal(0), ordinal(1)]);
	// Full lifetime entitlements do not refresh. Exact immutable retries remain
	// valid fresh native calls without allocating another retained message.
	await Promise.all([creator.room.issue(required(commands[0])), recipient.room.issue(required(commands[1]))]);
	expect(await Promise.all([ordinal(0), ordinal(1)])).toEqual(reopenedOrdinals.map((value) => value + 1));
	await f.receiveRows(0, await f.ownRows(1));
	await f.receiveRows(1, await f.ownRows(0));
	expect(required(f.application.migration).canonicalStateBytes(creator.room.projection())).toEqual(fullState);
	expect(required(f.application.migration).canonicalStateBytes(recipient.room.projection())).toEqual(fullState);
}, 60_000);

it.each([false, true])(
	"native none-profile pending bootstrap publishes before seal and continues after reopen (publication-failure=%s)",
	async (publicationFailure) => {
		const f = await fixture("both-writers");
		let creator = await f.open();
		const recipient = await f.open(false, 1);
		await f.receiveRows(1, await f.ownRows(0));
		await f.receiveRows(0, await f.ownRows(1));
		await recipient.room.issue(send("none-remote-gameplay", "valid gameplay without creator local issue"));
		await f.receiveRows(0, await f.ownRows(1));
		const bootstrap = required((await f.ownRows(0))[0]);
		expect(bootstrap.commit.authorSequence).toBe(0);
		expect(bootstrap.publishState).toBe("pending");
		expect(f.publications[0]).toBe(0);
		const originalMessages = creator.room.projection().messages;
		if (publicationFailure) {
			const beforeImage = f.nativeImage(),
				beforeStatus = creator.room.status(),
				beforeOrdinal = await f.nextOrdinal();
			f.setCreatorPublicationFailure(true);
			await expect(creator.room.sealEpoch()).rejects.toThrow("v3 room publication failed: publish-failed");
			expect(f.nativeImage()).toEqual(beforeImage);
			expect(creator.room.status()).toEqual(beforeStatus);
			expect(await f.nextOrdinal()).toBe(beforeOrdinal);
			expect(required((await f.ownRows(0))[0]).publishState).toBe("pending");
			expect(creator.room.projection().messages).toEqual(originalMessages);
			f.setCreatorPublicationFailure(false);
		}
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		expect(f.publications[0]).toBe(publicationFailure ? 2 : 1);
		expect(required((await f.ownRows(0))[0]).publishState).toBe("published");
		await creator.room.adoptCreatorSuccessor();
		await creator.room.close();
		rooms.delete(creator.room);
		await creator.head.close();
		heads.delete(creator.head);
		creator = await f.open(true);
		expect(creator.room.projection().messages).toEqual(originalMessages);
		await creator.room.issue(send("remote-refusal-continued", "new valid issue after persisted reopen"));
		expect(creator.room.projection().messages).toHaveLength(originalMessages.length + 1);
		expect(creator.room.projection().messages).toEqual(expect.arrayContaining(originalMessages));
	},
	60_000
);

it("native pending application publication debt still seals and settles after bootstrap-only publication guard", async () => {
	const f = await fixture(undefined, false, true);
	let creator = await f.open();
	expect(required((await f.ownRows(0))[0]).publishState).toBe("published");
	f.setCreatorPublicationFailure(true);
	await expect(
		creator.room.issue(send("pending-app-source", "accepted source must remain recoverable"))
	).rejects.toThrow("v3 room publication failed: publish-failed");
	const source = required(
		(await f.ownRows(0)).find((row) => {
			const preimage = decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as {
				operation: Record<string, unknown>;
			};
			return preimage.operation.clientOperationId === "pending-app-source";
		})
	);
	expect(source.publishState).toBe("pending");
	const beforePublications = f.publications[0];
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	expect(f.publications[0]).toBe(beforePublications);
	expect(
		required((await f.ownRows(0)).find((row) => row.commit.authorSequence === source.commit.authorSequence))
			.publishState
	).toBe("pending");
	f.setCreatorPublicationFailure(false);
	await creator.room.adoptCreatorSuccessor();
	expect(creator.room.projection().messages).toHaveLength(1);
	expect(creator.room.projection().messages[0]?.clientOperationId).toBe("pending-app-source");
	const store = await f.host.openIssuance("shipping-chat");
	try {
		const plan = await store.readSettlementPlan({ author: f.keychain.localAuthorId, objectId: f.objectId });
		expect(plan?.fenceSequence).not.toBeNull();
		// The authenticated terminal frontier already inherited this exact effect;
		// pending publication remains truthful debt, not a new replacement intent.
		expect(plan?.entries.find((row) => row.sourceSequence === source.commit.authorSequence)).toBeUndefined();
		const retained = required(
			await store.readIssued({ author: f.keychain.localAuthorId, objectId: f.objectId }, source.commit.authorSequence)
		);
		expect(retained.envelope.digest).toEqual(source.commit.envelope.digest);
		expect(
			required((await f.ownRows(0)).find((row) => row.commit.authorSequence === source.commit.authorSequence))
				.publishState
		).toBe("pending");
	} finally {
		await store.close();
	}
	await creator.room.close();
	rooms.delete(creator.room);
	await creator.head.close();
	heads.delete(creator.head);
	creator = await f.open(true);
	await creator.room.issue(send("pending-app-source", "accepted source must remain recoverable"));
	await creator.room.issue(send("pending-app-continued", "new issue after native accounting and reopen"));
	expect(creator.room.projection().messages).toHaveLength(2);
}, 60_000);

it("native Chat lifetime entitlement refuses exact+1 bytes without consuming source and survives rollover/reopen", async () => {
	const f = await fixture();
	let { room, head } = await f.open();
	const author = f.keychain.localAuthorId;
	const allocation = required(room.projection().capacity.allocations.find((row) => row[0] === author));
	const id = "exact-capacity",
		time = 1791662400000;
	let text = "x";
	while (encodeCanonical({ author, clientOperationId: id, displayTimeMs: time, text }).byteLength < allocation[1])
		text += "x";
	expect(encodeCanonical({ author, clientOperationId: id, displayTimeMs: time, text }).byteLength).toBe(allocation[1]);
	const initial = await f.nextOrdinal();
	await expect(room.issue(send(id, text + "x", time))).rejects.toThrow();
	expect(await f.nextOrdinal()).toBe(initial);
	expect(encodeCanonical({ author, clientOperationId: id + "x", displayTimeMs: time, text }).byteLength).toBe(
		allocation[1] + 1
	);
	await expect(room.issue(send(id + "x", text, time))).rejects.toThrow();
	expect(await f.nextOrdinal()).toBe(initial);
	await room.issue(send(id, text, time));
	expect(await f.nextOrdinal()).toBe(initial + 1);
	await room.issue(send(id, text, time));
	expect(await f.nextOrdinal()).toBe(initial + 2);
	await expect(room.issue(send("new-id", "x"))).rejects.toThrow();
	expect(await f.nextOrdinal()).toBe(initial + 2);
	expect(room.projection().messages).toEqual([{ author, clientOperationId: id, displayTimeMs: time, text }]);
	expect((await room.sealEpoch()).ok).toBe(true);
	await room.adoptCreatorSuccessor();
	expect(room.projection().capacity.allocations).toContainEqual(allocation);
	await room.close();
	rooms.delete(room);
	await head.close();
	heads.delete(head);
	({ room, head } = await f.open(true));
	expect(room.projection().messages).toEqual([{ author, clientOperationId: id, displayTimeMs: time, text }]);
	const reopened = await f.nextOrdinal();
	await room.issue(send(id, text, time));
	expect(await f.nextOrdinal()).toBe(reopened + 1);
	await expect(room.issue(send("new-id", "x"))).rejects.toThrow();
	expect(await f.nextOrdinal()).toBe(reopened + 1);
}, 60_000);

it("native independently accepted Writers converge in opposite order within disjoint full-byte entitlements", async () => {
	const f = await fixture("both-writers");
	const creator = await f.open();
	const recipient = await f.open(false, 1);
	await f.receiveRows(1, await f.ownRows(0));
	await creator.room.issue(send("alice-1", "creator-independent"));
	await recipient.room.issue(send("bob-1", "recipient-independent"));
	await creator.room.issue(send("alice-2", "creator-second"));
	await recipient.room.issue(send("bob-2", "recipient-second"));
	await f.receiveRows(1, await f.ownRows(0));
	await f.receiveRows(0, await f.ownRows(1));
	expect(creator.room.projection().messages).toEqual(recipient.room.projection().messages);
	expect(creator.room.projection().messages).toHaveLength(4);
	expect(creator.room.projection().capacity).toEqual(recipient.room.projection().capacity);
	expect(creator.room.projection().messages.map((m) => m.author)).toContain(f.enrolled[1]?.localAuthorId);
}, 60_000);

it("native batch capacity refusal has no partial effect and accepted identities survive two healthy rollovers", async () => {
	const f = await fixture();
	let { room, head } = await f.open();
	const initial = await f.nextOrdinal();
	const refused = await Promise.allSettled([
		room.issue(send("oversize-a", "x".repeat(18_000))),
		room.issue(send("oversize-b", "y".repeat(18_000))),
	]);
	expect(refused.map((row) => row.status)).toEqual(["rejected", "rejected"]);
	expect(await f.nextOrdinal()).toBe(initial);
	expect(room.projection().messages).toHaveLength(0);
	await Promise.all([room.issue(send("continued-a", "one")), room.issue(send("continued-b", "two"))]);
	const original = room.projection().messages;
	expect(original).toHaveLength(2);
	const capacity = room.projection().capacity;
	for (let epoch = 0; epoch < 2; epoch++) {
		expect((await room.sealEpoch()).ok).toBe(true);
		await room.adoptCreatorSuccessor();
		expect(room.projection().capacity).toEqual(capacity);
		expect(room.projection().messages).toEqual(original);
		await room.issue(send("continued-a", "one"));
	}
	await room.close();
	rooms.delete(room);
	await head.close();
	heads.delete(head);
	({ room, head } = await f.open(true));
	await room.issue(send("continued-c", "new after second reopen"));
	expect(room.projection().messages).toHaveLength(3);
	expect(room.projection().capacity).toEqual(capacity);
}, 60_000);

it("native enrolled Admin dormant entitlement activates only after authenticated Writer grant and never refreshes", async () => {
	const f = await fixture("distinct-target");
	const creator = await f.open();
	let recipient = await f.open(false, 1);
	await f.receiveRows(1, await f.ownRows(0));
	const author = required(f.enrolled[1]).localAuthorId;
	const allocation = required(creator.room.projection().capacity.allocations.find((row) => row[0] === author));
	expect(allocation[1]).toBeGreaterThan(0);
	await expect(recipient.room.issue(send("before-grant"))).rejects.toThrow();
	expect(await f.ownRows(1)).toEqual([]);
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: author });
	await f.receiveRows(1, await f.ownRows(0));
	await expect(recipient.room.issue(send("still-not-latched"))).rejects.toThrow();
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const delivery = await recipientSource(f, "shipping-chat", f.objectId, f.invite);
	f.transferPorts.set(1, delivery.port);
	const ahe = await f.host.openAhe("shipping-chat--ahe"),
		snapshots = await f.host.openSnapshots("shipping-chat");
	try {
		const exported = await readCreatorSuccessorExport({
			store: ahe,
			snapshotStore: snapshots,
			catalog: f.application.catalog,
			objectId: required(parseStorageObjectId(f.objectId).ok ? parseStorageObjectId(f.objectId).value : undefined),
			pinnedGenesisAnchorDigest: f.invite.pinnedGenesisAnchorDigest,
			exactCanonicalGenesisAnchorPreimageBytes: f.invite.exactCanonicalGenesisAnchorPreimageBytes,
			detachedGenesisSignature: f.invite.detachedGenesisSignature,
		});
		await recipient.room.installCreatorSuccessor({ offer: exported.offer, peers: ["r9-grid-peer-0"] });
	} finally {
		await ahe.close();
		await snapshots.close();
	}
	expect(recipient.room.projection().capacity.allocations).toContainEqual(allocation);
	await recipient.room.issue(send("after-grant", "authorized dormant share"));
	await recipient.room.close();
	rooms.delete(recipient.room);
	await recipient.head.close();
	heads.delete(recipient.head);
	recipient = await f.open(true, 1, delivery.port);
	expect(recipient.room.projection().messages.some((row) => row.clientOperationId === "after-grant")).toBe(true);
	await recipient.room.issue(send("continued-after-reopen", "same finite share"));
	expect(recipient.room.projection().capacity.allocations).toContainEqual(allocation);
}, 60_000);

it.each([false, true])(
	"native capacity-refused oversized transform retains accepted source and terminates accounting (interrupted=%s)",
	async (interrupted) => {
		const f = await fixture("both-writers", true, true, interrupted);
		const creator = await f.open();
		let recipient = await f.open(false, 1);
		const author = required(f.enrolled[1]).localAuthorId;
		const allocation = required(recipient.room.projection().capacity.allocations.find((row) => row[0] === author));
		const id = "reserved-source",
			time = 1791662400000;
		let low = 0,
			high = 32768;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (
				encodeCanonical({ author, clientOperationId: id, displayTimeMs: time, text: "x".repeat(middle) }).byteLength <=
				allocation[1]
			)
				low = middle;
			else high = middle - 1;
		}
		const text = "x".repeat(low);
		expect(encodeCanonical({ author, clientOperationId: id, displayTimeMs: time, text }).byteLength).toBe(
			allocation[1]
		);
		await recipient.room.issue(send(id, text, time));
		expect(recipient.room.projection().messages).toHaveLength(1);
		// Creator intentionally has not observed the accepted source: native old source
		// stays protected at the recipient and cannot be erased by this healthy close.
		expect(creator.room.projection().messages).toHaveLength(0);
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		const delivery = await recipientSource(f, "shipping-chat", f.objectId, f.invite);
		f.transferPorts.set(1, delivery.port);
		if (interrupted) {
			await expect(
				recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers })
			).rejects.toThrow("issuance-rejected");
			expect(f.wasRefusalInterrupted()).toBe(true);
			const pending = await f.host.openIssuance("shipping-chat-recipient");
			try {
				const plan = await pending.readSettlementPlan({ author, objectId: f.objectId });
				expect(plan?.fenceSequence).toBe(null);
				const entry = required(plan?.entries.find((row) => row.transformRefusal !== undefined));
				expect(entry.replacementSequence).toBe(null);
				expect(entry.transformRefusal?.reason).toBe("capacity");
			} finally {
				await pending.close();
			}
			await recipient.room.close();
			rooms.delete(recipient.room);
			await recipient.head.close();
			heads.delete(recipient.head);
			recipient = await f.open(true, 1, delivery.port);
		} else await recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
		expect(recipient.room.projection().messages).toEqual([
			{ author, clientOperationId: id, displayTimeMs: time, text },
		]);
		const store = await f.host.openIssuance("shipping-chat-recipient");
		try {
			const plan = await store.readSettlementPlan({ author, objectId: f.objectId });
			const entry = required(plan?.entries.find((row) => row.disposition === "transform"));
			expect(entry.transformRefusal).toMatchObject({ version: 1, kind: "admission-refused", reason: "capacity" });
			expect(entry.replacementSequence).not.toBe(null);
			expect(plan?.fenceSequence).not.toBe(null);
			const stable = required(plan),
				refusal = required(entry.transformRefusal),
				scope = { author, objectId: f.objectId };
			for (const changed of [
				{ ...refusal, reason: "encoding" as const },
				{ ...refusal, proposedIntentDigest: new Uint8Array(32).fill(0x91) },
			]) {
				await expect(
					store.transactWriteSettlementPlan({
						expectedRevision: stable.revision,
						scope,
						plan: {
							...stable,
							revision: stable.revision + 1,
							entries: stable.entries.map((row) =>
								row.sourceSequence === entry.sourceSequence ? { ...row, transformRefusal: changed } : row
							),
						},
					})
				).rejects.toThrow();
			}
			await expect(
				store.transactWriteSettlementPlan({
					expectedRevision: stable.revision,
					scope,
					plan: {
						...stable,
						revision: stable.revision + 1,
						entries: stable.entries.map((row) => {
							if (row.sourceSequence !== entry.sourceSequence) return row;
							const { transformRefusal: _refusal, ...retained } = row;
							return retained;
						}),
					},
				})
			).rejects.toThrow();
			expect(await store.readSettlementPlan(scope)).toEqual(stable);
		} finally {
			await store.close();
		}
		await recipient.room.close();
		rooms.delete(recipient.room);
		await recipient.head.close();
		heads.delete(recipient.head);
		recipient = await f.open(true, 1, delivery.port);
		expect(recipient.room.projection().messages).toEqual([
			{ author, clientOperationId: id, displayTimeMs: time, text },
		]);
		await recipient.room.issue(send(id, text, time));
		await expect(recipient.room.issue(send("new-capacity", "x"))).rejects.toThrow();
		await creator.room.issue(send("creator-continues", "independent author entitlement"));
	},
	90_000
);

it("native creator-selected unpublished former Writer Chat fallback joins recipient replay and nested continuation", async () => {
	const f = await fixture("both-writers", true, true);
	const approvals: V3SettlementSourceSelectionApproval[] = [];
	let blockApproval = false;
	let approvalEntered!: () => void;
	const pendingApproval = new Promise<void>((resolve) => {
		approvalEntered = resolve;
	});
	let cancelledApproval = false;
	let creator = await f.open(false, 0, undefined, undefined, async (request) => {
		approvals.push(request);
		expect(request.cancellationSignal.aborted).toBe(false);
		if (blockApproval)
			return new Promise<boolean>((resolve) => {
				const cancel = () => {
					cancelledApproval = true;
					resolve(false);
				};
				request.cancellationSignal.addEventListener("abort", cancel, { once: true });
				if (request.cancellationSignal.aborted) cancel();
				approvalEntered();
			});
		return true;
	});
	let recipient = await f.open(false, 1);
	const author = required(f.enrolled[1]).localAuthorId;
	const allocation = required(recipient.room.projection().capacity.allocations.find((row) => row[0] === author));
	const id = "portable-original-source",
		time = 1791662400000;
	let low = 0,
		high = 32768;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (
			encodeCanonical({ author, clientOperationId: id, displayTimeMs: time, text: "x".repeat(middle) }).byteLength <=
			allocation[1]
		)
			low = middle;
		else high = middle - 1;
	}
	const text = "x".repeat(low);
	await recipient.room.issue(send(id, text, time));
	const initialRows = await f.ownRows(1),
		original = required(
			initialRows.find(
				(row) =>
					(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: { action: string } }).operation
						.action === "message"
			)
		);
	expect(creator.room.projection().messages).toHaveLength(0);
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const delivery = await recipientSource(f, "shipping-chat", f.objectId, f.invite);
	f.transferPorts.set(1, delivery.port);
	await recipient.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
	const readPlan = async () => {
		const store = await f.host.openIssuance("shipping-chat-recipient");
		try {
			return await store.readSettlementPlan({ author, objectId: f.objectId });
		} finally {
			await store.close();
		}
	};
	const held = required(await readPlan()),
		heldEntry = required(held.entries.find((row) => row.sourceSequence === original.commit.authorSequence));
	expect(held.fenceSequence).toBe(null);
	expect(heldEntry.replacementSequence).toBe(null);
	const before = await f.ownRows(1);
	await expect(recipient.room.issue(send("refused-new", "not a Writer"))).rejects.toThrow();
	expect(await f.ownRows(1)).toEqual(before);
	await recipient.room.close();
	rooms.delete(recipient.room);
	await recipient.head.close();
	heads.delete(recipient.head);
	const selections: Uint8Array[] = [];
	recipient = await f.open(true, 1, delivery.port, async (request) => {
		selections.push(new Uint8Array(request.exactCanonicalSelectionBytes));
		const beforeApproval = approvals.length;
		const image = f.nativeImage();
		const wrongDigest = new Uint8Array(request.digest);
		wrongDigest[0] ^= 1;
		await expect(
			creator.room.authorizeSettlementSourceSelection({ ...request, digest: wrongDigest })
		).rejects.toThrow();
		expect(approvals).toHaveLength(beforeApproval);
		expect(f.nativeImage()).toEqual(image);
		return creator.room.authorizeSettlementSourceSelection(request);
	});
	const selectedPlan = required(await readPlan()),
		selected = required(selectedPlan.entries.find((row) => row.sourceSequence === original.commit.authorSequence));
	expect(selected.transformRefusal).toMatchObject({ kind: "admission-refused", reason: "capacity" });
	expect(selected.replacementSequence).not.toBe(null);
	expect(selections).toHaveLength(1);
	expect(approvals).toHaveLength(1);
	expect(approvals[0]?.preview).toMatchObject({
		sourceObjectId: f.objectId,
		sourceAuthor: author,
		sourceSequence: original.commit.authorSequence,
		sourceDigest: hex(original.commit.envelope.digest),
		targetObjectId: f.objectId,
		targetEpoch: 1,
	});
	const sourceProof = decodeCanonical(required(selections[0])) as {
		sourceDigest: string;
		sourceObjectId: string;
		targetObjectId: string;
	};
	expect(sourceProof.sourceDigest).toBe(hex(original.commit.envelope.digest));
	expect(sourceProof.sourceObjectId).toBe(f.objectId);
	expect(sourceProof.targetObjectId).toBe(f.objectId);
	expect(recipient.room.projection().messages).toEqual([{ author, clientOperationId: id, displayTimeMs: time, text }]);
	// The creator has still not observed the first replacement. A second genuine
	// close displaces it: original linked progress must survive while that exact
	// replacement becomes the next bounded native source.
	expect(creator.room.projection().messages).toHaveLength(0);
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const secondDelivery = await recipientSource(f, "shipping-chat", f.objectId, f.invite);
	f.transferPorts.set(1, secondDelivery.port);
	await recipient.room.installCreatorSuccessor({ offer: secondDelivery.offer, peers: secondDelivery.peers });
	const nestedPlan = required(await readPlan()),
		nested = required(nestedPlan.entries.find((row) => row.sourceSequence === selected.replacementSequence));
	expect(
		nestedPlan.entries.find((row) => row.sourceSequence === original.commit.authorSequence)?.replacementSequence
	).toBe(selected.replacementSequence);
	expect(nested.replacementSequence).not.toBe(null);
	expect(selections).toHaveLength(2);
	expect(approvals).toHaveLength(2);
	const nestedSelection = decodeCanonical(required(selections[1])) as { sourcePreimage: Uint8Array };
	expect(
		(decodeCanonical(nestedSelection.sourcePreimage) as { settlementSource: unknown }).settlementSource
	).toBeDefined();
	expect(recipient.room.projection().messages).toEqual([{ author, clientOperationId: id, displayTimeMs: time, text }]);
	// Selection approval remains cancellable before this unseen source is delivered.
	// Already-consumed ranges deliberately refuse a fresh authorization request.
	blockApproval = true;
	const selectionBytes = required(selections[1]);
	const imageBeforeCancelledApproval = f.nativeImage();
	const cancelledResult = creator.room
		.authorizeSettlementSourceSelection({
			exactCanonicalSelectionBytes: selectionBytes,
			digest: hashDomain("ts-drp/settlement-source-selection/v1", selectionBytes),
		})
		.then(
			() => ({ ok: true }),
			(error) => ({ ok: false, error: String(error) })
		);
	await Promise.race([
		pendingApproval,
		cancelledResult.then((result) => {
			throw new TypeError(`approval never entered:${JSON.stringify(result)}`);
		}),
	]);
	await creator.room.close();
	rooms.delete(creator.room);
	expect(cancelledApproval).toBe(true);
	expect(await cancelledResult).toMatchObject({ ok: false });
	expect(f.nativeImage()).toEqual(imageBeforeCancelledApproval);
	await creator.head.close();
	heads.delete(creator.head);
	creator = await f.open(true, 0);
	await f.receiveRows(
		0,
		(await f.ownRows(1)).filter(
			(row) => (decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { epoch: number }).epoch === 2
		)
	);
	expect(creator.room.projection().messages).toEqual(recipient.room.projection().messages);
	await creator.room.close();
	rooms.delete(creator.room);
	await creator.head.close();
	heads.delete(creator.head);
	const coldCreator = await f.open(true, 0);
	expect(coldCreator.room.projection().messages).toEqual(recipient.room.projection().messages);
	await coldCreator.room.issue(send("creator-continued", "genuine Writer continuation"));
	await expect(recipient.room.issue(send("still-revoked", "must not author NEW"))).rejects.toThrow();
}, 90_000);

it.each([false, true])(
	"native creator-selected unseen cross-object Chat source follows authenticated rehearsal activation and cold replay (interrupted=%s)",
	async (interrupted) => {
		const f = await fixture("both-writers", false, true);
		const approvals: V3SettlementSourceSelectionApproval[] = [];
		const creator = await f.open(false, 0, undefined, undefined, (request) => {
			approvals.push(request);
			return Promise.resolve(true);
		});
		const selections: Uint8Array[] = [];
		const authorize = async (request: V3SettlementSourceSelectionRequest) => {
			selections.push(new Uint8Array(request.exactCanonicalSelectionBytes));
			return creator.room.authorizeSettlementSourceSelection(request);
		};
		let recipient = await f.open(false, 1, undefined, interrupted ? undefined : authorize);
		const author = required(f.enrolled[1]).localAuthorId;
		const operation = send("cross-object-protected-source", "exact source bytes remain historical", 1791662400001);
		await recipient.room.issue(operation);
		const original = required(
			(await f.ownRows(1)).find(
				(row) =>
					(decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: { action: string } }).operation
						.action === "message"
			)
		);
		expect(creator.room.projection().messages).toHaveLength(0);
		const nonce = new Uint8Array(32).fill(0x6b);
		const targetObjectId = `creator:${hex(hashDomain("ts-drp/v3-room-migration-target-object/v1", encodeCanonical({ rehearsalNonce: nonce, sourceObjectId: f.objectId }))).slice(0, 32)}`;
		const sourceAcl = decodeCanonical(f.invite.exactCanonicalLatchedAclBytes) as {
			members: readonly { author: string; groups: readonly string[] }[];
		};
		const targetAcl = encodeCanonical({
			...sourceAcl,
			objectId: targetObjectId,
			members: sourceAcl.members.map((member) =>
				member.author === author ? { ...member, groups: member.groups.filter((group) => group !== "writer") } : member
			),
		});
		const targetInvite = await createV3RoomCreatorInviteMaterial({
			blueprintDigest: f.blueprintDigest,
			exactCanonicalApplicationStateBytes: createShippingChatGenesisStateBytes({
				exactCanonicalLatchedAclBytes: targetAcl,
			}),
			exactCanonicalLatchedAclBytes: targetAcl,
			exactCanonicalParametersCarrierBytes: f.invite.exactCanonicalParametersCarrierBytes,
			exactCanonicalProfileBytes: f.invite.exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes: f.invite.exactCanonicalSignerSetBytes,
			objectId: targetObjectId,
			signGenesisAnchorDigest: (digest) => f.keychain.signWithLocalAuthor(digest),
		});
		const receipt = await creator.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
		await creator.room.activateMigration({
			exactCanonicalRecordBytes: receipt.exactCanonicalRecordBytes,
			recordVertexDigest: receipt.recordVertexDigest,
			targetCreatorInvite: targetInvite,
		});
		const creatorTarget = required(f.migrationTarget());
		expect(creator.room.objectId).toBe(targetObjectId);
		await f.receiveRows(1, await f.ownRows(0));
		const scratchDigest = hex(
			hashDomain(
				"ts-drp/v3-room-migration-scratch/v1",
				encodeCanonical({ rehearsalNonce: nonce, sourceObjectId: f.objectId, targetObjectId })
			)
		);
		const creatorName = `ts-drp-v3-room-migration--${hex(hashDomain("ts-drp/v3-room-migration-local-store/v1", encodeCanonical({ localNamespace: "shipping-chat", scratchDigest })))}`;
		const name = `ts-drp-v3-room-migration--${hex(hashDomain("ts-drp/v3-room-migration-local-store/v1", encodeCanonical({ localNamespace: "shipping-chat-recipient", scratchDigest })))}`;
		const creatorStore = await f.host.openIssuance(`${creatorName}--issuance`);
		let creatorRows: Awaited<ReturnType<typeof f.ownRows>>;
		try {
			creatorRows = await creatorStore.readOutboxPage({
				scope: { author: f.keychain.localAuthorId, objectId: targetObjectId },
				limit: 128,
			});
		} finally {
			await creatorStore.close();
		}
		await vi.waitFor(() => expect(f.ingressTopic(1)).toBe(f.ingressTopic(0)), { timeout: 15000 });
		await f.receiveRows(1, creatorRows, true);
		try {
			await vi.waitFor(() => expect(recipient.room.objectId).toBe(targetObjectId), { timeout: 15000 });
		} catch (error) {
			await waitForV3RoomStartupForDiagnostics(recipient.room);
			throw error;
		}
		if (interrupted) {
			expect(selections).toHaveLength(0);
			expect(approvals).toHaveLength(0);
			expect(recipient.room.projection().messages).toHaveLength(0);
			await expect(required(f.migrationTarget()).issue(send("held-cross-object-new"))).rejects.toThrow(
				"creator authorization is required"
			);
			await recipient.room.close();
			rooms.delete(recipient.room);
			await recipient.head.close();
			heads.delete(recipient.head);
			const store = await f.host.openIssuance(`${name}--issuance`);
			const scope = { author, objectId: targetObjectId };
			try {
				const plan = required(await store.readSettlementPlan(scope));
				expect(plan.fenceSequence).toBeNull();
				expect(plan.entries).toEqual([
					{
						disposition: "rebase",
						sourceObjectId: f.objectId,
						sourceSequence: original.commit.authorSequence,
						sourceDigest: original.commit.envelope.digest,
						replacementSequence: null,
					},
				]);
				expect((await store.readLineage(scope)).next).toBe(0);
				expect(await store.readOutboxPage({ scope, limit: 128 })).toEqual([]);
				for (const forged of [targetObjectId, `creator:${"f".repeat(32)}`]) {
					await expect(
						store.transactWriteSettlementPlan({
							scope,
							expectedRevision: plan.revision,
							plan: {
								...plan,
								revision: plan.revision + 1,
								entries: plan.entries.map((entry) => ({ ...entry, sourceObjectId: forged })),
							},
						})
					).rejects.toThrow();
					expect(await store.readSettlementPlan(scope)).toEqual(plan);
					expect((await store.readLineage(scope)).next).toBe(0);
					expect(await store.readOutboxPage({ scope, limit: 128 })).toEqual([]);
				}
			} finally {
				await store.close();
			}
			expect(
				(await f.ownRows(1)).find((row) => row.commit.authorSequence === original.commit.authorSequence)?.commit
					.envelope
			).toEqual(original.commit.envelope);
			recipient = await f.open(true, 1, undefined, authorize);
			expect(recipient.room.objectId).toBe(targetObjectId);
		}
		expect(selections).toHaveLength(1);
		expect(approvals).toHaveLength(1);
		expect(approvals[0]?.preview).toMatchObject({
			sourceObjectId: f.objectId,
			sourceAuthor: author,
			sourceSequence: original.commit.authorSequence,
			sourceDigest: hex(original.commit.envelope.digest),
			targetObjectId,
			targetEpoch: 0,
		});
		const targetRows = async () => {
			const store = await f.host.openIssuance(`${name}--issuance`);
			try {
				return await store.readOutboxPage({ scope: { author, objectId: targetObjectId }, limit: 128 });
			} finally {
				await store.close();
			}
		};
		const rows = await targetRows();
		expect(
			rows.some(
				(row) =>
					(
						decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as {
							settlementSource?: { sourceObjectId: string };
						}
					).settlementSource?.sourceObjectId === f.objectId
			)
		).toBe(true);
		await f.receiveRows(0, rows);
		expect(creator.room.projection().messages).toEqual(
			[{ author, ...operation }].map(({ action: _action, ...message }) => message)
		);
		expect(recipient.room.projection().messages).toEqual(creator.room.projection().messages);
		expect(
			(await f.ownRows(1)).find((row) => row.commit.authorSequence === original.commit.authorSequence)?.commit.envelope
		).toEqual(original.commit.envelope);
		const beforeRows = await targetRows();
		await expect(
			recipient.room.issue(send("cross-object-invalid-new", "current Writer still false"))
		).rejects.toThrow();
		expect(await targetRows()).toEqual(beforeRows);
		await recipient.room.close();
		rooms.delete(recipient.room);
		await recipient.head.close();
		heads.delete(recipient.head);
		recipient = await f.open(true, 1, undefined, (request) => creator.room.authorizeSettlementSourceSelection(request));
		expect(recipient.room.objectId).toBe(targetObjectId);
		expect(recipient.room.projection().messages).toEqual(creator.room.projection().messages);
		await creatorTarget.issue(send("cross-object-creator-continued", "genuine target Writer"));
		await expect(recipient.room.issue(send("cross-object-cold-invalid", "reopen does not regrant"))).rejects.toThrow();
	},
	90000
);

it("native authenticated retired-incarnation capacity release retains full committed messages and reallocates finite share", async () => {
	const f = await fixture("both-writers", false, true);
	let creator = await f.open();
	const recipient = await f.open(false, 1);
	const author = required(f.enrolled[1]).localAuthorId;
	await recipient.room.issue(send("retained-history", "never erase this accepted record"));
	await f.receiveRows(0, await f.ownRows(1));
	const original = creator.room.projection().messages;
	expect(original).toHaveLength(1);
	const originalCapacity = creator.room.projection().capacity;
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: author });
	await creator.room.issue({ action: "acl", kind: "revoke", group: "admin", target: author });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	expect(creator.room.projection().capacity).toEqual(originalCapacity);
	expect(creator.room.projection().messages).toEqual(original);
	await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: author });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const selectedAcl = encodeCanonical(creator.room.previewLatchedAcl().current);
	const state = {
		version: 3 as const,
		messages: creator.room.projection().messages,
		capacity: creator.room.projection().capacity,
	};
	const expected = reallocateShippingChatCapacity({
		state,
		exactCanonicalLatchedAclBytes: selectedAcl,
		authenticatedSettlementFrontiers: [[author, 2, null]],
	});
	expect(expected.allocations.find((row) => row[0] === author)?.[1]).toBeLessThan(
		required(originalCapacity.allocations.find((row) => row[0] === author))[1]
	);
	const op = {
		action: "capacityAllocation",
		capacity: expected,
		epoch: 2,
		aclDigest: hex(hashDomain("ts-drp/latched-acl/v3", selectedAcl)),
	};
	const ordinal = await f.nextOrdinal();
	await expect(
		creator.room.issue({
			...op,
			capacity: {
				...expected,
				allocations: expected.allocations.map((row) => (row[0] === author ? [row[0], row[1] + 1, row[2]] : row)),
			},
		})
	).rejects.toThrow();
	expect(await f.nextOrdinal()).toBe(ordinal);
	await creator.room.issue(op);
	expect(creator.room.projection().capacity).toEqual(expected);
	expect(creator.room.projection().messages).toEqual(original);
	expect(shippingChatCapacityStateBytes({ ...state, capacity: expected }).byteLength).toBeLessThanOrEqual(32768);
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await creator.room.close();
	rooms.delete(creator.room);
	await creator.head.close();
	heads.delete(creator.head);
	creator = await f.open(true);
	expect(creator.room.projection().capacity).toEqual(expected);
	expect(creator.room.projection().messages).toEqual(original);
	await creator.room.issue(send("continued-after-release", "authenticated finite allocation"));
}, 90_000);

it("native authenticated migration carries exact source capacity and refuses target-only release before effects", async () => {
	const f = await fixture("both-writers", false, true);
	let creator = await f.open();
	await creator.room.issue(send("source-inherited", "never refresh a source entitlement in a foreign namespace"));
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const sourceState = required(f.application.migration).canonicalStateBytes(creator.room.projection());
	const nonce = new Uint8Array(32).fill(0x65);
	const targetObjectId = `creator:${hex(hashDomain("ts-drp/v3-room-migration-target-object/v1", encodeCanonical({ rehearsalNonce: nonce, sourceObjectId: f.objectId })).subarray(0, 16))}`;
	const targetAcl = encodeCanonical({
		...(decodeCanonical(f.invite.exactCanonicalLatchedAclBytes) as object),
		objectId: targetObjectId,
	});
	const targetInvite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: f.blueprintDigest,
		exactCanonicalApplicationStateBytes: createShippingChatGenesisStateBytes({
			exactCanonicalLatchedAclBytes: targetAcl,
		}),
		exactCanonicalLatchedAclBytes: targetAcl,
		exactCanonicalParametersCarrierBytes: f.invite.exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes: f.invite.exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes: f.invite.exactCanonicalSignerSetBytes,
		objectId: targetObjectId,
		signGenesisAnchorDigest: (digest) => f.keychain.signWithLocalAuthor(digest),
	});
	const receipt = await creator.room.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetInvite });
	expect(required(f.application.migration).canonicalStateBytes(creator.room.projection())).toEqual(sourceState);
	await creator.room.activateMigration({
		exactCanonicalRecordBytes: receipt.exactCanonicalRecordBytes,
		recordVertexDigest: receipt.recordVertexDigest,
		targetCreatorInvite: targetInvite,
	});
	creator = { ...creator, room: required(f.migrationTarget()) };
	expect(creator.room.objectId).toBe(targetObjectId);
	expect(required(f.application.migration).canonicalStateBytes(creator.room.projection())).toEqual(sourceState);
	const before = creator.room.projection();
	const targetAuthor = required(f.enrolled[1]).localAuthorId;
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: targetAuthor });
	await creator.room.issue({ action: "acl", kind: "revoke", group: "admin", target: targetAuthor });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await creator.room.issue({ action: "acl", kind: "grant", group: "writer", target: targetAuthor });
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const selectedAcl = encodeCanonical(creator.room.previewLatchedAcl().current);
	const allocation = {
		action: "capacityAllocation",
		epoch: 2,
		aclDigest: hex(hashDomain("ts-drp/latched-acl/v3", selectedAcl)),
		capacity: before.capacity,
	};
	const image = f.nativeImage();
	await expect(creator.room.issue(allocation)).rejects.toThrow();
	await expect(
		creator.room.issue({ ...allocation, capacity: { ...before.capacity, basisObjectId: targetObjectId } })
	).rejects.toThrow();
	expect(f.nativeImage()).toEqual(image);
	expect(creator.room.projection().capacity).toEqual(before.capacity);
	expect(creator.room.projection().messages).toEqual(before.messages);
	await creator.room.issue(send("target-continues", "finite carried share remains usable"));
	await creator.room.close();
	rooms.delete(creator.room);
	await creator.head.close();
	heads.delete(creator.head);
	creator = await f.open(true);
	expect(creator.room.objectId).toBe(targetObjectId);
	expect(creator.room.projection().capacity).toEqual(before.capacity);
	await creator.room.issue(send("target-reopened", "persisted carried share"));
}, 90_000);

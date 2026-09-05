/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */
/* eslint-disable @typescript-eslint/consistent-type-imports -- importOriginal describes the observed production module. */
import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit } from "@ts-drp/issuance-store";
import type { V3PlaneHandle } from "@ts-drp/node/v3-live";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { createV3ChatApplication } from "../examples/v3-chat/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomHeadState,
	type V3RoomSession,
} from "../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../packages/keychain/src/finality.js";
import {
	frontierFor,
	openCreatorAuthorSettlement,
	resolveCreatorAuthorSettlement,
} from "../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { createBrowserDurableIssuanceStore } from "../packages/storage-browser/src/issuance.js";

const observed = vi.hoisted(() => ({
	stores: new Map<string, DurableIssuanceStore>(),
	planes: new Map<string, V3PlaneHandle>(),
	commits: [] as DurableIssueCommit[],
	advances: [] as Record<string, unknown>[],
	failSuffixFor: "",
	faults: 0,
}));

// All aliases point at the existing implementations, sharing their actual opaque
// capability custody. No replacement trust, codec, checkpoint or activation result.
vi.mock("../packages/node/dist/src/creator-adoption.js", () => import("../packages/node/src/creator-adoption.js"));
vi.mock(
	"../packages/node/dist/src/creator-adoption-stage.js",
	() => import("../packages/node/src/creator-adoption-stage.js")
);
vi.mock(
	"../packages/node/dist/src/creator-adoption-recover.js",
	() => import("../packages/node/src/creator-adoption-recover.js")
);
vi.mock(
	"../packages/node/dist/src/creator-adoption-activate.js",
	() => import("../packages/node/src/creator-adoption-activate.js")
);

vi.mock("../packages/node/src/internal/creator-transition-advance.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../packages/node/src/internal/creator-transition-advance.js")>();
	return {
		...real,
		inspectCreatorTransitionAdvance: (...args: Parameters<typeof real.inspectCreatorTransitionAdvance>) => {
			observed.advances.push(args[0] as unknown as Record<string, unknown>);
			return real.inspectCreatorTransitionAdvance(...args);
		},
	};
});

vi.mock("../packages/storage-browser/dist/src/issuance.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("@ts-drp/storage-browser/issuance")>();
	return {
		...real,
		createBrowserDurableIssuanceStore: async (input: { primaryDatabaseName: string }) => {
			const store = await real.createBrowserDurableIssuanceStore(input);
			const wrapped: DurableIssuanceStore = {
				...store,
				transactIssue: async (scope, build) => {
					let selected: DurableIssueCommit | undefined;
					const result = await store.transactIssue(scope, async (sequence) => {
						const candidate = await build(sequence);
						const effect = candidate.planEffect;
						if (
							input.primaryDatabaseName === observed.failSuffixFor &&
							effect?.kind === "replacement" &&
							"fromIntent" in effect &&
							effect.fromIntent > 0
						) {
							observed.faults += 1;
							throw new Error("F5B_SIGNED_SUFFIX_NOT_COMMITTED");
						}
						selected = candidate;
						return candidate;
					});
					if (selected !== undefined) observed.commits.push(selected);
					return result;
				},
			};
			observed.stores.set(input.primaryDatabaseName, wrapped);
			return wrapped;
		},
	};
});

vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const real = await importOriginal<typeof import("@ts-drp/node/v3-live")>();
	return {
		...real,
		activateV3LivePlane: (...args: Parameters<typeof real.activateV3LivePlane>) => {
			const result = real.activateV3LivePlane(...args);
			if (result.ok) observed.planes.set(args[0].networkNode.peerId, result.handle);
			return result;
		},
	};
});

const sessions = new Set<V3RoomSession>();
const originalStorage = Object.getOwnPropertyDescriptor(navigator, "storage");
const parameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const record = (value: Uint8Array) => decodeCanonical(value) as Record<string, unknown>;
let ordinal = 0;

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) throw new TypeError("F5B_PRODUCT_CUSTODY_MISSING");
	return value;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}

function transactionDone(value: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		value.oncomplete = () => resolve();
		value.onabort = () => reject(value.error);
		value.onerror = () => reject(value.error);
	});
}

// Deferred availability transport, not hot-follow authority: only byte-for-byte
// copies of creator-published AHE/snapshot storage are delivered. The receiver's
// ordinary room reopen still checks pinned genesis, published floor, closure,
// snapshot, signatures and projection. Its issuance/journal are NEVER copied.
async function transferDatabase(sourceName: string, targetName: string): Promise<void> {
	const source = await request(indexedDB.open(sourceName));
	try {
		const names = [...source.objectStoreNames];
		const reading = source.transaction(names, "readonly");
		const rows = await Promise.all(
			names.map(async (name) => {
				const owner = reading.objectStore(name);
				const indexes = [...owner.indexNames].map((indexName) => {
					const index = owner.index(indexName);
					return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
				});
				return {
					name,
					keyPath: owner.keyPath,
					autoIncrement: owner.autoIncrement,
					indexes,
					keys: await request(owner.getAllKeys()),
					values: await request(owner.getAll()),
				};
			})
		);
		const opening = indexedDB.open(targetName, source.version);
		opening.onupgradeneeded = () => {
			for (const row of rows)
				if (!opening.result.objectStoreNames.contains(row.name)) {
					const owner = opening.result.createObjectStore(row.name, {
						keyPath: row.keyPath,
						autoIncrement: row.autoIncrement,
					});
					for (const index of row.indexes)
						owner.createIndex(index.name, index.keyPath, {
							unique: index.unique,
							multiEntry: index.multiEntry,
						});
				}
		};
		const target = await request(opening);
		try {
			const writing = target.transaction(names, "readwrite");
			const complete = transactionDone(writing);
			for (const row of rows) {
				const owner = writing.objectStore(row.name);
				owner.clear();
				row.values.forEach((value, index) => {
					if (row.keyPath === null) owner.put(structuredClone(value), row.keys[index]);
					else owner.put(structuredClone(value));
				});
			}
			await complete;
		} finally {
			target.close();
		}
	} finally {
		source.close();
	}
}

async function producedDeclaration(databaseName: string, closedEpoch: number) {
	const database = await request(indexedDB.open(`${databaseName}--drp-snapshot-quarantine-v1`));
	try {
		const reading = database.transaction(["scopes", "chunks"], "readonly");
		const [scopes, chunks] = await Promise.all([
			request(reading.objectStore("scopes").getAll()) as Promise<Record<string, unknown>[]>,
			request(reading.objectStore("chunks").getAll()) as Promise<Record<string, unknown>[]>,
		]);
		const matching = scopes.filter((row) => row.epoch === closedEpoch && row.state === "verified");
		expect(matching, "F5B_GENUINE_SNAPSHOT_DECLARATION_UNIQUE").toHaveLength(1);
		const scope = required(matching[0]);
		const selected = chunks
			.filter((row) => ["objectId", "epoch", "anchor", "manifestDigest"].every((key) => row[key] === scope[key]))
			.sort((a, b) => Number(a.index) - Number(b.index));
		expect(selected, "F5B_GENUINE_SNAPSHOT_CHUNKS_COMPLETE").toHaveLength(Number(scope.chunkCount));
		return {
			chunks: selected.map((row) => ({ byteLength: row.byteLength, digest: row.digest, index: row.index })),
			exactCanonicalManifestBytes: new Uint8Array(scope.exactCanonicalManifestBytes as Uint8Array),
			scope: {
				anchor: scope.anchor,
				epoch: scope.epoch,
				manifestDigest: scope.manifestDigest,
				objectId: scope.objectId,
			},
			totalBytes: scope.totalBytes,
		} as NonNullable<CreateV3RoomSessionInput["successorSnapshotDeclaration"]>;
	} finally {
		database.close();
	}
}

function floorOwner() {
	let state: V3RoomHeadState | null = null;
	const result = () => ({ ok: true as const, state: structuredClone(state) });
	const same = (value: unknown) => hex(encodeCanonical(value)) === hex(encodeCanonical(state));
	const authority: CreateV3RoomSessionInput["roomHeadAuthority"] = {
		initialization: { kind: "create" },
		read: () => Promise.resolve(result()),
		create: async (input) => {
			await Promise.resolve();
			if (state === null) state = { pending: null, stable: input.stable };
			return result();
		},
		migrate: () => Promise.resolve({ ok: false, reason: "conflict" }),
		begin: async (input) => {
			await Promise.resolve();
			if (!same(input.expected)) return { ok: false, reason: "conflict" };
			const previous = required(state).stable;
			state = { stable: previous, pending: { previous, next: input.next } };
			return result();
		},
		commit: async (input) => {
			await Promise.resolve();
			if (!same(input.expected)) return { ok: false, reason: "conflict" };
			state = { stable: required(required(state).pending).next, pending: null };
			return result();
		},
	};
	return {
		authority,
		read: () => structuredClone(required(state)),
		// Transport the exact floor already committed by the genuine creator.
		receive: (published: V3RoomHeadState) => {
			state = structuredClone(published);
		},
	};
}

interface Peer {
	readonly author: string;
	readonly seed: Uint8Array;
	readonly databaseName: string;
	readonly floor: ReturnType<typeof floorOwner>;
	readonly input: CreateV3RoomSessionInput;
	room: V3RoomSession;
}

async function openRoom(writerCount: number, legacy = false) {
	const id = ++ordinal;
	const objectId = `creator:${(8000 + id).toString(16).padStart(32, "0")}`;
	const identities = Array.from({ length: writerCount }, (_, index) => {
		const seed = new Uint8Array(32);
		seed[0] = 121;
		seed[1] = index + 1;
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const base = createV3ChatApplication("alice");
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(base.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: encodeCanonical([]),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			objectId,
			permissionless: false,
			version: legacy ? 1 : 3,
			members: identities
				.map(({ author }, index) => ({
					author,
					finalityKey: index === 0 ? author : null,
					groups: index === 0 ? ["admin", "finality", "writer"] : ["writer"],
				}))
				.sort((a, b) => (a.author < b.author ? -1 : 1)),
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: legacy ? "creator-trusted-v1" : "creator-trusted-settlement-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, creator.seed)),
	});
	const finality = await createRecoverableFinalitySigner({ seed: creator.seed });
	const ingress = new Map<string, (message: Message) => void>();
	const received = new Set<string>();
	const waiters = new Map<string, () => void>();
	const held = new Set<string>();
	const envelopes: Message[] = [];
	const peers: Peer[] = [];
	const send = async (sender: string, message: Message) => {
		envelopes.push(structuredClone(message));
		if (held.has(sender) || sender === `d110c-f5b-parent-${id}-peer-0`) return true;
		const target = required(peers[0]);
		const envelope = V3Envelope.decode(message.data);
		const digest = hex(hashDomain("ts-drp/vertex/v3", envelope.canonicalPreimage));
		if (received.has(digest)) return true;
		const operation = record(envelope.canonicalPreimage).operation as Record<string, unknown>;
		const delivered = new Promise<void>((resolve) => {
			waiters.set(digest, resolve);
		});
		required(ingress.get(target.databaseName))(message);
		// Control vertices intentionally have no application callback. A following
		// ordinary issue causally depends on them and supplies the admission ack.
		if (operation.action === "$drp.author-fence.v1" || operation.action === "join" || operation.action === "causalJoin")
			return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				delivered,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`F5B_ROUTED_OPERATION_NOT_ADMITTED:${digest}`)), 5000);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			waiters.delete(digest);
		}
		return true;
	};
	for (const [index, identity] of identities.entries()) {
		const databaseName = `d110c-f5b-parent-${id}-peer-${index}`;
		const floor = floorOwner();
		const application = {
			...base,
			displacementPolicies: { message: "transform" as const },
			transformDisplacedOperation: (operation: Readonly<Record<string, unknown>>) => ({
				...operation,
				text: "r".repeat(33_000),
			}),
		};
		const input: CreateV3RoomSessionInput = {
			application,
			author: identity.author,
			creatorInvite: invite,
			databaseName,
			initialLogicalTime: 3,
			issuanceDatabaseName: databaseName,
			objectId,
			publicKeyBytes: ed25519.getPublicKey(identity.seed),
			roomHeadAuthority: floor.authority,
			...(index === 0 ? { creatorFinalitySigner: finality.signer } : {}),
			onAcceptedVertex: (vertex) => {
				const digest = hex(vertex.digest);
				if (index === 0) {
					received.add(digest);
					waiters.get(digest)?.();
				}
			},
			onProjection: () => undefined,
			signRegisteredVertexDigest: (digest) => Promise.resolve(ed25519.sign(digest, identity.seed)),
			openTransport: () => {
				const networkNode = fakeNetwork(databaseName);
				Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
				Reflect.set(networkNode, "publishMessage", (_topic: string, message: Message) => send(databaseName, message));
				return {
					networkNode,
					close: () => {
						ingress.delete(databaseName);
					},
					openEphemeral: () => {
						throw new Error("F5B_EPHEMERAL_NOT_USED");
					},
					requestRetainedHistory: () => undefined,
					setRetainedPublisher: () => undefined,
					setIngressHandler: (_topic, handler) => {
						ingress.set(databaseName, handler);
					},
				};
			},
		};
		const room = await createV3RoomSession(input);
		sessions.add(room);
		peers.push({ ...identity, databaseName, floor, input, room });
	}
	const stop = async (peer: Peer) => {
		await peer.room.close();
		sessions.delete(peer.room);
	};
	const reopen = async (peer: Peer, closedEpoch: number, transfer = false, application = peer.input.application) => {
		await stop(peer);
		const origin = required(peers[0]);
		if (transfer) {
			await transferDatabase(`${origin.databaseName}--ahe`, `${peer.databaseName}--ahe`);
			await transferDatabase(
				`${origin.databaseName}--drp-snapshot-quarantine-v1`,
				`${peer.databaseName}--drp-snapshot-quarantine-v1`
			);
			peer.floor.receive(origin.floor.read());
		}
		const declaration = await producedDeclaration(peer.databaseName, closedEpoch);
		peer.room = await createV3RoomSession({
			...peer.input,
			application,
			roomHeadAuthority: { ...peer.floor.authority, initialization: { kind: "reopen" } },
			successorSnapshotDeclaration: declaration,
		});
		sessions.add(peer.room);
	};
	const issue = (peer: Peer, clientOperationId: string) =>
		peer.room.issue({ action: "message", clientOperationId, text: clientOperationId });
	const close = async () => {
		const origin = required(peers[0]);
		try {
			return await origin.room.sealEpoch();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (detail !== "creator trust advance failed: TRUST_CLOSURE_INVALID") throw error;
			const candidate = required(observed.advances.at(-1)).proposed as { candidates: { bytes: Uint8Array }[] };
			const kinds = candidate.candidates.map(({ bytes }) => record(bytes).kind);
			if (
				!kinds.includes("drp-creator-issuance-retirement-state") ||
				!kinds.includes("drp-creator-author-issuance-frontiers-state") ||
				kinds.includes("drp-creator-author-settlement-state")
			)
				throw error;
			throw new Error(
				"F5B_AUTHENTICATED_CHECKPOINT_COMPOSITION: genuine close emits legacy retirement/aggregate; settlement advance rejects TRUST_CLOSURE_INVALID",
				{ cause: error }
			);
		}
	};
	const checkpoint = () => {
		const advance = required(observed.advances.at(-1));
		const proposed = advance.proposed as {
			candidates: { bytes: Uint8Array; ref: { byteLength: number; digest: string } }[];
		};
		const selected = (kind: string) => required(proposed.candidates.find(({ bytes }) => record(bytes).kind === kind));
		const settled = selected("drp-creator-author-settlement-state");
		const checkpointRecord = record(settled.bytes);
		const cut = required(
			proposed.candidates.find(
				({ bytes }) =>
					record(bytes).kind === "drp-hard-epoch-cut" &&
					hex(hashDomain("ts-drp/hard-epoch-cut/v3", bytes)) === checkpointRecord.cutValueDigest
			)
		);
		const qc = proposed.candidates.find(
			({ ref }) => ref.digest === (checkpointRecord.commitQcRef as { digest: string }).digest
		);
		const opened = openCreatorAuthorSettlement({
			exactCanonicalRecordBytes: settled.bytes,
			expectedCommitQcRef: required(qc).ref,
			expectedCurrentAclDigest: checkpointRecord.currentAclDigest,
			expectedCutValueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", cut.bytes)),
			expectedSnapshotManifestDigest: record(cut.bytes).snapshotManifestDigest,
			expectedSuccessorAclDigest: checkpointRecord.successorAclDigest,
			floorTrust: advance.successorTrust,
		});
		expect(opened.ok, "F5B_C26_FLOOR_ONLY_CHECKPOINT_OPEN").toBe(true);
		if (!opened.ok) throw new Error("F5B_CHECKPOINT_OPEN_FAILED");
		expect(
			proposed.candidates.filter(({ bytes }) =>
				["drp-creator-issuance-retirement-state", "drp-creator-author-issuance-frontiers-state"].includes(
					String(record(bytes).kind)
				)
			),
			"F5B_NO_LEGACY_CONTROLS"
		).toHaveLength(0);
		return { capability: opened.capability, identity: required(resolveCreatorAuthorSettlement(opened.capability)) };
	};
	const deliver = (message: Message) => required(ingress.get(required(peers[0]).databaseName))(message);
	return { peers, objectId, issue, close, checkpoint, reopen, stop, held, envelopes, deliver };
}

async function durable(peer: Peer) {
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: peer.databaseName });
	try {
		const scope = { author: peer.author, objectId: peer.input.objectId };
		const lineage = await store.readLineage(scope);
		const plan = await store.readSettlementPlan(scope);
		return { lineage, plan };
	} finally {
		await store.close();
	}
}

async function sameKeyReentry() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "reentry-creator-initial");
	await fixture.issue(writer, "reentry-writer-initial");
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "old-incarnation-unadmitted");
	const previous = await durable(writer);
	const oldEnvelope = required(fixture.envelopes.findLast((message) => message.sender === writer.databaseName));
	const oldVertex = record(V3Envelope.decode(oldEnvelope.data).canonicalPreimage);
	await fixture.stop(writer);
	await creator.room.issue({ action: "acl", group: "writer", kind: "revoke", target: writer.author });
	for (let epoch = 0; epoch < 3; epoch += 1) {
		await fixture.issue(creator, `removed-epoch-${epoch}`);
		await fixture.close();
		const checkpoint = fixture.checkpoint();
		expect(frontierFor(checkpoint.capability, writer.author), "F5B_C06_ABSENT_ACROSS_MULTIPLE_CLOSES").toBeUndefined();
		await creator.room.adoptCreatorSuccessor();
	}
	await creator.room.issue({ action: "acl", group: "writer", kind: "grant", target: writer.author });
	await fixture.close();
	const checkpoint = fixture.checkpoint();
	const returning = required(frontierFor(checkpoint.capability, writer.author));
	// Unlike a role-only transition, complete removal and regrant creates a new
	// authenticated incarnation, with no retired-key dictionary or lineage jump.
	expect(returning, "F5B_C07_SAME_KEY_NEW_INCARNATION").toEqual([writer.author, 4, null]);
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	const offset = observed.commits.length;
	await fixture.reopen(writer, 3, true);
	await fixture.issue(writer, "same-device-reentry");
	const issued = observed.commits
		.slice(offset)
		.filter((row) => record(row.envelope.canonicalPreimageBytes).author === writer.author);
	const first = required(issued[0]);
	expect(first.authorSequence, "F5B_C07_NEVER_RESET_DEVICE_SEQUENCE").toBe(previous.lineage.next);
	expect(record(first.envelope.canonicalPreimageBytes).operation, "F5B_C07_EMPTY_PLAN_STILL_FENCES").toMatchObject({
		action: "$drp.author-fence.v1",
	});
	expect((await durable(writer)).plan?.entries, "F5B_C07_OLD_INCARNATION_NOT_REBASED").toHaveLength(0);
	expect(oldVertex.epoch, "F5B_C09_OLD_VERTEX_REMAINS_ON_ITS_DEAD_ANCHOR").toBeLessThan(returning[1]);
	expect(oldVertex.anchor, "F5B_C09_CROSS_ANCHOR_PAIR_IS_NOT_EQUIVOCATION").not.toBe(
		creator.room.authority()?.anchorDigest
	);
	fixture.deliver(oldEnvelope);
	await fixture.issue(writer, "after-rejected-stale-envelope");
	const accepted = Reflect.get(creator.room.projection(), "accepted") as { clientOperationId: string }[];
	expect(
		accepted.map((row) => row.clientOperationId),
		"F5B_C09_STALE_INCARNATION_REJECTED_AT_REAL_INGRESS"
	).not.toContain("old-incarnation-unadmitted");
	await fixture.stop(writer);
	// A fresh installation receives the very same published authenticated bytes;
	// no issued/outbox/plan row from the returning device is copied to it.
	const fresh = {
		...writer,
		databaseName: `${writer.databaseName}-fresh`,
		floor: floorOwner(),
		input: {
			...writer.input,
			databaseName: `${writer.databaseName}-fresh`,
			issuanceDatabaseName: `${writer.databaseName}-fresh`,
		},
	};
	await fixture.reopen(fresh, 3, true);
	await fixture.issue(fresh, "fresh-device-reentry");
	expect((await durable(fresh)).lineage.next, "F5B_C08_FRESH_DEVICE_STARTS_AT_ZERO").toBeGreaterThanOrEqual(2);
	const freshStore = await createBrowserDurableIssuanceStore({ primaryDatabaseName: fresh.databaseName });
	try {
		const zero = required(await freshStore.readIssued({ author: fresh.author, objectId: fixture.objectId }, 0));
		expect(record(zero.envelope.canonicalPreimageBytes).operation, "F5B_C08_FRESH_DEVICE_FENCE_ZERO").toMatchObject({
			action: "$drp.author-fence.v1",
			fenceSequence: 0,
		});
	} finally {
		await freshStore.close();
	}
	await fixture.stop(fresh);
	await fixture.stop(creator);
}

async function manualReviewHold() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "manual-creator-before");
	await fixture.issue(writer, "manual-writer-before");
	fixture.held.add(writer.databaseName);
	await fixture.issue(writer, "manual-displaced");
	await fixture.close();
	const first = fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	fixture.held.delete(writer.databaseName);
	const before = await durable(writer);
	await fixture.reopen(writer, 0, true, {
		...writer.input.application,
		displacementPolicies: { message: "manual-review" },
	});
	await expect(fixture.issue(writer, "must-stay-held"), "F5B_C11_MANUAL_REVIEW_BARRIER").rejects.toThrow();
	const held = await durable(writer);
	expect(held.lineage, "F5B_C05_C11_NO_FENCE_OR_REPLACEMENT_WHILE_HELD").toEqual(before.lineage);
	expect(held.plan?.fenceSequence, "F5B_C11_DURABLE_UNFENCED_PLAN").toBeNull();
	expect(
		held.plan?.entries.some((entry) => entry.disposition === "manual-review"),
		"F5B_C11_PLAN_HOLD_DURABLE"
	).toBe(true);
	await fixture.issue(creator, "manual-other-author-progress");
	await fixture.close();
	const second = fixture.checkpoint();
	expect(frontierFor(second.capability, creator.author)?.[2], "F5B_C11_ONLY_HELD_AUTHOR_STALLS").toBeGreaterThan(
		required(frontierFor(first.capability, creator.author)?.[2])
	);
	expect(frontierFor(second.capability, writer.author)?.[2], "F5B_C11_HELD_BOUNDARY_UNCHANGED").toBe(
		frontierFor(first.capability, writer.author)?.[2]
	);
	await creator.room.adoptCreatorSuccessor();
	// The original source must still exist while unlinked; backend primitive
	// conformance additionally tests direct prune refusal under the same gate.
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: writer.databaseName });
	try {
		for (const entry of required(held.plan).entries)
			expect(
				await store.readIssued({ author: writer.author, objectId: fixture.objectId }, entry.sourceSequence),
				"F5B_C13_UNLINKED_SOURCE_RETAINED_ACROSS_CLOSE"
			).not.toBeNull();
	} finally {
		await store.close();
	}
	await fixture.stop(writer);
	await fixture.stop(creator);
}

async function creatorFenceScan() {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]);
	const writer = required(fixture.peers[1]);
	await fixture.issue(creator, "scan-creator-before");
	await fixture.issue(writer, "scan-writer-before");
	await fixture.close();
	const first = fixture.checkpoint();
	await creator.room.adoptCreatorSuccessor();
	await fixture.reopen(writer, 0, true);
	await fixture.issue(writer, "scan-writer-current");
	const authority = required(creator.room.authority());
	const makeFence = (sequence: number, fenceSequence: number, dependency = authority.anchorDigest) => {
		const canonicalPreimage = encodeCanonical({
			anchor: authority.anchorDigest,
			author: writer.author,
			authorSequence: sequence,
			dependencies: [dependency],
			epoch: authority.epoch,
			kind: "drp-vertex",
			logicalTime: 10_000 + sequence,
			objectId: fixture.objectId,
			operation: { action: "$drp.author-fence.v1", fenceSequence, version: 1 },
			protocolMajor: 3,
		});
		const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimage);
		return {
			digest: hex(digest),
			message: Message.create({
				objectId: required(observed.planes.get(creator.databaseName)).topic,
				data: V3Envelope.encode({ canonicalPreimage, signature: ed25519.sign(digest, writer.seed) }).finish(),
				sender: writer.databaseName,
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			}),
		};
	};
	// Adversarial author signs its own operations. Only operation bytes are
	// adversarial; creator graph, signature checking, close and checkpoint are real.
	const lower = makeFence(10_000, 10_000);
	const largest = makeFence(10_001, 10_001, lower.digest);
	fixture.deliver(lower.message);
	fixture.deliver(largest.message);
	fixture.deliver(makeFence(10_002, 10_003).message); // m > f: malformed control
	await fixture.issue(writer, "scan-after-fences"); // FIFO ingress acknowledgement
	await fixture.issue(creator, "scan-independent-creator");
	await fixture.close();
	const second = fixture.checkpoint();
	expect(frontierFor(second.capability, writer.author)?.[2], "F5B_C12_LARGEST_VALID_FENCE_THEN_CONTIGUOUS_SCAN").toBe(
		10_001
	);
	expect(
		frontierFor(second.capability, creator.author)?.[2],
		"F5B_C12_BYZANTINE_JUMP_ONLY_BURNS_OWN_SPACE"
	).toBeGreaterThan(required(frontierFor(first.capability, creator.author)?.[2]));
	await creator.room.adoptCreatorSuccessor();
	await fixture.stop(writer);
	await fixture.stop(creator);
}

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: {
			estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }),
		},
	});
	observed.stores.clear();
	observed.planes.clear();
	observed.commits = [];
	observed.advances = [];
	observed.failSuffixFor = "";
	observed.faults = 0;
});
afterEach(async () => {
	observed.failSuffixFor = "";
	await Promise.all([...sessions].map((room) => room.close().catch(() => undefined)));
	sessions.clear();
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
});

describe("D.110c-0c1f5b parent genuine settlement composition", () => {
	it("retains checkpoint-terminal open progress through cold recovery, then composes 64 active writers across three transitions", async () => {
		const fixture = await openRoom(2);
		const creator = required(fixture.peers[0]);
		const writer = required(fixture.peers[1]);
		await fixture.issue(creator, "creator-before-close");
		await fixture.issue(writer, "writer-before-close");
		fixture.held.add(writer.databaseName);
		await Promise.all([fixture.issue(writer, "displaced-0"), fixture.issue(writer, "displaced-1")]);
		const scope = { author: writer.author, objectId: fixture.objectId };
		const sourceStore = required(observed.stores.get(writer.databaseName));
		const before = await sourceStore.readLineage(scope);
		const source = required(await sourceStore.readIssued(scope, before.next - 1));
		expect(record(source.envelope.canonicalPreimageBytes).operation, "F5B_REAL_BATCH_SOURCE").toMatchObject({
			action: "applicationBatch",
		});
		// The only intended RED terminus: genuine production close, before any
		// frontier fixture or capability can exist. All subsequent code is GREEN
		// continuation, not a claim that RED physically entered openProgressSources.
		await fixture.close();
		const first = fixture.checkpoint();
		expect(frontierFor(first.capability, writer.author)?.[2], "F5B_C01_DELAYED_DEPENDENCY_NOT_ADMITTED").toBeLessThan(
			source.authorSequence
		);
		for (const peer of fixture.peers)
			expect(frontierFor(first.capability, peer.author)?.[1], "F5B_C22_GENESIS_INCARNATION").toBe(0);
		await creator.room.adoptCreatorSuccessor();
		fixture.held.delete(writer.databaseName);
		observed.failSuffixFor = writer.databaseName;
		await fixture.reopen(writer, 0, true);
		await expect(fixture.issue(writer, "blocked-suffix"), "F5B_C03_CRASH_AFTER_COMMITTED_PREFIX").rejects.toThrow();
		const partial = required((await durable(writer)).plan);
		const entry = required(partial.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(entry.replacementSequence, "F5B_C10_PARTIAL_LINK_UNFULFILLED").toBeNull();
		expect(required(entry.replacementProgress).chunks, "F5B_REAL_ROOM_CREATED_PARTIAL_PROGRESS").toHaveLength(1);
		expect(partial.fenceSequence, "F5B_C02_FENCE_PRECEDES_REPLACEMENT").toBeLessThan(
			required(required(entry.replacementProgress).chunks[0]).replacementSequence
		);
		await fixture.issue(creator, "creator-during-writer-crash");
		await fixture.close();
		const second = fixture.checkpoint();
		expect(
			frontierFor(second.capability, writer.author)?.[2],
			"F5B_AUTHENTICATED_SOURCE_IS_TERMINAL"
		).toBeGreaterThanOrEqual(source.authorSequence);
		await creator.room.adoptCreatorSuccessor();
		observed.failSuffixFor = "";
		await fixture.reopen(writer, 1, true);
		await fixture.issue(writer, "after-cold-reopen");
		const complete = required(await required(observed.stores.get(writer.databaseName)).readSettlementPlan(scope));
		const completed = required(complete.entries.find((row) => row.sourceSequence === source.authorSequence));
		expect(
			completed.replacementSequence,
			"F5B_OPEN_PROGRESS_SOURCES_AUTHENTICATED_FRONTIER_REACHABILITY"
		).not.toBeNull();
		expect(required(completed.replacementProgress).chunks[0], "F5B_C10_LINKED_PREFIX_NEVER_REISSUED").toEqual(
			required(entry.replacementProgress).chunks[0]
		);
		expect(required(completed.replacementProgress).chunks.at(-1)?.throughIntent, "F5B_C03_UNLINKED_SUFFIX_ONCE").toBe(
			2
		);
		await fixture.close();
		fixture.checkpoint();
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(creator, 2);
		await fixture.issue(creator, "creator-cold-reopen");
		await fixture.reopen(writer, 2, true);
		await fixture.issue(writer, "writer-third-reopen");
		for (const peer of fixture.peers)
			expect(peer.room.authority()?.epoch, "F5B_C14_THREE_TRANSITIONS_AND_COLD_REOPEN").toBe(3);
		await Promise.all(fixture.peers.map(fixture.stop));

		// Exactly 64 active writers, not a membership census: each public issue is
		// awaited through real publication and creator ingress in epochs 0,1,2,3.
		const wide = await openRoom(64);
		const contributions: { author: string; epoch: number; clientOperationId: string }[] = [];
		for (let epoch = 0; epoch <= 3; epoch += 1) {
			for (const [index, peer] of wide.peers.entries()) {
				const clientOperationId = `wide-${epoch}-${index}`;
				await wide.issue(peer, clientOperationId);
				contributions.push({ author: peer.author, epoch, clientOperationId });
			}
			if (epoch === 3) break;
			await wide.close();
			const current = wide.checkpoint();
			expect(current.identity.frontiers, "F5B_64_AUTHENTICATED_FRONTIERS").toHaveLength(64);
			await required(wide.peers[0]).room.adoptCreatorSuccessor();
			for (const peer of wide.peers.slice(1)) await wide.reopen(peer, epoch, true);
			if (epoch === 1) await wide.reopen(required(wide.peers[0]), epoch);
		}
		expect(contributions, "F5B_64_ACTIVE_WRITERS_EVERY_EPOCH").toHaveLength(256);
		for (let epoch = 0; epoch <= 3; epoch += 1)
			expect(
				new Set(contributions.filter((row) => row.epoch === epoch).map((row) => row.author)).size,
				`F5B_64_GENUINE_WRITERS_EPOCH_${epoch}`
			).toBe(64);
		await Promise.all(wide.peers.map(wide.stop));
		await sameKeyReentry();
		await manualReviewHold();
		await creatorFenceScan();
	}, 60_000);

	it("keeps the genuine v1 room issue, close, adoption and cold reopen control unchanged", async () => {
		const fixture = await openRoom(1, true);
		const creator = required(fixture.peers[0]);
		await fixture.issue(creator, "v1-control");
		const closed = await fixture.close();
		expect(closed.successorEpoch, "F5B_C17_CV1_COMPATIBILITY_CLOSE").toBe(1);
		await creator.room.adoptCreatorSuccessor();
		await fixture.reopen(creator, 0);
		await fixture.issue(creator, "v1-after-reopen");
		expect(creator.room.authority()?.epoch, "F5B_V1_COLD_REOPEN_CONTROL").toBe(1);
	});
});

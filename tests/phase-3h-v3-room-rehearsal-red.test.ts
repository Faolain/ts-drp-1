/* eslint-disable @typescript-eslint/explicit-function-return-type -- the controlled application preserves the genuine room surface. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type DRPNetworkNode, Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHASE_3H_MIGRATION_RECORD_KEYS } from "./fixtures/phase-3a1b-p3/seam3-contract.js";
import {
	expectedMigrationActivationDecision,
	expectedMigrationActivationDecisionDigest,
	type ExpectedMigrationProjection,
	type ExpectedMigrationReceipt,
	expectedTargetObjectId,
	MIGRATION_ACTIVATION_DECISION_KEYS,
	operationNames,
	prepareChatMigration,
} from "./fixtures/phase-3h/migration-rehearsal-fixture.js";
import { createV3ChatApplication } from "../examples/v3-chat/src/index.js";
import type {
	V3RoomAcceptedOperation,
	V3RoomApplication,
	V3RoomCreatorInviteMaterial,
	V3RoomSession,
	V3RoomTransport,
} from "../examples/v3-room/src/index.js";
import { verifyEd25519RegisteredDigest } from "../packages/protocol-v3/src/index.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../packages/storage-node/src/live-journal.js";

const PARAMETERS = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

const probe = vi.hoisted(() => ({
	aheCloses: 0,
	aheClosedNames: [] as string[],
	databaseNames: [] as string[],
	issuanceCloses: 0,
	issuanceClosedNames: [] as string[],
	issuanceCrashAfterCommit: false,
	journalCloses: 0,
	journalClosedNames: [] as string[],
	journalCrashAfterAppend: false,
	journalCrashDatabaseName: undefined as string | undefined,
	journalCloseObserver: undefined as ((databaseName: string) => void) | undefined,
	liveIngressHandlers: new Map<string, (message: Message) => void>(),
	liveIngressTopics: new Map<string, string>(),
	localPublicationCalls: 0,
	openTransportCalls: 0,
	publicationFailures: 0,
	remoteEgressCalls: 0,
	retainedIngressHandlers: new Map<string, (message: Message) => void>(),
	retainedMessageObjects: new WeakSet<Message>(),
	retainedPublishedMessages: new Map<string, Message[]>(),
	sinkCrashOnActivation: false,
	sqliteDirectory: "",
	armTargetFailureMode: undefined as "recovery" | "store" | "transport" | "trust" | undefined,
	targetFailureMode: undefined as "recovery" | "store" | "transport" | "trust" | undefined,
	transportCloses: 0,
	transportObjectIds: [] as string[],
}));

function controlledTargetDatabase(databaseName: string): boolean {
	return databaseName.startsWith("ts-drp-v3-room-migration--");
}

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserAheDurableStore: async ({ databaseName }: { readonly databaseName: string }) => {
		if (probe.targetFailureMode === "store" && controlledTargetDatabase(databaseName)) {
			throw new TypeError("controlled migration target store failure");
		}
		const { createSqliteAheDurableStore } = await import("../packages/storage-node/src/index.js");
		probe.databaseNames.push(databaseName);
		const store = createSqliteAheDurableStore({ filename: sqliteFilename(databaseName) });
		return new Proxy(store, {
			get(target, property) {
				if (property === "databaseName") return databaseName;
				if (property === "close") {
					return async (): Promise<void> => {
						probe.aheCloses += 1;
						probe.aheClosedNames.push(databaseName);
						await store.close();
					};
				}
				if (property === "readHead" && probe.targetFailureMode === "trust" && controlledTargetDatabase(databaseName)) {
					return (): Promise<Readonly<{ ok: false; reason: "STORE_POISONED" }>> =>
						Promise.resolve(Object.freeze({ ok: false, reason: "STORE_POISONED" }));
				}
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	},
}));

vi.mock("../packages/storage-browser/dist/src/issuance.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserDurableIssuanceStore: async ({ primaryDatabaseName }: { readonly primaryDatabaseName: string }) => {
		const { createNodeDurableIssuanceStore: createStore } = await import("../packages/storage-node/src/issuance.js");
		probe.databaseNames.push(primaryDatabaseName);
		const store = createStore({ primaryFilename: sqliteFilename(primaryDatabaseName) });
		return Object.freeze({
			...store,
			transactIssue: async (...args: Parameters<typeof store.transactIssue>) => {
				const committed = await store.transactIssue(...args);
				if (probe.issuanceCrashAfterCommit) {
					probe.issuanceCrashAfterCommit = false;
					throw new TypeError("controlled crash after issuance commit");
				}
				return committed;
			},
			close: async (): Promise<void> => {
				probe.issuanceCloses += 1;
				probe.issuanceClosedNames.push(primaryDatabaseName);
				await store.close();
			},
		});
	},
}));

vi.mock("../packages/storage-browser/dist/src/live-journal.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserDurableLiveJournalStore: async ({ primaryDatabaseName }: { readonly primaryDatabaseName: string }) => {
		const { createNodeDurableLiveJournalStore } = await import("../packages/storage-node/src/live-journal.js");
		probe.databaseNames.push(primaryDatabaseName);
		const store = createNodeDurableLiveJournalStore({ primaryFilename: sqliteFilename(primaryDatabaseName) });
		return Object.freeze({
			...store,
			readiness: async (...args: Parameters<typeof store.readiness>) => {
				if (probe.targetFailureMode === "recovery" && controlledTargetDatabase(primaryDatabaseName)) {
					throw new TypeError("controlled migration target recovery failure");
				}
				return store.readiness(...args);
			},
			appendAccepted: async (...args: Parameters<typeof store.appendAccepted>) => {
				const appended = await store.appendAccepted(...args);
				if (probe.journalCrashAfterAppend && probe.journalCrashDatabaseName === primaryDatabaseName) {
					probe.journalCrashAfterAppend = false;
					probe.journalCrashDatabaseName = undefined;
					throw new TypeError("controlled crash after journal append");
				}
				return appended;
			},
			close: async (): Promise<void> => {
				probe.journalCloses += 1;
				probe.journalClosedNames.push(primaryDatabaseName);
				probe.journalCloseObserver?.(primaryDatabaseName);
				await store.close();
			},
		});
	},
}));

const roomModule = import("../examples/v3-room/src/index.js");

interface CreatorMaterial {
	readonly author: string;
	readonly blueprintDigest: string;
	readonly invite: V3RoomCreatorInviteMaterial;
	readonly seed: Uint8Array;
}

type MigrationSession = V3RoomSession<ReturnType<V3RoomApplication["projectAcceptedOperations"]>> &
	Readonly<{
		activateMigration(
			input: Readonly<{
				readonly exactCanonicalRecordBytes: Uint8Array;
				readonly recordVertexDigest: string;
				readonly targetCreatorInvite: V3RoomCreatorInviteMaterial;
			}>
		): Promise<
			Readonly<{
				readonly activated: true;
				readonly activationDecisionDigest: string;
				readonly activationVertexDigest: string;
				readonly targetAnchorDigest: string;
			}>
		>;
		rehearseMigration(
			input: Readonly<{ rehearsalNonce: Uint8Array; targetCreatorInvite: V3RoomCreatorInviteMaterial }>
		): Promise<ExpectedMigrationReceipt>;
	}>;

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function sqliteFilename(databaseName: string): string {
	return path.join(probe.sqliteDirectory, `${databaseName.replaceAll(/[^a-z0-9-]/giu, "_")}.sqlite`);
}

function digest(domain: string, value: Uint8Array): string {
	return hex(hashDomain(domain, value));
}

async function expectRejected(call: () => Promise<unknown>): Promise<void> {
	let result: Promise<unknown>;
	try {
		result = call();
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		return;
	}
	await expect(result).rejects.toThrow();
}

function recordWithCanonicalSize(
	targetBytes: number,
	build: (padding: string) => Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
	let lower = 0;
	let upper = targetBytes;
	while (lower <= upper) {
		const length = Math.floor((lower + upper) / 2);
		const candidate = build("x".repeat(length));
		const size = encodeCanonical(candidate).byteLength;
		if (size === targetBytes) return candidate;
		if (size < targetBytes) lower = length + 1;
		else upper = length - 1;
	}
	throw new TypeError(`controlled canonical record cannot reach ${String(targetBytes)} bytes`);
}

function creatorMaterial(
	application: V3RoomApplication,
	objectId: string,
	seedByte = 0x41,
	blueprintDigest = digest("ts-drp/blueprint-admission/v3", application.canonicalBlueprintPackageBytes),
	additionalWriterAuthors: readonly string[] = Object.freeze([])
): CreatorMaterial {
	const seed = new Uint8Array(32).fill(seedByte);
	const author = hex(ed25519.getPublicKey(seed));
	const signerSet = Object.freeze([Object.freeze({ publicKey: author, signerId: "creator" })]);
	const exactCanonicalSignerSetBytes = encodeCanonical(signerSet);
	const exactCanonicalProfileBytes = encodeCanonical({
		cryptoSuiteId: "ed25519-sha256-v3",
		profileId: "creator-trusted-v1",
		quorum: 1,
		signers: signerSet,
	});
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: Object.freeze(
			[
				Object.freeze({
					author,
					finalityKey: author,
					groups: Object.freeze(["admin", "finality", "writer"]),
				}),
				...additionalWriterAuthors.map((writer) =>
					Object.freeze({ author: writer, finalityKey: null, groups: Object.freeze(["writer"]) })
				),
			].sort((left, right) => (left.author < right.author ? -1 : left.author > right.author ? 1 : 0))
		),
		objectId,
		permissionless: false,
		version: 1,
	});
	const exactCanonicalParametersCarrierBytes = encodeCanonical(PARAMETERS);
	const exactCanonicalGenesisAnchorPreimageBytes = encodeCanonical({
		aclDigest: digest("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest,
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: "0".repeat(64),
		epoch: 0,
		historyRoot: "5".repeat(64),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId,
		parametersDigest: digest("ts-drp/parameters/v3", exactCanonicalParametersCarrierBytes),
		previousAnchor: "0".repeat(64),
		profileDigest: digest("ts-drp/profile/v3", exactCanonicalProfileBytes),
		protocolMajor: 3,
		signerSetDigest: digest("ts-drp/signer-set/v3", exactCanonicalSignerSetBytes),
		stateDigest: "7".repeat(64),
	});
	const anchorDigestBytes = hashDomain("ts-drp/epoch-anchor/v3", exactCanonicalGenesisAnchorPreimageBytes);
	return Object.freeze({
		author,
		blueprintDigest,
		invite: Object.freeze({
			detachedGenesisSignature: ed25519.sign(anchorDigestBytes, seed),
			exactCanonicalGenesisAnchorPreimageBytes,
			exactCanonicalLatchedAclBytes,
			exactCanonicalParametersCarrierBytes,
			exactCanonicalProfileBytes,
			exactCanonicalSignerSetBytes,
			pinnedGenesisAnchorDigest: hex(anchorDigestBytes),
		}),
		seed,
	});
}

function application(
	prepare: (accepted: readonly V3RoomAcceptedOperation[]) => ExpectedMigrationProjection = prepareChatMigration,
	onProjection?: (accepted: readonly V3RoomAcceptedOperation[]) => void
) {
	const base = createV3ChatApplication("alice");
	const migration = base.migration;
	if (migration === undefined) throw new TypeError("v3 chat migration capability is unavailable");
	return Object.freeze({
		...base,
		migration: Object.freeze({ ...migration, prepare }),
		projectAcceptedOperations: (accepted: readonly V3RoomAcceptedOperation[]) => {
			onProjection?.(accepted);
			return base.projectAcceptedOperations(accepted);
		},
	});
}

function inertTransport(label: string, objectId: string): V3RoomTransport {
	probe.openTransportCalls += 1;
	const topics = new Set<string>();
	const networkNode = {
		peerId: `peer:phase-3h:${label}`,
		broadcastMessage: (): Promise<void> => {
			probe.remoteEgressCalls += 1;
			return Promise.reject(new TypeError("migration transport remote broadcast is unavailable"));
		},
		changeTopicScoreParams: (): void => undefined,
		connect: (): Promise<void> => {
			probe.remoteEgressCalls += 1;
			return Promise.reject(new TypeError("migration transport remote connect is unavailable"));
		},
		connectToBootstraps: (): Promise<void> => {
			probe.remoteEgressCalls += 1;
			return Promise.reject(new TypeError("migration transport bootstrap dialing is unavailable"));
		},
		disconnect: (): Promise<void> => Promise.resolve(),
		getAllPeers: (): [] => [],
		getBootstrapNodes: (): [] => [],
		getGroupPeers: (): [] => [],
		getMultiaddrs: (): [] => [],
		getPeerMultiaddrs: (): Promise<[]> => Promise.resolve([]),
		getSubscribedTopics: (): string[] => [...topics],
		gossipTopicFor: (message: Message): string | undefined =>
			probe.retainedMessageObjects.has(message) ? undefined : message.objectId,
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		publishMessage: (_topic: string, message: Message): Promise<true> => {
			probe.localPublicationCalls += 1;
			if (probe.publicationFailures > 0) {
				probe.publicationFailures -= 1;
				return Promise.reject(new TypeError("controlled terminal publication failure"));
			}
			probe.retainedMessageObjects.add(message);
			const published = probe.retainedPublishedMessages.get(objectId) ?? [];
			published.push(message);
			probe.retainedPublishedMessages.set(objectId, published);
			return Promise.resolve(true);
		},
		removeTopicScoreParams: (): void => undefined,
		restart: (): Promise<void> => Promise.resolve(),
		sendGroupMessageRandomPeer: (): Promise<void> => {
			probe.remoteEgressCalls += 1;
			return Promise.reject(new TypeError("migration transport remote group send is unavailable"));
		},
		sendMessage: (): Promise<void> => {
			probe.remoteEgressCalls += 1;
			return Promise.reject(new TypeError("migration transport remote send is unavailable"));
		},
		start: (): Promise<void> => Promise.resolve(),
		stop: (): Promise<void> => Promise.resolve(),
		subscribe: (topic: string): void => {
			topics.add(topic);
		},
		subscribeToMessageQueue: (): void => undefined,
		unsubscribe: (topic: string): void => {
			topics.delete(topic);
		},
	} as unknown as DRPNetworkNode;
	return Object.freeze({
		close(): void {
			probe.transportCloses += 1;
		},
		networkNode,
		openEphemeral(): never {
			throw new TypeError("migration transport cannot open ephemeral traffic");
		},
		requestRetainedHistory(): void {
			probe.localPublicationCalls += 1;
		},
		setIngressHandler(
			ingressId: string,
			liveHandler: (message: Message) => void,
			retainedHandler: (message: Message) => void
		): void {
			probe.liveIngressHandlers.set(label, liveHandler);
			probe.liveIngressTopics.set(label, ingressId);
			probe.retainedIngressHandlers.set(`${label}:${objectId}`, retainedHandler);
		},
		setRetainedPublisher(): void {
			// The genuine live plane still installs its local retained publisher.
		},
	});
}

async function openRoom(
	input: Readonly<{
		application: ReturnType<typeof application>;
		author?: string;
		databaseName: string;
		material: CreatorMaterial;
		objectId: string;
		onAcceptedVertex?(vertex: unknown): void;
		signer?(digest: Uint8Array): Promise<Uint8Array>;
	}>
): Promise<MigrationSession> {
	const { createV3RoomSession } = await roomModule;
	const author = input.author ?? input.material.author;
	return (await createV3RoomSession({
		application: input.application,
		author,
		creatorInvite: input.material.invite,
		databaseName: input.databaseName,
		initialLogicalTime: 3,
		issuanceDatabaseName: `${input.databaseName}--issuance`,
		objectId: input.objectId,
		onAcceptedVertex: (vertex: unknown) => {
			const operation = Reflect.get(vertex as object, "operation");
			const action = typeof operation === "object" && operation !== null ? Reflect.get(operation, "action") : undefined;
			if (probe.sinkCrashOnActivation && action === "migrationActivation") {
				probe.sinkCrashOnActivation = false;
				throw new TypeError("controlled crash before terminal sink disposition");
			}
			if (action === "migrationActivation" && probe.armTargetFailureMode !== undefined) {
				probe.targetFailureMode = probe.armTargetFailureMode;
				probe.armTargetFailureMode = undefined;
			}
			input.onAcceptedVertex?.(vertex);
		},
		onProjection: () => undefined,
		openTransport: (openedObjectId: string) => {
			probe.transportObjectIds.push(openedObjectId);
			if (probe.targetFailureMode === "transport" && openedObjectId !== input.objectId) {
				throw new TypeError("controlled migration target transport failure");
			}
			return inertTransport(input.databaseName, openedObjectId);
		},
		publicKeyBytes: bytes(author),
		roomHeadAuthority: undefined as never,
		signRegisteredVertexDigest:
			input.signer ?? ((registeredDigest) => Promise.resolve(ed25519.sign(registeredDigest, input.material.seed))),
	})) as MigrationSession;
}

function scratchRoomName(sourceObjectId: string, targetObjectId: string, rehearsalNonce: Uint8Array): string {
	const scratchDigest = digest(
		"ts-drp/v3-room-migration-scratch/v1",
		encodeCanonical({ rehearsalNonce, sourceObjectId, targetObjectId })
	);
	return `ts-drp-v3-room-migration--${scratchDigest}`;
}

async function issuedDigest(
	databaseName: string,
	material: CreatorMaterial,
	objectId: string,
	authorSequence: number
): Promise<string> {
	const store = createNodeDurableIssuanceStore({ primaryFilename: sqliteFilename(`${databaseName}--issuance`) });
	try {
		const scope = Object.freeze({ author: material.author, objectId });
		const committed = await store.readIssued(scope, authorSequence);
		if (committed === null) throw new TypeError("controlled migration issued row is absent");
		return hex(committed.envelope.digest);
	} finally {
		await store.close();
	}
}

async function issuanceNext(databaseName: string, material: CreatorMaterial, objectId: string): Promise<number> {
	const store = createNodeDurableIssuanceStore({ primaryFilename: sqliteFilename(`${databaseName}--issuance`) });
	try {
		return (await store.readLineage(Object.freeze({ author: material.author, objectId }))).next;
	} finally {
		await store.close();
	}
}

async function issuedVertex(
	databaseName: string,
	material: CreatorMaterial,
	objectId: string,
	authorSequence: number
): Promise<
	Readonly<{
		readonly digest: string;
		readonly exactCanonicalPreimageBytes: Uint8Array;
		readonly signature: Uint8Array;
	}>
> {
	const store = createNodeDurableIssuanceStore({ primaryFilename: sqliteFilename(`${databaseName}--issuance`) });
	try {
		const committed = await store.readIssued(Object.freeze({ author: material.author, objectId }), authorSequence);
		if (committed === null) throw new TypeError("controlled migration issued vertex is absent");
		return Object.freeze({
			digest: hex(committed.envelope.digest),
			exactCanonicalPreimageBytes: new Uint8Array(committed.envelope.canonicalPreimageBytes),
			signature: new Uint8Array(committed.envelope.signature),
		});
	} finally {
		await store.close();
	}
}

async function appendReceivedOperation(
	databaseName: string,
	material: CreatorMaterial,
	objectId: string,
	input: Readonly<{
		readonly authorSeed: Uint8Array;
		readonly authorSequence?: number;
		readonly dependency: string;
		readonly logicalTime: number;
		readonly messageObjectId?: string;
		readonly operation: Readonly<Record<string, unknown>>;
	}>
): Promise<string> {
	const evidence = receivedOperationEvidence(material, objectId, input);
	const journal = createNodeDurableLiveJournalStore({ primaryFilename: sqliteFilename(databaseName) });
	try {
		const appended = await journal.appendAccepted({
			detachedSignature: evidence.signature,
			exactCanonicalPreimageBytes: evidence.exactCanonicalPreimageBytes,
			scope: Object.freeze({
				anchorDigest: material.invite.pinnedGenesisAnchorDigest,
				epoch: 0,
				objectId,
			}),
			sourceKind: "received",
			vertexDigest: evidence.vertexDigest,
		});
		if (!appended.ok) throw new TypeError(`controlled migration received append failed: ${appended.kind}`);
		return evidence.vertexDigest;
	} finally {
		await journal.close();
	}
}

function receivedOperationEvidence(
	material: CreatorMaterial,
	objectId: string,
	input: Readonly<{
		readonly authorSeed: Uint8Array;
		readonly authorSequence?: number;
		readonly dependency: string;
		readonly logicalTime: number;
		readonly messageObjectId?: string;
		readonly operation: Readonly<Record<string, unknown>>;
	}>
): Readonly<{
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly message: Message;
	readonly signature: Uint8Array;
	readonly vertexDigest: string;
}> {
	const author = hex(ed25519.getPublicKey(input.authorSeed));
	const exactCanonicalPreimageBytes = encodeCanonical({
		anchor: material.invite.pinnedGenesisAnchorDigest,
		author,
		authorSequence: input.authorSequence ?? 0,
		dependencies: [input.dependency],
		epoch: 0,
		kind: "drp-vertex",
		logicalTime: input.logicalTime,
		objectId,
		operation: input.operation,
		protocolMajor: 3,
	});
	const vertexDigestBytes = hashDomain("ts-drp/vertex/v3", exactCanonicalPreimageBytes);
	const vertexDigest = hex(vertexDigestBytes);
	const signature = ed25519.sign(vertexDigestBytes, input.authorSeed);
	return Object.freeze({
		exactCanonicalPreimageBytes,
		message: Message.create({
			data: V3Envelope.encode({ canonicalPreimage: exactCanonicalPreimageBytes, signature }).finish(),
			objectId: input.messageObjectId ?? material.invite.pinnedGenesisAnchorDigest,
			sender: "peer:phase-3h:remote-writer",
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		}),
		signature,
		vertexDigest,
	});
}

async function journalRowCount(databaseName: string, material: CreatorMaterial, objectId: string): Promise<number> {
	const journal = createNodeDurableLiveJournalStore({ primaryFilename: sqliteFilename(databaseName) });
	try {
		const readiness = await journal.readiness({
			scope: Object.freeze({
				anchorDigest: material.invite.pinnedGenesisAnchorDigest,
				epoch: 0,
				objectId,
			}),
		});
		if (!readiness.ok || !readiness.ready) throw new TypeError("controlled migration journal is unavailable");
		return readiness.rowCount;
	} finally {
		await journal.close();
	}
}

function sourceRowsEvidence(
	accepted: readonly V3RoomAcceptedOperation[]
): Readonly<{ readonly count: number; readonly digest: string }> {
	const rows = accepted.map((row) =>
		Object.freeze({
			author: row.author,
			authorSequence: row.authorSequence,
			exactCanonicalOperationBytes: encodeCanonical(row.operation),
			logicalTime: row.logicalTime,
			operationCount: row.operationCount,
			operationIndex: row.operationIndex,
			vertexDigest: row.vertexDigest,
		})
	);
	return Object.freeze({
		count: rows.length,
		digest: digest("ts-drp/v3-room-migration-source/v1", encodeCanonical(rows)),
	});
}

beforeEach(() => {
	probe.aheCloses = 0;
	probe.aheClosedNames = [];
	probe.databaseNames = [];
	probe.issuanceCloses = 0;
	probe.issuanceClosedNames = [];
	probe.issuanceCrashAfterCommit = false;
	probe.journalCloses = 0;
	probe.journalClosedNames = [];
	probe.journalCrashAfterAppend = false;
	probe.journalCrashDatabaseName = undefined;
	probe.journalCloseObserver = undefined;
	probe.liveIngressHandlers.clear();
	probe.liveIngressTopics.clear();
	probe.localPublicationCalls = 0;
	probe.openTransportCalls = 0;
	probe.publicationFailures = 0;
	probe.remoteEgressCalls = 0;
	probe.retainedIngressHandlers.clear();
	probe.retainedMessageObjects = new WeakSet<Message>();
	probe.retainedPublishedMessages.clear();
	probe.sinkCrashOnActivation = false;
	probe.sqliteDirectory = mkdtempSync(path.join(tmpdir(), "phase-3h-migration-"));
	probe.armTargetFailureMode = undefined;
	probe.targetFailureMode = undefined;
	probe.transportCloses = 0;
	probe.transportObjectIds = [];
});

afterEach(() => {
	if (probe.sqliteDirectory !== "") rmSync(probe.sqliteDirectory, { force: true, recursive: true });
	probe.sqliteDirectory = "";
});

describe("Phase 3h shared-room reversible rehearsal RED", () => {
	it("uses genuine trust, issuance and recovery, signs the record last, and reopens durable target state", async () => {
		const sourceObjectId = `creator:${"d".repeat(32)}`;
		const nonce = new Uint8Array(32).fill(0x53);
		const targetObjectId = expectedTargetObjectId(sourceObjectId, nonce);
		const remoteSeed = new Uint8Array(32).fill(0x42);
		const remoteAuthor = hex(ed25519.getPublicKey(remoteSeed));
		let committedSourceRows: readonly V3RoomAcceptedOperation[] = Object.freeze([]);
		const selectedApplication = application(prepareChatMigration, (accepted) => {
			committedSourceRows = Object.freeze([...accepted]);
		});
		const sourceMaterial = creatorMaterial(
			selectedApplication,
			sourceObjectId,
			0x41,
			digest("ts-drp/blueprint-admission/v3", selectedApplication.canonicalBlueprintPackageBytes),
			[remoteAuthor]
		);
		const targetMaterial = creatorMaterial(
			selectedApplication,
			targetObjectId,
			0x41,
			digest("ts-drp/blueprint-admission/v3", selectedApplication.canonicalBlueprintPackageBytes),
			[remoteAuthor]
		);
		let source = await openRoom({
			application: selectedApplication,
			databaseName: "phase-3h-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
		});
		await source.issue(Object.freeze({ action: "message", clientOperationId: "source-message", text: "durable" }));
		const localMessageDigest = committedSourceRows.at(-1)?.vertexDigest;
		if (localMessageDigest === undefined) throw new TypeError("controlled local source message is absent");
		await source.close();
		await appendReceivedOperation("phase-3h-source", sourceMaterial, sourceObjectId, {
			authorSeed: remoteSeed,
			dependency: localMessageDigest,
			logicalTime: 9,
			operation: Object.freeze({ action: "message", clientOperationId: "remote-message", text: "from peer" }),
		});
		source = await openRoom({
			application: selectedApplication,
			databaseName: "phase-3h-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
		});
		const sourceEvidence = sourceRowsEvidence(committedSourceRows);
		expect(committedSourceRows.some(({ author }) => author === remoteAuthor)).toBe(true);
		expect(sourceEvidence.count).toBe(3);
		const sourceLineageBefore = await issuanceNext("phase-3h-source", sourceMaterial, sourceObjectId);
		expect(sourceLineageBefore).toBe(2);
		const transportCallsBefore = probe.openTransportCalls;
		const localPublicationsBefore = probe.localPublicationCalls;
		const receipt = await source.rehearseMigration({
			rehearsalNonce: nonce,
			targetCreatorInvite: targetMaterial.invite,
		});
		expect(receipt).toMatchObject({
			activated: false,
			applicationStateDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
			importedOperationCount: 2,
			recordDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
			recordVertexDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
			targetAnchorDigest: targetMaterial.invite.pinnedGenesisAnchorDigest,
		});
		const record = decodeCanonical(receipt.exactCanonicalRecordBytes);
		if (record === null || typeof record !== "object") throw new TypeError("migration record is absent");
		expect(Reflect.ownKeys(record).map(String).sort()).toEqual([...PHASE_3H_MIGRATION_RECORD_KEYS].sort());
		expect(record).toMatchObject({
			applicationStateDigest: receipt.applicationStateDigest,
			archivePolicy: "retain-source",
			authorityKind: "creator-ed25519-registered-vertex-v1",
			kind: "ts-drp-v3-room-migration-record",
			rehearsalNonce: nonce,
			sourceAcceptedOperationCount: sourceEvidence.count,
			sourceAcceptedOperationsDigest: sourceEvidence.digest,
			sourceAnchorDigest: source.roomId,
			sourceBlueprintDigest: sourceMaterial.blueprintDigest,
			sourceCreatorAuthor: sourceMaterial.author,
			sourceObjectId,
			targetAnchorDigest: targetMaterial.invite.pinnedGenesisAnchorDigest,
			targetBlueprintDigest: targetMaterial.blueprintDigest,
			targetCreatorAuthor: targetMaterial.author,
			targetImportOperationCount: 2,
			targetImportOperationsDigest: digest(
				"ts-drp/v3-room-migration-import/v1",
				encodeCanonical([
					Object.freeze({ action: "message", clientOperationId: "source-message", text: "durable" }),
					Object.freeze({ action: "message", clientOperationId: "remote-message", text: "from peer" }),
				])
			),
			targetObjectId,
			version: 1,
		});
		expect(receipt.recordDigest).toBe(digest("ts-drp/v3-room-migration-record/v1", receipt.exactCanonicalRecordBytes));
		expect(receipt.exactCanonicalRecordBytes.byteLength).toBeLessThanOrEqual(49_152);
		const expectedState = encodeCanonical([
			{ clientOperationId: "source-message", text: "durable" },
			{ clientOperationId: "remote-message", text: "from peer" },
		]);
		expect(Reflect.get(record, "exactCanonicalApplicationStateBytes")).toEqual(expectedState);
		expect(receipt.applicationStateDigest).toBe(digest("ts-drp/v3-room-migration-state/v1", expectedState));

		const scratch = scratchRoomName(sourceObjectId, targetObjectId, nonce);
		const ordinaryWriterDigest = await appendReceivedOperation(scratch, targetMaterial, targetObjectId, {
			authorSeed: remoteSeed,
			dependency: receipt.recordVertexDigest,
			logicalTime: 23,
			operation: Object.freeze({
				action: "message",
				clientOperationId: "target-writer-control",
				text: "writer accepted",
			}),
		});
		const targetNames = [scratch, `${scratch}--ahe`, `${scratch}--issuance`];
		for (const name of targetNames) {
			expect(probe.databaseNames.filter((candidate) => candidate === name)).toHaveLength(2);
		}
		expect(probe.aheClosedNames.filter((name) => name === `${scratch}--ahe`)).toHaveLength(2);
		expect(probe.issuanceClosedNames.filter((name) => name === `${scratch}--issuance`)).toHaveLength(2);
		expect(probe.journalClosedNames.filter((name) => name === scratch)).toHaveLength(2);
		expect(probe.openTransportCalls).toBe(transportCallsBefore);
		expect(probe.remoteEgressCalls).toBe(0);
		expect(probe.localPublicationCalls).toBe(localPublicationsBefore);

		const independentlyAccepted: string[] = [];
		const independentlyReopened = await openRoom({
			application: selectedApplication,
			databaseName: scratch,
			material: targetMaterial,
			objectId: targetObjectId,
			onAcceptedVertex: (value) => {
				const digestBytes = Reflect.get(value as object, "digest");
				if (digestBytes instanceof Uint8Array) independentlyAccepted.push(hex(digestBytes));
			},
		});
		expect(independentlyAccepted).toContain(ordinaryWriterDigest);
		expect(independentlyReopened.projection()).toMatchObject({
			accepted: [
				expect.objectContaining({ clientOperationId: "source-message", text: "durable" }),
				expect.objectContaining({ clientOperationId: "remote-message", text: "from peer" }),
				expect.objectContaining({ clientOperationId: "target-writer-control", text: "writer accepted" }),
			],
		});
		await independentlyReopened.close();

		const replayDatabaseName = "phase-3h-record-authority-replay";
		const replayTarget = await openRoom({
			application: selectedApplication,
			databaseName: replayDatabaseName,
			material: targetMaterial,
			objectId: targetObjectId,
		});
		await replayTarget.issue(
			Object.freeze({ action: "message", clientOperationId: "source-message", text: "durable" })
		);
		await replayTarget.issue(
			Object.freeze({ action: "message", clientOperationId: "remote-message", text: "from peer" })
		);
		await replayTarget.close();
		const replayTip = await issuedDigest(replayDatabaseName, targetMaterial, targetObjectId, 2);
		const recordOperation = Object.freeze({ action: "migrationRecord", record });
		const writerRecordDigest = await appendReceivedOperation(replayDatabaseName, targetMaterial, targetObjectId, {
			authorSeed: remoteSeed,
			dependency: replayTip,
			logicalTime: 25,
			operation: recordOperation,
		});
		const creatorRecordDigest = await appendReceivedOperation(replayDatabaseName, targetMaterial, targetObjectId, {
			authorSeed: targetMaterial.seed,
			authorSequence: 3,
			dependency: replayTip,
			logicalTime: 26,
			operation: recordOperation,
		});
		const replayAccepted: string[] = [];
		const replayReopened = await openRoom({
			application: selectedApplication,
			databaseName: replayDatabaseName,
			material: targetMaterial,
			objectId: targetObjectId,
			onAcceptedVertex: (value) => {
				const digestBytes = Reflect.get(value as object, "digest");
				if (digestBytes instanceof Uint8Array) replayAccepted.push(hex(digestBytes));
			},
		});
		expect(replayAccepted).not.toContain(writerRecordDigest);
		expect(replayAccepted).toContain(creatorRecordDigest);
		expect(replayReopened.projection()).toMatchObject({
			accepted: [
				expect.objectContaining({ clientOperationId: "source-message", text: "durable" }),
				expect.objectContaining({ clientOperationId: "remote-message", text: "from peer" }),
			],
		});
		await replayReopened.close();

		const issuance = createNodeDurableIssuanceStore({
			primaryFilename: sqliteFilename(`${scratch}--issuance`),
		});
		try {
			const scope = Object.freeze({ author: targetMaterial.author, objectId: targetObjectId });
			const lineage = await issuance.readLineage(scope);
			expect(lineage.next).toBeGreaterThanOrEqual(3);
			expect(lineage.next).toBeLessThanOrEqual(4);
			const outbox = await issuance.readOutboxPage({ limit: 5, scope });
			expect(outbox).toHaveLength(lineage.next);
			expect(outbox.every(({ publishState }) => publishState === "published")).toBe(true);
			const issuedOperations: Readonly<Record<string, unknown>>[] = [];
			for (let authorSequence = 0; authorSequence < lineage.next; authorSequence += 1) {
				const issued = await issuance.readIssued(scope, authorSequence);
				if (issued === null) throw new TypeError("migration target issuance has a gap");
				const issuedPreimage = decodeCanonical(issued.envelope.canonicalPreimageBytes);
				const operation = Reflect.get(issuedPreimage as object, "operation") as Readonly<Record<string, unknown>>;
				issuedOperations.push(operation);
			}
			expect(Reflect.get(issuedOperations[0] as object, "action")).toBe("join");
			const durableImports = issuedOperations.slice(1, -1).flatMap((operation) => {
				if (Reflect.get(operation, "action") !== "applicationBatch") return [operation];
				const entries = Reflect.get(Reflect.get(operation, "batch") as object, "entries");
				if (!Array.isArray(entries)) throw new TypeError("migration target batch entries are invalid");
				return entries.map((entry) => Reflect.get(entry as object, "operation") as Readonly<Record<string, unknown>>);
			});
			expect(durableImports).toEqual([
				Object.freeze({ action: "message", clientOperationId: "source-message", text: "durable" }),
				Object.freeze({ action: "message", clientOperationId: "remote-message", text: "from peer" }),
			]);
			const last = await issuance.readIssued(scope, lineage.next - 1);
			if (last === null) throw new TypeError("migration record vertex is absent from durable issuance");
			expect(hex(last.envelope.digest)).toBe(receipt.recordVertexDigest);
			expect(
				verifyEd25519RegisteredDigest(last.envelope.signature, last.envelope.digest, bytes(targetMaterial.author))
			).toBe(true);
			const preimage = decodeCanonical(last.envelope.canonicalPreimageBytes);
			expect(Reflect.get(Reflect.get(preimage, "operation") as object, "action")).toBe("migrationRecord");
			expect(Reflect.get(Reflect.get(preimage, "operation") as object, "record")).toEqual(record);
		} finally {
			await issuance.close();
		}

		await expect(
			source.issue(Object.freeze({ action: "message", clientOperationId: "source-after", text: "still live" }))
		).resolves.toBeUndefined();
		expect(await issuanceNext("phase-3h-source", sourceMaterial, sourceObjectId)).toBe(sourceLineageBefore + 1);
		expect(source.projection()).toMatchObject({
			accepted: expect.arrayContaining([expect.objectContaining({ text: "still live" })]),
		});
		await expect(
			source.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: targetMaterial.invite })
		).rejects.toThrow();
		await source.close();
		expect(probe.transportCloses).toBe(5);
		expect(probe.aheCloses).toBeGreaterThanOrEqual(4);
		expect(probe.issuanceCloses).toBeGreaterThanOrEqual(4);
		expect(probe.journalCloses).toBeGreaterThanOrEqual(4);
	});

	it("rejects a caller-selected target, a foreign creator, and hostile nonce views before target effects", async () => {
		const sourceObjectId = `creator:${"c".repeat(32)}`;
		const nonce = new Uint8Array(32).fill(0x54);
		const expectedTarget = expectedTargetObjectId(sourceObjectId, nonce);
		const selectedApplication = application();
		const remoteSeed = new Uint8Array(32).fill(0x43);
		const remoteAuthor = hex(ed25519.getPublicKey(remoteSeed));
		const sourceMaterial = creatorMaterial(
			selectedApplication,
			sourceObjectId,
			0x41,
			digest("ts-drp/blueprint-admission/v3", selectedApplication.canonicalBlueprintPackageBytes),
			[remoteAuthor]
		);
		const source = await openRoom({
			application: selectedApplication,
			databaseName: "phase-3h-hostile-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
		});
		await source.issue(Object.freeze({ action: "message", clientOperationId: "one", text: "durable" }));
		const before = probe.databaseNames.length;
		const selectedOtherTarget = creatorMaterial(selectedApplication, `creator:${"e".repeat(32)}`);
		await expect(
			source.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: selectedOtherTarget.invite })
		).rejects.toThrow();
		const foreignCreator = creatorMaterial(selectedApplication, expectedTarget, 0x42);
		await expect(
			source.rehearseMigration({ rehearsalNonce: nonce, targetCreatorInvite: foreignCreator.invite })
		).rejects.toThrow();
		const backing = new Uint8Array(33).fill(0x54);
		await expect(
			source.rehearseMigration({
				rehearsalNonce: backing.subarray(1),
				targetCreatorInvite: creatorMaterial(selectedApplication, expectedTarget).invite,
			})
		).rejects.toThrow();
		await expect(
			source.rehearseMigration({
				extra: true,
				rehearsalNonce: nonce,
				targetCreatorInvite: creatorMaterial(selectedApplication, expectedTarget).invite,
			} as never)
		).rejects.toThrow();
		expect(probe.databaseNames).toHaveLength(before);
		const blueprintNonce = new Uint8Array(32).fill(0x5a);
		const blueprintTarget = expectedTargetObjectId(sourceObjectId, blueprintNonce);
		await expect(
			source.rehearseMigration({
				rehearsalNonce: blueprintNonce,
				targetCreatorInvite: creatorMaterial(selectedApplication, blueprintTarget, 0x41, "f".repeat(64)).invite,
			})
		).rejects.toThrow();
		await expect(
			source.issue(Object.freeze({ action: "message", clientOperationId: "after-hostile", text: "live" }))
		).resolves.toBeUndefined();
		await source.close();

		const remote = await openRoom({
			application: selectedApplication,
			author: remoteAuthor,
			databaseName: "phase-3h-hostile-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
			signer: (registeredDigest) => Promise.resolve(ed25519.sign(registeredDigest, remoteSeed)),
		});
		const remoteBefore = probe.databaseNames.length;
		await expect(
			remote.rehearseMigration({
				rehearsalNonce: nonce,
				targetCreatorInvite: creatorMaterial(
					selectedApplication,
					expectedTarget,
					0x41,
					digest("ts-drp/blueprint-admission/v3", selectedApplication.canonicalBlueprintPackageBytes),
					[remoteAuthor]
				).invite,
			})
		).rejects.toThrow();
		expect(probe.databaseNames).toHaveLength(remoteBefore);
		await expect(
			remote.issue(Object.freeze({ action: "message", clientOperationId: "remote-after-hostile", text: "live" }))
		).resolves.toBeUndefined();
		await remote.close();
	});

	it("rejects duplicate source identity, unstable prepare, source substitution, and target-state divergence", async () => {
		const sourceObjectId = `creator:${"b".repeat(32)}`;
		const nonce = new Uint8Array(32).fill(0x55);
		const targetObjectId = expectedTargetObjectId(sourceObjectId, nonce);
		const duplicateApplication = application();
		const duplicateMaterial = creatorMaterial(duplicateApplication, sourceObjectId);
		const duplicateSource = await openRoom({
			application: duplicateApplication,
			databaseName: "phase-3h-duplicate-source",
			material: duplicateMaterial,
			objectId: sourceObjectId,
		});
		const duplicate = Object.freeze({ action: "message", clientOperationId: "same", text: "same" });
		await duplicateSource.issue(duplicate);
		await duplicateSource.issue(duplicate);
		const beforeDuplicate = probe.databaseNames.length;
		await expect(
			duplicateSource.rehearseMigration({
				rehearsalNonce: nonce,
				targetCreatorInvite: creatorMaterial(duplicateApplication, targetObjectId).invite,
			})
		).rejects.toThrow();
		expect(probe.databaseNames).toHaveLength(beforeDuplicate);
		await duplicateSource.close();

		let calls = 0;
		const unstableApplication = application((accepted) => {
			calls += 1;
			const stable = prepareChatMigration(accepted);
			return calls === 1
				? stable
				: Object.freeze({
						exactCanonicalApplicationStateBytes: encodeCanonical([{ clientOperationId: "changed", text: "changed" }]),
						importOperations: stable.importOperations,
					});
		});
		const unstableMaterial = creatorMaterial(unstableApplication, sourceObjectId);
		const unstableSource = await openRoom({
			application: unstableApplication,
			databaseName: "phase-3h-unstable-source",
			material: unstableMaterial,
			objectId: sourceObjectId,
		});
		await unstableSource.issue(Object.freeze({ action: "message", clientOperationId: "stable", text: "stable" }));
		const beforeUnstable = probe.databaseNames.length;
		await expect(
			unstableSource.rehearseMigration({
				rehearsalNonce: new Uint8Array(32).fill(0x56),
				targetCreatorInvite: creatorMaterial(
					unstableApplication,
					expectedTargetObjectId(sourceObjectId, new Uint8Array(32).fill(0x56))
				).invite,
			})
		).rejects.toThrow();
		expect(calls).toBe(2);
		expect(probe.databaseNames).toHaveLength(beforeUnstable);
		await unstableSource.close();

		const sourceMismatchNonce = new Uint8Array(32).fill(0x57);
		const sourceMismatchTarget = expectedTargetObjectId(sourceObjectId, sourceMismatchNonce);
		const sourceMismatchApplication = application(() =>
			Object.freeze({
				exactCanonicalApplicationStateBytes: encodeCanonical([]),
				importOperations: Object.freeze([]),
			})
		);
		const sourceMismatchMaterial = creatorMaterial(sourceMismatchApplication, sourceObjectId);
		const sourceMismatch = await openRoom({
			application: sourceMismatchApplication,
			databaseName: "phase-3h-source-mismatch",
			material: sourceMismatchMaterial,
			objectId: sourceObjectId,
		});
		await sourceMismatch.issue(
			Object.freeze({ action: "message", clientOperationId: "omitted", text: "must remain in source state" })
		);
		const beforeSourceMismatch = probe.databaseNames.length;
		try {
			await expect(
				sourceMismatch.rehearseMigration({
					rehearsalNonce: sourceMismatchNonce,
					targetCreatorInvite: creatorMaterial(sourceMismatchApplication, sourceMismatchTarget).invite,
				})
			).rejects.toThrow();
			expect(probe.databaseNames).toHaveLength(beforeSourceMismatch);
			await sourceMismatch.issue(
				Object.freeze({ action: "message", clientOperationId: "after-source-mismatch", text: "source remains live" })
			);
			expect(sourceMismatch.projection()).toMatchObject({
				accepted: expect.arrayContaining([
					expect.objectContaining({ clientOperationId: "omitted", text: "must remain in source state" }),
					expect.objectContaining({ clientOperationId: "after-source-mismatch", text: "source remains live" }),
				]),
			});
		} finally {
			await sourceMismatch.close();
		}

		const divergentNonce = new Uint8Array(32).fill(0x5b);
		const divergentTarget = expectedTargetObjectId(sourceObjectId, divergentNonce);
		const divergentApplication = application((accepted) => {
			const stable = prepareChatMigration(accepted);
			return Object.freeze({
				exactCanonicalApplicationStateBytes: stable.exactCanonicalApplicationStateBytes,
				importOperations: Object.freeze(
					stable.importOperations.map((operation) =>
						Object.freeze({ ...operation, text: `${String(Reflect.get(operation, "text"))}:mutated-on-import` })
					)
				),
			});
		});
		const divergentMaterial = creatorMaterial(divergentApplication, sourceObjectId);
		const divergentSource = await openRoom({
			application: divergentApplication,
			databaseName: "phase-3h-target-divergence",
			material: divergentMaterial,
			objectId: sourceObjectId,
		});
		try {
			await divergentSource.issue(
				Object.freeze({ action: "message", clientOperationId: "divergent", text: "source-state" })
			);
			await expect(
				divergentSource.rehearseMigration({
					rehearsalNonce: divergentNonce,
					targetCreatorInvite: creatorMaterial(divergentApplication, divergentTarget).invite,
				})
			).rejects.toThrow();
			await expect(
				divergentSource.issue(
					Object.freeze({ action: "message", clientOperationId: "after-divergence", text: "source-live" })
				)
			).resolves.toBeUndefined();
			const scratch = scratchRoomName(sourceObjectId, divergentTarget, divergentNonce);
			const targetStore = createNodeDurableIssuanceStore({
				primaryFilename: sqliteFilename(`${scratch}--issuance`),
			});
			try {
				const targetScope = Object.freeze({ author: divergentMaterial.author, objectId: divergentTarget });
				const lineage = await targetStore.readLineage(targetScope);
				for (let authorSequence = 0; authorSequence < lineage.next; authorSequence += 1) {
					const issued = await targetStore.readIssued(targetScope, authorSequence);
					if (issued === null) throw new TypeError("divergent target issuance has a gap");
					const preimage = decodeCanonical(issued.envelope.canonicalPreimageBytes);
					expect(Reflect.get(Reflect.get(preimage as object, "operation") as object, "action")).not.toBe(
						"migrationRecord"
					);
				}
			} finally {
				await targetStore.close();
			}
		} finally {
			await divergentSource.close();
		}
	});

	it("rejects oversized state and import descriptions before target reservation", async () => {
		const sourceObjectId = `creator:${"7".repeat(32)}`;
		const scenarios = [
			Object.freeze({
				label: "state",
				prepare: (_accepted: readonly V3RoomAcceptedOperation[]) =>
					Object.freeze({
						exactCanonicalApplicationStateBytes: encodeCanonical("x".repeat(32_769)),
						importOperations: Object.freeze([]),
					}),
			}),
			Object.freeze({
				label: "imports",
				prepare: (_accepted: readonly V3RoomAcceptedOperation[]) =>
					Object.freeze({
						exactCanonicalApplicationStateBytes: encodeCanonical([]),
						importOperations: Object.freeze(
							Array.from({ length: 8193 }, (_, index) =>
								Object.freeze({ action: "message", clientOperationId: `oversized-${index}`, text: "x" })
							)
						),
					}),
			}),
			Object.freeze({
				label: "import-bytes",
				prepare: (_accepted: readonly V3RoomAcceptedOperation[]) =>
					Object.freeze({
						exactCanonicalApplicationStateBytes: encodeCanonical([]),
						importOperations: Object.freeze([
							Object.freeze({
								action: "message",
								clientOperationId: "oversized-import",
								text: "x".repeat(4_194_304),
							}),
						]),
					}),
			}),
		] as const;
		for (const [index, scenario] of scenarios.entries()) {
			const selectedApplication = application(scenario.prepare);
			const material = creatorMaterial(selectedApplication, sourceObjectId);
			const source = await openRoom({
				application: selectedApplication,
				databaseName: `phase-3h-limit-${scenario.label}`,
				material,
				objectId: sourceObjectId,
			});
			await source.issue(Object.freeze({ action: "message", clientOperationId: "one", text: "durable" }));
			const nonce = new Uint8Array(32).fill(0x60 + index);
			const targetObjectId = expectedTargetObjectId(sourceObjectId, nonce);
			const before = probe.databaseNames.length;
			await expect(
				source.rehearseMigration({
					rehearsalNonce: nonce,
					targetCreatorInvite: creatorMaterial(selectedApplication, targetObjectId).invite,
				})
			).rejects.toThrow();
			expect(probe.databaseNames).toHaveLength(before);
			await source.close();
		}
	});

	it("linearizes the source snapshot before a concurrently queued source write", async () => {
		const sourceObjectId = `creator:${"a".repeat(32)}`;
		const nonce = new Uint8Array(32).fill(0x57);
		const targetObjectId = expectedTargetObjectId(sourceObjectId, nonce);
		const holder: { source?: MigrationSession } = {};
		let concurrentIssue: Promise<void> | undefined;
		let concurrentIssueResolved = false;
		let concurrentResolvedBeforeTargetClose = false;
		let scratchCloseCount = 0;
		let calls = 0;
		const selectedApplication = application((accepted) => {
			calls += 1;
			if (calls === 1 && holder.source !== undefined) {
				concurrentIssue = holder.source
					.issue(Object.freeze({ action: "message", clientOperationId: "during", text: "after barrier" }))
					.then(() => {
						concurrentIssueResolved = true;
					});
			}
			return prepareChatMigration(accepted);
		});
		const sourceMaterial = creatorMaterial(selectedApplication, sourceObjectId);
		holder.source = await openRoom({
			application: selectedApplication,
			databaseName: "phase-3h-barrier-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
		});
		const source = holder.source;
		await source.issue(Object.freeze({ action: "message", clientOperationId: "before", text: "before barrier" }));
		const scratch = scratchRoomName(sourceObjectId, targetObjectId, nonce);
		probe.journalCloseObserver = (databaseName) => {
			if (databaseName !== scratch) return;
			scratchCloseCount += 1;
			if (scratchCloseCount === 1) concurrentResolvedBeforeTargetClose = concurrentIssueResolved;
		};
		const receipt = await source.rehearseMigration({
			rehearsalNonce: nonce,
			targetCreatorInvite: creatorMaterial(selectedApplication, targetObjectId).invite,
		});
		if (concurrentIssue === undefined) throw new TypeError("concurrent source issue was not queued");
		await concurrentIssue;
		expect(concurrentResolvedBeforeTargetClose).toBe(true);
		expect(scratchCloseCount).toBe(2);
		expect(calls).toBe(2);
		expect(receipt.importedOperationCount).toBe(1);
		expect(
			decodeCanonical(
				Reflect.get(
					decodeCanonical(receipt.exactCanonicalRecordBytes) as object,
					"exactCanonicalApplicationStateBytes"
				) as Uint8Array
			)
		).toEqual([{ clientOperationId: "before", text: "before barrier" }]);
		expect(source.projection()).toMatchObject({
			accepted: expect.arrayContaining([expect.objectContaining({ clientOperationId: "during" })]),
		});
		await source.close();
	});

	it("rejects a genuine target import failure and a foreign registered-vertex signature without poisoning the source", async () => {
		const sourceObjectId = `creator:${"9".repeat(32)}`;
		const nonce = new Uint8Array(32).fill(0x58);
		const targetObjectId = expectedTargetObjectId(sourceObjectId, nonce);
		const invalidImportApplication = application((accepted) => {
			const stable = prepareChatMigration(accepted);
			return Object.freeze({
				exactCanonicalApplicationStateBytes: stable.exactCanonicalApplicationStateBytes,
				importOperations: Object.freeze([Object.freeze({ action: "unknownMigrationImport" })]),
			});
		});
		const sourceMaterial = creatorMaterial(invalidImportApplication, sourceObjectId);
		const source = await openRoom({
			application: invalidImportApplication,
			databaseName: "phase-3h-failure-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
		});
		await source.issue(Object.freeze({ action: "message", clientOperationId: "one", text: "durable" }));
		const failureScratch = scratchRoomName(sourceObjectId, targetObjectId, nonce);
		const closesBeforeFailure = Object.freeze({
			ahe: probe.aheCloses,
			issuance: probe.issuanceCloses,
			journal: probe.journalCloses,
		});
		await expect(
			source.rehearseMigration({
				rehearsalNonce: nonce,
				targetCreatorInvite: creatorMaterial(invalidImportApplication, targetObjectId).invite,
			})
		).rejects.toThrow();
		expect(probe.aheClosedNames.filter((name) => name === `${failureScratch}--ahe`)).toHaveLength(1);
		expect(probe.issuanceClosedNames.filter((name) => name === `${failureScratch}--issuance`)).toHaveLength(1);
		expect(probe.journalClosedNames.filter((name) => name === failureScratch)).toHaveLength(1);
		expect(probe.aheCloses).toBe(closesBeforeFailure.ahe + 1);
		expect(probe.issuanceCloses).toBe(closesBeforeFailure.issuance + 1);
		expect(probe.journalCloses).toBe(closesBeforeFailure.journal + 1);
		const failedImportIssuance = createNodeDurableIssuanceStore({
			primaryFilename: sqliteFilename(`${failureScratch}--issuance`),
		});
		try {
			const failedScope = Object.freeze({ author: sourceMaterial.author, objectId: targetObjectId });
			expect(await failedImportIssuance.readLineage(failedScope)).toMatchObject({ next: 1 });
			const bootstrap = await failedImportIssuance.readIssued(failedScope, 0);
			if (bootstrap === null) throw new TypeError("failed migration target bootstrap is absent");
			const bootstrapPreimage = decodeCanonical(bootstrap.envelope.canonicalPreimageBytes);
			expect(Reflect.get(Reflect.get(bootstrapPreimage, "operation") as object, "action")).toBe("join");
			expect(await failedImportIssuance.readIssued(failedScope, 1)).toBeNull();
			const failedOutbox = await failedImportIssuance.readOutboxPage({ limit: 3, scope: failedScope });
			expect(failedOutbox).toHaveLength(1);
			expect(
				failedOutbox.map(({ commit }) => {
					const preimage = decodeCanonical(commit.envelope.canonicalPreimageBytes);
					return Reflect.get(Reflect.get(preimage, "operation") as object, "action");
				})
			).toEqual(["join"]);
		} finally {
			await failedImportIssuance.close();
		}
		await expect(
			source.issue(Object.freeze({ action: "message", clientOperationId: "after-import-failure", text: "live" }))
		).resolves.toBeUndefined();
		await source.close();

		const signatureObjectId = `creator:${"6".repeat(32)}`;
		const validApplication = application();
		const validSourceMaterial = creatorMaterial(validApplication, signatureObjectId);
		const validNonce = new Uint8Array(32).fill(0x59);
		const validTarget = expectedTargetObjectId(signatureObjectId, validNonce);
		let signerCalls = 0;
		let foreignSignerCall = Number.POSITIVE_INFINITY;
		const signatureSource = await openRoom({
			application: validApplication,
			databaseName: "phase-3h-signature-source",
			material: validSourceMaterial,
			objectId: signatureObjectId,
			signer: (registeredDigest) => {
				signerCalls += 1;
				return Promise.resolve(
					ed25519.sign(
						registeredDigest,
						signerCalls === foreignSignerCall ? new Uint8Array(32).fill(0x42) : validSourceMaterial.seed
					)
				);
			},
		});
		await signatureSource.issue(Object.freeze({ action: "message", clientOperationId: "signed", text: "durable" }));
		const signerCallsBefore = signerCalls;
		// Target bootstrap and import remain valid; only the final migration-record vertex receives the foreign signature.
		foreignSignerCall = signerCallsBefore + 3;
		await expect(
			signatureSource.rehearseMigration({
				rehearsalNonce: validNonce,
				targetCreatorInvite: creatorMaterial(validApplication, validTarget).invite,
			})
		).rejects.toThrow();
		expect(signerCalls).toBe(foreignSignerCall);
		const scratch = scratchRoomName(signatureObjectId, validTarget, validNonce);
		const failedTargetIssuance = createNodeDurableIssuanceStore({
			primaryFilename: sqliteFilename(`${scratch}--issuance`),
		});
		try {
			expect(
				await failedTargetIssuance.readLineage(
					Object.freeze({ author: validSourceMaterial.author, objectId: validTarget })
				)
			).toMatchObject({ next: 2 });
			expect(
				await failedTargetIssuance.readIssued(
					Object.freeze({ author: validSourceMaterial.author, objectId: validTarget }),
					2
				)
			).toBeNull();
		} finally {
			await failedTargetIssuance.close();
		}
		foreignSignerCall = Number.POSITIVE_INFINITY;
		await expect(
			signatureSource.issue(Object.freeze({ action: "message", clientOperationId: "after-failure", text: "live" }))
		).resolves.toBeUndefined();
		await signatureSource.close();
	});

	it("contains a malformed signed remote migration record before projection and keeps recovery usable", async () => {
		const objectId = `creator:${"8".repeat(32)}`;
		const selectedApplication = application();
		// This readiness assertion becomes green only when the genuine product catalog can parse the injected row.
		expect(operationNames(selectedApplication)).toContain("migrationRecord");
		const remoteSeed = new Uint8Array(32).fill(0x43);
		const remoteAuthor = hex(ed25519.getPublicKey(remoteSeed));
		const material = creatorMaterial(
			selectedApplication,
			objectId,
			0x41,
			digest("ts-drp/blueprint-admission/v3", selectedApplication.canonicalBlueprintPackageBytes),
			[remoteAuthor]
		);
		const validRecord = Object.freeze({
			applicationStateDigest: "1".repeat(64),
			archivePolicy: "retain-source",
			authorityKind: "creator-ed25519-registered-vertex-v1",
			exactCanonicalApplicationStateBytes: encodeCanonical([]),
			kind: "ts-drp-v3-room-migration-record",
			rehearsalNonce: new Uint8Array(32).fill(0x53),
			sourceAcceptedOperationCount: 0,
			sourceAcceptedOperationsDigest: "2".repeat(64),
			sourceAnchorDigest: "3".repeat(64),
			sourceBlueprintDigest: material.blueprintDigest,
			sourceCreatorAuthor: material.author,
			sourceObjectId: objectId,
			targetAnchorDigest: "4".repeat(64),
			targetBlueprintDigest: material.blueprintDigest,
			targetCreatorAuthor: material.author,
			targetImportOperationCount: 0,
			targetImportOperationsDigest: "5".repeat(64),
			targetObjectId: `creator:${"9".repeat(32)}`,
			version: 1,
		});
		const missingVersion = Object.freeze(
			Object.fromEntries(Object.entries(validRecord).filter(([key]) => key !== "version"))
		);
		const malformedRecords = [
			Object.freeze({ ...validRecord, kind: "wrong" }),
			missingVersion,
			Object.freeze({ ...validRecord, extra: true }),
			Object.freeze({ ...validRecord, version: 2 }),
			Object.freeze({ ...validRecord, sourceAcceptedOperationsDigest: "not-a-digest" }),
		] as const;
		for (const [index, record] of malformedRecords.entries()) {
			const databaseName = `phase-3h-malformed-record-${index}`;
			const first = await openRoom({ application: selectedApplication, databaseName, material, objectId });
			await first.close();
			const bootstrapDigest = await issuedDigest(databaseName, material, objectId, 0);
			const malformedDigest = await appendReceivedOperation(databaseName, material, objectId, {
				authorSeed: remoteSeed,
				dependency: bootstrapDigest,
				logicalTime: 3,
				operation: Object.freeze({ action: "migrationRecord", record }),
			});
			const accepted: string[] = [];
			const reopened = await openRoom({
				application: selectedApplication,
				databaseName,
				material,
				objectId,
				onAcceptedVertex: (value) => {
					const digestBytes = Reflect.get(value as object, "digest");
					if (digestBytes instanceof Uint8Array) accepted.push(hex(digestBytes));
				},
			});
			expect(accepted).toContain(bootstrapDigest);
			expect(accepted).not.toContain(malformedDigest);
			expect(reopened.projection()).toMatchObject({ accepted: [] });
			await expect(
				reopened.issue(
					Object.freeze({ action: "message", clientOperationId: `after-malformed-${index}`, text: "live" })
				)
			).resolves.toBeUndefined();
			expect(reopened.projection()).toMatchObject({
				accepted: [expect.objectContaining({ clientOperationId: `after-malformed-${index}`, text: "live" })],
			});
			await reopened.close();
		}
	});

	it("rejects noncreator and creator-signed malformed decisions before the exact creator activation", async () => {
		const sourceObjectId = `creator:${"8".repeat(32)}`;
		const selectedApplication = application();
		const remoteSeed = new Uint8Array(32).fill(0x48);
		const remoteAuthor = hex(ed25519.getPublicKey(remoteSeed));
		const sourceMaterial = creatorMaterial(
			selectedApplication,
			sourceObjectId,
			0x41,
			digest("ts-drp/blueprint-admission/v3", selectedApplication.canonicalBlueprintPackageBytes),
			[remoteAuthor]
		);
		const acceptedAfterHostile: string[] = [];
		let sourceSignerCalls = 0;
		const source = await openRoom({
			application: selectedApplication,
			databaseName: "phase-3h-activation-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
			onAcceptedVertex: (value) => {
				const digestBytes = Reflect.get(value as object, "digest");
				if (digestBytes instanceof Uint8Array) acceptedAfterHostile.push(hex(digestBytes));
			},
			signer: (registeredDigest) => {
				sourceSignerCalls += 1;
				return Promise.resolve(ed25519.sign(registeredDigest, sourceMaterial.seed));
			},
		});
		const hostileNonce = new Uint8Array(32).fill(0x62);
		const hostileTargetObjectId = expectedTargetObjectId(sourceObjectId, hostileNonce);
		const hostileTargetMaterial = creatorMaterial(selectedApplication, hostileTargetObjectId);
		await source.issue(Object.freeze({ action: "message", clientOperationId: "before-activation", text: "durable" }));
		const hostileRehearsal = await source.rehearseMigration({
			rehearsalNonce: hostileNonce,
			targetCreatorInvite: hostileTargetMaterial.invite,
		});
		const hostileDecision = expectedMigrationActivationDecision(
			hostileRehearsal.exactCanonicalRecordBytes,
			hostileRehearsal.recordVertexDigest,
			hostileTargetMaterial.invite
		);
		const malformedCreatorDecision = Object.freeze({ ...hostileDecision, targetObjectId: sourceObjectId });
		const oversizedDecision = recordWithCanonicalSize(49_153, (sourceIdentity) =>
			Object.freeze({ ...hostileDecision, sourceObjectId: sourceIdentity })
		);
		const oversizedOperation = recordWithCanonicalSize(65_537, (sourceIdentity) =>
			Object.freeze({
				action: "migrationActivation",
				decision: Object.freeze({ ...hostileDecision, sourceObjectId: sourceIdentity }),
			})
		);
		expect(encodeCanonical(oversizedDecision)).toHaveLength(49_153);
		expect(encodeCanonical(oversizedOperation)).toHaveLength(65_537);
		const sourceMessageDigest = await issuedDigest("phase-3h-activation-source", sourceMaterial, sourceObjectId, 1);
		const activationIngressTopic = probe.liveIngressTopics.get("phase-3h-activation-source");
		if (activationIngressTopic === undefined) throw new TypeError("controlled migration live topic is absent");
		const hostileEvidence = receivedOperationEvidence(sourceMaterial, sourceObjectId, {
			authorSeed: remoteSeed,
			dependency: sourceMessageDigest,
			logicalTime: 13,
			messageObjectId: activationIngressTopic,
			operation: Object.freeze({ action: "migrationActivation", decision: hostileDecision }),
		});
		const malformedCreatorEvidence = receivedOperationEvidence(sourceMaterial, sourceObjectId, {
			authorSeed: sourceMaterial.seed,
			authorSequence: 2,
			dependency: sourceMessageDigest,
			logicalTime: 14,
			messageObjectId: activationIngressTopic,
			operation: Object.freeze({ action: "migrationActivation", decision: malformedCreatorDecision }),
		});
		const oversizedDecisionEvidence = receivedOperationEvidence(sourceMaterial, sourceObjectId, {
			authorSeed: sourceMaterial.seed,
			authorSequence: 2,
			dependency: sourceMessageDigest,
			logicalTime: 15,
			messageObjectId: activationIngressTopic,
			operation: Object.freeze({ action: "migrationActivation", decision: oversizedDecision }),
		});
		const oversizedOperationEvidence = receivedOperationEvidence(sourceMaterial, sourceObjectId, {
			authorSeed: sourceMaterial.seed,
			authorSequence: 2,
			dependency: sourceMessageDigest,
			logicalTime: 16,
			messageObjectId: activationIngressTopic,
			operation: oversizedOperation,
		});
		const ordinaryRemoteEvidence = receivedOperationEvidence(sourceMaterial, sourceObjectId, {
			authorSeed: remoteSeed,
			dependency: sourceMessageDigest,
			logicalTime: 17,
			messageObjectId: activationIngressTopic,
			operation: Object.freeze({ action: "message", clientOperationId: "ordinary-remote", text: "accepted" }),
		});
		const rowsBeforeHostile = await journalRowCount("phase-3h-activation-source", sourceMaterial, sourceObjectId);
		const liveIngress = probe.liveIngressHandlers.get("phase-3h-activation-source");
		if (liveIngress === undefined) throw new TypeError("controlled migration live ingress is absent");
		liveIngress(hostileEvidence.message);
		liveIngress(malformedCreatorEvidence.message);
		liveIngress(oversizedDecisionEvidence.message);
		liveIngress(oversizedOperationEvidence.message);
		liveIngress(ordinaryRemoteEvidence.message);
		await expect(
			source.issue(Object.freeze({ action: "message", clientOperationId: "after-hostile", text: "still live" }))
		).resolves.toBeUndefined();
		expect(acceptedAfterHostile).not.toContain(hostileEvidence.vertexDigest);
		expect(acceptedAfterHostile).not.toContain(malformedCreatorEvidence.vertexDigest);
		expect(acceptedAfterHostile).not.toContain(oversizedDecisionEvidence.vertexDigest);
		expect(acceptedAfterHostile).not.toContain(oversizedOperationEvidence.vertexDigest);
		expect(acceptedAfterHostile).toContain(ordinaryRemoteEvidence.vertexDigest);
		expect(await journalRowCount("phase-3h-activation-source", sourceMaterial, sourceObjectId)).toBe(
			rowsBeforeHostile + 2
		);

		const nonce = new Uint8Array(32).fill(0x63);
		const targetObjectId = expectedTargetObjectId(sourceObjectId, nonce);
		const targetMaterial = creatorMaterial(selectedApplication, targetObjectId);
		const rehearsal = await source.rehearseMigration({
			rehearsalNonce: nonce,
			targetCreatorInvite: targetMaterial.invite,
		});
		const expectedDecision = expectedMigrationActivationDecision(
			rehearsal.exactCanonicalRecordBytes,
			rehearsal.recordVertexDigest,
			targetMaterial.invite
		);
		const lineageBeforeRejectedActivation = await issuanceNext(
			"phase-3h-activation-source",
			sourceMaterial,
			sourceObjectId
		);
		const signerCallsBeforeRejectedActivation = sourceSignerCalls;
		await expect(
			source.issue(Object.freeze({ action: "migrationActivation", decision: expectedDecision }))
		).rejects.toThrow();
		expect(await issuanceNext("phase-3h-activation-source", sourceMaterial, sourceObjectId)).toBe(
			lineageBeforeRejectedActivation
		);
		expect(sourceSignerCalls).toBe(signerCallsBeforeRejectedActivation);
		if (typeof source.activateMigration !== "function") throw new TypeError("PHASE3H_ACTIVATION_ABSENT");
		const mutatedRecordBytes = new Uint8Array(rehearsal.exactCanonicalRecordBytes);
		mutatedRecordBytes[mutatedRecordBytes.byteLength - 1] =
			(mutatedRecordBytes[mutatedRecordBytes.byteLength - 1] ?? 0) ^ 1;
		const foreignTargetObjectId = expectedTargetObjectId(sourceObjectId, new Uint8Array(32).fill(0x64));
		const foreignTargetMaterial = creatorMaterial(selectedApplication, foreignTargetObjectId, 0x44);
		const oversizedTargetInvite: V3RoomCreatorInviteMaterial = Object.freeze({
			...targetMaterial.invite,
			exactCanonicalProfileBytes: new Uint8Array(32_769),
		});
		const inheritedActivationInput = Object.create({
			exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
			recordVertexDigest: rehearsal.recordVertexDigest,
			targetCreatorInvite: targetMaterial.invite,
		}) as object;
		const accessorActivationInput = Object.defineProperties(
			{},
			{
				exactCanonicalRecordBytes: { enumerable: true, get: () => rehearsal.exactCanonicalRecordBytes },
				recordVertexDigest: { enumerable: true, get: () => rehearsal.recordVertexDigest },
				targetCreatorInvite: { enumerable: true, get: () => targetMaterial.invite },
			}
		);
		const invalidActivationInputs = [
			Object.freeze({
				exactCanonicalRecordBytes: mutatedRecordBytes,
				recordVertexDigest: rehearsal.recordVertexDigest,
				targetCreatorInvite: targetMaterial.invite,
			}),
			Object.freeze({
				exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
				recordVertexDigest: "0".repeat(64),
				targetCreatorInvite: targetMaterial.invite,
			}),
			Object.freeze({
				exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
				recordVertexDigest: rehearsal.recordVertexDigest,
				targetCreatorInvite: foreignTargetMaterial.invite,
			}),
			Object.freeze({
				exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
				recordVertexDigest: rehearsal.recordVertexDigest,
				targetCreatorInvite: oversizedTargetInvite,
			}),
			Object.freeze({
				exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
				extra: true,
				recordVertexDigest: rehearsal.recordVertexDigest,
				targetCreatorInvite: targetMaterial.invite,
			}),
			inheritedActivationInput,
			accessorActivationInput,
		] as const;
		for (const invalidInput of invalidActivationInputs) {
			await expectRejected(() => Reflect.apply(source.activateMigration, source, [invalidInput]) as Promise<unknown>);
			expect(await issuanceNext("phase-3h-activation-source", sourceMaterial, sourceObjectId)).toBe(
				lineageBeforeRejectedActivation
			);
			expect(sourceSignerCalls).toBe(signerCallsBeforeRejectedActivation);
		}
		const lineageBeforeActivation = await issuanceNext("phase-3h-activation-source", sourceMaterial, sourceObjectId);
		const mutableBackings: Uint8Array[] = [];
		const backedView = (value: Uint8Array): Uint8Array => {
			const backing = new Uint8Array(value.byteLength + 4);
			const view = backing.subarray(2, value.byteLength + 2);
			view.set(value);
			mutableBackings.push(backing);
			return view;
		};
		const snapshotInvite: V3RoomCreatorInviteMaterial = Object.freeze({
			detachedGenesisSignature: backedView(targetMaterial.invite.detachedGenesisSignature),
			exactCanonicalGenesisAnchorPreimageBytes: backedView(
				targetMaterial.invite.exactCanonicalGenesisAnchorPreimageBytes
			),
			exactCanonicalLatchedAclBytes: backedView(targetMaterial.invite.exactCanonicalLatchedAclBytes),
			exactCanonicalParametersCarrierBytes: backedView(targetMaterial.invite.exactCanonicalParametersCarrierBytes),
			exactCanonicalProfileBytes: backedView(targetMaterial.invite.exactCanonicalProfileBytes),
			exactCanonicalSignerSetBytes: backedView(targetMaterial.invite.exactCanonicalSignerSetBytes),
			pinnedGenesisAnchorDigest: targetMaterial.invite.pinnedGenesisAnchorDigest,
		});
		const activationPromise = source.activateMigration({
			exactCanonicalRecordBytes: backedView(rehearsal.exactCanonicalRecordBytes),
			recordVertexDigest: rehearsal.recordVertexDigest,
			targetCreatorInvite: snapshotInvite,
		});
		for (const backing of mutableBackings) backing.fill(0);
		const receipt = await activationPromise;
		expect(receipt).toEqual({
			activated: true,
			activationDecisionDigest: expectedMigrationActivationDecisionDigest(expectedDecision),
			activationVertexDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
			targetAnchorDigest: targetMaterial.invite.pinnedGenesisAnchorDigest,
		});
		const activationVertex = await issuedVertex(
			"phase-3h-activation-source",
			sourceMaterial,
			sourceObjectId,
			lineageBeforeActivation
		);
		expect(activationVertex.digest).toBe(receipt.activationVertexDigest);
		expect(
			verifyEd25519RegisteredDigest(
				activationVertex.signature,
				bytes(activationVertex.digest),
				bytes(sourceMaterial.author)
			)
		).toBe(true);
		const activationPreimage = decodeCanonical(activationVertex.exactCanonicalPreimageBytes);
		const activationOperation = Reflect.get(activationPreimage as object, "operation");
		expect(activationOperation).toEqual({ action: "migrationActivation", decision: expectedDecision });
		expect(
			Reflect.ownKeys(Reflect.get(activationOperation as object, "decision") as object)
				.map(String)
				.sort()
		).toEqual([...MIGRATION_ACTIVATION_DECISION_KEYS].sort());
		await expect(
			source.issue(Object.freeze({ action: "message", clientOperationId: "after-terminal", text: "forbidden" }))
		).rejects.toThrow();
		expect(await issuanceNext("phase-3h-activation-source", sourceMaterial, sourceObjectId)).toBe(
			lineageBeforeActivation + 1
		);
		await source.close();

		const redirectTransportStart = probe.transportObjectIds.length;
		let redirected = await openRoom({
			application: selectedApplication,
			databaseName: "phase-3h-activation-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
		});
		expect(redirected.roomId).toBe(targetMaterial.invite.pinnedGenesisAnchorDigest);
		expect(redirected.projection()).toMatchObject({
			accepted: expect.arrayContaining([
				expect.objectContaining({ clientOperationId: "before-activation", text: "durable" }),
				expect.objectContaining({ clientOperationId: "after-hostile", text: "still live" }),
			]),
		});
		expect(probe.transportObjectIds.slice(redirectTransportStart)).toEqual(
			expect.arrayContaining([sourceObjectId, targetObjectId])
		);
		await redirected.issue(Object.freeze({ action: "message", clientOperationId: "target-suffix", text: "survives" }));
		await redirected.close();
		redirected = await openRoom({
			application: selectedApplication,
			databaseName: "phase-3h-activation-source",
			material: sourceMaterial,
			objectId: sourceObjectId,
		});
		expect(redirected.roomId).toBe(targetMaterial.invite.pinnedGenesisAnchorDigest);
		expect(redirected.projection()).toMatchObject({
			accepted: expect.arrayContaining([
				expect.objectContaining({ clientOperationId: "target-suffix", text: "survives" }),
			]),
		});
		await redirected.close();

		const remoteObjectId = `creator:${"9".repeat(32)}`;
		const remoteMaterial = creatorMaterial(selectedApplication, remoteObjectId, 0x42);
		const remoteNonce = new Uint8Array(32).fill(0x65);
		const remoteTargetObjectId = expectedTargetObjectId(remoteObjectId, remoteNonce);
		const remoteTargetMaterial = creatorMaterial(selectedApplication, remoteTargetObjectId, 0x42);
		const remoteAccepted: string[] = [];
		const remoteSource = await openRoom({
			application: selectedApplication,
			databaseName: "phase-3h-activation-remote",
			material: remoteMaterial,
			objectId: remoteObjectId,
			onAcceptedVertex: (value) => {
				const digestBytes = Reflect.get(value as object, "digest");
				if (digestBytes instanceof Uint8Array) remoteAccepted.push(hex(digestBytes));
			},
		});
		await remoteSource.issue(
			Object.freeze({ action: "message", clientOperationId: "before-remote-activation", text: "durable" })
		);
		const remoteRehearsal = await remoteSource.rehearseMigration({
			rehearsalNonce: remoteNonce,
			targetCreatorInvite: remoteTargetMaterial.invite,
		});
		const remoteDecision = expectedMigrationActivationDecision(
			remoteRehearsal.exactCanonicalRecordBytes,
			remoteRehearsal.recordVertexDigest,
			remoteTargetMaterial.invite
		);
		const remoteDependency = await issuedDigest("phase-3h-activation-remote", remoteMaterial, remoteObjectId, 1);
		const remoteIngressTopic = probe.liveIngressTopics.get("phase-3h-activation-remote");
		if (remoteIngressTopic === undefined) throw new TypeError("controlled remote activation topic is absent");
		const remoteActivation = receivedOperationEvidence(remoteMaterial, remoteObjectId, {
			authorSeed: remoteMaterial.seed,
			authorSequence: 2,
			dependency: remoteDependency,
			logicalTime: 13,
			messageObjectId: remoteIngressTopic,
			operation: Object.freeze({ action: "migrationActivation", decision: remoteDecision }),
		});
		const remoteLineageBefore = await issuanceNext("phase-3h-activation-remote", remoteMaterial, remoteObjectId);
		const remoteIngress = probe.liveIngressHandlers.get("phase-3h-activation-remote");
		if (remoteIngress === undefined) throw new TypeError("controlled remote activation ingress is absent");
		remoteIngress(remoteActivation.message);
		await expect(
			remoteSource.issue(
				Object.freeze({ action: "message", clientOperationId: "after-remote-activation", text: "forbidden" })
			)
		).rejects.toThrow();
		expect(remoteAccepted).toContain(remoteActivation.vertexDigest);
		expect(await issuanceNext("phase-3h-activation-remote", remoteMaterial, remoteObjectId)).toBe(remoteLineageBefore);
		await remoteSource.close();
	});

	it("recovers irreversible activation commits without reopening source authority", async () => {
		for (const [index, failurePoint] of [
			"signer",
			"issuance",
			"journal",
			"sink",
			"publication",
			"target-store",
			"target-trust",
			"target-recovery",
			"target-transport",
		].entries()) {
			const selectedApplication = application();
			const sourceObjectId = `creator:${String(index + 1).repeat(32)}`;
			const staleSeed = new Uint8Array(32).fill(0x31 + index);
			const staleAuthor = hex(ed25519.getPublicKey(staleSeed));
			const sourceMaterial = creatorMaterial(
				selectedApplication,
				sourceObjectId,
				0x51 + index,
				digest("ts-drp/blueprint-admission/v3", selectedApplication.canonicalBlueprintPackageBytes),
				[staleAuthor]
			);
			const nonce = new Uint8Array(32).fill(0x70 + index);
			const targetObjectId = expectedTargetObjectId(sourceObjectId, nonce);
			const targetMaterial = creatorMaterial(
				selectedApplication,
				targetObjectId,
				0x51 + index,
				digest("ts-drp/blueprint-admission/v3", selectedApplication.canonicalBlueprintPackageBytes),
				[staleAuthor]
			);
			const databaseName = `phase-3h-activation-crash-${failurePoint}`;
			let rejectNextSignature = false;
			let source = await openRoom({
				application: selectedApplication,
				databaseName,
				material: sourceMaterial,
				objectId: sourceObjectId,
				signer: (registeredDigest) => {
					if (rejectNextSignature) {
						rejectNextSignature = false;
						return Promise.reject(new TypeError("controlled crash before issuance"));
					}
					return Promise.resolve(ed25519.sign(registeredDigest, sourceMaterial.seed));
				},
			});
			await source.issue(
				Object.freeze({ action: "message", clientOperationId: `before-${failurePoint}`, text: "durable" })
			);
			const rehearsal = await source.rehearseMigration({
				rehearsalNonce: nonce,
				targetCreatorInvite: targetMaterial.invite,
			});
			if (typeof source.activateMigration !== "function") {
				throw new TypeError("PHASE3H_ACTIVATION_ABSENT");
			}
			if (failurePoint === "signer") rejectNextSignature = true;
			if (failurePoint === "issuance") probe.issuanceCrashAfterCommit = true;
			if (failurePoint === "journal") {
				probe.journalCrashAfterAppend = true;
				probe.journalCrashDatabaseName = databaseName;
			}
			if (failurePoint === "sink") probe.sinkCrashOnActivation = true;
			if (failurePoint === "publication") probe.publicationFailures = 1;
			if (failurePoint.startsWith("target-")) {
				probe.armTargetFailureMode = failurePoint.slice("target-".length) as
					| "recovery"
					| "store"
					| "transport"
					| "trust";
			}
			await expectRejected(() =>
				source.activateMigration({
					exactCanonicalRecordBytes: rehearsal.exactCanonicalRecordBytes,
					recordVertexDigest: rehearsal.recordVertexDigest,
					targetCreatorInvite: targetMaterial.invite,
				})
			);
			if (failurePoint === "signer") {
				await expect(
					source.issue(Object.freeze({ action: "message", clientOperationId: "after-pre-effect", text: "source-live" }))
				).resolves.toBeUndefined();
				await source.close();
				continue;
			}
			const targetFailure = failurePoint.startsWith("target-");
			const sourceLineageAfterTerminalEffect = await issuanceNext(databaseName, sourceMaterial, sourceObjectId);
			const activationVertex = await issuedVertex(
				databaseName,
				sourceMaterial,
				sourceObjectId,
				sourceLineageAfterTerminalEffect - 1
			);
			const activationPreimage = decodeCanonical(activationVertex.exactCanonicalPreimageBytes);
			if (activationPreimage === null || typeof activationPreimage !== "object") {
				throw new TypeError("controlled migration activation preimage is malformed");
			}
			const activationOperation = Reflect.get(activationPreimage, "operation");
			if (activationOperation === null || typeof activationOperation !== "object") {
				throw new TypeError("controlled migration activation operation is malformed");
			}
			expect(Reflect.get(activationOperation, "action")).toBe("migrationActivation");
			const sourceRowsAfterTerminalEffect = await journalRowCount(databaseName, sourceMaterial, sourceObjectId);
			await expect(
				source.issue(
					Object.freeze({
						action: "message",
						clientOperationId: `after-terminal-effect-${failurePoint}`,
						text: "forbidden-before-reopen",
					})
				)
			).rejects.toThrow();
			expect(await issuanceNext(databaseName, sourceMaterial, sourceObjectId)).toBe(sourceLineageAfterTerminalEffect);
			expect(await journalRowCount(databaseName, sourceMaterial, sourceObjectId)).toBe(sourceRowsAfterTerminalEffect);
			await source.close();
			if (targetFailure) {
				await expect(
					openRoom({
						application: selectedApplication,
						databaseName,
						material: sourceMaterial,
						objectId: sourceObjectId,
					})
				).rejects.toThrow();
				expect(await issuanceNext(databaseName, sourceMaterial, sourceObjectId)).toBe(sourceLineageAfterTerminalEffect);
				expect(await journalRowCount(databaseName, sourceMaterial, sourceObjectId)).toBe(sourceRowsAfterTerminalEffect);
				probe.targetFailureMode = undefined;
			}
			const retainedPublicationStart = probe.retainedPublishedMessages.get(sourceObjectId)?.length ?? 0;
			source = await openRoom({
				application: selectedApplication,
				databaseName,
				material: sourceMaterial,
				objectId: sourceObjectId,
			});
			expect(source.roomId).toBe(targetMaterial.invite.pinnedGenesisAnchorDigest);
			if (failurePoint === "publication") {
				const retainedSourceMessages = [...(probe.retainedPublishedMessages.get(sourceObjectId) ?? [])];
				const replayedDigests = retainedSourceMessages.slice(retainedPublicationStart).map((message) => {
					const envelope = V3Envelope.decode(message.data ?? new Uint8Array());
					return hex(hashDomain("ts-drp/vertex/v3", envelope.canonicalPreimage));
				});
				expect(replayedDigests).toContain(activationVertex.digest);
				const staleDatabaseName = `${databaseName}-stale-peer`;
				const staleAccepted: string[] = [];
				let stalePeer = await openRoom({
					application: selectedApplication,
					author: staleAuthor,
					databaseName: staleDatabaseName,
					material: sourceMaterial,
					objectId: sourceObjectId,
					onAcceptedVertex: (value) => {
						const digestBytes = Reflect.get(value as object, "digest");
						if (digestBytes instanceof Uint8Array) staleAccepted.push(hex(digestBytes));
					},
					signer: (registeredDigest) => Promise.resolve(ed25519.sign(registeredDigest, staleSeed)),
				});
				const retainedIngress = probe.retainedIngressHandlers.get(`${staleDatabaseName}:${sourceObjectId}`);
				if (retainedIngress === undefined) throw new TypeError("controlled stale-peer retained ingress is absent");
				for (const message of retainedSourceMessages) retainedIngress(message);
				for (let turn = 0; turn < 64 && !staleAccepted.includes(activationVertex.digest); turn += 1) {
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
				}
				expect(staleAccepted).toContain(activationVertex.digest);
				await stalePeer.close();
				stalePeer = await openRoom({
					application: selectedApplication,
					author: staleAuthor,
					databaseName: staleDatabaseName,
					material: sourceMaterial,
					objectId: sourceObjectId,
					signer: (registeredDigest) => Promise.resolve(ed25519.sign(registeredDigest, staleSeed)),
				});
				expect(stalePeer.roomId).toBe(targetMaterial.invite.pinnedGenesisAnchorDigest);
				await stalePeer.close();
			}
			await expect(
				source.issue(
					Object.freeze({ action: "message", clientOperationId: `after-${failurePoint}`, text: "target-live" })
				)
			).resolves.toBeUndefined();
			await source.close();
		}

		const remoteApplication = application();
		const remoteObjectId = `creator:${"6".repeat(32)}`;
		const remoteMaterial = creatorMaterial(remoteApplication, remoteObjectId, 0x58);
		const remoteNonce = new Uint8Array(32).fill(0x79);
		const remoteTargetObjectId = expectedTargetObjectId(remoteObjectId, remoteNonce);
		const remoteTargetMaterial = creatorMaterial(remoteApplication, remoteTargetObjectId, 0x58);
		const remoteDatabaseName = "phase-3h-activation-crash-remote-journal";
		let remoteSource = await openRoom({
			application: remoteApplication,
			databaseName: remoteDatabaseName,
			material: remoteMaterial,
			objectId: remoteObjectId,
		});
		await remoteSource.issue(
			Object.freeze({ action: "message", clientOperationId: "before-remote-journal", text: "durable" })
		);
		const remoteRehearsal = await remoteSource.rehearseMigration({
			rehearsalNonce: remoteNonce,
			targetCreatorInvite: remoteTargetMaterial.invite,
		});
		const remoteDecision = expectedMigrationActivationDecision(
			remoteRehearsal.exactCanonicalRecordBytes,
			remoteRehearsal.recordVertexDigest,
			remoteTargetMaterial.invite
		);
		const remoteDependency = await issuedDigest(remoteDatabaseName, remoteMaterial, remoteObjectId, 1);
		const remoteTopic = probe.liveIngressTopics.get(remoteDatabaseName);
		const remoteIngress = probe.liveIngressHandlers.get(remoteDatabaseName);
		if (remoteTopic === undefined || remoteIngress === undefined) {
			throw new TypeError("controlled remote-journal activation ingress is absent");
		}
		const remoteActivation = receivedOperationEvidence(remoteMaterial, remoteObjectId, {
			authorSeed: remoteMaterial.seed,
			authorSequence: 2,
			dependency: remoteDependency,
			logicalTime: 13,
			messageObjectId: remoteTopic,
			operation: Object.freeze({ action: "migrationActivation", decision: remoteDecision }),
		});
		probe.journalCrashAfterAppend = true;
		probe.journalCrashDatabaseName = remoteDatabaseName;
		remoteIngress(remoteActivation.message);
		await expect(
			remoteSource.issue(
				Object.freeze({ action: "message", clientOperationId: "after-remote-journal", text: "forbidden" })
			)
		).rejects.toThrow();
		expect(await journalRowCount(remoteDatabaseName, remoteMaterial, remoteObjectId)).toBe(3);
		await remoteSource.close();
		remoteSource = await openRoom({
			application: remoteApplication,
			databaseName: remoteDatabaseName,
			material: remoteMaterial,
			objectId: remoteObjectId,
		});
		expect(remoteSource.roomId).toBe(remoteTargetMaterial.invite.pinnedGenesisAnchorDigest);
		await expect(
			remoteSource.issue(
				Object.freeze({ action: "message", clientOperationId: "after-remote-recovery", text: "target-live" })
			)
		).resolves.toBeUndefined();
		await remoteSource.close();
	});
});

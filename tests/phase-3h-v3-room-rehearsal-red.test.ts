/* eslint-disable @typescript-eslint/explicit-function-return-type -- the controlled application preserves the genuine room surface. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DRPNetworkNode, Message } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PHASE_3H_MIGRATION_RECORD_KEYS } from "./fixtures/phase-3a1b-p3/seam3-contract.js";
import {
	type ExpectedMigrationProjection,
	type ExpectedMigrationReceipt,
	expectedTargetObjectId,
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
	journalCloses: 0,
	journalClosedNames: [] as string[],
	localPublicationCalls: 0,
	openTransportCalls: 0,
	remoteEgressCalls: 0,
	sqliteDirectory: "",
	transportCloses: 0,
}));

vi.mock("../packages/storage-browser/dist/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	createBrowserAheDurableStore: async ({ databaseName }: { readonly databaseName: string }) => {
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
			close: async (): Promise<void> => {
				probe.journalCloses += 1;
				probe.journalClosedNames.push(primaryDatabaseName);
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
	return Object.freeze({
		...base,
		migration: Object.freeze({ prepare }),
		projectAcceptedOperations: (accepted: readonly V3RoomAcceptedOperation[]) => {
			onProjection?.(accepted);
			return base.projectAcceptedOperations(accepted);
		},
	});
}

function inertTransport(label: string): V3RoomTransport {
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
		isDialable: (): Promise<boolean> => Promise.resolve(false),
		publishMessage: (_topic: string, _message: Message): Promise<true> => {
			probe.localPublicationCalls += 1;
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
		setIngressHandler(): void {
			// No remote ingress exists in this closed local transport.
		},
		setRetainedPublisher(): void {
			// The genuine live plane still installs its local retained publisher.
		},
	});
}

async function openRoom(
	input: Readonly<{
		application: ReturnType<typeof application>;
		databaseName: string;
		material: CreatorMaterial;
		objectId: string;
		onAcceptedVertex?(vertex: unknown): void;
		signer?(digest: Uint8Array): Promise<Uint8Array>;
	}>
): Promise<MigrationSession> {
	const { createV3RoomSession } = await roomModule;
	return (await createV3RoomSession({
		application: input.application,
		author: input.material.author,
		creatorInvite: input.material.invite,
		databaseName: input.databaseName,
		initialLogicalTime: 3,
		issuanceDatabaseName: `${input.databaseName}--issuance`,
		objectId: input.objectId,
		onAcceptedVertex: input.onAcceptedVertex ?? (() => undefined),
		onProjection: () => undefined,
		openTransport: () => inertTransport(input.databaseName),
		publicKeyBytes: bytes(input.material.author),
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

async function appendReceivedOperation(
	databaseName: string,
	material: CreatorMaterial,
	objectId: string,
	input: Readonly<{
		readonly authorSeed: Uint8Array;
		readonly dependency: string;
		readonly logicalTime: number;
		readonly operation: Readonly<Record<string, unknown>>;
	}>
): Promise<string> {
	const author = hex(ed25519.getPublicKey(input.authorSeed));
	const exactCanonicalPreimageBytes = encodeCanonical({
		anchor: material.invite.pinnedGenesisAnchorDigest,
		author,
		authorSequence: 0,
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
	const journal = createNodeDurableLiveJournalStore({ primaryFilename: sqliteFilename(databaseName) });
	try {
		const appended = await journal.appendAccepted({
			detachedSignature: ed25519.sign(vertexDigestBytes, input.authorSeed),
			exactCanonicalPreimageBytes,
			scope: Object.freeze({
				anchorDigest: material.invite.pinnedGenesisAnchorDigest,
				epoch: 0,
				objectId,
			}),
			sourceKind: "received",
			vertexDigest,
		});
		if (!appended.ok) throw new TypeError(`controlled migration received append failed: ${appended.kind}`);
		return vertexDigest;
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
	probe.journalCloses = 0;
	probe.journalClosedNames = [];
	probe.localPublicationCalls = 0;
	probe.openTransportCalls = 0;
	probe.remoteEgressCalls = 0;
	probe.sqliteDirectory = mkdtempSync(path.join(tmpdir(), "phase-3h-migration-"));
	probe.transportCloses = 0;
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
		const targetMaterial = creatorMaterial(selectedApplication, targetObjectId);
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

		const independentlyReopened = await openRoom({
			application: selectedApplication,
			databaseName: scratch,
			material: targetMaterial,
			objectId: targetObjectId,
		});
		expect(independentlyReopened.projection()).toMatchObject({
			accepted: [
				expect.objectContaining({ clientOperationId: "source-message", text: "durable" }),
				expect.objectContaining({ clientOperationId: "remote-message", text: "from peer" }),
			],
		});
		await independentlyReopened.close();

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
		expect(probe.transportCloses).toBe(3);
		expect(probe.aheCloses).toBeGreaterThanOrEqual(4);
		expect(probe.issuanceCloses).toBeGreaterThanOrEqual(4);
		expect(probe.journalCloses).toBeGreaterThanOrEqual(4);
	});

	it("rejects a caller-selected target, a foreign creator, and hostile nonce views before target effects", async () => {
		const sourceObjectId = `creator:${"c".repeat(32)}`;
		const nonce = new Uint8Array(32).fill(0x54);
		const expectedTarget = expectedTargetObjectId(sourceObjectId, nonce);
		const selectedApplication = application();
		const sourceMaterial = creatorMaterial(selectedApplication, sourceObjectId);
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
	});

	it("rejects duplicate source identity and unstable prepare before reserving a target", async () => {
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
		let calls = 0;
		const selectedApplication = application((accepted) => {
			calls += 1;
			if (calls === 1 && holder.source !== undefined) {
				concurrentIssue = holder.source.issue(
					Object.freeze({ action: "message", clientOperationId: "during", text: "after barrier" })
				);
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
		const receipt = await source.rehearseMigration({
			rehearsalNonce: nonce,
			targetCreatorInvite: creatorMaterial(selectedApplication, targetObjectId).invite,
		});
		if (concurrentIssue === undefined) throw new TypeError("concurrent source issue was not queued");
		await concurrentIssue;
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
});

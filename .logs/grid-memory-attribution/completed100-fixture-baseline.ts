/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent test observers retain real runtime signatures. */
/* eslint-disable @typescript-eslint/consistent-type-imports -- importOriginal describes the observed production module. */
// Extracted from the genuine F5B room composition fixture. The existing chat
// case and grid diagnostic share observers, signature/checkpoint custody,
// physical-client activation realms, durable stores and cold recovery here.
// The optional application factory is the only application composition seam.
import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit, SettlementPlan } from "@ts-drp/issuance-store";
import type { DurableIssuancePruningReceipt } from "@ts-drp/issuance-store/maintenance";
import type { V3PlaneHandle } from "@ts-drp/node/v3-live";
import { type GenerationRecord, parseStorageObjectId } from "@ts-drp/storage";
import { Message, V3Envelope } from "@ts-drp/types";
import { readFileSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, vi } from "vitest";

import { fakeNetwork } from "./phase-4b-v3/live-snapshot.js";
import { createTransientPayloadApplication } from "./phase-6b-d110c-0c1f5b/transient-payload-application.js";
import { createV3ChatApplication } from "../../examples/v3-chat/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type CreateV3RoomSessionInput,
	type V3RoomHeadState,
	type V3RoomSession,
} from "../../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../../packages/keychain/src/finality.js";
import {
	openCreatorAuthorSettlement,
	resolveCreatorAuthorSettlement,
} from "../../packages/protocol-v3/src/creator-author-issuance-frontiers.js";
import { createBrowserAheDurableStore } from "../../packages/storage-browser/src/index.js";
import { PHASE_5E_SCHEMA_AUTHORITY } from "../../packages/storage-browser/src/internal/schema-idb.js";
import { createBrowserDurableIssuanceStore } from "../../packages/storage-browser/src/issuance.js";

const observed = vi.hoisted(() => ({
	stores: new Map<string, DurableIssuanceStore>(),
	planes: new Map<string, V3PlaneHandle>(),
	commits: [] as DurableIssueCommit[],
	advances: [] as Record<string, unknown>[],
	failSuffixFor: "",
	faults: 0,
	ambiguous: undefined as
		| { database: string; kind: "fence" | "replacement"; committed: boolean; recoveryFails?: boolean }
		| undefined,
	failRecoveryReadFor: "",
	issueAttempts: [] as DurableIssueCommit[],
	commitHandles: new Map<DurableIssueCommit, V3PlaneHandle | undefined>(),
	issuePlans: new Map<DurableIssueCommit, SettlementPlan | null>(),
	timeline: [] as { database: string; kind: "plan" | "commit" | "publication"; sequence?: number; revision?: number }[],
	ambiguities: [] as {
		database: string;
		candidate: DurableIssueCommit;
		handle: V3PlaneHandle | undefined;
		plan: SettlementPlan | null;
		lineage: { next: number; exhausted: boolean };
		row: DurableIssueCommit | null;
		publicationOffset: number;
		commitOffset: number;
	}[],
	publications: [] as { database: string; sequence: number; digest: string; handle: V3PlaneHandle | undefined }[],
	planWrites: [] as { database: string; plan: SettlementPlan }[],
	prunes: [] as {
		database: string;
		input: unknown;
		stack: string;
		receipt?: DurableIssuancePruningReceipt;
		error?: unknown;
	}[],
	cleanup: [] as { input: unknown; result: unknown }[],
	snapshots: [] as {
		input: Parameters<typeof import("@ts-drp/protocol-v3/snapshot-transfer").encodeSnapshotTransfer>[0];
		result: ReturnType<typeof import("@ts-drp/protocol-v3/snapshot-transfer").encodeSnapshotTransfer>;
	}[],
	closeGraphs: [] as {
		input: Parameters<typeof import("@ts-drp/compaction").deriveCloseSetHistoryCommitment>[0];
		result: Awaited<ReturnType<typeof import("@ts-drp/compaction").deriveCloseSetHistoryCommitment>>;
	}[],
}));

vi.mock("@ts-drp/protocol-v3/snapshot-transfer", async (importOriginal) => {
	const real = await importOriginal<typeof import("@ts-drp/protocol-v3/snapshot-transfer")>();
	return {
		...real,
		encodeSnapshotTransfer: (input: Parameters<typeof real.encodeSnapshotTransfer>[0]) => {
			const result = real.encodeSnapshotTransfer(input);
			observed.snapshots.push(structuredClone({ input, result }));
			return result;
		},
	};
});

vi.mock("@ts-drp/compaction", async (importOriginal) => {
	const real = await importOriginal<typeof import("@ts-drp/compaction")>();
	return {
		...real,
		deriveCloseSetHistoryCommitment: async (input: Parameters<typeof real.deriveCloseSetHistoryCommitment>[0]) => {
			const result = await real.deriveCloseSetHistoryCommitment(input);
			observed.closeGraphs.push({ input, result });
			return result;
		},
	};
});

// All aliases point at the existing implementations, sharing their actual opaque
// capability custody. No replacement trust, codec, checkpoint or activation result.
vi.mock(
	"../../packages/node/dist/src/creator-adoption.js",
	() => import("../../packages/node/src/creator-adoption.js")
);
vi.mock(
	"../../packages/node/dist/src/creator-adoption-stage.js",
	() => import("../../packages/node/src/creator-adoption-stage.js")
);
vi.mock(
	"../../packages/node/dist/src/creator-adoption-recover.js",
	() => import("../../packages/node/src/creator-adoption-recover.js")
);
vi.mock("../../packages/node/dist/src/creator-adoption-activate.js", async () => {
	const real = await import("../../packages/node/src/creator-adoption-activate.js");
	type ActivationRealm = typeof real;
	const realms = new Map<string, Promise<ActivationRealm>>();
	// Independent physical clients have independent module-local activeOwners.
	// Query-isolate ONLY that unchanged production module; its opaque intent,
	// handle-alias and recovery dependencies retain their exact shared identities.
	// A peer keeps its realm across close/reopen: only real room.close() releases
	// its ownership. Never clear/reset a production singleton to admit a peer.
	const realmFor = async (peerId: string): Promise<ActivationRealm> => {
		let pending = realms.get(peerId);
		if (pending === undefined) {
			const source = new URL("../../packages/node/src/creator-adoption-activate.ts", import.meta.url).href;
			pending = import(`${source}?f5bClient=${encodeURIComponent(peerId)}`) as Promise<ActivationRealm>;
			realms.set(peerId, pending);
		}
		const selected = await pending;
		for (const [otherId, other] of realms)
			if (otherId !== peerId)
				expect(selected.activateCreatorSuccessorAdoption, "F5B_INDEPENDENT_CLIENT_MODULE_REALM").not.toBe(
					(await other).activateCreatorSuccessorAdoption
				);
		return selected;
	};
	const capture =
		(name: "activateCreatorSuccessorAdoption" | "reopenCreatorSuccessorAdoption") => async (input: unknown) => {
			const network = Reflect.get(input as object, "networkNode") as { peerId: string };
			expect(network.peerId, "F5B_PHYSICAL_CLIENT_TRANSPORT_IDENTITY").toMatch(
				/^d110c-f5b-parent-\d+-peer-\d+(?:-fresh)?$/u
			);
			const realm = await realmFor(network.peerId);
			const result = await realm[name](input);
			if (result.ok === true) {
				observed.planes.set(network.peerId, result.handle as V3PlaneHandle);
			}
			return result;
		};
	return {
		...real,
		activateCreatorSuccessorAdoption: capture("activateCreatorSuccessorAdoption"),
		reopenCreatorSuccessorAdoption: capture("reopenCreatorSuccessorAdoption"),
	};
});

vi.mock("../../packages/node/src/internal/closed-epoch-cleanup.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../packages/node/src/internal/closed-epoch-cleanup.js")>();
	return {
		...real,
		planClosedEpochCleanup: (input: unknown) => {
			const result = real.planClosedEpochCleanup(input);
			observed.cleanup.push({ input, result });
			return result;
		},
	};
});

vi.mock("../../packages/node/src/internal/creator-transition-advance.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../packages/node/src/internal/creator-transition-advance.js")>();
	return {
		...real,
		inspectCreatorTransitionAdvance: (...args: Parameters<typeof real.inspectCreatorTransitionAdvance>) => {
			observed.advances.push(args[0] as unknown as Record<string, unknown>);
			return real.inspectCreatorTransitionAdvance(...args);
		},
	};
});

vi.mock("../../packages/storage-browser/dist/src/issuance.js", async () => {
	const real = await import("../../packages/storage-browser/src/issuance.js");
	const { browserIssuanceImplementationForTest } = await import(
		"../../packages/storage-browser/src/internal/browser-issuance-store.js"
	);
	const { DurableIssuanceUnknownOutcomeError } = await import("../../packages/issuance-store/src/contract.js");
	return {
		...real,
		createBrowserDurableIssuanceStore: async (input: { primaryDatabaseName: string }) => {
			const store = await real.createBrowserDurableIssuanceStore(input);
			const transactIssue = store.transactIssue;
			const readLineage = store.readLineage;
			Reflect.set(store, "readLineage", (scope: Parameters<typeof readLineage>[0]) => {
				if (observed.failRecoveryReadFor === input.primaryDatabaseName)
					return Promise.reject(new Error("F5B_RECOVERY_DURABLE_READ_UNAVAILABLE"));
				return readLineage(scope);
			});
			const ambiguousReadback = async (candidate: DurableIssueCommit) => {
				const scope = candidate.issuedRecord.scope;
				observed.ambiguities.push({
					database: input.primaryDatabaseName,
					candidate,
					handle: observed.planes.get(input.primaryDatabaseName),
					plan: await store.readSettlementPlan(scope),
					lineage: await readLineage(scope),
					row: await store.readIssued(scope, candidate.authorSequence),
					publicationOffset: observed.publications.length,
					commitOffset: observed.commits.length,
				});
			};
			// Observe methods on the EXACT backend facade. Its existing maintenance
			// WeakMap identity remains intact; no capability is minted or rebound.
			Reflect.set(store, "transactIssue", (async (scope, build) => {
				let selected: DurableIssueCommit | undefined;
				const ambiguity = observed.ambiguous?.database === input.primaryDatabaseName ? observed.ambiguous : undefined;
				const result = await transactIssue(scope, async (sequence) => {
					const candidate = await build(sequence);
					observed.issuePlans.set(candidate, structuredClone(await store.readSettlementPlan(scope)));
					observed.issueAttempts.push(candidate);
					const effect = candidate.planEffect;
					if (ambiguity !== undefined && ambiguity.kind === effect?.kind && !ambiguity.committed) {
						await ambiguousReadback(candidate);
						if (ambiguity.recoveryFails === true) observed.failRecoveryReadFor = input.primaryDatabaseName;
						observed.ambiguous = undefined;
						throw new DurableIssuanceUnknownOutcomeError(scope);
					}
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
				if (selected !== undefined) {
					observed.commits.push(selected);
					observed.timeline.push({
						database: input.primaryDatabaseName,
						kind: "commit",
						sequence: selected.authorSequence,
					});
					observed.commitHandles.set(selected, observed.planes.get(input.primaryDatabaseName));
				}
				if (ambiguity !== undefined && ambiguity.kind === selected?.planEffect?.kind && ambiguity.committed) {
					await ambiguousReadback(selected);
					if (ambiguity.recoveryFails === true) observed.failRecoveryReadFor = input.primaryDatabaseName;
					observed.ambiguous = undefined;
					throw new DurableIssuanceUnknownOutcomeError(scope);
				}
				return result;
			}) satisfies DurableIssuanceStore["transactIssue"]);
			const publish = store.compareAndMarkOutboxPublished;
			Reflect.set(store, "compareAndMarkOutboxPublished", (async (value) => {
				await publish(value);
				observed.timeline.push({
					database: input.primaryDatabaseName,
					kind: "publication",
					sequence: value.authorSequence,
				});
				observed.publications.push({
					database: input.primaryDatabaseName,
					sequence: value.authorSequence,
					digest: Buffer.from(value.digest).toString("hex"),
					handle: observed.planes.get(input.primaryDatabaseName),
				});
			}) satisfies DurableIssuanceStore["compareAndMarkOutboxPublished"]);
			const writePlan = store.transactWriteSettlementPlan;
			Reflect.set(store, "transactWriteSettlementPlan", (async (value) => {
				const plan = await writePlan(value);
				observed.planWrites.push({ database: input.primaryDatabaseName, plan: structuredClone(plan) });
				observed.timeline.push({ database: input.primaryDatabaseName, kind: "plan", revision: plan.revision });
				return plan;
			}) satisfies DurableIssuanceStore["transactWriteSettlementPlan"]);
			const implementation = browserIssuanceImplementationForTest(store);
			if (implementation === undefined) throw new Error("F5B_NATIVE_ISSUANCE_IDENTITY_LOST");
			const prune = implementation.pruneAuthenticatedSettledPrefix.bind(implementation);
			// Forward without a global spy registry retaining every closed store owner.
			Reflect.set(implementation, "pruneAuthenticatedSettledPrefix", async (value: Parameters<typeof prune>[0]) => {
				const event: (typeof observed.prunes)[number] = {
					database: input.primaryDatabaseName,
					input: structuredClone(value),
					stack: new Error().stack ?? "",
				};
				observed.prunes.push(event);
				try {
					return (event.receipt = await prune(value));
				} catch (error) {
					event.error = error;
					throw error;
				}
			});
			observed.stores.set(input.primaryDatabaseName, store);
			return store;
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
/** Renders exact protocol bytes for evidence identity comparisons. */
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
/** Decodes a fixture-owned canonical record without changing its bytes. */
const record = (value: Uint8Array) => decodeCanonical(value) as Record<string, unknown>;
const STALE_LOCAL_HEAD_FAILURE =
	"v3 room successor reopen failed: D110C_FLOOR_MISMATCH: creator successor differs from the authenticated room-head floor";
let ordinal = 0;

const wideDiagnosticState = {
	enabled: process.env.TS_DRP_F5B_WIDE_DIAGNOSTIC === "1",
	records: 0,
	completedOrdinaryIssues: 0,
	epoch: null as number | null,
	startNs: 0n,
	previousUser: 0,
	previousSystem: 0,
	writeFailures: 0,
};

/** Emits bounded opt-in progress without retaining sampled product objects. */
function wideDiagnostic(
	phase: string,
	edge: string,
	epoch: number | null = null,
	peer: string | null = null,
	completed: boolean | null = null
): void {
	if (!wideDiagnosticState.enabled || wideDiagnosticState.records >= 4096) return;
	try {
		const now = process.hrtime.bigint();
		const cpu = process.cpuUsage();
		const eventLoop = performance.eventLoopUtilization();
		if (wideDiagnosticState.records === 0) {
			wideDiagnosticState.startNs = now;
			wideDiagnosticState.previousUser = cpu.user;
			wideDiagnosticState.previousSystem = cpu.system;
		}
		if (phase === "epoch" && edge === "begin") wideDiagnosticState.epoch = epoch;
		if (phase === "ordinary-issue" && edge === "end") wideDiagnosticState.completedOrdinaryIssues += 1;
		wideDiagnosticState.records += 1;
		const overflow = wideDiagnosticState.records === 4096;
		writeSync(
			1,
			`${JSON.stringify({
				kind: "F5B_WIDE_DIAGNOSTIC",
				sequence: wideDiagnosticState.records,
				phase: overflow ? "diagnostic-overflow" : phase,
				edge: overflow ? "limit" : edge,
				epoch: epoch ?? wideDiagnosticState.epoch,
				peer,
				completed,
				completedOrdinaryIssues: wideDiagnosticState.completedOrdinaryIssues,
				elapsedMs: Number(now - wideDiagnosticState.startNs) / 1_000_000,
				cpuScope: "process-aggregate-including-overlapping-work",
				cpuUserMicros: cpu.user,
				cpuSystemMicros: cpu.system,
				eventLoopIdleMs: eventLoop.idle,
				eventLoopActiveMs: eventLoop.active,
				eventLoopUtilization: eventLoop.utilization,
				deltaUserMicros: cpu.user - wideDiagnosticState.previousUser,
				deltaSystemMicros: cpu.system - wideDiagnosticState.previousSystem,
				writeFailures: wideDiagnosticState.writeFailures,
			})}\n`
		);
		wideDiagnosticState.previousUser = cpu.user;
		wideDiagnosticState.previousSystem = cpu.system;
	} catch {
		wideDiagnosticState.writeFailures += 1;
	}
}

/** Makes missing evidence a hard fixture failure rather than an optional check. */
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
	const namespace = /^(d110c-f5b-parent-\d+-peer-)(0|[1-9]\d*)(-fresh)?(--ahe|--drp-snapshot-quarantine-v1)$/u;
	const sourceScope = namespace.exec(sourceName);
	const targetScope = namespace.exec(targetName);
	if (
		sourceName === targetName ||
		sourceScope === null ||
		targetScope === null ||
		sourceScope[1] !== targetScope[1] ||
		sourceScope[2] !== "0" ||
		sourceScope[3] !== undefined ||
		targetScope[2] === "0" ||
		sourceScope[4] !== targetScope[4]
	)
		throw new TypeError("F5B_TRANSFER_DATABASE_SCOPE_INVALID");
	const schema =
		sourceScope[4] === "--ahe"
			? PHASE_5E_SCHEMA_AUTHORITY
			: {
					version: 1,
					stores: [
						{
							name: "chunks",
							keyPath: ["objectId", "epoch", "anchor", "manifestDigest", "index"],
							autoIncrement: false,
							indexes: [],
						},
						{
							name: "scopes",
							keyPath: ["objectId", "epoch", "anchor", "manifestDigest"],
							autoIncrement: false,
							indexes: [{ name: "expiryAsc", keyPath: "expiresAt", unique: false, multiEntry: false }],
						},
					],
				};
	const expectedStores = [...schema.stores].sort((left, right) => left.name.localeCompare(right.name));
	const schemaFor = async (database: IDBDatabase) => {
		const transaction = database.transaction([...database.objectStoreNames], "readonly");
		const complete = transactionDone(transaction);
		const stores = [...database.objectStoreNames].map((name) => {
			const owner = transaction.objectStore(name);
			return {
				name,
				keyPath: owner.keyPath,
				autoIncrement: owner.autoIncrement,
				indexes: [...owner.indexNames].map((indexName) => {
					const index = owner.index(indexName);
					return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
				}),
			};
		});
		await complete;
		return stores;
	};
	const databases = await indexedDB.databases();
	const existingTarget = databases.find((database) => database.name === targetName);
	for (const name of existingTarget === undefined ? [sourceName] : [sourceName, targetName]) {
		expect(
			databases.find((database) => database.name === name),
			"F5B_TRANSFER_EXISTING_SUPPORTED_DATABASE"
		).toEqual({ name, version: schema.version });
	}
	const source = await request(indexedDB.open(sourceName));
	try {
		expect(await schemaFor(source), "F5B_TRANSFER_SOURCE_EXACT_SCHEMA_NO_COUNTERS").toEqual(expectedStores);
		if (existingTarget !== undefined) {
			const previous = await request(indexedDB.open(targetName));
			try {
				expect(await schemaFor(previous), "F5B_TRANSFER_TARGET_EXACT_SCHEMA_NO_EXTRAS").toEqual(expectedStores);
			} finally {
				previous.close();
			}
		}
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

/** Models the explicitly trusted external room-head account for one fixture peer. */
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

/** Composes genuine signed peers and durable stores with an observable local transport. */
async function openRoom(
	writerCount: number,
	legacy = false,
	secondaryAdmin = false,
	transientPayload = false,
	applicationFactory?: (input: {
		identities: readonly { author: string; seed: Uint8Array }[];
		creatorPeerId: string;
	}) => CreateV3RoomSessionInput["application"]
) {
	const id = ++ordinal;
	const objectId = `creator:${(8000 + id).toString(16).padStart(32, "0")}`;
	const identities = Array.from({ length: writerCount }, (_, index) => {
		const seed = new Uint8Array(32);
		seed[0] = 121;
		seed[1] = index + 1;
		return { seed, author: hex(ed25519.getPublicKey(seed)) };
	});
	const creator = required(identities[0]);
	const base =
		applicationFactory === undefined
			? transientPayload
				? createTransientPayloadApplication()
				: createV3ChatApplication("alice")
			: applicationFactory({ identities, creatorPeerId: `d110c-f5b-parent-${id}-peer-0` });
	const observeEmissions = transientPayload || applicationFactory !== undefined;
	const signers = [{ publicKey: creator.author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(base.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes:
			applicationFactory === undefined
				? encodeCanonical([])
				: required(base.migration).canonicalStateBytes(
						base.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
					),
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
					groups:
						index === 0
							? ["admin", "finality", "writer"]
							: secondaryAdmin && index === 1
								? ["admin", "writer"]
								: ["writer"],
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
	const held = new Set<string>();
	const publicationFailures = new Set<string>();
	const heldApplications = new Set<string>();
	const envelopes: Message[] = [];
	const peers: Peer[] = [];
	const emitted = new Map<
		string,
		{
			generation: number;
			owner?: V3RoomSession;
			emissions: number;
			bytes?: Uint8Array;
		}
	>();
	const observeProjection = (
		databaseName: string,
		application: CreateV3RoomSessionInput["application"]
	): CreateV3RoomSessionInput["onProjection"] => {
		const migration = required(application.migration);
		const cell = { generation: (emitted.get(databaseName)?.generation ?? 0) + 1, emissions: 0 } as {
			generation: number;
			owner?: V3RoomSession;
			emissions: number;
			bytes?: Uint8Array;
		};
		emitted.set(databaseName, cell);
		return (projection) => {
			// Encode the exact branded callback value before copying bytes. This is
			// emitted projection evidence, not an independent commit receipt: room
			// assigns its projection synchronously after this callback returns.
			const bytes = migration.canonicalStateBytes(projection);
			cell.bytes = new Uint8Array(bytes);
			cell.emissions += 1;
		};
	};
	const emittedProjection = (peer: Peer) => {
		const cell = required(emitted.get(peer.databaseName));
		expect(cell.owner, "F5B_C03_EMITTED_PROJECTION_BINDS_CURRENT_OPEN_OWNER").toBe(peer.room);
		expect(cell.emissions, "F5B_C03_EVERY_OPEN_REQUIRES_FRESH_PROJECTION_EMISSION").toBeGreaterThan(0);
		return { generation: cell.generation, emissions: cell.emissions, bytes: required(cell.bytes).slice() };
	};
	const send = async (sender: string, message: Message) => {
		envelopes.push(structuredClone(message));
		if (publicationFailures.has(sender)) return false;
		if (heldApplications.has(sender)) {
			const action = (record(V3Envelope.decode(message.data).canonicalPreimage).operation as Record<string, unknown>)
				.action;
			if (action !== "$drp.author-fence.v1" && action !== "join" && action !== "causalJoin") return true;
		}
		if (held.has(sender) || sender === `d110c-f5b-parent-${id}-peer-0`) return true;
		const target = required(peers[0]);
		const envelope = V3Envelope.decode(message.data);
		const digest = hex(hashDomain("ts-drp/vertex/v3", envelope.canonicalPreimage));
		if (received.has(digest)) return true;
		const operation = record(envelope.canonicalPreimage).operation as Record<string, unknown>;
		required(ingress.get(target.databaseName))(message);
		// Control vertices intentionally have no application callback. A following
		// ordinary issue causally depends on them and supplies the admission ack.
		if (operation.action === "$drp.author-fence.v1" || operation.action === "join" || operation.action === "causalJoin")
			return true;
		// Bounded deterministic scheduling oracle: each real readonly IDB round
		// yields to queued ingress/storage work, with no sleep or elapsed-time test.
		// 256 is a fixture scheduling budget, never a product resource ceiling.
		for (let turn = 0; turn < 256 && !received.has(digest); turn += 1)
			await required(observed.stores.get(target.databaseName)).readLineage({ author: target.author, objectId });
		if (!received.has(digest)) throw new Error(`F5B_ROUTED_OPERATION_NOT_ADMITTED:${digest}`);
		return true;
	};
	const transportFor =
		(databaseName: string): CreateV3RoomSessionInput["openTransport"] =>
		() => {
			const networkNode = fakeNetwork(databaseName, false);
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
		};
	for (const [index, identity] of identities.entries()) {
		const databaseName = `d110c-f5b-parent-${id}-peer-${index}`;
		const floor = floorOwner();
		const application =
			applicationFactory === undefined
				? {
						...base,
						displacementPolicies: { message: "transform" as const },
						transformDisplacedOperation: transientPayload
							? required(base.transformDisplacedOperation)
							: (operation: Readonly<Record<string, unknown>>) => ({ ...operation, text: "r".repeat(256) }),
					}
				: base;
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
				}
			},
			onProjection: observeEmissions ? observeProjection(databaseName, application) : () => undefined,
			signRegisteredVertexDigest: (digest) => Promise.resolve(ed25519.sign(digest, identity.seed)),
			openTransport: transportFor(databaseName),
		};
		wideDiagnostic("initial-peer-open", "begin", 0, databaseName);
		const room = await createV3RoomSession(input);
		wideDiagnostic("initial-peer-open", "end", 0, databaseName);
		sessions.add(room);
		const peer = { ...identity, databaseName, floor, input, room };
		peers.push(peer);
		if (observeEmissions) {
			required(emitted.get(databaseName)).owner = room;
			emittedProjection(peer);
		}
	}
	const stop = async (peer: Peer) => {
		wideDiagnostic("peer-stop", "begin", null, peer.databaseName);
		await peer.room.close();
		sessions.delete(peer.room);
		wideDiagnostic("peer-stop", "end", null, peer.databaseName);
	};
	const reopen = async (peer: Peer, closedEpoch: number, transfer = false, application = peer.input.application) => {
		wideDiagnostic("reopen", "begin", closedEpoch + 1, peer.databaseName);
		await stop(peer);
		const origin = required(peers[0]);
		if (transfer) {
			wideDiagnostic("ahe-transfer", "begin", closedEpoch + 1, peer.databaseName);
			await transferDatabase(`${origin.databaseName}--ahe`, `${peer.databaseName}--ahe`);
			wideDiagnostic("ahe-transfer", "end", closedEpoch + 1, peer.databaseName);
			wideDiagnostic("snapshot-transfer", "begin", closedEpoch + 1, peer.databaseName);
			await transferDatabase(
				`${origin.databaseName}--drp-snapshot-quarantine-v1`,
				`${peer.databaseName}--drp-snapshot-quarantine-v1`
			);
			wideDiagnostic("snapshot-transfer", "end", closedEpoch + 1, peer.databaseName);
			peer.floor.receive(origin.floor.read());
		}
		wideDiagnostic("snapshot-declaration", "begin", closedEpoch + 1, peer.databaseName);
		const declaration = await producedDeclaration(peer.databaseName, closedEpoch);
		wideDiagnostic("snapshot-declaration", "end", closedEpoch + 1, peer.databaseName);
		const { creatorFinalitySigner, ...reopenInput } = peer.input;
		wideDiagnostic("reopen-session", "begin", closedEpoch + 1, peer.databaseName);
		peer.room = await createV3RoomSession({
			...reopenInput,
			// Legacy keeps its existing restriction. Settlement creator restart must
			// authenticate this existing input pair and rebind close authority.
			...(!legacy && creatorFinalitySigner !== undefined ? { creatorFinalitySigner } : {}),
			application,
			onProjection: observeEmissions ? observeProjection(peer.databaseName, application) : reopenInput.onProjection,
			roomHeadAuthority: { ...peer.floor.authority, initialization: { kind: "reopen" } },
			successorSnapshotDeclaration: declaration,
		});
		wideDiagnostic("reopen-session", "end", closedEpoch + 1, peer.databaseName);
		sessions.add(peer.room);
		if (observeEmissions) {
			required(emitted.get(peer.databaseName)).owner = peer.room;
			emittedProjection(peer);
		}
		wideDiagnostic("reopen", "end", closedEpoch + 1, peer.databaseName);
	};
	const issue = (peer: Peer, clientOperationId: string) =>
		peer.room.issue({ action: "message", clientOperationId, text: clientOperationId });
	const close = async () => {
		const origin = required(peers[0]);
		try {
			return await origin.room.sealEpoch();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (detail === "creator close actor failed: CERTIFIED_VALUE_MISMATCH") {
				// The first preserved run established this earlier compatibility seam.
				// Pin all five successor/cold-checkpoint sites; do not substitute a profile,
				// checkpoint, signature, successful actor result or synthetic authority.
				const source = readFileSync(
					new URL("../../packages/protocol-v3/src/creator-close.ts", import.meta.url),
					"utf8"
				);
				const owner = (name: string) => {
					const start = source.indexOf(`export function ${name}(`);
					expect(start, `F5B_SUCCESSOR_CODEC_OWNER_${name}`).toBeGreaterThanOrEqual(0);
					const next = source.indexOf("\nexport function ", start + 1);
					return source.slice(start, next === -1 ? undefined : next);
				};
				expect(owner("prepareCreatorAnchorSigningRequest"), "F5B_SUCCESSOR_PROFILE_PREPARATION_V1_ONLY").toContain(
					'profile.profileId !== "creator-trusted-v1"'
				);
				expect(owner("completeCreatorSuccessor"), "F5B_SUCCESSOR_PROFILE_COMPLETION_V1_ONLY").toContain(
					'profileId: "creator-trusted-v1"'
				);
				expect(owner("openCreatorSuccessorTrust"), "F5B_SUCCESSOR_PROFILE_OPEN_V1_ONLY").toContain(
					'decodedRecord.profileId !== "creator-trusted-v1"'
				);
				const checkpointSource = readFileSync(
					new URL("../../packages/protocol-v3/src/creator-checkpoint.ts", import.meta.url),
					"utf8"
				);
				expect(
					checkpointSource.slice(
						checkpointSource.indexOf("function trustRecord("),
						checkpointSource.indexOf("function bytesHex(")
					),
					"F5B_CHECKPOINT_CURRENT_PROFILE_V1_ONLY"
				).toContain('decoded.profileId !== "creator-trusted-v1"');
				expect(
					checkpointSource.slice(
						checkpointSource.indexOf("const genesisRecordBytes = encodeCanonical({"),
						checkpointSource.indexOf("const genesis = openCurrentAnchorTrust({")
					),
					"F5B_CHECKPOINT_RECONSTRUCTED_GENESIS_PROFILE_V1_ONLY"
				).toContain('profileId: "creator-trusted-v1"');
				throw new Error(
					"F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED: genuine settlement successor fails CERTIFIED_VALUE_MISMATCH before checkpoint production",
					{ cause: error }
				);
			}
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
		return {
			capability: opened.capability,
			identity: required(resolveCreatorAuthorSettlement(opened.capability)),
			bytes: settled.bytes,
			cut: record(cut.bytes),
			candidates: proposed.candidates,
		};
	};
	const deliver = (message: Message) => required(ingress.get(required(peers[0]).databaseName))(message);
	return {
		peers,
		emittedProjection,
		objectId,
		issue,
		close,
		checkpoint,
		reopen,
		stop,
		transportFor,
		held,
		publicationFailures,
		heldApplications,
		envelopes,
		deliver,
		received,
	};
}

/** Enumerates a peer's real durable issuance lineage and outbox to exhaustion. */
async function durable(peer: Peer) {
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: peer.databaseName });
	try {
		const scope = { author: peer.author, objectId: peer.input.objectId };
		const lineage = await store.readLineage(scope);
		const plan = await store.readSettlementPlan(scope);
		const rows: Awaited<ReturnType<typeof store.readOutboxPage>>[number][] = [];
		let afterKey: readonly [string, string, number] | null = null;
		for (;;) {
			const page = await store.readOutboxPage({ scope, limit: 128, afterKey });
			if (page.length === 0) break;
			for (const row of page) {
				expect(row.commit.outboxEntry.scope, "F5B_DURABLE_CENSUS_EXACT_SCOPE").toEqual(scope);
				expect(row.commit.authorSequence, "F5B_DURABLE_CENSUS_STRICT_CURSOR_PROGRESS").toBeGreaterThan(
					afterKey?.[2] ?? -1
				);
				rows.push(row);
				afterKey = [scope.objectId, scope.author, row.commit.authorSequence];
			}
		}
		return { lineage, plan, rows };
	} finally {
		await store.close();
	}
}

/** Reads canonical state through the application's production projection surface. */
function productState(peer: Peer): Uint8Array {
	return required(peer.input.application.migration).canonicalStateBytes(peer.room.projection());
}
/** Reads the physical active head and generation census from durable storage. */
async function aheFacts(peer: Peer) {
	const store = await createBrowserAheDurableStore({ databaseName: `${peer.databaseName}--ahe` });
	try {
		const objectId = parseStorageObjectId(peer.input.objectId);
		if (!objectId.ok) throw new Error("F5B_REAL_OBJECT_ID_REQUIRED");
		const recovered = await store.recoverActiveGeneration(objectId.value);
		expect(recovered.ok, "F5B_C24C_GENUINE_ACTIVE_HEAD_RECOVERY").toBe(true);
		if (!recovered.ok || recovered.value.kind !== "active") throw new Error("F5B_ACTIVE_GENERATION_REQUIRED");
		const generations: GenerationRecord[] = [];
		let cursor: Parameters<typeof store.readGenerationPage>[0]["cursor"];
		do {
			const page = await store.readGenerationPage({
				objectId: objectId.value,
				limit: 64,
				...(cursor === undefined ? {} : { cursor }),
			});
			if (!page.ok) throw new Error(`F5B_AHE_ENUMERATION_${page.reason}`);
			generations.push(...page.value.generations);
			cursor = page.value.nextCursor ?? undefined;
		} while (cursor !== undefined);
		return { head: recovered.value.head, generations };
	} finally {
		await store.close();
	}
}

/** Verifies authenticated cleanup retained only the complete rollback lineage. */
async function assertRetainedRollbackPair(peer: Peer) {
	const cleanup = observed.cleanup.findLast((event) => {
		const input = event.input as { issuance?: { scope?: { author?: string } }; close?: { objectId?: string } };
		return input.issuance?.scope?.author === peer.author && input.close?.objectId === peer.input.objectId;
	});
	expect(required(cleanup).result, "F5B_C13_C24C_REAL_AUTHENTICATED_CLEANUP_BEFORE_CENSUS").toMatchObject({ ok: true });
	const facts = await aheFacts(peer);
	const retained = facts.generations.filter((generation) => generation.state === "Superseded");
	// Cleanup retains physical generations, including preparation/close ancestors.
	const expected = 2;
	expect(retained, "F5B_C13_C24C_PRODUCT_TRUE_BOUNDED_ROLLBACK_WINDOW").toHaveLength(expected);
	expect(facts.generations, "F5B_C13_BOUNDED_ACTIVE_AND_ROLLBACK_GENERATIONS").toHaveLength(expected + 1);
	const active = required(facts.generations.find((generation) => generation.generationId === facts.head.generationId));
	expect(active.state).toBe("Adopted");
	let base = active.baseExpectedHead;
	for (let index = 0; index < expected; index += 1) {
		if (base.kind !== "present") throw new Error("F5B_C13_ROLLBACK_LINEAGE_GAP");
		const id = base.generationId;
		const prior = required(retained.find((generation) => generation.generationId === id));
		expect(prior.closure.length, "F5B_C13_RETAINED_COMPLETE_CLOSURE").toBeGreaterThan(0);
		expect(prior.closureDigest).toBe(base.closureDigest);
		base = prior.baseExpectedHead;
	}
	return facts;
}

export {
	aheFacts,
	assertRetainedRollbackPair,
	observed,
	sessions,
	originalStorage,
	hex,
	record,
	STALE_LOCAL_HEAD_FAILURE,
	wideDiagnostic,
	required,
	floorOwner,
	type Peer,
	openRoom,
	durable,
	productState,
};

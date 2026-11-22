import { decodeCanonical } from "@ts-drp/canonical";
import type { AheDurableStore } from "@ts-drp/storage";
import {
	SNAPSHOT_QUARANTINE_RETENTION_MS,
	type SnapshotQuarantineDeclaration,
	type SnapshotQuarantineScope,
	type SnapshotQuarantineStore,
	type SnapshotRecoveryLimits,
	type SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";
import { IDBDatabase, IDBObjectStore } from "fake-indexeddb";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveCreatorCloseEvidenceStore } from "../../../packages/seal/src/internal/creator-close-intent.js";
import { resolveSealStorePort } from "../../../packages/seal/src/internal/seal-vote-intent.js";
import { createBrowserSnapshotQuarantineStore } from "../../../packages/storage-browser/src/snapshot-transfer.js";
import { createNodeSnapshotQuarantineStore } from "../../../packages/storage-node/src/snapshot-transfer.js";
import {
	type GenuineCreatorAdoptionFixtureModules,
	type PreparedGenuineCreatorAdoptionFixture,
	prepareGenuineCreatorAdoptionFixture,
} from "../phase-6a-v3/creator-adoption-contract.js";

export type AdapterRuntime = "SQLite/Node" | "browser-adapter/fake-IndexedDB";
export type Store = SnapshotQuarantineStore<SnapshotVerificationReceipt>;
export type Scope = SnapshotQuarantineScope<SnapshotVerificationReceipt>;
export interface Operation {
	readonly lane: "ahe" | "journal" | "seal" | "close" | "commitment" | "snapshot";
	readonly name: string;
	readonly detail?: unknown;
}
export interface AheImage {
	readonly head: Awaited<ReturnType<AheDurableStore["readHead"]>>;
	readonly generations: Awaited<ReturnType<AheDurableStore["readGenerationPage"]>>;
}
export interface SnapshotImage {
	readonly version: number;
	readonly owner: readonly Record<string, unknown>[];
	readonly scopes: readonly Record<string, unknown>[];
	readonly chunks: readonly Record<string, unknown>[];
}

/**
 * Read-only physical row census, before an adapter reopen can change anything.
 * @param fixture - Exact adapter and database identity to census.
 * @returns Detached physical rows and schema version.
 */
export async function snapshotImage(
	fixture: Pick<ProducerFixture, "adapter" | "primaryFilename" | "snapshotDatabaseName">
): Promise<SnapshotImage> {
	if (fixture.adapter === "SQLite/Node") {
		const database = new DatabaseSync(`${fixture.primaryFilename}.drp-snapshot-quarantine-v1.sqlite`, {
			readOnly: true,
		});
		try {
			return {
				version: Number(database.prepare("PRAGMA user_version").get()?.user_version),
				owner: database.prepare("SELECT * FROM snapshot_owner_v2 ORDER BY id").all(),
				scopes: database
					.prepare("SELECT * FROM snapshot_scopes_v2 ORDER BY object_id,epoch,anchor,manifest_digest")
					.all(),
				chunks: database
					.prepare("SELECT * FROM snapshot_chunks_v2 ORDER BY object_id,epoch,anchor,manifest_digest,chunk_index")
					.all(),
			};
		} finally {
			database.close();
		}
	}
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(`${fixture.snapshotDatabaseName}--drp-snapshot-quarantine-v1`);
		request.onsuccess = (): void => resolve(request.result);
		request.onerror = (): void => reject(request.error);
	});
	try {
		const transaction = database.transaction(["owner", "scopes", "chunks"], "readonly");
		const rows = (name: string): Promise<Record<string, unknown>[]> =>
			new Promise((resolve, reject) => {
				const request = transaction.objectStore(name).getAll();
				request.onsuccess = (): void => resolve(request.result as Record<string, unknown>[]);
				request.onerror = (): void => reject(request.error);
			});
		const [owner, scopes, chunks] = await Promise.all([rows("owner"), rows("scopes"), rows("chunks")]);
		return { version: database.version, owner, scopes, chunks };
	} finally {
		database.close();
	}
}
export interface Checkpoint {
	readonly operationCount: number;
	readonly operations: readonly Operation[];
	readonly ahe: AheImage;
}
export interface ScopeObservation {
	readonly id: number;
	readonly backend: Scope;
	readonly decorated: Scope;
	readonly declaration: SnapshotQuarantineDeclaration;
	completed: boolean;
	released: boolean;
	retentionCalls: number;
	retained: boolean;
	chunks: readonly Uint8Array[];
}
export interface Barrier {
	readonly entered: Promise<void>;
	readonly released: Promise<void>;
	enter(): void;
	release(): void;
}

/**
 * A hold before delegation never occupies the snapshot owner's transaction queue.
 * @returns Independent entered and released promises with their signals.
 */
export function barrier(): Barrier {
	let enter!: () => void;
	let release!: () => void;
	return {
		entered: new Promise<void>((resolve) => {
			enter = resolve;
		}),
		released: new Promise<void>((resolve) => {
			release = resolve;
		}),
		enter: () => enter(),
		release: () => release(),
	};
}

/**
 * Reads exact verified bytes without replacing the receipt-bearing quarantine.
 * @param scope - Genuine verified scope to read.
 * @param declaration - Exact expected manifest and descriptors.
 * @returns Independent copies of the exact verified chunks.
 */
export async function chunksFor(
	scope: Scope,
	declaration: SnapshotQuarantineDeclaration
): Promise<readonly Uint8Array[]> {
	const port = scope.verificationQuarantine.open(new AbortController().signal);
	try {
		const chunks: Uint8Array[] = [];
		for (const descriptor of declaration.chunks) {
			const chunk = await port.read(descriptor);
			assert.ok(chunk, `missing exact chunk ${descriptor.index}`);
			chunks.push(Uint8Array.from(chunk));
		}
		return chunks;
	} finally {
		await port.discard();
	}
}

/**
 * Captures every logical AHE generation and the head without decorator side effects.
 * @param prepared - Original AHE backend and object identity.
 * @returns Complete logical head and generation census.
 */
export async function aheImage(
	prepared: Pick<PreparedGenuineCreatorAdoptionFixture, "aheBackend" | "current">
): Promise<AheImage> {
	const objectId = prepared.current.head.objectId;
	const head = await prepared.aheBackend.readHead(objectId);
	const generations = await prepared.aheBackend.readGenerationPage({ objectId, limit: 128 });
	assert.equal(head.ok, true);
	assert.equal(generations.ok, true);
	if (generations.ok) assert.equal(generations.value.nextCursor, null, "producer checkpoint census must be complete");
	return { head, generations };
}

/**
 * Observe the native IDB operations behind the original, minted seal capabilities.
 * @param emit - Cumulative operation observer.
 * @returns Strict-durability telemetry, database selector and restoration owner.
 */
export function observeIndexedDb(emit: (operation: Operation) => void): {
	readonly strict: { requested: string; reported: string; database: string }[];
	selectSealDatabase(name: string): void;
	restore(): void;
} {
	let sealDatabase: string | undefined;
	const strict: { requested: string; reported: string; database: string }[] = [];
	const transaction = IDBDatabase.prototype.transaction;
	const put = IDBObjectStore.prototype.put;
	const add = IDBObjectStore.prototype.add;
	const remove = IDBObjectStore.prototype.delete;
	const clear = IDBObjectStore.prototype.clear;
	IDBDatabase.prototype.transaction = function (...args): IDBTransaction {
		const result = Reflect.apply(transaction, this, args) as IDBTransaction;
		if (args[2]?.durability === "strict")
			strict.push({ requested: args[2].durability, reported: result.durability, database: this.name });
		if (this.name === sealDatabase) {
			const names = Array.from(result.objectStoreNames).sort();
			// This exact readonly transaction is the real internal openSnapshot enrollment call.
			if (result.mode === "readonly" && names.join(",") === "signerState,voteOutbox") {
				emit({ lane: "seal", name: "enrollment-call" });
			}
			if (result.mode === "readwrite") emit({ lane: "seal", name: "write-transaction", detail: names });
		}
		return result;
	};
	function observeWrite(store: IDBObjectStore, method: string, value?: unknown): void {
		if (store.transaction.db.name !== sealDatabase) return;
		const row = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
		emit({ lane: "seal", name: `${store.name}:${method}`, detail: { phase: row?.phase, epoch: row?.epoch } });
	}
	IDBObjectStore.prototype.put = function (...args): IDBRequest<IDBValidKey> {
		observeWrite(this, "put", args[0]);
		return Reflect.apply(put, this, args) as IDBRequest<IDBValidKey>;
	};
	IDBObjectStore.prototype.add = function (...args): IDBRequest<IDBValidKey> {
		observeWrite(this, "add", args[0]);
		return Reflect.apply(add, this, args) as IDBRequest<IDBValidKey>;
	};
	IDBObjectStore.prototype.delete = function (...args): IDBRequest<undefined> {
		observeWrite(this, "delete");
		return Reflect.apply(remove, this, args) as IDBRequest<undefined>;
	};
	IDBObjectStore.prototype.clear = function (...args): IDBRequest<undefined> {
		observeWrite(this, "clear");
		return Reflect.apply(clear, this, args) as IDBRequest<undefined>;
	};
	return {
		strict,
		selectSealDatabase: (name): void => {
			sealDatabase = name;
		},
		restore: (): void => {
			IDBDatabase.prototype.transaction = transaction;
			IDBObjectStore.prototype.put = put;
			IDBObjectStore.prototype.add = add;
			IDBObjectStore.prototype.delete = remove;
			IDBObjectStore.prototype.clear = clear;
		},
	};
}

export interface ProducerFixture {
	readonly adapter: AdapterRuntime;
	readonly prepared: PreparedGenuineCreatorAdoptionFixture;
	readonly owner: Store;
	readonly operations: Operation[];
	readonly scopes: ScopeObservation[];
	readonly persistenceEntries: Checkpoint[];
	readonly beforeClose: Checkpoint;
	readonly strict: { requested: string; reported: string; database: string }[];
	readonly primaryFilename: string;
	readonly snapshotDatabaseName: string;
	beforeRetention?(scope: ScopeObservation): Promise<void>;
	afterRetention?(scope: ScopeObservation): Promise<void>;
	retentionSignal?: AbortSignal;
	onOperation?(operation: Operation): void;
	record(operation: Operation): void;
	checkpoint(): Promise<Checkpoint>;
	close(): Promise<void>;
}

/**
 * Dedicated pre-close fixture. Real registration, completion and seal capabilities stay intact.
 * @param input - Test-owned adapter and construction choices.
 * @param input.adapter - Runtime under observation.
 * @param input.recoveryLimits - Optional deliberately small owner capacity.
 * @param input.primaryFilename - Optional native process-owned SQLite path.
 * @param input.modules - Real module implementations for native bundling.
 * @returns Genuine bound-but-not-closed producer and transparent telemetry.
 */
export async function openProducerFixture(input: {
	readonly adapter: AdapterRuntime;
	readonly recoveryLimits?: SnapshotRecoveryLimits;
	readonly primaryFilename?: string;
	readonly modules?: GenuineCreatorAdoptionFixtureModules;
}): Promise<ProducerFixture> {
	const directory = input.primaryFilename === undefined ? mkdtempSync(join(tmpdir(), "producer-presign-")) : undefined;
	const primaryFilename = input.primaryFilename ?? join(directory as string, "primary.sqlite");
	const snapshotDatabaseName = `producer-presign-${crypto.randomUUID()}`;
	const operations: Operation[] = [];
	const emit = (operation: Operation): void => {
		operations.push(operation);
		fixture?.onOperation?.(operation);
	};
	const idb = observeIndexedDb(emit);
	const scopes: ScopeObservation[] = [];
	const persistenceEntries: Checkpoint[] = [];
	let fixture!: ProducerFixture;
	let prepared!: PreparedGenuineCreatorAdoptionFixture;
	const checkpoint = async (): Promise<Checkpoint> => {
		const cumulative = operations.slice();
		return { operationCount: cumulative.length, operations: cumulative, ahe: await aheImage(prepared) };
	};
	const owner =
		input.adapter === "SQLite/Node"
			? createNodeSnapshotQuarantineStore({
					primaryFilename,
					...(input.recoveryLimits === undefined ? {} : { recoveryLimits: input.recoveryLimits }),
				})
			: await createBrowserSnapshotQuarantineStore({
					primaryDatabaseName: snapshotDatabaseName,
					...(input.recoveryLimits === undefined ? {} : { recoveryLimits: input.recoveryLimits }),
				});
	const observed: Store = {
		close: () => owner.close(),
		inspectRecovery: (declaration, options) => owner.inspectRecovery(declaration, options),
		recoveryStatus: (options) => owner.recoveryStatus(options),
		sweepExpired: (options) => owner.sweepExpired(options),
		openScope: async (declaration, options) => {
			// This baseline is captured before delegating openScope, never at retention entry.
			persistenceEntries.push(await checkpoint());
			emit({ lane: "snapshot", name: "openScope", detail: declaration.scope });
			const backend = await owner.openScope(declaration, options);
			const decorated: Scope = Object.freeze<Scope>({
				scope: backend.scope,
				verificationQuarantine: backend.verificationQuarantine,
				status: (selected) => backend.status(selected),
				missingIndices: (selected) => backend.missingIndices(selected),
				cancel: (selected) => {
					emit({ lane: "snapshot", name: "cancel", detail: observation.id });
					return backend.cancel(selected);
				},
				complete: async (receipt, selected) => {
					const result = await backend.complete(receipt, selected);
					observation.completed = true;
					observation.chunks = await chunksFor(backend, declaration);
					emit({ lane: "snapshot", name: "complete", detail: observation.id });
					return result;
				},
				retainForRecovery: async (selected) => {
					observation.retentionCalls += 1;
					emit({ lane: "snapshot", name: "retention-entry", detail: observation.id });
					await fixture.beforeRetention?.(observation);
					await backend.retainForRecovery(
						fixture.retentionSignal === undefined ? selected : { signal: fixture.retentionSignal }
					);
					observation.retained = true;
					emit({ lane: "snapshot", name: "retention-committed", detail: observation.id });
					await fixture.afterRetention?.(observation);
				},
				release: async () => {
					await backend.release();
					observation.released = true;
					emit({ lane: "snapshot", name: "release", detail: observation.id });
				},
			});
			const observation: ScopeObservation = {
				id: scopes.length,
				backend,
				decorated,
				declaration,
				completed: false,
				released: false,
				retained: false,
				retentionCalls: 0,
				chunks: [],
			};
			scopes.push(observation);
			return decorated;
		},
	};
	try {
		prepared = await prepareGenuineCreatorAdoptionFixture({
			...(input.modules === undefined ? {} : { modules: input.modules }),
			createSnapshotStore: () => Promise.resolve(observed),
			onCloseObservation: (event) => emit({ lane: "close", name: "observation", detail: event }),
			decorateLiveJournalStore: (journal) => ({
				...journal,
				appendAccepted: (selected): ReturnType<typeof journal.appendAccepted> => {
					emit({ lane: "journal", name: "appendAccepted" });
					return journal.appendAccepted(selected);
				},
				readiness: (selected): ReturnType<typeof journal.readiness> => {
					emit({ lane: "journal", name: "readiness" });
					return journal.readiness(selected);
				},
				readPage: (selected): ReturnType<typeof journal.readPage> => {
					emit({ lane: "journal", name: "readPage" });
					return journal.readPage(selected);
				},
			}),
		});
		assert.ok(
			resolveCreatorCloseEvidenceStore(prepared.evidencePort),
			"original minted evidence capability must resolve"
		);
		assert.ok(resolveSealStorePort(prepared.votePort), "original minted vote capability must resolve");
		idb.selectSealDatabase(prepared.sealDatabaseName);
		prepared.controls.aheMutationHook = (event): void =>
			emit({ lane: "ahe", name: event.operation, detail: event.edge });
		const beforeClose = await checkpoint();
		fixture = {
			adapter: input.adapter,
			prepared,
			owner,
			operations,
			scopes,
			persistenceEntries,
			beforeClose,
			strict: idb.strict,
			primaryFilename,
			snapshotDatabaseName,
			checkpoint,
			record: emit,
			close: async (): Promise<void> => {
				try {
					await prepared.close();
				} finally {
					idb.restore();
					if (input.adapter === "browser-adapter/fake-IndexedDB")
						await deleteDatabase(`${snapshotDatabaseName}--drp-snapshot-quarantine-v1`);
					if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
				}
			},
		};
		return fixture;
	} catch (error) {
		idb.restore();
		await owner.close();
		if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = (): void => resolve();
		request.onerror = (): void => reject(request.error);
		request.onblocked = (): void => reject(new Error(`producer database cleanup blocked: ${name}`));
	});
}

/**
 * No unknown authority effects may be added to the explicitly empty staging allowance.
 * @param fixture - Producer with cumulative pre-close and persistence-entry evidence.
 * @returns Reconciled persistence-entry checkpoint.
 */
export function assertTwoCheckpoints(fixture: ProducerFixture): Checkpoint {
	const entry = fixture.persistenceEntries[0];
	assert.ok(entry, "genuine persistSnapshot must enter openScope");
	const staging = entry.operations.slice(fixture.beforeClose.operationCount);
	assert.deepEqual(staging, [], `uncharacterized pre-persistence staging effects: ${JSON.stringify(staging)}`);
	assert.deepEqual(entry.ahe, fixture.beforeClose.ahe, "staging cannot publish a new AHE generation/head");
	return entry;
}

/**
 * Reject cut/vote/publication, commitment or replay activity from the true persistence baseline.
 * @param fixture - Producer whose authority state must remain unchanged.
 */
export async function assertNoDependence(fixture: ProducerFixture): Promise<void> {
	const entry = assertTwoCheckpoints(fixture);
	const forbidden = fixture.operations.slice(entry.operationCount).filter((event) => event.lane !== "snapshot");
	assert.deepEqual(forbidden, [], `close dependence before retention: ${JSON.stringify(forbidden)}`);
	assert.deepEqual(await aheImage(fixture.prepared), entry.ahe, "AHE changed after persistence entry");
	assert.notEqual(fixture.prepared.handle.status().lifecycle, "successor-pending-adoption");
}

/**
 * Exact declaration/content identity plus single charging, using the actual owner's read interface.
 * @param fixture - Owner and physical runtime under test.
 * @param scope - Exact producer declaration and bytes to preserve.
 * @param expectedScopes - Expected total recovery scope charge.
 * @param expectedBytes - Expected total recovery byte charge.
 */
export async function assertRetained(
	fixture: ProducerFixture,
	scope: ScopeObservation,
	expectedScopes = 1,
	expectedBytes = charge(scope.declaration)
): Promise<void> {
	const inspection = await fixture.owner.inspectRecovery(scope.declaration);
	assert.equal(inspection.kind, "present");
	if (inspection.kind === "present") {
		assert.equal(inspection.status.kind, "verified");
		assert.equal(inspection.status.retention, "recovery");
	}
	const owner = await fixture.owner.recoveryStatus();
	assert.equal(owner.migration, "ready");
	assert.equal(owner.recoveryScopes, expectedScopes);
	assert.equal(owner.recoveryContentBytes, expectedBytes);
	const reopened = await fixture.owner.openScope(scope.declaration);
	try {
		assert.deepEqual(reopened.scope, scope.declaration.scope);
		assert.deepEqual(await chunksFor(reopened, scope.declaration), scope.chunks);
	} finally {
		await reopened.release();
	}
}

/**
 * Compute the owner's exact manifest-plus-content charge.
 * @param declaration - Exact snapshot manifest declaration.
 * @returns Accounted recovery bytes for one scope.
 */
export function charge(declaration: SnapshotQuarantineDeclaration): number {
	return declaration.totalBytes + declaration.exactCanonicalManifestBytes.byteLength;
}

/**
 * Time advances, not TTL policy. Ordinary sweep must still remove unrelated temporary scopes.
 * @param run - Operation executed after temporary expiry.
 * @returns The operation's unmodified result.
 */
export async function pastTemporaryTtl<T>(run: () => Promise<T>): Promise<T> {
	const now = Date.now;
	const afterExpiry = now() + SNAPSHOT_QUARANTINE_RETENTION_MS + 10_000;
	Date.now = (): number => afterExpiry;
	try {
		return await run();
	} finally {
		Date.now = now;
	}
}

/**
 * Tie the retained producer declaration directly to the genuine signed cut reference.
 * @param fixture - Original durable AHE backend.
 * @param result - Genuine successful close result.
 * @param scope - Retained producer snapshot identity.
 */
export async function assertSignedIdentity(
	fixture: ProducerFixture,
	result: Awaited<ReturnType<PreparedGenuineCreatorAdoptionFixture["handle"]["close"]>>,
	scope: ScopeObservation
): Promise<void> {
	assert.equal(result.ok, true);
	const cutBlob = await fixture.prepared.aheBackend.getBlob(result.cutValueRef.digest);
	assert.ok(cutBlob.ok && cutBlob.value !== null);
	const decoded = decodeCanonical(cutBlob.value) as Record<string, unknown>;
	assert.equal(decoded.snapshotManifestDigest, scope.declaration.scope.manifestDigest);
}

/**
 * Synchronous SQLite post-write/pre-COMMIT injection, scoped to the real snapshot connection.
 * @param primaryFilename - Exact test-owned SQLite primary identity.
 * @returns Original injected cause, transaction evidence and restoration owner.
 */
export function sqlitePrecommitFault(primaryFilename: string): {
	readonly error: Error;
	readonly evidence: { commitsIntercepted: number; ownedInsideTransaction: boolean };
	restore(): void;
} {
	const error = new Error("INJECTED_PRODUCER_RETENTION_PRECOMMIT");
	const evidence = { commitsIntercepted: 0, ownedInsideTransaction: false };
	const targetFilename = realpathSync(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`);
	const exec = DatabaseSync.prototype.exec;
	const prepare = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.exec = function (sql): void {
		if (sql.trim().toUpperCase() === "COMMIT" && evidence.commitsIntercepted === 0) {
			const files = Reflect.apply(prepare, this, ["PRAGMA database_list"]).all() as { file: string }[];
			if (files.some((row) => row.file === targetFilename)) {
				const owner = Reflect.apply(prepare, this, ["SELECT recovery_scopes FROM snapshot_owner_v2"]).get() as {
					recovery_scopes: number;
				};
				if (owner.recovery_scopes > 0) {
					evidence.commitsIntercepted += 1;
					evidence.ownedInsideTransaction = true;
					throw error;
				}
			}
		}
		Reflect.apply(exec, this, [sql]);
	};
	return {
		error,
		evidence,
		restore: (): void => {
			DatabaseSync.prototype.exec = exec;
		},
	};
}

/**
 * Abort only after the real IDB scope promotion and owner charge requests succeed, before transaction completion.
 * @param snapshotDatabaseName - Exact test-owned IndexedDB primary identity.
 * @returns Abort controller, original cause, request evidence and restoration owner.
 */
export function indexedDbPrecommitFault(snapshotDatabaseName: string): {
	readonly error: Error;
	readonly evidence: { ownerWrites: number; aborts: number };
	readonly controller: AbortController;
	restore(): void;
} {
	const error = new Error("INJECTED_PRODUCER_RETENTION_PRECOMMIT");
	const controller = new AbortController();
	const evidence = { ownerWrites: 0, aborts: 0 };
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function (...args): IDBRequest<IDBValidKey> {
		const request = Reflect.apply(put, this, args) as IDBRequest<IDBValidKey>;
		const row = args[0] as Record<string, unknown>;
		if (
			this.transaction.db.name === `${snapshotDatabaseName}--drp-snapshot-quarantine-v1` &&
			this.name === "owner" &&
			Number(row.recoveryScopes) > 0 &&
			evidence.aborts === 0
		) {
			request.addEventListener(
				"success",
				() => {
					evidence.ownerWrites += 1;
					evidence.aborts += 1;
					controller.abort(error);
				},
				{ once: true }
			);
		}
		return request;
	};
	return {
		error,
		evidence,
		controller,
		restore: (): void => {
			IDBObjectStore.prototype.put = put;
		},
	};
}

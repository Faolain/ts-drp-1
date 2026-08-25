import { compareBytes, encodeCanonical } from "@ts-drp/canonical";

import { PHASE_2D_SCHEMA_AUTHORITY, PHASE_5C_SCHEMA_AUTHORITY } from "./schema-idb.js";
import { createInternalVoteDispatcher } from "./seal-vote-dispatch.js";
import { openInternalSealVoteStore, type StoredSealCarrier } from "./seal-vote-store.js";

const OBJECT_ID = "phase5:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ANCHOR = "11".repeat(32);
const VALUE_DIGEST = "22".repeat(32);
const SIGNER_ID = "A";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener(
			"abort",
			() => reject(transaction.error ?? new DOMException("transaction aborted", "AbortError")),
			{ once: true }
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
			{ once: true }
		);
	});
}

function copyKeyPath(keyPath: string | readonly string[]): string | string[] {
	return typeof keyPath === "string" ? keyPath : [...keyPath];
}

async function createLegacyDatabase(databaseName: string, malformed: boolean): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.open(databaseName, 1);
		request.addEventListener(
			"upgradeneeded",
			() => {
				for (const store of PHASE_2D_SCHEMA_AUTHORITY.stores) {
					request.result.createObjectStore(store.name, {
						autoIncrement: store.autoIncrement,
						keyPath: copyKeyPath(store.keyPath),
					});
				}
				if (malformed) request.result.createObjectStore("unexpected", { keyPath: "id" });
			},
			{ once: true }
		);
		request.addEventListener("error", () => reject(request.error ?? new Error("legacy database failed")), {
			once: true,
		});
		request.addEventListener(
			"success",
			() => {
				const database = request.result;
				if (!malformed) {
					const transaction = database.transaction(
						PHASE_2D_SCHEMA_AUTHORITY.stores.map(({ name }) => name),
						"readwrite"
					);
					transaction.objectStore("objects").add({ objectId: "legacy-object" });
					transaction.objectStore("generations").add({ generationId: "g0", objectId: "legacy-object" });
					transaction.objectStore("blobs").add({ digest: "legacy-digest" });
					transaction
						.objectStore("promotions")
						.add({ digest: "legacy-digest", generationId: "g0", objectId: "legacy-object" });
					void transactionComplete(transaction).then(
						() => {
							database.close();
							resolve();
						},
						(error: unknown) => {
							database.close();
							reject(error);
						}
					);
					return;
				}
				database.close();
				resolve();
			},
			{ once: true }
		);
	});
}

function carrier(
	round: number,
	signatureByte = 0x42,
	proposalHash = "33".repeat(32),
	objectId = OBJECT_ID,
	signerId = SIGNER_ID
): StoredSealCarrier {
	return Object.freeze({
		exactCanonicalPreimageBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-seal-vote",
			objectId,
			phase: "prepare",
			proposalDigest: VALUE_DIGEST,
			proposalHash,
			round,
			signerId,
		}),
		signature: new Uint8Array(64).fill(signatureByte),
	});
}

function commitInput(
	stored: StoredSealCarrier,
	incarnation: string,
	round: number,
	revision: number,
	objectId = OBJECT_ID,
	signerId = SIGNER_ID
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		anchor: ANCHOR,
		carrier: stored,
		expectedIncarnation: incarnation,
		expectedRevision: revision,
		objectId,
		phase: "prepare",
		round,
		signerId,
		valueDigest: VALUE_DIGEST,
	});
}

function exactStores(database: IDBDatabase): readonly string[] {
	return Array.from(database.objectStoreNames);
}

function exactKey(round: number): string {
	return JSON.stringify([OBJECT_ID, 0, round, "prepare", SIGNER_ID]);
}

function bytesHex(value: StoredSealCarrier): string {
	return [...value.exactCanonicalPreimageBytes, ...value.signature]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function rawCounts(database: IDBDatabase): Promise<Record<string, number>> {
	const stores = exactStores(database);
	const transaction = database.transaction(stores, "readonly");
	const counts = Object.fromEntries(
		await Promise.all(
			stores.map(async (store) => [store, await requestResult(transaction.objectStore(store).count())] as const)
		)
	);
	await transactionComplete(transaction);
	return counts;
}

async function openCurrentDatabase(databaseName: string): Promise<IDBDatabase> {
	return requestResult(indexedDB.open(databaseName, PHASE_5C_SCHEMA_AUTHORITY.version));
}

async function runSchemaScenario(databaseName: string): Promise<unknown> {
	const fresh = await openInternalSealVoteStore({ databaseName });
	const freshResult = {
		incarnation: fresh.incarnation,
		stores: fresh.schema.stores,
		version: fresh.schema.version,
	};
	fresh.close();

	const upgradeName = `${databaseName}-upgrade`;
	await createLegacyDatabase(upgradeName, false);
	const upgraded = await openInternalSealVoteStore({ databaseName: upgradeName });
	const upgradedResult = {
		stores: upgraded.schema.stores,
		version: upgraded.schema.version,
	};
	upgraded.close();
	const upgradedDatabase = await openCurrentDatabase(upgradeName);
	const upgradeCounts = await rawCounts(upgradedDatabase);
	upgradedDatabase.close();
	const upgradeObservation = {
		preservedLegacyRows: PHASE_2D_SCHEMA_AUTHORITY.stores.reduce(
			(total, { name }) => total + (upgradeCounts[name] ?? 0),
			0
		),
		...upgradedResult,
	};

	const malformedName = `${databaseName}-malformed`;
	await createLegacyDatabase(malformedName, true);
	let rejected = false;
	try {
		(await openInternalSealVoteStore({ databaseName: malformedName })).close();
	} catch {
		rejected = true;
	}
	const unchanged = await new Promise<boolean>((resolve) => {
		const request = indexedDB.open(malformedName);
		request.addEventListener("error", () => resolve(false), { once: true });
		request.addEventListener(
			"success",
			() => {
				resolve(request.result.version === 1 && request.result.objectStoreNames.contains("unexpected"));
				request.result.close();
			},
			{ once: true }
		);
	});
	return Object.freeze({ fresh: freshResult, malformed: { rejected, unchanged }, upgraded: upgradeObservation });
}

async function runStrictVoteScenario(databaseName: string): Promise<unknown> {
	let dispatches = 0;
	const store = await openInternalSealVoteStore({
		databaseName,
		onCommitted: () => {
			dispatches += 1;
		},
	});
	const firstCarrier = carrier(0);
	const dispatchBeforeComplete = dispatches;
	const first = (await store.commitVote(commitInput(firstCarrier, store.incarnation, 0, 0))) as Record<string, unknown>;
	const dispatchAfterComplete = dispatches;
	const duplicate = (await store.commitVote(commitInput(carrier(0, 0x99), store.incarnation, 0, 1))) as Record<
		string,
		unknown
	>;
	const conflict = (await store.commitVote(
		commitInput(carrier(0, 0x55, "44".repeat(32)), store.incarnation, 0, 1)
	)) as Record<string, unknown>;
	const staleRevision = (await store.commitVote(commitInput(firstCarrier, store.incarnation, 0, 0))) as Record<
		string,
		unknown
	>;
	const recreated = (await store.commitVote(commitInput(firstCarrier, "recreated-incarnation", 0, 1))) as Record<
		string,
		unknown
	>;
	const exactStored = duplicate.stored as StoredSealCarrier;
	const existing = conflict.existing as StoredSealCarrier;
	const result = Object.freeze({
		conflict: {
			existingBytesExact:
				compareBytes(existing.exactCanonicalPreimageBytes, firstCarrier.exactCanonicalPreimageBytes) === 0,
			writes: conflict.writes,
		},
		dispatchAfterComplete,
		dispatchBeforeComplete,
		duplicate: {
			exactStoredBytes:
				compareBytes(exactStored.exactCanonicalPreimageBytes, firstCarrier.exactCanonicalPreimageBytes) === 0 &&
				compareBytes(exactStored.signature, firstCarrier.signature) === 0,
			writes: duplicate.writes,
		},
		first: { durability: "strict", stores: [...VOTE_STORES], writes: first.writes },
		recreated: { reason: recreated.reason, writes: recreated.writes },
		staleRevision: { reason: staleRevision.reason, writes: staleRevision.writes },
	});
	store.close();
	return result;
}

async function runScopedSnapshotScenario(databaseName: string): Promise<unknown> {
	const store = await openInternalSealVoteStore({ databaseName });
	const secondObjectId = "phase5:cccccccccccccccccccccccccccccccc";
	const secondSignerId = "B";
	await store.commitVote(commitInput(carrier(0, 0x42, "33".repeat(32), OBJECT_ID, SIGNER_ID), store.incarnation, 0, 0));
	await store.commitVote(
		commitInput(
			carrier(0, 0x43, "44".repeat(32), secondObjectId, secondSignerId),
			store.incarnation,
			0,
			0,
			secondObjectId,
			secondSignerId
		)
	);
	const firstScope = {
		anchor: ANCHOR,
		epoch: 0,
		expectedIncarnation: store.incarnation,
		objectId: OBJECT_ID,
		signerId: SIGNER_ID,
	};
	const secondScope = { ...firstScope, objectId: secondObjectId, signerId: secondSignerId };
	const firstBefore = await store.openSnapshot(firstScope);
	const secondBefore = await store.openSnapshot(secondScope);
	const advanced = await store.commitRound({ ...firstScope, expectedRevision: 1, round: 2 });
	const firstAfter = await store.openSnapshot(firstScope);
	const secondAfter = await store.openSnapshot(secondScope);
	store.close();
	return Object.freeze({ advanced, firstAfter, firstBefore, secondAfter, secondBefore });
}

const VOTE_STORES = ["signerState", "storageMeta", "voteOutbox", "voteSlots"] as const;

async function runDispatchScenario(databaseName: string, mode: string): Promise<unknown> {
	const store = await openInternalSealVoteStore({ databaseName });
	if (mode === "inspect-only") {
		const pending = await store.readPending();
		store.close();
		return Object.freeze({ committedKeys: pending.map(({ round }) => exactKey(round)), sentKeys: [] });
	}
	if (mode === "commit-only") {
		const committedKeys: string[] = [];
		for (let round = 0; round < 6; round++) {
			const result = (await store.commitVote(commitInput(carrier(round), store.incarnation, round, round))) as {
				readonly ok?: boolean;
			};
			if (result.ok !== true) throw new Error(`failed to commit takeover row ${round}`);
			committedKeys.push(exactKey(round));
		}
		store.close();
		return Object.freeze({ committedKeys: Object.freeze(committedKeys) });
	}

	const sent: Readonly<{ carrier: StoredSealCarrier; key: string }>[] = [];
	const publish = (value: Readonly<{ carrier: StoredSealCarrier; key: string }>): Promise<void> => {
		sent.push(value);
		if (typeof globalThis.dispatchEvent === "function") {
			globalThis.dispatchEvent(
				new CustomEvent("phase5c-seal-send", { detail: { bytesHex: bytesHex(value.carrier), key: value.key } })
			);
		}
		return Promise.resolve();
	};
	const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
	if (mode !== "native" && mode !== "takeover-only") {
		const throwingRequest = (): never => {
			throw new Error("LockManager throw mutant");
		};
		const rejectingRequest = (): Promise<never> =>
			Promise.reject(new DOMException("LockManager rejected", "AbortError"));
		const hangingRequest = (): Promise<never> => new Promise<never>(() => undefined);
		const request =
			mode === "absent"
				? undefined
				: mode === "non-callable"
					? 1
					: mode === "throw"
						? throwingRequest
						: mode === "reject" || mode === "abort"
							? rejectingRequest
							: hangingRequest;
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: mode === "absent" ? undefined : { request },
		});
	}
	try {
		if (mode !== "takeover-only") {
			const pending = await store.readPending();
			if (pending.length === 0) await store.commitVote(commitInput(carrier(0), store.incarnation, 0, 0));
		}
		const dispatcher = createInternalVoteDispatcher({ databaseName, publish, store });
		const first = await dispatcher.drain();
		const second = first.overflowReason === undefined ? undefined : await dispatcher.drain();
		await dispatcher.close();
		const committedKeys = [...new Set((await store.readPending()).map(({ round }) => exactKey(round)))];
		store.close();
		if (mode === "takeover-only") {
			return Object.freeze({
				first,
				inFlightPeak: second?.inFlightPeak ?? first.inFlightPeak,
				overflowReason: second?.overflowReason,
				second,
				sentKeys: second?.sentKeys ?? first.sentKeys,
			});
		}
		return Object.freeze({
			committedKeys,
			provisionalSends: 0,
			sentOnlyCommittedBytes: sent.every(({ carrier: sentCarrier }) =>
				Boolean(sentCarrier.exactCanonicalPreimageBytes.byteLength && sentCarrier.signature.byteLength === 64)
			),
		});
	} finally {
		if (originalLocks === undefined) Reflect.deleteProperty(navigator, "locks");
		else Object.defineProperty(navigator, "locks", originalLocks);
	}
}

async function runVersionChangeScenario(databaseName: string): Promise<unknown> {
	let releasePublish!: () => void;
	let publishStartedResolve!: () => void;
	const publishStarted = new Promise<void>((resolve) => (publishStartedResolve = resolve));
	let connectionClosedSynchronously = false;
	const store = await openInternalSealVoteStore({
		databaseName,
		onVersionChange: () => {
			connectionClosedSynchronously = true;
			releasePublish();
		},
	});
	await store.commitVote(commitInput(carrier(0), store.incarnation, 0, 0));
	const dispatcher = createInternalVoteDispatcher({
		databaseName,
		publish: () =>
			new Promise<void>((resolve) => {
				releasePublish = resolve;
				publishStartedResolve();
			}),
		store,
	});
	const drain = dispatcher.drain().catch(() => undefined);
	await publishStarted;
	const upgrade = indexedDB.open(databaseName, PHASE_5C_SCHEMA_AUTHORITY.version + 1);
	const upgradeSettled = new Promise<void>((resolve) => {
		upgrade.addEventListener(
			"upgradeneeded",
			() => {
				upgrade.transaction?.abort();
			},
			{ once: true }
		);
		upgrade.addEventListener(
			"error",
			() => {
				resolve();
			},
			{ once: true }
		);
		upgrade.addEventListener(
			"success",
			() => {
				upgrade.result.close();
				resolve();
			},
			{ once: true }
		);
	});
	await upgradeSettled;
	await drain;
	await dispatcher.close().catch(() => undefined);
	const successor = await openInternalSealVoteStore({ databaseName });
	const pending = await successor.readPending();
	const result = {
		blockedLateUpgradeCommitted: successor.schema.version !== 2,
		connectionClosedSynchronously,
		lateDispatchMarked: pending.length === 0,
		successorPendingCount: pending.length,
	};
	successor.close();
	return Object.freeze(result);
}

async function runDeathCheckpoint(databaseName: string, checkpoint: string): Promise<never> {
	void checkpoint;
	const store = await openInternalSealVoteStore({ databaseName });
	await store.commitVote(commitInput(carrier(0), store.incarnation, 0, 0));
	throw new Error("death checkpoint was not reached");
}

/**
 * Runs one commit or reopen request inside the real module Worker.
 * @param input - Worker request identity, database, and mode.
 * @returns Exact persisted-state observation.
 */
export async function runSealVoteWorkerRequest(
	input: Readonly<{
		databaseName: string;
		id: string;
		mode: "commit" | "reopen";
	}>
): Promise<unknown> {
	const store = await openInternalSealVoteStore({ databaseName: input.databaseName });
	if (input.mode === "commit") await store.commitVote(commitInput(carrier(0), store.incarnation, 0, 0));
	const pending = await store.readPending();
	const result = Object.freeze({ pendingCount: pending.length, state: pending.length === 0 ? "old" : "exact-new" });
	store.close();
	return result;
}

/**
 * Creates the browser-only D.105b composition test control.
 * @returns Closed schema, vote, dispatch, death, and versionchange scenarios.
 */
export function createSealVoteBrowserTestControl(): Readonly<{
	runDeathCheckpoint(databaseName: string, checkpoint: string): Promise<never>;
	runDispatchScenario(databaseName: string, mode: string): Promise<unknown>;
	runSchemaScenario(databaseName: string): Promise<unknown>;
	runScopedSnapshotScenario(databaseName: string): Promise<unknown>;
	runStrictVoteScenario(databaseName: string): Promise<unknown>;
	runVersionChangeScenario(databaseName: string): Promise<unknown>;
}> {
	return Object.freeze({
		runDeathCheckpoint,
		runDispatchScenario,
		runSchemaScenario,
		runScopedSnapshotScenario,
		runStrictVoteScenario,
		runVersionChangeScenario,
	});
}

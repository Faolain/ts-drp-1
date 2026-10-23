import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	encodeJournalRetirementControl,
	journalRetirementFrameDigest,
	LIVE_JOURNAL_RETIREMENT_LIMITS,
	type DurableLiveJournalStore,
	type LiveJournalScope,
} from "@ts-drp/live-journal";

import {
	armPhase3a1bP4BrowserDurabilityDowngrade,
	armPhase3a1bP4BrowserReadbackFault,
	armPhase3a1bP4BrowserReadbackInterleave,
	observePhase3a1bP4BrowserOperation,
	takePhase3a1bP4BrowserObservationLedger,
} from "#phase-3a1b-p4-browser-test-control"; // eslint-disable-line import/no-unresolved -- private RED bundler alias.

// The static observer bootstrap above must finish before this dynamic candidate import.
async function loadCandidate(): Promise<{
	createBrowserDurableLiveJournalStore(options: Readonly<Record<string, unknown>>): Promise<JournalStore>;
}> {
	// eslint-disable-next-line import/no-unresolved -- private RED bundler alias.
	return import("#phase-3a1b-p4-browser-candidate") as unknown as Promise<{
		createBrowserDurableLiveJournalStore(options: Readonly<Record<string, unknown>>): Promise<JournalStore>;
	}>;
}

interface JournalStore {
	acquireNativeReadReservation(input: { readonly objectId: string }): Promise<{
		check(): Promise<void>;
		release(): Promise<void>;
	}>;
	appendAccepted(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	close(): Promise<void>;
	installGenesis(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readiness(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readPage(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

declare global {
	interface Window {
		phase3a1bP4Run(
			caseId:
				| "concurrency"
				| "decision-mutants"
				| "duplicates"
				| "faults"
				| "interleaving"
				| "lifecycle"
				| "persisted-shapes"
				| "strict-downgrade"
				| "surface-schema"
				| "reserved-page-bound"
				| "reserved-page-foreign"
				| "reserved-page-lifetime"
				| "reserved-page-poison"
				| "reserved-readiness-reuse"
				| "reserved-readiness-scopes"
				| "incremental-replay-validation"
				| "closed-membership-after-drain"
				| "closed-membership-upgrade"
				| "reserved-retirement-reuse"
				| "reserved-retirement-abort"
				| "reserved-retirement-admission"
				| "reserved-retirement-current-probe"
		): Promise<unknown>;
	}
}

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
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("transaction aborted")), {
			once: true,
		});
		transaction.addEventListener("error", () => reject(transaction.error ?? new Error("transaction failed")), {
			once: true,
		});
	});
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolve(), { once: true });
		request.addEventListener("blocked", () => reject(new Error(`delete blocked: ${name}`)), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error(`delete failed: ${name}`)), {
			once: true,
		});
	});
}

async function rawSchema(name: string): Promise<unknown> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction([...database.objectStoreNames], "readonly");
		const stores = [...database.objectStoreNames].map((storeName) => {
			const store = transaction.objectStore(storeName);
			const indexes = [...store.indexNames].map((indexName) => {
				const index = store.index(indexName);
				return {
					keyPath: Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
					multiEntry: index.multiEntry,
					name: indexName,
					unique: index.unique,
				};
			});
			return {
				autoIncrement: store.autoIncrement,
				indexes,
				keyPath: Array.isArray(store.keyPath) ? [...store.keyPath] : store.keyPath,
				name: storeName,
			};
		});
		await transactionComplete(transaction);
		return { stores, version: database.version };
	} finally {
		database.close();
	}
}

async function rawClosure(name: string): Promise<unknown> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(["acceptedEntries", "scopes"], "readonly");
		const rows = await requestResult(transaction.objectStore("acceptedEntries").getAll());
		const scopes = await requestResult(transaction.objectStore("scopes").getAll());
		await transactionComplete(transaction);
		return { rows, scopes };
	} finally {
		database.close();
	}
}

async function rawLocalRefKeys(name: string): Promise<readonly IDBValidKey[]> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction("acceptedEntries", "readonly");
		const keys = await requestResult(transaction.objectStore("acceptedEntries").index("localRefUniq").getAllKeys());
		await transactionComplete(transaction);
		return keys;
	} finally {
		database.close();
	}
}

async function replaceRaw(name: string, storeName: "acceptedEntries" | "scopes", value: unknown): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
		await requestResult(transaction.objectStore(storeName).put(value));
		await transactionComplete(transaction);
	} finally {
		database.close();
	}
}

async function deleteRaw(name: string, storeName: "acceptedEntries" | "scopes", key: IDBValidKey): Promise<void> {
	const database = await requestResult(indexedDB.open(name));
	try {
		const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
		await requestResult(transaction.objectStore(storeName).delete(key));
		await transactionComplete(transaction);
	} finally {
		database.close();
	}
}

async function applyReadbackFate(
	derived: string,
	operation: "append" | "install",
	fate: "exact-old" | "mixed",
	values: Readonly<Record<string, unknown>>
): Promise<void> {
	const closure = (await rawClosure(derived)) as {
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	};
	const scope = values.scope as Readonly<Record<string, unknown>>;
	const scopeKey: IDBValidKey = [scope.objectId as string, 0, scope.anchorDigest as string];
	if (operation === "install") {
		if (fate === "exact-old") await deleteRaw(derived, "scopes", scopeKey);
		else await replaceRaw(derived, "scopes", { ...closure.scopes[0], detachedAnchorSignature: new Uint8Array(64) });
		return;
	}
	const row = closure.rows[0];
	const rowKey: IDBValidKey = [...(scopeKey as readonly IDBValidKey[]), 0];
	if (fate === "exact-old") {
		await deleteRaw(derived, "acceptedEntries", rowKey);
		await replaceRaw(derived, "scopes", { ...closure.scopes[0], nextJournalSequence: 0 });
	} else {
		await replaceRaw(derived, "scopes", { ...closure.scopes[0], nextJournalSequence: 0 });
		if (row === undefined) throw new TypeError("external mixed readback requires the committed row");
	}
}

function lowerHex(bytes: Uint8Array): string {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: unknown, right: unknown): boolean {
	return (
		left instanceof Uint8Array &&
		right instanceof Uint8Array &&
		left.byteLength === right.byteLength &&
		left.every((value, index) => value === right[index])
	);
}

function exactDataRecord(
	value: unknown,
	expectedKeys: readonly string[],
	label: string
): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be a record`);
	}
	const prototype = Object.getPrototypeOf(value);
	const keys = Reflect.ownKeys(value);
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		keys.length !== expectedKeys.length ||
		!keys.every((key, index) => key === expectedKeys[index]) ||
		!keys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
		})
	) {
		throw new TypeError(`${label} must have the exact data-record shape`);
	}
	return value as Readonly<Record<string, unknown>>;
}

function material(): Readonly<Record<string, unknown>> {
	const zero = "0".repeat(64);
	const objectId = `creator:${"1".repeat(32)}`;
	const parametersBytes = encodeCanonical({
		maxEpochVertices: 64,
		maxEpochBytes: 1_048_576,
		maxDependencies: 8,
		snapshotChunkBytes: 65_536,
		maxSnapshotBytes: 1_048_576,
		maxPendingEntries: 64,
		maxPendingBytes: 1_048_576,
	});
	const parametersDigest = lowerHex(hashDomain("ts-drp/parameters/v3", parametersBytes));
	const anchorBytes = encodeCanonical({
		kind: "drp-epoch-anchor",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		previousAnchor: zero,
		cutDigest: zero,
		stateDigest: zero,
		aclDigest: zero,
		historyRoot: zero,
		historySize: 0,
		archiveIndexRoot: zero,
		blueprintDigest: "2".repeat(64),
		signerSetDigest: "3".repeat(64),
		parametersDigest,
		profileDigest: "4".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
	});
	const anchorDigest = lowerHex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const vertexBytes = encodeCanonical({
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		anchor: anchorDigest,
		author: "creator",
		authorSequence: 0,
		logicalTime: 1,
		dependencies: ["5".repeat(64)],
		operation: { arguments: { value: 1 }, type: "append" },
	});
	const signature = new Uint8Array(64).fill(7);
	const scope = Object.freeze({ anchorDigest, epoch: 0, objectId });
	return Object.freeze({
		install: Object.freeze({
			detachedAnchorSignature: signature,
			exactCanonicalAnchorPreimageBytes: anchorBytes,
			exactCanonicalParametersCarrierBytes: parametersBytes,
			objectId,
		}),
		local: Object.freeze({
			author: "creator",
			authorSequence: 0,
			scope,
			sourceKind: "local-issued",
			vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", vertexBytes)),
		}),
		received: Object.freeze({
			detachedSignature: signature,
			exactCanonicalPreimageBytes: vertexBytes,
			scope,
			sourceKind: "received",
			vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", vertexBytes)),
		}),
		scope,
	});
}

async function open(primaryDatabaseName: string): Promise<JournalStore> {
	const { createBrowserDurableLiveJournalStore } = await loadCandidate();
	return createBrowserDurableLiveJournalStore({ primaryDatabaseName });
}

async function surfaceSchema(): Promise<unknown> {
	const primary = `phase-3a1b-p4-surface-${crypto.randomUUID()}`;
	const derived = `${primary}--drp-live-journal-v1`;
	const store = await open(primary);
	try {
		return {
			derived,
			keys: Object.keys(store).sort(),
			primaryCreated: (await indexedDB.databases()).some(({ name }) => name === primary),
			schema: await rawSchema(derived),
		};
	} finally {
		await store.close();
		await deleteDatabase(derived);
	}
}

async function lifecycle(): Promise<unknown> {
	const primary = `phase-3a1b-p4-life-${crypto.randomUUID()}`;
	const derived = `${primary}--drp-live-journal-v1`;
	const store = await open(primary);
	const values = material();
	try {
		const installed = await store.installGenesis(values.install as Readonly<Record<string, unknown>>);
		const received = await store.appendAccepted(values.received as Readonly<Record<string, unknown>>);
		const echo = await store.appendAccepted(values.local as Readonly<Record<string, unknown>>);
		const ready = await store.readiness({ scope: values.scope });
		const snapshot = Reflect.get(ready, "snapshot") as Readonly<Record<string, unknown>>;
		const page = await store.readPage({ afterSequence: null, limit: 1, scope: values.scope, snapshot });
		const database = await requestResult(indexedDB.open(derived));
		let rawRows: unknown;
		try {
			const transaction = database.transaction("acceptedEntries", "readonly");
			rawRows = await requestResult(transaction.objectStore("acceptedEntries").getAll());
			await transactionComplete(transaction);
		} finally {
			database.close();
		}
		return { echo, installed, page, rawRows, ready, received };
	} finally {
		await store.close();
		await deleteDatabase(derived);
	}
}

async function concurrency(): Promise<unknown> {
	const primary = `phase-3a1b-p4-race-${crypto.randomUUID()}`;
	const derived = `${primary}--drp-live-journal-v1`;
	const first = await open(primary);
	const second = await open(primary);
	const values = material();
	const install = exactDataRecord(
		values.install,
		[
			"detachedAnchorSignature",
			"exactCanonicalAnchorPreimageBytes",
			"exactCanonicalParametersCarrierBytes",
			"objectId",
		],
		"material.install"
	);
	const local = exactDataRecord(
		values.local,
		["author", "authorSequence", "scope", "sourceKind", "vertexDigest"],
		"material.local"
	);
	const received = exactDataRecord(
		values.received,
		["detachedSignature", "exactCanonicalPreimageBytes", "scope", "sourceKind", "vertexDigest"],
		"material.received"
	);
	const scope = exactDataRecord(values.scope, ["anchorDigest", "epoch", "objectId"], "material.scope");
	try {
		await first.installGenesis(install);
		const race = await Promise.all([first.appendAccepted(received), second.appendAccepted(local)]);
		await Promise.all([first.close(), second.close()]);
		const closure = (await rawClosure(derived)) as {
			readonly rows: readonly Record<string, unknown>[];
			readonly scopes: readonly Record<string, unknown>[];
		};
		const row = closure.rows[0];
		const installed = closure.scopes[0];
		const rawVerified =
			closure.rows.length === 1 &&
			closure.scopes.length === 1 &&
			Reflect.get(row ?? {}, "journalSequence") === 0 &&
			Reflect.get(row ?? {}, "vertexDigest") === Reflect.get(received, "vertexDigest") &&
			Reflect.get(installed ?? {}, "nextJournalSequence") === 1 &&
			Reflect.get(installed ?? {}, "objectId") === Reflect.get(install, "objectId") &&
			Reflect.get(installed ?? {}, "anchorDigest") === Reflect.get(scope, "anchorDigest") &&
			sameBytes(
				Reflect.get(installed ?? {}, "exactCanonicalAnchorPreimageBytes"),
				Reflect.get(install, "exactCanonicalAnchorPreimageBytes")
			) &&
			sameBytes(
				Reflect.get(installed ?? {}, "exactCanonicalParametersCarrierBytes"),
				Reflect.get(install, "exactCanonicalParametersCarrierBytes")
			) &&
			sameBytes(
				Reflect.get(installed ?? {}, "detachedAnchorSignature"),
				Reflect.get(install, "detachedAnchorSignature")
			);
		return { closure, race, rawVerified };
	} finally {
		await Promise.all([first.close(), second.close()]);
		await deleteDatabase(derived);
	}
}

async function legalReadbackInterleave(): Promise<unknown> {
	const primary = `phase-3a1b-p4-interleave-${crypto.randomUUID()}`;
	const derived = `${primary}--drp-live-journal-v1`;
	const first = await open(primary);
	const second = await open(primary);
	const values = material();
	try {
		await first.installGenesis(values.install as Readonly<Record<string, unknown>>);
		takePhase3a1bP4BrowserObservationLedger();
		const genesisRepeat = await observePhase3a1bP4BrowserOperation("genesis-repeat", () =>
			first.installGenesis(values.install as Readonly<Record<string, unknown>>)
		);
		armPhase3a1bP4BrowserReadbackInterleave(async () => {
			await second.appendAccepted({
				...(values.local as Readonly<Record<string, unknown>>),
				authorSequence: 1,
				vertexDigest: "6".repeat(64),
			});
		});
		const target = await observePhase3a1bP4BrowserOperation("received-new", () =>
			first.appendAccepted(values.received as Readonly<Record<string, unknown>>)
		);
		const repeat = await observePhase3a1bP4BrowserOperation("received-repeat", () =>
			first.appendAccepted(values.received as Readonly<Record<string, unknown>>)
		);
		const localRepeat = await observePhase3a1bP4BrowserOperation("local-repeat", () =>
			first.appendAccepted({
				...(values.local as Readonly<Record<string, unknown>>),
				authorSequence: 1,
				vertexDigest: "6".repeat(64),
			})
		);
		const crossKind = await observePhase3a1bP4BrowserOperation("cross-kind", () =>
			first.appendAccepted(values.local as Readonly<Record<string, unknown>>)
		);
		const localRefConflict = await observePhase3a1bP4BrowserOperation("local-ref", () =>
			first.appendAccepted({
				...(values.local as Readonly<Record<string, unknown>>),
				authorSequence: 1,
			})
		);
		const ready = await observePhase3a1bP4BrowserOperation("readiness", () => first.readiness({ scope: values.scope }));
		const snapshot = Reflect.get(ready, "snapshot") as Readonly<Record<string, unknown>>;
		await observePhase3a1bP4BrowserOperation("page", () =>
			first.readPage({ afterSequence: null, limit: 64, scope: values.scope, snapshot })
		);
		const ledger = takePhase3a1bP4BrowserObservationLedger();
		return {
			closure: await rawClosure(derived),
			crossKind,
			genesisRepeat,
			ledger,
			localRefConflict,
			localRepeat,
			ready,
			repeat,
			target,
		};
	} finally {
		await Promise.all([first.close(), second.close()]);
		await deleteDatabase(derived);
	}
}

async function persistedShapes(): Promise<unknown> {
	const values = material();
	const receivedPrimary = `phase-3a1b-p4-shape-received-${crypto.randomUUID()}`;
	const receivedDerived = `${receivedPrimary}--drp-live-journal-v1`;
	const receivedStore = await open(receivedPrimary);
	let receivedClosure: {
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	};
	let rowPoison: unknown;
	let receivedLocalRefKeys: readonly IDBValidKey[];
	try {
		await receivedStore.installGenesis(values.install as Readonly<Record<string, unknown>>);
		await receivedStore.appendAccepted(values.received as Readonly<Record<string, unknown>>);
		receivedClosure = (await rawClosure(receivedDerived)) as typeof receivedClosure;
		receivedLocalRefKeys = await rawLocalRefKeys(receivedDerived);
		await replaceRaw(receivedDerived, "acceptedEntries", { ...receivedClosure.rows[0], localAuthor: "poison" });
		rowPoison = await receivedStore.readiness({ scope: values.scope });
	} finally {
		await receivedStore.close();
		await deleteDatabase(receivedDerived);
	}

	const localPrimary = `phase-3a1b-p4-shape-local-${crypto.randomUUID()}`;
	const localDerived = `${localPrimary}--drp-live-journal-v1`;
	const localStore = await open(localPrimary);
	let localClosure: {
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	};
	let scopePoison: unknown;
	try {
		await localStore.installGenesis(values.install as Readonly<Record<string, unknown>>);
		await localStore.appendAccepted(values.local as Readonly<Record<string, unknown>>);
		localClosure = (await rawClosure(localDerived)) as typeof localClosure;
		await replaceRaw(localDerived, "scopes", { ...localClosure.scopes[0], extra: true });
		scopePoison = await localStore.readiness({ scope: values.scope });
	} finally {
		await localStore.close();
		await deleteDatabase(localDerived);
	}
	const poisonKinds = [
		["received", "missing", "detachedSignature"],
		["received", "null", "detachedSignature"],
		["received", "undefined", "detachedSignature"],
		["received", "opposite", "localAuthor"],
		["received", "missing", "exactCanonicalPreimageBytes"],
		["received", "null", "exactCanonicalPreimageBytes"],
		["received", "undefined", "exactCanonicalPreimageBytes"],
		["received", "opposite", "localAuthorSequence"],
		["local-issued", "missing", "localAuthor"],
		["local-issued", "null", "localAuthor"],
		["local-issued", "undefined", "localAuthor"],
		["local-issued", "opposite", "detachedSignature"],
		["local-issued", "missing", "localAuthorSequence"],
		["local-issued", "null", "localAuthorSequence"],
		["local-issued", "undefined", "localAuthorSequence"],
		["local-issued", "opposite", "exactCanonicalPreimageBytes"],
	] as const;
	const variantPoisons: unknown[] = [];
	for (const [sourceKind, mutation, field] of poisonKinds) {
		const primary = `phase-3a1b-p4-shape-${sourceKind}-${mutation}-${crypto.randomUUID()}`;
		const derived = `${primary}--drp-live-journal-v1`;
		const store = await open(primary);
		try {
			await store.installGenesis(values.install as Readonly<Record<string, unknown>>);
			await store.appendAccepted(
				(sourceKind === "received" ? values.received : values.local) as Readonly<Record<string, unknown>>
			);
			const closure = (await rawClosure(derived)) as { readonly rows: readonly Record<string, unknown>[] };
			const poisoned = { ...closure.rows[0] };
			if (mutation === "missing") delete poisoned[field];
			else poisoned[field] = mutation === "null" ? null : mutation === "undefined" ? undefined : "poison";
			await replaceRaw(derived, "acceptedEntries", poisoned);
			variantPoisons.push(await store.readiness({ scope: values.scope }));
		} finally {
			await store.close();
			await deleteDatabase(derived);
		}
	}
	return { localClosure, receivedClosure, receivedLocalRefKeys, rowPoison, scopePoison, variantPoisons };
}

async function duplicateMatrix(): Promise<unknown> {
	const results: unknown[] = [];
	for (const firstKind of ["received", "local-issued"] as const) {
		const primary = `phase-3a1b-p4-duplicates-${firstKind}-${crypto.randomUUID()}`;
		const derived = `${primary}--drp-live-journal-v1`;
		const store = await open(primary);
		const values = material();
		try {
			await store.installGenesis(values.install as Readonly<Record<string, unknown>>);
			const first = firstKind === "received" ? values.received : values.local;
			results.push(await store.appendAccepted(first as Readonly<Record<string, unknown>>));
			results.push(await store.appendAccepted(first as Readonly<Record<string, unknown>>));
			results.push(
				await store.appendAccepted(
					(firstKind === "received" ? values.local : values.received) as Readonly<Record<string, unknown>>
				)
			);
			if (firstKind === "received") {
				results.push(
					await store.appendAccepted({
						...(values.received as Readonly<Record<string, unknown>>),
						detachedSignature: new Uint8Array(64).fill(9),
					})
				);
			} else {
				results.push(
					await store.appendAccepted({
						...(values.local as Readonly<Record<string, unknown>>),
						vertexDigest: "6".repeat(64),
					})
				);
				results.push(
					await store.appendAccepted({
						...(values.local as Readonly<Record<string, unknown>>),
						authorSequence: 1,
					})
				);
			}
			await store.close();
			results.push(await rawClosure(derived));
		} finally {
			await store.close();
			await deleteDatabase(derived);
		}
	}
	const collisionPrimary = `phase-3a1b-p4-duplicates-collision-${crypto.randomUUID()}`;
	const collisionDerived = `${collisionPrimary}--drp-live-journal-v1`;
	const collisionStore = await open(collisionPrimary);
	const collisionValues = material();
	try {
		await collisionStore.installGenesis(collisionValues.install as Readonly<Record<string, unknown>>);
		results.push(await collisionStore.appendAccepted(collisionValues.local as Readonly<Record<string, unknown>>));
		results.push(
			await collisionStore.appendAccepted({
				...(collisionValues.local as Readonly<Record<string, unknown>>),
				authorSequence: 1,
				vertexDigest: "6".repeat(64),
			})
		);
		results.push(
			await collisionStore.appendAccepted({
				...(collisionValues.local as Readonly<Record<string, unknown>>),
				vertexDigest: "6".repeat(64),
			})
		);
		await collisionStore.close();
		results.push(await rawClosure(collisionDerived));
	} finally {
		await collisionStore.close();
		await deleteDatabase(collisionDerived);
	}
	return { results };
}

async function readbackFaults(): Promise<unknown> {
	const results: unknown[] = [];
	for (const operation of ["install", "append"] as const) {
		for (const fate of ["exact-new", "exact-old", "mixed", "unreadable"] as const) {
			const primary = `phase-3a1b-p4-fault-${operation}-${fate}-${crypto.randomUUID()}`;
			const derived = `${primary}--drp-live-journal-v1`;
			const store = await open(primary);
			const values = material();
			try {
				if (operation === "append") {
					await store.installGenesis(values.install as Readonly<Record<string, unknown>>);
				}
				armPhase3a1bP4BrowserReadbackFault(
					fate,
					fate === "exact-old" || fate === "mixed"
						? (): Promise<void> => applyReadbackFate(derived, operation, fate, values)
						: undefined
				);
				const result = await observePhase3a1bP4BrowserOperation(`fault-${operation}-${fate}`, () =>
					operation === "install"
						? store.installGenesis(values.install as Readonly<Record<string, unknown>>)
						: store.appendAccepted(values.received as Readonly<Record<string, unknown>>)
				);
				const after = await store.readiness({ scope: values.scope });
				results.push({ after, fate, operation, result });
			} finally {
				await store.close();
				await deleteDatabase(derived);
			}
		}
	}
	return { results };
}

async function strictDowngrade(): Promise<unknown> {
	const primary = `phase-3a1b-p4-downgrade-${crypto.randomUUID()}`;
	const derived = `${primary}--drp-live-journal-v1`;
	armPhase3a1bP4BrowserDurabilityDowngrade();
	try {
		const store = await open(primary);
		await store.close();
		return { unexpectedSuccess: true };
	} catch (error) {
		return {
			error:
				typeof error === "object" && error !== null
					? { kind: Reflect.get(error, "kind"), name: Reflect.get(error, "name") }
					: String(error),
		};
	} finally {
		await deleteDatabase(derived);
	}
}

async function decisionMutants(): Promise<unknown> {
	const values = material();
	const results: Record<string, unknown> = {};
	for (const mode of ["capture", "duplicate", "snapshot", "observation"] as const) {
		const primary = `phase-3a1b-p4-decision-${mode}-${crypto.randomUUID()}`;
		const derived = `${primary}--drp-live-journal-v1`;
		const store = await open(primary);
		try {
			if (mode === "capture") Reflect.set(globalThis, "__TS_DRP_P4_LIVE_JOURNAL_DECISION_MUTANT__", mode);
			const installed = await store.installGenesis(values.install as Readonly<Record<string, unknown>>);
			if (mode === "capture") {
				results[mode] = { outcome: installed, raw: await rawClosure(derived) };
				continue;
			}
			expectDataSuccess(installed);
			if (mode === "duplicate" || mode === "snapshot") {
				expectDataSuccess(await store.appendAccepted(values.received as Readonly<Record<string, unknown>>));
			}
			Reflect.set(globalThis, "__TS_DRP_P4_LIVE_JOURNAL_DECISION_MUTANT__", mode);
			const outcome =
				mode === "snapshot"
					? await store.readiness({ scope: values.scope })
					: await store.appendAccepted(values.received as Readonly<Record<string, unknown>>);
			results[mode] = { outcome, raw: await rawClosure(derived) };
		} finally {
			Reflect.deleteProperty(globalThis, "__TS_DRP_P4_LIVE_JOURNAL_DECISION_MUTANT__");
			await store.close();
			await deleteDatabase(derived);
		}
	}
	const expectedScope = values.scope as Readonly<Record<string, unknown>>;
	const expectedInstall = values.install as Readonly<Record<string, unknown>>;
	const expectedReceived = values.received as Readonly<Record<string, unknown>>;
	return {
		expected: {
			anchorDigest: Reflect.get(expectedScope, "anchorDigest"),
			objectId: Reflect.get(expectedScope, "objectId"),
			parametersDigest: lowerHex(
				hashDomain(
					"ts-drp/parameters/v3",
					Reflect.get(expectedInstall, "exactCanonicalParametersCarrierBytes") as Uint8Array
				)
			),
			vertexDigest: Reflect.get(expectedReceived, "vertexDigest"),
		},
		results,
	};
}

function expectDataSuccess(value: Readonly<Record<string, unknown>>): void {
	if (Reflect.get(value, "ok") !== true) throw new Error("p4 decision-mutant control did not reach the real adapter");
}

// Observe native result cardinality/bytes and transaction identity; do not
// substitute rows, transactions, versions or terminal results.
async function measuredPageRead<T>(operation: () => Promise<T>): Promise<{
	readonly value: T;
	readonly reads: readonly {
		readonly rows: number;
		readonly bytes: number;
		readonly count: number | null;
		readonly transaction: number;
	}[];
}> {
	const original = IDBObjectStore.prototype.getAll;
	const ids = new WeakMap<IDBTransaction, number>();
	let next = 0;
	const reads: { rows: number; bytes: number; count: number | null; transaction: number }[] = [];
	IDBObjectStore.prototype.getAll = function (...args): IDBRequest {
		const request = original.apply(this, args);
		if (this.name === "acceptedEntries") {
			const transaction = this.transaction;
			const identity = ids.get(transaction) ?? ++next;
			ids.set(transaction, identity);
			request.addEventListener(
				"success",
				() => {
					const rows = request.result as Record<string, unknown>[];
					const bytes = rows.reduce(
						(sum, row) =>
							sum +
							Object.values(row).reduce<number>(
								(total, value) => total + (value instanceof Uint8Array ? value.byteLength : 0),
								0
							),
						0
					);
					reads.push({ rows: rows.length, bytes, count: args[1] ?? null, transaction: identity });
				},
				{ once: true }
			);
		}
		return request;
	};
	try {
		return { value: await operation(), reads };
	} finally {
		IDBObjectStore.prototype.getAll = original;
	}
}

function pageVertex(values: Readonly<Record<string, unknown>>, sequence: number): Readonly<Record<string, unknown>> {
	const scope = values.scope as { objectId: string; anchorDigest: string; epoch: number };
	const bytes = encodeCanonical({
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId: scope.objectId,
		epoch: scope.epoch,
		anchor: scope.anchorDigest,
		author: "creator",
		authorSequence: sequence,
		logicalTime: sequence + 1,
		dependencies: ["5".repeat(64)],
		operation: { payload: "x".repeat(1024), sequence },
	});
	return {
		scope: values.scope,
		sourceKind: "received",
		vertexDigest: lowerHex(hashDomain("ts-drp/vertex/v3", bytes)),
		exactCanonicalPreimageBytes: bytes,
		detachedSignature: new Uint8Array(64).fill(sequence + 1),
	};
}

async function seededPageStore(count: number): Promise<{
	primary: string;
	derived: string;
	store: JournalStore;
	values: Readonly<Record<string, unknown>>;
}> {
	const primary = `phase-3a1b-p4-reserved-page-${crypto.randomUUID()}`;
	const store = await open(primary);
	const values = material();
	try {
		expectDataSuccess(await store.installGenesis(values.install as Readonly<Record<string, unknown>>));
		for (let sequence = 0; sequence < count; sequence++)
			expectDataSuccess(await store.appendAccepted(pageVertex(values, sequence)));
		return { primary, derived: `${primary}--drp-live-journal-v1`, store, values };
	} catch (cause) {
		await store.close();
		throw cause;
	}
}

// Native mechanical regression only: these fixture preparations/opaque bytes do
// not establish protocol eligibility or authenticate a close certificate.
async function closedMembershipAfterDrain(): Promise<unknown> {
	const { primary, derived, store: opened, values } = await seededPageStore(1);
	let store = opened as unknown as DurableLiveJournalStore;
	const scope = values.scope as LiveJournalScope;
	const acquire = async () => {
		const result = await store.acquireRetirementControl!({ objectId: scope.objectId });
		if (!result.ok) throw new TypeError(`native regression acquisition: ${result.kind}`);
		return result.value;
	};
	try {
		const install = values.install as { exactCanonicalAnchorPreimageBytes: Uint8Array };
		const anchor = decodeCanonical(install.exactCanonicalAnchorPreimageBytes) as Record<string, unknown>;
		const nextBytes = encodeCanonical({ ...anchor, epoch: 1, previousAnchor: scope.anchorDigest });
		const nextScope = { ...scope, epoch: 1, anchorDigest: lowerHex(hashDomain("ts-drp/epoch-anchor/v3", nextBytes)) };
		expectDataSuccess(await store.installEpochAnchor({ ...install, exactCanonicalAnchorPreimageBytes: nextBytes } as never));
		let view = await acquire();
		expectDataSuccess(await view.prepareFence({ throughEpoch: 0, protectedScopes: [], decisionDigest: "a".repeat(64), sourceProofDigest: "b".repeat(64) }));
		await view.release();
		view = await acquire();
		expectDataSuccess(await view.commitPrepared());
		await view.release();
		view = await acquire();
		const frame = view.readExactCanonicalRows().find(bytes => (decodeCanonical(bytes) as unknown[])[0] === "acceptedEntries");
		if (frame === undefined) throw new TypeError("native regression row missing");
		const raw = (decodeCanonical(frame) as unknown[])[2] as { journalSequence: number; vertexDigest: string; exactCanonicalPreimageBytes: Uint8Array };
		const vertex = decodeCanonical(raw.exactCanonicalPreimageBytes) as { author: string; authorSequence: number };
		expectDataSuccess(await view.beginDrain({ baseControl: view.control, sourceImage: view.image, prefixes: [{ scope, highWatermark: 1, rows: [{ journalSequence: raw.journalSequence, vertexDigest: raw.vertexDigest, author: vertex.author, authorSequence: vertex.authorSequence, nativeFrameDigest: journalRetirementFrameDigest(frame), exactCanonicalNativeFrameBytes: frame }] }] }));
		await view.release();
		view = await acquire();
		expectDataSuccess(await view.drainBatch());
		await view.release();
		view = await acquire();
		const completedDrain = view.control.drain;
		const expectedNativeImage = { imageDigest: view.image.imageDigest, controlBytes: encodeJournalRetirementControl(view.control) };
		await view.release();
		const membership = encodeCanonical({ kind: "native-membership-regression", epoch: 1 });
		const fresh = await store.recordClosedMembership!({ scope: nextScope, exactCanonicalMembershipBytes: membership, expectedNativeImage });
		const stale = await store.recordClosedMembership!({ scope: nextScope, exactCanonicalMembershipBytes: membership, expectedNativeImage });
		const afterStale = await store.readRetirementImage!({ objectId: scope.objectId });
		if (!fresh.ok) return { completedDrain, fresh, stale, afterStale };
		await store.close();
		store = await open(primary) as unknown as DurableLiveJournalStore;
		const reopened = await store.readRetirementImage!({ objectId: scope.objectId });
		const retry = await store.recordClosedMembership!({ scope: nextScope, exactCanonicalMembershipBytes: membership, expectedNativeImage: { imageDigest: fresh.value.imageDigest, controlBytes: fresh.value.controlBytes } });
		// Explicit persisted-schema corruption remains unsupported: never relax the
		// native decoder merely because logical controls are valid API evidence.
		const database = await requestResult(indexedDB.open(derived));
		try {
			const tx = database.transaction("retirementControls", "readwrite", { durability: "strict" });
			const terminal = transactionComplete(tx);
			tx.objectStore("retirementControls").put({ objectId: scope.objectId, record: expectedNativeImage.controlBytes });
			await terminal;
		} finally { database.close(); }
		const inlineRejected = await store.readRetirementImage!({ objectId: scope.objectId });
		return { completedDrain, fresh, stale, afterStale, reopened, retry, inlineRejected };
	} finally {
		await store.close();
		await deleteDatabase(derived);
	}
}

async function closedMembershipUpgrade(): Promise<unknown> {
	const {primary, derived, store: opened, values} = await seededPageStore(1);
	let store = opened as unknown as DurableLiveJournalStore;
	const scope = values.scope as LiveJournalScope;
	const read = async () => {
		const result = await store.readRetirementImage!({objectId: scope.objectId});
		if (!result.ok) throw new TypeError(result.kind);
		return result.value;
	};
	const currency = (value: Awaited<ReturnType<typeof read>>) => ({imageDigest: value.image.imageDigest,
		controlBytes: value.control === null ? null : encodeJournalRetirementControl(value.control)});
	// Opaque mechanical evidence; no fixture bytes establish close authority.
	const original = encodeCanonical({kind: "creator-close-membership-1", marker: 1});
	const fields = {kind: "creator-received-close-membership-1", exactCanonicalMembershipBytes: original,
		exactCanonicalCutValueBytes: Uint8Array.of(1), exactCanonicalCommitQcBytes: Uint8Array.of(2),
		exactCanonicalSuccessorTrustStateRecordBytes: Uint8Array.of(3)};
	const extended = encodeCanonical(fields);
	const record = (bytes: Uint8Array, expectedNativeImage: ReturnType<typeof currency>) =>
		store.recordClosedMembership!({scope, exactCanonicalMembershipBytes: bytes, expectedNativeImage});
	try {
		const empty = await read(), fresh = await record(original, currency(empty)), legacy = await read();
		const stale = await record(extended, currency(empty));
		const changed = await record(encodeCanonical({...fields, exactCanonicalMembershipBytes:
			encodeCanonical({kind: "creator-close-membership-1", marker: 2})}), currency(legacy));
		const overImage = encodeCanonical({...fields, exactCanonicalCommitQcBytes:
			new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes - extended.byteLength - 15)},
			{maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, maxItems: 65_536, maxDepth: 32});
		const bounded = await record(overImage, currency(legacy)), afterRefusals = await read();
		const upgrade = await record(extended, currency(legacy)), upgraded = await read();
		await store.close(); store = await open(primary) as unknown as DurableLiveJournalStore;
		const reopened = await read(), retry = await record(extended, currency(reopened));
		const downgrade = await record(original, currency(reopened));
		const rewrite = await record(encodeCanonical({...fields, exactCanonicalCommitQcBytes: Uint8Array.of(9)}), currency(reopened));
		return {fresh, stale, changed, bounded, legacy, afterRefusals, upgrade, upgraded, reopened, retry, downgrade, rewrite};
	} finally { await store.close(); await deleteDatabase(derived); }
}

// Exact native transaction identities, not database names or portable handles.
const retirementTransactionIds = new WeakMap<IDBTransaction, number>();
let nextRetirementTransactionId = 0;
async function measuredRetirementRead<T>(operation: () => Promise<T>,
	observeTransaction?: (transaction: IDBTransaction) => void): Promise<{
	value: T; cursors: {scopes: number; acceptedEntries: number}; getKeyInvocations: number; transactions: number[];
}> {
	const cursor = IDBObjectStore.prototype.openCursor, getKey = IDBObjectStore.prototype.getKey;
	const cursors = {scopes: 0, acceptedEntries: 0}, transactions = new Set<number>();
	let getKeyInvocations = 0;
	const observe = (transaction: IDBTransaction): void => {
		let identity = retirementTransactionIds.get(transaction);
		if (identity === undefined) { identity = ++nextRetirementTransactionId; retirementTransactionIds.set(transaction, identity); }
		transactions.add(identity); observeTransaction?.(transaction);
	};
	IDBObjectStore.prototype.openCursor = function (...args) {
		const request = Reflect.apply(cursor, this, args);
		if (this.name === "scopes" || this.name === "acceptedEntries") { cursors[this.name]++; observe(this.transaction); }
		return request;
	};
	IDBObjectStore.prototype.getKey = function (...args) {
		const request = Reflect.apply(getKey, this, args);
		getKeyInvocations++; observe(this.transaction);
		return request;
	};
	try { return {value: await operation(), cursors, getKeyInvocations, transactions: [...transactions]}; }
	finally { IDBObjectStore.prototype.openCursor = cursor; IDBObjectStore.prototype.getKey = getKey; }
}

async function reservedRetirementReuse(): Promise<unknown> {
	const {primary, derived, store, values} = await seededPageStore(4);
	const journal = store as unknown as DurableLiveJournalStore, objectId = (values.scope as LiveJournalScope).objectId;
	let held: Awaited<ReturnType<JournalStore["acquireNativeReadReservation"]>> | undefined;
	let second: JournalStore | undefined, write: Promise<unknown> | undefined;
	try {
		const control = await journal.acquireRetirementControl!({objectId});
		if (!control.ok) throw new TypeError("native retirement control birth failed");
		await control.value.release();
		// Opening a facade performs the original RW schema admission. Complete
		// it before the held RO book that must genuinely exclude native writers.
		second = await open(primary);
		held = await store.acquireNativeReadReservation({objectId});
		const first = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
		if (!first.value.ok) throw new TypeError("initial native retirement capture failed");
		const pristine = lowerHex(encodeCanonical(first.value));
		first.value.value.canonicalRows[0]!.fill(255);
		first.value.value.exactCanonicalControlCarriers[0]!.fill(255);
		const repeated = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
		const isolated = lowerHex(encodeCanonical(repeated.value)) === pristine;
		const wrongObject = await measuredRetirementRead(() => journal.readRetirementImage!({objectId: "uninstalled-object"}));
		const recaptured = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
		const foreignFacade = await measuredRetirementRead(() =>
			(second as unknown as DurableLiveJournalStore).readRetirementImage!({objectId}));
		let committed = false;
		write = second.appendAccepted(pageVertex(values, 4)).then(value => { committed = true; return value; });
		await new Promise(resolve => setTimeout(resolve, 30));
		const excluded = !committed;
		const duringForeign = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
		// The hit must await a genuine native turn; release revokes this queued call.
		const queued = journal.readRetirementImage!({objectId});
		const releasing = held.release();
		const afterRevocation = await journal.readRetirementImage!({objectId});
		const revokedQueued = await queued;
		await releasing; held = undefined;
		const appended = await write;
		const ordinary = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
		held = await store.acquireNativeReadReservation({objectId});
		const replacement = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
		const replacementRepeat = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
		const queuedClose = journal.readRetirementImage!({objectId});
		const closing = store.close();
		const afterClose = await journal.readRetirementImage!({objectId}), closedQueued = await queuedClose;
		await closing;
		return {first: {cursors: first.cursors, transactions: first.transactions}, repeated,
			isolated, wrongObject, recaptured, foreignFacade, excluded, duringForeign, revokedQueued, afterRevocation, appended, ordinary,
			replacement, replacementRepeat, closedQueued, afterClose};
	} finally {
		await Promise.allSettled([Promise.resolve().then(() => held?.release()), Promise.resolve().then(() => store.close()),
			Promise.resolve().then(() => write), Promise.resolve().then(() => second?.close())]);
		await deleteDatabase(derived);
	}
}

async function reservedRetirementAbort(): Promise<unknown> {
	const {derived, store, values} = await seededPageStore(4);
	const journal = store as unknown as DurableLiveJournalStore, objectId = (values.scope as LiveJournalScope).objectId;
	const held = await store.acquireNativeReadReservation({objectId});
	try {
		let transaction: IDBTransaction | undefined;
		const first = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}), value => { transaction = value; });
		if (!first.value.ok || transaction === undefined) throw new TypeError("exact native held retirement book absent");
		const probe = journal.readRetirementImage?.captureCurrentProbe?.(first.value.value);
		if (probe === undefined) throw new TypeError("genuine held retirement probe absent");
		transaction.abort(); // Original transaction only; no replacement or synthetic authority.
		let checkRejected = false;
		try { await held.check(); } catch { checkRejected = true; }
		const afterAbort = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
		const release = await Promise.allSettled([held.release()]);
		return {checkRejected, afterAbort, probeAfterAbort: await probe.checkCurrent(), releaseRejected: release[0]?.status === "rejected"};
	} finally {
		await Promise.allSettled([held.release(), store.close()]); await deleteDatabase(derived);
	}
}

async function reservedRetirementAdmission(): Promise<unknown> {
	const results: Record<string, unknown> = {};
	for (const fate of ["control-corruption", "native-byte-quota", "poisoned-facade"] as const) {
		const {derived, store, values} = await seededPageStore(4);
		const journal = store as unknown as DurableLiveJournalStore, objectId = (values.scope as LiveJournalScope).objectId;
		let held: Awaited<ReturnType<JournalStore["acquireNativeReadReservation"]>> | undefined;
		try {
			if (fate === "poisoned-facade") {
				const closure = await rawClosure(derived) as {rows: Record<string, unknown>[]};
				await replaceRaw(derived, "acceptedEntries", {...closure.rows[3], detachedSignature: new Uint8Array(1)});
				held = await store.acquireNativeReadReservation({objectId});
				// Retirement raw commitments are not authentication. A separate
				// original replay reader must still poison this facade in the SAME book.
				const initial = await journal.readRetirementImage!({objectId});
				if (!initial.ok) throw new TypeError("initial raw retirement commitment failed");
				const probe = journal.readRetirementImage?.captureCurrentProbe?.(initial.value);
				if (probe === undefined) throw new TypeError("genuine held retirement probe absent");
				const readiness = await store.readiness({scope: values.scope});
				results[fate] = {readiness, probeAfterPoison: await probe.checkCurrent(),
					after: await measuredRetirementRead(() => journal.readRetirementImage!({objectId}))};
				continue;
			}
			held = await store.acquireNativeReadReservation({objectId});
			const initial = await journal.readRetirementImage!({objectId});
			if (!initial.ok) throw new TypeError("initial native retirement capture failed");
			await held.release(); held = undefined;
			if (fate === "control-corruption") {
				const database = await requestResult(indexedDB.open(derived));
				try { const tx = database.transaction("retirementControls", "readwrite", {durability: "strict"});
					const terminal = transactionComplete(tx); tx.objectStore("retirementControls").put({objectId, record: new Uint8Array(1)}); await terminal;
				} finally { database.close(); }
			} else {
				const closure = await rawClosure(derived) as {scopes: Record<string, unknown>[]};
				await replaceRaw(derived, "scopes", {...closure.scopes[0],
					detachedAnchorSignature: new Uint8Array(LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1)});
			}
			// Ordinary original capture pins the existing failure classification.
			const ordinary = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
			held = await store.acquireNativeReadReservation({objectId});
			const fresh = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
			const repeated = await measuredRetirementRead(() => journal.readRetirementImage!({objectId}));
			results[fate] = {ordinary, fresh, repeated};
		} finally {
			await Promise.allSettled([Promise.resolve().then(() => held?.release()), store.close()]); await deleteDatabase(derived);
		}
	}
	return results;
}

async function reservedRetirementCurrentProbe(): Promise<unknown> {
	const {primary, derived, store, values} = await seededPageStore(4);
	const journal = store as unknown as DurableLiveJournalStore, read = journal.readRetirementImage;
	const objectId = (values.scope as LiveJournalScope).objectId;
	if (read?.captureCurrentProbe === undefined) throw new TypeError("current probe native port absent");
	let held: Awaited<ReturnType<JournalStore["acquireNativeReadReservation"]>> | undefined;
	let second: JournalStore | undefined, write: Promise<unknown> | undefined;
	try {
		const control = await journal.acquireRetirementControl!({objectId});
		if (!control.ok) throw new TypeError("native retirement control birth failed");
		await control.value.release(); second = await open(primary);
		held = await store.acquireNativeReadReservation({objectId});
		const first = await measuredRetirementRead(() => read({objectId}));
		if (!first.value.ok) throw new TypeError("initial retirement capture failed");
		const copiedObservationRefused = read.captureCurrentProbe({...first.value.value}) === undefined;
		const forgedObservationRefused = read.captureCurrentProbe(decodeCanonical(encodeCanonical(first.value.value)) as typeof first.value.value) === undefined;
		const wrongProducerReceiverRefused = Reflect.apply(read.captureCurrentProbe, read.bind(journal), [first.value.value]) === undefined;
		const probe = read.captureCurrentProbe(first.value.value);
		if (probe === undefined) throw new TypeError("genuine initial current probe absent");
		const consumedEnrollmentRefused = read.captureCurrentProbe(first.value.value) === undefined;
		first.value.value.canonicalRows[0]!.fill(255);
		first.value.value.exactCanonicalControlCarriers[0]!.fill(255);
		const isolated = await measuredRetirementRead(() => probe.checkCurrent());
		const harmlessRead = await measuredRetirementRead(() => read({objectId}));
		const afterHarmlessRead = await measuredRetirementRead(() => probe.checkCurrent());
		const mutated = await read({objectId}); if (!mutated.ok) throw new TypeError("same-book mutation control absent");
		mutated.value.canonicalRows[0]!.fill(254);
		const mutatedObservationRefused = read.captureCurrentProbe(mutated.value) === undefined;
		const afterMutatedObservation = await measuredRetirementRead(() => probe.checkCurrent());
		const wrongProbeReceiver = await Object.freeze({...probe}).checkCurrent();
		const evictingRead = await measuredRetirementRead(() => read({objectId: "uninstalled-object"}));
		const evicted = await measuredRetirementRead(() => probe.checkCurrent());
		const recaptured = await measuredRetirementRead(() => read({objectId}));
		if (!recaptured.value.ok) throw new TypeError("same-book recapture absent");
		const renewed = read.captureCurrentProbe(recaptured.value.value);
		if (renewed === undefined) throw new TypeError("same-book renewed probe absent");
		const afterRecapture = await measuredRetirementRead(() => renewed.checkCurrent());
		let committed = false;
		write = second.appendAccepted(pageVertex(values, 4)).then(value => {committed = true; return value;});
		await new Promise(resolve => setTimeout(resolve, 30));
		const excluded = !committed;
		const queued = renewed.checkCurrent(), releasing = held.release();
		const afterRevocation = await renewed.checkCurrent(), revokedQueued = await queued;
		await releasing; held = undefined; const appended = await write;
		held = await store.acquireNativeReadReservation({objectId});
		const replacement = await measuredRetirementRead(() => read({objectId}));
		if (!replacement.value.ok) throw new TypeError("replacement book capture absent");
		const wrongBookObservationRefused = read.captureCurrentProbe(recaptured.value.value) === undefined;
		const oldProbeNewBook = await renewed.checkCurrent();
		const next = read.captureCurrentProbe(replacement.value.value);
		if (next === undefined) throw new TypeError("replacement book probe absent");
		const replacementProbe = await measuredRetirementRead(() => next.checkCurrent());
		const queuedClose = next.checkCurrent(), closing = store.close();
		const afterClose = await next.checkCurrent(), closedQueued = await queuedClose; await closing;
		return {producerFrozen: Object.isFrozen(read), first, copiedObservationRefused, forgedObservationRefused,
			wrongProducerReceiverRefused, consumedEnrollmentRefused, mutatedObservationRefused, isolated, harmlessRead,
			afterHarmlessRead, afterMutatedObservation, wrongProbeReceiver,
			evictingRead, evicted, recaptured, afterRecapture, excluded, revokedQueued, afterRevocation, appended,
			replacement, wrongBookObservationRefused, oldProbeNewBook, replacementProbe, afterClose, closedQueued};
	} finally {
		await Promise.allSettled([Promise.resolve().then(() => held?.release()), Promise.resolve().then(() => store.close()),
			Promise.resolve().then(() => write), Promise.resolve().then(() => second?.close())]);
		await deleteDatabase(derived);
	}
}

async function reservedReadinessReuse(): Promise<unknown> {
	const { derived, store, values } = await seededPageStore(64);
	let held: Awaited<ReturnType<JournalStore["acquireNativeReadReservation"]>> | undefined;
	try {
		const first = await measuredPageRead(async () => {
			held = await store.acquireNativeReadReservation({objectId: Reflect.get(values.scope as object, "objectId") as string});
			const ready = await store.readiness({scope: values.scope});
			expectDataSuccess(ready);
			const repeated = [];
			for (let repeat = 0; repeat < 3; repeat++) repeated.push(await store.readiness({scope: values.scope}));
			const bounded = await store.readPage({scope: values.scope, snapshot: ready.snapshot, limit: 1});
			await held.check();
			return {ready, repeated, bounded};
		});
		await held?.release();
		held = undefined;
		// The original append owner's preparation/readback is not a readiness read.
		// Keep it outside these two explicitly scoped materialization measurements.
		const append = await store.appendAccepted(pageVertex(values, 64));
		expectDataSuccess(append);
		const afterAppend = await measuredPageRead(async () => {
			held = await store.acquireNativeReadReservation({objectId: Reflect.get(values.scope as object, "objectId") as string});
			const oldPrefix = await store.readPage({scope: values.scope, snapshot: first.value.ready.snapshot, limit: 1});
			const complete = await store.readiness({scope: values.scope});
			const completeRepeat = await store.readiness({scope: values.scope});
			await held.check();
			return {oldPrefix, complete, completeRepeat};
		});
		return {first, append, afterAppend};
	} finally {
		const joined = await Promise.allSettled([
			Promise.resolve().then(() => held?.release()), Promise.resolve().then(() => store.close()),
		]);
		await deleteDatabase(derived);
		const failures = joined.flatMap(result => result.status === "rejected" ? [result.reason] : []);
		if (failures.length) throw new AggregateError(failures, "original repeated-readiness owners failed to join");
	}
}

// Mechanical native replay coverage, not a claim of authenticated epoch activation.
async function reservedReadinessScopes(): Promise<unknown> {
	const {derived, store, values} = await seededPageStore(8);
	let held: Awaited<ReturnType<JournalStore["acquireNativeReadReservation"]>> | undefined;
	try {
		const scope = values.scope as LiveJournalScope;
		const install = values.install as {exactCanonicalAnchorPreimageBytes: Uint8Array};
		const anchor = decodeCanonical(install.exactCanonicalAnchorPreimageBytes) as Record<string, unknown>;
		const nextBytes = encodeCanonical({...anchor, epoch: 1, previousAnchor: scope.anchorDigest});
		const nextScope = {...scope, epoch: 1, anchorDigest: lowerHex(hashDomain("ts-drp/epoch-anchor/v3", nextBytes))};
		expectDataSuccess(await (store as unknown as DurableLiveJournalStore).installEpochAnchor({
			...install, exactCanonicalAnchorPreimageBytes: nextBytes,
		} as never));
		for (let sequence = 0; sequence < 4; sequence++)
			expectDataSuccess(await store.appendAccepted(pageVertex({...values, scope: nextScope}, sequence)));
		return await measuredPageRead(async () => {
			held = await store.acquireNativeReadReservation({objectId: scope.objectId});
			const first = await store.readiness({scope}); expectDataSuccess(first);
			const second = await store.readiness({scope: nextScope}); expectDataSuccess(second);
			const repeated = await store.readiness({scope}); expectDataSuccess(repeated);
			const page = await store.readPage({scope, snapshot: first.snapshot, limit: 1}); expectDataSuccess(page);
			const row = (page.rows as {exactCanonicalPreimageBytes: Uint8Array}[])[0];
			if (row === undefined) throw new TypeError("scope replay row absent");
			const originalByte = row.exactCanonicalPreimageBytes[0];
			row.exactCanonicalPreimageBytes.fill(255);
			const secondPage = await store.readPage({scope: nextScope, snapshot: second.snapshot, limit: 1});
			expectDataSuccess(secondPage);
			const detached = await store.readPage({scope, snapshot: first.snapshot, limit: 1}); expectDataSuccess(detached);
			const detachedByte = (detached.rows as {exactCanonicalPreimageBytes: Uint8Array}[])[0]?.exactCanonicalPreimageBytes[0];
			await held.check(); await held.release(); held = undefined;
			held = await store.acquireNativeReadReservation({objectId: scope.objectId});
			const replacement = await store.readiness({scope}); expectDataSuccess(replacement); await held.check();
			return {first, second, repeated, replacement, originalByte, detachedByte};
		});
	} finally {
		await held?.release(); await store.close(); await deleteDatabase(derived);
	}
}

async function incrementalReplayValidation(): Promise<unknown> {
	const {primary, derived, store, values} = await seededPageStore(8);
	let other: JournalStore | undefined;
	const measure = async <T>(operation: () => Promise<T>) => {
		const original = TextDecoder.prototype.decode;
		let strings = 0;
		TextDecoder.prototype.decode = function (...args) { strings++; return original.apply(this, args); };
		try { return await measuredPageRead(async () => ({value: await operation(), strings: () => strings})); }
		finally { TextDecoder.prototype.decode = original; }
	};
	// Return plain scalar observations; never serialize a function as evidence.
	const read = async (owner: JournalStore) => {
		const measured = await measure(() => owner.readiness({scope: values.scope}));
		return {...measured, value: measured.value.value, strings: measured.value.strings()};
	};
	try {
		const first = await read(store), repeated = await read(store);
		const ready = repeated.value; expectDataSuccess(ready);
		const page = await store.readPage({scope: values.scope, snapshot: ready.snapshot, limit: 1}); expectDataSuccess(page);
		const returned = (page.rows as {exactCanonicalPreimageBytes: Uint8Array; detachedSignature: Uint8Array}[])[0];
		if (returned === undefined) throw new TypeError("incremental replay row absent");
		returned.exactCanonicalPreimageBytes.fill(255); returned.detachedSignature.fill(255);
		const afterMutation = await read(store);
		other = await open(primary);
		const foreignFirst = await read(other), foreignRepeated = await read(other);
		await other.close(); other = undefined;
		const raw = await rawClosure(derived) as {rows: Record<string, unknown>[]};
		const row = raw.rows[0]; if (row === undefined) throw new TypeError("native replay row absent");
		await replaceRaw(derived, "acceptedEntries", {...row, exactCanonicalPreimageBytes: new Uint8Array([255])});
		const corrupted = await read(store);
		return {first, repeated, afterMutation, foreignFirst, foreignRepeated, corrupted};
	} finally {
		await other?.close(); await store.close(); await deleteDatabase(derived);
	}
}

async function reservedPageBound(): Promise<unknown> {
	const { derived, store, values } = await seededPageStore(64);
	const held = await store.acquireNativeReadReservation({
		objectId: Reflect.get(values.scope as object, "objectId") as string,
	});
	try {
		return await measuredPageRead(async () => {
			const ready = await store.readiness({ scope: values.scope });
			expectDataSuccess(ready);
			const first = await store.readPage({
				scope: values.scope,
				snapshot: ready.snapshot,
				afterSequence: null,
				limit: 2,
			});
			expectDataSuccess(first);
			const rows = first.rows as { detachedSignature: Uint8Array; exactCanonicalPreimageBytes: Uint8Array }[];
			const firstRow = rows[0];
			if (firstRow === undefined) throw new TypeError("expected nonempty native page");
			const detached = { signature: firstRow.detachedSignature[0], bytes: firstRow.exactCanonicalPreimageBytes[0] };
			firstRow.detachedSignature.fill(255);
			firstRow.exactCanonicalPreimageBytes.fill(255);
			const repeat = await store.readPage({
				scope: values.scope,
				snapshot: ready.snapshot,
				afterSequence: null,
				limit: 2,
			});
			const tail = await store.readPage({ scope: values.scope, snapshot: ready.snapshot, afterSequence: 61, limit: 2 });
			const empty = await store.readPage({
				scope: values.scope,
				snapshot: ready.snapshot,
				afterSequence: Number.MAX_SAFE_INTEGER,
				limit: 2,
			});
			await held.check();
			return {
				ready,
				first,
				repeat,
				tail,
				empty,
				detached,
				frozen:
					Object.isFrozen(repeat) &&
					Object.isFrozen(repeat.rows) &&
					(repeat.rows as object[]).every((row) => Object.isFrozen(row) && Object.isFrozen(Reflect.get(row, "scope"))),
			};
		});
	} finally {
		await held.release();
		await store.close();
		await deleteDatabase(derived);
	}
}

async function reservedPageForeign(): Promise<unknown> {
	const { derived, store, values } = await seededPageStore(8);
	const closure = (await rawClosure(derived)) as { rows: Record<string, unknown>[] };
	const foreign = await requestResult(indexedDB.open(derived));
	const held = await store.acquireNativeReadReservation({
		objectId: Reflect.get(values.scope as object, "objectId") as string,
	});
	let write: Promise<void> | undefined;
	try {
		const ready = await store.readiness({ scope: values.scope });
		const transaction = foreign.transaction("acceptedEntries", "readwrite", { durability: "strict" });
		let committed = false,
			requestSucceeded = false;
		const terminal = transactionComplete(transaction);
		const request = transaction
			.objectStore("acceptedEntries")
			.put({ ...closure.rows[7], detachedSignature: new Uint8Array(1) });
		write = Promise.all([
			requestResult(request).then(() => {
				requestSucceeded = true;
			}),
			terminal.then(() => {
				committed = true;
			}),
		]).then(() => undefined);
		void write.catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 30));
		const before = { committed, requestSucceeded };
		const during = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: ready.snapshot, limit: 1 })
		);
		await held.release();
		await write;
		const after = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: ready.snapshot, limit: 1 })
		);
		const sticky = await store.readiness({ scope: values.scope });
		return { before, during, after, sticky, committed, requestSucceeded };
	} finally {
		await held.release();
		await write;
		foreign.close();
		await store.close();
		await deleteDatabase(derived);
	}
}

async function reservedPageLifetime(): Promise<unknown> {
	const { primary, derived, store, values } = await seededPageStore(4);
	const second = await open(primary);
	let held: Awaited<ReturnType<JournalStore["acquireNativeReadReservation"]>> | undefined;
	try {
		const outside = await store.readiness({ scope: values.scope });
		held = await store.acquireNativeReadReservation({
			objectId: Reflect.get(values.scope as object, "objectId") as string,
		});
		const newTransaction = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: outside.snapshot, limit: 1 })
		);
		const reused = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: outside.snapshot, limit: 1 })
		);
		await held.release();
		held = undefined;
		expectDataSuccess(await second.appendAccepted(pageVertex(values, 4)));
		const unreserved = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: outside.snapshot, afterSequence: 2, limit: 2 })
		);
		held = await store.acquireNativeReadReservation({
			objectId: Reflect.get(values.scope as object, "objectId") as string,
		});
		const restored = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: outside.snapshot, afterSequence: 2, limit: 2 })
		);
		const prefix = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: outside.snapshot, afterSequence: 2, limit: 2 })
		);
		const forged = await measuredPageRead(() =>
			store.readPage({
				scope: values.scope,
				snapshot: { ...(outside.snapshot as object), orderedRowDigest: "f".repeat(64) },
				limit: 1,
			})
		);
		const stale = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: { ...(outside.snapshot as object), highWatermark: 6 }, limit: 1 })
		);
		const wrong = await measuredPageRead(() =>
			store.readPage({
				scope: { ...(values.scope as object), anchorDigest: "a".repeat(64) },
				snapshot: outside.snapshot,
				limit: 1,
			})
		);
		await held.release();
		held = undefined;
		expectDataSuccess(await store.appendAccepted(pageVertex(values, 5)));
		const ownAppend = await measuredPageRead(() =>
			store.readPage({ scope: values.scope, snapshot: outside.snapshot, afterSequence: 2, limit: 2 })
		);
		return { newTransaction, reused, unreserved, restored, prefix, forged, stale, wrong, ownAppend };
	} finally {
		await held?.release();
		await Promise.all([store.close(), second.close()]);
		await deleteDatabase(derived);
	}
}

async function reservedPagePoison(): Promise<unknown> {
	const results: Record<string, unknown> = {};
	for (const fate of ["hole", "offpage", "header", "absent", "wrong-anchor", "duplicate"] as const) {
		const { derived, store, values } = await seededPageStore(4);
		const held = await store.acquireNativeReadReservation({
			objectId: Reflect.get(values.scope as object, "objectId") as string,
		});
		try {
			const ready = await store.readiness({ scope: values.scope });
			await held.release();
			const closure = (await rawClosure(derived)) as {
				rows: Record<string, unknown>[];
				scopes: Record<string, unknown>[];
			};
			const scope = values.scope as { objectId: string; anchorDigest: string };
			const key: IDBValidKey = [scope.objectId, 0, scope.anchorDigest];
			let scopeRequest: unknown = values.scope;
			let snapshot: unknown = ready.snapshot;
			let duplicateRefused: boolean | undefined;
			if (fate === "hole") await deleteRaw(derived, "acceptedEntries", [...(key as IDBValidKey[]), 3]);
			if (fate === "offpage")
				await replaceRaw(derived, "acceptedEntries", { ...closure.rows[3], detachedSignature: new Uint8Array(1) });
			if (fate === "header" || fate === "wrong-anchor")
				await replaceRaw(derived, "scopes", { ...closure.scopes[0], detachedAnchorSignature: new Uint8Array(1) });
			if (fate === "absent") await deleteRaw(derived, "scopes", key);
			if (fate === "wrong-anchor") {
				scopeRequest = { ...scope, epoch: 0, anchorDigest: "a".repeat(64) };
				snapshot = { ...(ready.snapshot as object), scope: scopeRequest };
			}
			if (fate === "duplicate") {
				const firstRow = closure.rows[0];
				if (firstRow === undefined) throw new TypeError("expected original seeded native row");
				try {
					await replaceRaw(derived, "acceptedEntries", {
						...closure.rows[3],
						vertexDigest: firstRow.vertexDigest,
					});
					duplicateRefused = false;
				} catch {
					duplicateRefused = true;
				}
			}
			const page = await measuredPageRead(() => store.readPage({ scope: scopeRequest, snapshot, limit: 1 }));
			const next = await store.readiness({ scope: values.scope });
			results[fate] = { page, next, duplicateRefused };
		} finally {
			await held.release();
			await store.close();
			await deleteDatabase(derived);
		}
	}
	return results;
}

window.phase3a1bP4Run = (caseId): Promise<unknown> => {
	if (caseId === "reserved-retirement-current-probe") return reservedRetirementCurrentProbe();
	if (caseId === "reserved-retirement-reuse") return reservedRetirementReuse();
	if (caseId === "reserved-retirement-abort") return reservedRetirementAbort();
	if (caseId === "reserved-retirement-admission") return reservedRetirementAdmission();
	if (caseId === "closed-membership-after-drain") return closedMembershipAfterDrain();
	if (caseId === "closed-membership-upgrade") return closedMembershipUpgrade();
	if (caseId === "reserved-readiness-reuse") return reservedReadinessReuse();
	if (caseId === "reserved-readiness-scopes") return reservedReadinessScopes();
	if (caseId === "incremental-replay-validation") return incrementalReplayValidation();
	if (caseId === "reserved-page-bound") return reservedPageBound();
	if (caseId === "reserved-page-foreign") return reservedPageForeign();
	if (caseId === "reserved-page-lifetime") return reservedPageLifetime();
	if (caseId === "reserved-page-poison") return reservedPagePoison();
	if (caseId === "decision-mutants") return decisionMutants();
	if (caseId === "surface-schema") return surfaceSchema();
	if (caseId === "lifecycle") return lifecycle();
	if (caseId === "duplicates") return duplicateMatrix();
	if (caseId === "faults") return readbackFaults();
	if (caseId === "interleaving") return legalReadbackInterleave();
	if (caseId === "persisted-shapes") return persistedShapes();
	if (caseId === "strict-downgrade") return strictDowngrade();
	return concurrency();
};

import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

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

window.phase3a1bP4Run = (caseId): Promise<unknown> => {
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

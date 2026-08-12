import { encodeCanonical } from "@ts-drp/canonical";

// eslint-disable-next-line import/no-unresolved -- resolved by the private RED bundler.
import { createBrowserDurableIssuanceStore } from "#phase-2l-b-candidate";
// eslint-disable-next-line import/no-unresolved -- resolved by the private RED bundler.
import { runBrowserTerminalAmbiguityCase } from "#phase-2l-b-test-control";
import {
	type Phase2lBCommit,
	type Phase2lBEnvelope,
	type Phase2lBScope,
	type Phase2lBStore,
	PHASE_2L_B_AMBIGUITY_CASES,
	type PHASE_2L_B_FAST_CASES,
	PHASE_2L_B_SCHEMA,
} from "../fixtures/phase-2l-b-browser-issuance-contract.js";

type FastCase = (typeof PHASE_2L_B_FAST_CASES)[number];

declare global {
	interface Window {
		phase2lBRunFastCase(caseId: FastCase): Promise<unknown>;
	}
}

const SUFFIX = "--drp-issuance-v1";
const SCOPE = Object.freeze({ author: "alice", objectId: "room:alpha" });

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

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolve(), { once: true });
		request.addEventListener("blocked", () => reject(new Error(`delete blocked: ${name}`)), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error(`delete failed: ${name}`)), {
			once: true,
		});
	});
}

async function openRaw(
	name: string,
	version?: number,
	upgrade?: (database: IDBDatabase) => void
): Promise<IDBDatabase> {
	const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
	if (upgrade !== undefined) request.addEventListener("upgradeneeded", () => upgrade(request.result), { once: true });
	return requestResult(request);
}

async function rawSchema(name: string): Promise<unknown> {
	const database = await openRaw(name);
	try {
		const transaction = database.transaction([...database.objectStoreNames], "readonly");
		const stores = [...database.objectStoreNames].map((storeName) => {
			const store = transaction.objectStore(storeName);
			return {
				autoIncrement: store.autoIncrement,
				indexes: [...store.indexNames],
				keyPath: Array.isArray(store.keyPath) ? [...store.keyPath] : store.keyPath,
				name: storeName,
			};
		});
		await transactionComplete(transaction);
		return { databaseVersion: database.version, stores };
	} finally {
		database.close();
	}
}

function envelope(scope: Phase2lBScope, authorSequence: number, seed = 7): Phase2lBEnvelope {
	return {
		canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
}

function commit(scope: Phase2lBScope, authorSequence: number, seed = 7): Phase2lBCommit {
	const signed = envelope(scope, authorSequence, seed);
	return {
		authorSequence,
		envelope: signed,
		issuedRecord: { authorSequence, envelope: signed, scope },
		outboxEntry: { authorSequence, envelope: signed, scope },
	};
}

async function rejection(promise: Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		await promise;
		return { code: "RESOLVED" };
	} catch (error) {
		if (typeof error !== "object" || error === null) return { code: "NON_OBJECT" };
		return {
			code: String(Reflect.get(error, "code")),
			keys: Object.keys(error),
			name: String(Reflect.get(error, "name")),
			retryClass: Reflect.get(error, "retryClass"),
		};
	}
}

async function withStore<T>(primary: string, run: (store: Phase2lBStore) => Promise<T>): Promise<T> {
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: primary });
	try {
		return await run(store);
	} finally {
		await store.close();
	}
}

async function surfaceOptionsIdentity(): Promise<unknown> {
	const invalid: unknown[] = [
		undefined,
		null,
		"legacy",
		[],
		new String("boxed"),
		{},
		{ databaseName: "alias" },
		{ primaryDatabaseName: "x", extra: true },
	];
	const observations: unknown[] = [];
	for (const value of invalid) {
		let returned: Promise<unknown> | undefined;
		let synchronous = false;
		try {
			returned = Reflect.apply(createBrowserDurableIssuanceStore, undefined, [value]) as Promise<unknown>;
		} catch {
			synchronous = true;
		}
		observations.push({ rejection: returned === undefined ? null : await rejection(returned), synchronous });
	}
	let getterCalls = 0;
	const accessor = Object.defineProperty({}, "primaryDatabaseName", {
		enumerable: true,
		get: () => {
			getterCalls++;
			return "getter";
		},
	});
	observations.push({
		accessor: await rejection(Reflect.apply(createBrowserDurableIssuanceStore, undefined, [accessor])),
		getterCalls,
	});
	const validNames = ["   ", "n".repeat(1025), `e\u0301-${crypto.randomUUID()}`];
	const derived: string[] = [];
	for (const primaryDatabaseName of validNames) {
		const store = await createBrowserDurableIssuanceStore(Object.freeze({ primaryDatabaseName }));
		derived.push(`${primaryDatabaseName}${SUFFIX}`);
		await store.close();
		await deleteDatabase(`${primaryDatabaseName}${SUFFIX}`);
	}
	const primary = `phase-2l-b-surface-${crypto.randomUUID()}`;
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: primary });
	const closeA = store.close();
	const closeB = store.close();
	await closeA;
	await deleteDatabase(`${primary}${SUFFIX}`);
	return {
		closeSamePromise: closeA === closeB,
		derived,
		getterCalls,
		invalid: observations,
		keys: Object.keys(store).sort(),
		prototypeKeys: Reflect.ownKeys(Object.getPrototypeOf(store) ?? {}).filter((key) => key !== "constructor"),
	};
}

async function primaryOpacitySchemaAdmission(): Promise<unknown> {
	const absentPrimary = `phase-2l-b-absent-${crypto.randomUUID()}`;
	await withStore(absentPrimary, () => Promise.resolve(undefined));
	const namesAfterAbsent = (await indexedDB.databases()).map(({ name }) => name);
	const primary = `phase-2l-b-primary-${crypto.randomUUID()}`;
	const derived = `${primary}${SUFFIX}`;
	const sentinel = await openRaw(primary, 7, (database) => database.createObjectStore("sentinel", { keyPath: "id" }));
	sentinel.close();
	await withStore(primary, () => Promise.resolve(undefined));
	const primaryAfter = await openRaw(primary);
	const primaryObservation = { stores: [...primaryAfter.objectStoreNames], version: primaryAfter.version };
	primaryAfter.close();
	const schema = await rawSchema(derived);
	const aheShaped = `phase-2l-b-ahe-shaped-${crypto.randomUUID()}${SUFFIX}`;
	const bad = await openRaw(aheShaped, 1, (database) => database.createObjectStore("objects", { keyPath: "objectId" }));
	bad.close();
	const badPrimary = aheShaped.slice(0, -SUFFIX.length);
	const badError = await rejection(createBrowserDurableIssuanceStore({ primaryDatabaseName: badPrimary }));
	await Promise.all([
		deleteDatabase(`${absentPrimary}${SUFFIX}`),
		deleteDatabase(primary),
		deleteDatabase(derived),
		deleteDatabase(aheShaped),
	]);
	return {
		absentPrimaryCreated: namesAfterAbsent.includes(absentPrimary),
		badError,
		primaryObservation,
		schema,
	};
}

async function issueReadCopyPaging(): Promise<unknown> {
	const primary = `phase-2l-b-issue-${crypto.randomUUID()}`;
	const result = await withStore(primary, async (store) => {
		const source = commit(SCOPE, 0, 23);
		const issued = await store.transactIssue(SCOPE, () => Promise.resolve(source));
		source.envelope.digest.fill(0);
		issued.envelope.signature.fill(0);
		const first = await store.readIssued(SCOPE, 0);
		const second = await store.readIssued(SCOPE, 0);
		const scopes = [
			{ author: "z", objectId: "\ue000" },
			{ author: "a", objectId: "😀" },
			{ author: "a", objectId: "a" },
		];
		for (const scope of scopes)
			await store.transactIssue(scope, (selected: number) => Promise.resolve(commit(scope, selected)));
		const page = await store.readOutboxPage();
		return {
			copy: {
				digest: [...(first?.envelope.digest ?? [])],
				freshEnvelope: first?.envelope !== second?.envelope,
				freshGraph: first !== second,
				signature: [...(first?.envelope.signature ?? [])],
			},
			lineage: await store.readLineage(SCOPE),
			order: page.map(({ commit: row }) => [
				row.outboxEntry.scope.objectId,
				row.outboxEntry.scope.author,
				row.authorSequence,
			]),
		};
	});
	const schema = await rawSchema(`${primary}${SUFFIX}`);
	await deleteDatabase(`${primary}${SUFFIX}`);
	return { ...result, schema };
}

async function sameScopeRaceAndCrossScopeProgress(): Promise<unknown> {
	const primary = `phase-2l-b-race-${crypto.randomUUID()}`;
	const first = await createBrowserDurableIssuanceStore({ primaryDatabaseName: primary });
	const second = await createBrowserDurableIssuanceStore({ primaryDatabaseName: primary });
	try {
		let entered = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => (release = resolve));
		const calls = [first, second].map((store, seed) =>
			store.transactIssue(SCOPE, async (selected: number) => {
				entered++;
				if (entered === 2) release();
				await barrier;
				return commit(SCOPE, selected, seed + 1);
			})
		);
		const race = await Promise.allSettled(calls);
		let releaseA!: () => void;
		let enteredA!: () => void;
		const aGate = new Promise<void>((resolve) => (releaseA = resolve));
		const aEntered = new Promise<void>((resolve) => (enteredA = resolve));
		const scopeA = { author: "a", objectId: "world:a" };
		const scopeB = { author: "b", objectId: "world:b" };
		const a = first.transactIssue(scopeA, async (selected: number) => {
			enteredA();
			await aGate;
			return commit(scopeA, selected);
		});
		await aEntered;
		const b = await second.transactIssue(scopeB, (selected: number) => Promise.resolve(commit(scopeB, selected)));
		releaseA();
		await a;
		return {
			buildCalls: entered,
			crossScopeB: b.authorSequence,
			lineage: await first.readLineage(SCOPE),
			outboxCount: (await first.readOutboxPage({ scope: SCOPE })).length,
			race: race.map((outcome) =>
				outcome.status === "fulfilled" ? "success" : String(Reflect.get(outcome.reason as object, "code"))
			),
		};
	} finally {
		await Promise.all([first.close(), second.close()]);
		await deleteDatabase(`${primary}${SUFFIX}`);
	}
}

async function closeVersionchangeAndMax(): Promise<unknown> {
	const primary = `phase-2l-b-close-${crypto.randomUUID()}`;
	const derived = `${primary}${SUFFIX}`;
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: primary });
	let release!: (value: Phase2lBCommit) => void;
	let entered!: () => void;
	const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
	const pending = store.transactIssue(SCOPE, (selected: number) => {
		void selected;
		entered();
		return new Promise((resolve) => (release = resolve));
	});
	await enteredPromise;
	const closeA = store.close();
	const closeB = store.close();
	const closeWon = await Promise.race([
		closeA.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
	]);
	release(commit(SCOPE, 0));
	const suspendedError = await rejection(pending);
	await deleteDatabase(derived);

	const maxPrimary = `phase-2l-b-max-${crypto.randomUUID()}`;
	const maxDerived = `${maxPrimary}${SUFFIX}`;
	await withStore(maxPrimary, () => Promise.resolve(undefined));
	const raw = await openRaw(maxDerived);
	const transaction = raw.transaction("lineages", "readwrite", { durability: "strict" });
	transaction.objectStore("lineages").add({ ...SCOPE, exhausted: false, next: Number.MAX_SAFE_INTEGER });
	await transactionComplete(transaction);
	raw.close();
	const max = await withStore(maxPrimary, async (maxStore) => {
		let builds = 0;
		const final = await maxStore.transactIssue(SCOPE, (selected: number) => {
			builds++;
			return Promise.resolve(commit(SCOPE, selected));
		});
		const exhausted = await rejection(
			maxStore.transactIssue(SCOPE, (selected: number) => {
				builds++;
				return Promise.resolve(commit(SCOPE, selected));
			})
		);
		return { builds, exhausted, final: final.authorSequence, lineage: await maxStore.readLineage(SCOPE) };
	});
	await deleteDatabase(maxDerived);
	return { closeSamePromise: closeA === closeB, closeWon, max, suspendedError };
}

async function collisionPoisonAndAmbiguity(): Promise<unknown> {
	const primary = `phase-2l-b-collision-${crypto.randomUUID()}`;
	const derived = `${primary}${SUFFIX}`;
	await withStore(primary, () => Promise.resolve(undefined));
	const raw = await openRaw(derived);
	const transaction = raw.transaction("issuedRecords", "readwrite", { durability: "strict" });
	transaction.objectStore("issuedRecords").add({
		...SCOPE,
		authorSequence: 0,
		canonicalPreimageBytes: encodeCanonical({ ...SCOPE, authorSequence: 0 }),
		digest: Uint8Array.of(8),
		signature: Uint8Array.of(9),
	});
	await transactionComplete(transaction);
	raw.close();
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: primary });
	const first = await rejection(
		store.transactIssue(SCOPE, (selected: number) => Promise.resolve(commit(SCOPE, selected)))
	);
	const second = await rejection(store.readLineage(SCOPE));
	await store.close();
	await deleteDatabase(derived);
	const ambiguity = await Promise.all(
		PHASE_2L_B_AMBIGUITY_CASES.map(async (caseId) => {
			const casePrimary = `phase-2l-b-ambiguity-${caseId}-${crypto.randomUUID()}`;
			try {
				return { caseId, ...(await runBrowserTerminalAmbiguityCase({ caseId, primaryDatabaseName: casePrimary })) };
			} finally {
				await deleteDatabase(`${casePrimary}${SUFFIX}`).catch(() => undefined);
			}
		})
	);
	return { ambiguity, collision: [first, second] };
}

async function runFastCase(caseId: FastCase): Promise<unknown> {
	switch (caseId) {
		case "surface-options-identity":
			return surfaceOptionsIdentity();
		case "primary-opacity-schema-admission":
			return primaryOpacitySchemaAdmission();
		case "issue-read-copy-paging":
			return issueReadCopyPaging();
		case "same-scope-race-and-cross-scope-progress":
			return sameScopeRaceAndCrossScopeProgress();
		case "close-versionchange-and-max":
			return closeVersionchangeAndMax();
		case "collision-poison-and-ambiguity":
			return collisionPoisonAndAmbiguity();
	}
}

window.phase2lBRunFastCase = async (caseId: FastCase): Promise<unknown> => {
	try {
		return { candidateAvailable: true, value: await runFastCase(caseId) };
	} catch (error) {
		return {
			candidateAvailable: false,
			failure: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error) },
		};
	}
};

void PHASE_2L_B_SCHEMA;

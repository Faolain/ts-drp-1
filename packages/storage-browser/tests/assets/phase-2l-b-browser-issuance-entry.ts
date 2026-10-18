import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueSignContext } from "@ts-drp/issuance-store";
import {
	decodeIssuanceRetirementControl,
	durableIssuancePruningMaintenanceForStore,
	encodeIssuanceRetirementControl,
	ISSUANCE_RETIREMENT_LIMITS,
} from "@ts-drp/issuance-store/maintenance";
import { createAdmissionBoundTransactionalVertexIssuer, prepareBlueprintAdmission } from "@ts-drp/protocol-v3";

// eslint-disable-next-line import/no-unresolved -- resolved by the private RED bundler.
import { createBrowserDurableIssuanceStore } from "#phase-2l-b-candidate";
// eslint-disable-next-line import/no-unresolved -- resolved by the private RED bundler.
import { runBrowserTerminalAmbiguityCase } from "#phase-2l-b-test-control";
import originalAdmission from "../../../../tests/fixtures/phase-0i-v3/blueprint-admission-package.json" with { type: "json" };
import { createBrowserDurableIssuanceStore as createOriginalStore } from "../../src/issuance.js";
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
	const nativeControlName = `phase-2l-b-native-schema-${crypto.randomUUID()}`;
	const nativeControl = await openRaw(nativeControlName, 1, (database) => {
		database.createObjectStore("lineages", { keyPath: ["objectId", "author"] });
		database.createObjectStore("issuedRecords", { keyPath: ["objectId", "author", "authorSequence"] });
		database.createObjectStore("issuanceOutbox", { keyPath: ["objectId", "author", "authorSequence"] });
	});
	nativeControl.close();
	const nativeSchemaControl = await rawSchema(nativeControlName);
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
		deleteDatabase(nativeControlName),
		deleteDatabase(`${absentPrimary}${SUFFIX}`),
		deleteDatabase(primary),
		deleteDatabase(derived),
		deleteDatabase(aheShaped),
	]);
	return {
		absentPrimaryCreated: namesAfterAbsent.includes(absentPrimary),
		badError,
		nativeSchemaControl,
		primaryObservation,
		schema,
	};
}

async function v1UpgradePreservesCommittedRows(): Promise<unknown> {
	const primary = `phase-2l-b-v1-upgrade-${crypto.randomUUID()}`;
	const derived = `${primary}${SUFFIX}`;
	const source = commit(SCOPE, 0, 37);
	const legacy = await openRaw(derived, 1, (database) => {
		database.createObjectStore("lineages", { keyPath: ["objectId", "author"] });
		database.createObjectStore("issuedRecords", { keyPath: ["objectId", "author", "authorSequence"] });
		database.createObjectStore("issuanceOutbox", { keyPath: ["objectId", "author", "authorSequence"] });
	});
	const seed = legacy.transaction(["lineages", "issuedRecords", "issuanceOutbox"], "readwrite", {
		durability: "strict",
	});
	seed.objectStore("lineages").add({ ...SCOPE, exhausted: false, next: 1 });
	seed.objectStore("issuedRecords").add({
		...SCOPE,
		authorSequence: source.authorSequence,
		canonicalPreimageBytes: source.envelope.canonicalPreimageBytes,
		digest: source.envelope.digest,
		signature: source.envelope.signature,
	});
	seed.objectStore("issuanceOutbox").add({
		...SCOPE,
		authorSequence: source.authorSequence,
		digest: source.envelope.digest,
		publishState: "published",
	});
	await transactionComplete(seed);
	legacy.close();

	const beforeSchema = await rawSchema(derived);
	const readable = await withStore(primary, async (store) => {
		const issued = await store.readIssued(SCOPE, 0);
		const outbox = await store.readOutboxPage({ scope: SCOPE });
		return {
			issued:
				issued === null
					? null
					: {
							authorSequence: issued.authorSequence,
							canonicalPreimageBytes: [...issued.envelope.canonicalPreimageBytes],
							digest: [...issued.envelope.digest],
							issuedScope: issued.issuedRecord.scope,
							outboxScope: issued.outboxEntry.scope,
							signature: [...issued.envelope.signature],
						},
			lineage: await store.readLineage(SCOPE),
			outbox: outbox.map((row) => ({
				authorSequence: row.commit.authorSequence,
				digest: [...row.commit.envelope.digest],
				publishState: row.publishState,
				scope: row.commit.outboxEntry.scope,
			})),
			settlementPlan: await store.readSettlementPlan(SCOPE),
		};
	});
	const afterSchema = await rawSchema(derived);
	await deleteDatabase(derived);
	return {
		afterSchema,
		beforeSchema,
		expectedCanonicalPreimageBytes: [...source.envelope.canonicalPreimageBytes],
		readable,
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
		const selected = page.find(({ commit: row }) => row.outboxEntry.scope.objectId === SCOPE.objectId)?.commit;
		if (selected === undefined) throw new Error("issued outbox row missing");
		const envelopes = [selected.envelope, selected.issuedRecord.envelope, selected.outboxEntry.envelope];
		const independentEnvelopes =
			new Set(envelopes).size === 3 &&
			new Set(envelopes.map((envelope) => envelope.canonicalPreimageBytes.buffer)).size === 3 &&
			new Set(envelopes.map((envelope) => envelope.digest.buffer)).size === 3 &&
			new Set(envelopes.map((envelope) => envelope.signature.buffer)).size === 3;
		const independentScopes = selected.issuedRecord.scope !== selected.outboxEntry.scope;
		const expectedPreimage = [...selected.envelope.canonicalPreimageBytes];
		selected.envelope.digest.fill(0);
		selected.issuedRecord.envelope.signature.fill(0);
		selected.outboxEntry.envelope.canonicalPreimageBytes.fill(0);
		const fresh = (await store.readOutboxPage({ scope: SCOPE }))[0]?.commit;
		if (fresh === undefined) throw new Error("fresh issued outbox row missing");
		return {
			copy: {
				digest: [...(first?.envelope.digest ?? [])],
				freshEnvelope: first?.envelope !== second?.envelope,
				freshGraph: first !== second,
				signature: [...(first?.envelope.signature ?? [])],
			},
			lineage: await store.readLineage(SCOPE),
			outboxCopy: {
				independentEnvelopes,
				independentScopes,
				freshGraph: fresh !== selected && fresh.envelope !== selected.envelope,
				unchanged: [fresh.envelope, fresh.issuedRecord.envelope, fresh.outboxEntry.envelope].every(
					(envelope) =>
						JSON.stringify([...envelope.canonicalPreimageBytes]) === JSON.stringify(expectedPreimage) &&
						JSON.stringify([...envelope.digest]) === JSON.stringify([23, 209]) &&
						JSON.stringify([...envelope.signature]) === JSON.stringify([23, 81])
				),
			},
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

async function heldOutboxPageWork(): Promise<unknown> {
	const primary = `phase-2l-b-held-pages-${crypto.randomUUID()}`;
	const derived = `${primary}${SUFFIX}`;
	try {
		return await withStore(primary, async (store) => {
			for (let i = 0; i < 64; i++) {
				await store.transactIssue(SCOPE, (sequence) => Promise.resolve(commit(SCOPE, sequence)));
			}
			const acquire: unknown = Reflect.get(store, "acquireNativeReadReservation");
			if (typeof acquire !== "function") throw new Error("ORIGINAL_NATIVE_RESERVATION_REQUIRED");
			const held = (await Reflect.apply(acquire, store, [{ objectId: SCOPE.objectId }])) as {
				check(): Promise<void>;
				release(): Promise<void>;
			};
			const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "getAll");
			if (descriptor === undefined || typeof descriptor.value !== "function") throw new Error("native getAll missing");
			const reads: { store: string; rows: number; count: number | null }[] = [];
			const cursorDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "openCursor");
			if (cursorDescriptor === undefined || typeof cursorDescriptor.value !== "function") throw new Error("native cursor missing");
			const cursorRows: Record<string, number> = {};
			Object.defineProperty(IDBObjectStore.prototype, "openCursor", {
				...cursorDescriptor,
				value: function (this: IDBObjectStore, ...args: unknown[]): IDBRequest<IDBCursorWithValue | null> {
					const request = Reflect.apply(cursorDescriptor.value, this, args) as IDBRequest<IDBCursorWithValue | null>;
					request.addEventListener("success", () => {
						if (request.result !== null) cursorRows[this.name] = (cursorRows[this.name] ?? 0) + 1;
					});
					return request;
				},
			});
			Object.defineProperty(IDBObjectStore.prototype, "getAll", {
				...descriptor,
				value: function (this: IDBObjectStore, ...args: unknown[]): IDBRequest<unknown[]> {
					const request = Reflect.apply(descriptor.value, this, args) as IDBRequest<unknown[]>;
					request.addEventListener(
						"success",
						() =>
							reads.push({
								store: this.name,
								rows: request.result.length,
								count: typeof args[1] === "number" ? args[1] : null,
							}),
						{ once: true }
					);
					return request;
				},
			});
			let foreign: IDBDatabase | undefined;
			let foreignWork: Promise<void> | undefined;
			let released = false;
			try {
				const first = await store.readOutboxPage({ scope: SCOPE, limit: 2 });
				const initialReads = reads.splice(0);
				const initialCursorRows = { ...cursorRows };
				for (const name of Object.keys(cursorRows)) delete cursorRows[name];
				const second = await store.readOutboxPage({
					scope: SCOPE,
					afterKey: [SCOPE.objectId, SCOPE.author, 1],
					limit: 2,
				});
				const pageReads = reads.splice(0);
				// Begin a genuine foreign RW transaction against an off-page row.
				// Its first native request, not just its ACK, must remain excluded.
				foreign = await openRaw(derived);
				const transaction = foreign.transaction("issuanceOutbox", "readwrite", { durability: "strict" });
				const terminal = transactionComplete(transaction);
				let foreignRead = false;
				let foreignCommitted = false;
				foreignWork = (async (): Promise<void> => {
					const raw = await requestResult(
						transaction.objectStore("issuanceOutbox").get([SCOPE.objectId, SCOPE.author, 63])
					);
					foreignRead = true;
					await requestResult(transaction.objectStore("issuanceOutbox").put({ ...raw, digest: Uint8Array.of(99, 99) }));
					await terminal;
					foreignCommitted = true;
				})();
				void foreignWork.catch(() => undefined);
				const last = await store.readOutboxPage({
					scope: SCOPE,
					afterKey: [SCOPE.objectId, SCOPE.author, 62],
					limit: 2,
				});
				const lastReads = reads.splice(0);
				const absent = await store.readOutboxPage({ scope: SCOPE, afterKey: ["z", "z", 0], limit: 2 });
				await held.check();
				const excluded = { foreignRead, foreignCommitted };
				await held.release();
				released = true;
				await foreignWork;
				reads.splice(0);
				const postRelease = await rejection(store.readOutboxPage({ scope: SCOPE, limit: 2 }));
				return {
					initialReads,
					initialCursorRows,
					pageReads,
					lastReads,
					excluded,
					postRelease,
					postReleaseReads: reads.splice(0),
					postReleaseCursorRows: { ...cursorRows },
					foreignRead,
					foreignCommitted,
					first: first.map((row) => row.commit.authorSequence),
					second: second.map((row) => row.commit.authorSequence),
					last: last.map((row) => row.commit.authorSequence),
					absent: absent.length,
				};
			} finally {
				Object.defineProperty(IDBObjectStore.prototype, "getAll", descriptor);
				Object.defineProperty(IDBObjectStore.prototype, "openCursor", cursorDescriptor);
				if (!released) await held.release();
				await foreignWork;
				foreign?.close();
			}
		});
	} finally {
		await deleteDatabase(derived);
	}
}

// Initial validation must visit the global closure without collecting whole-store arrays.
async function r8OutboxMaterialization(): Promise<unknown> {
	const primary = `phase-2l-b-r8-outbox-materialization-${crypto.randomUUID()}`;
	const derived = `${primary}${SUFFIX}`;
	const scopes = [{ objectId: "a", author: "foreign-before" }, SCOPE,
		{ objectId: "z", author: "foreign-after" }];
	try {
		return await withStore(primary, async (store) => {
			for (const scope of scopes) for (let i = 0; i < 64; i++)
				await store.transactIssue(scope, (sequence) => Promise.resolve(commit(scope, sequence)));
			const methods = ["getAll", "getAllKeys", "openCursor"] as const;
			const descriptors = methods.map(method => Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, method));
			const arrays: { method: string; store: string; rows: number; count: number | null }[] = [];
			const cursors: Record<string, number> = {};
			try {
				for (const [index, method] of methods.entries()) {
					const descriptor = descriptors[index];
					if (descriptor === undefined || typeof descriptor.value !== "function")
						throw new Error(`native ${method} missing`);
					Object.defineProperty(IDBObjectStore.prototype, method, {
						...descriptor,
						value: function (this: IDBObjectStore, ...args: unknown[]): IDBRequest<unknown> {
							const request = Reflect.apply(descriptor.value, this, args) as IDBRequest<unknown>;
							if (["lineages", "issuedRecords", "issuanceOutbox"].includes(this.name))
								request.addEventListener("success", () => {
									if (method === "openCursor") {
										if (request.result !== null) cursors[this.name] = (cursors[this.name] ?? 0) + 1;
									} else if (Array.isArray(request.result)) arrays.push({ method, store: this.name,
										rows: request.result.length, count: typeof args[1] === "number" ? args[1] : null });
								});
							return request;
						},
					});
				}
				const page = await store.readOutboxPage({ scope: SCOPE,
					afterKey: [SCOPE.objectId, SCOPE.author, 0], limit: 2 });
				return { arrays, cursorRows: cursors, page: page.map(row => ({
					sequence: row.commit.authorSequence, scope: row.commit.issuedRecord.scope,
					publishState: row.publishState })) };
			} finally {
				for (const [index, method] of methods.entries()) {
					const descriptor = descriptors[index];
					if (descriptor !== undefined) Object.defineProperty(IDBObjectStore.prototype, method, descriptor);
				}
			}
		});
	} finally {
		await deleteDatabase(derived);
	}
}

// Off-page poison must still refuse, including unused lineage tails.
async function r8OutboxStreamingControls(): Promise<unknown> {
	const failures: unknown[] = [];
	const mutations = ["orphan-issued", "orphan-outbox", "malformed-issued", "malformed-outbox",
		"digest", "missing-lineage", "unconsumed", "pruned", "unused-lineage"];
	for (const side of ["a", "z"]) for (const mutation of mutations) {
		const primary = `phase-2l-b-r8-stream-${crypto.randomUUID()}`;
		const derived = `${primary}${SUFFIX}`;
		const foreign = { objectId: side, author: "foreign" };
		try {
			await withStore(primary, async store => {
				await store.transactIssue(SCOPE, sequence => Promise.resolve(commit(SCOPE, sequence)));
				await store.transactIssue(foreign, sequence => Promise.resolve(commit(foreign, sequence)));
			});
			const raw = await openRaw(derived);
			try {
				const tx = raw.transaction(["lineages", "issuedRecords", "issuanceOutbox"], "readwrite", { durability: "strict" });
				const terminal = transactionComplete(tx);
				const key = [foreign.objectId, foreign.author, 0];
				const [issued, outbox, lineage] = await Promise.all([
					requestResult(tx.objectStore("issuedRecords").get(key)),
					requestResult(tx.objectStore("issuanceOutbox").get(key)),
					requestResult(tx.objectStore("lineages").get(key.slice(0, 2))),
				]);
				switch (mutation) {
					case "orphan-issued": tx.objectStore("issuanceOutbox").delete(key); break;
					case "orphan-outbox": tx.objectStore("issuedRecords").delete(key); break;
					case "malformed-issued": tx.objectStore("issuedRecords").put({ ...issued, unexpected: true }); break;
					case "malformed-outbox": tx.objectStore("issuanceOutbox").put({ ...outbox, publishState: "broken" }); break;
					case "digest": tx.objectStore("issuanceOutbox").put({ ...outbox, digest: Uint8Array.of(99) }); break;
					case "missing-lineage": tx.objectStore("lineages").delete(key.slice(0, 2)); break;
					case "unconsumed": tx.objectStore("lineages").put({ ...lineage, next: 0 }); break;
					case "pruned": tx.objectStore("lineages").put({ ...lineage, prunedThroughAuthorSequence: 0 }); break;
					case "unused-lineage": tx.objectStore("lineages").put({ objectId: `${side}:unused`, author: "foreign",
						next: -1, exhausted: false }); break;
				}
				await terminal;
			} finally { raw.close(); }
			await withStore(primary, async store => {
				const first: unknown = await store.readOutboxPage({ scope: SCOPE, limit: 1 }).catch(error => error);
				const second: unknown = await store.readOutboxPage({ scope: { objectId: "absent", author: "absent" }, limit: 1 }).catch(error => error);
				failures.push({ side, mutation, code: typeof first === "object" && first !== null ? Reflect.get(first, "code") : null,
					sticky: first === second });
			});
		} finally { await deleteDatabase(derived); }
	}
	const primary = `phase-2l-b-r8-stream-positive-${crypto.randomUUID()}`;
	const derived = `${primary}${SUFFIX}`;
	let positive: unknown;
	try {
		await withStore(primary, async store => {
			const empty = await store.readOutboxPage({ limit: 1 });
			const raw = await openRaw(derived);
			try {
				const tx = raw.transaction("lineages", "readwrite", { durability: "strict" });
				const terminal = transactionComplete(tx);
				tx.objectStore("lineages").put({ objectId: "unused", author: "unused", next: 0, exhausted: false });
				await terminal;
			} finally { raw.close(); }
			const lineageOnly = await store.readOutboxPage({ limit: 1 });
			const scopes = [{ objectId: "\uE000", author: "unicode" }, { objectId: "\u{10000}", author: "unicode" }, SCOPE];
			for (const scope of scopes) await store.transactIssue(scope, sequence => Promise.resolve(commit(scope, sequence)));
			const page = await store.readOutboxPage({ limit: 3 });
			const order = page.map(row => row.commit.issuedRecord.scope.objectId);
			const after = await store.readOutboxPage({ afterKey: [SCOPE.objectId, SCOPE.author, 0], limit: 3 });
			const absent = await store.readOutboxPage({ scope: { objectId: "absent", author: "absent" }, limit: 1 });
			const target = page[0];
			if (target === undefined) throw new Error("target page missing");
			target.commit.envelope.digest[0] = 99;
			target.commit.issuedRecord.envelope.signature[0] = 98;
			const detached = await store.readOutboxPage({ scope: SCOPE, limit: 1 });
			positive = { empty: empty.length, lineageOnly: lineageOnly.length, order,
				after: after.map(row => row.commit.issuedRecord.scope.objectId), absent: absent.length,
				digest: [...(detached[0]?.commit.envelope.digest ?? [])],
				signature: [...(detached[0]?.commit.issuedRecord.envelope.signature ?? [])] };
		});
	} finally { await deleteDatabase(derived); }
	return { failures, positive };
}

declare global {
	interface Window {
		phase2lBR8OutboxMaterialization(): Promise<unknown>;
		phase2lBR8OutboxStreamingControls(): Promise<unknown>;
	}
}
window.phase2lBR8OutboxMaterialization = r8OutboxMaterialization;
window.phase2lBR8OutboxStreamingControls = r8OutboxStreamingControls;

async function runFastCase(caseId: FastCase): Promise<unknown> {
	switch (caseId) {
		case "surface-options-identity":
			return surfaceOptionsIdentity();
		case "primary-opacity-schema-admission":
			return primaryOpacitySchemaAdmission();
		case "v1-upgrade-preserves-committed-rows":
			return v1UpgradePreservesCommittedRows();
		case "issue-read-copy-paging":
			return issueReadCopyPaging();
		case "held-outbox-page-work":
			return heldOutboxPageWork();
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

// New affected native-hook controls only. Old raw fake-envelope cases above
// remain unchanged and are not selected by this run.
const r8Hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const r8Seed = Uint8Array.from(originalAdmission.privateKeySeedHex.match(/../gu) ?? [], (v) => Number.parseInt(v, 16));
const r8PublicKey = ed25519.getPublicKey(r8Seed);
const r8Scope = { author: r8Hex(r8PublicKey), objectId: originalAdmission.vertex.objectId };
const r8Package = encodeCanonical(originalAdmission.package);
const r8Prepared = prepareBlueprintAdmission({
	canonicalBlueprintPackageBytes: r8Package,
	expectedBlueprintDigest: r8Hex(hashDomain("ts-drp/blueprint-admission/v3", r8Package)),
});
const r8Input = { ...originalAdmission.vertex, epoch: 1, operation: originalAdmission.validOperation };
function r8Check(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error("R8_NATIVE_ORACLE:" + message);
}
function r8Error(error: unknown): { code: unknown; message: string; cause?: string } {
	return {
		code: typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined,
		message: error instanceof Error ? error.message : String(error),
		...(error instanceof Error && error.cause !== undefined ? { cause: String(error.cause) } : {}),
	};
}
function r8Issuer(
	store: DurableIssuanceStore,
	sign: (digest: Uint8Array) => Promise<Uint8Array>,
	barrier?: () => Promise<void>
): ReturnType<typeof createAdmissionBoundTransactionalVertexIssuer> {
	return createAdmissionBoundTransactionalVertexIssuer({
		author: r8Scope.author,
		preparedBlueprintAdmission: r8Prepared,
		publicKey: { bytes: r8PublicKey, format: "raw" },
		signRegisteredVertexDigest: sign,
		transactIssue: (scope, build) =>
			store.transactIssue(scope, async (sequence, nativeAdmission) => {
				r8Check(typeof nativeAdmission === "function", "original supplied native hook required");
				const candidate = await build(sequence, nativeAdmission);
				r8Check(
					ed25519.verify(candidate.envelope.signature, candidate.envelope.digest, r8PublicKey),
					"genuine original signature"
				);
				await barrier?.();
				return candidate;
			}),
	});
}
async function r8Image(primary: string): Promise<string> {
	const db = await openRaw(primary + SUFFIX);
	try {
		const names = [...db.objectStoreNames];
		const tx = db.transaction(names, "readonly");
		const terminal = transactionComplete(tx);
		const tables = await Promise.all(
			names.map(async (name) => ({
				name,
				keys: await requestResult(tx.objectStore(name).getAllKeys()),
				rows: await requestResult(tx.objectStore(name).getAll()),
			}))
		);
		await terminal;
		return r8Hex(encodeCanonical(tables));
	} finally {
		db.close();
	}
}
async function r8UnknownIdentity(): Promise<unknown> {
	const primary = "phase-2l-b-r8-unknown-" + crypto.randomUUID();
	const first = await createOriginalStore({ primaryDatabaseName: primary });
	let cold: DurableIssuanceStore | undefined;
	let firstDigest: string | undefined;
	let initial: unknown;
	let conflicting: unknown;
	let conflictEntries = 0;
	let retryEntries = 0;
	const cleanup: string[] = [];
	try {
		try {
			await r8Issuer(first, async (digest) => {
				const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
				r8Check(ed25519.verify(signature, digest, r8PublicKey), "first real crypto verifies");
				firstDigest = r8Hex(digest);
				throw new Error("R8_TEST_ENTERED_CRYPTO_DELIVERY_LOST");
			}).issue(r8Input);
		} catch (error) {
			initial = r8Error(error);
		}
		await first.close();
		cleanup.push("initial:fulfilled");
		r8Check(firstDigest !== undefined, "entered original signer reached");
		cold = await createOriginalStore({ primaryDatabaseName: primary });
		const before = await r8Image(primary);
		try {
			await r8Issuer(cold, async (digest) => {
				conflictEntries++;
				const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
				return signature;
			}).issue({ ...r8Input, operation: { ...originalAdmission.validOperation, value: "conflicting-after-unknown" } });
			conflicting = { code: "RESOLVED" };
		} catch (error) {
			conflicting = r8Error(error);
		}
		const after = await r8Image(primary);
		r8Check(conflictEntries === 0, "conflicting ordinal must refuse BEFORE genuine crypto");
		r8Check(before === after, "conflicting refusal has zero whole-native effects");
		const commit = await r8Issuer(cold, async (digest) => {
			retryEntries++;
			r8Check(r8Hex(digest) === firstDigest, "SAME exact unsigned identity retry");
			const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
			return signature;
		}).issue(r8Input);
		const lineage = await cold.readLineage(r8Scope);
		const outbox = await cold.readOutboxPage({ scope: r8Scope });
		const stored = await cold.readIssued(r8Scope, 0);
		r8Check(
			retryEntries === 1 && commit.authorSequence === 0 && lineage.next === 1 && outbox.length === 1 && stored !== null,
			"same intent once NEW pairs and original next/readback"
		);
		return {
			initial,
			firstDigest,
			conflicting,
			conflictEntries,
			retryEntries,
			wholeNativeUnchanged: before === after,
			sameIntent: {
				sequence: commit.authorSequence,
				next: lineage.next,
				outboxCount: outbox.length,
				digestMatches: r8Hex(commit.envelope.digest) === firstDigest,
			},
			cleanup,
		};
	} finally {
		await first.close();
		if (cold) {
			await cold.close();
			cleanup.push("cold:fulfilled");
		}
		await deleteDatabase(primary + SUFFIX);
		cleanup.push("database:deleted");
	}
}
async function r8NativeJobClose(): Promise<unknown> {
	const primary = "phase-2l-b-r8-job-" + crypto.randomUUID();
	const store = await createOriginalStore({ primaryDatabaseName: primary });
	const foreign = await createOriginalStore({ primaryDatabaseName: primary });
	let enter: () => void = () => undefined,
		release: () => void = () => undefined;
	const entered = new Promise<void>((r) => {
		enter = r;
	});
	const barrier = new Promise<void>((r) => {
		release = r;
	});
	let entries = 0,
		closeDelivered = false,
		foreignDelivered = false;
	let issue: Promise<unknown> | undefined,
		closing: Promise<void> | undefined,
		foreignRead: Promise<unknown> | undefined;
	const phases: string[] = [];
	const cleanup: string[] = [];
	try {
		issue = r8Issuer(
			store,
			async (digest) => {
				entries++;
				const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
				return signature;
			},
			async () => {
				phases.push("verified-signature/builder-entered");
				enter();
				await barrier;
				phases.push("builder-joined");
			}
		)
			.issue(r8Input)
			.then(
				(c) => ({ ok: true, sequence: c.authorSequence }),
				(e) => ({ ok: false, ...r8Error(e) })
			);
		await entered;
		foreignRead = foreign.readLineage(r8Scope).then((value) => {
			foreignDelivered = true;
			phases.push("foreign-read-delivered");
			return value;
		});
		closing = store.close().then(() => {
			closeDelivered = true;
			phases.push("close-delivered");
		});
		phases.push("close-invoked");
		const revoked = await rejection(store.readLineage(r8Scope));
		await new Promise<void>((r) => setTimeout(r, 20));
		r8Check(revoked.code === "ISSUANCE_STORE_CLOSED", "close immediately revokes new original admission");
		r8Check(!closeDelivered && !foreignDelivered, "original native writer/close retained through post-sign builder");
		const beforeJoin = { closeDelivered, foreignDelivered };
		release();
		const result = await issue;
		await closing;
		const foreignLineage = await foreignRead;
		r8Check(phases.indexOf("close-delivered") > phases.indexOf("builder-joined"), "joined close ordering");
		return { entries, beforeJoin, revoked, result, foreignLineage, phases, cleanup };
	} finally {
		release();
		await Promise.allSettled([issue, closing, foreignRead]);
		const joined = await Promise.allSettled([store.close(), foreign.close()]);
		cleanup.push(...joined.map((r) => r.status));
		r8Check(
			joined.every((r) => r.status === "fulfilled"),
			"all original owner cleanup joined"
		);
		await deleteDatabase(primary + SUFFIX);
		cleanup.push("database:deleted");
	}
}
declare global {
	interface Window {
		phase2lBR8Native(caseId: "unknown" | "job"): Promise<unknown>;
	}
}
window.phase2lBR8Native = async (caseId): Promise<unknown> => {
	try {
		return { ok: true, value: await (caseId === "unknown" ? r8UnknownIdentity() : r8NativeJobClose()) };
	} catch (error) {
		return { ok: false, failure: r8Error(error) };
	}
};

// This distinct control exercises actual native abort while the original signer
// is suspended. It is not a simulated quota or total-work measurement.
async function r8EnteredSignerNativeAbort(): Promise<unknown> {
	const primary = "phase-2l-b-r8-abort-" + crypto.randomUUID();
	const store = await createOriginalStore({ primaryDatabaseName: primary });
	let cold: DurableIssuanceStore | undefined;
	let enter!: () => void;
	let release!: () => void;
	let pulse!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pulsed = new Promise<void>((resolve) => {
		pulse = resolve;
	});
	const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "getKey");
	r8Check(descriptor !== undefined && typeof descriptor.value === "function", "original native getKey required");
	let writer: IDBTransaction | undefined;
	let nativeAbortJoined: Promise<void> | undefined;
	let pulseCount = 0;
	let closeDelivered = false;
	let digestHex: string | undefined;
	let issue: Promise<unknown> | undefined;
	let closing: Promise<void> | undefined;
	let conflictEntries = 0;
	let retryEntries = 0;
	const phases: string[] = [];
	const cleanup: string[] = [];
	Object.defineProperty(IDBObjectStore.prototype, "getKey", {
		...descriptor,
		value: function (this: IDBObjectStore, ...args: unknown[]): IDBRequest<IDBValidKey | undefined> {
			const request = Reflect.apply(descriptor.value, this, args) as IDBRequest<IDBValidKey | undefined>;
			if (
				this.name === "lineages" &&
				args[0] === "" &&
				this.transaction.mode === "readwrite" &&
				this.transaction.db.name === primary + SUFFIX
			) {
				if (writer === undefined) {
					writer = this.transaction;
					nativeAbortJoined = new Promise<void>((resolve) => {
						this.transaction.addEventListener(
							"abort",
							() => {
								phases.push("actual-native-abort");
								resolve();
							},
							{ once: true }
						);
					});
				}
				request.addEventListener(
					"success",
					() => {
						pulseCount++;
						pulse();
					},
					{ once: true }
				);
			}
			return request;
		},
	});
	try {
		issue = r8Issuer(store, async (digest) => {
			const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
			r8Check(ed25519.verify(signature, digest, r8PublicKey), "actual entered crypto verifies");
			digestHex = r8Hex(digest);
			phases.push("verified-signer-entered");
			enter();
			await barrier;
			phases.push("signer-joined");
			return signature;
		})
			.issue(r8Input)
			.then(
				(commit) => ({ ok: true, sequence: commit.authorSequence }),
				(error: unknown) => ({ ok: false, ...r8Error(error) })
			);
		await entered;
		await pulsed;
		r8Check(
			writer !== undefined && nativeAbortJoined !== undefined && pulseCount > 0,
			"actual owned writer pulse reached"
		);
		writer.abort();
		await nativeAbortJoined;
		Object.defineProperty(IDBObjectStore.prototype, "getKey", descriptor);
		closing = store.close().then(() => {
			closeDelivered = true;
			phases.push("close-delivered");
		});
		phases.push("close-invoked");
		const revoked = await rejection(store.readLineage(r8Scope));
		const raw = await openRaw(primary + SUFFIX);
		let debt: unknown;
		try {
			const tx = raw.transaction(["lineages", "issuedRecords", "issuanceOutbox"], "readonly");
			const terminal = transactionComplete(tx);
			const row: unknown = await requestResult(tx.objectStore("lineages").get([r8Scope.objectId, r8Scope.author]));
			r8Check(typeof row === "object" && row !== null, "durable original lineage remains");
			const pending: unknown = Reflect.get(row, "pendingUnsigned");
			r8Check(typeof pending === "object" && pending !== null, "durable original entered intent remains");
			const digest: unknown = Reflect.get(pending, "digest");
			r8Check(digest instanceof Uint8Array, "exact durable pending digest");
			debt = {
				phase: Reflect.get(pending, "phase"),
				sequence: Reflect.get(pending, "authorSequence"),
				next: Reflect.get(row, "next"),
				digestMatches: r8Hex(digest) === digestHex,
				issued: await requestResult(tx.objectStore("issuedRecords").count()),
				outbox: await requestResult(tx.objectStore("issuanceOutbox").count()),
			};
			await terminal;
		} finally {
			raw.close();
		}
		const afterAbort = await r8Image(primary);
		r8Check(revoked.code === "ISSUANCE_STORE_CLOSED", "native abort does not weaken close revocation");
		r8Check(!closeDelivered, "close must still join the actually entered suspended signer");
		const beforeJoin = { closeDelivered };
		release();
		const result = await issue;
		await closing;
		r8Check(
			phases.indexOf("close-delivered") > phases.indexOf("signer-joined"),
			"native abort does not deliver close before signer join"
		);
		cold = await createOriginalStore({ primaryDatabaseName: primary });
		const beforeConflict = await r8Image(primary);
		r8Check(beforeConflict === afterAbort, "joined close/reopen changes no whole native abort postimage");
		let conflicting: unknown;
		try {
			await r8Issuer(cold, async (digest) => {
				conflictEntries++;
				const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
				return signature;
			}).issue({
				...r8Input,
				operation: { ...originalAdmission.validOperation, value: "conflicting-after-native-abort" },
			});
			conflicting = { code: "RESOLVED" };
		} catch (error) {
			conflicting = r8Error(error);
		}
		const afterConflict = await r8Image(primary);
		r8Check(
			conflictEntries === 0 && beforeConflict === afterConflict,
			"interrupted writer retains exact identity before fresh crypto/effects"
		);
		const commit = await r8Issuer(cold, async (digest) => {
			retryEntries++;
			r8Check(r8Hex(digest) === digestHex, "original exact intent resumes after interrupted writer");
			const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
			return signature;
		}).issue(r8Input);
		const lineage = await cold.readLineage(r8Scope);
		const outbox = await cold.readOutboxPage({ scope: r8Scope });
		return {
			pulseCount,
			beforeJoin,
			revoked,
			result,
			debt,
			phases,
			conflicting,
			conflictEntries,
			wholeNativeUnchanged: beforeConflict === afterConflict,
			retryEntries,
			sameIntent: {
				sequence: commit.authorSequence,
				next: lineage.next,
				outboxCount: outbox.length,
				digestMatches: r8Hex(commit.envelope.digest) === digestHex,
			},
			cleanup,
		};
	} finally {
		Object.defineProperty(IDBObjectStore.prototype, "getKey", descriptor);
		release();
		await Promise.allSettled([issue, closing]);
		const joined = await Promise.allSettled([store.close(), cold?.close()]);
		cleanup.push(...joined.map((result) => result.status));
		r8Check(
			joined.every((result) => result.status === "fulfilled"),
			"all interrupted native owners joined"
		);
		await deleteDatabase(primary + SUFFIX);
		cleanup.push("database:deleted");
	}
}
declare global {
	interface Window {
		phase2lBR8NativeAbort(): Promise<unknown>;
	}
}
window.phase2lBR8NativeAbort = async (): Promise<unknown> => {
	try {
		return { ok: true, value: await r8EnteredSignerNativeAbort() };
	} catch (error) {
		return { ok: false, failure: r8Error(error) };
	}
};

type R8CurrencyCase =
	| "control-stale"
	| "rows-stale"
	| "matching-null"
	| "malformed-pair"
	| "inherited-entered-stale"
	| "reserved-ack-interposition";

async function r8CurrencyCapture(store: DurableIssuanceStore): Promise<DurableIssueSignContext> {
	const maintenance = durableIssuancePruningMaintenanceForStore(store);
	r8Check(maintenance?.readBoundedRecoveryCensus !== undefined, "original complete native census required");
	const census = await maintenance.readBoundedRecoveryCensus({
		objectId: r8Scope.objectId,
		limits: ISSUANCE_RETIREMENT_LIMITS,
	});
	r8Check(census.control !== undefined, "actual noncreating native control required");
	return {
		expectedIssuanceImageDigest: census.image.imageDigest,
		expectedIssuanceControlBytes: census.control === null ? null : encodeIssuanceRetirementControl(census.control),
	};
}
function r8CurrencyIssuer(
	store: DurableIssuanceStore,
	context: DurableIssueSignContext,
	sign: (digest: Uint8Array) => Promise<Uint8Array>
): ReturnType<typeof createAdmissionBoundTransactionalVertexIssuer> {
	return createAdmissionBoundTransactionalVertexIssuer({
		author: r8Scope.author,
		preparedBlueprintAdmission: r8Prepared,
		publicKey: { bytes: r8PublicKey, format: "raw" },
		signRegisteredVertexDigest: sign,
		transactIssue: (scope, build) =>
			store.transactIssue(scope, (sequence, nativeAdmission) => {
				r8Check(nativeAdmission !== undefined, "original lexical native job required");
				return build(sequence, (bytes, signer) => nativeAdmission(bytes, signer, context));
			}),
	});
}
async function r8PairedNativeCurrency(caseId: R8CurrencyCase): Promise<unknown> {
	const primary = "phase-2l-b-r8-currency-" + crypto.randomUUID();
	const first = await createOriginalStore({ primaryDatabaseName: primary });
	let cold: DurableIssuanceStore | undefined;
	let foreign: DurableIssuanceStore | undefined;
	let store: DurableIssuanceStore = first;
	let entries = 0;
	const signed = async (digest: Uint8Array): Promise<Uint8Array> => {
		entries++;
		const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
		r8Check(ed25519.verify(signature, digest, r8PublicKey), "original registered signature verifies");
		return signature;
	};
	const cleanup: string[] = [];
	try {
		const initial = await r8CurrencyCapture(first);
		r8Check(initial.expectedIssuanceControlBytes === null, "initial original native control absent");
		if (caseId === "reserved-ack-interposition") {
			const priorCommit = await r8Issuer(store, signed).issue(r8Input);
			const selected = await r8CurrencyCapture(store);
			const before = await r8Image(primary);
			foreign = await createOriginalStore({ primaryDatabaseName: primary });
			const ackOwner = foreign;
			const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
			r8Check(descriptor?.value !== undefined, "original native put descriptor required");
			const originalPut = IDBObjectStore.prototype.put;
			const phases: string[] = [];
			let acknowledgement: Promise<void> | undefined;
			let selectedRequest = false;
			let refused: unknown;
			const entriesBefore = entries;
			Object.defineProperty(IDBObjectStore.prototype, "put", {
				...descriptor,
				value(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
					const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
					const row = value as {
						objectId?: unknown;
						author?: unknown;
						pendingUnsigned?: { phase?: unknown; authorSequence?: unknown };
					};
					if (
						!selectedRequest &&
						this.name === "lineages" &&
						this.transaction.db.name === primary + SUFFIX &&
						row.objectId === r8Scope.objectId &&
						row.author === r8Scope.author &&
						row.pendingUnsigned?.phase === "reserved" &&
						row.pendingUnsigned.authorSequence === 1
					) {
						selectedRequest = true;
						request.addEventListener(
							"success",
							() => {
								phases.push("reserved-put-success", "original-foreign-ack-invoked");
								acknowledgement = ackOwner.compareAndMarkOutboxPublished({
									scope: r8Scope,
									authorSequence: priorCommit.authorSequence,
									digest: priorCommit.envelope.digest,
								});
								void acknowledgement.catch(() => undefined);
							},
							{ once: true }
						);
					}
					return request;
				},
			});
			try {
				await r8CurrencyIssuer(store, selected, signed).issue(r8Input);
				refused = { code: "RESOLVED" };
			} catch (error) {
				refused = r8Error(error);
				phases.push("reserved-currency-refused");
			} finally {
				Object.defineProperty(IDBObjectStore.prototype, "put", descriptor);
			}
			r8Check(acknowledgement !== undefined, "actual original foreign ACK selected before marker");
			await acknowledgement;
			phases.push("original-foreign-ack-joined");
			const debt = await store.readLineage(r8Scope);
			const priorOutbox = await store.readOutboxPage({ scope: r8Scope });
			const after = await r8Image(primary);
			type NativeTable = { name: string; keys: readonly unknown[]; rows: readonly Record<string, unknown>[] };
			const tables = (image: string): readonly NativeTable[] =>
				decodeCanonical(
					Uint8Array.from(image.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16))
				) as readonly NativeTable[];
			const actualTables = tables(after);
			const pending = actualTables.find((table) => table.name === "lineages")?.rows[0]?.pendingUnsigned as
				| { phase: string; authorSequence: number }
				| undefined;
			r8Check(
				pending?.phase === "reserved" && pending.authorSequence === 1,
				"actual reserved native identity observed"
			);
			const expectedTables = tables(before).map((table) => ({
				...table,
				rows: table.rows.map((row) => {
					if (table.name === "lineages") {
						const actual = actualTables.find((value) => value.name === table.name)?.rows[0];
						r8Check(
							actual?.pendingUnsigned !== undefined,
							"exact original reserved intent remains in this implementation"
						);
						return { ...row, pendingUnsigned: actual.pendingUnsigned };
					}
					if (table.name === "issuanceOutbox") return { ...row, publishState: "published" };
					if (table.name === "retirementControls") {
						const control = decodeIssuanceRetirementControl(row.record);
						return { ...row, record: encodeIssuanceRetirementControl({ ...control, revision: control.revision + 2 }) };
					}
					return row;
				}),
			}));
			const expected = r8Hex(encodeCanonical(expectedTables));
			const exactDefinedNativeDeltas = expected === after;
			r8Check(
				exactDefinedNativeDeltas,
				"only original reserved intent and genuine foreign ACK alter complete native image"
			);
			r8Check(entries === entriesBefore, "post-reserved currency refusal precedes new crypto");
			const refusalCryptoEntries = entries - entriesBefore;
			const exactCurrent = await r8CurrencyCapture(store);
			const commit = await r8CurrencyIssuer(store, exactCurrent, signed).issue(r8Input);
			const lineage = await store.readLineage(r8Scope);
			const outbox = await store.readOutboxPage({ scope: r8Scope });
			return {
				caseId,
				phases,
				refused,
				refusalCryptoEntries,
				exactDefinedNativeDeltas,
				nativeImages: { before, expected, actual: after },
				debt: { next: debt.next, phase: pending.phase, sequence: pending.authorSequence },
				priorOutbox: priorOutbox.map((row) => ({ sequence: row.commit.authorSequence, state: row.publishState })),
				continuation: {
					addedCrypto: entries - entriesBefore,
					sequence: commit.authorSequence,
					next: lineage.next,
					outboxCount: outbox.length,
				},
				cleanup,
			};
		}
		if (caseId === "matching-null") {
			const firstCommit = await r8CurrencyIssuer(store, initial, signed).issue(r8Input);
			const current = await r8CurrencyCapture(store);
			r8Check(current.expectedIssuanceControlBytes instanceof Uint8Array, "actual control born by original job");
			const nextCommit = await r8CurrencyIssuer(store, current, signed).issue(r8Input);
			const lineage = await store.readLineage(r8Scope);
			const outbox = await store.readOutboxPage({ scope: r8Scope });
			return {
				caseId,
				entries,
				sequences: [firstCommit.authorSequence, nextCommit.authorSequence],
				next: lineage.next,
				outboxCount: outbox.length,
				cleanup,
			};
		}
		let selected = initial;
		let prerequisite: unknown;
		if (caseId === "control-stale") {
			const maintenance = durableIssuancePruningMaintenanceForStore(store);
			r8Check(maintenance?.acquireRetirementControl !== undefined, "original native control owner required");
			const control = await maintenance.acquireRetirementControl({ objectId: r8Scope.objectId });
			await control.release();
			const current = await r8CurrencyCapture(store);
			r8Check(
				current.expectedIssuanceImageDigest === initial.expectedIssuanceImageDigest &&
					current.expectedIssuanceControlBytes instanceof Uint8Array,
				"only original actual control changed"
			);
			prerequisite = { rowsUnchanged: true, priorControl: null, actualControlPresent: true };
		} else if (caseId === "rows-stale") {
			await r8Issuer(store, signed).issue(r8Input);
			const current = await r8CurrencyCapture(store);
			r8Check(
				current.expectedIssuanceImageDigest !== initial.expectedIssuanceImageDigest,
				"genuine paired write changes original rows"
			);
			selected = { ...initial, expectedIssuanceControlBytes: current.expectedIssuanceControlBytes };
			prerequisite = { staleRows: true, exactCurrentControl: true };
		} else if (caseId === "malformed-pair") {
			selected = { expectedIssuanceImageDigest: initial.expectedIssuanceImageDigest };
		} else {
			let firstError: unknown;
			try {
				await r8CurrencyIssuer(store, initial, async (digest) => {
					const signature = await signed(digest);
					r8Check(ed25519.verify(signature, digest, r8PublicKey), "first uncertain signature real");
					throw new Error("R8_CURRENCY_ENTERED_DELIVERY_LOST");
				}).issue(r8Input);
			} catch (error) {
				firstError = r8Error(error);
			}
			await first.close();
			cold = await createOriginalStore({ primaryDatabaseName: primary });
			store = cold;
			prerequisite = firstError;
		}
		const before = await r8Image(primary);
		const entriesBefore = entries;
		let refused: unknown;
		try {
			await r8CurrencyIssuer(store, selected, signed).issue(r8Input);
			refused = { code: "RESOLVED" };
		} catch (error) {
			refused = r8Error(error);
		}
		const after = await r8Image(primary);
		r8Check(
			entries === entriesBefore && before === after,
			"currency/pair refusal has zero crypto and whole native effects"
		);
		const refusalCryptoEntries = entries - entriesBefore;
		let continuation: unknown;
		if (caseId !== "malformed-pair") {
			const exactCurrent = await r8CurrencyCapture(store);
			const commit = await r8CurrencyIssuer(store, exactCurrent, signed).issue(r8Input);
			const lineage = await store.readLineage(r8Scope);
			const outbox = await store.readOutboxPage({ scope: r8Scope });
			continuation = {
				addedCrypto: entries - entriesBefore,
				sequence: commit.authorSequence,
				next: lineage.next,
				outboxCount: outbox.length,
			};
		}
		return {
			caseId,
			prerequisite,
			refused,
			refusalCryptoEntries,
			wholeNativeUnchanged: before === after,
			continuation,
			cleanup,
		};
	} finally {
		const joined = await Promise.allSettled([
			first.close(),
			cold?.close(),
			...(foreign === undefined ? [] : [foreign.close()]),
		]);
		cleanup.push(...joined.map((result) => result.status));
		r8Check(
			joined.every((result) => result.status === "fulfilled"),
			"original currency owners joined"
		);
		await deleteDatabase(primary + SUFFIX);
		cleanup.push("database:deleted");
	}
}
declare global {
	interface Window {
		phase2lBR8NativeCurrency(caseId: R8CurrencyCase): Promise<unknown>;
	}
}
window.phase2lBR8NativeCurrency = async (caseId): Promise<unknown> => {
	try {
		return { ok: true, value: await r8PairedNativeCurrency(caseId) };
	} catch (error) {
		return { ok: false, failure: r8Error(error) };
	}
};

async function r8ForeignSameIntentCompletion(): Promise<unknown> {
	const primary = "phase-2l-b-r8-foreign-completion-" + crypto.randomUUID();
	const selected = await createOriginalStore({ primaryDatabaseName: primary });
	const foreign = await createOriginalStore({ primaryDatabaseName: primary });
	const putDescriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
	r8Check(putDescriptor?.value !== undefined, "original native put descriptor required");
	const ownListenerDescriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "addEventListener");
	const originalListener = EventTarget.prototype.addEventListener;
	r8Check(
		IDBTransaction.prototype.addEventListener === originalListener,
		"original inherited native event listener required"
	);
	const originalPut = IDBObjectStore.prototype.put;
	let reserved: IDBTransaction | undefined;
	const deliveries: Array<() => void> = [];
	let delivered = false;
	let signal!: () => void;
	const reached = new Promise<void>((resolve) => {
		signal = resolve;
	});
	let selectedCrypto = 0;
	let foreignCrypto = 0;
	let issue: Promise<unknown> | undefined;
	const phases: string[] = [];
	const cleanup: string[] = [];
	Object.defineProperty(IDBTransaction.prototype, "addEventListener", {
		configurable: true,
		writable: true,
		value(
			this: IDBTransaction,
			type: string,
			listener: EventListenerOrEventListenerObject | null,
			options?: boolean | AddEventListenerOptions
		): void {
			if (type !== "complete" || listener === null) {
				originalListener.call(this, type, listener, options);
				return;
			}
			originalListener.call(
				this,
				type,
				function (this: IDBTransaction, event: Event): void {
					const invoke = (): void => {
						if (typeof listener === "function") listener.call(this, event);
						else listener.handleEvent(event);
					};
					if (this === reserved && !delivered) {
						// Only terminal delivery is gated: the original strict RW has
						// really completed. The foreign retry uses original public APIs.
						deliveries.push(invoke);
						if (deliveries.length === 1) {
							phases.push("reserved-native-complete-delivery-held");
							signal();
						}
					} else invoke();
				},
				options
			);
		},
	});
	Object.defineProperty(IDBObjectStore.prototype, "put", {
		...putDescriptor,
		value(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
			const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
			const row = value as {
				objectId?: unknown;
				author?: unknown;
				pendingUnsigned?: { phase?: unknown; authorSequence?: unknown };
			};
			if (
				reserved === undefined &&
				this.name === "lineages" &&
				this.transaction.db.name === primary + SUFFIX &&
				row.objectId === r8Scope.objectId &&
				row.author === r8Scope.author &&
				row.pendingUnsigned?.phase === "reserved" &&
				row.pendingUnsigned.authorSequence === 0
			)
				reserved = this.transaction;
			return request;
		},
	});
	try {
		const quote = await r8CurrencyCapture(selected);
		issue = r8CurrencyIssuer(selected, quote, async (digest) => {
			selectedCrypto++;
			const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
			return signature;
		})
			.issue(r8Input)
			.then(
				() => ({ code: "RESOLVED" }),
				(error: unknown) => r8Error(error)
			);
		await reached;
		const reservedImage = await r8CurrencyCapture(foreign);
		r8Check(
			reservedImage.expectedIssuanceImageDigest !== quote.expectedIssuanceImageDigest &&
				reservedImage.expectedIssuanceControlBytes instanceof Uint8Array,
			"fresh actual reserved postimage observed"
		);
		// The foreign attempt uses the original lexical job's supported absent
		// optional-quote context. Its exact pending identity is still mandatory.
		const commit = await r8Issuer(foreign, async (digest) => {
			foreignCrypto++;
			const signature = await Promise.resolve(ed25519.sign(digest, r8Seed));
			r8Check(ed25519.verify(signature, digest, r8PublicKey), "foreign SAME-intent registered signature verifies");
			return signature;
		}).issue(r8Input);
		r8Check(commit.authorSequence === 0 && foreignCrypto === 1, "foreign SAME-intent genuine once NEW");
		phases.push("foreign-same-intent-new-joined");
		const before = await r8Image(primary);
		r8Check(deliveries.length === 2, "original lifecycle and terminal complete callbacks both held");
		delivered = true;
		for (const resume of deliveries.splice(0)) resume();
		phases.push("reserved-completion-delivered");
		const refusal = await issue;
		const after = await r8Image(primary);
		phases.push("selected-refusal-joined");
		const lineage = await foreign.readLineage(r8Scope);
		const outbox = await foreign.readOutboxPage({ scope: r8Scope });
		const issued = await foreign.readIssued(r8Scope, 0);
		r8Check(
			issued !== null && ed25519.verify(issued.envelope.signature, issued.envelope.digest, r8PublicKey),
			"retained NEW exact signature verifies"
		);
		r8Check(
			selectedCrypto === 0 && before === after,
			"consumed ordinal refusal has no selected crypto or whole native effects"
		);
		return {
			refusal,
			selectedCrypto,
			foreignCrypto,
			phases,
			wholeNativeUnchanged: before === after,
			nativeImages: { before, actual: after },
			foreignNew: {
				sequence: commit.authorSequence,
				next: lineage.next,
				outboxCount: outbox.length,
				digestMatches: r8Hex(issued.envelope.digest) === r8Hex(commit.envelope.digest),
			},
			cleanup,
		};
	} finally {
		Object.defineProperty(IDBObjectStore.prototype, "put", putDescriptor);
		if (ownListenerDescriptor === undefined) Reflect.deleteProperty(IDBTransaction.prototype, "addEventListener");
		else Object.defineProperty(IDBTransaction.prototype, "addEventListener", ownListenerDescriptor);
		delivered = true;
		for (const resume of deliveries.splice(0)) resume();
		await issue;
		const joined = await Promise.allSettled([selected.close(), foreign.close()]);
		cleanup.push(...joined.map((result) => result.status));
		r8Check(
			joined.every((result) => result.status === "fulfilled"),
			"both same-intent native owners joined"
		);
		await deleteDatabase(primary + SUFFIX);
		cleanup.push("database:deleted");
	}
}
declare global {
	interface Window {
		phase2lBR8ForeignCompletion(): Promise<unknown>;
	}
}
window.phase2lBR8ForeignCompletion = async (): Promise<unknown> => {
	try {
		return { ok: true, value: await r8ForeignSameIntentCompletion() };
	} catch (error) {
		return { ok: false, failure: r8Error(error) };
	}
};

// Changed boundary only: one real reserved transaction owns these mechanical
// facts. All signatures and plans originate in the existing issuer/store APIs.
type R8HeldRead = { check(): Promise<void>; release(): Promise<void> };
async function r8AcquireHeldRead(store: DurableIssuanceStore, objectId: string): Promise<R8HeldRead> {
	const acquire: unknown = Reflect.get(store, "acquireNativeReadReservation");
	r8Check(typeof acquire === "function", "original native read reservation port required");
	return Reflect.apply(acquire, store, [{ objectId }]) as Promise<R8HeldRead>;
}
async function r8HeldCensusFacts(probeOnly = false): Promise<unknown> {
	const primary = "phase-2l-b-r8-held-census-" + crypto.randomUUID(), derived = primary + SUFFIX;
	const otherScope = { ...r8Scope, objectId: r8Scope.objectId + ":other" };
	let stage = "genuine-issue", store = await createOriginalStore({ primaryDatabaseName: primary });
	let held: R8HeldRead | undefined, foreign: IDBDatabase | undefined, foreignWork: Promise<void> | undefined;
	let cryptoEntries = 0;
	const signed = async (digest: Uint8Array): Promise<Uint8Array> => { cryptoEntries++; return ed25519.sign(digest, r8Seed); };
	const observations: Record<string, unknown> = {}, cleanup: string[] = [];
	const descriptors = new Map<string, PropertyDescriptor>();
	const transactionIds = new WeakMap<IDBTransaction, number>();
	const completedTransactions = new Set<number>(), abortedTransactions = new Set<number>();
	const nativeTerminals = new Map<number, Promise<void>>();
	let nextTransactionId = 0, actualHeldTransaction: IDBTransaction | undefined;
	let calls: Record<string, number> = {}, cursorRows: Record<string, number> = {}, seenTransactions = new Set<number>(), getKeyRequests = 0;
	const take = () => {
		const transactions = [...seenTransactions].sort((a, b) => a - b);
		const value = { calls, cursorRows, transactions, ...(probeOnly ? { getKeyRequests } : {}), completedTransactions: transactions.filter(id => completedTransactions.has(id)),
			abortedTransactions: transactions.filter(id => abortedTransactions.has(id)) };
		calls = {}; cursorRows = {}; seenTransactions = new Set(); getKeyRequests = 0; return value;
	};
	let resumeRead: (() => void) | undefined, primaryFailure: unknown;
	const ownListenerDescriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "addEventListener");
	const originalListener = IDBRequest.prototype.addEventListener;
	try {
		const issuer = r8Issuer(store, signed), commits: Awaited<ReturnType<typeof issuer.issue>>[] = [];
		for (let ordinal = 0; ordinal < 3; ordinal++) commits.push(await issuer.issue(r8Input));
		await issuer.issue({ ...r8Input, objectId: otherScope.objectId });
		const firstCommit = commits[0]!;
		await store.transactWriteSettlementPlan({ scope: r8Scope, expectedRevision: null, plan: {
			scope: r8Scope, revision: 0, fenceSequence: null, entries: [{ sourceSequence: firstCommit.authorSequence,
				sourceDigest: firstCommit.envelope.digest, disposition: "manual-review", replacementSequence: null }],
		} });
		const before = await r8Image(primary);
		for (const method of ["get", "getKey", "count", "openCursor", "getAll", "getAllKeys"]) {
			const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, method);
			r8Check(descriptor !== undefined && typeof descriptor.value === "function", "original native request method " + method);
			descriptors.set(method, descriptor);
			Object.defineProperty(IDBObjectStore.prototype, method, { ...descriptor,
				value: function (this: IDBObjectStore, ...args: unknown[]): IDBRequest<unknown> {
					const request = Reflect.apply(descriptor.value, this, args) as IDBRequest<unknown>;
					if (this.transaction.db.name === derived) {
						if (actualHeldTransaction === undefined && this.transaction.mode === "readonly") actualHeldTransaction = this.transaction;
						let id = transactionIds.get(this.transaction);
						if (id === undefined) {
							id = ++nextTransactionId; transactionIds.set(this.transaction, id);
							const observedId = id;
							nativeTerminals.set(observedId, new Promise<void>(resolve => {
								this.transaction.addEventListener("complete", () => { completedTransactions.add(observedId); resolve(); }, { once: true });
								this.transaction.addEventListener("abort", () => { abortedTransactions.add(observedId); resolve(); }, { once: true });
							}));
						}
						seenTransactions.add(id);
						if (method === "getKey" && probeOnly) getKeyRequests++;
						if (method !== "getKey") { const key = method + ":" + this.name; calls[key] = (calls[key] ?? 0) + 1; }
						if (method === "openCursor") request.addEventListener("success", () => {
							if (request.result !== null) cursorRows[this.name] = (cursorRows[this.name] ?? 0) + 1;
						});
					}
					return request;
				},
			});
		}
		const maintenance = durableIssuancePruningMaintenanceForStore(store);
		r8Check(maintenance?.readBoundedRecoveryCensus !== undefined, "original native maintenance census required");
		const census = (objectId = r8Scope.objectId, limits = ISSUANCE_RETIREMENT_LIMITS) => maintenance.readBoundedRecoveryCensus!({ objectId, limits });
		stage = "unheld-census-before-first-loan"; take();
		const unheldBefore = await census();
		await Promise.all([...seenTransactions].map(id => nativeTerminals.get(id)!)); observations.unheldBeforeWork = take();
		stage = "first-real-held-census"; actualHeldTransaction = undefined;
		held = await r8AcquireHeldRead(store, r8Scope.objectId);
		take();
		const seed = await census(); observations.seedWork = take();
		const expectedRows = r8Hex(encodeCanonical(seed.rows)), expectedImage = seed.image.imageDigest;
		const expectedControl = r8Hex(encodeCanonical(seed.control ?? null));
		if (probeOnly) {
			type Probe = { checkCurrent(): Promise<boolean> };
			const producer = maintenance.readBoundedRecoveryCensus!;
			const capture: unknown = Reflect.get(producer, "captureCurrentProbe");
			r8Check(typeof capture === "function" && Object.isFrozen(producer), "frozen original census producer owns probe capture");
			const input: { objectId: string; limits: { readonly maxRows: number; readonly maxBytes: number } } =
				{ objectId: r8Scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS };
			const captured = (observation: typeof seed, request = input, receiver: unknown = producer): Probe | undefined =>
				Reflect.apply(capture, receiver, [request, observation]) as Probe | undefined;
			const probeRefusals = {
				nonheld: captured(unheldBefore) === undefined,
				copied: captured(structuredClone(seed)) === undefined,
				forged: captured({ ...seed }) === undefined,
				foreignReceiver: captured(seed, input, {}) === undefined,
				wrongObject: captured(seed, { ...input, objectId: otherScope.objectId }) === undefined,
				wrongLimits: captured(seed, { ...input, limits: { ...ISSUANCE_RETIREMENT_LIMITS, maxRows: ISSUANCE_RETIREMENT_LIMITS.maxRows - 1 } }) === undefined,
				wrongByteLimit: captured(seed, { ...input, limits: { ...ISSUANCE_RETIREMENT_LIMITS, maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes - 1 } }) === undefined,
			};
			const signature = seed.rows.issued[0]!.signature, savedByte = signature[0]!;
			signature[0] = savedByte ^ 1;
			const mutated = captured(seed) === undefined;
			signature[0] = savedByte;
			const probe = captured(seed);
			r8Check(probe !== undefined, "rejected copies/inputs/mutation preserve genuine enrollment");
			observations.probeRefusals = { ...probeRefusals, mutated, consumed: captured(seed) === undefined };
			observations.probeSurface = { keys: Reflect.ownKeys(probe), frozen: Object.isFrozen(probe) };
			observations.foreignProbeReceiver = await rejection(Reflect.apply(probe.checkCurrent, {}, []));
			take(); observations.current = await probe.checkCurrent(); observations.currentWork = take();
			observations.otherObjectFallback = { rows: (await census(otherScope.objectId)).rows.issued.length };
			observations.otherObjectFallbackWork = take();
			observations.lowerRows = await rejection(census(r8Scope.objectId, { ...ISSUANCE_RETIREMENT_LIMITS, maxRows: 1 }));
			observations.lowerRowsWork = take();
			observations.lowerBytes = await rejection(census(r8Scope.objectId, { ...ISSUANCE_RETIREMENT_LIMITS, maxBytes: 1 }));
			observations.lowerBytesWork = take();
			observations.currentAfterRefusals = await probe.checkCurrent(); take();
			await held.release(); held = undefined;
			observations.released = await probe.checkCurrent(); take();
			actualHeldTransaction = undefined; held = await r8AcquireHeldRead(store, r8Scope.objectId); take();
			observations.replaced = await probe.checkCurrent(); observations.replacedWork = take();
			const newBook = await census(); observations.newBookWork = take();
			observations.newBook = { sameImage: newBook.image.imageDigest === expectedImage, signature: ed25519.verify(newBook.rows.issued[0]!.signature, newBook.rows.issued[0]!.digest, r8PublicKey) };
			await held.release(); held = undefined;
			const joinedProbeControls: unknown[] = [], controlsCrypto = cryptoEntries;
			for (const mode of ["release", "abort", "close"] as const) {
				stage = "entered-current-probe-" + mode; actualHeldTransaction = undefined;
				held = await r8AcquireHeldRead(store, r8Scope.objectId);
				const observation = await census(), currentProbe = captured(observation);
				r8Check(currentProbe !== undefined && actualHeldTransaction !== undefined, "genuine probe for original current native book");
				let enteredResolve!: () => void, registrations = 0, delivered = false, stopJoined = false;
				const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
				// Outside a native turn: the next keeper queues its successor first,
				// then starts the queued check's genuine getKey. Gate only that second
				// success continuation, never a request/result or the keeper schedule.
				Object.defineProperty(IDBRequest.prototype, "addEventListener", { configurable: true, writable: true,
					value: function (this: IDBRequest, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void {
						const source = this.source;
						if (type === "success" && source instanceof IDBObjectStore && source.name === actualHeldTransaction?.objectStoreNames[0] && source.transaction === actualHeldTransaction && ++registrations === 2) {
							return Reflect.apply(originalListener, this, [type, (event: Event) => {
								resumeRead = () => { resumeRead = undefined; if (typeof listener === "function") listener.call(this, event); else listener.handleEvent(event); };
								enteredResolve();
							}, options]);
						}
						return Reflect.apply(originalListener, this, [type, listener, options]);
					},
				});
				const inFlight = currentProbe.checkCurrent().then(current => { delivered = true; return { resolved: true, current }; }, error => { delivered = true; return { resolved: false, failure: r8Error(error) }; });
				await entered;
				foreign = await openRaw(derived);
				const writer = foreign.transaction("lineages", "readwrite"), writerTerminal = transactionComplete(writer);
				let writerRead = false;
				foreignWork = requestResult(writer.objectStore("lineages").get([r8Scope.objectId, r8Scope.author])).then(async () => { writerRead = true; await writerTerminal; });
				void foreignWork.catch(() => undefined);
				if (mode === "abort") actualHeldTransaction!.abort();
				const stop = (mode === "close" ? store.close() : held.release()).then(() => { stopJoined = true; return { code: "RESOLVED" }; }, error => { stopJoined = true; return r8Error(error); });
				take();
				const revokedProbe = await currentProbe.checkCurrent().then(current => ({ resolved: true, current }), error => ({ resolved: false, failure: r8Error(error) }));
				const closedCapture = mode === "close" ? await rejection(Promise.resolve().then(() => captured(observation))) : undefined;
				const admission = await rejection(store.readIssued(r8Scope, 0)), admissionWork = take();
				const midpoint = { stopJoined, delivered, writerRead };
				r8Check(resumeRead !== undefined, "original currency success continuation held"); resumeRead();
				const checked = await inFlight, stopped = await stop;
				await foreignWork; foreignWork = undefined; foreign.close(); foreign = undefined; held = undefined;
				if (ownListenerDescriptor === undefined) Reflect.deleteProperty(IDBRequest.prototype, "addEventListener");
				else Object.defineProperty(IDBRequest.prototype, "addEventListener", ownListenerDescriptor);
				joinedProbeControls.push({ mode, midpoint, revokedProbe, closedCapture, admission, admissionWork, checked, stopped, delivered, stopJoined, writerRead });
				if (mode === "close") { await store.close(); store = await createOriginalStore({ primaryDatabaseName: primary }); }
			}
			observations.joinedProbeControls = joinedProbeControls;
			observations.probeControlsZeroCrypto = controlsCrypto === cryptoEntries;
			observations.probeControlsNativeUnchanged = before === await r8Image(primary);
			stage = "new-book-foreign-corruption-and-sticky-poison";
			const currentMaintenance = durableIssuancePruningMaintenanceForStore(store);
			r8Check(currentMaintenance?.readBoundedRecoveryCensus !== undefined, "reopened original producer required");
			const currentProducer = currentMaintenance.readBoundedRecoveryCensus;
			actualHeldTransaction = undefined; held = await r8AcquireHeldRead(store, r8Scope.objectId);
			const currentObservation = await currentProducer(input);
			const currentCapture: unknown = Reflect.get(currentProducer, "captureCurrentProbe");
			r8Check(typeof currentCapture === "function", "reopened producer probe method required");
			const beforeCorruption = Reflect.apply(currentCapture, currentProducer, [input, currentObservation]) as Probe | undefined;
			r8Check(beforeCorruption !== undefined, "original pre-corruption enrollment");
			foreign = await openRaw(derived);
			const corrupt = foreign.transaction("issuanceOutbox", "readwrite"), corruptTerminal = transactionComplete(corrupt);
			let foreignRead = false;
			foreignWork = (async () => {
				const raw: unknown = await requestResult(corrupt.objectStore("issuanceOutbox").get([otherScope.objectId, otherScope.author, 0]));
				r8Check(typeof raw === "object" && raw !== null, "original foreign outbox row present"); foreignRead = true;
				const digest = Uint8Array.from(Reflect.get(raw, "digest") as Uint8Array); digest[0] = digest[0]! ^ 1;
				await requestResult(corrupt.objectStore("issuanceOutbox").put({ ...raw, digest })); await corruptTerminal;
			})(); void foreignWork.catch(() => undefined);
			await beforeCorruption.checkCurrent(); observations.foreignExcluded = !foreignRead;
			await held.release(); held = undefined; await foreignWork; foreignWork = undefined; foreign.close(); foreign = undefined;
			actualHeldTransaction = undefined; held = await r8AcquireHeldRead(store, r8Scope.objectId); take();
			observations.oldBookAfterCorruption = await beforeCorruption.checkCurrent();
			const poisonedObservation = await currentProducer(input); observations.corruptNewBookWork = take();
			const poisonedProbe = Reflect.apply(currentCapture, currentProducer, [input, poisonedObservation]) as Probe | undefined;
			r8Check(poisonedProbe !== undefined, "addressed census retains original global outbox validation boundary");
			observations.foreignCorruption = await rejection(store.readOutboxPage({ scope: r8Scope, limit: 1 }));
			observations.foreignScanWork = take();
			observations.poisonedProbe = await rejection(poisonedProbe.checkCurrent());
			observations.poisonedCapture = await rejection(Promise.resolve().then(() => Reflect.apply(currentCapture, currentProducer, [input, poisonedObservation])));
			observations.foreignSticky = await rejection(store.readIssued(r8Scope, 0));
			return { ...observations, cryptoEntries, cleanup, qualification: "One original census producer and exact held IndexedDB transaction. Probes return currentness only; genuine new native requests, original full-read fallback, corruption and joined revocation remain. Scalar request observations are not CPU/FPS claims or reusable authentication/accounting credit." };
		}
		observations.unheldBefore = { rows: unheldBefore.rows.issued.length, imageMatches: unheldBefore.image.imageDigest === expectedImage,
			rowsetMatches: r8Hex(encodeCanonical(unheldBefore.rows)) === expectedRows, controlMatches: r8Hex(encodeCanonical(unheldBefore.control ?? null)) === expectedControl,
			signature: ed25519.verify(unheldBefore.rows.issued[0]!.signature, unheldBefore.rows.issued[0]!.digest, r8PublicKey) };
		const mutationAttempts: string[] = [];
		const mutate = (label: string, action: () => void): void => { try { action(); mutationAttempts.push(label + ":mutated"); } catch { mutationAttempts.push(label + ":immutable"); } };
		mutate("census-PRE", () => seed.rows.issued[0]!.canonicalPreimageBytes.fill(0));
		mutate("census-signature", () => seed.rows.issued[0]!.signature.fill(0));
		mutate("census-plan-digest", () => seed.rows.plans[0]!.entries[0]!.sourceDigest.fill(0));
		mutate("census-arrays", () => { (seed.rows.outbox as unknown as unknown[]).pop(); });
		mutate("census-lineage", () => { Reflect.set(seed.rows.lineages[0]!, "next", 999); });
		stage = "repeat-census-point-plan-lineage";
		const repeated = await census(); observations.repeatCensusWork = take();
		const point = await store.readIssued(r8Scope, 1), plan = await store.readSettlementPlan(r8Scope), lineage = await store.readLineage(r8Scope);
		r8Check(point !== null && plan !== null, "genuine point and native plan present");
		observations.pointPlanLineageWork = take();
		const expectedPoint = r8Hex(encodeCanonical(point)), expectedPlan = r8Hex(encodeCanonical(plan));
		mutate("point-PRE", () => point.envelope.canonicalPreimageBytes.fill(0));
		mutate("point-signature", () => point.envelope.signature.fill(0));
		mutate("point-scope", () => { Reflect.set(point.issuedRecord.scope, "objectId", "foreign"); });
		mutate("plan-digest", () => plan.entries[0]!.sourceDigest.fill(0));
		mutate("plan-array", () => { (plan.entries as unknown as unknown[]).pop(); });
		mutate("lineage", () => { Reflect.set(lineage, "next", 999); });
		const freshPoint = await store.readIssued(r8Scope, 1), freshPlan = await store.readSettlementPlan(r8Scope);
		const freshLineage = await store.readLineage(r8Scope);
		observations.copyIsolation = {
			census: r8Hex(encodeCanonical(repeated.rows)) === expectedRows && repeated.image.imageDigest === expectedImage,
			control: r8Hex(encodeCanonical(repeated.control ?? null)) === expectedControl,
			point: r8Hex(encodeCanonical(freshPoint)) === expectedPoint, plan: r8Hex(encodeCanonical(freshPlan)) === expectedPlan,
			lineage: freshLineage.next === 3,
			signature: freshPoint !== null && ed25519.verify(freshPoint.envelope.signature, freshPoint.envelope.digest, r8PublicKey), mutationAttempts,
		}; take();
		stage = "global-page-and-other-object-fallback";
		const firstPage = await store.readOutboxPage({ scope: r8Scope, limit: 2 }); observations.firstPageWork = take();
		mutate("page-signature", () => firstPage[0]!.commit.envelope.signature.fill(0));
		mutate("page-array", () => { (firstPage as unknown as unknown[]).pop(); });
		const nextPage = await store.readOutboxPage({ scope: r8Scope, afterKey: [r8Scope.objectId, r8Scope.author, 1], limit: 2 });
		observations.repeatPageWork = take();
		const firstPageAgain = await store.readOutboxPage({ scope: r8Scope, limit: 2 });
		observations.pages = { next: nextPage.map(row => row.commit.authorSequence), isolated: firstPageAgain.length === 2 &&
			ed25519.verify(firstPageAgain[0]!.commit.envelope.signature, firstPageAgain[0]!.commit.envelope.digest, r8PublicKey) }; take();
		const other = await census(otherScope.objectId); observations.otherObjectWork = take();
		const otherPoint = await store.readIssued(otherScope, 0);
		observations.otherObject = { rows: other.rows.issued.length, differentImage: other.image.imageDigest !== expectedImage,
			signature: otherPoint !== null && ed25519.verify(otherPoint.envelope.signature, otherPoint.envelope.digest, r8PublicKey) }; take();
		stage = "strict-smaller-entitlements";
		observations.lowerRows = await rejection(census(r8Scope.objectId, { ...ISSUANCE_RETIREMENT_LIMITS, maxRows: 1 }));
		observations.lowerBytes = await rejection(census(r8Scope.objectId, { ...ISSUANCE_RETIREMENT_LIMITS, maxBytes: 1 }));
		const afterLimits = await census();
		observations.limitsPreserve = afterLimits.image.imageDigest === expectedImage;
		await held.release(); held = undefined;
		stage = "unheld-census-after-joined-release"; take();
		const unheldAfter = await census();
		await Promise.all([...seenTransactions].map(id => nativeTerminals.get(id)!)); observations.unheldAfterWork = take();
		observations.unheldAfter = { rows: unheldAfter.rows.issued.length, imageMatches: unheldAfter.image.imageDigest === expectedImage,
			rowsetMatches: r8Hex(encodeCanonical(unheldAfter.rows)) === expectedRows, controlMatches: r8Hex(encodeCanonical(unheldAfter.control ?? null)) === expectedControl,
			signature: ed25519.verify(unheldAfter.rows.issued[0]!.signature, unheldAfter.rows.issued[0]!.digest, r8PublicKey) };
		observations.readOnlyNativeUnchanged = before === await r8Image(primary);

		// A real success notification is held, not a fake request/result or owner.
		// The original native transaction remains alive and owns its exclusion.
		const joinedControls: unknown[] = [], controlsBefore = await r8Image(primary), controlsCrypto = cryptoEntries;
		for (const mode of ["release", "abort", "close"] as const) {
			stage = "entered-native-read-" + mode; actualHeldTransaction = undefined;
			held = await r8AcquireHeldRead(store, r8Scope.objectId); await census(); take();
			let enteredResolve!: () => void, armed = true, readDelivered = false, stopJoined = false;
			const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
			Object.defineProperty(IDBRequest.prototype, "addEventListener", { configurable: true, writable: true,
				value: function (this: IDBRequest, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void {
					const source = this.source;
					if (armed && type === "success" && source instanceof IDBObjectStore && source.name === "retirementControls" && source.transaction === actualHeldTransaction) {
						armed = false;
						return Reflect.apply(originalListener, this, [type, (event: Event) => {
							resumeRead = () => { resumeRead = undefined; if (typeof listener === "function") listener.call(this, event); else listener.handleEvent(event); };
							enteredResolve();
						}, options]);
					}
					return Reflect.apply(originalListener, this, [type, listener, options]);
				},
			});
			const inFlight = census().then(() => { readDelivered = true; return { code: "RESOLVED" }; }, error => r8Error(error));
			await entered;
			foreign = await openRaw(derived);
			const writer = foreign.transaction("lineages", "readwrite"), writerTerminal = transactionComplete(writer);
			let writerRead = false;
			foreignWork = requestResult(writer.objectStore("lineages").get([r8Scope.objectId, r8Scope.author])).then(async () => { writerRead = true; await writerTerminal; });
			void foreignWork.catch(() => undefined);
			take();
			if (mode === "abort") actualHeldTransaction!.abort();
			const stop = (mode === "close" ? store.close() : held.release()).then(() => { stopJoined = true; return { code: "RESOLVED" }; }, error => { stopJoined = true; return r8Error(error); });
			const admission = await rejection(store.readIssued(r8Scope, 0)), admissionWork = take();
			const midpoint = { stopJoined, readDelivered, writerRead };
			r8Check(resumeRead !== undefined, "real original read success awaiting continuation"); resumeRead();
			const read = await inFlight, stopped = await stop;
			await foreignWork; foreignWork = undefined; foreign.close(); foreign = undefined; held = undefined;
			if (ownListenerDescriptor === undefined) Reflect.deleteProperty(IDBRequest.prototype, "addEventListener");
			else Object.defineProperty(IDBRequest.prototype, "addEventListener", ownListenerDescriptor);
			joinedControls.push({ mode, midpoint, admission, admissionWork, read, stopped, readDelivered, stopJoined, writerRead });
			if (mode === "close") {
				await store.close(); store = await createOriginalStore({ primaryDatabaseName: primary });
			}
		}
		observations.joinedControls = joinedControls;
		observations.readControlsZeroCrypto = controlsCrypto === cryptoEntries;
		observations.readControlsNativeUnchanged = controlsBefore === await r8Image(primary);
		stage = "released-native-write-new-transaction-reopen";
		const nativeBefore = await r8Image(primary), cryptoBefore = cryptoEntries;
		const currentMaintenance = durableIssuancePruningMaintenanceForStore(store);
		r8Check(currentMaintenance?.readBoundedRecoveryCensus !== undefined, "same connection original native census required");
		held = await r8AcquireHeldRead(store, r8Scope.objectId);
		await currentMaintenance.readBoundedRecoveryCensus({ objectId: r8Scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
		await held.release(); held = undefined;
		const next = await r8Issuer(store, signed).issue(r8Input);
		await store.compareAndMarkOutboxPublished({ scope: r8Scope, authorSequence: next.authorSequence, digest: next.envelope.digest });
		held = await r8AcquireHeldRead(store, r8Scope.objectId); take();
		const sameConnection = await currentMaintenance.readBoundedRecoveryCensus({ objectId: r8Scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
		observations.sameConnectionRefreshWork = take();
		observations.sameConnectionRefresh = { rows: sameConnection.rows.issued.length, newImage: sameConnection.image.imageDigest !== expectedImage,
			published: sameConnection.rows.outbox.find(row => row.author === r8Scope.author && row.authorSequence === next.authorSequence)?.publishState === "published" };
		await held.release(); held = undefined;
		await store.close(); store = await createOriginalStore({ primaryDatabaseName: primary });
		held = await r8AcquireHeldRead(store, r8Scope.objectId);
		const reopenedMaintenance = durableIssuancePruningMaintenanceForStore(store);
		r8Check(reopenedMaintenance?.readBoundedRecoveryCensus !== undefined, "same DB native census reopened");
		take(); const refreshed = await reopenedMaintenance.readBoundedRecoveryCensus({ objectId: r8Scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
		observations.refreshWork = take();
		const refreshedIssued = await store.readIssued(r8Scope, next.authorSequence);
		const refreshedPage = await store.readOutboxPage({ scope: r8Scope, afterKey: [r8Scope.objectId, r8Scope.author, next.authorSequence - 1], limit: 1 });
		observations.refresh = { sequence: next.authorSequence, rows: refreshed.rows.issued.length, next: (await store.readLineage(r8Scope)).next,
			newImage: refreshed.image.imageDigest !== expectedImage, published: refreshedPage[0]?.publishState === "published",
			oneNewSignature: cryptoEntries === cryptoBefore + 1, signature: refreshedIssued !== null && ed25519.verify(refreshedIssued.envelope.signature, refreshedIssued.envelope.digest, r8PublicKey) };
		await held.release(); held = undefined;
		observations.actualNativeWrite = nativeBefore !== await r8Image(primary);
		const continuation = await r8Issuer(store, signed).issue(r8Input);
		observations.continuation = { sequence: continuation.authorSequence, signature: ed25519.verify(continuation.envelope.signature, continuation.envelope.digest, r8PublicKey) };
		stage = "foreign-corruption-after-release";
		held = await r8AcquireHeldRead(store, r8Scope.objectId);
		await reopenedMaintenance.readBoundedRecoveryCensus({ objectId: r8Scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS });
		foreign = await openRaw(derived);
		const poison = foreign.transaction("issuanceOutbox", "readwrite"), poisonTerminal = transactionComplete(poison);
		let foreignRead = false, foreignCommitted = false;
		foreignWork = (async () => {
			const raw: unknown = await requestResult(poison.objectStore("issuanceOutbox").get([otherScope.objectId, otherScope.author, 0]));
			r8Check(typeof raw === "object" && raw !== null, "genuine foreign signed row present"); foreignRead = true;
			const digest = Uint8Array.from(Reflect.get(raw, "digest") as Uint8Array); digest[0] = digest[0]! ^ 1;
			await requestResult(poison.objectStore("issuanceOutbox").put({ ...raw, digest })); await poisonTerminal; foreignCommitted = true;
		})(); void foreignWork.catch(() => undefined);
		await held.check(); observations.foreignExcluded = { foreignRead, foreignCommitted };
		await held.release(); held = undefined; await foreignWork; foreignWork = undefined; foreign.close(); foreign = undefined;
		await store.close(); store = await createOriginalStore({ primaryDatabaseName: primary });
		held = await r8AcquireHeldRead(store, r8Scope.objectId);
		const poisonedMaintenance = durableIssuancePruningMaintenanceForStore(store);
		r8Check(poisonedMaintenance?.readBoundedRecoveryCensus !== undefined, "uncovered foreign source uses original census");
		await poisonedMaintenance.readBoundedRecoveryCensus({ objectId: r8Scope.objectId, limits: ISSUANCE_RETIREMENT_LIMITS }); take();
		observations.foreignCorruption = await rejection(store.readOutboxPage({ scope: r8Scope, limit: 1 }));
		observations.foreignScanWork = take();
		observations.foreignSticky = await rejection(store.readIssued(r8Scope, 0));
		return { ...observations, cryptoEntries, cleanup, qualification: "Actual IndexedDB and one original held NativeReadReservation transaction; genuine Ed25519 issuer and mechanical native plans. Request/cursor counts concern removed native row materialization, not elapsed performance or authentication memoization. Success-listener gate controls delivery only; genuine transactions/requests and original exclusion/join checks remain. Local browser evidence, not device/network viability." };
	} catch (error) {
		primaryFailure = new Error(stage + ": " + String(error), { cause: error }); throw primaryFailure;
	} finally {
		resumeRead?.();
		if (ownListenerDescriptor === undefined) Reflect.deleteProperty(IDBRequest.prototype, "addEventListener");
		else Object.defineProperty(IDBRequest.prototype, "addEventListener", ownListenerDescriptor);
		for (const [method, descriptor] of descriptors) Object.defineProperty(IDBObjectStore.prototype, method, descriptor);
		const faults: unknown[] = [];
		for (const joined of await Promise.allSettled([...(held === undefined ? [] : [held.release()]), ...(foreignWork === undefined ? [] : [foreignWork])]))
			if (joined.status === "rejected") faults.push(joined.reason);
		if (held !== undefined) cleanup.push("reservation:joined"); foreign?.close();
		try { await store.close(); cleanup.push("store:joined"); } catch (error) { faults.push(error); }
		await deleteDatabase(derived); cleanup.push("database:deleted");
		if (faults.length) throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...faults], "held census regression cleanup failed", { cause: primaryFailure ?? faults[0] });
	}
}
declare global { interface Window { phase2lBR8HeldCensusFacts(): Promise<unknown>; phase2lBR8IssuanceCurrentProbe(): Promise<unknown>; } }
window.phase2lBR8HeldCensusFacts = async (): Promise<unknown> => {
	try { return { ok: true, value: await r8HeldCensusFacts() }; }
	catch (error) { return { ok: false, failure: r8Error(error) }; }
};
window.phase2lBR8IssuanceCurrentProbe = async (): Promise<unknown> => {
	try { return { ok: true, value: await r8HeldCensusFacts(true) }; }
	catch (error) { return { ok: false, failure: r8Error(error) }; }
};

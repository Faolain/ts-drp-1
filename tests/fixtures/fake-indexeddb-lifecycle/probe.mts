import type * as FakeIndexedDB from "fake-indexeddb";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";

const format = process.argv[2];
assert.ok(format === "esm" || format === "cjs");
assert.equal(typeof globalThis.gc, "function", "probe requires actual Node --expose-gc");
const library: typeof FakeIndexedDB =
	format === "esm"
		? await import("fake-indexeddb")
		: (createRequire(import.meta.url)("fake-indexeddb") as typeof FakeIndexedDB);
const factory = new library.IDBFactory();
const roots: IDBDatabase[] = [];
const terminal: { name: string; reference: WeakRef<IDBTransaction> }[] = [];
const cases: { name: string; ok: boolean; error?: string }[] = [];
const seed = { id: "seed", unique: "seed", bytes: new Uint8Array([1, 2, 3]) };

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = (): void => resolve(request.result);
		request.onerror = (): void => reject(request.error);
	});
}

function terminalEvent(transaction: IDBTransaction, expected: "complete" | "abort" = "complete"): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.addEventListener(
			"complete",
			() => (expected === "complete" ? resolve() : reject(new Error("expected abort"))),
			{ once: true }
		);
		transaction.addEventListener(
			"abort",
			() => (expected === "abort" ? resolve() : reject(transaction.error ?? new Error("unexpected abort"))),
			{ once: true }
		);
	});
}

async function openSeeded(name: string): Promise<IDBDatabase> {
	const opening = factory.open(name, 1);
	opening.onupgradeneeded = (): void => {
		const store = opening.result.createObjectStore("records", { keyPath: "id" });
		store.createIndex("unique", "unique", { unique: true });
		store.add(seed);
	};
	const database = await result(opening);
	roots.push(database);
	assert.deepEqual(await rows(database), [seed]);
	return database;
}

async function rows(database: IDBDatabase): Promise<unknown[]> {
	const transaction = database.transaction("records", "readonly");
	const complete = terminalEvent(transaction);
	const values = await result<unknown[]>(transaction.objectStore("records").getAll());
	await complete;
	return values;
}

async function run(name: string, action: () => Promise<void>): Promise<void> {
	try {
		await action();
		cases.push({ name, ok: true });
	} catch (error) {
		cases.push({ name, ok: false, error: String((error as { stack?: unknown } | null | undefined)?.stack ?? error) });
	}
}

await run("commit", async () => {
	const database = await openSeeded("commit");
	const transaction = database.transaction("records", "readwrite");
	const complete = terminalEvent(transaction);
	const replacement = { id: "replacement", unique: "replacement", bytes: new Uint8Array([4, 5, 6]) };
	transaction.objectStore("records").clear();
	transaction.objectStore("records").put(replacement);
	await complete;
	assert.deepEqual(await rows(database), [replacement]);
	terminal.push({ name: "commit", reference: new WeakRef(transaction) });
});

await run("explicit-abort", async () => {
	const database = await openSeeded("explicit-abort");
	const transaction = database.transaction("records", "readwrite");
	const aborted = terminalEvent(transaction, "abort");
	const store = transaction.objectStore("records");
	store.clear();
	const inserted = store.put({ id: "replacement", unique: "replacement", bytes: new Uint8Array([9]) });
	inserted.onsuccess = (): void => transaction.abort();
	await aborted;
	assert.equal(transaction.error, null);
	assert.deepEqual(await rows(database), [seed]);
	terminal.push({ name: "explicit-abort", reference: new WeakRef(transaction) });
});

await run("error-abort", async () => {
	const database = await openSeeded("error-abort");
	const transaction = database.transaction("records", "readwrite");
	const aborted = terminalEvent(transaction, "abort");
	const store = transaction.objectStore("records");
	store.put({ id: "temporary", unique: "temporary", bytes: new Uint8Array([8]) });
	// Let the unique-index error abort normally; no preventDefault or synthetic failure.
	store.add({ id: "duplicate", unique: "seed", bytes: new Uint8Array([7]) });
	await aborted;
	assert.equal(transaction.error?.name, "ConstraintError");
	assert.deepEqual(await rows(database), [seed]);
	terminal.push({ name: "error-abort", reference: new WeakRef(transaction) });
});

await run("conflicting-order", async () => {
	const database = await openSeeded("conflicting-order");
	const events: string[] = [];
	const first = database.transaction("records", "readwrite");
	const firstComplete = terminalEvent(first);
	first.addEventListener("complete", () => events.push("first-complete"));
	const firstWrite = first.objectStore("records").put({ id: "seed", unique: "seed", bytes: new Uint8Array([4]) });
	firstWrite.onsuccess = (): void => {
		events.push("first-write");
		// An active request callback can extend the first transaction even though
		// a conflicting successor transaction is already queued.
		first.objectStore("records").put({ id: "seed", unique: "seed", bytes: new Uint8Array([5]) });
	};
	const second = database.transaction("records", "readwrite");
	const secondComplete = terminalEvent(second);
	second.addEventListener("complete", () => events.push("second-complete"));
	const secondRead = second.objectStore("records").get("seed");
	let observed: unknown;
	secondRead.onsuccess = (): void => {
		events.push("second-read");
		observed = secondRead.result;
		second.objectStore("records").put({ id: "seed", unique: "seed", bytes: new Uint8Array([6]) });
	};
	await Promise.all([firstComplete, secondComplete]);
	assert.deepEqual(events, ["first-write", "first-complete", "second-read", "second-complete"]);
	assert.deepEqual(observed, { id: "seed", unique: "seed", bytes: new Uint8Array([5]) });
	assert.deepEqual(await rows(database), [{ id: "seed", unique: "seed", bytes: new Uint8Array([6]) }]);
});

await run("upgrade-abort-close-delete", async () => {
	const initial = await openSeeded("upgrade");
	initial.close();
	const upgrade = factory.open("upgrade", 2);
	upgrade.onupgradeneeded = (): void => {
		const transaction = upgrade.transaction as IDBTransaction;
		terminal.push({ name: "upgrade-abort", reference: new WeakRef(transaction) });
		upgrade.result.deleteObjectStore("records");
		upgrade.result.createObjectStore("discarded");
		transaction.abort();
	};
	await assert.rejects(result(upgrade), { name: "AbortError" });
	const database = await result(factory.open("upgrade", 1));
	roots.push(database);
	assert.equal(database.version, 1);
	assert.deepEqual([...database.objectStoreNames], ["records"]);
	assert.deepEqual(await rows(database), [seed]);
	const other = await result(factory.open("upgrade", 1));
	const events: string[] = [];
	const pending = database.transaction("records", "readwrite");
	const completed = terminalEvent(pending);
	pending.objectStore("records").put({ id: "later", unique: "later", bytes: new Uint8Array([10]) });
	pending.addEventListener("complete", () => events.push("transaction-complete"));
	database.close();
	assert.throws(() => database.transaction("records"), { name: "InvalidStateError" });
	other.onversionchange = (): number => events.push("versionchange");
	const deletion = factory.deleteDatabase("upgrade");
	deletion.onblocked = (): void => {
		events.push("blocked");
		other.close();
	};
	await result(deletion);
	events.push("delete-complete");
	await completed;
	assert.ok(events.indexOf("versionchange") >= 0);
	assert.ok(events.indexOf("blocked") > events.indexOf("versionchange"));
	assert.ok(events.indexOf("delete-complete") > events.indexOf("blocked"));
	assert.ok(events.indexOf("delete-complete") > events.indexOf("transaction-complete"));
	const recreated = factory.open("upgrade", 1);
	let oldVersion: number | undefined;
	recreated.onupgradeneeded = (event): void => {
		oldVersion = event.oldVersion;
		recreated.result.createObjectStore("records", { keyPath: "id" });
	};
	const fresh = await result(recreated);
	roots.push(fresh);
	assert.equal(oldVersion, 0);
	assert.deepEqual(await rows(fresh), []);
});

// WeakRefs are created in completed helper scopes. No pressure arrays, private
// implementation fields, or database deletion are used to make GC pass.
const disposable = ((): WeakRef<{ sentinel: boolean }> => new WeakRef({ sentinel: true }))();
const maxGcTurns = 32;
let gcTurns = 0;
let sentinelCollected = false;
let collected: { name: string; collected: boolean }[] = [];
for (; gcTurns < maxGcTurns; gcTurns += 1) {
	// A new job ends WeakRef's keep-during-job protection from the previous check.
	await setImmediate();
	(globalThis.gc as () => void)();
	await setImmediate();
	sentinelCollected = disposable.deref() === undefined;
	collected = terminal.map(({ name, reference }) => ({ name, collected: reference.deref() === undefined }));
	if (sentinelCollected && collected.every((entry) => entry.collected)) {
		gcTurns += 1;
		break;
	}
}
// Keep the factory, connections and committed contents observably live across GC.
assert.deepEqual(
	(await factory.databases()).map(({ name }) => name).sort(),
	["commit", "conflicting-order", "error-abort", "explicit-abort", "upgrade"].sort()
);
assert.equal(roots.length, 7);
assert.deepEqual(await rows(roots[0]), [
	{ id: "replacement", unique: "replacement", bytes: new Uint8Array([4, 5, 6]) },
]);
process.stdout.write(
	`${JSON.stringify({ kind: "FAKE_IDB_LIFECYCLE", format, cases, gc: { gcTurns, maxGcTurns, sentinelCollected, collected } })}\n`
);

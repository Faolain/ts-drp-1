// Slice 14f (specs/bounded-storage-lifecycle/slices/14f-retention-native-evidence.md),
// mechanism cases 1-4 for the slice 14a room retirement session, run in a real engine.
// Test-only page entry: it drives the session's own transaction with synthetic rows and
// mints no authority; product owners and their transitions are not involved.
import { openRoomRetirementSession } from "../../src/internal/native-read-reservation.js";
import { openPhase2dBrowserDatabase, prepareBrowserRoomDatabase } from "../../src/internal/schema-idb.js";

type Session = Awaited<ReturnType<typeof openRoomRetirementSession>>;

function request<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = (): void => resolve(r.result);
		r.onerror = (): void => reject(r.error);
	});
}
function terminal(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = (): void => resolve();
		tx.onabort = (): void => reject(tx.error ?? new Error("aborted"));
	});
}
const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const control = (objectId: string, value: number): Readonly<{ objectId: string; record: Uint8Array }> => ({
	objectId,
	record: Uint8Array.of(value),
});
const describe = (cause: unknown): string =>
	cause instanceof Error || cause instanceof DOMException ? `${cause.name}: ${cause.message}` : String(cause);

async function openPlain(name: string): Promise<IDBDatabase> {
	return request(indexedDB.open(name));
}
async function count(name: string, store: string): Promise<number> {
	const db = await openPlain(name);
	try {
		const tx = db.transaction([store], "readonly");
		const value = await request(tx.objectStore(store).count());
		await terminal(tx);
		return value;
	} finally {
		db.close();
	}
}
async function counts(name: string, stores: readonly string[]): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const store of stores) out[store] = await count(name, store);
	return out;
}

// One synthetic row per object store, shaped only by that store's key path, so a
// transaction can write in every owner namespace of the room database at once.
let synthetic = 0;
function syntheticRow(store: IDBObjectStore): { value: unknown; key?: IDBValidKey } {
	const id = `r3-synthetic-${++synthetic}`;
	const keyPath = store.keyPath;
	if (keyPath === null) return store.autoIncrement ? { value: { id } } : { value: { id }, key: id };
	const value: Record<string, unknown> = { id };
	for (const path of typeof keyPath === "string" ? [keyPath] : keyPath) {
		const parts = path.split(".");
		let at = value;
		for (const part of parts.slice(0, -1)) at = (at[part] ??= {}) as Record<string, unknown>;
		at[parts.at(-1)!] = id;
	}
	// Index key paths absent from a value are skipped natively; unique values never collide.
	return { value };
}
// Every owner store; the room layout record is the database's own and stays exact.
const ROOM_LAYOUT_STORE = "room:layout";
async function writeEveryStore(tx: IDBTransaction): Promise<string[]> {
	const names = [...tx.objectStoreNames].filter((name) => name !== ROOM_LAYOUT_STORE);
	for (const name of names) {
		const store = tx.objectStore(name);
		const row = syntheticRow(store);
		await request(row.key === undefined ? store.add(row.value) : store.add(row.value, row.key));
	}
	return names;
}

let counter = 0;
const fresh = (label: string): string => `r3-native-${label}-${Date.now()}-${++counter}`;

const cases: Record<string, (arg?: string) => Promise<unknown>> = {
	// Case 1: the session's read-write transaction is strict.
	async "strict"() {
		const name = fresh("strict");
		await prepareBrowserRoomDatabase({ databaseName: name });
		const session = await openRoomRetirementSession({ databaseName: name });
		try {
			const durability = await session.run(async (tx) => tx.durability);
			const mode = await session.run(async (tx) => tx.mode);
			await session.commit();
			return { ok: true, durability, mode };
		} catch (cause) {
			await session.abort().catch(() => undefined);
			return { ok: false, error: describe(cause), durabilityAttribute: "durability" in IDBTransaction.prototype };
		}
	},
	// Case 2: one transaction over every owner store, kept open across non-IndexedDB
	// work; aborted at its last request it changes no store; committed, every store.
	async "atomic"() {
		const name = fresh("atomic");
		await prepareBrowserRoomDatabase({ databaseName: name });
		const plain = await openPlain(name);
		const stores = [...plain.objectStoreNames].filter((store) => store !== ROOM_LAYOUT_STORE);
		plain.close();
		const before = await counts(name, stores);
		const aborted = await openRoomRetirementSession({ databaseName: name });
		await aborted.run(async (tx) => writeEveryStore(tx));
		await later(50);
		await aborted.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("last", 1)));
		});
		await aborted.abort(new Error("abort at the last request"));
		const afterAbort = await counts(name, stores);
		const refusedAfterAbort = await aborted
			.run(async () => "ran")
			.then(
				() => false,
				() => true
			);
		const committed = await openRoomRetirementSession({ databaseName: name });
		await committed.run(async (tx) => writeEveryStore(tx));
		await later(50);
		await committed.commit();
		const afterCommit = await counts(name, stores);
		const failed = await openRoomRetirementSession({ databaseName: name });
		await failed.run(async (tx) => writeEveryStore(tx));
		const ownerRefusal = await failed
			.run(async () => {
				throw new Error("owner refusal");
			})
			.then(
				() => "resolved",
				(cause: unknown) => describe(cause)
			);
		const commitAfterFailure = await failed.commit().then(
			() => "committed",
			(cause: unknown) => describe(cause)
		);
		const afterFailure = await counts(name, stores);
		return {
			stores,
			before,
			afterAbort,
			refusedAfterAbort,
			afterCommit,
			ownerRefusal,
			commitAfterFailure,
			afterFailure,
		};
	},
	// Case 2 (checkpoint): a checkpoint is durable; writes after it are discarded by an abort.
	async "checkpoint"() {
		const name = fresh("checkpoint");
		await prepareBrowserRoomDatabase({ databaseName: name });
		const session = await openRoomRetirementSession({ databaseName: name });
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("a", 1)));
		});
		await session.checkpoint();
		const afterCheckpoint = await count(name, "journal:retirementControls");
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("b", 2)));
			await request(tx.objectStore("issuance:retirementControls").put(control("b", 2)));
		});
		await session.abort();
		return {
			afterCheckpoint,
			journal: await count(name, "journal:retirementControls"),
			issuance: await count(name, "issuance:retirementControls"),
		};
	},
	// Case 3 (session side): opens a session, writes, and holds it until told to commit.
	async "hold-open"(name?: string) {
		const databaseName = name!;
		await prepareBrowserRoomDatabase({ databaseName });
		const session = await openRoomRetirementSession({ databaseName });
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("o", 1)));
		});
		Reflect.set(globalThis, "__r3Held", session);
		return { held: true };
	},
	async "commit-held"() {
		const session = Reflect.get(globalThis, "__r3Held") as Session;
		const committedAt = performance.timeOrigin + performance.now();
		await session.commit();
		return { committedAt, finishedAt: performance.timeOrigin + performance.now() };
	},
	async "run-held"() {
		const session = Reflect.get(globalThis, "__r3Held") as Session;
		return session
			.run(async (tx) => {
				await request(tx.objectStore("journal:retirementControls").put(control("late", 3)));
				return "ran";
			})
			.then(
				(value) => ({ ok: true, value }),
				(cause: unknown) => ({ ok: false, error: describe(cause) })
			);
	},
	// Case 3 (foreign writer, another page): a strict write on an overlapping store.
	async "foreign-write"(name?: string) {
		const db = await openPlain(name!);
		const writer = db.transaction(["journal:retirementControls"], "readwrite", { durability: "strict" });
		writer.objectStore("journal:retirementControls").put(control("o", 9));
		const startedAt = performance.timeOrigin + performance.now();
		const done = terminal(writer).then(() => performance.timeOrigin + performance.now());
		Reflect.set(globalThis, "__r3Foreign", { db, done, startedAt });
		await later(150);
		const settledEarly = await Promise.race([done.then(() => true), later(0).then(() => false)]);
		return { startedAt, settledEarly };
	},
	async "foreign-done"(name?: string) {
		const foreign = Reflect.get(globalThis, "__r3Foreign") as { db: IDBDatabase; done: Promise<number> };
		const completedAt = await foreign.done;
		foreign.db.close();
		const db = await openPlain(name!);
		const tx = db.transaction(["journal:retirementControls"], "readonly");
		const rows = await request(tx.objectStore("journal:retirementControls").getAll());
		await terminal(tx);
		db.close();
		return { completedAt, rows: rows.map((row) => Array.from((row as { record: Uint8Array }).record)) };
	},
	async "journal-rows"(name?: string) {
		const db = await openPlain(name!);
		const tx = db.transaction(["journal:retirementControls"], "readonly");
		const rows = await request(tx.objectStore("journal:retirementControls").getAll());
		await terminal(tx);
		db.close();
		return { rows: rows.map((row) => Array.from((row as { record: Uint8Array }).record)) };
	},
	// Case 4 (another page): opens the room database at a higher version.
	async "upgrade"(name?: string) {
		const opened = indexedDB.open(name!, 8);
		opened.onupgradeneeded = (): void => undefined;
		let blocked = false;
		opened.onblocked = (): void => {
			blocked = true;
		};
		const db = await request(opened);
		const version = db.version;
		db.close();
		return { version, blocked };
	},
	// Case 4: code pinned to version 7 is refused once the database moved on.
	async "reopen-pinned"(name?: string) {
		const session = await openRoomRetirementSession({ databaseName: name! }).then(
			(value) => ({ ok: true as const, value }),
			(cause: unknown) => ({ ok: false as const, error: describe(cause) })
		);
		if (session.ok) await session.value.abort();
		const pinned = await request(indexedDB.open(name!, 7)).then(
			(db) => {
				db.close();
				return "opened";
			},
			(cause: unknown) => describe(cause)
		);
		return { session: session.ok ? "opened" : session.error, pinned };
	},
	// A database that is not a ready room is refused before any write.
	async "not-ready"() {
		const legacy = fresh("legacy");
		const v6 = await openPhase2dBrowserDatabase({ databaseName: legacy });
		v6.close();
		const legacySession = await openRoomRetirementSession({ databaseName: legacy }).then(
			() => "opened",
			(cause: unknown) => describe(cause)
		);
		const missing = fresh("missing");
		const missingSession = await openRoomRetirementSession({ databaseName: missing }).then(
			() => "opened",
			(cause: unknown) => describe(cause)
		);
		return { legacySession, missingSession };
	},
};

Reflect.set(globalThis, "r3SessionCase", async (name: string, arg?: string) => {
	const run = cases[name];
	if (run === undefined) throw new Error(`unknown case ${name}`);
	return run(arg);
});
Reflect.set(globalThis, "r3SessionReady", true);

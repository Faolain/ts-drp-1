import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import * as reservationModule from "../src/internal/native-read-reservation.js";
import * as schemaModule from "../src/internal/schema-idb.js";

// Slice 14a (specs/bounded-storage-lifecycle/slices/14a-retention-database-format.md),
// RED item 4, executor mechanics: one strict read-write transaction over the room
// database at a time, kept open across non-IndexedDB work, committed whole or not at
// all. fake-indexeddb is mechanism evidence only (native: 14f).

type Session = Readonly<{
	run<T>(operation: (transaction: IDBTransaction) => Promise<T>): Promise<T>;
	checkpoint(): Promise<void>;
	commit(): Promise<void>;
	abort(cause?: unknown): Promise<void>;
}>;

async function openSession(databaseName: string): Promise<Session> {
	const open = Reflect.get(reservationModule, "openRoomRetirementSession") as
		| ((input: Readonly<{ databaseName: string }>) => Promise<Session>)
		| undefined;
	if (typeof open !== "function") throw new Error("openRoomRetirementSession is missing");
	return open({ databaseName });
}

async function prepare(databaseName: string): Promise<void> {
	const prepareRoom = Reflect.get(schemaModule, "prepareBrowserRoomDatabase") as (
		input: Readonly<{ databaseName: string }>
	) => Promise<unknown>;
	await prepareRoom({ databaseName });
}

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

async function rows(databaseName: string, store: string): Promise<unknown[]> {
	const db = await request(indexedDB.open(databaseName));
	try {
		const tx = db.transaction([store], "readonly");
		const values = await request(tx.objectStore(store).getAll());
		await terminal(tx);
		return values;
	} finally {
		db.close();
	}
}

let counter = 0;
const fresh = (label: string): string => `room-session-${label}-${++counter}`;
const control = (objectId: string, value: number): Readonly<{ objectId: string; record: Uint8Array }> => ({
	objectId,
	record: Uint8Array.of(value),
});

describe("14a room retirement session", () => {
	it("commits writes to several namespaces in one transaction kept open across non-IndexedDB work", async () => {
		const name = fresh("atomic");
		await prepare(name);
		const session = await openSession(name);
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("o", 1)));
		});
		await later(50);
		await session.run(async (tx) => {
			await request(tx.objectStore("issuance:retirementControls").put(control("o", 2)));
			await request(tx.objectStore("voteSlots").put({ objectId: "o", epoch: 1, round: 0, phase: "p", signerId: "s" }));
		});
		// Nothing is visible to another connection before the commit.
		const reader = request(indexedDB.open(name));
		const db = await reader;
		const pending = (async () => {
			const tx = db.transaction(["journal:retirementControls"], "readonly");
			const values = await request(tx.objectStore("journal:retirementControls").getAll());
			await terminal(tx);
			return values;
		})();
		await later(50);
		await session.commit();
		// The reader was serialised after the whole session, so it sees all of it.
		expect(await pending).toHaveLength(1);
		db.close();
		expect(await rows(name, "issuance:retirementControls")).toHaveLength(1);
		expect(await rows(name, "voteSlots")).toHaveLength(1);
	});

	it("discards every write when aborted at the last request", async () => {
		const name = fresh("abort");
		await prepare(name);
		const session = await openSession(name);
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("o", 1)));
		});
		await later(20);
		await session.run(async (tx) => {
			await request(tx.objectStore("snapshot:retirementControls").put(Uint8Array.of(1), "o"));
		});
		await session.abort(new Error("test abort"));
		expect(await rows(name, "journal:retirementControls")).toEqual([]);
		expect(await rows(name, "snapshot:retirementControls")).toEqual([]);
		await expect(session.run(async () => undefined)).rejects.toThrow();
	});

	it("never commits after a failed operation", async () => {
		const name = fresh("failed");
		await prepare(name);
		const session = await openSession(name);
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("o", 1)));
		});
		await expect(
			session.run(async (tx) => {
				await request(tx.objectStore("issuance:retirementControls").put(control("o", 2)));
				throw new Error("owner refusal");
			})
		).rejects.toThrow("owner refusal");
		await expect(session.commit()).rejects.toThrow();
		expect(await rows(name, "journal:retirementControls")).toEqual([]);
		expect(await rows(name, "issuance:retirementControls")).toEqual([]);
	});

	it("makes a checkpoint durable and starts a new transaction after it", async () => {
		const name = fresh("checkpoint");
		await prepare(name);
		const session = await openSession(name);
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("a", 1)));
		});
		await session.checkpoint();
		expect(await rows(name, "journal:retirementControls")).toHaveLength(1);
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("b", 2)));
		});
		await session.abort();
		expect(await rows(name, "journal:retirementControls")).toEqual([control("a", 1)]);
	});

	it("serialises an ordinary writer after the session", async () => {
		const name = fresh("serial");
		await prepare(name);
		const session = await openSession(name);
		await session.run(async (tx) => {
			await request(tx.objectStore("journal:retirementControls").put(control("o", 1)));
		});
		const db = await request(indexedDB.open(name));
		const writer = db.transaction(["journal:retirementControls"], "readwrite", { durability: "strict" });
		writer.objectStore("journal:retirementControls").put(control("o", 9));
		let writerDone = false;
		const done = terminal(writer).then(() => {
			writerDone = true;
		});
		await later(100);
		expect(writerDone).toBe(false);
		await session.commit();
		await done;
		db.close();
		expect(await rows(name, "journal:retirementControls")).toEqual([control("o", 9)]);
	});

	it("refuses a room database that is not ready, and a non-strict transaction, with zero writes", async () => {
		const legacy = fresh("migrating");
		const v6 = await schemaModule.openPhase2dBrowserDatabase({ databaseName: legacy });
		v6.close();
		await prepare(legacy);
		await expect(openSession(legacy)).rejects.toThrow();
		await expect(openSession(fresh("missing"))).rejects.toThrow();

		const name = fresh("relaxed");
		await prepare(name);
		const original = IDBDatabase.prototype.transaction;
		IDBDatabase.prototype.transaction = function (
			this: IDBDatabase,
			stores: string | string[],
			mode?: IDBTransactionMode,
			options?: IDBTransactionOptions
		) {
			return original.call(this, stores, mode, mode === "readwrite" ? { ...options, durability: "relaxed" } : options);
		} as typeof original;
		try {
			const session = await openSession(name);
			await expect(
				session.run(async (tx) => {
					await request(tx.objectStore("journal:retirementControls").put(control("o", 1)));
				})
			).rejects.toThrow("RETENTION_DURABILITY");
			await session.abort().catch(() => undefined);
		} finally {
			IDBDatabase.prototype.transaction = original;
		}
		expect(await rows(name, "journal:retirementControls")).toEqual([]);
	});
});

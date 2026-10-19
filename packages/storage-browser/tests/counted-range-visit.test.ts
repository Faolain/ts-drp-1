import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { visitCountedRange } from "../src/internal/native-read-reservation.js";

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

async function seeded(rows: number): Promise<IDBDatabase> {
	const open = indexedDB.open(`counted-range-${crypto.randomUUID()}`, 1);
	open.onupgradeneeded = () => open.result.createObjectStore("rows", { keyPath: ["objectId", "sequence"] });
	const db = await requestResult(open);
	const write = db.transaction("rows", "readwrite");
	for (const objectId of ["a", "room", "room\0", "roomz"])
		for (let sequence = 0; sequence < rows; sequence++) write.objectStore("rows").put({ objectId, sequence });
	await new Promise<void>((resolve, reject) => {
		write.oncomplete = () => resolve();
		write.onabort = () => reject(write.error);
	});
	return db;
}

async function cursorWalk(db: IDBDatabase, range: IDBKeyRange): Promise<IDBValidKey[]> {
	const keys: IDBValidKey[] = [];
	const request = db.transaction("rows").objectStore("rows").openCursor(range);
	await new Promise<void>((resolve, reject) => {
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const cursor = request.result;
			if (cursor === null) return resolve();
			keys.push(cursor.primaryKey);
			cursor.continue();
		};
	});
	return keys;
}

describe("visitCountedRange", () => {
	it("visits exactly the cursor's rows in cursor order across page boundaries", async () => {
		const db = await seeded(70);
		try {
			for (const range of [
				IDBKeyRange.bound(["room"], ["room", []]),
				IDBKeyRange.bound(["room"], ["room\0"], false, true),
				IDBKeyRange.bound(["room", 0], ["room", 63]),
				IDBKeyRange.lowerBound(["room", 5]),
			]) {
				const expected = await cursorWalk(db, range);
				const visited: IDBValidKey[] = [];
				const count = await visitCountedRange(db.transaction("rows").objectStore("rows"), range, 1_000, (value, key) => {
					expect(key).toEqual([(value as { objectId: string }).objectId, (value as { sequence: number }).sequence]);
					visited.push(key);
				});
				expect(visited).toEqual(expected);
				expect(count).toBe(expected.length);
			}
		} finally {
			db.close();
		}
	});

	it("stops at the limit and before reading past a refusing row's page", async () => {
		const db = await seeded(70);
		try {
			const range = IDBKeyRange.bound(["room"], ["room", []]);
			const limited: IDBValidKey[] = [];
			expect(await visitCountedRange(db.transaction("rows").objectStore("rows"), range, 33, (_, key) => limited.push(key))).toBe(33);
			expect(limited).toEqual((await cursorWalk(db, range)).slice(0, 33));
			let seen = 0;
			await expect(
				visitCountedRange(db.transaction("rows").objectStore("rows"), range, 71, () => {
					if (++seen === 3) throw new Error("refused");
				})
			).rejects.toThrow("refused");
			expect(seen).toBe(3);
		} finally {
			db.close();
		}
	});
});

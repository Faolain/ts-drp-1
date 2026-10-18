import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { observed, openRoom, originalStorage, required, sessions } from "./fixtures/grid-room-workload.js";

beforeEach(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) },
	});
	observed.stores.clear();
	observed.planes.clear();
	observed.commits = [];
	observed.advances = [];
	observed.failSuffixFor = "";
	observed.faults = 0;
	observed.ambiguous = undefined;
	observed.failRecoveryReadFor = "";
	observed.issueAttempts = [];
	observed.commitHandles.clear();
	observed.issuePlans.clear();
	observed.timeline = [];
	observed.ambiguities = [];
	observed.publications = [];
	observed.planWrites = [];
	observed.prunes = [];
	observed.cleanup = [];
	observed.closeGraphs = [];
	observed.snapshots = [];
});
afterEach(async () => {
	await Promise.all([...sessions].map((room) => room.close()));
	sessions.clear();
	vi.restoreAllMocks();
	if (originalStorage === undefined) Reflect.deleteProperty(navigator, "storage");
	else Object.defineProperty(navigator, "storage", originalStorage);
});
function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = (): void => resolve(value.result);
		value.onerror = (): void => reject(value.error);
	});
}

it("real snapshot-delivery refusal cannot advance the recipient floor", async () => {
	const fixture = await openRoom(2);
	const creator = required(fixture.peers[0]),
		recipient = required(fixture.peers[1]);
	await fixture.issue(creator, "delivery-floor-creator");
	await fixture.issue(recipient, "delivery-floor-writer");
	await fixture.close();
	await creator.room.adoptCreatorSuccessor();
	const before = recipient.floor.read();
	expect(creator.floor.read().stable.epoch).toBe(1);
	expect(before.stable.epoch).toBe(0);
	const database = await request(indexedDB.open(creator.databaseName + "--drp-snapshot-quarantine-v1"));
	try {
		const tx = database.transaction("chunks", "readwrite", { durability: "strict" });
		const complete = new Promise<void>((resolve, reject) => {
			tx.oncomplete = (): void => resolve();
			tx.onabort = (): void => reject(tx.error);
		});
		const store = tx.objectStore("chunks"),
			keys = await request(store.getAllKeys());
		expect(keys.length, "SETUP_GENUINE_PRODUCER_HAS_CONTENT").toBeGreaterThan(0);
		store.delete(required(keys[0]));
		await complete;
	} finally {
		database.close();
	}
	await expect(fixture.reopen(recipient, 0, true)).rejects.toBeDefined();
	expect(recipient.floor.read()).toEqual(before);
	expect(creator.floor.read().stable.epoch).toBe(1);
});

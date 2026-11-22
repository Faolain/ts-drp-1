import "fake-indexeddb/auto";
import { parseStorageObjectId, type StorageObjectId } from "@ts-drp/storage";
import { describe, expect, it } from "vitest";

import { createBrowserRoomAheDurableStore } from "../src/internal/idb-adapter.js";
import { prepareBrowserRoomDatabase } from "../src/internal/schema-idb.js";

// Track 46 (docs/realtime-latency/tracks/46-network-stream-reuse): a browser creator's rollover
// failed with `creator recovery role transfer source failed ... SUBSTRATE_FAILURE` right after a
// received append gave up its replacement custody (`received-maintenance-custody`). Every AHE read
// on a room database joins whichever native read reservation is held there, held by anyone. When
// the holder releases it, a read waiting for its turn on that view, or one that starts while the
// release completes, fails as a substrate failure. Nothing failed in IndexedDB: the read should
// run on its own transaction once the view is gone. fake-indexeddb is mechanism evidence only.

let counter = 0;
const objectIdOf = (label: string): StorageObjectId => {
	const parsed = parseStorageObjectId(`${label}:${"b".repeat(32)}`);
	if (!parsed.ok) throw new Error("object id fixture is invalid");
	return parsed.value;
};
// The reservation holder's own object (a received append's room, say), not the reader's.
const HOLDER = `holder:${"a".repeat(32)}`;

async function openStore(label: string): Promise<Awaited<ReturnType<typeof createBrowserRoomAheDurableStore>>> {
	const databaseName = `held-view-release-${label}-${++counter}`;
	await prepareBrowserRoomDatabase({ databaseName });
	return createBrowserRoomAheDurableStore({ databaseName });
}

describe("a released native read reservation does not fail other readers", () => {
	it("a read queued on another holder's view completes after that holder releases it", async () => {
		const store = await openStore("queued");
		try {
			const objectId = objectIdOf("queued");
			const reservation = await store.acquireNativeReadReservation({ objectId: HOLDER });
			// Not on the view's native turn: the read queues for the next one. The holder releases first.
			const read = store.readRetirementControl!(objectId);
			const released = reservation.release();
			await expect(read).resolves.toEqual({ ok: true, value: null });
			await released;
		} finally {
			await store.close();
		}
	});

	it("a read that starts while the holder's release completes runs on its own transaction", async () => {
		const store = await openStore("releasing");
		try {
			const objectId = objectIdOf("releasing");
			const reservation = await store.acquireNativeReadReservation({ objectId: HOLDER });
			const released = reservation.release();
			// The view is released but its native transaction has not completed yet.
			const read = store.readRetirementControl!(objectId);
			await expect(read).resolves.toEqual({ ok: true, value: null });
			await released;
		} finally {
			await store.close();
		}
	});

	it("the holder's own reservation still refuses after release", async () => {
		const store = await openStore("holder");
		try {
			const reservation = await store.acquireNativeReadReservation({ objectId: HOLDER });
			await reservation.release();
			await expect(reservation.check()).rejects.toThrow("NATIVE_READ_RESERVATION_RELEASED");
		} finally {
			await store.close();
		}
	});
});

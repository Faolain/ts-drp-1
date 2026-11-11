// "database is locked" within one peer: the AHE store's main connection against its own native
// read reservation.
//
// Observed in the 4-writer scorecard (r2-w3-r2-behind16): a member install failed with "creator close
// active generation is unavailable: SUBSTRATE_FAILURE: database is locked". The two connections are
// both on the peer's AHE file, in one thread:
//   - the native read reservation (create-scaffold acquireNativeReadReservation ->
//     SqliteNativeReadReservationOwner) holds BEGIN IMMEDIATE on its own connection across awaits,
//     by design, and registers itself in native-writer-gate;
//   - the store's main connection begins BEGIN IMMEDIATE synchronously in recoverActiveGeneration
//     (creator-close inspectHead) and in every mutation, without consulting that gate.
// node:sqlite is synchronous, so the main connection's busy handler sleeps the only JS thread for
// busy_timeout (1000 ms). The holder can never release while the thread sleeps, so the wait always
// ends in SQLITE_BUSY. The issuance store and the read reservation already wait for in-process
// holders asynchronously (native-writer-gate); the AHE store's main connection must too.
import { parseStorageObjectId } from "@ts-drp/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createSqliteAheDurableStore } from "../packages/storage-node/src/index.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

it("[RED] recoverActiveGeneration waits for the file's in-process read reservation instead of failing busy", async () => {
	const directory = mkdtempSync(join(tmpdir(), "ahe-writer-wait-"));
	directories.push(directory);
	const filename = join(directory, "peer-1--ahe.sqlite");
	const store = createSqliteAheDurableStore({ filename, initialization: "create" });
	const parsed = parseStorageObjectId(`creator:${"ab".repeat(16)}`);
	if (!parsed.ok) throw new Error("invalid object id");
	const objectId = parsed.value;
	try {
		// Uncontended baseline: the store's own answer for this object (not a substrate failure).
		const baseline = await store.recoverActiveGeneration(objectId);
		expect(baseline.ok || baseline.reason !== "SUBSTRATE_FAILURE", JSON.stringify(baseline)).toBe(true);

		const reservation = await store.acquireNativeReadReservation({ objectId });
		// The holder needs the event loop to finish its work and release (as every real holder does).
		let released = false;
		const releasing = sleep(200).then(async () => {
			await reservation.release();
			released = true;
		});
		const started = performance.now();
		let timerLagMs = 0;
		const lagStart = performance.now();
		const lag = sleep(10).then(() => {
			timerLagMs = performance.now() - lagStart - 10;
		});
		const contended = await store.recoverActiveGeneration(objectId);
		const elapsed = performance.now() - started;
		await Promise.all([releasing, lag]);
		console.log(
			"AHE_WRITER_WAIT",
			JSON.stringify({ contended, elapsedMs: Math.round(elapsed), timerLagMs: Math.round(timerLagMs) })
		);
		expect(released, "the holder released").toBe(true);
		expect(contended, "the contended recovery answers as the uncontended one did").toEqual(baseline);
		expect(timerLagMs, "the wait does not freeze the event loop").toBeLessThan(150);
	} finally {
		await store.close();
	}
}, 60_000);

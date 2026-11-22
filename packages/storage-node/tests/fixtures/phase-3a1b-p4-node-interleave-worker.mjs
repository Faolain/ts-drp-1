/* eslint-disable @typescript-eslint/explicit-function-return-type -- isolated test worker. */
import { workerData } from "node:worker_threads";

const signal = new Int32Array(workerData.signal);

try {
	const candidate = await import(workerData.moduleUrl);
	const store = candidate.createNodeDurableLiveJournalStore({ primaryFilename: workerData.primaryFilename });
	try {
		const appended = await store.appendAccepted(workerData.appendInput);
		if (appended?.ok !== true || appended.idempotent !== false || appended.journalSequence !== 1) {
			throw new Error("distinct facade append did not commit the expected row");
		}
		const readiness = await store.readiness(workerData.readinessInput);
		if (readiness?.ok !== true || readiness.ready !== true || readiness.rowCount !== 2) {
			throw new Error("distinct facade readonly readback did not observe the committed closure");
		}
	} finally {
		await store.close();
	}
	Atomics.store(signal, 0, 1);
} catch {
	Atomics.store(signal, 0, -1);
} finally {
	Atomics.notify(signal, 0);
}

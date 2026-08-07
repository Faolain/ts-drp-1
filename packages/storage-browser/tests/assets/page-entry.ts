import type { KillPoint } from "../../src/killpoints.js";
import { FIXTURE_OBJECT_ID } from "../fixtures/fixture-records.js";
import { parseWorkerToPageMessage, type WorkerToPageMessage } from "../fixtures/worker-protocol.js";

declare global {
	interface Window {
		phase2bRun(armed: KillPoint | null): Promise<WorkerToPageMessage>;
	}
}

window.phase2bRun = (armed: KillPoint | null): Promise<WorkerToPageMessage> =>
	new Promise((resolve, reject) => {
		const worker = new Worker("./worker-entry.js", { type: "module" });
		const signal = new SharedArrayBuffer(4);
		worker.onerror = (): void => reject(new TypeError("Phase 2b Worker failed to load"));
		worker.onmessage = (event: MessageEvent<unknown>): void => {
			const message = parseWorkerToPageMessage(event.data);
			if (message === undefined) {
				worker.terminate();
				reject(new TypeError("Worker emitted a message outside the closed protocol"));
				return;
			}
			if (message.kind === "ready") {
				worker.postMessage({
					kind: "run",
					version: 1,
					databaseName: "phase-2b-playwright-red",
					objectId: FIXTURE_OBJECT_ID,
					armed,
					signal,
				});
				return;
			}
			worker.terminate();
			resolve(message);
		};
	});

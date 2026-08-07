import { runInstrumentedTransition } from "../../src/internal/instrumented-idb.js";
import { boundedDetail, parseWorkerRunMessage, type WorkerToPageMessage } from "../fixtures/worker-protocol.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerToPageMessage): void {
	workerScope.postMessage(message);
}

workerScope.onmessage = (event: MessageEvent<unknown>): void => {
	const input = parseWorkerRunMessage(event.data);
	if (input === undefined) {
		post({ kind: "failure", version: 1, code: "INVALID_RUN_MESSAGE", detail: "invalid closed run message" });
		return;
	}
	void runInstrumentedTransition({ ...input, onHit: (hit): void => post({ kind: "hit", version: 1, ...hit }) }).then(
		(result) => {
			if (result.kind === "failure") {
				post({
					kind: "failure",
					version: 1,
					code: result.code,
					detail: boundedDetail(result.detail) ?? "invalid boundary failure detail",
				});
				return;
			}
			post({
				kind: "complete",
				version: 1,
				observed: result.observed,
				transactionDurability: result.transactionDurability,
			});
		}
	);
};

post({ kind: "ready", version: 1 });

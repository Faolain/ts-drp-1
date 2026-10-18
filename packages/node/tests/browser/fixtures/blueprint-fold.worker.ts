import { runBlueprintFoldWorkload } from "./blueprint-fold-workload.js";
import { serveWorkerTasks, type WorkerHostScope } from "../../../../worker-host/src/worker.js";

serveWorkerTasks(globalThis as unknown as WorkerHostScope, {
	"blueprint-fold-4096": async (_payload, context) => {
		const summary = await runBlueprintFoldWorkload();
		context.emit(new TextEncoder().encode(JSON.stringify({ ...summary, workerScope: globalThis.constructor.name })));
	},
});

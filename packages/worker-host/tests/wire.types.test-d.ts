import {
	createWorkerHost,
	type WorkerHost,
	type WorkerHostEndpoint,
	type WorkerHostOptions,
	type WorkerHostState,
	type WorkerWireErrorCode,
} from "@ts-drp/worker-host/host"; // eslint-disable-line import/no-unresolved -- deliberate RED until ./host exists
import {
	serveWorkerTasks,
	type WorkerHostScope,
	type WorkerTaskContext,
	type WorkerTaskHandler,
} from "@ts-drp/worker-host/worker"; // eslint-disable-line import/no-unresolved -- deliberate RED until ./worker exists

declare const endpoint: WorkerHostEndpoint;
declare const scope: WorkerHostScope;
const options: WorkerHostOptions = { endpoint, maxInFlightRequests: 1 };
const host: WorkerHost = createWorkerHost(options);
const state: WorkerHostState = host.state;
const stream: AsyncGenerator<Uint8Array, void, void> = host.submit("echo", new Uint8Array());
const handler: WorkerTaskHandler = (payload: Uint8Array, context: WorkerTaskContext) => {
	context.emit(payload);
	void context.signal;
};
serveWorkerTasks(scope, { echo: handler });
const wireCode: WorkerWireErrorCode = "worker-task-failed";
void [state, stream, wireCode];

import { PHASE_2E6_DECLARED_EDGES } from "../fixtures/phase-2e6-real-process-death-contract.js";

interface WorkerObservation {
	readonly crossOriginIsolated?: boolean;
	readonly detail?: string;
	readonly edgeId?: string;
	readonly instrumented?: boolean;
	readonly kind: string;
	readonly ok?: boolean;
	readonly trace?: readonly unknown[];
	readonly version: number;
}

declare global {
	interface Window {
		phase2e6Relay?(observation: WorkerObservation, cellValue: number): Promise<void>;
		phase2e6RunOne(edge: (typeof PHASE_2E6_DECLARED_EDGES)[number], databaseName: string): Promise<WorkerObservation>;
	}
}

function observeWorker(
	edge: (typeof PHASE_2E6_DECLARED_EDGES)[number],
	databaseName = `phase-2e6-red-${crypto.randomUUID()}`
): Promise<WorkerObservation> {
	return new Promise((resolve, reject) => {
		const worker = new Worker("/phase-2e6-real-process-death-worker.js", { type: "module" });
		const signal = new SharedArrayBuffer(4);
		const cell = new Int32Array(signal);
		const timer = setTimeout(() => {
			worker.terminate();
			reject(new Error(`arm timeout: ${edge.id}`));
		}, 10_000);
		let ready = false;
		worker.addEventListener("message", (event: MessageEvent<unknown>) => {
			if (typeof event.data !== "object" || event.data === null) {
				clearTimeout(timer);
				worker.terminate();
				reject(new Error("Worker emitted a non-object"));
				return;
			}
			const message = event.data as WorkerObservation;
			if (message.kind === "ready") {
				if (ready) {
					clearTimeout(timer);
					worker.terminate();
					reject(new Error("Worker emitted duplicate ready"));
					return;
				}
				ready = true;
				worker.postMessage({
					databaseName,
					edge,
					kind: "run",
					signal,
					version: 1,
				});
				return;
			}
			if (message.kind === "armed" && window.phase2e6Relay !== undefined) {
				void window.phase2e6Relay(message, Atomics.load(cell, 0));
				return;
			}
			clearTimeout(timer);
			worker.terminate();
			resolve(message);
		});
		worker.addEventListener("error", (error) => {
			clearTimeout(timer);
			worker.terminate();
			reject(error);
		});
	});
}

window.phase2e6RunOne = (edge, databaseName): Promise<WorkerObservation> => observeWorker(edge, databaseName);

async function runPhase2e6RedProbe(): Promise<readonly WorkerObservation[]> {
	if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
		throw new TypeError("Phase 2e6 requires COOP/COEP and SharedArrayBuffer");
	}
	const observations: WorkerObservation[] = [];
	for (const edge of PHASE_2E6_DECLARED_EDGES) observations.push(await observeWorker(edge));
	return Object.freeze(observations);
}

Reflect.set(globalThis, "phase2e6RealProcessDeathHarness", Object.freeze({ runPhase2e6RedProbe }));

import { openContender, release } from "./phase-6a-creator-successor-activation-entry.js";

type LockMode = "missing" | "native" | "rejecting";

interface WorkerRequest {
	readonly databaseName?: string;
	readonly id: string;
	readonly kind: "open" | "release";
	readonly lockMode?: LockMode;
	readonly material?: unknown;
}

let acquisitionCount = 0;
let callbackCount = 0;
let releaseCount = 0;

function counters(): Readonly<Record<string, number>> {
	return Object.freeze({ acquisitionCount, callbackCount, releaseCount });
}

function installObservedLocks(mode: LockMode): void {
	const native = navigator.locks;
	if (mode === "missing") {
		Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
		return;
	}
	if (mode === "rejecting") {
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: Object.freeze({ request: () => Promise.reject(new Error("D108E2A_WORKER_LOCK_REJECTED")) }),
		});
		return;
	}
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: Object.freeze({
			request: (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>) => {
				acquisitionCount += 1;
				return native
					.request(name, options, async (lock) => {
						callbackCount += 1;
						await callback(lock);
					})
					.finally(() => {
						releaseCount += 1;
					});
			},
		}),
	});
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
	void (async (): Promise<void> => {
		const request = event.data;
		try {
			if (request.kind === "release") {
				const released = await release();
				self.postMessage({ counters: counters(), id: request.id, kind: "result", released });
				return;
			}
			if (request.databaseName === undefined || request.material === undefined || request.lockMode === undefined) {
				throw new TypeError("D.108e2a worker request is incomplete");
			}
			installObservedLocks(request.lockMode);
			const result = await openContender(request.databaseName, request.material);
			self.postMessage({ counters: counters(), id: request.id, kind: "result", result });
		} catch (error) {
			self.postMessage({
				detail: error instanceof Error ? error.message : String(error),
				id: request.id,
				kind: "worker-error",
			});
		}
	})();
});

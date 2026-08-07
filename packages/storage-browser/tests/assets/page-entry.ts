import type { KillHit, KillPoint } from "../../src/killpoints.js";
import { FIXTURE_OBJECT_ID } from "../fixtures/fixture-records.js";
import { parseWorkerToPageMessage, type WorkerToPageMessage } from "../fixtures/worker-protocol.js";

export interface PageRunResult {
	readonly complete: Extract<WorkerToPageMessage, { readonly kind: "complete" }>;
	readonly crossOriginIsolated: true;
	readonly finalCellValue: number;
	readonly hits: readonly KillHit[];
	readonly notifyWoken: 0 | 1;
	readonly preResumeHits: readonly KillHit[];
}

declare global {
	interface Window {
		phase2bRelay?(message: unknown, cellValue: number): Promise<void>;
		phase2bRun(
			databaseName: string,
			armed: KillPoint | null,
			role: "tuple" | "discovery" | "arming"
		): Promise<PageRunResult>;
	}
}

function notifyRegisteredWaiter(cell: Int32Array): Promise<1> {
	const deadline = performance.now() + 2_000;
	return new Promise((resolve, reject) => {
		const attempt = (): void => {
			const woken = Atomics.notify(cell, 0, 1);
			if (woken === 1) {
				resolve(1);
				return;
			}
			if (woken !== 0 || performance.now() >= deadline) {
				reject(new TypeError("arming control did not observe a registered waiter before its deadline"));
				return;
			}
			setTimeout(attempt, 0);
		};
		attempt();
	});
}

window.phase2bRun = (databaseName, armed, role): Promise<PageRunResult> =>
	new Promise((resolve, reject) => {
		if (
			globalThis.crossOriginIsolated !== true ||
			typeof SharedArrayBuffer === "undefined" ||
			typeof Worker === "undefined"
		) {
			reject(new TypeError("cross-origin isolated SharedArrayBuffer Worker capability is required"));
			return;
		}
		const worker = new Worker("./worker-entry.js", { type: "module" });
		const signal = new SharedArrayBuffer(4);
		const cell = new Int32Array(signal);
		const hits: KillHit[] = [];
		let preResumeHits: readonly KillHit[] = Object.freeze([]);
		let notifyWoken: 0 | 1 = 0;
		let started = false;
		worker.onerror = (): void => reject(new TypeError("Phase 2b Worker failed to load"));
		worker.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
			const message = parseWorkerToPageMessage(event.data);
			if (message === undefined) {
				worker.terminate();
				reject(new TypeError("Worker emitted a message outside the closed protocol"));
				return;
			}
			if (message.kind === "ready") {
				if (started) {
					worker.terminate();
					reject(new TypeError("Worker emitted duplicate ready"));
					return;
				}
				started = true;
				worker.postMessage({ kind: "run", version: 1, databaseName, objectId: FIXTURE_OBJECT_ID, armed, signal });
				return;
			}
			if (message.kind === "hit") {
				hits.push(
					Object.freeze({
						id: message.id,
						edge: message.edge,
						transactionDurability: message.transactionDurability,
					})
				);
				const value = Atomics.load(cell, 0);
				if (window.phase2bRelay !== undefined) await window.phase2bRelay(message, value);
				if (armed?.id === message.id && armed.edge === message.edge) {
					if (value !== 1) {
						worker.terminate();
						reject(new TypeError("armed hit was not observed with page-owned cell at one"));
						return;
					}
					preResumeHits = Object.freeze([...hits]);
					if (role === "arming") {
						try {
							notifyWoken = await notifyRegisteredWaiter(cell);
						} catch (error) {
							worker.terminate();
							reject(error);
						}
					}
				}
				return;
			}
			if (message.kind === "failure") {
				worker.terminate();
				reject(new TypeError(`${message.code}: ${message.detail}`));
				return;
			}
			worker.terminate();
			resolve(
				Object.freeze({
					complete: message,
					crossOriginIsolated: true,
					finalCellValue: Atomics.load(cell, 0),
					hits: Object.freeze([...hits]),
					notifyWoken,
					preResumeHits,
				})
			);
		};
	});

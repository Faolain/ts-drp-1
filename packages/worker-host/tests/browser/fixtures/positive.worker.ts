import "./delay-evaluation.js";
// Deliberately unresolved until the production ./worker subpath exists at GREEN.
// eslint-disable-next-line import/no-unresolved
import { serveWorkerTasks, type WorkerHostScope } from "@ts-drp/worker-host/worker";

let readySentAtMs = Number.NaN;
const instrumentedScope = {
	addEventListener: self.addEventListener.bind(self),
	postMessage(message: unknown, transfer?: readonly Transferable[]): void {
		if ((message as { kind?: unknown }).kind === "ready") readySentAtMs = performance.now();
		self.postMessage(message, { transfer: [...(transfer ?? [])] });
	},
	removeEventListener: self.removeEventListener.bind(self),
} as WorkerHostScope;

serveWorkerTasks(instrumentedScope, {
	probe(_payload: Uint8Array, context: Readonly<{ emit(payload: Uint8Array): void; signal: AbortSignal }>) {
		const requestReceivedAtMs = performance.now();
		context.emit(
			new TextEncoder().encode(
				JSON.stringify({
					marker: "handshake-ok",
					readySentAtMs,
					requestReceivedAtMs,
				})
			)
		);
	},
});

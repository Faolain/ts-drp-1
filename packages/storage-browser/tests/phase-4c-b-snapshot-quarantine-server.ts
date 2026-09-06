import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

export interface Phase4cBServer {
	readonly origin: string;
	close(): Promise<void>;
}

/**
 * Starts the isolated Phase 4c-b browser asset server.
 * @returns Bound server handle.
 */
export async function startPhase4cBServer(): Promise<Phase4cBServer> {
	const directory = dirname(fileURLToPath(import.meta.url));
	return startPhase4cBrowserServer({
		entryPoint: resolve(directory, "assets/phase-4c-b-snapshot-quarantine-entry.ts"),
		workerPoint: resolve(directory, "assets/phase-4c-b-snapshot-quarantine-worker.ts"),
	});
}

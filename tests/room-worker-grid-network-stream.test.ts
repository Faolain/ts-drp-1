import { describe, expect, it } from "vitest";

import { ZONE_WORKER_CONTRACT, zoneWorkerNetwork } from "../examples/grid/src/zone-worker-contract.js";

/**
 * The Grid worker's network stream is the page's network panel, sent when it changes. The session
 * diagnostics (the modular session's snapshot, whose control-plane event log grows for the session's
 * life) are a call the page makes on demand, as the main-thread page reads them: streamed, every
 * change re-sent the whole log to the main thread, and its deserialization was the bridge's main
 * main-thread cost (ab3: library p99 2.3-3.2 ms per frame, 88% of heavy frames).
 */
describe("Grid room worker: the network stream carries the panel only", () => {
	it("builds the stream value from the panel and dialability, with no session diagnostics", () => {
		const value = zoneWorkerNetwork({ peerId: "p", peers: ["a"], topics: ["t"] }, true);
		expect(value).toEqual({ peerId: "p", peers: ["a"], topics: ["t"], dialable: true });
	});

	it("reads the session diagnostics through a call", () => {
		expect(ZONE_WORKER_CONTRACT.commands.session?.kind).toBe("call");
	});
});

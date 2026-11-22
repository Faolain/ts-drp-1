import { queryObjects, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { createEphemeralChannel, type EphemeralTransportPort } from "../src/index.js";

// A channel lives for a whole session and publishes at frame rate. Waiting on
// its "closed" promise inside every send must not leave anything behind on
// that long-pending promise: a Promise.race against it attaches a reaction
// (and retains the race's own promise and closures) that only close() could
// release. Live Promise objects are a load-independent census of that.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

async function livePromises(): Promise<number> {
	for (let round = 0; round < 4; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
	return queryObjects(Promise, { format: "count" }) as number;
}

function immediatePort(): EphemeralTransportPort {
	return {
		localPeerId: "local",
		authorizedPeers: () => ["remote"],
		isAuthorized: () => true,
		maxEnvelopeBytes: () => 1024,
		onMessage: () => () => undefined,
		send: () => Promise.resolve(true),
	};
}

describe("ephemeral channel close-race retention", () => {
	it("retains nothing per published frame on the long-pending close promise", async () => {
		const channel = createEphemeralChannel(immediatePort(), {
			maxMessageBytes: 256,
			maxSequencedKeys: 16,
			maxSequencedSenders: 8,
		});
		const payload = new Uint8Array(8);
		const publish = async (frames: number): Promise<void> => {
			for (let index = 0; index < frames; index++)
				expect(await channel.publish({ class: "unreliable-unordered", key: null, payload })).toBe(true);
		};
		try {
			await publish(256); // warm every lazily created owner
			const before = await livePromises();
			await publish(4096);
			const after = await livePromises();
			// Bounded by a small constant, never by frames published (4096).
			expect(after - before, `live promises ${before} -> ${after}`).toBeLessThan(64);
		} finally {
			channel.close();
		}
	});
});

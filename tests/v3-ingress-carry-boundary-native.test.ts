// The carried-ingress entry (a same-epoch recovery re-offering its predecessor's pending rows) is not
// reachable from network input: the gossip path still refuses a message without native provenance
// (a synthesized copy), and the re-offer takes only a copy carryV3PendingIngress minted in-process.
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { reofferV3CarriedPendingIngress, type V3PlaneHandle } from "../packages/node/src/v3-live.js";

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

it("a forged or foreign carry copy re-offers nothing", () => {
	expect(reofferV3CarriedPendingIngress({} as V3PlaneHandle, Object.freeze({ rows: 1 }))).toBe(0);
});

it("the gossip path refuses a message without native provenance, and admits the same row with it", async () => {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	await writer.room.issue({ action: "placeBlock", id: "writer-0", kind: "stone", x: 1, y: 0 });
	const rows = await fixture.publishedAfter(1, null);
	const move = required(rows.filter((row) => !isControl(row)).at(-1));
	const digest = Buffer.from(move.commit.envelope.digest).toString("hex");
	const native = Reflect.get(creator.networkNode, "gossipTopicFor") as (message: unknown) => string | undefined;
	// A synthesized copy carries no native identity: the network node names no gossip topic for it.
	Reflect.set(creator.networkNode, "gossipTopicFor", () => undefined);
	creator.inject(rows, 1);
	await sleep(1_500);
	expect(creator.accepted.has(digest), "a copy without native provenance is refused").toBe(false);
	Reflect.set(creator.networkNode, "gossipTopicFor", native);
	await creator.receive(rows, 1);
	expect(creator.accepted.has(digest), "the same row with native provenance is admitted").toBe(true);
}, 120_000);

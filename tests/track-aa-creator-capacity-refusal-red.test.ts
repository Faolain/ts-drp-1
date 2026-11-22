import { encodeCanonical } from "@ts-drp/canonical";
import { MessageType } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	creatorDeliveryRoom,
	envelopeMessage,
	gossipQueueCharge,
	type Profile,
	ROOM_PARAMETERS,
} from "./fixtures/track-aa/creator-delivery-room.js";
import { admitted, ingressWarnings, openAll, place, placedRows } from "./fixtures/track-aa/scenario.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";

// The plane's ingress warnings (v3-live.ts `ingressFailureLog`) go to the console captured at
// module load. vi.hoisted runs before every import, so the recorder sees them.
const warnings = vi.hoisted(() => {
	const recorded: unknown[][] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]): void => {
		recorded.push(args);
		if (process.env.TRACK_AA_ECHO_WARN === "1") original(...args);
	};
	return recorded;
});

// Track AA RED (decision row 73): a first copy of a Writer's row that the creator refuses at
// one of its capacity bounds is never asked for again.
//
// The creator's live plane has two bounded admission owners in front of its FIFO
// (packages/node/src/v3-live.ts):
// - the gossip queue in `routeV3Ingress`: at most 32 queued gossip jobs
//   (MAX_ADMITTED_INPUT_JOBS) and `maxPendingBytes` of queue charge (2 x payload + metadata);
// - the input pool in `enqueueRegistrationTask` (via `enqueueV3Ingress`): at most 32 jobs
//   and `maxPendingBytes` of captured input bytes.
// A refusal at either logs `admission-rejected` and returns. It records nothing about the
// sender. On the creator, the room transport's missing-dependency request is a no-op
// (room-network.ts `#requestMissing`), and the Writer's own retained republication runs only
// on its open-time schedule (0-15 s after open). Once that schedule has run out, a refused
// first copy is lost for good: the creator stays deaf to it on a stable connection.
//
// Every test below lets every open-time schedule run out (SETTLE_MS), holds the creator's
// admission (its accepted-vertex callback, awaited in the plane FIFO: a slow creator), drives
// one refusal point, releases the creator and asserts that it admits every Writer row within
// DELIVERY_MS. The transport, the bounds and admission are the production owners.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const PROFILES: readonly Profile[] = (process.env.TRACK_AA_PROFILES?.split(",") as Profile[] | undefined) ?? [
	"shipped",
	"settlement",
];
const TEST_TIMEOUT = 180_000;
// A residual credit smaller than any genuine Grid row, so the next row is refused for bytes.
const RESIDUAL_BYTES = 100;

describe.each(PROFILES)("Track AA RED, %s profile: a first copy refused at a creator capacity bound", (profile) => {
	it(
		"gossip queue, entries: the Writer rows refused once 32 gossip jobs are queued reach the creator",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const [creator, writer] = await openAll(fixture);
			fixture.creatorGate.hold();
			const mark = warnings.length;
			const ids = await place(required(writer), "gossip-entries", 40);
			await fixture.network.idle();
			const refusals = ingressWarnings(warnings, mark)["admission-rejected"] ?? 0;
			expect(refusals, "precondition: the creator's gossip queue refused first copies").toBeGreaterThan(0);
			fixture.creatorGate.release();
			const rows = placedRows(fixture, required(writer), ids);
			const result = await admitted(
				required(creator),
				rows.map((row) => row.digest)
			);
			expect(result, `TRACK_AA_RED gossip-entries: creator admitted ${result.count} of ${result.of}`).toMatchObject({
				complete: true,
			});
		},
		TEST_TIMEOUT
	);

	it(
		"gossip queue, bytes: Writer rows refused for queue bytes held by junk reach the creator",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const [creator, writer] = await openAll(fixture);
			const hostile = fixture.bare("track-aa-hostile");
			fixture.creatorGate.hold();
			const entered = fixture.creatorGate.entered;
			// The Writer's first row enters the creator's FIFO and holds it (and its queue charge).
			const first = await place(required(writer), "gossip-bytes-first", 1);
			await fixture.network.idle();
			await fixture.creatorGate.whenEntered(entered + 1);
			const [firstRow] = placedRows(fixture, required(writer), first);
			const topic = required(firstRow).message.objectId;
			// Queued junk (it fails authentication later) takes the queue's byte credit, leaving
			// less than one genuine row; fewer than 32 jobs, so the byte bound refuses.
			let remaining = ROOM_PARAMETERS.maxPendingBytes - gossipQueueCharge(required(firstRow).message);
			const meta = encodeCanonical({
				sender: hostile.peerId,
				objectId: topic,
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			}).byteLength;
			let junkJobs = 0;
			while (remaining > RESIDUAL_BYTES) {
				const charge = Math.min(2_000_000 + meta, remaining - RESIDUAL_BYTES);
				const length = Math.floor((charge - meta) / 2);
				if (length <= 0) break;
				await hostile.publishMessage(topic, envelopeMessage(topic, new Uint8Array(length), hostile.peerId));
				remaining -= length * 2 + meta;
				junkJobs++;
			}
			expect(junkJobs + 1, "precondition: the gossip queue is below its job bound").toBeLessThan(32);
			await fixture.network.idle();
			const mark = warnings.length;
			const refused = await place(required(writer), "gossip-bytes-refused", 3, 1);
			await fixture.network.idle();
			expect(ingressWarnings(warnings, mark)["admission-rejected"] ?? 0, "precondition: byte refusals").toBe(3);
			fixture.creatorGate.release();
			const rows = placedRows(fixture, required(writer), [...first, ...refused]);
			const result = await admitted(
				required(creator),
				rows.map((row) => row.digest)
			);
			expect(result, `TRACK_AA_RED gossip-bytes: creator admitted ${result.count} of ${result.of}`).toMatchObject({
				complete: true,
			});
		},
		TEST_TIMEOUT
	);

	it(
		"input pool, entries: direct Writer rows refused once 32 input jobs are queued reach the creator",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const [creator, writer] = await openAll(fixture);
			const creatorPeer = required(creator).peerId;
			const writerPeer = required(writer).peerId;
			// The Writer's gossip to the creator is lost; its retained republication (a direct
			// stream, the input pool) is the creator's only copy.
			fixture.network.lose(({ kind, from, to }) => kind === "gossip" && from === writerPeer && to === creatorPeer);
			const ids = await place(required(writer), "input-entries", 40);
			await fixture.network.idle();
			const rows = placedRows(fixture, required(writer), ids);
			fixture.creatorGate.hold();
			const mark = warnings.length;
			const writerNode = required(fixture.nodes.get(writerPeer));
			for (const row of rows) await writerNode.sendMessage(creatorPeer, row.message);
			await fixture.network.idle();
			expect(ingressWarnings(warnings, mark)["admission-rejected"] ?? 0, "precondition: input pool refusals").toBe(8);
			fixture.creatorGate.release();
			const result = await admitted(
				required(creator),
				rows.map((row) => row.digest)
			);
			expect(result, `TRACK_AA_RED input-entries: creator admitted ${result.count} of ${result.of}`).toMatchObject({
				complete: true,
			});
		},
		TEST_TIMEOUT
	);

	it(
		"input pool, bytes: direct Writer rows refused for input bytes held by junk reach the creator",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const [creator, writer] = await openAll(fixture);
			const creatorPeer = required(creator).peerId;
			const writerPeer = required(writer).peerId;
			const hostile = fixture.bare("track-aa-hostile");
			fixture.network.lose(({ kind, from, to }) => kind === "gossip" && from === writerPeer && to === creatorPeer);
			const ids = await place(required(writer), "input-bytes", 4);
			await fixture.network.idle();
			const rows = placedRows(fixture, required(writer), ids);
			const writerNode = required(fixture.nodes.get(writerPeer));
			fixture.creatorGate.hold();
			const entered = fixture.creatorGate.entered;
			await writerNode.sendMessage(creatorPeer, required(rows[0]).message);
			await fixture.network.idle();
			await fixture.creatorGate.whenEntered(entered + 1);
			const topic = required(rows[0]).message.objectId;
			// Junk direct input (captured and charged before the FIFO) takes the byte credit.
			let remaining = ROOM_PARAMETERS.maxPendingBytes - required(rows[0]).message.data.byteLength;
			let junkJobs = 0;
			while (remaining > RESIDUAL_BYTES) {
				const length = Math.min(1_000_000, remaining - RESIDUAL_BYTES);
				await hostile.sendMessage(creatorPeer, envelopeMessage(topic, new Uint8Array(length), hostile.peerId));
				remaining -= length;
				junkJobs++;
			}
			expect(junkJobs + 1, "precondition: the input pool is below its job bound").toBeLessThan(32);
			await fixture.network.idle();
			const mark = warnings.length;
			for (const row of rows.slice(1)) await writerNode.sendMessage(creatorPeer, row.message);
			await fixture.network.idle();
			expect(ingressWarnings(warnings, mark)["admission-rejected"] ?? 0, "precondition: byte refusals").toBe(3);
			fixture.creatorGate.release();
			const result = await admitted(
				required(creator),
				rows.map((row) => row.digest)
			);
			expect(result, `TRACK_AA_RED input-bytes: creator admitted ${result.count} of ${result.of}`).toMatchObject({
				complete: true,
			});
		},
		TEST_TIMEOUT
	);

	it(
		"a lost final row: the one refused last row, with no later traffic, reaches the creator",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile });
			const [creator, writer] = await openAll(fixture);
			fixture.creatorGate.hold();
			const mark = warnings.length;
			// One row enters the FIFO, 31 queue: the 33rd (the last) is refused.
			const ids = await place(required(writer), "final-row", 33);
			await fixture.network.idle();
			expect(ingressWarnings(warnings, mark)["admission-rejected"] ?? 0, "precondition: one refusal").toBe(1);
			fixture.creatorGate.release();
			const rows = placedRows(fixture, required(writer), ids);
			const result = await admitted(
				required(creator),
				rows.map((row) => row.digest)
			);
			expect(result, `TRACK_AA_RED final-row: creator admitted ${result.count} of ${result.of}`).toMatchObject({
				complete: true,
			});
		},
		TEST_TIMEOUT
	);
});

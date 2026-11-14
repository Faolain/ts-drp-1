import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { readV3RoomSettlementBatchCounts } from "../packages/node/src/v3-room.js";

// Measurement (batch fix 1157c16b): what the room's application state check costs a settlement drain
// chunk issued as one batch (row 93) when the room is at its 32 KiB limit (rows 96/97).
//
// A chunk of several replacement rows is judged by one exact refold of the admitted epoch graph with the
// whole chain inserted (applicationStateAdmitsChain), reported per chunk as an
// "application-state-bound-chain" proof event. The creator first fills the Grid zone's state until a
// new block is refused at the limit. Then, each epoch, the Writer re-places LOST_PER_EPOCH existing
// blocks (no state growth) whose rows never reach the creator: at the Writer's next install they are
// displaced and its drain replays them as one batched chunk.
//
// Reported (BATCH_REFOLD line): per-chunk refold p50/p95/max, per-install totals, the state size,
// and the chunks over 5 ms (the coordinator's flag, 2026-11-14). Only the room's behaviour is
// asserted (every epoch installs, the chunks were batched and judged); the cost is reported, not gated.

afterEach(async () => {
	Reflect.deleteProperty(globalThis, "__warmProofEvent");
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const ID_BYTES = Number(process.env.BATCH_REFOLD_ID_BYTES ?? 200);
const LOST_PER_EPOCH = Number(process.env.BATCH_REFOLD_LOST_PER_EPOCH ?? 4);
const MEASURE_EPOCHS = Number(process.env.BATCH_REFOLD_MEASURE_EPOCHS ?? 12);
const FILL_PER_EPOCH = 16;
const LIMIT_ERROR = /application state limit/u;
const FLAG_US = 5000;

type ChainEvent = { kind: string; rows: number; admitted: boolean; durationUs: number; stateBytes?: number; receiver?: string };

const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const block = (ordinal: number, kind = "stone") => ({
	action: "placeBlock",
	id: `${String(ordinal).padStart(5, "0")}-${"b".repeat(ID_BYTES)}`,
	kind,
	x: ordinal % 16,
	y: Math.floor(ordinal / 16) % 16,
});

function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((left, right) => left - right);
	return required(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]);
}

it("a batched drain chunk at the 32 KiB state limit: chain refold cost per chunk and per install", async () => {
	const fixture = await readinessHoldRoom({ writers: 1 });
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	const writerAuthor = required(fixture.identities[1]).author;
	const events: ChainEvent[] = [];
	Reflect.set(globalThis, "__warmProofEvent", (event: ChainEvent) => {
		if (event.kind === "application-state-bound-chain" && event.receiver === writerAuthor) events.push({ ...event });
	});
	let delivered: number | null = null;
	const deliver = async (): Promise<void> => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(1, delivered);
		for (let start = 0; start < rows.length; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0) await creator.receive(chunk.slice(0, last + 1), 1);
			creator.inject(chunk.slice(last + 1), 1);
		}
		if (rows.length !== 0) delivered = required(rows.at(-1)).commit.authorSequence;
	};
	/** Every row the Writer published so far never reaches the creator. */
	const lose = async (): Promise<number> => {
		const lost = await fixture.publishedAfter(1, delivered);
		if (lost.length !== 0) delivered = required(lost.at(-1)).commit.authorSequence;
		return lost.filter((row) => !isControl(row)).length;
	};
	const rollover = async (epoch: number): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};

	// Fill: the creator places new blocks until one is refused at the room's state limit.
	let epoch = 0;
	let placed = 0;
	let refusal: string | undefined;
	while (refusal === undefined && epoch < 64) {
		for (let index = 0; index < FILL_PER_EPOCH && refusal === undefined; index++) {
			try {
				await creator.room.issue(block(placed));
				placed++;
			} catch (error) {
				refusal = explain(error);
			}
		}
		epoch++;
		await rollover(epoch);
		await deliver(); // the Writer's fence reaches the creator
	}
	expect(refusal, "the fill reaches the room's state limit").toMatch(LIMIT_ERROR);
	expect(placed).toBeGreaterThanOrEqual(LOST_PER_EPOCH);
	const filledAt = epoch;
	const before = readV3RoomSettlementBatchCounts();

	// Measure: each epoch the Writer's re-placements are lost and replayed as one batched chunk at its install.
	const perInstall: { epoch: number; chunks: number; totalUs: number; maxUs: number; stateBytes?: number }[] = [];
	for (let round = 0; round < MEASURE_EPOCHS; round++) {
		for (let index = 0; index < LOST_PER_EPOCH; index++)
			await writer.room.issue(block((round * LOST_PER_EPOCH + index) % placed, round % 2 === 0 ? "gold" : "stone"));
		expect(await lose()).toBe(LOST_PER_EPOCH);
		const from = events.length;
		epoch++;
		await rollover(epoch); // the drain replays the lost re-placements
		await deliver(); // the fence and the replacements reach the creator
		const chunk = events.slice(from);
		const stateBytes = chunk.at(-1)?.stateBytes;
		perInstall.push({
			epoch,
			chunks: chunk.length,
			totalUs: chunk.reduce((sum, event) => sum + event.durationUs, 0),
			maxUs: Math.max(0, ...chunk.map((event) => event.durationUs)),
			...(stateBytes === undefined ? {} : { stateBytes }),
		});
	}
	const after = readV3RoomSettlementBatchCounts();
	const durations = events.map((event) => event.durationUs);
	const totals = perInstall.map((install) => install.totalUs);
	const summary = {
		idBytes: ID_BYTES,
		lostPerEpoch: LOST_PER_EPOCH,
		filledAt,
		placed,
		chunks: events.length,
		rows: events.reduce((sum, event) => sum + event.rows, 0),
		refused: events.filter((event) => !event.admitted).length,
		stateBytes: { min: Math.min(...events.map((event) => event.stateBytes ?? Infinity)), max: Math.max(0, ...events.map((event) => event.stateBytes ?? 0)) },
		chunkUs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: Math.max(0, ...durations) },
		installUs: { p50: percentile(totals, 0.5), p95: percentile(totals, 0.95), max: Math.max(0, ...totals) },
		over5ms: durations.filter((value) => value > FLAG_US).length,
		batches: after.batches - before.batches,
		rowsBatched: after.rowsBatched - before.rowsBatched,
		rowsSingly: after.rowsSingly - before.rowsSingly,
	};
	console.log(`BATCH_REFOLD ${JSON.stringify(summary)}`);
	console.log(`BATCH_REFOLD_INSTALLS ${JSON.stringify(perInstall)}`);
	if (summary.over5ms > 0) console.log(`BATCH_REFOLD_FLAG ${summary.over5ms} chunk refolds over 5 ms at 32 KiB`);
	// The chunks went through the batch and the multi-row state check judged each one.
	expect(summary.batches, "the lost re-placements were replayed in batched chunks").toBeGreaterThanOrEqual(MEASURE_EPOCHS);
	expect(events.length, "every batched multi-row chunk was judged by the chain refold").toBeGreaterThanOrEqual(MEASURE_EPOCHS);
	expect(summary.refused, "re-placements never grow the state").toBe(0);
}, 1_800_000);

import { createOutcomeCommitAdmissionPolicy } from "@ts-drp/outcome-commit";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// RED (room state limit, finding B): a room's application state is bounded by the room's reviewed
// limit, 32,768 bytes for every room that declares none, and the bound is enforced when an
// operation is admitted. Today the shipped Grid zone has no such bound at admission: the live plane
// folds up to maxSnapshotBytes (256 MiB), so a creator signs a successor whose state passes 32 KiB,
// and then the zone's outcome-commit admission policy refuses that state at the creator's own
// adoption ("outcome inherited state is unbounded"). The room is stuck at that epoch for good.
//
// Wanted: the move whose resulting state would pass 32,768 bytes is refused with a typed error on
// the peer that issues it (creator or Writer) and on the creator when it receives it; the room keeps
// sealing, adopting and installing, and a move that does not grow the state is still admitted.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const LIMIT = 32_768;
const ID_BYTES = 1000;
const LIMIT_ERROR = /application state limit/u;

const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The shipped zone's admission policy, observing every authenticated state it is handed. */
function zonePolicy(seen: number[]) {
	return (context: Parameters<typeof createOutcomeCommitAdmissionPolicy>[0] & Record<string, unknown>) => {
		const state = context.authenticatedApplicationStateBytes as Uint8Array | undefined;
		if (state !== undefined) seen.push(state.byteLength);
		return createOutcomeCommitAdmissionPolicy({
			aclDigest: context.aclDigest,
			anchorDigest: context.anchorDigest,
			epoch: context.epoch,
			objectId: context.objectId,
			maxEntries: 8192,
			...(context.maxApplicationStateBytes === undefined
				? {}
				: { maxApplicationStateBytes: context.maxApplicationStateBytes as number }),
			...(state === undefined ? {} : { authenticatedApplicationStateBytes: state }),
		});
	};
}

const block = (owner: string, ordinal: number) => ({
	action: "placeBlock",
	id: `${owner}-${String(ordinal).padStart(5, "0")}-${"b".repeat(ID_BYTES)}`,
	kind: "stone",
	x: ordinal % 16,
	y: Math.floor(ordinal / 16),
});

it("a creator's move that would pass 32 KiB is refused at issue, and the room keeps rolling", async () => {
	const seen: number[] = [];
	const fixture = await readinessHoldRoom({ writers: 0, createOperationAdmissionPolicy: zonePolicy(seen) as never });
	const creator = await fixture.open(0);
	const outcomes: string[] = [];
	let refusal: string | undefined;
	let ordinal = 0;
	for (let epoch = 0; epoch < 8 && refusal === undefined; epoch++) {
		for (let index = 0; index < 8 && refusal === undefined; index++) {
			try {
				await creator.room.issue(block("creator", ordinal));
				ordinal++;
			} catch (error) {
				refusal = explain(error);
			}
		}
		try {
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			outcomes.push(`epoch ${epoch}: ok`);
		} catch (error) {
			outcomes.push(`epoch ${epoch}: ${explain(error)}`);
			break;
		}
	}
	console.log(`LEGACY_BOUND_CREATOR ${JSON.stringify({ refusal, ordinal, outcomes, seen })}`);
	expect(outcomes.filter((outcome) => !outcome.endsWith(": ok")), "every epoch seals and adopts").toEqual([]);
	expect(refusal, "the crossing move is refused with the typed limit error").toMatch(LIMIT_ERROR);
	// The room keeps rolling at the limit: a move that re-places an existing block (no growth) lands.
	const epoch = required(creator.room.authority()).epoch;
	await creator.room.issue({ ...block("creator", 0), kind: "gold" });
	const sealed = await creator.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	expect(creator.room.authority()?.epoch).toBe(epoch + 1);
	expect(Math.max(...seen), "no signed state passes the limit").toBeLessThanOrEqual(LIMIT);
}, 900_000);

it("a Writer's move that would pass 32 KiB is refused, the creator never admits one, and both keep rolling", async () => {
	const seen: number[] = [];
	const fixture = await readinessHoldRoom({ writers: 2, createOperationAdmissionPolicy: zonePolicy(seen) as never });
	const creator = await fixture.open(0);
	const writers = [await fixture.open(1), await fixture.open(2)];
	const delivered: (number | null)[] = [null, null, null];
	const deliver = async (from: number, to: typeof creator): Promise<void> => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(from, delivered[from] ?? null);
		for (let start = 0; start < rows.length; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0) await to.receive(chunk.slice(0, last + 1), from);
			to.inject(chunk.slice(last + 1), from);
		}
		if (rows.length !== 0) delivered[from] = required(rows.at(-1)).commit.authorSequence;
	};
	const install = async (writer: typeof creator, index: number, epoch: number): Promise<void> => {
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, index);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};
	const failures: string[] = [];
	const refusals: string[] = [];
	const ordinals = [0, 0];
	for (let epoch = 0; epoch < 8 && failures.length === 0; epoch++) {
		// Both Writers issue concurrently, each from its own view: near the limit, two moves that each
		// fit alone can pass it together. The creator is the one that decides.
		await Promise.all(
			writers.map(async (writer, index) => {
				for (let count = 0; count < 4; count++) {
					try {
						await writer.room.issue(block(`w${index + 1}`, required(ordinals[index])));
						ordinals[index] = required(ordinals[index]) + 1;
					} catch (error) {
						refusals.push(`w${index + 1} epoch ${epoch}: ${explain(error)}`);
						return;
					}
				}
			})
		);
		try {
			await deliver(1, creator);
			await deliver(2, creator);
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			for (const [index, writer] of writers.entries()) await install(writer, index + 1, epoch + 1);
		} catch (error) {
			failures.push(`epoch ${epoch}: ${explain(error)}`);
		}
	}
	console.log(`LEGACY_BOUND_WRITERS ${JSON.stringify({ failures, refusals, ordinals, seen })}`);
	expect(failures, "every epoch seals, adopts and installs").toEqual([]);
	expect(refusals.length, "a Writer's crossing move is refused").toBeGreaterThan(0);
	for (const refusal of refusals) expect(refusal).toMatch(LIMIT_ERROR);
	expect(Math.max(...seen), "no signed state passes the limit").toBeLessThanOrEqual(LIMIT);
}, 900_000);

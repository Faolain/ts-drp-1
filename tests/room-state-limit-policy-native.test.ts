import { createOutcomeCommitAdmissionPolicy } from "@ts-drp/outcome-commit";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// Owner decision 2026-11-21: the room's application state limit is a per-room setting chosen when the
// room is created (the optional `maxApplicationStateBytes` of the room's signed parameters). A room
// created with a 128 KiB limit admits moves past 32 KiB that a room created without the setting
// refuses; it refuses, typed, a move past its own limit (V3RoomStateLimitRefused with limitBytes =
// the room's limit); its creator signs no state past it; the application's admission policy is handed
// the room's limit; and a Writer of that room issues, installs and converges past 32 KiB (every member
// enforces the same authenticated value).

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const DEFAULT_LIMIT = 32_768;
const ROOM_LIMIT = 131_072;
const ID_BYTES = 2000;

type Block = { action: "placeBlock"; id: string; kind: string; x: number; y: number };

const block = (owner: string, ordinal: number): Block => ({
	action: "placeBlock",
	id: `${owner}-${String(ordinal).padStart(5, "0")}-${"b".repeat(ID_BYTES)}`,
	kind: "stone",
	x: ordinal % 16,
	y: Math.floor(ordinal / 16),
});

const refusalOf = (error: unknown) =>
	error instanceof Error
		? {
				name: error.name,
				kind: Reflect.get(error, "kind") as unknown,
				limitBytes: Reflect.get(error, "limitBytes") as unknown,
			}
		: { name: typeof error, kind: undefined, limitBytes: undefined };

const typed = (limitBytes: number) => ({ name: "V3RoomStateLimitRefused", kind: "application-state-limit", limitBytes });

/** The shipped zone's admission policy, recording the limit it is handed and every authenticated state. */
function zonePolicy(seen: { states: number[]; limits: (number | undefined)[] }) {
	return (context: Parameters<typeof createOutcomeCommitAdmissionPolicy>[0] & Record<string, unknown>) => {
		const state = context.authenticatedApplicationStateBytes as Uint8Array | undefined;
		if (state !== undefined) seen.states.push(state.byteLength);
		seen.limits.push(context.maxApplicationStateBytes as number | undefined);
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

async function creatorRoom(parameters: Readonly<Record<string, number>>, seen: Parameters<typeof zonePolicy>[0]) {
	const fixture = await readinessHoldRoom({
		writers: 0,
		parameters,
		createOperationAdmissionPolicy: zonePolicy(seen) as never,
	});
	const creator = await fixture.open(0);
	const stateBytes = (): number =>
		required(fixture.application.migration).canonicalStateBytes(creator.room.projection() as never).byteLength;
	const roll = async (): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	};
	return { creator, stateBytes, roll };
}

it("a room created with a 128 KiB limit admits a move a 32 KiB room refuses, and refuses typed past its own limit", async () => {
	const seen = { states: [] as number[], limits: [] as (number | undefined)[] };
	const { creator, stateBytes, roll } = await creatorRoom({ maxApplicationStateBytes: ROOM_LIMIT }, seen);
	let placed = 0;
	let refusal: unknown;
	let pastDefault = 0;
	for (let epoch = 0; epoch < 24 && refusal === undefined; epoch++) {
		for (let index = 0; index < 8 && refusal === undefined; index++) {
			try {
				await creator.room.issue(block("big", placed));
				placed++;
				if (stateBytes() > DEFAULT_LIMIT) pastDefault++;
			} catch (error) {
				refusal = error;
			}
		}
		await roll();
	}
	const reached = stateBytes();
	console.log(`ROOM_LIMIT_128K ${JSON.stringify({ placed, pastDefault, reached, refusal: refusalOf(refusal) })}`);
	expect(pastDefault, "moves past 32 KiB are admitted in a 128 KiB room").toBeGreaterThan(8);
	expect(reached, "the room's state grows past 32 KiB").toBeGreaterThan(DEFAULT_LIMIT);
	expect(refusal, "the fill reaches the room's own limit").toBeDefined();
	expect(refusalOf(refusal), "the crossing move is refused typed, naming the room's limit").toEqual(typed(ROOM_LIMIT));
	expect(reached + ID_BYTES, "the refused move would pass the room's limit").toBeGreaterThan(ROOM_LIMIT);
	// The player keeps playing: a non-growing move is admitted and the room keeps rolling.
	await creator.room.issue({ ...block("big", 0), kind: "gold" });
	await roll();
	expect(stateBytes()).toBeLessThanOrEqual(ROOM_LIMIT);
	expect(Math.max(...seen.states), "no signed state passes the room's limit").toBeLessThanOrEqual(ROOM_LIMIT);
	expect(Math.max(...seen.states), "signed states past 32 KiB reach the admission policy").toBeGreaterThan(DEFAULT_LIMIT);
	expect(new Set(seen.limits), "the admission policy is handed the room's limit").toEqual(new Set([ROOM_LIMIT]));
}, 900_000);

it("a room created without the setting keeps the 32 KiB limit: the same move is refused typed at 32,768 bytes", async () => {
	const seen = { states: [] as number[], limits: [] as (number | undefined)[] };
	const { creator, stateBytes, roll } = await creatorRoom({}, seen);
	let placed = 0;
	let refusal: unknown;
	for (let epoch = 0; epoch < 8 && refusal === undefined; epoch++) {
		for (let index = 0; index < 8 && refusal === undefined; index++) {
			try {
				await creator.room.issue(block("big", placed));
				placed++;
			} catch (error) {
				refusal = error;
			}
		}
		await roll();
	}
	console.log(`ROOM_LIMIT_DEFAULT ${JSON.stringify({ placed, reached: stateBytes(), refusal: refusalOf(refusal) })}`);
	expect(refusalOf(refusal)).toEqual(typed(DEFAULT_LIMIT));
	expect(stateBytes()).toBeLessThanOrEqual(DEFAULT_LIMIT);
	expect(Math.max(...seen.states)).toBeLessThanOrEqual(DEFAULT_LIMIT);
	expect(new Set(seen.limits)).toEqual(new Set([DEFAULT_LIMIT]));
}, 900_000);

it("a Writer of a 128 KiB room issues past 32 KiB, the creator admits it, and the Writer installs and converges", async () => {
	const seen = { states: [] as number[], limits: [] as (number | undefined)[] };
	const fixture = await readinessHoldRoom({
		writers: 1,
		parameters: { maxApplicationStateBytes: ROOM_LIMIT },
		createOperationAdmissionPolicy: zonePolicy(seen) as never,
	});
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	const stateBytes = (peer: typeof creator): number =>
		required(fixture.application.migration).canonicalStateBytes(peer.room.projection() as never).byteLength;
	let delivered: number | null = null;
	const deliver = async (): Promise<void> => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(1, delivered);
		if (rows.length === 0) return;
		delivered = required(rows.at(-1)).commit.authorSequence;
		for (const row of rows) {
			if (isControl(row)) creator.inject([row], 1);
			else await creator.receive([row], 1);
		}
	};
	const failures: string[] = [];
	let ordinal = 0;
	for (let epoch = 0; epoch < 6 && failures.length === 0 && stateBytes(creator) <= DEFAULT_LIMIT + 4 * ID_BYTES; epoch++) {
		try {
			for (let count = 0; count < 6; count++) {
				await writer.room.issue(block("w1", ordinal));
				ordinal++;
			}
			await deliver();
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
			Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
			await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
			expect(writer.room.authority()?.epoch).toBe(epoch + 1);
		} catch (error) {
			failures.push(`epoch ${epoch}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const creatorBytes = stateBytes(creator);
	console.log(`ROOM_LIMIT_WRITER ${JSON.stringify({ failures, ordinal, creatorBytes, writerBytes: stateBytes(writer) })}`);
	expect(failures, "every Writer move is admitted and every epoch seals, adopts and installs").toEqual([]);
	expect(creatorBytes, "the room's state passes 32 KiB").toBeGreaterThan(DEFAULT_LIMIT);
	expect(stateBytes(writer), "the Writer converges on the creator").toBe(creatorBytes);
	expect(writer.room.projection().blocks.length).toBe(ordinal);
	expect(Math.max(...seen.states)).toBeLessThanOrEqual(ROOM_LIMIT);
}, 900_000);

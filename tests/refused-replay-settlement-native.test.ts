import { encodeCanonical } from "@ts-drp/canonical";
import {
	type DurableIssuanceOutboxRecord,
	SETTLEMENT_HAND_BACK_LIMITS,
	type SettlementPlan,
} from "@ts-drp/issuance-store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { V3RoomHandBackRefused, V3RoomLocalBacklogFull } from "../packages/node/src/v3-room.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// RED (refused replay, fix/refused-replay-settlement): a Writer's displaced move whose replay the
// room's admission refuses stops the Writer's install for good.
//
// A Writer's move that the creator's epoch closes without (late, or refused at the creator) is
// displaced; the Writer's next install replays it in the new epoch (a settlement replacement). When
// the room's operation admission policy refuses that replay (here a policy whose rule refuses the
// move from epoch 2 on; in the shipped zone, an outcome identity another author committed first),
// issueSettlement throws "v3 room settlement issue failed: admission-rejected" and
// installCreatorSuccessor fails: the Writer is stuck at its epoch.
//
// Wanted: the install completes and the Writer keeps playing; the refused move is never replayed
// again and never silently lost: it is given back to the application as a durable hand-back record
// typed with the refusal reason (settlementStatus().undelivered, reason "admission-rejected").

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const DOOM_EPOCH = 2;
// A test lifts the rule to let a given-back move's reissue be admitted (and consume its record).
let doomLifted = false;
afterEach(() => {
	doomLifted = false;
});
const fresh = Object.freeze({ kind: "fresh" as const, commit: () => "committed" as const, release: () => undefined });

/** Admits every move, except a "doomed" block from DOOM_EPOCH on (the rule its replay meets). */
const doomingPolicy = (context: Readonly<{ epoch: number }>) =>
	Object.freeze({
		reserve: (operation: Readonly<Record<string, unknown>>) =>
			!doomLifted && context.epoch >= DOOM_EPOCH && String(operation.id ?? "").startsWith("doomed")
				? Object.freeze({ kind: "rejected" as const })
				: fresh,
	});

const block = (id: string, x: number) => ({ action: "placeBlock", id, kind: "stone", x, y: 0 });
const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

it("a displaced move whose replay the room refuses is handed back typed, and the Writer keeps installing", async () => {
	const fixture = await readinessHoldRoom({ writers: 1, createOperationAdmissionPolicy: doomingPolicy as never });
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
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
	const rollover = async (epoch: number): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};
	const ids = (room: typeof creator): string[] =>
		(room.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((value) => value.id).sort();

	// Epoch 0: an ordinary move lands.
	await writer.room.issue(block("w-0", 0));
	await deliver();
	await rollover(1);
	await deliver(); // the Writer's epoch-1 fence reaches the creator
	// Epoch 1: the doomed move is admitted by the Writer but never reaches the creator.
	await writer.room.issue(block("doomed-1", 1));
	// It is lost on the way: the creator never receives it (the stale row is never delivered later).
	const lost = await fixture.publishedAfter(1, delivered);
	expect(lost.filter((row) => !isControl(row)).length).toBe(1);
	delivered = required(lost.at(-1)).commit.authorSequence;
	const failures: string[] = [];
	try {
		await rollover(2); // the install replays the displaced move; the epoch-2 rule refuses it
	} catch (error) {
		failures.push(`install 2: ${explain(error)}`);
	}
	const status = writer.room.settlementStatus?.();
	console.log(`REFUSED_REPLAY ${JSON.stringify({ failures, status })}`);
	expect(failures, "the install completes").toEqual([]);
	const undelivered = required(status).undelivered;
	expect(undelivered.map((move) => move.operations[0]?.id), "the refused move is given back").toEqual(["doomed-1"]);
	expect(Reflect.get(required(undelivered[0]), "reason"), "typed with the refusal reason").toBe("admission-rejected");

	// The Writer keeps playing, and the refused move is never replayed again.
	await deliver();
	await writer.room.issue(block("w-2", 2));
	await deliver();
	await rollover(3);
	await deliver();
	await rollover(4);
	expect(ids(creator)).toEqual(["w-0", "w-2"]);
	expect(ids(writer)).toEqual(["w-0", "w-2"]);
	const later = required(writer.room.settlementStatus?.()).undelivered;
	expect(later.map((move) => move.operations[0]?.id), "listed once, never replayed").toEqual(["doomed-1"]);
	const replays = (await fixture.publishedAfter(1, null)).filter((row) => !isControl(row));
	console.log(`REFUSED_REPLAY_ROWS ${replays.length}`);
}, 600_000);

/** A creator and one Writer under the dooming policy, with manual delivery and rollover. */
async function doomingRoom(directory?: string) {
	const fixture = await readinessHoldRoom({
		...(directory === undefined ? {} : { directory }),
		writers: 1,
		createOperationAdmissionPolicy: doomingPolicy as never,
	});
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
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
	/** Marks every row the Writer published so far as lost: it never reaches the creator. */
	const lose = async (): Promise<number> => {
		const lost = await fixture.publishedAfter(1, delivered);
		if (lost.length !== 0) delivered = required(lost.at(-1)).commit.authorSequence;
		return lost.filter((row) => !isControl(row)).length;
	};
	const install = async (epoch: number): Promise<void> => {
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};
	const adopt = async (): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	};
	const ids = (room: typeof creator): string[] =>
		(room.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((value) => value.id).sort();
	const status = () => required(writer.room.settlementStatus?.());
	const listed = () => status().undelivered.map((move) => move.operations[0]?.id);
	return { fixture, creator, writer, deliver, lose, install, adopt, ids, status, listed };
}

// The hand-back records always suffice for refused replays: the Writer's backlog bound
// (V3_ROOM_LOCAL_BACKLOG_LIMIT = SETTLEMENT_HAND_BACK_LIMITS.maxRecords) counts its live displaced moves
// and its unconsumed records together and refuses a new move at the bound, and a refusal turns each
// live move into at most one record. Here the Writer fills the bound with 64 lost moves (the 65th is
// refused up front); every one of their replays is refused at the next install, and all 64 are given
// back, none deferred.
it("64 refused replays (the Writer's whole backlog) are all handed back; declined, they free the backlog and the Writer plays again", async () => {
	const room = await doomingRoom();
	await room.writer.room.issue(block("w-0", 0));
	await room.deliver();
	await room.adopt();
	await room.install(1);
	await room.deliver();
	const limit = SETTLEMENT_HAND_BACK_LIMITS.maxRecords;
	for (let index = 0; index < limit; index++)
		await room.writer.room.issue(block(`doomed-${String(index).padStart(2, "0")}`, 1 + index));
	let refused: string | undefined;
	try {
		await room.writer.room.issue(block("doomed-64", 99));
	} catch (error) {
		refused = error instanceof Error ? error.name : String(error);
	}
	expect(refused, "the 65th undelivered move is refused up front").toBe("V3RoomLocalBacklogFull");
	expect(await room.lose()).toBeGreaterThanOrEqual(1);
	await room.adopt();
	await room.install(2);
	const status = room.status();
	console.log(`REFUSED_REPLAY_BOUND ${JSON.stringify({ listed: status.undelivered.length, deferred: status.deferred })}`);
	expect(room.listed().length).toBe(limit);
	expect(room.listed().every((id) => String(id).startsWith("doomed-"))).toBe(true);
	expect(status.undelivered.every((move) => Reflect.get(move, "reason") === "admission-rejected")).toBe(true);
	expect(status.deferred, "none deferred").toBe(0);
	// Each record holds a backlog slot until the application offers its exact operation again
	// (issue(op, {handBack})) or declines it. Here the Writer's next new move is refused, and the
	// refusal says the 64 slots are given-back moves.
	let blocked: unknown;
	try {
		await room.writer.room.issue(block("w-2", 2));
	} catch (error) {
		blocked = error;
	}
	expect(blocked).toBeInstanceOf(V3RoomLocalBacklogFull);
	expect((blocked as V3RoomLocalBacklogFull).handBackSlots, "all 64 slots are given-back moves").toBe(limit);
	// Offered again, each is refused again for the same lasting reason, typed with its record; the
	// application declines it (one plan write drops exactly that record).
	const outcomes: string[] = [];
	for (const move of status.undelivered) {
		let refusedAgain: unknown;
		try {
			await room.writer.room.issue(required(move.operations[0]), { handBack: move.handBack });
		} catch (error) {
			refusedAgain = error;
		}
		expect(refusedAgain).toBeInstanceOf(V3RoomHandBackRefused);
		expect((refusedAgain as V3RoomHandBackRefused).handBack).toEqual(move.handBack);
		expect((refusedAgain as V3RoomHandBackRefused).reason).toBe("admission-rejected");
		outcomes.push((await required(room.writer.room.declineHandBack)(move.handBack)).kind);
	}
	expect(outcomes).toEqual(Array.from({ length: limit }, () => "declined"));
	expect(room.listed(), "none listed").toEqual([]);
	// The Writer plays again: its move is accepted, reaches the creator, and lands; no doomed move ever does.
	await room.deliver();
	await room.writer.room.issue(block("w-2", 2));
	await room.deliver();
	await room.adopt();
	await room.install(3);
	await room.deliver();
	await room.adopt();
	await room.install(4);
	console.log(`REFUSED_REPLAY_DECLINED ${JSON.stringify({ outcomes: outcomes.length, creator: room.ids(room.creator) })}`);
	expect(room.ids(room.creator)).toEqual(["w-0", "w-2"]);
	expect(room.ids(room.writer)).toEqual(["w-0", "w-2"]);
	expect(room.listed()).toEqual([]);
}, 600_000);

// Declining is exact: a record a reissued row already consumed is left as it is ("consumed"), and a
// record no longer in the plan is reported "absent", never an error and never a second change.
it("declining a consumed or absent hand-back record is a typed no-op", async () => {
	const room = await doomingRoom();
	await room.writer.room.issue(block("w-0", 0));
	await room.deliver();
	await room.adopt();
	await room.install(1);
	await room.deliver();
	await room.writer.room.issue(block("doomed-1", 1));
	expect(await room.lose()).toBe(1);
	await room.adopt();
	await room.install(2);
	const [given] = room.status().undelivered;
	expect(given?.operations[0]?.id).toBe("doomed-1");
	const decline = required(room.writer.room.declineHandBack);
	// The rule is lifted: the reissue is admitted and its row consumes the record.
	doomLifted = true;
	await room.deliver();
	await room.writer.room.issue(required(required(given).operations[0]), { handBack: required(given).handBack });
	expect(room.listed()).toEqual([]);
	expect(await decline(required(given).handBack)).toEqual({ kind: "consumed", handBack: required(given).handBack });
	// The next install's merge drops the consumed record; the reissued move lands.
	await room.deliver();
	await room.adopt();
	await room.install(3);
	expect(await decline(required(given).handBack)).toEqual({ kind: "absent", handBack: required(given).handBack });
	expect(await decline({ sourceSequence: 9_999, intent: 0 })).toEqual({
		kind: "absent",
		handBack: { sourceSequence: 9_999, intent: 0 },
	});
	expect(room.ids(room.creator)).toEqual(["doomed-1", "w-0"]);
}, 600_000);

// A declined record is gone for good: declining again is "absent", and offering the move with the
// record is refused (the record is unavailable), so it can never also be reissued.
it("a declined hand-back can be neither declined again nor reissued with its record", async () => {
	const room = await doomingRoom();
	await room.writer.room.issue(block("w-0", 0));
	await room.deliver();
	await room.adopt();
	await room.install(1);
	await room.deliver();
	await room.writer.room.issue(block("doomed-1", 1));
	expect(await room.lose()).toBe(1);
	await room.adopt();
	await room.install(2);
	const given = required(room.status().undelivered[0]);
	const decline = required(room.writer.room.declineHandBack);
	expect((await decline(given.handBack)).kind).toBe("declined");
	expect((await decline(given.handBack)).kind).toBe("absent");
	doomLifted = true;
	let reissued: unknown;
	try {
		await room.writer.room.issue(required(given.operations[0]), { handBack: given.handBack });
	} catch (error) {
		reissued = error;
	}
	expect(reissued).toBeInstanceOf(V3RoomHandBackRefused);
	expect((reissued as V3RoomHandBackRefused).reason, "not a lasting refusal: the record is unavailable").toBeUndefined();
	expect(explain(reissued)).toContain("hand-back is unavailable");
	await room.deliver();
	await room.adopt();
	await room.install(3);
	expect(room.ids(room.creator)).toEqual(["w-0"]);
	expect(room.listed()).toEqual([]);
}, 600_000);

// Fail-safe of the hand-back (unreachable through the public API, see above): with every record taken,
// a refused replay is NOT expired (no move is ever expired unrecorded): its source stays live, reported
// deferred, and the install completes. The records are taken directly in the Writer's own store (64
// genuine-shape records of an earlier source), between the creator's adoption and the Writer's install.
it("with all 64 hand-back records taken, a refused replay stays live and the install completes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "refused-replay-full-"));
	const room = await doomingRoom(directory);
	await room.writer.room.issue(block("w-0", 0));
	await room.deliver();
	await room.adopt();
	await room.install(1);
	await room.deliver();
	await room.writer.room.issue(block("doomed-1", 1));
	expect(await room.lose()).toBe(1);
	await room.adopt();
	const author = required(room.fixture.identities[1]).author;
	const scope = { author, objectId: room.fixture.objectId };
	const issuance = await createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" }).openIssuance("peer-1");
	try {
		const plan = required(await issuance.readSettlementPlan(scope));
		const fillers = Array.from({ length: SETTLEMENT_HAND_BACK_LIMITS.maxRecords }, (_, intent) =>
			Object.freeze({
				sourceSequence: 0,
				sourceDigest: new Uint8Array(32).fill(0xaa),
				sourceEpoch: 0,
				intent,
				exactCanonicalOperationBytes: encodeCanonical(block(`filler-${String(intent).padStart(2, "0")}`, 2 + intent)),
				reissueSequence: null,
			})
		);
		await issuance.transactWriteSettlementPlan({
			expectedRevision: plan.revision,
			scope,
			plan: { ...plan, revision: plan.revision + 1, handBacks: [...(plan.handBacks ?? []), ...fillers] },
		});
	} finally {
		await issuance.close();
	}
	const failures: string[] = [];
	try {
		await room.install(2); // the replay is refused; no record is free
	} catch (error) {
		failures.push(`install 2: ${explain(error)}`);
	}
	const status = room.status();
	console.log(`REFUSED_REPLAY_FULL ${JSON.stringify({ failures, listed: status.undelivered.length, deferred: status.deferred })}`);
	expect(failures, "the install completes").toEqual([]);
	expect(room.listed(), "not given back: no record was free").not.toContain("doomed-1");
	expect(room.listed().length).toBe(SETTLEMENT_HAND_BACK_LIMITS.maxRecords);
	expect(status.deferred, "the live move is reported deferred").toBe(1);
	expect(room.ids(room.creator)).toEqual(["w-0"]);
}, 600_000);

// Refused replay x track 46 (integration int7-wo): the move a refused replay gave back is offered again
// (its reissue consumes the record and maps the reissued row to the move's origin, reissueOrigins), and
// that reissued row is displaced and its replay refused too. The second hand-back keeps the move's
// origin (the row the author first made it in), carries the refusal reason, and takes over the reissue's
// entry in the same plan write: the entry is dropped (it was the plan's only one), so the move holds
// exactly one backlog slot, by its record.
it("a reissued move whose reissue's replay is refused again is given back at its origin, and its entry is dropped", async () => {
	const directory = mkdtempSync(join(tmpdir(), "refused-replay-reissued-"));
	const room = await doomingRoom(directory);
	const author = required(room.fixture.identities[1]).author;
	const scope = { author, objectId: room.fixture.objectId };
	const readPlan = async (): Promise<SettlementPlan | null> => {
		const issuance = await createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" }).openIssuance(
			"peer-1"
		);
		try {
			return await issuance.readSettlementPlan(scope);
		} finally {
			await issuance.close();
		}
	};
	await room.writer.room.issue(block("w-0", 0));
	await room.deliver();
	await room.adopt();
	await room.install(1);
	await room.deliver();
	await room.writer.room.issue(block("doomed-1", 1));
	expect(await room.lose()).toBe(1);
	await room.adopt();
	await room.install(2); // the replay is refused: given back (reason admission-rejected)
	const first = required(room.status().undelivered[0]);
	expect(first.operations[0]?.id).toBe("doomed-1");
	const origin = first.handBack.sourceSequence;
	expect(first.originSequence, "the first hand-back is the move's own row").toBe(origin);
	// Offered again while the rule is lifted: admitted, the record consumed, the entry written.
	doomLifted = true;
	await room.deliver();
	await room.writer.room.issue(required(first.operations[0]), { handBack: first.handBack });
	doomLifted = false;
	const reissuedPlan = required(await readPlan());
	expect(reissuedPlan.reissueOrigins?.length, "the reissue's origin entry").toBe(1);
	const reissue = required(reissuedPlan.reissueOrigins?.[0]);
	expect(reissue.originSequence).toBe(origin);
	// The reissued row is lost; the next install replays it and the rule refuses it again.
	expect(await room.lose()).toBe(1);
	await room.adopt();
	const failures: string[] = [];
	try {
		await room.install(3);
	} catch (error) {
		failures.push(`install 3: ${explain(error)}`);
	}
	const status = room.status();
	const plan = required(await readPlan());
	console.log(
		`REFUSED_REPLAY_REISSUED ${JSON.stringify({ failures, origin, reissue, undelivered: status.undelivered, reissueOrigins: plan.reissueOrigins ?? null, records: (plan.handBacks ?? []).map(({ sourceSequence, intent, originSequence, reissueSequence, reason }) => ({ sourceSequence, intent, originSequence, reissueSequence, reason })) })}`
	);
	expect(failures, "the install completes").toEqual([]);
	expect(
		status.undelivered.map((move) => move.operations[0]?.id),
		"given back once more"
	).toEqual(["doomed-1"]);
	const second = required(status.undelivered[0]);
	expect(second.handBack.sourceSequence, "the record is the reissued row's").toBe(reissue.reissueSequence);
	expect(Reflect.get(second, "reason"), "typed with the refusal reason").toBe("admission-rejected");
	expect(second.originSequence, "the move's origin, not the reissued row").toBe(origin);
	const records = (plan.handBacks ?? []).filter((record) => record.reissueSequence === null);
	expect(records.map((record) => [record.sourceSequence, record.originSequence, record.reason])).toEqual([
		[reissue.reissueSequence, origin, "admission-rejected"],
	]);
	expect(plan.reissueOrigins, "the reissue's entry passed to the new record").toBeUndefined();
	// The Writer keeps playing; the given-back move is not replayed.
	await room.deliver();
	await room.writer.room.issue(block("w-3", 3));
	await room.deliver();
	await room.adopt();
	await room.install(4);
	expect(room.ids(room.creator)).toEqual(["w-0", "w-3"]);
	expect(room.listed()).toEqual(["doomed-1"]);
}, 600_000);

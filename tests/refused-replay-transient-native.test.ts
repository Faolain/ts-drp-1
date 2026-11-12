import { decodeCanonical } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// A Writer's displaced move whose replay its own admission refuses for a TRANSIENT reason at an install
// (here: the snapshot readiness read fails, "v3 snapshot readiness is unavailable"). A failed install is
// the room's terminal failure, and a displaced row not replayed at its own epoch's install leaves the
// next scan, so the install retries the replay itself (backoff 10 ms doubling, 7 retries) and:
//   - a refusal that clears within the retries: the replay is signed, and the move lands exactly once;
//   - a refusal that persists past them: the move is handed back once, reason "transient-exhausted",
//     the install completes and the Writer plays on; offered again later, the move lands once.
// The fault is in the native read itself (the Writer's snapshot owner status query throws while armed);
// nothing in the room is mocked. It is armed in the Writer's own issuance store once its install's
// drain has issued the epoch's fence (the drain issues the fence before any replay) with the displaced
// source's replay still pending, and disarmed after `failures` reads, or by the hand-back's plan write.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const WRITER_ISSUANCE = createHash("sha256").update(JSON.stringify(["issuance", "peer-1"])).digest("hex");
const OWNER_STATUS_SQL = "SELECT COUNT(*) AS count FROM snapshot_owner_v2";
const block = (id: string, x: number) => ({ action: "placeBlock", id, kind: "stone", x, y: 0 });

/** A stored settlement plan row: whether a replay decision is pending, and whether one was handed back. */
function planState(entriesJson: string): Readonly<{ pendingReplay: boolean; handedBack: boolean }> {
	const decoded = JSON.parse(entriesJson) as unknown;
	const entries = (
		Array.isArray(decoded)
			? decoded
			: (decodeCanonical(new Uint8Array(Buffer.from((decoded as { bytes: string }).bytes, "base64"))) as {
					entries: unknown[];
				}).entries
	) as { disposition?: string; replacementSequence?: number | null; handedBack?: unknown }[];
	return {
		pendingReplay: entries.some(
			(entry) =>
				(entry.disposition === "rebase" || entry.disposition === "transform") &&
				(entry.replacementSequence ?? null) === null &&
				entry.handedBack === undefined
		),
		handedBack: entries.some((entry) => entry.handedBack !== undefined),
	};
}

/** Arms the fault: from the install's replay decision on, the snapshot owner status read throws. */
function snapshotReadinessFault(failures: number) {
	const fault = { watching: false, armed: false, inside: false, thrown: 0, failures };
	const exec = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
		const result = exec.call(this, sql);
		if (
			fault.watching &&
			!fault.inside &&
			(sql === "COMMIT" || sql.endsWith("COMMIT")) &&
			this.location()?.endsWith(".drp-issuance-v1.sqlite") === true &&
			basename(this.location() ?? "").startsWith(WRITER_ISSUANCE)
		) {
			fault.inside = true;
			try {
				const rows = this.prepare("SELECT fence_sequence, entries_json FROM settlement_plans").all() as {
					fence_sequence: number | null;
					entries_json: string;
				}[];
				const states = rows.map((row) => ({ fenced: row.fence_sequence !== null, ...planState(row.entries_json) }));
				if (states.some((state) => state.handedBack)) fault.armed = false;
				else if (states.some((state) => state.fenced && state.pendingReplay)) fault.armed = fault.thrown < fault.failures;
			} finally {
				fault.inside = false;
			}
		}
		return result;
	};
	const get = StatementSync.prototype.get;
	StatementSync.prototype.get = function (this: StatementSync, ...parameters: never[]) {
		if (fault.armed && this.sourceSQL === OWNER_STATUS_SQL) {
			fault.thrown += 1;
			if (fault.thrown >= fault.failures) fault.armed = false;
			throw new Error("injected snapshot owner read failure");
		}
		return Reflect.apply(get, this, parameters) as unknown;
	} as typeof get;
	const restore = (): void => {
		DatabaseSync.prototype.exec = exec;
		StatementSync.prototype.get = get;
	};
	return { fault, restore };
}

async function writerRoom() {
	const fixture = await readinessHoldRoom({ writers: 1 });
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
	const ids = (room: typeof creator): string[] =>
		(room.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((value) => value.id).sort();
	const status = () => required(writer.room.settlementStatus?.());
	return { creator, writer, deliver, lose, rollover, ids, status };
}

/** Epoch 0 lands w-0; epoch 1's lost-1 never reaches the creator, so the epoch-2 install replays it. */
async function lostMove() {
	const room = await writerRoom();
	await room.writer.room.issue(block("w-0", 0));
	await room.deliver();
	await room.rollover(1);
	await room.deliver();
	await room.writer.room.issue(block("lost-1", 1));
	expect(await room.lose()).toBe(1);
	return room;
}

it("a replay refused transiently, then cleared within the install's retries, lands exactly once", async () => {
	const room = await lostMove();
	const { fault, restore } = snapshotReadinessFault(2);
	try {
		fault.watching = true;
		await room.rollover(2);
	} finally {
		restore();
	}
	console.log(`REFUSED_REPLAY_TRANSIENT_CLEARS ${JSON.stringify({ thrown: fault.thrown, status: room.status() })}`);
	expect(fault.thrown, "the replay was refused (transiently) twice").toBe(2);
	expect(room.status().undelivered, "nothing handed back").toEqual([]);
	await room.deliver();
	await room.rollover(3);
	expect(room.ids(room.creator)).toEqual(["lost-1", "w-0"]);
	expect(room.ids(room.writer)).toEqual(["lost-1", "w-0"]);
	await room.deliver();
	await room.rollover(4);
	expect(room.ids(room.creator), "landed once, never replayed again").toEqual(["lost-1", "w-0"]);
}, 600_000);

it("a replay refused transiently past the install's retries is handed back once (transient-exhausted); the Writer plays on", async () => {
	const room = await lostMove();
	const { fault, restore } = snapshotReadinessFault(Number.POSITIVE_INFINITY);
	const started = performance.now();
	try {
		fault.watching = true;
		await room.rollover(2); // the install completes
	} finally {
		restore();
	}
	const installMs = performance.now() - started;
	const given = room.status().undelivered;
	console.log(`REFUSED_REPLAY_TRANSIENT_EXHAUSTED ${JSON.stringify({ thrown: fault.thrown, installMs, given })}`);
	expect(fault.thrown, "the first attempt and its 7 retries").toBe(8);
	expect(given.map((move) => move.operations[0]?.id)).toEqual(["lost-1"]);
	expect(Reflect.get(required(given[0]), "reason")).toBe("transient-exhausted");
	// The Writer plays on.
	await room.deliver();
	await room.writer.room.issue(block("w-2", 2));
	await room.deliver();
	await room.rollover(3);
	expect(room.ids(room.creator)).toEqual(["w-0", "w-2"]);
	expect(room.status().undelivered.map((move) => move.operations[0]?.id), "listed once").toEqual(["lost-1"]);
	// Offered again, the move lands exactly once and its record is consumed.
	const move = required(given[0]);
	await room.writer.room.issue(required(move.operations[0]), { handBack: move.handBack });
	expect(room.status().undelivered).toEqual([]);
	await room.deliver();
	await room.rollover(4);
	await room.deliver();
	await room.rollover(5);
	expect(room.ids(room.creator)).toEqual(["lost-1", "w-0", "w-2"]);
	expect(room.ids(room.writer)).toEqual(["lost-1", "w-0", "w-2"]);
}, 600_000);

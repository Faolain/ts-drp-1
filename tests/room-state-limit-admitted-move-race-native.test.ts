import { encodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import * as rollover from "../examples/v3-room/src/rollover.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { ROOM_APPLICATION_STATE_BYTES } from "../packages/node/src/v3-live.js";

// The hot-writer loss (verify-int7wo2/policy1.log, block-1-687), driven without timing luck.
//
// At the room's application state limit (row 96) a Writer's admission is advisory: its own view lacks the
// creator's concurrent moves. A Writer move W is admitted (the app is told "accepted") in epoch N, and
// the creator closes N without it (its row arrives too late: the hot-writer run's `capacity` rollover).
// In N+1 the creator's own move C takes the state's last bytes. The Writer's install of N+1 replays W;
// its own check admits the replay (it has not seen C), and the creator's ingress refuses it
// (application-state-limit). The creator closes N+1 with C. At the install of N+2 the Writer's own
// admission refuses the replay, so row 97 gives W back (reason application-state-limit), and the shipped
// member policy offers it again with its record, is refused (V3RoomHandBackRefused) and declines it
// (hooks.onDeclined). W is gone from the converged state.
//
// The application below keeps its books the way the hot-writer harness does (app-rollover-policy-native
// playPastCeiling with stateLimitRefusals, and the track-m-apps fixture's member policy hooks): a move is
// accepted when its issue resolves, a typed V3RoomStateLimitRefused is a refusal, and the policy gets
// only onError. The converged state must hold exactly the moves the application holds as accepted.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

type Block = { action: "placeBlock"; id: string; kind: string; x: number; y: number };
type Projection = {
	creatorAuthor: string;
	creatorPeerId: string;
	blocks: readonly Omit<Block, "action">[];
	outcomes: readonly unknown[];
	roster: readonly unknown[];
};

const block = (prefix: string, ordinal: number, idBytes: number): Block => ({
	action: "placeBlock",
	id: `${prefix}-${String(ordinal).padStart(5, "0")}-${"b".repeat(idBytes)}`,
	kind: "stone",
	x: ordinal % 16,
	y: Math.floor(ordinal / 16) % 16,
});

/** The Grid zone's exact canonical state with these placements added (the room's state-limit measure). */
function stateBytesWith(projection: Projection, added: readonly Block[]): number {
	const blocks = new Map(projection.blocks.map((value) => [value.id, value]));
	for (const { action: _action, ...value } of added) blocks.set(value.id, value);
	return encodeCanonical({
		version: 2,
		creatorAuthor: projection.creatorAuthor,
		creatorPeerId: projection.creatorPeerId,
		blocks: [...blocks.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
		outcomes: projection.outcomes,
		roster: projection.roster,
	}).byteLength;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `done` holds, at most `ms`.
 * @param done - The condition.
 * @param ms - The bound.
 * @returns Whether it held.
 */
async function until(done: () => boolean, ms: number): Promise<boolean> {
	for (const deadline = performance.now() + ms; performance.now() < deadline; ) {
		if (done()) return true;
		await sleep(50);
	}
	return done();
}

it("a Writer move admitted at the state limit and then given back is in the converged state, or the application was told it was declined", async () => {
	const fixture = await readinessHoldRoom({ writers: 1 });
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	const LIMIT = ROOM_APPLICATION_STATE_BYTES;
	const projection = (peer: typeof creator) => peer.room.projection() as unknown as Projection;
	const ids = (peer: typeof creator) => projection(peer).blocks.map((value) => value.id).sort();
	let delivered: number | null = null;
	// The Writer's published rows reach the creator (the last ordinary one is awaited), in order.
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
	// The Writer's rows published so far never reach the creator.
	const lose = async (): Promise<number> => {
		const lost = await fixture.publishedAfter(1, delivered);
		if (lost.length !== 0) delivered = required(lost.at(-1)).commit.authorSequence;
		return lost.filter((row) => !isControl(row)).length;
	};
	const adopt = async (): Promise<void> => {
		const sealed = await creator.room.sealEpoch();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	};
	const install = async (epoch: number): Promise<void> => {
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom, 1);
		Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
		expect(writer.room.authority()?.epoch).toBe(epoch);
	};
	let epoch = 0;
	const roll = async (): Promise<void> => {
		await adopt();
		epoch++;
		await install(epoch);
		await deliver(); // the Writer's fence of the new epoch
	};

	// The application's books, as the hot-writer harness keeps them.
	const accepted: string[] = [];
	const refusals: string[] = [];
	const play = async (id: string, issue: () => Promise<unknown>): Promise<boolean> => {
		try {
			await issue();
		} catch (error) {
			if (!(error instanceof Error) || error.name !== "V3RoomStateLimitRefused") throw error;
			refusals.push(id);
			return false;
		}
		accepted.push(id);
		return true;
	};

	// The Writer's opening rows reach the creator in epoch 0.
	await deliver();
	// Fill to just under the limit with the creator's blocks (rolling every 8, the Writer following).
	let placed = 0;
	for (const [prefix, idBytes, margin] of [["big", 1000, 2600], ["mid", 100, 1400]] as const) {
		for (let count = 0; stateBytesWith(projection(creator), [block(prefix, placed, idBytes)]) <= LIMIT - margin; count++) {
			const fill = block(prefix, placed, idBytes);
			expect(await play(fill.id, () => creator.room.issue(fill))).toBe(true);
			placed++;
			if (count % 8 === 7) await roll();
		}
		await roll();
	}
	expect(ids(writer), "the Writer's view is the creator's").toEqual(ids(creator));
	// W and C: each alone fits the state; both together pass the limit.
	let idBytes = 1;
	while (stateBytesWith(projection(creator), [block("w", 0, idBytes + 1)]) <= LIMIT) idBytes++;
	const moveW = block("w", 0, idBytes);
	const moveC = block("c", 0, idBytes);
	const base = stateBytesWith(projection(creator), []);
	expect(stateBytesWith(projection(creator), [moveW])).toBeLessThanOrEqual(LIMIT);
	expect(stateBytesWith(projection(creator), [moveC])).toBeLessThanOrEqual(LIMIT);
	expect(stateBytesWith(projection(creator), [moveW, moveC]), "W and C together pass the limit").toBeGreaterThan(LIMIT);

	// The Writer's application: the shipped member policy, with the hooks the hot-writer harness gives it.
	const policyErrors: string[] = [];
	const policy = rollover.createV3RoomRolloverPolicy({
		role: "member",
		budget: { movesPerAuthor: 100_000, idleMs: 20_000 },
		hooks: { onError: (error) => policyErrors.push(error instanceof Error ? error.message : String(error)) },
	});
	// The room's state-bound diagnostics (the "__warmProofEvent" hook): each admission judgement's outcome.
	const judged: Readonly<Record<string, unknown>>[] = [];
	Reflect.set(globalThis, "__warmProofEvent", (event: Readonly<Record<string, unknown>>) => {
		if (event.kind === "application-state-bound") judged.push(event);
	});
	try {
		policy.bind(writer.room as unknown as Parameters<rollover.V3RoomRolloverPolicy["bind"]>[0]);
		// Epoch N: W is admitted by the Writer; its row never reaches the creator before the creator closes N.
		const closing = epoch;
		expect(await play(moveW.id, () => policy.issue(moveW)), "the Writer admits W").toBe(true);
		expect(await lose()).toBe(1);
		await adopt();
		epoch++;
		// Epoch N+1: the creator's own move takes the last bytes.
		expect(await play(moveC.id, () => creator.room.issue(moveC)), "the creator admits C").toBe(true);
		await install(epoch);
		// The install replayed W; the Writer's own (advisory) check admitted the replay: it has not seen C.
		expect(ids(writer), "the Writer's replay of W is admitted locally").toContain(moveW.id);
		const replay = await fixture.publishedAfter(1, delivered);
		creator.inject(replay, 1);
		delivered = required(replay.at(-1)).commit.authorSequence;
		const creatorAuthor = required(fixture.identities[0]).author;
		const refusedAtIngress = () =>
			judged.some((event) => event.path === "received" && event.receiver === creatorAuthor && event.admitted === false);
		expect(await until(refusedAtIngress, 30_000), "the creator's ingress refuses the replay at the limit").toBe(true);
		expect(ids(creator)).not.toContain(moveW.id);
		// The creator closes N+1 with C; the Writer's install of N+2 gives W back (row 97).
		await adopt();
		epoch++;
		await install(epoch);
		const status = required(writer.room.settlementStatus?.());
		const givenBack = status.undelivered.find((move) => move.operations[0]?.id === moveW.id);
		console.log(
			`ADMITTED_MOVE_RACE ${JSON.stringify({ closing, base, idBytes, placed, undelivered: status.undelivered.map((move) => [String(move.operations[0]?.id).slice(0, 7), Reflect.get(move, "reason")]) })}`
		);
		expect(givenBack, "the Writer's own admission refused the replay: W is given back").toBeDefined();
		expect(Reflect.get(required(givenBack), "reason")).toBe("application-state-limit");
		await deliver();
		// The policy answers the given-back move: offered again with its record, refused, declined.
		const answered = () =>
			policy.status().kept.length === 0 && required(writer.room.settlementStatus?.()).undelivered.length === 0;
		expect(await until(answered, 20_000), "the policy answered the given-back move").toBe(true);
		console.log(`ADMITTED_MOVE_RACE_POLICY ${JSON.stringify({ policyErrors, kept: policy.status().kept.length })}`);
		// Converged: both roles hold C and not W.
		expect(ids(writer)).toEqual(ids(creator));
		expect(ids(creator)).toContain(moveC.id);
		expect(ids(creator)).not.toContain(moveW.id);
		// The converged state holds exactly the moves the application holds as accepted.
		expect(ids(creator), "the state holds exactly the accepted moves").toEqual([...accepted].sort());
	} finally {
		policy.close();
		Reflect.deleteProperty(globalThis, "__warmProofEvent");
	}
}, 900_000);

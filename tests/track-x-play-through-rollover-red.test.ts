import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, hex, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import {
	type HookPeer,
	readinessHoldRoom,
	type ReadinessHoldPeer,
	type ReadinessHoldRoom,
} from "./fixtures/track-x/readiness-hold-room.js";

// Track X, decision row 60: play during a rollover, on creator-trusted-settlement-v1 with the
// Grid zone application, a creator and one Writer on the node SQLite host.
//
// Every shipped harness pauses play while the creator seals, exports and adopts and the Writer
// installs. A real game does not. A Writer move made during the creator's seal or adoption is
// outside the sealed cut, so the Writer's settlement plan rebases it at the Writer's install, and
// the install drain replaces it in the new epoch. A recipient must never go deaf (G28), and a
// move must not be lost: the Writer stays live and its move reaches the creator, as a replacement.
//
// The last case is an order no shipped harness uses: the Writer installs the successor and plays
// before the creator adopts it. Its first rows reach the creator's sealed plane and are dropped;
// its next move reaches the creator's new plane during the adoption, before the creator's
// settlement fence, with a dependency the creator does not hold yet. The creator must stay live
// and admit the Writer's rows once it holds them.

const SETTLE_MS = 300;
const RETRY_MS = 50;
const STREAM_CAP = 40;
// Opt-in scale for the proof runs: more rollovers, and an optional pause between the Writer's
// moves (0, the default, plays back to back).
const STREAM_EPOCHS = Number(process.env.TRACK_X_PLAY_THROUGH_EPOCHS ?? 3);
const STREAM_PACE_MS = Number(process.env.TRACK_X_PLAY_THROUGH_PACE_MS ?? 0);

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Rows = readonly DurableIssuanceOutboxRecord[];

const blockIds = (peer: ReadinessHoldPeer): string[] =>
	(peer.room.projection() as unknown as { blocks: readonly { id: string }[] }).blocks.map((block) => block.id);

const settled = <T>(promise: Promise<T>): Promise<string> =>
	promise.then(
		() => "ok",
		(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
	);

interface Room {
	fixture: ReadinessHoldRoom;
	creator: ReadinessHoldPeer;
	writer: ReadinessHoldPeer;
	/** Each peer's last author sequence delivered to the other peer. */
	delivered: [number | null, number | null];
}

/**
 * Opens the creator and the Writer.
 * @param onCreatorProjection - Optional observer of the creator's projections.
 * @returns The room.
 */
async function openRoom(onCreatorProjection?: (peer: HookPeer) => void): Promise<Room> {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0, onCreatorProjection === undefined ? {} : { onProjection: onCreatorProjection });
	const writer = await fixture.open(1);
	return { fixture, creator, writer, delivered: [null, null] };
}

/**
 * Plays four moves, alternating creator and Writer, each delivered to the other peer and admitted.
 * @param room - The room.
 * @param label - Block id prefix.
 */
async function play(room: Room, label: string): Promise<void> {
	for (let ordinal = 0; ordinal < 4; ordinal++) {
		const index = ordinal % 2;
		const peer = index === 0 ? room.creator : room.writer;
		await peer.room.issue({
			action: "placeBlock",
			id: `${label}-${index}-${ordinal >> 1}`,
			kind: "stone",
			x: 2,
			y: index,
		});
		await deliver(room, index);
	}
}

/**
 * Delivers every row a peer published since the last delivery to the other peer as gossip, and
 * waits until the last one is admitted.
 * @param room - The room.
 * @param index - The sending peer.
 */
async function deliver(room: Room, index: 0 | 1): Promise<void> {
	const rows = await room.fixture.publishedAfter(index, room.delivered[index]);
	if (rows.length === 0) return;
	await (index === 0 ? room.writer : room.creator).receive(rows, index);
	room.delivered[index] = required(rows.at(-1)).commit.authorSequence;
}

/**
 * Exports the creator's adopted successor and installs it on the Writer.
 * @param room - The room.
 * @returns "ok", or the install's failure.
 */
async function install(room: Room): Promise<string> {
	const transfer = await settlementDelivery(room.fixture as unknown as SettlementRoom);
	Reflect.set(room.writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	return settled(room.writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers }));
}

/**
 * Both peers stay live: each plays a move the other admits, and both projections agree.
 * @param room - The room.
 * @param label - Block id prefix.
 */
async function expectLive(room: Room, label: string): Promise<void> {
	await room.writer.room.issue({ action: "placeBlock", id: `${label}-writer`, kind: "stone", x: 50, y: 1 });
	await deliver(room, 1);
	await room.creator.room.issue({ action: "placeBlock", id: `${label}-creator`, kind: "stone", x: 50, y: 0 });
	await deliver(room, 0);
	expect(room.writer.room.projection()).toEqual(room.creator.room.projection());
	expect(blockIds(room.creator)).toEqual(expect.arrayContaining([`${label}-writer`, `${label}-creator`]));
}

it("a Writer move made during the creator's seal is replaced at the Writer's install; the Writer stays live", async () => {
	const room = await openRoom();
	await play(room, "epoch-0");
	await sleep(SETTLE_MS);
	const sealing = room.creator.room.sealEpoch();
	// The Writer plays while the creator seals. Its move reaches the creator only after the seal
	// (network delay), so it is outside the cut, and the creator's sealed plane drops it.
	await room.writer.room.issue({ action: "placeBlock", id: "writer-during-seal", kind: "gold", x: 9, y: 9 });
	const sealed = await sealing;
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	room.creator.inject(await room.fixture.publishedAfter(1, room.delivered[1]), 1);
	await room.creator.room.adoptCreatorSuccessor();
	expect(room.creator.room.authority()?.epoch).toBe(1);

	expect(await install(room), "the Writer's install drain replaces the move").toBe("ok");
	expect(room.writer.room.authority()?.epoch).toBe(1);
	await deliver(room, 1);
	expect(blockIds(room.creator), "the move reaches the creator as its replacement").toContain("writer-during-seal");
	expect(room.writer.room.projection()).toEqual(room.creator.room.projection());
	await expectLive(room, "epoch-1");
}, 240_000);

it("a Writer move made during the creator's adoption is replaced at the Writer's install; the Writer stays live", async () => {
	const room = await openRoom();
	await play(room, "epoch-0");
	await sleep(SETTLE_MS);
	const sealed = await room.creator.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	const adopting = settled(room.creator.room.adoptCreatorSuccessor());
	// The Writer, still in epoch 0, plays while the creator adopts; its move reaches the creator
	// at once, during the adoption.
	await room.writer.room.issue({ action: "placeBlock", id: "writer-during-adopt", kind: "gold", x: 9, y: 9 });
	room.creator.inject(await room.fixture.publishedAfter(1, room.delivered[1]), 1);
	expect(await adopting).toBe("ok");
	expect(room.creator.room.authority()?.epoch).toBe(1);

	expect(await install(room), "the Writer's install drain replaces the move").toBe("ok");
	expect(room.writer.room.authority()?.epoch).toBe(1);
	await deliver(room, 1);
	expect(blockIds(room.creator), "the move reaches the creator as its replacement").toContain("writer-during-adopt");
	expect(room.writer.room.projection()).toEqual(room.creator.room.projection());
	await expectLive(room, "epoch-1");
}, 240_000);

it(
	`continuous play: a Writer moving back to back through ${STREAM_EPOCHS} rollovers stays live and loses no move`,
	async () => {
		const room = await openRoom();
		const placed: string[] = [];
		const failures: string[] = [];
		for (let epoch = 0; epoch < STREAM_EPOCHS; epoch++) {
			await play(room, `epoch-${epoch}`);
			await sleep(SETTLE_MS);
			// The Writer plays from the creator's seal until its own install ends, one move after
			// another, and each move is gossiped to the creator at once. On the node host the seal,
			// adoption and install run as long chains of microtasks that starve timers, so a paced
			// stream would not move during them; back-to-back moves interleave with them.
			let rolling = true;
			const start = performance.now();
			const at = (): number => Math.round(performance.now() - start);
			const timeline: string[] = [];
			const stream = (async (): Promise<void> => {
				let sequence = 0;
				let after: number | null = room.delivered[1];
				while (rolling && sequence < STREAM_CAP) {
					const id = `stream-${epoch}-${sequence++}`;
					const issuedAt = at();
					const issued = await settled(
						room.writer.room.issue({ action: "placeBlock", id, kind: "glass", x: 20 + (sequence % 20), y: 1 })
					);
					timeline.push(`${id}@${issuedAt}-${at()}:${issued === "ok" ? "ok" : "failed"}`);
					if (issued !== "ok") {
						failures.push(`${id}: ${issued}`);
						await sleep(RETRY_MS);
						continue;
					}
					placed.push(id);
					const rows: Rows = await room.fixture.publishedAfter(1, after);
					if (rows.length !== 0) {
						room.creator.inject(rows, 1);
						after = required(rows.at(-1)).commit.authorSequence;
					}
					if (STREAM_PACE_MS > 0) await sleep(STREAM_PACE_MS);
				}
			})();
			const transition = (async (): Promise<string> => {
				const sealed = await room.creator.room.sealEpoch();
				timeline.push(`sealed@${at()}`);
				if ((sealed as { ok?: boolean }).ok !== true) return `seal failed: ${JSON.stringify(sealed)}`;
				const adopted = await settled(room.creator.room.adoptCreatorSuccessor());
				timeline.push(`adopted@${at()}`);
				if (adopted !== "ok") return `adoption ${adopted}`;
				const installed = await install(room);
				timeline.push(`installed@${at()}`);
				return installed === "ok" ? "ok" : `install ${installed}`;
			})().finally(() => {
				rolling = false;
			});
			const outcome = await transition;
			await stream;
			console.log(`TRACK_X_PLAY_THROUGH_EPOCH ${JSON.stringify({ epoch: epoch + 1, outcome, timeline })}`);
			expect(outcome, `rollover to epoch ${epoch + 1}`).toBe("ok");
			expect(room.writer.room.authority()?.epoch).toBe(epoch + 1);
			// The Writer's rows of the new epoch (its fence, the replacements, its moves) reach the
			// creator, then both play on.
			await deliver(room, 1);
		}
		await expectLive(room, "after-stream");
		console.log(`TRACK_X_PLAY_THROUGH ${JSON.stringify({ placed: placed.length, failures: failures.slice(0, 5) })}`);
		expect(placed.length, "the Writer played during the rollovers").toBeGreaterThan(STREAM_EPOCHS);
		const atCreator = new Set(blockIds(room.creator));
		expect(
			placed.filter((id) => !atCreator.has(id)),
			"every move the Writer made reaches the creator"
		).toEqual([]);
	},
	Math.max(600_000, STREAM_EPOCHS * 120_000)
);

it("fixture-only order: a Writer that installs and plays before the creator adopts leaves the creator live", async () => {
	const state: { armed: boolean; rows: Rows; delivered: boolean } = { armed: false, rows: [], delivered: false };
	// Once armed, the creator's first projection (its adoption's successor projection, before its
	// settlement drain) delivers the Writer's rows as gossip.
	const room = await openRoom((peer) => {
		if (!state.armed) return;
		state.armed = false;
		state.delivered = true;
		peer.inject(state.rows, 1);
	});
	await play(room, "epoch-0");
	await sleep(SETTLE_MS);
	const sealed = await room.creator.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	expect(await install(room)).toBe("ok");
	expect(room.writer.room.authority()?.epoch).toBe(1);
	await room.writer.room.issue({ action: "placeBlock", id: "writer-first", kind: "gold", x: 9, y: 9 });
	const first = await room.fixture.publishedAfter(1, room.delivered[1]);
	// The Writer's fence and first move reach the creator's sealed plane and are dropped.
	room.creator.inject(first, 1);
	await room.writer.room.issue({ action: "placeBlock", id: "writer-second", kind: "gold", x: 10, y: 9 });
	const all = await room.fixture.publishedAfter(1, room.delivered[1]);
	state.rows = all.slice(first.length);
	state.armed = true;
	const adopted = await settled(room.creator.room.adoptCreatorSuccessor());
	expect(state.delivered, "the second move reached the creator during its adoption").toBe(true);
	expect(adopted, "the creator's adoption").toBe("ok");
	expect(room.creator.room.authority()?.epoch).toBe(1);
	// The creator obtains the rows it is missing (as a retained-history answer would bring them).
	const last = hex(required(all.at(-1)).commit.envelope.digest);
	room.creator.injectRetained(all, 1);
	const deadline = performance.now() + 30_000;
	while (!room.creator.accepted.has(last) && performance.now() < deadline) await sleep(5);
	expect(room.creator.accepted.has(last), "the Writer's moves are admitted").toBe(true);
	room.delivered[1] = required(all.at(-1)).commit.authorSequence;
	expect(blockIds(room.creator)).toEqual(expect.arrayContaining(["writer-first", "writer-second"]));
	await expectLive(room, "epoch-1");
}, 240_000);

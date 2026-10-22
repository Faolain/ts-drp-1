import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import {
	readinessHoldRoom,
	type ReadinessHoldPeer,
	type ReadinessHoldRoom,
} from "./fixtures/track-x/readiness-hold-room.js";

// Track X, decision row 60, R5: a Writer move made during the creator's seal is outside the
// sealed cut. It stays in the Writer's journal scope of that epoch, and the Writer's install
// replaces it in the next epoch. A journal scope was collectible only when its rows were exactly
// the signed cut's membership, so every such scope stayed protected for good: one more per
// rollover with play, until the 8th exceeded the journal's seven protected scopes and the
// Writer's next install refused ("journal retirement refused: malformed-input"). The owner's
// decision (option A): such a scope is collectible when every row outside the cut is a local
// source this author replaced, whose replacement is a member of a later signed cut and equals the
// source's derivation by the original policy. Grid zone application, creator-trusted-settlement-v1,
// the creator and one Writer on the node SQLite host.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const SETTLE_MS = 300;
const EPOCHS = Number(process.env.TRACK_X_R5_EPOCHS ?? 12);
// The journal keeps the current scope and the two before it for replay, and a scope whose
// replacement is not in a signed cut yet; anything beyond that grows with room age.
const PROTECTED_BOUND = 4;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const blockIds = (peer: ReadinessHoldPeer): string[] =>
	(peer.room.projection() as unknown as { blocks: readonly { id: string }[] }).blocks.map((block) => block.id);

interface Room {
	fixture: ReadinessHoldRoom;
	creator: ReadinessHoldPeer;
	writer: ReadinessHoldPeer;
	delivered: [number | null, number | null];
}

async function deliver(room: Room, index: 0 | 1): Promise<void> {
	const rows: readonly DurableIssuanceOutboxRecord[] = await room.fixture.publishedAfter(index, room.delivered[index]);
	if (rows.length === 0) return;
	for (let start = 0; start < rows.length; start += 16)
		await (index === 0 ? room.writer : room.creator).receive(rows.slice(start, start + 16), index);
	room.delivered[index] = required(rows.at(-1)).commit.authorSequence;
}

async function play(room: Room, label: string): Promise<void> {
	for (let ordinal = 0; ordinal < 4; ordinal++) {
		const index = (ordinal % 2) as 0 | 1;
		await (index === 0 ? room.creator : room.writer).room.issue({
			action: "placeBlock",
			id: `${label}-${index}-${ordinal >> 1}`,
			kind: "stone",
			x: 2,
			y: index,
		});
		await deliver(room, index);
	}
}

/** The epochs of the Writer's protected journal scopes in its last completed retirement. */
async function writerProtectedEpochs(room: Room): Promise<number[]> {
	const journal = await room.fixture.host.storageHost.openJournal("peer-1");
	try {
		const read = await required(journal.readRetirementImage)({ objectId: room.fixture.objectId });
		if (!read.ok) throw new TypeError(`TRACK_X_R5_JOURNAL_READ:${read.kind}`);
		return (read.value.control?.completed?.protectedScopes ?? []).map((scope) => scope.epoch);
	} finally {
		await journal.close();
	}
}

it(`a Writer that moves during every seal keeps its protected journal scopes bounded through ${EPOCHS} rollovers`, async () => {
	const fixture = await readinessHoldRoom();
	const room: Room = {
		fixture,
		creator: await fixture.open(0),
		writer: await fixture.open(1),
		delivered: [null, null],
	};
	const history: string[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await play(room, `epoch-${epoch}`);
		await sleep(SETTLE_MS);
		const sealing = room.creator.room.sealEpoch();
		// Outside the cut: the creator receives it only after the seal.
		await room.writer.room.issue({ action: "placeBlock", id: `seal-${epoch}`, kind: "gold", x: 9, y: epoch });
		expect((await sealing) as { ok?: boolean }).toMatchObject({ ok: true });
		// The creator's sealed plane drops it, so nothing waits for its admission.
		const outside = await fixture.publishedAfter(1, room.delivered[1]);
		room.creator.inject(outside, 1);
		room.delivered[1] = required(outside.at(-1)).commit.authorSequence;
		await room.creator.room.adoptCreatorSuccessor();
		const transfer = await settlementDelivery(fixture as unknown as SettlementRoom);
		Reflect.set(room.writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
		const installed = await room.writer.room
			.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers })
			.then(
				() => "ok",
				(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
			);
		const protectedEpochs = await writerProtectedEpochs(room);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${protectedEpochs.join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		// The replacement reaches the creator before its next seal, so the next cut holds it.
		await deliver(room, 1);
		expect(blockIds(room.creator)).toContain(`seal-${epoch}`);
		expect(protectedEpochs.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	}
	console.log(`TRACK_X_R5 ${JSON.stringify(history)}`);
	expect(room.writer.room.projection()).toEqual(room.creator.room.projection());
}, 900_000);

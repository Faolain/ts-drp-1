import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, hex, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import {
	readinessHoldRoom,
	type ReadinessHoldPeer,
	type ReadinessHoldRoom,
} from "./fixtures/track-x/readiness-hold-room.js";

// Track X, decision row 60, R5 (owner's option A) refusal cases on the node SQLite host (Grid zone
// application, creator-trusted-settlement-v1). A Writer's journal scope holding rows outside its
// signed Cut becomes collectible only when every outside row is this author's own replaced source
// whose replacement is a member of a later signed Cut and equals the source's derivation by the
// immutable policy. Otherwise the scope, with the outside row, is retained:
// (a) its replacement missed the next Cut (and was itself replaced): the scope stays retained.
//     Under that rule the replacement's own scope is collected meanwhile, and the Writer's plan
//     still names the retired replacement: its 6th install after the miss is refused (RESULT
//     section 13, "R5-chain"), so this case stops at the 5th;
// (b) its durable plan entry names a replacement whose operations are not the derivation: the
//     source is never accepted as replaced, so nothing of the scope is deleted;
// (c) the outside row is another Writer's move, received: the scope stays retained (with two
//     Writers playing through every seal this repeats each epoch; see RESULT section 13, R5b).

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const SETTLE_MS = 300;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Room {
	fixture: ReadinessHoldRoom;
	peers: ReadinessHoldPeer[];
	delivered: (number | null)[];
}

const blockIds = (peer: ReadinessHoldPeer): string[] =>
	(peer.room.projection() as unknown as { blocks: readonly { id: string }[] }).blocks.map((block) => block.id);

async function open(writers = 1): Promise<Room> {
	const fixture = await readinessHoldRoom({ writers });
	const peers: ReadinessHoldPeer[] = [];
	for (let index = 0; index <= writers; index++) peers.push(await fixture.open(index));
	return { fixture, peers, delivered: peers.map(() => null) };
}

/** Whether a signed row carries a protocol control operation (an author fence, not a move). */
const isControl = (row: DurableIssuanceOutboxRecord): boolean => {
	const operation = (
		decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation?: { action?: unknown } }
	).operation;
	return typeof operation?.action === "string" && operation.action.startsWith("$drp.");
};

/**
 * Delivers a peer's new rows to the other peers (or to `to`) and waits for their admission. The
 * room reports admitted moves, not control rows, so trailing control rows (a Writer's settlement
 * fence after an install with nothing to replace) are handed over without waiting; the next move,
 * which depends on them, is admitted only after them.
 */
async function deliver(
	room: Room,
	from: number,
	to?: readonly number[]
): Promise<readonly DurableIssuanceOutboxRecord[]> {
	const rows = await room.fixture.publishedAfter(from, room.delivered[from] ?? null);
	if (rows.length === 0) return rows;
	for (const [index, peer] of room.peers.entries()) {
		if (index === from || (to !== undefined && !to.includes(index))) continue;
		for (let start = 0; start < rows.length; start += 16) {
			const chunk = rows.slice(start, start + 16);
			const last = chunk.findLastIndex((row) => !isControl(row));
			if (last >= 0)
				await peer.receive(chunk.slice(0, last + 1), from).catch((error: unknown) => {
					const sequences = chunk.map((row) => row.commit.authorSequence);
					throw new TypeError(`${String(error)} delivering ${from}:[${sequences.join(",")}] to ${index}`);
				});
			peer.inject(chunk.slice(last + 1), from);
		}
	}
	room.delivered[from] = required(rows.at(-1)).commit.authorSequence;
	return rows;
}

/** One move per peer, each delivered to every other peer. */
async function play(room: Room, label: string, players: readonly number[] = room.peers.map((_, index) => index)) {
	for (const index of players) {
		await required(room.peers[index]).room.issue({
			action: "placeBlock",
			id: `${label}-${index}`,
			kind: "stone",
			x: 2,
			y: index,
		});
		await deliver(room, index);
	}
}

/** The creator seals while `outside` (a Writer) moves; the creator's sealed plane drops that move. */
async function seal(room: Room, epoch: number, outside: number | undefined, alsoTo: readonly number[] = []) {
	await sleep(SETTLE_MS);
	const creator = required(room.peers[0]);
	const sealing = creator.room.sealEpoch();
	if (outside !== undefined)
		await required(room.peers[outside]).room.issue({
			action: "placeBlock",
			id: `seal-${epoch}-${outside}`,
			kind: "gold",
			x: 9,
			y: epoch,
		});
	expect((await sealing) as { ok?: boolean }).toMatchObject({ ok: true });
	if (outside === undefined) return;
	const rows = await room.fixture.publishedAfter(outside, room.delivered[outside] ?? null);
	creator.inject(rows, outside);
	// Another Writer, still in the sealed epoch, admits the move.
	for (const index of alsoTo) await required(room.peers[index]).receive(rows, outside);
	room.delivered[outside] = required(rows.at(-1)).commit.authorSequence;
}

async function install(room: Room, writer: number): Promise<string> {
	const transfer = await settlementDelivery(room.fixture as unknown as SettlementRoom, writer);
	const peer = required(room.peers[writer]);
	Reflect.set(peer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	return peer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers }).then(
		() => "ok",
		(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
	);
}

/** The epochs of a peer's protected journal scopes in its last completed retirement. */
async function protectedEpochs(room: Room, index: number): Promise<number[]> {
	const journal = await room.fixture.host.storageHost.openJournal(`peer-${index}`);
	try {
		const read = await required(journal.readRetirementImage)({ objectId: room.fixture.objectId });
		if (!read.ok) throw new TypeError(`TRACK_X_R5_JOURNAL_READ:${read.kind}`);
		return (read.value.control?.completed?.protectedScopes ?? []).map((scope) => scope.epoch);
	} finally {
		await journal.close();
	}
}

/** Whether a peer's journal still holds an accepted row with this vertex digest. */
async function journalHolds(room: Room, index: number, digest: Uint8Array): Promise<boolean> {
	const journal = await room.fixture.host.storageHost.openJournal(`peer-${index}`);
	try {
		const read = await required(journal.readRetirementImage)({ objectId: room.fixture.objectId });
		if (!read.ok) throw new TypeError(`TRACK_X_R5_JOURNAL_READ:${read.kind}`);
		const wanted = hex(digest);
		return read.value.canonicalRows.some((bytes) => {
			const frame = decodeCanonical(bytes) as [string, unknown, Record<string, unknown>];
			return (
				(frame[0] === "accepted_entries" || frame[0] === "acceptedEntries") &&
				(frame[2].vertex_digest ?? frame[2].vertexDigest) === wanted
			);
		});
	} finally {
		await journal.close();
	}
}

it("(a) a scope whose outside move's replacement missed the next signed Cut stays retained", async () => {
	const room = await open();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	const MISSED = 1;
	let source: DurableIssuanceOutboxRecord | undefined;
	const EPOCHS = 6;
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		// The Writer does not move in the epoch after the missed one: its moves would depend on
		// the withheld replacement, which the creator never admits.
		await play(room, `epoch-${epoch}`, epoch === MISSED + 1 ? [0] : [0, 1]);
		await seal(room, epoch, 1);
		if (epoch === MISSED)
			source = (await room.fixture.publishedAfter(1, null)).find(
				(row) => row.commit.authorSequence === room.delivered[1]
			);
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${(await protectedEpochs(room, 1)).join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		// The missed epoch's replacement reaches the creator only during its next seal, which drops
		// it (the Writer's settlement fence arrives in time); its next install replaces it in turn.
		if (epoch === MISSED) {
			const fence = required((await room.fixture.publishedAfter(1, room.delivered[1]))[0]);
			expect(isControl(fence)).toBe(true);
			// No admission report exists for a control row; the seal's settle covers its admission (had
			// it missed the Cut too, the next install would refuse: RESULT section 13, "R6").
			creator.inject([fence], 1);
			room.delivered[1] = fence.commit.authorSequence;
		} else await deliver(room, 1);
	}
	console.log(`TRACK_X_R5_REFUSAL_A ${JSON.stringify(history)}`);
	// The move converged through the replacement of its replacement.
	expect(blockIds(creator)).toContain(`seal-${MISSED}-1`);
	const kept = await protectedEpochs(room, 1);
	expect(kept, history.join("\n")).toContain(MISSED);
	expect(await journalHolds(room, 1, required(source).commit.envelope.digest)).toBe(true);
	// The other epochs' scopes, whose replacements made the next Cut, were collected.
	expect(kept.filter((epoch) => epoch !== MISSED && epoch < EPOCHS - 3)).toEqual([]);
}, 900_000);

it("(c) a scope holding another Writer's move outside the Cut stays retained", async () => {
	const room = await open(2);
	const creator = required(room.peers[0]);
	const history: string[] = [];
	const OUTSIDE = 1;
	let received: DurableIssuanceOutboxRecord | undefined;
	for (let epoch = 0; epoch < 6; epoch++) {
		await play(room, `epoch-${epoch}`);
		// Writer 2 moves during this seal; Writer 1, still in the sealed epoch, admits it.
		await seal(room, epoch, epoch === OUTSIDE ? 2 : undefined, epoch === OUTSIDE ? [1] : []);
		if (epoch === OUTSIDE)
			received = (await room.fixture.publishedAfter(2, null)).find(
				(row) => row.commit.authorSequence === room.delivered[2]
			);
		await creator.room.adoptCreatorSuccessor();
		const installed = [await install(room, 1), await install(room, 2)];
		history.push(
			`epoch ${epoch + 1}: ${installed.join(",")}; writer-1 protected [${(await protectedEpochs(room, 1)).join(",")}]`
		);
		expect(installed, history.join("\n")).toEqual(["ok", "ok"]);
		await deliver(room, 1);
		await deliver(room, 2);
	}
	console.log(`TRACK_X_R5_REFUSAL_C ${JSON.stringify(history)}`);
	expect(blockIds(creator)).toContain(`seal-${OUTSIDE}-2`);
	expect(await protectedEpochs(room, 1), history.join("\n")).toContain(OUTSIDE);
	expect(await journalHolds(room, 1, required(received).commit.envelope.digest)).toBe(true);
}, 900_000);

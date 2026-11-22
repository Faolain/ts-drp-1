// Review fixture copied from Track X 128b066e; existing tests are untouched.
import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { expect } from "vitest";

import { hex, required } from "../track-m/room-retention-fixture.js";
import { settlementDelivery, type SettlementRoom } from "./settlement-room.js";
import { readinessHoldRoom, type ReadinessHoldPeer, type ReadinessHoldRoom } from "./readiness-hold-room.js";
import { creatorCurrency } from "../creator-currency.js";

// Track X, decision row 60 (R5, R5b, R5-chain, R6): the creator and one or more Writers on the node
// SQLite host (Grid zone application, creator-trusted-settlement-v1), with manual delivery of
// signed rows, so a test chooses which rows reach which peer before or after the creator's seal.

export const SETTLE_MS = 300;
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface OutsideRowsRoom {
	fixture: ReadinessHoldRoom;
	peers: ReadinessHoldPeer[];
	/** Per peer, the last author sequence handed to the others. */
	delivered: (number | null)[];
}

export const blockIds = (peer: ReadinessHoldPeer): string[] =>
	(peer.room.projection() as unknown as { blocks: readonly { id: string }[] }).blocks.map((block) => block.id);

/**
 * Opens the creator (peer 0) and `writers` Writers.
 * @param writers - Non-creator Writers.
 * @returns The room.
 */
export async function openOutsideRowsRoom(
	writers = 1,
	policy: "rebase" | "expire" = "rebase"
): Promise<OutsideRowsRoom> {
	const fixture = await readinessHoldRoom({ writers, policy });
	const peers: ReadinessHoldPeer[] = [];
	for (let index = 0; index <= writers; index++) peers.push(await fixture.open(index));
	return { fixture, peers, delivered: peers.map(() => null) };
}

/**
 * Whether a signed row carries a protocol control operation (an author fence, not a move).
 * @param row - The signed row.
 * @returns Whether its operation is a control operation.
 */
export const isControl = (row: DurableIssuanceOutboxRecord): boolean => {
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
 * @param room - The room.
 * @param from - The sending peer.
 * @param to - The receiving peers (default: every other peer).
 * @returns The delivered rows.
 */
export async function deliver(
	room: OutsideRowsRoom,
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

/**
 * One move per player, each delivered to every other peer.
 * @param room - The room.
 * @param label - The move id prefix.
 * @param players - The moving peers (default: every peer).
 */
export async function play(
	room: OutsideRowsRoom,
	label: string,
	players: readonly number[] = room.peers.map((_, index) => index)
): Promise<void> {
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

/**
 * The creator seals while each `outside` Writer moves; the creator's sealed plane drops those moves.
 * @param room - The room.
 * @param epoch - The sealed epoch (names the moves `seal-<epoch>-<writer>`).
 * @param outside - The Writers that move during the seal.
 * @param alsoTo - Writers, still in the sealed epoch, that admit those moves.
 */
export async function seal(
	room: OutsideRowsRoom,
	epoch: number,
	outside: readonly number[] = [],
	alsoTo: readonly number[] = []
): Promise<void> {
	await sleep(SETTLE_MS);
	const creator = required(room.peers[0]);
	const sealing = creator.room.sealEpoch();
	for (const index of outside)
		await required(room.peers[index]).room.issue({
			action: "placeBlock",
			id: `seal-${epoch}-${index}`,
			kind: "gold",
			x: 9,
			y: epoch * 4 + index,
		});
	expect((await sealing) as { ok?: boolean }).toMatchObject({ ok: true });
	for (const index of outside) {
		const rows = await room.fixture.publishedAfter(index, room.delivered[index] ?? null);
		creator.inject(rows, index);
		for (const other of alsoTo) if (other !== index) await required(room.peers[other]).receive(rows, index);
		room.delivered[index] = required(rows.at(-1)).commit.authorSequence;
	}
}

/**
 * A Writer installs the creator's adopted successor.
 * @param room - The room.
 * @param writer - The installing Writer.
 * @returns "ok", or the failure.
 */
export async function install(room: OutsideRowsRoom, writer: number): Promise<string> {
	const transfer = await settlementDelivery(room.fixture as unknown as SettlementRoom, writer);
	const peer = required(room.peers[writer]);
	Reflect.set(peer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	return peer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers, ...creatorCurrency(required(room.peers[0]).room) }).then(
		() => "ok",
		(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
	);
}

/**
 * The epochs of a peer's protected journal scopes in its last completed retirement.
 * @param room - The room.
 * @param index - The peer.
 * @returns The protected scopes' epochs.
 */
export async function protectedEpochs(room: OutsideRowsRoom, index: number): Promise<number[]> {
	const journal = await room.fixture.host.storageHost.openJournal(`peer-${index}`);
	try {
		const read = await required(journal.readRetirementImage)({ objectId: room.fixture.objectId });
		if (!read.ok) throw new TypeError(`TRACK_X_R5_JOURNAL_READ:${read.kind}`);
		return (read.value.control?.completed?.protectedScopes ?? []).map((scope) => scope.epoch);
	} finally {
		await journal.close();
	}
}

/**
 * Whether a peer's journal still holds an accepted row with this vertex digest.
 * @param room - The room.
 * @param index - The peer.
 * @param digest - The vertex digest.
 * @returns Whether the row is held.
 */
export async function journalHolds(room: OutsideRowsRoom, index: number, digest: Uint8Array): Promise<boolean> {
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

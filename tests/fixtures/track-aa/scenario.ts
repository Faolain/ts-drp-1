/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the existing native capability signatures. */
import type { Message } from "@ts-drp/types";

import { type CreatorDeliveryRoom, envelopeVertex, eventually, sleep } from "./creator-delivery-room.js";
import { required } from "../track-m/room-retention-fixture.js";

// Track AA scenario helpers shared by the RED and proof tests.

// Every peer's open-time retained-request schedule (room-network.ts RETAINED_REQUEST_DELAYS)
// ends 15 s after its transport opens. A scenario that runs after it models a creator
// blocked past the Writer's last scheduled retry.
export const SETTLE_MS = Number(process.env.TRACK_AA_SETTLE_MS ?? 16_000);
// How long the creator may take, after its admission is released, to admit every row.
export const DELIVERY_MS = Number(process.env.TRACK_AA_DELIVERY_MS ?? 20_000);

export type OpenedPeer = Awaited<ReturnType<CreatorDeliveryRoom["open"]>>;

/**
 * Issue Grid placements on one peer, one vertex each (sequential issues are not batched).
 * @param peer - The issuing peer.
 * @param prefix - Block identity prefix.
 * @param count - Number of placements.
 * @param row - Grid row offset.
 * @returns The block identities, in issue order.
 */
export async function place(peer: OpenedPeer, prefix: string, count: number, row = 0): Promise<string[]> {
	const ids: string[] = [];
	for (let index = 0; index < count; index++) {
		const id = `${prefix}-${index}`;
		await peer.room.issue({ action: "placeBlock", id, kind: "stone", x: index % 10, y: row + Math.floor(index / 10) });
		ids.push(id);
	}
	return ids;
}

/**
 * The signed rows one peer sent for the given placements, in issue order.
 * @param fixture - The room.
 * @param peer - The issuing peer.
 * @param ids - Block identities.
 * @returns Digest and message of each placement's vertex.
 */
export function placedRows(
	fixture: CreatorDeliveryRoom,
	peer: OpenedPeer,
	ids: readonly string[]
): { id: string; digest: string; message: Message }[] {
	const author = required(fixture.identities[peer.index]).author;
	const byId = new Map<string, { digest: string; message: Message }>();
	for (const row of fixture.sentBy(peer.peerId, author)) {
		const operation = envelopeVertex(row.message)?.operation as Readonly<Record<string, unknown>> | undefined;
		if (operation?.action === "placeBlock" && typeof operation.id === "string" && !byId.has(operation.id))
			byId.set(operation.id, row);
	}
	return ids.map((id) => {
		const row = byId.get(id);
		if (row === undefined) throw new TypeError(`TRACK_AA_ROW_NOT_SENT ${id}`);
		return { id, ...row };
	});
}

/**
 * Wait until a peer has admitted every digest, or report how many it has.
 * @param peer - The receiving peer.
 * @param digests - Required digests.
 * @param timeoutMs - Deadline.
 * @returns How many of the digests it admitted, and whether all arrived.
 */
export async function admitted(peer: OpenedPeer, digests: readonly string[], timeoutMs = DELIVERY_MS) {
	const complete = await eventually(() => digests.every((digest) => peer.accepted.has(digest)), timeoutMs);
	return { complete, count: digests.filter((digest) => peer.accepted.has(digest)).length, of: digests.length };
}

/**
 * Open the creator and the Writers, then let every open-time schedule run out.
 * @param fixture - The room.
 * @param settle - Whether to wait for the schedules (SETTLE_MS).
 * @returns The opened peers, creator first.
 */
export async function openAll(fixture: CreatorDeliveryRoom, settle = true): Promise<OpenedPeer[]> {
	const peers: OpenedPeer[] = [];
	for (let index = 0; index < fixture.identities.length; index++) peers.push(await fixture.open(index));
	if (settle) await sleep(SETTLE_MS);
	return peers;
}

/**
 * Counts of `::v3-ingress <category> [stage]` warnings recorded since `from`.
 * @param recorded
 * @param from
 */
export function ingressWarnings(recorded: readonly unknown[][], from = 0): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const args of recorded.slice(from)) {
		if (args[0] !== "::v3-ingress") continue;
		const key = args.slice(1).join(" ");
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

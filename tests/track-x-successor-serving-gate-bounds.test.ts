import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { type ReadinessHoldPeer, readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { linkSuccessorProtocol, type SuccessorLink } from "./fixtures/track-x/successor-link.js";

// Track X, decision row 61: the bounds of the successor-serving gate (the RED is
// tests/track-x-successor-serving-gate-red.test.ts). These are proofs of the fix, not REDs; at a
// base without the gate both fail at their first assertion, because the creator serves at once.
// - Only the material request is held, after the material server has authenticated it. A manifest
//   or chunk request needs a requester the server has admitted, and before the adoption the gate
//   reports none, so such a request is refused, not held.
// - A held material request lasts at most the server's own response deadline
//   (SNAPSHOT_PULL_INACTIVITY_MS, 10 s), the same as the Writer's own material deadline. If the
//   creator has not adopted by then, the Writer's install fails, but nothing is lost: once the
//   creator adopts, the Writer's retry installs, and both play on.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const settled = <T>(promise: Promise<T>): Promise<string> =>
	promise.then(
		() => "ok",
		(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
	);

interface Room {
	creator: ReadinessHoldPeer;
	writer: ReadinessHoldPeer;
	link: SuccessorLink;
	move(from: 0 | 1, id: string, x: number): Promise<void>;
}

async function sealedRoom(): Promise<
	Room & { offer: Awaited<ReturnType<ReadinessHoldPeer["room"]["exportCreatorSuccessor"]>> }
> {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	const peers = [creator, writer] as const;
	const delivered: [number | null, number | null] = [null, null];
	const move = async (from: 0 | 1, id: string, x: number): Promise<void> => {
		await peers[from].room.issue({ action: "placeBlock", id, kind: "stone", x, y: from });
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(from, delivered[from]);
		if (rows.length === 0) return;
		await peers[from === 0 ? 1 : 0].receive(rows, from);
		delivered[from] = required(rows.at(-1)).commit.authorSequence;
	};
	const link = linkSuccessorProtocol(creator, writer);
	await move(1, "writer-0", 1);
	await move(0, "creator-0", 2);
	// Harness only, as Track M's settlement fixture: let the creator's post-admission work release
	// the journal's native read reservation before the seal.
	await sleep(300);
	const sealed = await creator.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	const offer = await creator.room.exportCreatorSuccessor();
	return { creator, writer, link, move, offer };
}

async function expectLive(room: Room, label: string): Promise<void> {
	await room.move(1, `${label}-writer`, 3);
	await room.move(0, `${label}-creator`, 4);
	expect(room.writer.room.projection()).toEqual(room.creator.room.projection());
}

/**
 * Sends one snapshot manifest request on a raw link stream.
 * @param link - The link.
 * @param manifestDigest - The successor's manifest digest.
 * @returns The response kind, or the refusal.
 */
async function requestManifest(link: SuccessorLink, manifestDigest: string): Promise<string> {
	const stream = await link.open();
	const signal = AbortSignal.timeout(10_000);
	try {
		await stream.write(encodeCanonical({ kind: "snapshot-manifest-request", manifestDigest, version: 1 }), {
			signal,
		});
		const response = decodeCanonical(await stream.read(1_048_576, { signal })) as { kind?: unknown };
		return String(response.kind);
	} catch (error) {
		return `refused: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		await stream.close();
	}
}

it("a manifest request before the creator adopts is refused, not held; after the adoption and the install it is served", async () => {
	const room = await sealedRoom();
	const cut = decodeCanonical(room.offer.exactCanonicalCutValueBytes) as { snapshotManifestDigest: string };
	// The Writer's install sends its authenticated material request first. Without the gate the
	// server answers it and admits this peer, and the manifest request below is then served.
	const installed = settled(
		room.writer.room.installCreatorSuccessor({ offer: room.offer, peers: [room.creator.networkNode.peerId] })
	);
	const deadline = performance.now() + 60_000;
	while (room.link.requests.length === 0 && performance.now() < deadline) await sleep(25);
	expect(room.link.requests.length, "the Writer's material request was sent").toBe(1);
	await sleep(500);
	const early = performance.now();
	const before = await requestManifest(room.link, cut.snapshotManifestDigest);
	expect(before, "refused before the adoption").toMatch(/^refused: /u);
	expect(performance.now() - early, "refused at once, not held").toBeLessThan(5_000);

	await room.creator.room.adoptCreatorSuccessor();
	expect(await installed, "the Writer's install").toBe("ok");
	expect(await requestManifest(room.link, cut.snapshotManifestDigest), "served after the adoption").toBe(
		"snapshot-manifest-response"
	);
	await expectLive(room, "after");
}, 240_000);

it("a held material request ends at the server's response deadline; the Writer's retry after the adoption installs", async () => {
	const room = await sealedRoom();
	const first = settled(
		room.writer.room.installCreatorSuccessor({ offer: room.offer, peers: [room.creator.networkNode.peerId] })
	);
	const firstOutcome = await first;
	console.log(`TRACK_X_GATE_BOUND ${JSON.stringify({ firstOutcome, requests: room.link.requests.length })}`);
	expect(room.link.responses, "nothing served while the creator has not adopted").toEqual([]);
	expect(firstOutcome, "the first install ends at the material deadline").toMatch(/^failed: /u);
	expect(room.writer.room.authority()?.epoch ?? 0).toBe(0);

	await room.creator.room.adoptCreatorSuccessor();
	const retried = await settled(
		room.writer.room.installCreatorSuccessor({ offer: room.offer, peers: [room.creator.networkNode.peerId] })
	);
	expect(retried, "the Writer's retry after the adoption").toBe("ok");
	expect(room.writer.room.authority()?.epoch).toBe(1);
	await expectLive(room, "after");
}, 240_000);

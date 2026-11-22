import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { SNAPSHOT_PULL_INACTIVITY_MS } from "../packages/node/src/snapshot-transfer.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	type FloorHooks,
	type ReadinessHoldPeer,
	type ReadinessHoldRoom,
	readinessHoldRoom,
} from "./fixtures/track-x/readiness-hold-room.js";
import { linkSuccessorProtocol, type SuccessorLink } from "./fixtures/track-x/successor-link.js";

// Track X, decision row 61, option E (RED first). The successor-serving gate holds a Writer's
// material request until the creator has adopted (5bd36214), within the server's own 10 s response
// deadline. Option E: no wire change; the Writer's one install retries transient material
// unavailability (a held request that ended at a deadline, a reset, no server yet) until the
// material arrives or the Writer's session closes, so no finite gate delay fails the install. The
// gate's own lifetime: a creator close or a serving replacement cancels held responses before its
// port joins their handlers; a held request of a disconnected peer is released when another
// request is admitted; a failed adoption never opens serving.
// Real Grid rooms on the node SQLite host (the readiness-hold room) and the in-memory successor
// link with real request/response framing (tests/fixtures/track-x/successor-link.ts).

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settled = <T>(promise: Promise<T>): Promise<string> =>
	promise.then(
		() => "ok",
		(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
	);
const until = async (check: () => boolean, label: string, ms = 60_000): Promise<void> => {
	const deadline = performance.now() + ms;
	while (!check() && performance.now() < deadline) await sleep(20);
	expect(check(), label).toBe(true);
};

type Offer = Awaited<ReturnType<ReadinessHoldPeer["room"]["exportCreatorSuccessor"]>>;

interface Room {
	fixture: ReadinessHoldRoom;
	/** The current creator (0) and Writer (1); a reopen replaces its entry. */
	peers: [ReadinessHoldPeer, ReadinessHoldPeer];
	link: SuccessorLink;
	offer: Offer;
	move(from: 0 | 1, id: string, x: number): Promise<void>;
	install(): Promise<string>;
}

/**
 * A creator and one Writer that have played, then the creator's seal and export (not adopted).
 * @param options - The creator's floor hooks and how the creator's port closes.
 * @returns The room.
 */
async function sealedRoom(
	options: Readonly<{ creatorFloor?: FloorHooks; joinHandlersOnClose?: boolean }> = {}
): Promise<Room> {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0, options.creatorFloor === undefined ? {} : { floor: options.creatorFloor });
	const writer = await fixture.open(1);
	const peers: [ReadinessHoldPeer, ReadinessHoldPeer] = [creator, writer];
	const delivered: [number | null, number | null] = [null, null];
	const move = async (from: 0 | 1, id: string, x: number): Promise<void> => {
		await peers[from].room.issue({ action: "placeBlock", id, kind: "stone", x, y: from });
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(from, delivered[from]);
		if (rows.length === 0) return;
		await peers[from === 0 ? 1 : 0].receive(rows, from);
		delivered[from] = required(rows.at(-1)).commit.authorSequence;
	};
	const link = linkSuccessorProtocol(creator, writer, { joinHandlersOnClose: options.joinHandlersOnClose === true });
	await move(1, "writer-0", 1);
	await move(0, "creator-0", 2);
	// Harness only, as Track M's settlement fixture: let the creator's post-admission work release
	// the journal's native read reservation before the seal.
	await sleep(300);
	const sealed = await creator.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	const offer = await creator.room.exportCreatorSuccessor();
	const install = (): Promise<string> =>
		settled(peers[1].room.installCreatorSuccessor({ offer, peers: [peers[0].networkNode.peerId] }));
	return { fixture, peers, link, offer, move, install };
}

async function expectLive(room: Room, label: string): Promise<void> {
	await room.move(1, `${label}-writer`, 3);
	await room.move(0, `${label}-creator`, 4);
	expect(room.peers[1].room.projection()).toEqual(room.peers[0].room.projection());
}

const WRITER_KINDS = new Set([
	"creator-successor-material-request",
	"snapshot-manifest-request",
	"snapshot-chunk-request",
]);
const CREATOR_KINDS = new Set([
	"creator-successor-material-response",
	"snapshot-manifest-response",
	"snapshot-chunk-response",
	// A chunk response's body: the canonical snapshot payload bytes that follow its header frame.
	"drp-snapshot-payload",
	"raw",
]);

/**
 * The link carries only the frames the protocol had before option E (no new kind either way).
 * @param link - The link.
 */
function expectNoNewWire(link: SuccessorLink): void {
	const writer = new Set(link.frames.filter(({ from }) => from === "writer").map(({ kind }) => kind));
	const creator = new Set(link.frames.filter(({ from }) => from === "creator").map(({ kind }) => kind));
	expect(
		[...writer].filter((kind) => !WRITER_KINDS.has(kind)),
		"Writer frame kinds"
	).toEqual([]);
	expect(
		[...creator].filter((kind) => !CREATOR_KINDS.has(kind)),
		"creator frame kinds"
	).toEqual([]);
}

it("one install outwaits an adoption held past two response deadlines, and is served only after it", async () => {
	let armed = false;
	let delayed = false;
	const room = await sealedRoom({
		creatorFloor: {
			beforeReserve: async () => {
				if (!armed) return;
				armed = false;
				delayed = true;
				await sleep(2 * SNAPSHOT_PULL_INACTIVITY_MS + 2_000);
			},
		},
	});
	const started = performance.now();
	const installed = room.install();
	await until(() => room.link.requests.length === 1, "the Writer's first material request");
	armed = true;
	const adoptedAt = room.peers[0].room.adoptCreatorSuccessor().then(() => performance.now());
	const outcome = await installed;
	const adopted = await adoptedAt;
	console.log(
		`TRACK_X_OUTWAIT ${JSON.stringify({
			outcome,
			delayed,
			adoptedMs: Math.round(adopted - started),
			installedMs: Math.round(performance.now() - started),
			requests: room.link.requests.map((at) => Math.round(at - started)),
			responses: room.link.responses.map((at) => Math.round(at - started)),
		})}`
	);
	expect(delayed, "the adoption was held at its floor").toBe(true);
	expect(outcome, "the one public install").toBe("ok");
	expect(room.link.requests.length, "several attempts within that install").toBeGreaterThanOrEqual(3);
	expect(room.link.responses.length, "one material response").toBe(1);
	expect(required(room.link.responses[0]), "served only after the adoption").toBeGreaterThanOrEqual(adopted - 5);
	expect(
		room.link.frames.filter(({ from, at }) => from === "creator" && at < adopted - 5),
		"nothing served before the adoption"
	).toEqual([]);
	expectNoNewWire(room.link);
	expect(room.peers[1].room.authority()?.epoch).toBe(1);
	await expectLive(room, "after");
}, 240_000);

it("a Writer whose creator adopts within one response window is served on its first request", async () => {
	const room = await sealedRoom();
	const installed = room.install();
	await until(() => room.link.requests.length === 1, "the Writer's first material request");
	await sleep(500);
	await room.peers[0].room.adoptCreatorSuccessor();
	expect(await installed).toBe("ok");
	expect(room.link.requests, "no further attempt").toHaveLength(1);
	expectNoNewWire(room.link);
	await expectLive(room, "after");
}, 240_000);

it("closing the Writer while its install waits ends the install at once", async () => {
	const room = await sealedRoom();
	const installed = room.install();
	await until(() => room.link.requests.length === 1, "the Writer's first material request");
	await sleep(300);
	const closing = performance.now();
	await room.fixture.stop(room.peers[1]);
	const closeMs = performance.now() - closing;
	const outcome = await installed;
	console.log(`TRACK_X_WRITER_CLOSE ${JSON.stringify({ closeMs: Math.round(closeMs), outcome })}`);
	expect(closeMs, "the Writer's close does not wait for an attempt's deadline").toBeLessThan(5_000);
	expect(outcome).toMatch(/^failed: /u);
	expect(room.link.responses).toEqual([]);
}, 240_000);

it("closing the creator while a response is held does not wait for the response deadline; nothing is served", async () => {
	const room = await sealedRoom({ joinHandlersOnClose: true });
	const installed = room.install();
	await until(() => room.link.requests.length === 1, "the Writer's first material request");
	await sleep(300);
	const closing = performance.now();
	await room.fixture.stop(room.peers[0]);
	const closeMs = performance.now() - closing;
	expect(room.link.activeHandlers(), "the creator's port joined its handlers").toBe(0);
	// The Writer's install keeps waiting for a source; its own close ends it.
	await sleep(1_000);
	await room.fixture.stop(room.peers[1]);
	const outcome = await installed;
	console.log(`TRACK_X_CREATOR_CLOSE ${JSON.stringify({ closeMs: Math.round(closeMs), outcome })}`);
	expect(closeMs, "the creator's close cancels the held response").toBeLessThan(5_000);
	expect(room.link.responses, "the closed session served nothing").toEqual([]);
	expect(outcome).toMatch(/^failed: /u);
}, 240_000);

it("replacing the creator's serving while a response is held does not wait; the install completes after the adoption", async () => {
	const room = await sealedRoom({ joinHandlersOnClose: true });
	const installed = room.install();
	await until(() => room.link.requests.length === 1, "the Writer's first material request");
	await sleep(300);
	const replacing = performance.now();
	const again = await room.peers[0].room.exportCreatorSuccessor();
	const replaceMs = performance.now() - replacing;
	expect(again.exactCanonicalSnapshotManifestBytes).toEqual(room.offer.exactCanonicalSnapshotManifestBytes);
	await room.peers[0].room.adoptCreatorSuccessor();
	const outcome = await installed;
	console.log(
		`TRACK_X_SERVING_REPLACED ${JSON.stringify({ replaceMs: Math.round(replaceMs), outcome, requests: room.link.requests.length })}`
	);
	expect(replaceMs, "the replacement cancels the held response").toBeLessThan(5_000);
	expect(outcome).toBe("ok");
	expect(room.link.requests.length, "the Writer asked the new serving again").toBeGreaterThanOrEqual(2);
	expect(room.link.responses).toHaveLength(1);
	await expectLive(room, "after");
}, 240_000);

it("an adoption that fails after activation never opens serving; the Writer's install waits until its close", async () => {
	let failNext = false;
	const room = await sealedRoom({
		creatorFloor: {
			beforeReserve: () => {
				if (!failNext) return;
				failNext = false;
				throw new Error("TRACK_X_ADOPTION_FLOOR_FAILED");
			},
		},
	});
	const installed = room.install();
	let ended: string | undefined;
	void installed.then((outcome) => {
		ended = outcome;
	});
	await until(() => room.link.requests.length === 1, "the Writer's first material request");
	failNext = true;
	const adoption = await settled(room.peers[0].room.adoptCreatorSuccessor());
	expect(adoption).toMatch(/TRACK_X_ADOPTION_FLOOR_FAILED/u);
	expect(await settled(room.peers[0].room.adoptCreatorSuccessor()), "the failed creator does not adopt again").toMatch(
		/^failed: /u
	);
	await sleep(2_000);
	expect(room.link.responses, "nothing served after the failed adoption").toEqual([]);
	expect(ended, "the Writer's install is still waiting for a source").toBeUndefined();
	expect(room.peers[1].room.authority()?.epoch ?? 0).toBe(0);
	await room.fixture.stop(room.peers[1]);
	expect(await installed).toMatch(/^failed: /u);
	expect(room.link.responses).toEqual([]);
}, 240_000);

it("a creator restarted after its adoption serves only after its startup readiness; a Writer install begun while it was down completes", async () => {
	const room = await sealedRoom();
	await room.peers[0].room.adoptCreatorSuccessor();
	await room.fixture.stop(room.peers[0]);
	const started = performance.now();
	const installed = room.install();
	await sleep(1_500);
	const beforeReopen = room.link.requests.length;
	let armed = true;
	let releasedAt = 0;
	const reopening = room.fixture.open(0, {
		reopen: true,
		onNetwork: (networkNode) => room.link.rebindCreator(networkNode),
		floor: {
			beforeReserve: async () => {
				if (!armed) return;
				armed = false;
				await sleep(SNAPSHOT_PULL_INACTIVITY_MS + 2_000);
				releasedAt = performance.now();
			},
		},
	});
	room.peers[0] = await reopening;
	const outcome = await installed;
	console.log(
		`TRACK_X_RESTART ${JSON.stringify({
			outcome,
			beforeReopen,
			releasedMs: Math.round(releasedAt - started),
			requests: room.link.requests.map((at) => Math.round(at - started)),
			responses: room.link.responses.map((at) => Math.round(at - started)),
		})}`
	);
	expect(outcome, "the install begun while the creator was down").toBe("ok");
	expect(releasedAt, "the reopened creator's startup reserved its floor").toBeGreaterThan(0);
	expect(required(room.link.responses[0]), "served only after the startup readiness").toBeGreaterThanOrEqual(
		releasedAt - 5
	);
	expect(room.link.responses).toHaveLength(1);
	expectNoNewWire(room.link);
	expect(room.peers[1].room.authority()?.epoch).toBe(1);
	await expectLive(room, "after");
}, 240_000);

it("a Writer restarted while its install waited installs after the creator adopts", async () => {
	const room = await sealedRoom();
	const installed = room.install();
	await until(() => room.link.requests.length === 1, "the Writer's first material request");
	await room.fixture.stop(room.peers[1]);
	expect(await installed).toMatch(/^failed: /u);
	room.peers[1] = await room.fixture.open(1, {
		reopen: true,
		onNetwork: (networkNode) => room.link.rebindWriter(networkNode),
	});
	await room.peers[0].room.adoptCreatorSuccessor();
	expect(await room.install(), "the reopened Writer's install").toBe("ok");
	expect(room.peers[1].room.authority()?.epoch).toBe(1);
	await expectLive(room, "after");
}, 240_000);

// Row 72, the owner's decision (2026-10-27): a member's successor install has a bounded total
// deadline over the material fetch (V3_ROOM_SUCCESSOR_INSTALL_DEADLINE_MS = 120 s). On expiry it ends
// with a typed refusal (V3RoomSuccessorInstallExpired, stage "material") that the delivery shows and
// re-targets from (the newest offer, or the same one again); every terminal check stays. Here the
// creator seals and exports but does not adopt: the install must end with that refusal within the
// bound, and the Writer installs once the creator adopts. (The constant is written out so this test
// does not depend on the export it pins.)
const INSTALL_DEADLINE_MS = 120_000;

it("a Writer whose creator never adopts ends its install with a typed material expiry within the bound, then installs once the creator adopts", async () => {
	const room = await sealedRoom();
	const started = performance.now();
	const installing = room.peers[1].room
		.installCreatorSuccessor({ offer: room.offer, peers: [room.peers[0].networkNode.peerId] })
		.then(
			() => ({ ok: true as const, at: performance.now() }),
			(error: unknown) => ({ ok: false as const, error, at: performance.now() })
		);
	await until(() => room.link.requests.length === 1, "the Writer's first material request");
	const outcome = await Promise.race([installing, sleep(INSTALL_DEADLINE_MS + 30_000).then(() => "still pending" as const)]);
	const error = typeof outcome === "object" && !outcome.ok ? (outcome.error as { name?: string; stage?: string }) : undefined;
	console.log(
		`TRACK_X_INSTALL_DEADLINE ${JSON.stringify({
			outcome: typeof outcome === "string" ? outcome : outcome.ok ? "ok" : `${error?.name}: ${String((outcome.error as Error)?.message).slice(0, 200)}`,
			endedMs: typeof outcome === "string" ? null : Math.round(outcome.at - started),
			requests: room.link.requests.length,
		})}`
	);
	expect(outcome, "the install ends within the deadline").not.toBe("still pending");
	expect(typeof outcome === "object" && outcome.ok, "nothing was adopted, so nothing installs").toBe(false);
	expect(error?.name).toBe("V3RoomSuccessorInstallExpired");
	expect(error?.stage).toBe("material");
	expect(room.link.responses, "nothing served before the adoption").toEqual([]);
	expect(room.peers[1].room.authority()?.epoch ?? 0, "the refused install changed nothing").toBe(0);
	// The creator adopts; the Writer's next install of the same offer succeeds.
	await room.peers[0].room.adoptCreatorSuccessor();
	expect(await room.install(), "the install after the adoption").toBe("ok");
	expect(room.peers[1].room.authority()?.epoch).toBe(1);
	expectNoNewWire(room.link);
	await expectLive(room, "after");
}, 360_000);

const DOMAIN = "ts-drp/creator-successor-transport/v1";

/**
 * Sends one signed material request on a raw link stream as another (connected) peer, and reads.
 * @param room - The room.
 * @param peerId - The requesting peer.
 * @returns How the read ended, and when.
 */
function rawMaterialRequest(room: Room, peerId: string): Promise<Readonly<{ outcome: string; at: number }>> {
	const cut = decodeCanonical(room.offer.exactCanonicalCutValueBytes) as { snapshotManifestDigest: string };
	const seed = required(room.fixture.identities[1]).seed;
	const proof = {
		kind: "creator-successor-material-request",
		version: 1,
		nonce: crypto.getRandomValues(new Uint8Array(32)),
		manifestDigest: cut.snapshotManifestDigest,
		requesterPeer: peerId,
		sourcePeer: room.peers[0].networkNode.peerId,
		author: required(room.fixture.identities[1]).author,
	};
	const signature = ed25519.sign(hashDomain(DOMAIN, encodeCanonical(proof)), seed);
	return (async () => {
		const stream = await room.link.open(peerId);
		const signal = AbortSignal.timeout(30_000);
		try {
			await stream.write(encodeCanonical({ ...proof, signature }), { signal });
			const response = decodeCanonical(await stream.read(1_048_576, { signal })) as { kind?: unknown };
			return { outcome: String(response.kind), at: performance.now() };
		} catch (error) {
			return { outcome: `ended: ${error instanceof Error ? error.message : String(error)}`, at: performance.now() };
		}
	})();
}

it("a held request of a peer that disconnected is released when another peer's request is admitted", async () => {
	const room = await sealedRoom();
	room.link.setConnected(["track-x-ghost-0"]);
	const first = rawMaterialRequest(room, "track-x-ghost-0");
	await sleep(1_000);
	room.link.setConnected(["track-x-ghost-1"]);
	const admitted = performance.now();
	const second = rawMaterialRequest(room, "track-x-ghost-1");
	const ended = await first;
	console.log(
		`TRACK_X_DISCONNECTED_HOLD ${JSON.stringify({ outcome: ended.outcome, ms: Math.round(ended.at - admitted) })}`
	);
	expect(ended.outcome, "the disconnected peer's held request ends without a response").toMatch(/^ended: /u);
	expect(ended.at - admitted, "released at the next admission, not at its deadline").toBeLessThan(5_000);
	await room.peers[0].room.adoptCreatorSuccessor();
	expect((await second).outcome, "the connected peer's held request is served").toBe(
		"creator-successor-material-response"
	);
}, 240_000);

it("a newer request from the same peer supersedes its held one", async () => {
	const room = await sealedRoom();
	room.link.setConnected(["track-x-ghost-0"]);
	const first = rawMaterialRequest(room, "track-x-ghost-0");
	await sleep(1_000);
	const again = performance.now();
	const second = rawMaterialRequest(room, "track-x-ghost-0");
	const ended = await first;
	expect(ended.outcome).toMatch(/^ended: /u);
	expect(ended.at - again).toBeLessThan(5_000);
	await room.peers[0].room.adoptCreatorSuccessor();
	expect((await second).outcome).toBe("creator-successor-material-response");
}, 240_000);

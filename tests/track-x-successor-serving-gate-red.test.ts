import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { type ReadinessHoldPeer, readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

// Track X, decision row 61 ("Gate serving"): the creator's successor material server answers
// only after the creator has adopted that successor, its adoption tail (publication, settlement
// drain, readiness) included. Today sealEpoch already serves the successor and
// exportCreatorSuccessor returns its offer with no adoption precondition, so a Writer that is
// handed the offer early installs before the creator adopts; if it then plays, the creator goes
// terminal (tests/track-x-play-through-rollover-red.test.ts, the skipped last case).
//
// The Writer reaches the creator's own room server (the one sealEpoch and exportCreatorSuccessor
// install), not the storage-level server the settlement fixtures use: each peer's network node
// gets one in-memory port of the creator-successor protocol, and the Writer's streams reach the
// creator's installed handler with real request/response framing, so the Writer's own timeouts
// apply unchanged.
//
// The Writer's install does not retry a refused material fetch (receiveCreatorSuccessorMaterial
// tries each peer once, within SNAPSHOT_PULL_INACTIVITY_MS), so the gate holds the request
// (bounded) instead of refusing it. RED today: the creator serves the material at once, before it
// adopts.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One direction of an in-memory stream: frames in order, then an end or a failure. */
class FramePipe {
	readonly #frames: Uint8Array[] = [];
	#wake: (() => void) | undefined;
	#ended = false;
	#failure: Error | undefined;

	push(frame: Uint8Array): void {
		if (this.#ended || this.#failure !== undefined) throw new TypeError("TRACK_X_GATE_PIPE_CLOSED");
		this.#frames.push(Uint8Array.from(frame));
		this.#signal();
	}

	end(): void {
		this.#ended = true;
		this.#signal();
	}

	fail(reason: Error): void {
		this.#failure ??= reason;
		this.#signal();
	}

	async next(maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
		for (;;) {
			signal.throwIfAborted();
			const frame = this.#frames.shift();
			if (frame !== undefined) {
				if (frame.byteLength > maxBytes) throw new TypeError("TRACK_X_GATE_FRAME_LIMIT");
				return frame;
			}
			if (this.#failure !== undefined) throw this.#failure;
			if (this.#ended) throw new TypeError("TRACK_X_GATE_PIPE_ENDED");
			await new Promise<void>((resolve) => {
				const onAbort = (): void => {
					this.#wake = undefined;
					resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				this.#wake = (): void => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				};
			});
		}
	}

	#signal(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}
}

function pipeStream(
	peerId: string,
	inbox: FramePipe,
	outbox: FramePipe,
	onWrite: (bytes: Uint8Array) => void
): SnapshotChunkProtocolStream {
	return {
		peerId,
		abort: (reason) => {
			const error = reason ?? new Error("TRACK_X_GATE_STREAM_ABORTED");
			inbox.fail(error);
			outbox.fail(error);
		},
		close: () => {
			outbox.end();
			return Promise.resolve();
		},
		read: (maxBytes, options) => inbox.next(maxBytes, options.signal),
		write: (bytes, options) => {
			options.signal.throwIfAborted();
			onWrite(bytes);
			outbox.push(bytes);
			return Promise.resolve();
		},
	};
}

interface SuccessorLink {
	/** Material requests the Writer sent. */
	readonly requests: number[];
	/** When the creator wrote each material response. */
	readonly responses: number[];
}

/**
 * Connects the Writer's creator-successor protocol port to the creator's.
 * @param creator - The creator peer.
 * @param writer - The Writer peer.
 * @returns The material requests and responses seen on the link.
 */
function linkSuccessorProtocol(creator: ReadinessHoldPeer, writer: ReadinessHoldPeer): SuccessorLink {
	const creatorPeer = creator.networkNode.peerId;
	const writerPeer = writer.networkNode.peerId;
	const link = { requests: [] as number[], responses: [] as number[] };
	let handler: ((stream: SnapshotChunkProtocolStream) => Promise<void>) | undefined;
	const creatorPort: SnapshotChunkProtocolPort = {
		localPeerId: creatorPeer,
		close: () => {
			handler = undefined;
			return Promise.resolve();
		},
		connectedPeers: () => [writerPeer],
		open: () => Promise.reject(new TypeError("TRACK_X_GATE_CREATOR_DOES_NOT_DIAL")),
		serve: (next) => {
			handler = next;
			return () => {
				if (handler === next) handler = undefined;
			};
		},
	};
	const writerPort: SnapshotChunkProtocolPort = {
		localPeerId: writerPeer,
		close: () => Promise.resolve(),
		connectedPeers: () => [creatorPeer],
		open: (peer, options) => {
			options.signal.throwIfAborted();
			const serve = handler;
			if (peer !== creatorPeer || serve === undefined) return Promise.reject(new TypeError("TRACK_X_GATE_NO_SERVER"));
			const toCreator = new FramePipe();
			const toWriter = new FramePipe();
			let material = false;
			const inbound = pipeStream(writerPeer, toCreator, toWriter, () => {
				if (material) link.responses.push(performance.now());
			});
			const outbound = pipeStream(creatorPeer, toWriter, toCreator, (bytes) => {
				const request = decodeCanonical(bytes) as { kind?: unknown };
				if (request?.kind === "creator-successor-material-request") {
					material = true;
					link.requests.push(performance.now());
				}
			});
			void serve(inbound);
			return Promise.resolve(outbound);
		},
		serve: () => () => undefined,
	};
	Reflect.set(creator.networkNode, "createSnapshotChunkProtocolHost", () => creatorPort);
	Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => writerPort);
	return link;
}

const blockIds = (peer: ReadinessHoldPeer): string[] =>
	(peer.room.projection() as unknown as { blocks: readonly { id: string }[] }).blocks.map((block) => block.id);

it("a Writer that fetches the successor before the creator adopts it is served only after the adoption, then installs", async () => {
	const fixture = await readinessHoldRoom();
	const creator = await fixture.open(0);
	const writer = await fixture.open(1);
	const peers = [creator, writer] as const;
	const delivered: [number | null, number | null] = [null, null];
	const deliver = async (from: 0 | 1): Promise<void> => {
		const rows: readonly DurableIssuanceOutboxRecord[] = await fixture.publishedAfter(from, delivered[from]);
		if (rows.length === 0) return;
		await peers[from === 0 ? 1 : 0].receive(rows, from);
		delivered[from] = required(rows.at(-1)).commit.authorSequence;
	};
	const move = async (from: 0 | 1, id: string, x: number): Promise<void> => {
		await peers[from].room.issue({ action: "placeBlock", id, kind: "stone", x, y: from });
		await deliver(from);
	};
	const link = linkSuccessorProtocol(creator, writer);
	await move(1, "writer-0", 1);
	await move(0, "creator-0", 2);
	// Harness only, as Track M's settlement fixture: let the creator's post-admission work release
	// the journal's native read reservation before the seal.
	await sleep(300);
	const sealed = await creator.room.sealEpoch();
	expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
	// The public export, before the creator adopts: nothing in the API prevents handing it out.
	const offer = await creator.room.exportCreatorSuccessor();
	const installed = writer.room.installCreatorSuccessor({ offer, peers: [creator.networkNode.peerId] }).then(
		() => "ok",
		(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
	);
	const asked = performance.now() + 10_000;
	while (link.requests.length === 0 && performance.now() < asked) await sleep(5);
	expect(link.requests.length, "the Writer asked the creator for the successor material").toBeGreaterThan(0);
	await sleep(500);
	expect(link.responses, "no successor material is served before the creator adopts the successor").toEqual([]);

	await creator.room.adoptCreatorSuccessor();
	const adopted = performance.now();
	expect(await installed, "the Writer's install").toBe("ok");
	expect(link.responses.length, "the material was served once the creator adopted").toBeGreaterThan(0);
	expect(required(link.responses[0]), "served after the adoption completed").toBeGreaterThanOrEqual(adopted);
	expect(creator.room.authority()?.epoch).toBe(1);
	expect(writer.room.authority()?.epoch).toBe(1);

	// Both stay live: the Writer's install rows and a move reach the creator, then the creator's.
	await move(1, "writer-1", 3);
	await move(0, "creator-1", 4);
	expect(writer.room.projection()).toEqual(creator.room.projection());
	expect(blockIds(creator)).toEqual(expect.arrayContaining(["writer-0", "creator-0", "writer-1", "creator-1"]));
}, 240_000);

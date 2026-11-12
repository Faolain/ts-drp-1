/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { ed25519 } from "@noble/curves/ed25519.js";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { afterEach, expect, it } from "vitest";

import * as material from "../packages/node/src/internal/creator-successor-transport.js";
import { SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS, SNAPSHOT_PULL_TOTAL_MS } from "../packages/node/src/snapshot-transfer.js";

// fix/creator-material-session-bound: the creator's successor-material server bounds CONCURRENT
// serving sessions (SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS), not the members it served in an epoch.
// Before, a member's entry was released only when it disconnected, so once four connected members
// had installed a successor the fifth was refused for the whole epoch (its install expired after
// 120 s, again and again); every room with five or more members stalled. A member's entry is now
// released when its serving session ends: every chunk of the manifest served to it, or its pull
// deadline (SNAPSHOT_PULL_TOTAL_MS) passed. An idle session may be evicted for a new requester only
// past CREATOR_MATERIAL_SESSION_IDLE_MS; an active one never is. A requester refused while four
// sessions are active retries by itself within seconds.

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const creatorSeed = new Uint8Array(32).fill(0xc2);
const creatorAuthor = hexOf(ed25519.getPublicKey(creatorSeed));
const manifestDigest = "d".repeat(64);
const CREATOR = "creator-peer";
const CHUNKS = 3;
const sign = (seed: Uint8Array) => (digest: Uint8Array) => Promise.resolve(ed25519.sign(digest, seed));
const members = Array.from({ length: 8 }, (_, index) => {
	const seed = new Uint8Array(32).fill(0x10 + index);
	return { peer: `member-${index}`, seed, author: hexOf(ed25519.getPublicKey(seed)) };
});
const controllers = new Set<AbortController>();
afterEach(() => {
	for (const controller of controllers) controller.abort(new Error("test ended"));
	controllers.clear();
});

const auxiliary = Object.freeze({
	exactCanonicalSettlementBytes: new Uint8Array([1, 2, 3]),
	exactCanonicalHistoryBytes: new Uint8Array([4, 5, 6]),
});

interface Pipe {
	frames: Uint8Array[];
	waiting: ((frame: Uint8Array | Error) => void) | undefined;
	failure: Error | undefined;
}
const pipe = (): Pipe => ({ frames: [], waiting: undefined, failure: undefined });
const push = (target: Pipe, frame: Uint8Array | Error): void => {
	if (frame instanceof Error) target.failure ??= frame;
	const waiting = target.waiting;
	target.waiting = undefined;
	if (waiting !== undefined) waiting(frame);
	else if (!(frame instanceof Error)) target.frames.push(frame);
};
const pull = (source: Pipe, signal: AbortSignal): Promise<Uint8Array> => {
	const next = source.frames.shift();
	if (next !== undefined) return Promise.resolve(next);
	if (source.failure !== undefined) return Promise.reject(source.failure);
	return new Promise((resolve, reject) => {
		const aborted = (): void => reject(new Error("snapshot stream was aborted"));
		signal.addEventListener("abort", aborted, { once: true });
		source.waiting = (frame) => {
			signal.removeEventListener("abort", aborted);
			if (frame instanceof Error) reject(frame);
			else resolve(frame);
		};
	});
};

/** A member's material port wired to the creator's real material server (a control failure aborts the stream). */
function portOf(server: ReturnType<typeof material.createCreatorSuccessorMaterialServer>, member: string) {
	let attempts = 0;
	const port: SnapshotChunkProtocolPort = {
		localPeerId: member,
		connectedPeers: () => [CREATOR],
		close: () => Promise.resolve(),
		serve: () => () => undefined,
		open: (peer, { signal }) => {
			signal.throwIfAborted();
			attempts++;
			const toServer = pipe();
			const toClient = pipe();
			const serverStream: SnapshotChunkProtocolStream = {
				peerId: member,
				abort: (reason) => push(toClient, reason ?? new Error("snapshot stream was aborted")),
				close: () => Promise.resolve(),
				read: (_max, options) => pull(toServer, options.signal),
				write: (bytes) => {
					push(toClient, Uint8Array.from(bytes));
					return Promise.resolve();
				},
			};
			const stream: SnapshotChunkProtocolStream = {
				peerId: peer,
				abort: () => undefined,
				close: () => Promise.resolve(),
				read: (_max, options) => pull(toClient, options.signal),
				write: (bytes) => {
					void server.control(serverStream, Uint8Array.from(bytes)).then(
						(handled) => {
							if (!handled) serverStream.abort(new Error("snapshot request was not a control frame"));
						},
						() => serverStream.abort(new Error("snapshot serving request was rejected"))
					);
					return Promise.resolve();
				},
			};
			return Promise.resolve(stream);
		},
	};
	return { port, attempts: () => attempts };
}

function serverFor(options: Readonly<{ clock?: () => number; connected?: () => readonly string[] }> = {}) {
	return material.createCreatorSuccessorMaterialServer({
		identity: {
			author: creatorAuthor,
			sign: sign(creatorSeed),
			isAuthorizedAuthor: (author) => members.some((member) => member.author === author),
		},
		localPeerId: CREATOR,
		manifestDigest,
		material: auxiliary as unknown as material.CreatorSuccessorAuxiliaryMaterial,
		connectedPeers: options.connected ?? (() => members.map(({ peer }) => peer)),
		chunkCount: CHUNKS,
		...(options.clock === undefined ? {} : { clock: options.clock }),
	} as Parameters<typeof material.createCreatorSuccessorMaterialServer>[0]);
}

/** One member's material fetch, bounded by a guard; how it ended and how long it took. */
async function fetchAs(
	server: ReturnType<typeof material.createCreatorSuccessorMaterialServer>,
	index: number,
	guardMs = 3_000
) {
	const member = members[index]!;
	const linked = portOf(server, member.peer);
	const lifetime = new AbortController();
	controllers.add(lifetime);
	const guard = setTimeout(() => lifetime.abort(new Error("MATERIAL_SESSION_GUARD")), guardMs);
	const started = performance.now();
	try {
		const outcome = await material
			.receiveCreatorSuccessorMaterial({
				transport: linked.port,
				identity: {
					author: member.author,
					sign: sign(member.seed),
					isAuthorizedAuthor: (candidate) => candidate === creatorAuthor,
				},
				peers: [CREATOR],
				manifestDigest,
				retryUntil: lifetime.signal,
			} as Parameters<typeof material.receiveCreatorSuccessorMaterial>[0])
			.then(
				() => "received" as const,
				(error: unknown) => error
			);
		return { outcome, ms: performance.now() - started, attempts: linked.attempts() };
	} finally {
		clearTimeout(guard);
	}
}

/** The snapshot owner's report that it served these chunk indices to this member (the session's progress). */
const served = (server: ReturnType<typeof material.createCreatorSuccessorMaterialServer>, index: number, indices: number[]) =>
	(server as unknown as { served?(peer: string, indices: readonly number[]): void }).served?.(members[index]!.peer, indices);
const authorized = (server: ReturnType<typeof material.createCreatorSuccessorMaterialServer>, index: number) =>
	server.authorization.authorForPeer(members[index]!.peer);

it("four members served to completion free their sessions: a fifth and more connected members are served", async () => {
	const server = serverFor();
	for (let index = 0; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index++) {
		expect((await fetchAs(server, index)).outcome).toBe("received");
		expect(authorized(server, index), "the member's chunk pulls are authorized during its session").toBe(members[index]!.author);
		served(server, index, [0, 1]);
		served(server, index, [2]);
		expect(authorized(server, index), "a completed session is released").toBeUndefined();
	}
	for (let index = SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index < members.length; index++) {
		const fifth = await fetchAs(server, index);
		expect(fifth.outcome, `member ${index} is served after earlier sessions completed`).toBe("received");
		expect(fifth.attempts).toBe(1);
		served(server, index, [0, 1, 2]);
	}
});

it("with four sessions active a fifth requester is refused, and is served within seconds once one completes", async () => {
	const server = serverFor();
	for (let index = 0; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index++) expect((await fetchAs(server, index)).outcome).toBe("received");
	// Four active sessions (none completed): the fifth is refused and retries by itself.
	const fifth = fetchAs(server, SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS, 8_000);
	await new Promise((resolve) => setTimeout(resolve, 600));
	for (let index = 0; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index++)
		expect(authorized(server, index), "an active session is never evicted").toBe(members[index]!.author);
	const completedAt = performance.now();
	served(server, 0, [0, 1, 2]);
	const result = await fifth;
	expect(result.outcome).toBe("received");
	expect(result.attempts).toBeGreaterThan(1);
	expect(performance.now() - completedAt, "the refused requester's retry comes back within seconds").toBeLessThan(3_000);
}, 15_000);

it("a partially served session is kept; an idle one is evicted for a new requester only past the idle bound", async () => {
	let now = 1_000_000;
	const server = serverFor({ clock: () => now });
	for (let index = 0; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index++) expect((await fetchAs(server, index)).outcome).toBe("received");
	served(server, 0, [0, 1]);
	// Just under the idle bound: nothing is evicted, the fifth is refused.
	now += material.CREATOR_MATERIAL_SESSION_IDLE_MS - 1;
	const refused = await fetchAs(server, 4, 600);
	expect(refused.outcome).not.toBe("received");
	// Member 1 keeps pulling (its requests are authorized, which is activity); the others go idle.
	expect(authorized(server, 1)).toBe(members[1]!.author);
	now += 2;
	const admitted = await fetchAs(server, 4);
	expect(admitted.outcome).toBe("received");
	expect(authorized(server, 1), "an active session survives the eviction").toBe(members[1]!.author);
	const evicted = [0, 2, 3].filter((index) => authorized(server, index) === undefined);
	expect(evicted.length, "exactly one idle session made room").toBe(1);
});

it("a session past its pull deadline is released even if it was never completed", async () => {
	let now = 5_000_000;
	const server = serverFor({ clock: () => now });
	for (let index = 0; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index++) expect((await fetchAs(server, index)).outcome).toBe("received");
	now += SNAPSHOT_PULL_TOTAL_MS;
	for (let index = 0; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index++)
		expect(authorized(server, index), "the member's own pull has ended by its deadline").toBeUndefined();
	expect((await fetchAs(server, 4)).outcome).toBe("received");
});

it("a disconnected member's session is released at once (unchanged)", async () => {
	let connected = members.map(({ peer }) => peer);
	const server = serverFor({ connected: () => connected });
	for (let index = 0; index < SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS; index++) expect((await fetchAs(server, index)).outcome).toBe("received");
	connected = connected.filter((peer) => peer !== members[2]!.peer);
	expect((await fetchAs(server, 4)).outcome).toBe("received");
});

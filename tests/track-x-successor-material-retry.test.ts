import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { expect, it } from "vitest";

import * as material from "../packages/node/src/internal/creator-successor-transport.js";
import { CREATOR_CLOSE_MEMBERSHIP_MAX_BYTES } from "../packages/node/src/internal/creator-close-membership.js";
import { SNAPSHOT_PULL_INACTIVITY_MS } from "../packages/node/src/snapshot-transfer.js";

// Track X, decision row 61, option E (RED first): inside one install, a Writer retries transient
// creator-successor material unavailability until the material arrives, every listed peer has
// failed terminally, or the install's lifetime ends (its `retryUntil` signal). No wire change: the
// same signed request and response frames, a fresh nonce on each attempt.
// - Transient: the attempt's own deadline, a reset or ended stream, a failed open, a peer that is
//   not connected yet. Terminal: anything about the response itself (malformed frame, wrong kind,
//   version, manifest, peers or nonce, unauthorized author, bad signature, invalid bounds) and
//   uncertain stream cleanup, which ends the whole fetch at once, as before.
// - One attempt in flight at a time; candidates rotate, so a peer that never answers cannot starve
//   one that does; reviewed pacing between rounds; streams, timers, listeners and the failures kept
//   for the diagnostic stay bounded.
// - Without `retryUntil` (callers that own no lifetime), one pass over the candidates, as before.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settled = <T>(promise: Promise<T>): Promise<string> =>
	promise.then(
		() => "ok",
		(error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`
	);

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const writerSeed = new Uint8Array(32).fill(0xa1);
const creatorSeed = new Uint8Array(32).fill(0xa2);
const strangerSeed = new Uint8Array(32).fill(0xa3);
const writerAuthor = hexOf(ed25519.getPublicKey(writerSeed));
const creatorAuthor = hexOf(ed25519.getPublicKey(creatorSeed));
const strangerAuthor = hexOf(ed25519.getPublicKey(strangerSeed));
const manifestDigest = "c".repeat(64);
const DOMAIN = "ts-drp/creator-successor-transport/v1";
const WRITER = "writer-peer";

const identity = {
	author: writerAuthor,
	sign: (digest: Uint8Array): Promise<Uint8Array> => Promise.resolve(ed25519.sign(digest, writerSeed)),
	isAuthorizedAuthor: (author: string): boolean => author === creatorAuthor,
};

it("only authenticated exact checkpoint unavailability is retryable", async () => {
	for (const change of [ { reason: "arbitrary" }, { version: 3 }, { author: strangerAuthor },
		{ manifestDigest: "0".repeat(64) }, { nonce: new Uint8Array(32) }, { signature: new Uint8Array(64) },
		{ exactCanonicalSettlementBytes: Uint8Array.of(1) } ]) {
		const scripted = fakePort(() => ({ kind: "serve", bytes: request => {
			const proof = { kind: "creator-successor-material-unavailable", version: 1, reason: "checkpoint-not-adopted",
				nonce: request.nonce, manifestDigest, requesterPeer: request.requesterPeer, sourcePeer: request.sourcePeer,
				author: creatorAuthor };
			return encodeCanonical({ ...proof, signature: ed25519.sign(hashDomain(DOMAIN, encodeCanonical(proof)), creatorSeed), ...change });
		} }), () => ["creator"]);
		const lifetime = new AbortController();
		await expect(material.receiveCreatorSuccessorMaterial({ identity, transport: scripted.port, peers: ["creator"],
			manifestDigest, materialKind: "checkpoint", retryUntil: lifetime.signal })).rejects.toThrow();
		expect(scripted.attempts).toHaveLength(1);
		expect(scripted.open()).toBe(0);
	}
});

type Request = Readonly<{
	nonce: Uint8Array;
	requesterPeer: string;
	sourcePeer: string;
	manifestDigest: string;
	author: string;
	signature: Uint8Array;
}>;

/**
 * A signed material response to one request, as the creator's material server writes it.
 * @param request - The decoded request.
 * @param change - Fields to replace before signing (or after, with `afterSigning`).
 * @param options - Signing key and post-signing tampering.
 * @returns The response frame.
 */
function response(
	request: Request,
	change: Record<string, unknown> = {},
	options: Readonly<{ seed?: Uint8Array; author?: string; afterSigning?: Record<string, unknown> }> = {}
): Uint8Array {
	const proof = {
		exactCanonicalSettlementBytes: new Uint8Array([1, 2, 3]),
		exactCanonicalHistoryBytes: new Uint8Array([4, 5, 6]),
		kind: "creator-successor-material-response",
		version: 1,
		nonce: request.nonce,
		manifestDigest,
		requesterPeer: request.requesterPeer,
		sourcePeer: request.sourcePeer,
		author: options.author ?? creatorAuthor,
		...change,
	};
	const signature = ed25519.sign(hashDomain(DOMAIN, encodeCanonical(proof)), options.seed ?? creatorSeed);
	return encodeCanonical({ ...proof, signature, ...options.afterSigning });
}

type Reply =
	| Readonly<{ kind: "serve"; bytes?: (request: Request) => Uint8Array }>
	| Readonly<{ kind: "reset" }>
	| Readonly<{ kind: "invalid-length"; name: "InvalidDataLengthError" | "InvalidDataLengthLengthError" }>
	| Readonly<{ kind: "end" }>
	| Readonly<{ kind: "blackhole" }>
	| Readonly<{ kind: "open-fails" }>
	| Readonly<{ kind: "uncertain-cleanup" }>;

interface Attempt {
	readonly peer: string;
	readonly at: number;
	nonce?: string;
	closed: boolean;
	aborted: boolean;
}

/**
 * A creator-successor port whose peers answer each attempt as `reply` says.
 * @param reply - What the peer does on its n-th attempt (n counts per peer from 0).
 * @param connected - The connected peers, read on each call.
 * @returns The port and its observations.
 */
function fakePort(
	reply: (peer: string, attempt: number) => Reply,
	connected: () => readonly string[]
): Readonly<{
	port: SnapshotChunkProtocolPort;
	attempts: Attempt[];
	maxOpen: () => number;
	open: () => number;
	requests: Request[];
}> {
	const attempts: Attempt[] = [];
	const requests: Request[] = [];
	const perPeer = new Map<string, number>();
	let open = 0;
	let maxOpen = 0;
	const port: SnapshotChunkProtocolPort = {
		localPeerId: WRITER,
		connectedPeers: connected,
		close: () => Promise.resolve(),
		serve: () => () => undefined,
		open: (peer, { signal }) => {
			signal.throwIfAborted();
			const index = perPeer.get(peer) ?? 0;
			perPeer.set(peer, index + 1);
			const behavior = reply(peer, index);
			const attempt: Attempt = { peer, at: performance.now(), closed: false, aborted: false };
			attempts.push(attempt);
			if (behavior.kind === "open-fails" || !connected().includes(peer)) {
				attempt.closed = true;
				return Promise.reject(new Error("snapshot peer has no open unlimited authenticated connection"));
			}
			open += 1;
			maxOpen = Math.max(maxOpen, open);
			let ended = false;
			const end = (): void => {
				if (!ended) open -= 1;
				ended = true;
			};
			let request: Request | undefined;
			const stream: SnapshotChunkProtocolStream = {
				peerId: peer,
				abort: () => {
					attempt.aborted = true;
					end();
					if (behavior.kind === "uncertain-cleanup") throw new Error("TRACK_X_UNCERTAIN_ABORT");
				},
				close: () => {
					attempt.closed = true;
					end();
					return behavior.kind === "uncertain-cleanup"
						? Promise.reject(new Error("TRACK_X_UNCERTAIN_CLOSE"))
						: Promise.resolve();
				},
				write: (bytes, options) => {
					options.signal.throwIfAborted();
					request = decodeCanonical(bytes) as Request;
					requests.push(request);
					attempt.nonce = hexOf(request.nonce);
					return Promise.resolve();
				},
				read: async (_maxBytes, options) => {
					options.signal.throwIfAborted();
					if (behavior.kind === "serve") {
						if (request === undefined) throw new Error("TRACK_X_NO_REQUEST");
						return (behavior.bytes ?? ((value: Request) => response(value)))(request);
					}
					if (behavior.kind === "reset" || behavior.kind === "uncertain-cleanup" || behavior.kind === "invalid-length")
						throw Object.assign(new Error("snapshot frame violates its byte bound", {
							cause: Object.assign(new Error("stream read failed"), {
								name: behavior.kind === "invalid-length" ? behavior.name : "StreamResetError",
							}),
						}), { code: "protocol-violation" });
					if (behavior.kind === "end") throw new Error("TRACK_X_STREAM_ENDED");
					await new Promise<void>((resolve) => {
						options.signal.addEventListener("abort", () => resolve(), { once: true });
					});
					throw new Error("snapshot stream was aborted");
				},
			};
			return Promise.resolve(stream);
		},
	};
	return { port, attempts, requests, maxOpen: () => maxOpen, open: () => open };
}

/**
 * A lifetime signal that counts its listeners.
 * @returns The controller and the live listener count.
 */
function countedLifetime(): Readonly<{ controller: AbortController; listeners: () => number }> {
	const controller = new AbortController();
	const { signal } = controller;
	let listeners = 0;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	const live = new Set<unknown>();
	Object.defineProperty(signal, "addEventListener", {
		value: (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
			if (type === "abort" && !live.has(listener)) {
				live.add(listener);
				listeners += 1;
			}
			add(type, listener, options);
		},
	});
	Object.defineProperty(signal, "removeEventListener", {
		value: (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions) => {
			if (type === "abort" && live.delete(listener)) listeners -= 1;
			remove(type, listener, options);
		},
	});
	return { controller, listeners: () => listeners };
}

const receive = (
	port: SnapshotChunkProtocolPort,
	peers: readonly string[],
	retryUntil?: AbortSignal
): ReturnType<typeof material.receiveCreatorSuccessorMaterial> =>
	material.receiveCreatorSuccessorMaterial({
		transport: port,
		identity,
		peers,
		manifestDigest,
		...(retryUntil === undefined ? {} : { retryUntil }),
	} as Parameters<typeof material.receiveCreatorSuccessorMaterial>[0]);

it("authenticates and detaches version-2 membership beyond the manifest frame size", async () => {
	const membership = new Uint8Array(262_144).fill(23);
	const fake = fakePort(
		() => ({
			kind: "serve",
			bytes: (request) =>
				response(request, {
					version: 2,
					exactCanonicalCloseMembershipBytes: membership,
				}),
		}),
		() => ["creator"]
	);
	const received = await receive(fake.port, ["creator"]);
	expect(received.exactCanonicalCloseMembershipBytes).toEqual(membership);
	membership.fill(0);
	expect(received.exactCanonicalCloseMembershipBytes?.[0]).toBe(23);
	expect(fake.open()).toBe(0);
});

it.each([
	{ version: 2 },
	{ version: 1, exactCanonicalCloseMembershipBytes: new Uint8Array([1]) },
	{ version: 2, exactCanonicalCloseMembershipBytes: new Uint8Array(0) },
	{ version: 2, exactCanonicalCloseMembershipBytes: new Uint8Array(CREATOR_CLOSE_MEMBERSHIP_MAX_BYTES + 1) },
])("refuses mismatched or oversized membership response %#", async (change) => {
	const fake = fakePort(
		() => ({ kind: "serve", bytes: (request) => response(request, change) }),
		() => ["creator"]
	);
	await expect(receive(fake.port, ["creator"])).rejects.toThrow("creator successor material transport failed");
	expect(fake.open()).toBe(0);
	expect(fake.attempts).toHaveLength(1);
});

it("the reviewed pacing is named, bounded and below one attempt's own deadline", () => {
	const initial = (material as Record<string, unknown>).CREATOR_SUCCESSOR_MATERIAL_RETRY_INITIAL_MS;
	const maximum = (material as Record<string, unknown>).CREATOR_SUCCESSOR_MATERIAL_RETRY_MAX_MS;
	expect(typeof initial, "CREATOR_SUCCESSOR_MATERIAL_RETRY_INITIAL_MS").toBe("number");
	expect(typeof maximum, "CREATOR_SUCCESSOR_MATERIAL_RETRY_MAX_MS").toBe("number");
	expect(initial as number).toBeGreaterThanOrEqual(100);
	expect(maximum as number).toBeGreaterThanOrEqual(initial as number);
	expect(maximum as number).toBeLessThan(SNAPSHOT_PULL_INACTIVITY_MS);
});

it("without a lifetime, one pass over the candidates, as before", async () => {
	const fake = fakePort(
		() => ({ kind: "reset" }),
		() => ["creator"]
	);
	expect(await settled(receive(fake.port, ["creator"]))).toBe("failed: creator successor material transport failed");
	expect(fake.attempts).toHaveLength(1);
});

it("a reset, an ended stream and a failed open are retried with a fresh nonce in the same fetch", async () => {
	const { controller, listeners } = countedLifetime();
	const script: Reply[] = [{ kind: "reset" }, { kind: "end" }, { kind: "open-fails" }, { kind: "serve" }];
	const fake = fakePort(
		(_peer, attempt) => script[attempt] ?? { kind: "serve" },
		() => ["creator"]
	);
	const received = await receive(fake.port, ["creator"], controller.signal);
	expect(received.exactCanonicalHistoryBytes).toEqual(new Uint8Array([4, 5, 6]));
	expect(received.peers).toEqual(["creator"]);
	expect(fake.attempts.map(({ peer }) => peer)).toEqual(["creator", "creator", "creator", "creator"]);
	const nonces = fake.attempts.flatMap(({ nonce }) => (nonce === undefined ? [] : [nonce]));
	expect(nonces, "each request carries a fresh nonce").toHaveLength(3);
	expect(new Set(nonces).size).toBe(3);
	expect(fake.maxOpen(), "one attempt in flight").toBe(1);
	expect(fake.open(), "every stream ended").toBe(0);
	expect(listeners(), "no listener left on the lifetime").toBe(0);
});

it("an attempt that outlives its own deadline is retried, and the retry is served", async () => {
	const { controller } = countedLifetime();
	const fake = fakePort(
		(_peer, attempt) => (attempt === 0 ? { kind: "blackhole" } : { kind: "serve" }),
		() => ["creator"]
	);
	const started = performance.now();
	const received = await receive(fake.port, ["creator"], controller.signal);
	expect(received.peers).toEqual(["creator"]);
	expect(fake.attempts).toHaveLength(2);
	expect(required(fake.attempts[0]).aborted, "the timed-out stream was aborted").toBe(true);
	expect(performance.now() - started).toBeGreaterThanOrEqual(SNAPSHOT_PULL_INACTIVITY_MS - 50);
	expect(fake.open()).toBe(0);
}, 60_000);

it("a peer that is not connected yet is waited for, and the connected candidates are refreshed", async () => {
	const { controller } = countedLifetime();
	let connected: string[] = [];
	const fake = fakePort(
		() => ({ kind: "serve" }),
		() => connected
	);
	setTimeout(() => {
		connected = ["creator"];
	}, 700);
	const received = await receive(fake.port, ["creator"], controller.signal);
	expect(received.peers).toEqual(["creator"]);
	expect(fake.attempts.map(({ peer }) => peer)).toEqual(["creator"]);
});

const terminal: readonly (readonly [string, (request: Request) => Uint8Array])[] = [
	["a bad signature", (request) => response(request, {}, { afterSigning: { signature: new Uint8Array(64).fill(7) } })],
	["a foreign author", (request) => response(request, {}, { seed: strangerSeed, author: strangerAuthor })],
	["a wrong source peer", (request) => response(request, { sourcePeer: "someone-else" })],
	["a wrong requester peer", (request) => response(request, { requesterPeer: "someone-else" })],
	["a wrong manifest", (request) => response(request, { manifestDigest: "d".repeat(64) })],
	["a wrong nonce", (request) => response(request, { nonce: new Uint8Array(32).fill(9) })],
	["a wrong kind", (request) => response(request, { kind: "creator-successor-material-not-ready" })],
	["a malformed frame", (request) => response(request, {}, { afterSigning: { unexpected: 1 } })],
	["invalid material bounds", (request) => response(request, { exactCanonicalHistoryBytes: new Uint8Array() })],
];

for (const name of ["InvalidDataLengthError", "InvalidDataLengthLengthError"] as const) {
	it(`${name} in the network port is terminal before the response is decoded`, async () => {
		const { controller, listeners } = countedLifetime();
		const fake = fakePort(() => ({ kind: "invalid-length", name }), () => ["creator"]);
		const guard = setTimeout(() => controller.abort(new Error("test guard")), 2_000);
		try {
			expect(await settled(receive(fake.port, ["creator"], controller.signal)))
				.toBe("failed: creator successor material transport failed");
			expect(controller.signal.aborted).toBe(false);
			expect(fake.requests).toHaveLength(1);
			expect(fake.open()).toBe(0);
			expect(listeners()).toBe(0);
		} finally {
			clearTimeout(guard);
		}
	});
}

for (const [label, bytes] of terminal) {
	it(`${label} is terminal: one request, no retry`, async () => {
		const { controller, listeners } = countedLifetime();
		const fake = fakePort(
			() => ({ kind: "serve", bytes }),
			() => ["creator"]
		);
		const outcome = await settled(receive(fake.port, ["creator"], controller.signal));
		expect(outcome).toBe("failed: creator successor material transport failed");
		expect(fake.requests).toHaveLength(1);
		expect(fake.open()).toBe(0);
		expect(listeners()).toBe(0);
	});
}

it("uncertain stream cleanup ends the whole fetch at once, even with another candidate", async () => {
	const { controller } = countedLifetime();
	const fake = fakePort(
		(peer) => (peer === "a" ? { kind: "uncertain-cleanup" } : { kind: "serve" }),
		() => ["a", "b"]
	);
	const outcome = await settled(receive(fake.port, ["a", "b"], controller.signal));
	expect(outcome).toBe("failed: creator successor material transport failed");
	expect(fake.attempts.map(({ peer }) => peer)).toEqual(["a"]);
});

it("a terminal peer is dropped while a transient one keeps its turns", async () => {
	const { controller } = countedLifetime();
	const fake = fakePort(
		(peer, attempt) =>
			peer === "a"
				? { kind: "serve", bytes: (request) => response(request, {}, { seed: strangerSeed, author: strangerAuthor }) }
				: attempt < 2
					? { kind: "reset" }
					: { kind: "serve" },
		() => ["a", "b"]
	);
	const received = await receive(fake.port, ["a", "b"], controller.signal);
	expect(received.peers).toEqual(["b"]);
	expect(fake.attempts.map(({ peer }) => peer)).toEqual(["a", "b", "b", "b"]);
});

it("a peer that never answers cannot starve one that does: candidates rotate, one stream at a time", async () => {
	const { controller, listeners } = countedLifetime();
	const fake = fakePort(
		(peer, attempt) => (peer === "a" ? { kind: "blackhole" } : attempt === 0 ? { kind: "reset" } : { kind: "serve" }),
		() => ["a", "b"]
	);
	const received = await receive(fake.port, ["a", "b"], controller.signal);
	expect(received.peers).toEqual(["b"]);
	expect(fake.attempts.map(({ peer }) => peer)).toEqual(["a", "b", "a", "b"]);
	expect(fake.maxOpen()).toBe(1);
	expect(fake.open()).toBe(0);
	expect(
		fake.attempts.every(({ closed, aborted }) => closed || aborted),
		"every stream closed or aborted"
	).toBe(true);
	expect(listeners()).toBe(0);
}, 60_000);

it("a disconnected candidate is skipped until it reconnects", async () => {
	const { controller } = countedLifetime();
	let connected = ["a"];
	const fake = fakePort(
		(peer) => (peer === "a" ? { kind: "reset" } : { kind: "serve" }),
		() => connected
	);
	setTimeout(() => {
		connected = ["b"];
	}, 900);
	const received = await receive(fake.port, ["a", "b"], controller.signal);
	expect(received.peers).toEqual(["b"]);
	expect(
		fake.attempts.filter(({ peer }) => peer === "b"),
		"b was never opened while disconnected"
	).toHaveLength(1);
	expect(fake.attempts.at(-1)?.peer).toBe("b");
});

it("the lifetime ends the wait at once, with a bounded diagnostic and paced attempts", async () => {
	const { controller, listeners } = countedLifetime();
	const fake = fakePort(
		() => ({ kind: "open-fails" }),
		() => ["creator", "other"]
	);
	const outcome = receive(fake.port, ["creator", "other"], controller.signal).then(
		() => undefined,
		(error: unknown) => error
	);
	await sleep(3_000);
	const attempts = fake.attempts.length;
	const ended = performance.now();
	controller.abort(new Error("TRACK_X_SESSION_CLOSED"));
	const error = await outcome;
	expect(performance.now() - ended, "ends at once").toBeLessThan(1_000);
	expect(error).toBeInstanceOf(AggregateError);
	expect((error as AggregateError).message).toBe("creator successor material transport failed");
	expect((error as AggregateError).errors.length, "at most one failure kept per candidate").toBeLessThanOrEqual(2);
	// Two candidates per round, rounds paced from the initial delay up: a round at 0, then after
	// at least the initial delay, doubling. A tight loop would make hundreds of attempts here.
	expect(attempts).toBeGreaterThanOrEqual(4);
	expect(attempts).toBeLessThanOrEqual(12);
	expect(listeners()).toBe(0);
	expect(fake.attempts.length, "nothing after the lifetime ended").toBe(attempts);
});

it("the lifetime also ends an attempt in flight", async () => {
	const { controller, listeners } = countedLifetime();
	const fake = fakePort(
		() => ({ kind: "blackhole" }),
		() => ["creator"]
	);
	const outcome = settled(receive(fake.port, ["creator"], controller.signal));
	await sleep(500);
	const ended = performance.now();
	controller.abort(new Error("TRACK_X_SESSION_CLOSED"));
	expect(await outcome).toBe("failed: creator successor material transport failed");
	expect(performance.now() - ended).toBeLessThan(1_000);
	expect(fake.attempts).toHaveLength(1);
	expect(required(fake.attempts[0]).aborted).toBe(true);
	expect(fake.open()).toBe(0);
	expect(listeners()).toBe(0);
}, 30_000);

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new TypeError("TRACK_X_REQUIRED");
	return value;
}

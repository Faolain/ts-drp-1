/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { afterEach, expect, it } from "vitest";

import * as material from "../packages/node/src/internal/creator-successor-transport.js";

// App rollover delivery, item 3: the creator's successor-material server refuses a reader it does
// not authorize (Grid serves only its current Writers; a receive-only Grid member is not one) or a
// request for a successor it no longer serves (a member that raced a newer rollover). Before, the
// server threw and the stream was aborted with no frame; the member's install classified that as
// transient and retried forever (decision row 61, option E: no total deadline). Now the refusal is
// an explicit reply and the member's fetch stops on it at once. Measured in
// .logs/realtime-resume-2026-10-23/app-rollover/grid-receive-only-hang/.

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const creatorSeed = new Uint8Array(32).fill(0xb2);
const writerSeed = new Uint8Array(32).fill(0xb1);
const readerSeed = new Uint8Array(32).fill(0xb3);
const creatorAuthor = hexOf(ed25519.getPublicKey(creatorSeed));
const writerAuthor = hexOf(ed25519.getPublicKey(writerSeed));
const readerAuthor = hexOf(ed25519.getPublicKey(readerSeed));
const manifestDigest = "e".repeat(64);
const CREATOR = "creator-peer";
const MEMBER = "member-peer";
const sign = (seed: Uint8Array) => (digest: Uint8Array) => Promise.resolve(ed25519.sign(digest, seed));
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
	if (waiting !== undefined) waiting(frame instanceof Error ? frame : frame);
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

/**
 * The member's material port wired to the creator's real material server, as the snapshot transfer
 * owner wires it: the first frame goes to `control`, and a control failure aborts the stream with
 * no frame ("snapshot serving request was rejected").
 */
function wired(server: ReturnType<typeof material.createCreatorSuccessorMaterialServer>) {
	let attempts = 0;
	let open = 0;
	const port: SnapshotChunkProtocolPort = {
		localPeerId: MEMBER,
		connectedPeers: () => [CREATOR],
		close: () => Promise.resolve(),
		serve: () => () => undefined,
		open: (peer, { signal }) => {
			signal.throwIfAborted();
			attempts++;
			open++;
			const toServer = pipe();
			const toClient = pipe();
			let ended = false;
			const end = (): void => {
				if (!ended) open--;
				ended = true;
			};
			const serverStream: SnapshotChunkProtocolStream = {
				peerId: MEMBER,
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
				abort: () => end(),
				close: () => {
					end();
					return Promise.resolve();
				},
				read: (_max, options) => pull(toClient, options.signal),
				write: (bytes) => {
					const frame = Uint8Array.from(bytes);
					void server.control(serverStream, frame).then(
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
	return { port, attempts: () => attempts, open: () => open };
}

const serverFor = (options: Readonly<{ readers?(author: string): boolean; manifest?: string; localPeerId?: string }>) =>
	material.createCreatorSuccessorMaterialServer({
		identity: {
			author: creatorAuthor,
			sign: sign(creatorSeed),
			isAuthorizedAuthor: (author) => author === writerAuthor,
		},
		...(options.readers === undefined ? {} : { isAuthorizedReader: options.readers }),
		localPeerId: options.localPeerId ?? CREATOR,
		manifestDigest: options.manifest ?? manifestDigest,
		material: auxiliary as unknown as material.CreatorSuccessorAuxiliaryMaterial,
		connectedPeers: () => [MEMBER],
	});

const fetch = (port: SnapshotChunkProtocolPort, author: string, seed: Uint8Array, lifetime: AbortSignal) =>
	material.receiveCreatorSuccessorMaterial({
		transport: port,
		identity: {
			author,
			sign: sign(seed),
			isAuthorizedAuthor: (candidate) => candidate === creatorAuthor,
		},
		peers: [CREATOR],
		manifestDigest,
		retryUntil: lifetime,
	} as Parameters<typeof material.receiveCreatorSuccessorMaterial>[0]);

/**
 * Runs one fetch with a guard: the fetch must end by itself well before the guard aborts it.
 * @returns How it ended, how long it took and whether the guard had to end it.
 */
async function bounded(promise: (lifetime: AbortSignal) => Promise<unknown>, guardMs = 4_000) {
	const lifetime = new AbortController();
	controllers.add(lifetime);
	const guard = setTimeout(() => lifetime.abort(new Error("APP_ROLLOVER_REFUSAL_GUARD")), guardMs);
	const started = performance.now();
	try {
		const outcome = await promise(lifetime.signal).then(
			() => "received",
			(error: unknown) => error
		);
		return { outcome, ms: performance.now() - started, guarded: lifetime.signal.aborted };
	} finally {
		clearTimeout(guard);
	}
}

const causes = (error: unknown): string => {
	const parts: string[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (depth > 6 || value === undefined) return;
		if (value instanceof AggregateError) for (const inner of value.errors) visit(inner, depth + 1);
		if (value instanceof Error) {
			parts.push(value.message);
			visit(value.cause, depth + 1);
		} else parts.push(String(value));
	};
	visit(error, 0);
	return parts.join(" | ");
};

it("an authorized Writer is served, as before (control)", async () => {
	const linked = wired(serverFor({}));
	const result = await bounded((lifetime) => fetch(linked.port, writerAuthor, writerSeed, lifetime));
	expect(result.outcome).toBe("received");
	expect(linked.attempts()).toBe(1);
	expect(linked.open()).toBe(0);
});

it("a reader the creator does not authorize is refused with an explicit reply, and the member stops at once", async () => {
	// Grid: the material server authorizes current Writers only; this reader is not one.
	const linked = wired(serverFor({}));
	const result = await bounded((lifetime) => fetch(linked.port, readerAuthor, readerSeed, lifetime));
	expect(result.guarded, "the fetch ended by itself, not by the test's guard").toBe(false);
	expect(linked.attempts(), "one request, no retry").toBe(1);
	expect(causes(result.outcome)).toContain("creator material request was refused: unauthorized");
	expect(linked.open()).toBe(0);
});

it("an explicit reader policy that refuses is terminal too", async () => {
	const linked = wired(serverFor({ readers: () => false }));
	const result = await bounded((lifetime) => fetch(linked.port, writerAuthor, writerSeed, lifetime));
	expect(result.guarded).toBe(false);
	expect(linked.attempts()).toBe(1);
	expect(causes(result.outcome)).toContain("creator material request was refused: unauthorized");
});

it("a request for a successor the creator no longer serves is refused as stale, and the member stops at once", async () => {
	const linked = wired(serverFor({ manifest: "f".repeat(64) }));
	const result = await bounded((lifetime) => fetch(linked.port, writerAuthor, writerSeed, lifetime));
	expect(result.guarded).toBe(false);
	expect(linked.attempts()).toBe(1);
	expect(causes(result.outcome)).toContain("creator material request was refused: stale");
});

it("the refusal frame is bounded, unsigned and bound to the request's nonce and peers", async () => {
	const server = serverFor({});
	const nonce = crypto.getRandomValues(new Uint8Array(32));
	const request = {
		kind: "creator-successor-material-request",
		version: 1,
		nonce,
		manifestDigest,
		requesterPeer: MEMBER,
		sourcePeer: CREATOR,
		author: readerAuthor,
	};
	const signature = ed25519.sign(
		hashDomain("ts-drp/creator-successor-transport/v1", encodeCanonical(request)),
		readerSeed
	);
	const written: Uint8Array[] = [];
	let aborted = false;
	const handled = await server.control(
		{
			peerId: MEMBER,
			abort: () => {
				aborted = true;
			},
			close: () => Promise.resolve(),
			read: () => Promise.reject(new Error("no more frames")),
			write: (bytes) => {
				written.push(Uint8Array.from(bytes));
				return Promise.resolve();
			},
		},
		encodeCanonical({ ...request, signature })
	);
	expect(handled).toBe(true);
	expect(aborted).toBe(false);
	expect(written).toHaveLength(1);
	const reply = decodeCanonical(written[0] as Uint8Array) as Record<string, unknown>;
	expect(Object.keys(reply).sort()).toEqual(["kind", "nonce", "reason", "requesterPeer", "sourcePeer", "version"]);
	expect(reply).toMatchObject({
		kind: "creator-successor-material-refused",
		version: 1,
		reason: "unauthorized",
		requesterPeer: MEMBER,
		sourcePeer: CREATOR,
	});
	expect(hexOf(reply.nonce as Uint8Array)).toBe(hexOf(nonce));
	expect((written[0] as Uint8Array).byteLength).toBeLessThan(256);
});

it("a refusal from one peer drops only that peer; another peer still serves", async () => {
	const refusing = wired(serverFor({ readers: () => false, localPeerId: "a" }));
	const serving = wired(serverFor({ localPeerId: "b" }));
	const lifetime = new AbortController();
	controllers.add(lifetime);
	const result = await material
		.receiveCreatorSuccessorMaterial({
			transport: {
				localPeerId: MEMBER,
				connectedPeers: () => ["a", "b"],
				close: () => Promise.resolve(),
				serve: () => () => undefined,
				open: (peer, options) => (peer === "a" ? refusing : serving).port.open(peer, options),
			},
			identity: {
				author: writerAuthor,
				sign: sign(writerSeed),
				isAuthorizedAuthor: (candidate) => candidate === creatorAuthor,
			},
			peers: ["a", "b"],
			manifestDigest,
			retryUntil: lifetime.signal,
		} as Parameters<typeof material.receiveCreatorSuccessorMaterial>[0])
		.then(
			(received) => received.peers,
			(error: unknown) => causes(error)
		);
	expect(result).toEqual(["b"]);
	expect(refusing.attempts(), "the refusing peer was asked once").toBe(1);
	expect(serving.attempts()).toBe(1);
});

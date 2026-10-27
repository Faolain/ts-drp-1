/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test doubles keep the inferred shapes of the owners they stand in for. */
import { ed25519 } from "@noble/curves/ed25519.js";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { afterEach, expect, it } from "vitest";

import * as current from "../packages/node/src/internal/creator-successor-transport.js";
import * as previous from "./fixtures/creator-successor-transport-cf77f260.js";

// fix/skip-scope-carrier, cross-version probe. A member making a skip install asks the creator for
// the departed scope's carrier on a new request kind (creator-successor-departed-request v1). Both
// directions against the transport of cf77f260 (before the fix, verbatim in tests/fixtures):
//   - a new member against an old creator: the old server does not know the kind, so the snapshot
//     owner aborts the stream; the member gets no carrier at once (no hang) and its material fetch
//     (today's install) still works;
//   - an old member against a new creator: the old member never asks; the new server answers its
//     material requests (membership and checkpoint) as before.
// The transport is wired as the snapshot transfer owner wires it (first frame to `control`; an
// unhandled or failed control aborts the stream with no frame), as in app-rollover-material-refusal.

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const creatorSeed = new Uint8Array(32).fill(0xc2);
const writerSeed = new Uint8Array(32).fill(0xc1);
const creatorAuthor = hexOf(ed25519.getPublicKey(creatorSeed));
const writerAuthor = hexOf(ed25519.getPublicKey(writerSeed));
const manifestDigest = "d".repeat(64);
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
const departedScope = Object.freeze({ epoch: 7, anchorDigest: "a".repeat(64) });
const carrier = Object.freeze({
	exactCanonicalCutValueBytes: new Uint8Array([11, 12, 13]),
	exactCanonicalCommitQcBytes: new Uint8Array([14, 15]),
	exactCanonicalTrustStateRecordBytes: new Uint8Array([16]),
	exactCanonicalCloseMembershipBytes: new Uint8Array([17, 18, 19, 20]),
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

type Server = Readonly<{ control(stream: SnapshotChunkProtocolStream, bytes: Uint8Array): Promise<boolean> }>;
function wired(server: Server) {
	let attempts = 0;
	let open = 0;
	const outcomes: string[] = [];
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
					void server.control(serverStream, Uint8Array.from(bytes)).then(
						(handled) => {
							outcomes.push(handled ? "handled" : "not-a-control-frame");
							if (!handled) serverStream.abort(new Error("snapshot request was not a control frame"));
						},
						(error: unknown) => {
							outcomes.push(`rejected: ${String(error)}`);
							serverStream.abort(new Error("snapshot serving request was rejected"));
						}
					);
					return Promise.resolve();
				},
			};
			return Promise.resolve(stream);
		},
	};
	return { port, attempts: () => attempts, open: () => open, outcomes };
}

const serverInput = (departed?: (scope: current.CreatorSuccessorDepartedScope) => current.CreatorSuccessorDepartedCarrier | undefined) => ({
	identity: { author: creatorAuthor, sign: sign(creatorSeed), isAuthorizedAuthor: (author: string) => author === writerAuthor },
	localPeerId: CREATOR,
	manifestDigest,
	material: auxiliary as unknown as current.CreatorSuccessorAuxiliaryMaterial,
	connectedPeers: () => [MEMBER],
	...(departed === undefined ? {} : { departed }),
});
const memberIdentity = { author: writerAuthor, sign: sign(writerSeed), isAuthorizedAuthor: (candidate: string) => candidate === creatorAuthor };
const askDeparted = (port: SnapshotChunkProtocolPort, scope = departedScope) =>
	current.receiveCreatorSuccessorDepartedCarrier({ transport: port, identity: memberIdentity, peers: [CREATOR], manifestDigest, departed: scope });
const fetchMaterial = (
	module: typeof current | typeof previous,
	port: SnapshotChunkProtocolPort,
	lifetime: AbortSignal,
	materialKind?: "checkpoint"
) =>
	(module.receiveCreatorSuccessorMaterial as typeof current.receiveCreatorSuccessorMaterial)({
		transport: port,
		identity: memberIdentity,
		peers: [CREATOR],
		manifestDigest,
		retryUntil: lifetime,
		...(materialKind === undefined ? {} : { materialKind }),
	} as Parameters<typeof current.receiveCreatorSuccessorMaterial>[0]);

async function bounded<T>(promise: (lifetime: AbortSignal) => Promise<T>, guardMs = 15_000) {
	const lifetime = new AbortController();
	controllers.add(lifetime);
	const guard = setTimeout(() => lifetime.abort(new Error("SKIP_SCOPE_VERSION_GUARD")), guardMs);
	const started = performance.now();
	try {
		const outcome = await promise(lifetime.signal).then(
			(value) => ({ value }),
			(error: unknown) => ({ error })
		);
		return { ...outcome, ms: performance.now() - started, guarded: lifetime.signal.aborted };
	} finally {
		clearTimeout(guard);
	}
}
const report = (label: string, value: unknown) => process.stdout.write(`SKIP_SCOPE_VERSION ${label} ${JSON.stringify(value)}\n`);

it("new member, new creator: the departed carrier arrives intact (control)", async () => {
	const linked = wired(current.createCreatorSuccessorMaterialServer(serverInput((scope) =>
		scope.epoch === departedScope.epoch && scope.anchorDigest === departedScope.anchorDigest ? carrier : undefined)));
	const result = await bounded(() => askDeparted(linked.port));
	report("new-new", { ms: Math.round(result.ms), outcomes: linked.outcomes, received: result.value !== undefined });
	expect(result.guarded).toBe(false);
	expect(result.value).toEqual(carrier);
	expect(linked.attempts()).toBe(1);
	expect(linked.open()).toBe(0);
	// A scope the creator holds no carrier for: a signed "unavailable", so none.
	const other = await bounded(() => askDeparted(linked.port, { epoch: 8, anchorDigest: "b".repeat(64) }));
	expect(other.value).toBeUndefined();
	expect(linked.outcomes).toEqual(["handled", "handled"]);
	// A creator that holds none at all (restarted: the carriers are in memory only).
	const none = wired(current.createCreatorSuccessorMaterialServer(serverInput()));
	expect((await bounded(() => askDeparted(none.port))).value).toBeUndefined();
});

it("new member, new creator: a member the creator does not authorize gets a refusal and no carrier", async () => {
	const linked = wired(current.createCreatorSuccessorMaterialServer({ ...serverInput(() => carrier),
		identity: { author: creatorAuthor, sign: sign(creatorSeed), isAuthorizedAuthor: () => false } }));
	const result = await bounded(() => askDeparted(linked.port));
	expect(result.value).toBeUndefined();
	expect(result.guarded).toBe(false);
	expect(linked.attempts()).toBe(1);
});

it("new member, old creator (cf77f260): no carrier, at once, and the member's material fetch still works", async () => {
	const linked = wired(previous.createCreatorSuccessorMaterialServer(serverInput() as Parameters<typeof previous.createCreatorSuccessorMaterialServer>[0]));
	const asked = await bounded(() => askDeparted(linked.port));
	report("new-member-old-creator", { ms: Math.round(asked.ms), outcomes: linked.outcomes, received: asked.value !== undefined,
		guarded: asked.guarded, attempts: linked.attempts(), open: linked.open() });
	// The old server does not know the kind: its control returns false and the owner aborts the stream.
	expect(linked.outcomes).toEqual(["not-a-control-frame"]);
	expect(asked.value).toBeUndefined();
	expect(asked.guarded, "the ask ended by itself").toBe(false);
	expect(asked.ms).toBeLessThan(5_000);
	expect(linked.attempts(), "one ask, no retry").toBe(1);
	expect(linked.open()).toBe(0);
	// Today's install continues: the material (membership request v1) is served as before.
	const fetched = await bounded((lifetime) => fetchMaterial(current, linked.port, lifetime));
	expect("error" in fetched ? String(fetched.error) : "received").toBe("received");
});

it("old member (cf77f260), new creator: the old member's material requests are served as before", async () => {
	const server = current.createCreatorSuccessorMaterialServer(serverInput(() => carrier));
	const linked = wired(server);
	const membership = await bounded((lifetime) => fetchMaterial(previous, linked.port, lifetime));
	const viaPrevious = "value" in membership ? membership.value : undefined;
	// The checkpoint request (v2): this server holds no checkpoint, so a signed unavailable, as before.
	const checkpoint = await bounded((lifetime) => fetchMaterial(previous, linked.port, lifetime, "checkpoint"), 3_000);
	report("old-member-new-creator", { membership: viaPrevious === undefined ? String((membership as { error: unknown }).error) : "received",
		checkpoint: "error" in checkpoint ? String(checkpoint.error).slice(0, 200) : "received", outcomes: linked.outcomes });
	expect(viaPrevious).toBeDefined();
	expect(viaPrevious?.exactCanonicalSettlementBytes).toEqual(auxiliary.exactCanonicalSettlementBytes);
	expect(viaPrevious?.exactCanonicalHistoryBytes).toEqual(auxiliary.exactCanonicalHistoryBytes);
	expect(linked.outcomes.every((outcome) => outcome === "handled")).toBe(true);
	// Same with the old server: the old pair's checkpoint outcome is the reference for the new server's.
	const old = wired(previous.createCreatorSuccessorMaterialServer(serverInput() as Parameters<typeof previous.createCreatorSuccessorMaterialServer>[0]));
	const reference = await bounded((lifetime) => fetchMaterial(previous, old.port, lifetime, "checkpoint"), 3_000);
	const shape = (value: typeof checkpoint) => ("error" in value ? String(value.error).replace(/\d+ms|\d+/gu, "N") : "received");
	expect(shape(checkpoint)).toBe(shape(reference));
});

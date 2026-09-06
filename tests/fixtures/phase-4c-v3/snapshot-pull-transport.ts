import type {
	SnapshotChunkProtocolPort,
	SnapshotChunkProtocolStream,
	SnapshotPeerAuthorization,
} from "./snapshot-pull-types.js";
import type { SnapshotQuarantineFixture } from "./snapshot-quarantine-contract.js";
import { decodeCanonical, encodeCanonical } from "../../../packages/canonical/src/index.js";

export type SnapshotScriptedPeerBehavior =
	| "corrupt"
	| "first-then-slow"
	| "honest"
	| "mismatched-control"
	| "oversized-body"
	| "paced"
	| "slow";

interface ScriptedFrame {
	readonly bytes: Uint8Array;
	readonly kind: "body" | "control";
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("test transport control record is invalid");
	}
	return value as Readonly<Record<string, unknown>>;
}

class ScriptedStream implements SnapshotChunkProtocolStream {
	readonly #behavior: SnapshotScriptedPeerBehavior;
	readonly #fixture: SnapshotQuarantineFixture;
	readonly #emittedBodyBytes: number[];
	readonly #frames: ScriptedFrame[] = [];
	#closed = false;
	readonly peerId: string;
	readonly requests: Readonly<Record<string, unknown>>[];

	constructor(
		peerId: string,
		behavior: SnapshotScriptedPeerBehavior,
		fixture: SnapshotQuarantineFixture,
		requests: Readonly<Record<string, unknown>>[],
		emittedBodyBytes: number[]
	) {
		this.peerId = peerId;
		this.#behavior = behavior;
		this.#fixture = fixture;
		this.requests = requests;
		this.#emittedBodyBytes = emittedBodyBytes;
	}

	abort(): void {
		this.#closed = true;
	}

	close(): Promise<void> {
		this.#closed = true;
		return Promise.resolve();
	}

	async read(maxBytes: number, options: Readonly<{ readonly signal: AbortSignal }>): Promise<Uint8Array> {
		if (this.#closed) throw new TypeError("stream is closed");
		if (this.#behavior === "slow" || (this.#behavior === "first-then-slow" && this.#frames.length === 0)) {
			return new Promise<Uint8Array>((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
			});
		}
		if (this.#behavior === "paced") {
			await new Promise<void>((resolvePromise, reject) => {
				const onAbort = (): void => {
					clearTimeout(timeout);
					reject(options.signal.reason);
				};
				const timeout = setTimeout(() => {
					options.signal.removeEventListener("abort", onAbort);
					resolvePromise();
				}, 9_999);
				options.signal.addEventListener("abort", onAbort, { once: true });
			});
		}
		const frame = this.#frames.shift();
		if (frame === undefined) throw new TypeError("scripted peer omitted a frame");
		if (frame.bytes.byteLength > maxBytes && this.#behavior !== "oversized-body") {
			throw new TypeError("scripted frame exceeds requested bound");
		}
		if (frame.kind === "body") this.#emittedBodyBytes.push(frame.bytes.byteLength);
		return new Uint8Array(frame.bytes);
	}

	write(exactBytes: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new TypeError("stream is closed"));
		const request = exactRecord(decodeCanonical(new Uint8Array(exactBytes)));
		this.requests.push(request);
		if (request.kind === "snapshot-manifest-request") {
			this.#frames.push({
				bytes: encodeCanonical({
					exactCanonicalManifestBytes: this.#fixture.declaration.exactCanonicalManifestBytes,
					kind: "snapshot-manifest-response",
					manifestDigest: this.#fixture.declaration.scope.manifestDigest,
					version: 1,
				}),
				kind: "control",
			});
			return Promise.resolve();
		}
		if (request.kind !== "snapshot-chunk-request" || !Array.isArray(request.descriptors)) {
			return Promise.reject(new TypeError("scripted peer rejected request"));
		}
		const requested = this.#behavior === "first-then-slow" ? request.descriptors.slice(0, 1) : request.descriptors;
		for (const value of requested) {
			const descriptor = exactRecord(value);
			const index = descriptor.index;
			if (typeof index !== "number") return Promise.reject(new TypeError("scripted descriptor index is invalid"));
			const selected = this.#fixture.declaration.chunks[index];
			const body = this.#fixture.chunks[index];
			if (selected === undefined || body === undefined) {
				return Promise.reject(new TypeError("scripted descriptor is absent"));
			}
			this.#frames.push({
				bytes: encodeCanonical({
					byteLength: selected.byteLength,
					digest: this.#behavior === "mismatched-control" ? "ff".repeat(32) : selected.digest,
					index,
					kind: "snapshot-chunk-response",
					manifestDigest: this.#fixture.declaration.scope.manifestDigest,
					version: 1,
				}),
				kind: "control",
			});
			const exactBody = this.#behavior === "oversized-body" ? new Uint8Array(131_073).fill(0x5a) : new Uint8Array(body);
			if (this.#behavior === "corrupt") exactBody[0] = (exactBody[0] ?? 0) ^ 0xff;
			this.#frames.push({ bytes: exactBody, kind: "body" });
		}
		return Promise.resolve();
	}
}

class InboundProbeStream implements SnapshotChunkProtocolStream {
	readonly #requests: Uint8Array[];
	readonly #servedAborts: unknown[];
	readonly #servedWrites: Uint8Array[];
	#closed = false;
	readonly peerId: string;
	readonly responses: Uint8Array[] = [];

	constructor(peerId: string, requests: readonly Uint8Array[], servedWrites: Uint8Array[], servedAborts: unknown[]) {
		this.peerId = peerId;
		this.#requests = requests.map((bytes) => new Uint8Array(bytes));
		this.#servedWrites = servedWrites;
		this.#servedAborts = servedAborts;
	}

	abort(reason?: Error): void {
		this.#closed = true;
		this.#servedAborts.push(reason);
	}

	close(): Promise<void> {
		this.#closed = true;
		return Promise.resolve();
	}

	read(maxBytes: number): Promise<Uint8Array> {
		if (this.#closed) return Promise.reject(new TypeError("stream is closed"));
		const frame = this.#requests.shift();
		if (frame === undefined || frame.byteLength > maxBytes) {
			return Promise.reject(new TypeError("inbound probe request is invalid"));
		}
		return Promise.resolve(new Uint8Array(frame));
	}

	write(exactBytes: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new TypeError("stream is closed"));
		const copied = new Uint8Array(exactBytes);
		this.responses.push(copied);
		this.#servedWrites.push(new Uint8Array(copied));
		return Promise.resolve();
	}
}

/** Deterministic transport boundary shared by the transfer-session RED cases. */
export class ScriptedSnapshotChunkPort implements SnapshotChunkProtocolPort {
	readonly #behaviors: ReadonlyMap<string, SnapshotScriptedPeerBehavior>;
	readonly #fixture: SnapshotQuarantineFixture;
	#handler: ((stream: SnapshotChunkProtocolStream) => Promise<void>) | undefined;
	readonly localPeerId: string;
	readonly emittedBodyBytes: number[] = [];
	readonly opened: string[] = [];
	readonly requests: Readonly<Record<string, unknown>>[] = [];
	readonly servedAborts: unknown[] = [];
	readonly servedWrites: Uint8Array[] = [];

	/**
	 * Creates one isolated scripted protocol port.
	 * @param fixture - Exact manifest and chunk bodies served by every configured peer.
	 * @param behaviors - Authenticated peer identities and their one causal behavior.
	 * @param localPeerId - Local authenticated transport identity.
	 */
	constructor(
		fixture: SnapshotQuarantineFixture,
		behaviors: ReadonlyMap<string, SnapshotScriptedPeerBehavior>,
		localPeerId = "peer:receiver"
	) {
		this.#fixture = fixture;
		this.#behaviors = behaviors;
		this.localPeerId = localPeerId;
	}

	/**
	 * Closes the scripted protocol owner and removes its server.
	 * @returns Completion after the handler is detached.
	 */
	close(): Promise<void> {
		this.#handler = undefined;
		return Promise.resolve();
	}

	/** @returns Exact sorted already-connected peer identities. */
	connectedPeers(): readonly string[] {
		return [...this.#behaviors.keys()].sort();
	}

	/**
	 * Delivers one exact inbound protocol exchange to the installed server.
	 * @param peerId - Authenticated remote transport identity.
	 * @param requests - Exact request frames supplied by that peer.
	 * @returns Detached response frames written by the server.
	 */
	async dispatch(peerId: string, requests: readonly Uint8Array[]): Promise<readonly Uint8Array[]> {
		const handler = this.#handler;
		if (handler === undefined) throw new TypeError("snapshot server is absent");
		const stream = new InboundProbeStream(peerId, requests, this.servedWrites, this.servedAborts);
		await handler(stream);
		return Object.freeze(stream.responses.map((bytes) => new Uint8Array(bytes)));
	}

	/**
	 * Opens one scripted stream without dialing.
	 * @param peerId - Already-connected peer identity.
	 * @returns The peer's deterministic response stream.
	 */
	open(peerId: string): Promise<SnapshotChunkProtocolStream> {
		const behavior = this.#behaviors.get(peerId);
		if (behavior === undefined) return Promise.reject(new TypeError("peer is not already connected"));
		this.opened.push(peerId);
		return Promise.resolve(new ScriptedStream(peerId, behavior, this.#fixture, this.requests, this.emittedBodyBytes));
	}

	/**
	 * Installs the single inbound serving handler.
	 * @param handler - Protocol server to invoke for dispatched streams.
	 * @returns Idempotent handler removal.
	 */
	serve(handler: (stream: SnapshotChunkProtocolStream) => Promise<void>): () => void {
		if (this.#handler !== undefined) throw new TypeError("snapshot server is already installed");
		this.#handler = handler;
		return (): void => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}
}

/**
 * Builds exact authenticated peer-to-author and current-authority evidence.
 * @param peers - Authenticated peers in deterministic author order.
 * @returns Closed authorization provider.
 */
export function snapshotPeerAuthorization(peers: readonly string[]): SnapshotPeerAuthorization {
	const mappings = new Map(peers.map((peer, index) => [peer, `author:${index}`]));
	return Object.freeze({
		authorForPeer: (peerId: string): string | undefined => mappings.get(peerId),
		isAuthorizedAuthor: (author: string): boolean => [...mappings.values()].includes(author),
	});
}

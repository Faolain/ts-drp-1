import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { SNAPSHOT_PULL_INACTIVITY_MS } from "@ts-drp/node/snapshot-transfer";

/**
 * The creator's successor servings kept at once: the newest and the one it replaced.
 *
 * The creator switches its serving to the successor at its seal, but members learn that successor
 * only from the offer it publishes after the adoption and export. Serving the newest successor alone
 * refused every material request made from a member's newest known offer between the seal and that
 * offer's arrival ("stale"), however fast the member. Keeping the replaced serving answers those
 * requests: its material and snapshot are immutable and bound to their manifest, and the material
 * server signs each response for its request (nonce, requester, manifest). Memory: one more serving
 * (one auxiliary material, at most CREATOR_SUCCESSOR_TRANSPORT_LIMITS.maxResponseBytes, and one open
 * snapshot scope), never more.
 */
export const CREATOR_SUCCESSOR_SERVINGS_RETAINED = 2 as const;

// The largest first frame any serving reads (snapshot-transfer MAX_MANIFEST_BYTES); material
// requests are far smaller.
const FIRST_FRAME_MAX_BYTES = 212_387;

type Handler = (stream: SnapshotChunkProtocolStream) => Promise<void>;
interface Route {
	handler: Handler | undefined;
	readonly active: Set<Readonly<{ stream: SnapshotChunkProtocolStream; task: Promise<void> }>>;
}

/** Routes the creator-successor protocol's streams to the serving of the manifest each names. */
export interface CreatorSuccessorServingRouter {
	/**
	 * A port for one manifest's serving owner. Its `serve` receives the streams whose first frame names
	 * that manifest; its `close` stops them (aborting any in flight) and joins their handlers.
	 */
	port(manifestDigest: string): SnapshotChunkProtocolPort;
	/**
	 * Serves on a newly opened protocol port (the host keeps one server per protocol, and a host may
	 * hand out a new port per opening). The previous port stops taking streams but keeps the ones in
	 * flight (a fetch of the serving now retained) until the next attach closes it. Routes are kept.
	 */
	attach(port: SnapshotChunkProtocolPort): Promise<void>;
	/** The manifest a stream naming no served manifest goes to (the newest serving refuses it). */
	setCurrent(manifestDigest: string): void;
	close(): Promise<void>;
}

function manifestOf(bytes: Uint8Array): string | undefined {
	try {
		const value = decodeCanonical(bytes, { maxBytes: FIRST_FRAME_MAX_BYTES });
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const digest = Reflect.get(value, "manifestDigest");
		return typeof digest === "string" ? digest : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A stream whose first read returns the frame the router already read.
 * @param stream - The inbound stream.
 * @param first - Its first frame.
 * @returns The stream as the serving owner reads it.
 */
function replayFirstFrame(stream: SnapshotChunkProtocolStream, first: Uint8Array): SnapshotChunkProtocolStream {
	let pending: Uint8Array | undefined = first;
	return Object.freeze({
		peerId: stream.peerId,
		...(stream.connection === undefined ? {} : { connection: stream.connection }),
		abort: (reason?: Error): void => stream.abort(reason),
		close: (): Promise<void> => stream.close(),
		write: (bytes: Uint8Array, options: Readonly<{ readonly signal: AbortSignal }>): Promise<void> =>
			stream.write(bytes, options),
		read: (maxBytes: number, options: Readonly<{ readonly signal: AbortSignal }>): Promise<Uint8Array> => {
			const frame = pending;
			if (frame === undefined) return stream.read(maxBytes, options);
			pending = undefined;
			if (options.signal.aborted) return Promise.reject(options.signal.reason);
			if (frame.byteLength > maxBytes) {
				const failure = new Error("snapshot frame violates its byte bound");
				stream.abort(failure);
				return Promise.reject(failure);
			}
			return Promise.resolve(frame);
		},
	});
}

/**
 * The creator room's successor-serving router (see CREATOR_SUCCESSOR_SERVINGS_RETAINED).
 * @returns A router with no port attached and no routes.
 */
export function createCreatorSuccessorServingRouter(): CreatorSuccessorServingRouter {
	const routes = new Map<string, Route>();
	let current: string | undefined;
	let attached: SnapshotChunkProtocolPort | undefined;
	let draining: SnapshotChunkProtocolPort | undefined;
	let stopAttached: (() => void) | undefined;
	let closed = false;
	const incoming = async (stream: SnapshotChunkProtocolStream): Promise<void> => {
		let first: Uint8Array;
		try {
			first = await stream.read(FIRST_FRAME_MAX_BYTES, { signal: AbortSignal.timeout(SNAPSHOT_PULL_INACTIVITY_MS) });
		} catch (error) {
			stream.abort(error instanceof Error ? error : new Error("creator successor request was not read"));
			return;
		}
		const named = manifestOf(first);
		const route =
			(named === undefined ? undefined : routes.get(named)) ??
			(current === undefined ? undefined : routes.get(current));
		const handler = route?.handler;
		if (route === undefined || handler === undefined) {
			stream.abort(new Error("creator successor serving is unavailable"));
			return;
		}
		const wrapped = replayFirstFrame(stream, first);
		const entry = Object.freeze({ stream: wrapped, task: Promise.resolve().then(() => handler(wrapped)) });
		route.active.add(entry);
		try {
			await entry.task;
		} finally {
			route.active.delete(entry);
		}
	};
	const stopRoute = async (manifestDigest: string, route: Route): Promise<void> => {
		if (routes.get(manifestDigest) === route) routes.delete(manifestDigest);
		route.handler = undefined;
		const active = [...route.active];
		for (const { stream } of active) stream.abort(new Error("creator successor serving closed"));
		await Promise.allSettled(active.map(({ task }) => task));
	};
	return Object.freeze({
		port(manifestDigest: string): SnapshotChunkProtocolPort {
			const route: Route = { handler: undefined, active: new Set() };
			return Object.freeze({
				get localPeerId(): string {
					return attached?.localPeerId ?? "";
				},
				connectedPeers: (): readonly string[] => attached?.connectedPeers() ?? [],
				open: (): Promise<SnapshotChunkProtocolStream> =>
					Promise.reject(new TypeError("creator successor serving port does not open streams")),
				serve: (handler: Handler): (() => void) => {
					if (closed || route.handler !== undefined || routes.has(manifestDigest))
						throw new TypeError("creator successor serving is unavailable");
					route.handler = handler;
					routes.set(manifestDigest, route);
					return (): void => {
						if (routes.get(manifestDigest) === route) routes.delete(manifestDigest);
						route.handler = undefined;
					};
				},
				close: (): Promise<void> => stopRoute(manifestDigest, route),
			});
		},
		async attach(port: SnapshotChunkProtocolPort): Promise<void> {
			if (closed) throw new TypeError("creator successor serving is closed");
			const older = draining;
			stopAttached?.();
			stopAttached = undefined;
			draining = attached;
			attached = undefined;
			await older?.close();
			stopAttached = port.serve(incoming);
			attached = port;
		},
		setCurrent(manifestDigest: string): void {
			current = manifestDigest;
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			const selected = [...routes.entries()];
			await Promise.allSettled(selected.map(([digest, route]) => stopRoute(digest, route)));
			stopAttached?.();
			stopAttached = undefined;
			const previous = [attached, draining];
			attached = undefined;
			draining = undefined;
			await Promise.allSettled(previous.map((port) => port?.close()));
		},
	});
}

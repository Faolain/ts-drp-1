import type { Connection, Stream } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { WebRTC, WebRTCDirect } from "@multiformats/multiaddr-matcher";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";

export const DRP_UNRELIABLE_WEBRTC_SIGNALING_PROTOCOL = "/ts-drp/unreliable-webrtc/1.0.0";

const RAW_CHANNEL_LABEL = "ts-drp-ephemeral/1";
const ROUTE_DOMAIN = new TextEncoder().encode("ts-drp-ephemeral-route-v1\0");
const ROUTE_VERSION = 1;
const ROUTE_HEADER_BYTES = 33;
const MAX_ROUTED_ENVELOPE_BYTES = 1_200;
const MAX_PAYLOAD_BYTES = MAX_ROUTED_ENVELOPE_BYTES - ROUTE_HEADER_BYTES;
export const DRP_UNRELIABLE_WEBRTC_MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;
const MAX_LINKS = 8;
const MAX_CANDIDATES = 32;
const MAX_SDP_BYTES = 16_384;
const MAX_SIGNALING_FRAME_BYTES = 65_536;
const SETUP_TIMEOUT_MS = 10_000;
const BUFFERED_AMOUNT_CEILING = 65_536;

export interface DRPUnreliableWebRtcSnapshot {
	readonly activeLinks: number;
	readonly authenticatedConnectionLosses: number;
	readonly backpressuredDrops: number;
	readonly handshakeFailures: number;
	readonly lastLinkDrop:
		| "channel-close"
		| "connection-close"
		| "connection-failed"
		| "owner-close"
		| "replacement"
		| "restart"
		| "send-error"
		| undefined;
	readonly linkDrops: number;
	readonly received: number;
	readonly routedBytesReceived: number;
	readonly routedBytesSent: number;
	readonly sent: number;
	readonly unknownRouteDrops: number;
	readonly links: readonly Readonly<{
		readonly connectionId: string;
		readonly generation: number;
		readonly label: string;
		readonly maxRetransmits: number;
		readonly ordered: boolean;
		readonly peerId: string;
		readonly remoteAddr: string;
	}>[];
}

export interface DRPUnreliableWebRtcRoute {
	readonly maxPayloadBytes: number;
	close(): void;
	onMessage(listener: (ingress: { readonly bytes: Uint8Array; readonly sender: string }) => void): () => void;
	reconcile(peers: readonly string[]): Promise<void>;
	restart(): Promise<void>;
	send(peers: readonly string[], bytes: Uint8Array): Promise<boolean>;
	snapshot(): DRPUnreliableWebRtcSnapshot;
}

export interface DRPUnreliableWebRtcOwner {
	close(): void;
	openUnreliableWebRtcRoute(routeId: string): DRPUnreliableWebRtcRoute;
}

export interface AuthenticatedWebRtcConnection {
	readonly generation: number;
	readonly id: string;
	readonly remoteAddr: string;
	readonly remotePeerId: string;
	readonly transport: "other" | "webrtc";
	exchange(request: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
	onClose(listener: () => void): () => void;
}

export interface AuthenticatedWebRtcSignalingPort {
	readonly localPeerId: string;
	connections(): readonly AuthenticatedWebRtcConnection[];
	onRequest(
		listener: (connection: AuthenticatedWebRtcConnection, request: Uint8Array) => Promise<Uint8Array>
	): () => void;
}

interface IncomingSignalingStream {
	readonly connection: Connection;
	readonly stream: Stream;
}

interface Libp2pSignalingPortInput {
	connections(): readonly Connection[];
	readonly localPeerId: string;
	onIncoming(listener: (input: IncomingSignalingStream) => Promise<void>): () => void;
	read(stream: Stream, maxBytes: number): Promise<Uint8Array>;
	write(stream: Stream, bytes: Uint8Array): Promise<void>;
}

interface SignalDescription {
	readonly candidates: readonly RTCIceCandidateInit[];
	readonly sdp: string;
	readonly type: "answer" | "offer";
}

interface RouteRegistration {
	closed: boolean;
	readonly digest: Uint8Array;
	readonly digestHex: string;
	readonly listeners: Set<(ingress: { readonly bytes: Uint8Array; readonly sender: string }) => void>;
	membershipReconciled: boolean;
	peers: readonly string[];
	readonly routeId: string;
}

interface ActiveLink {
	readonly channel: RTCDataChannel;
	readonly connection: AuthenticatedWebRtcConnection;
	closing: boolean;
	readonly pc: RTCPeerConnection;
	unsubscribeConnection(): void;
}

interface PendingPeerConnection {
	readonly peerId: string;
	unsubscribeConnection(): void;
}

const abortedStreams = new WeakSet<object>();

function isWebRtcAddress(address: string): boolean {
	try {
		const parsed = multiaddr(address);
		return WebRTC.matches(parsed) || WebRTCDirect.matches(parsed);
	} catch {
		return false;
	}
}

function errorFrom(value: unknown, fallback: string): Error {
	return value instanceof Error ? value : new Error(fallback);
}

function abortStream(stream: unknown, error: Error): void {
	if (typeof stream !== "object" || stream === null || !("abort" in stream)) return;
	if (abortedStreams.has(stream)) return;
	const abort = (stream as { abort?: unknown }).abort;
	if (typeof abort !== "function") return;
	abortedStreams.add(stream);
	abort.call(stream, error);
}

async function closeStream(stream: unknown): Promise<void> {
	if (typeof stream !== "object" || stream === null || !("close" in stream)) return;
	const close = (stream as { close?: unknown }).close;
	if (typeof close === "function") await close.call(stream);
}

async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = SETUP_TIMEOUT_MS): Promise<T> {
	if (timeoutMs <= 0) throw new Error("RTC setup deadline exceeded");
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work(controller.signal),
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => {
					const error = new Error("RTC setup deadline exceeded");
					controller.abort(error);
					reject(error);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

/**
 * Adapt exact already-authenticated libp2p connections into the narrow signaling boundary.
 * This owner opens streams only on the supplied connections and has no dialing capability.
 * @param input Authenticated connection and framed-stream owners.
 * @returns A signaling port with detached exact peer attribution.
 */
export function createLibp2pWebRtcSignalingPort(input: Libp2pSignalingPortInput): AuthenticatedWebRtcSignalingPort {
	const generations = new WeakMap<Connection, number>();
	const wrappers = new WeakMap<Connection, AuthenticatedWebRtcConnection>();
	let nextGeneration = 1;
	let requestListener:
		| ((connection: AuthenticatedWebRtcConnection, request: Uint8Array) => Promise<Uint8Array>)
		| undefined;

	const adapt = (connection: Connection): AuthenticatedWebRtcConnection => {
		const existing = wrappers.get(connection);
		if (existing !== undefined) return existing;
		const generation = generations.get(connection) ?? nextGeneration++;
		generations.set(connection, generation);
		const closeListeners = new Set<() => void>();
		connection.addEventListener(
			"close",
			() => {
				for (const listener of closeListeners) listener();
			},
			{ once: true }
		);
		const remoteAddr = connection.remoteAddr.toString();
		const adapted: AuthenticatedWebRtcConnection = Object.freeze({
			exchange: async (request: Uint8Array, signal: AbortSignal): Promise<Uint8Array> => {
				const stream = await connection.newStream(DRP_UNRELIABLE_WEBRTC_SIGNALING_PROTOCOL, { signal });
				const onAbort = (): void => abortStream(stream, errorFrom(signal.reason, "RTC signaling exchange aborted"));
				if (signal.aborted) onAbort();
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					await input.write(stream, request.slice());
					return (await input.read(stream, MAX_SIGNALING_FRAME_BYTES)).slice();
				} catch (error) {
					if (!signal.aborted) abortStream(stream, errorFrom(error, "RTC signaling exchange failed"));
					throw error;
				} finally {
					signal.removeEventListener("abort", onAbort);
					await closeStream(stream).catch(() => undefined);
				}
			},
			generation,
			id: connection.id,
			onClose(listener: () => void): () => void {
				closeListeners.add(listener);
				return (): void => {
					closeListeners.delete(listener);
				};
			},
			remoteAddr,
			remotePeerId: connection.remotePeer.toString(),
			transport: isWebRtcAddress(remoteAddr) ? "webrtc" : "other",
		});
		wrappers.set(connection, adapted);
		return adapted;
	};

	const unsubscribeIncoming = input.onIncoming(async ({ connection, stream }) => {
		try {
			await withDeadline(async (signal) => {
				const onAbort = (): void => abortStream(stream, errorFrom(signal.reason, "RTC signaling request aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					if (requestListener === undefined) throw new Error("unreliable WebRTC signaling owner is unavailable");
					const authenticated = adapt(connection);
					if (authenticated.transport !== "webrtc") {
						throw new Error("unreliable WebRTC signaling transport rejected");
					}
					const request = (await input.read(stream, MAX_SIGNALING_FRAME_BYTES)).slice();
					const response = await requestListener(authenticated, request);
					await input.write(stream, response.slice());
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			});
		} catch (error) {
			abortStream(stream, errorFrom(error, "RTC signaling request failed"));
			throw error;
		} finally {
			await closeStream(stream).catch(() => undefined);
		}
	});

	return Object.freeze({
		connections: (): readonly AuthenticatedWebRtcConnection[] => input.connections().map(adapt),
		localPeerId: input.localPeerId,
		onRequest(
			listener: (connection: AuthenticatedWebRtcConnection, request: Uint8Array) => Promise<Uint8Array>
		): () => void {
			requestListener = listener;
			return (): void => {
				if (requestListener === listener) requestListener = undefined;
				unsubscribeIncoming();
			};
		},
	});
}

function candidateInit(candidate: RTCIceCandidate): RTCIceCandidateInit {
	if (typeof candidate.toJSON === "function") return candidate.toJSON();
	return {
		candidate: candidate.candidate,
		sdpMLineIndex: candidate.sdpMLineIndex,
		sdpMid: candidate.sdpMid,
		usernameFragment: candidate.usernameFragment ?? undefined,
	};
}

async function localDescription(
	pc: RTCPeerConnection,
	description: RTCSessionDescriptionInit
): Promise<SignalDescription> {
	const candidates: RTCIceCandidateInit[] = [];
	let malformedCandidate = false;
	let complete = pc.iceGatheringState === "complete";
	let resolveComplete: (() => void) | undefined;
	const completion = new Promise<void>((resolve) => {
		resolveComplete = resolve;
	});
	const onCandidate = (event: RTCPeerConnectionIceEvent): void => {
		if (event.candidate === null) {
			complete = true;
			resolveComplete?.();
			return;
		}
		if (event.candidate === undefined) {
			malformedCandidate = true;
			return;
		}
		candidates.push(candidateInit(event.candidate));
	};
	pc.addEventListener("icecandidate", onCandidate);
	try {
		await pc.setLocalDescription(description);
		if (pc.iceGatheringState === "complete") complete = true;
		if (!complete) await completion;
	} finally {
		pc.removeEventListener("icecandidate", onCandidate);
	}
	if (malformedCandidate || candidates.length > MAX_CANDIDATES) throw new Error("RTC candidate bound exceeded");
	const selected = pc.localDescription ?? description;
	if (selected.type !== "offer" && selected.type !== "answer") throw new Error("RTC description type is invalid");
	const sdp = selected.sdp ?? "";
	if (new TextEncoder().encode(sdp).byteLength > MAX_SDP_BYTES) throw new Error("RTC SDP bound exceeded");
	return Object.freeze({
		candidates: candidates.map((candidate) => Object.freeze({ ...candidate })),
		sdp,
		type: selected.type,
	});
}

function decodeDescription(bytes: Uint8Array, expectedType: "answer" | "offer"): SignalDescription {
	if (bytes.byteLength > MAX_SIGNALING_FRAME_BYTES) throw new Error("RTC signaling frame exceeds its byte bound");
	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("RTC signaling frame is malformed");
	}
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
		throw new Error("RTC signaling frame is malformed");
	}
	const value = decoded as Record<string, unknown>;
	if (
		Object.keys(value).sort().join(",") !== "candidates,sdp,type" ||
		value.type !== expectedType ||
		typeof value.sdp !== "string" ||
		new TextEncoder().encode(value.sdp).byteLength > MAX_SDP_BYTES ||
		!Array.isArray(value.candidates) ||
		value.candidates.length > MAX_CANDIDATES
	) {
		throw new Error("RTC signaling frame is outside its contract");
	}
	const candidates = value.candidates.map((candidate): RTCIceCandidateInit => {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
			throw new Error("RTC signaling candidate is malformed");
		}
		const selected = candidate as Record<string, unknown>;
		if (typeof selected.candidate !== "string") throw new Error("RTC signaling candidate is malformed");
		return selected as RTCIceCandidateInit;
	});
	return Object.freeze({ candidates, sdp: value.sdp, type: expectedType });
}

function encodeDescription(description: SignalDescription): Uint8Array {
	const bytes = new TextEncoder().encode(JSON.stringify(description));
	if (bytes.byteLength > MAX_SIGNALING_FRAME_BYTES) throw new Error("RTC signaling frame exceeds its byte bound");
	return bytes;
}

async function addRemoteCandidates(pc: RTCPeerConnection, candidates: readonly RTCIceCandidateInit[]): Promise<void> {
	for (const candidate of candidates) await pc.addIceCandidate(candidate);
}

function validateChannel(channel: RTCDataChannel): void {
	if (channel.label === "init" || channel.label !== RAW_CHANNEL_LABEL)
		throw new Error("RTC data channel label rejected");
	if (channel.ordered || channel.maxRetransmits !== 0) throw new Error("RTC data channel reliability rejected");
}

function validateSctp(pc: RTCPeerConnection): void {
	if (pc.sctp === null || pc.sctp.maxMessageSize < MAX_ROUTED_ENVELOPE_BYTES) {
		throw new Error("RTC SCTP maximum is below the routed envelope bound");
	}
}

function waitForOpen(channel: RTCDataChannel): Promise<void> {
	if (channel.readyState === "open") return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const onOpen = (): void => {
			cleanup();
			resolve();
		};
		const onClose = (): void => {
			cleanup();
			reject(new Error("RTC data channel closed during setup"));
		};
		const cleanup = (): void => {
			channel.removeEventListener("open", onOpen);
			channel.removeEventListener("close", onClose);
		};
		channel.addEventListener("open", onOpen);
		channel.addEventListener("close", onClose);
	});
}

function messageBytes(data: unknown): Uint8Array | undefined {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return undefined;
}

class UnreliableWebRtcOwner implements DRPUnreliableWebRtcOwner {
	readonly #activatedPeers = new Set<string>();
	readonly #createPeerConnection: () => RTCPeerConnection;
	readonly #links = new Map<string, ActiveLink>();
	readonly #pendingReplacementLinks = new Map<string, ActiveLink>();
	readonly #pendingLinks = new Map<string, Promise<ActiveLink | undefined>>();
	readonly #pendingPeerConnections = new Map<RTCPeerConnection, PendingPeerConnection>();
	readonly #retiringLinks = new Map<string, ActiveLink>();
	readonly #replacementAdmissions = new Map<
		string,
		Readonly<{ readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout> }>
	>();
	readonly #retryLinks = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #routes = new Map<string, RouteRegistration>();
	readonly #routesByDigest = new Map<string, RouteRegistration>();
	readonly #signaling: AuthenticatedWebRtcSignalingPort;
	readonly #unsubscribeRequest: () => void;
	#authenticatedConnectionLosses = 0;
	#backpressuredDrops = 0;
	#closed = false;
	#handshakeFailures = 0;
	#lastLinkDrop: DRPUnreliableWebRtcSnapshot["lastLinkDrop"];
	#linkDrops = 0;
	#received = 0;
	#routedBytesReceived = 0;
	#routedBytesSent = 0;
	#sent = 0;
	#unknownRouteDrops = 0;

	constructor(
		input: Readonly<{ createPeerConnection(): RTCPeerConnection; signaling: AuthenticatedWebRtcSignalingPort }>
	) {
		this.#createPeerConnection = input.createPeerConnection;
		this.#signaling = input.signaling;
		this.#unsubscribeRequest = this.#signaling.onRequest((connection, request) =>
			this.#handleSignalingRequest(connection, request)
		);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribeRequest();
		for (const route of this.#routes.values()) route.closed = true;
		this.#routes.clear();
		this.#routesByDigest.clear();
		this.#closeAllLinks();
	}

	openUnreliableWebRtcRoute(routeId: string): DRPUnreliableWebRtcRoute {
		if (this.#closed) return this.#closedRoute();
		const existing = this.#routes.get(routeId);
		if (existing !== undefined) return this.#route(existing);
		const digest = sha256(concatBytes(ROUTE_DOMAIN, new TextEncoder().encode(routeId)));
		const registration: RouteRegistration = {
			closed: false,
			digest,
			digestHex: bytesToHex(digest),
			listeners: new Set(),
			membershipReconciled: false,
			peers: Object.freeze([]),
			routeId,
		};
		this.#routes.set(routeId, registration);
		this.#routesByDigest.set(registration.digestHex, registration);
		return this.#route(registration);
	}

	#closedRoute(): DRPUnreliableWebRtcRoute {
		return Object.freeze({
			close(): void {},
			maxPayloadBytes: MAX_PAYLOAD_BYTES,
			onMessage: (): (() => void) => (): void => undefined,
			reconcile: (): Promise<void> => Promise.resolve(),
			restart: (): Promise<void> => Promise.resolve(),
			send: (): Promise<boolean> => Promise.resolve(false),
			snapshot: (): DRPUnreliableWebRtcSnapshot => this.#snapshot(),
		});
	}

	#route(registration: RouteRegistration): DRPUnreliableWebRtcRoute {
		return Object.freeze({
			close: (): void => this.#closeRoute(registration),
			maxPayloadBytes: MAX_PAYLOAD_BYTES,
			onMessage: (
				listener: (ingress: { readonly bytes: Uint8Array; readonly sender: string }) => void
			): (() => void) => {
				if (registration.closed) return (): void => undefined;
				registration.listeners.add(listener);
				return (): void => {
					registration.listeners.delete(listener);
				};
			},
			reconcile: (peers: readonly string[]): Promise<void> => this.#reconcile(registration, peers),
			restart: (): Promise<void> => this.#restart(registration),
			send: (peers: readonly string[], bytes: Uint8Array): Promise<boolean> => this.#send(registration, peers, bytes),
			snapshot: (): DRPUnreliableWebRtcSnapshot => this.#snapshot(),
		});
	}

	#closeRoute(registration: RouteRegistration): void {
		if (registration.closed) return;
		registration.closed = true;
		registration.listeners.clear();
		this.#routes.delete(registration.routeId);
		this.#routesByDigest.delete(registration.digestHex);
		if (this.#routes.size === 0) {
			this.#closeAllLinks();
			return;
		}
		this.#pruneReplacementAdmissions();
		for (const peerId of [...this.#retryLinks.keys()]) {
			if (!this.#desiredPeers().includes(peerId)) this.#clearLinkRetry(peerId);
		}
	}

	async #reconcile(registration: RouteRegistration, peers: readonly string[]): Promise<void> {
		if (this.#closed || registration.closed || new Set(peers).size !== peers.length) return;
		registration.membershipReconciled = true;
		registration.peers = Object.freeze(peers.slice(0, MAX_LINKS));
		this.#pruneReplacementAdmissions();
		await Promise.all(
			registration.peers.map(async (peerId) => {
				const link = await this.#linkFor(peerId);
				const replacement = this.#pendingLinks.get(peerId);
				if (replacement !== undefined) await replacement;
				if (link === undefined) this.#scheduleLinkRetry(peerId);
			})
		);
	}

	async #restart(registration: RouteRegistration): Promise<void> {
		if (this.#closed || registration.closed) return;
		for (const peerId of registration.peers) {
			this.#clearReplacementAdmission(peerId);
			this.#clearLinkRetry(peerId);
			this.#closePendingForPeer(peerId);
			const link = this.#links.get(peerId);
			if (link !== undefined) this.#dropLink(peerId, link, "restart");
		}
		await this.#reconcile(registration, registration.peers);
	}

	async #send(registration: RouteRegistration, peers: readonly string[], bytes: Uint8Array): Promise<boolean> {
		if (
			this.#closed ||
			registration.closed ||
			bytes.byteLength > MAX_PAYLOAD_BYTES ||
			peers.length === 0 ||
			peers.length > MAX_LINKS ||
			new Set(peers).size !== peers.length
		) {
			return false;
		}
		if (!registration.membershipReconciled) {
			const desiredPeers = [...new Set([...registration.peers, ...peers])].slice(0, MAX_LINKS);
			registration.peers = Object.freeze(desiredPeers);
			this.#pruneReplacementAdmissions();
			await Promise.all(
				desiredPeers.map(async (peerId) => {
					const existing = this.#links.get(peerId);
					const connection = this.#connectionFor(peerId);
					if (
						existing !== undefined &&
						existing.channel.readyState === "open" &&
						(connection === undefined || this.#isCurrent(existing.connection))
					) {
						return;
					}
					const setup = this.#linkFor(peerId);
					if (this.#activatedPeers.has(peerId)) {
						void setup;
						return;
					}
					await setup;
				})
			);
		}
		const targets: { readonly link: ActiveLink; readonly peerId: string }[] = [];
		for (const peerId of peers) {
			const link = this.#links.get(peerId);
			const connection = this.#connectionFor(peerId);
			if (link === undefined || link.channel.readyState !== "open") {
				if (link !== undefined && this.#desiredPeers().includes(peerId)) void this.#linkFor(peerId);
				return false;
			}
			if (connection !== undefined && !this.#isCurrent(link.connection) && this.#desiredPeers().includes(peerId)) {
				void this.#linkFor(peerId);
			}
			targets.push({ link, peerId });
		}
		if (targets.some(({ link }) => link.channel.bufferedAmount > BUFFERED_AMOUNT_CEILING)) {
			this.#backpressuredDrops += 1;
			return false;
		}
		const payload = bytes.slice();
		const envelope = new Uint8Array(ROUTE_HEADER_BYTES + payload.byteLength);
		envelope[0] = ROUTE_VERSION;
		envelope.set(registration.digest, 1);
		envelope.set(payload, ROUTE_HEADER_BYTES);
		let sent = true;
		for (const { link, peerId } of targets) {
			try {
				link.channel.send(envelope);
				this.#sent += 1;
				this.#routedBytesSent += envelope.byteLength;
			} catch {
				this.#dropLink(peerId, link, "send-error");
				sent = false;
			}
		}
		return sent;
	}

	async #linkFor(peerId: string): Promise<ActiveLink | undefined> {
		const existing = this.#links.get(peerId);
		const connection = this.#connectionFor(peerId);
		const unusable = existing !== undefined && existing.channel.readyState !== "open";
		const staleOpen =
			existing !== undefined &&
			existing.channel.readyState === "open" &&
			connection !== undefined &&
			!this.#isCurrent(existing.connection);
		if (existing !== undefined && !unusable && !staleOpen) return existing;
		if (existing !== undefined && unusable) {
			this.#reserveReplacementAdmission(peerId);
			this.#dropLink(peerId, existing, "replacement");
		}
		const pending = this.#pendingLinks.get(peerId);
		if (pending !== undefined) return staleOpen ? existing : pending;
		if (staleOpen && this.#pendingReplacementLinks.has(peerId)) return existing;
		if (staleOpen && this.#retiringLinks.has(peerId)) return existing;
		this.#pruneReplacementAdmissions();
		if (
			this.#signaling.localPeerId >= peerId ||
			this.#physicalPeerConnectionCount() >= MAX_LINKS ||
			(!this.#hasAdmission(peerId) && this.#logicalAdmissionCount() + this.#pendingPeerConnections.size >= MAX_LINKS)
		) {
			return staleOpen ? existing : undefined;
		}
		if (connection === undefined) return staleOpen ? existing : undefined;
		if (staleOpen && this.#retryLinks.has(peerId)) return existing;
		const setup = withDeadline((signal) => this.#initiate(connection, signal)).catch(() => {
			this.#closePendingForPeer(peerId);
			this.#handshakeFailures += 1;
			if (staleOpen) this.#scheduleLinkRetry(peerId);
			return undefined;
		});
		this.#pendingLinks.set(peerId, setup);
		if (staleOpen) {
			void setup.finally(() => {
				if (this.#pendingLinks.get(peerId) === setup) this.#pendingLinks.delete(peerId);
			});
			return existing;
		}
		try {
			return await setup;
		} finally {
			if (this.#pendingLinks.get(peerId) === setup) this.#pendingLinks.delete(peerId);
		}
	}

	#connectionFor(peerId: string): AuthenticatedWebRtcConnection | undefined {
		return this.#signaling
			.connections()
			.filter((connection) => connection.remotePeerId === peerId && connection.transport === "webrtc")
			.sort((left, right) => left.id.localeCompare(right.id))[0];
	}

	async #initiate(connection: AuthenticatedWebRtcConnection, signal: AbortSignal): Promise<ActiveLink> {
		const pc = this.#createPeerConnection();
		let authenticatedClosed = false;
		let established = false;
		const unsubscribeConnection = connection.onClose(() => {
			if (!established) {
				authenticatedClosed = true;
				pc.close();
				return;
			}
			this.#authenticatedConnectionLosses += 1;
		});
		this.#pendingPeerConnections.set(pc, {
			peerId: connection.remotePeerId,
			unsubscribeConnection,
		});
		try {
			const channel = pc.createDataChannel(RAW_CHANNEL_LABEL, { maxRetransmits: 0, ordered: false });
			channel.binaryType = "arraybuffer";
			validateChannel(channel);
			const offer = await localDescription(pc, await pc.createOffer());
			const answer = decodeDescription(await connection.exchange(encodeDescription(offer), signal), "answer");
			if (authenticatedClosed || !this.#isCurrent(connection)) throw new Error("authenticated connection changed");
			await pc.setRemoteDescription({ sdp: answer.sdp, type: "answer" });
			await addRemoteCandidates(pc, answer.candidates);
			validateSctp(pc);
			await waitForOpen(channel);
			if (authenticatedClosed || !this.#isCurrent(connection)) throw new Error("authenticated connection changed");
			established = true;
			const link = { channel, closing: false, connection, pc, unsubscribeConnection };
			const existing = this.#links.get(connection.remotePeerId);
			if (existing?.channel.readyState === "open" && !this.#sameConnection(existing.connection, connection)) {
				this.#holdReplacementLink(link);
				return existing;
			}
			this.#pendingPeerConnections.delete(pc);
			return this.#registerLink(link);
		} catch (error) {
			this.#pendingPeerConnections.delete(pc);
			unsubscribeConnection();
			pc.close();
			throw error;
		}
	}

	async #handleSignalingRequest(connection: AuthenticatedWebRtcConnection, request: Uint8Array): Promise<Uint8Array> {
		if (this.#closed || connection.transport !== "webrtc" || connection.remotePeerId >= this.#signaling.localPeerId) {
			throw new Error("unreliable WebRTC signaling request rejected");
		}
		this.#pruneReplacementAdmissions();
		if (
			this.#hasPendingPeerConnection(connection.remotePeerId) ||
			this.#physicalPeerConnectionCount() >= MAX_LINKS ||
			(!this.#hasAdmission(connection.remotePeerId) &&
				this.#logicalAdmissionCount() + this.#pendingPeerConnections.size >= MAX_LINKS)
		) {
			throw new Error("unreliable WebRTC signaling request rejected");
		}
		const deadlineAt = Date.now() + SETUP_TIMEOUT_MS;
		try {
			return await withDeadline((_signal) => this.#accept(connection, request, deadlineAt));
		} catch (error) {
			this.#closePendingForPeer(connection.remotePeerId);
			this.#handshakeFailures += 1;
			throw error;
		}
	}

	async #accept(
		connection: AuthenticatedWebRtcConnection,
		request: Uint8Array,
		deadlineAt: number
	): Promise<Uint8Array> {
		const offer = decodeDescription(request, "offer");
		const pc = this.#createPeerConnection();
		let authenticatedClosed = false;
		let established = false;
		let inboundChannelError: Error | undefined;
		const unsubscribeConnection = connection.onClose(() => {
			if (!established) {
				authenticatedClosed = true;
				pc.close();
				return;
			}
			this.#authenticatedConnectionLosses += 1;
		});
		this.#pendingPeerConnections.set(pc, {
			peerId: connection.remotePeerId,
			unsubscribeConnection,
		});
		try {
			const channelPromise = new Promise<RTCDataChannel>((resolve) => {
				pc.addEventListener(
					"datachannel",
					({ channel }) => {
						try {
							channel.binaryType = "arraybuffer";
							validateChannel(channel);
							resolve(channel);
						} catch (error) {
							inboundChannelError = errorFrom(error, "RTC data channel rejected");
							resolve(channel);
						}
					},
					{ once: true }
				);
			});
			await pc.setRemoteDescription({ sdp: offer.sdp, type: "offer" });
			if (inboundChannelError !== undefined) throw inboundChannelError;
			await addRemoteCandidates(pc, offer.candidates);
			const answer = await localDescription(pc, await pc.createAnswer());
			validateSctp(pc);
			const finish = async (): Promise<void> => {
				const channel = await channelPromise;
				validateChannel(channel);
				validateSctp(pc);
				await waitForOpen(channel);
				if (authenticatedClosed || !this.#isCurrent(connection)) {
					throw new Error("authenticated connection changed");
				}
				established = true;
				const link = { channel, closing: false, connection, pc, unsubscribeConnection };
				this.#pendingPeerConnections.delete(pc);
				this.#registerLink(link);
			};
			void withDeadline((_signal) => finish(), deadlineAt - Date.now()).catch(() => {
				this.#pendingPeerConnections.delete(pc);
				this.#handshakeFailures += 1;
				unsubscribeConnection();
				pc.close();
			});
			return encodeDescription(answer);
		} catch (error) {
			this.#pendingPeerConnections.delete(pc);
			unsubscribeConnection();
			pc.close();
			throw error;
		}
	}

	#isCurrent(connection: AuthenticatedWebRtcConnection): boolean {
		return this.#signaling.connections().some((candidate) => this.#sameConnection(candidate, connection));
	}

	#sameConnection(left: AuthenticatedWebRtcConnection, right: AuthenticatedWebRtcConnection): boolean {
		return (
			left.id === right.id &&
			left.generation === right.generation &&
			left.remotePeerId === right.remotePeerId &&
			left.remoteAddr === right.remoteAddr &&
			left.transport === "webrtc" &&
			right.transport === "webrtc"
		);
	}

	#registerLink(link: ActiveLink, prepared = false): ActiveLink {
		const peerId = link.connection.remotePeerId;
		this.#clearReplacementAdmission(peerId);
		this.#clearLinkRetry(peerId);
		const previous = this.#links.get(peerId);
		if (previous !== undefined && previous !== link) this.#retiringLinks.set(peerId, previous);
		this.#links.set(peerId, link);
		this.#activatedPeers.add(peerId);
		if (!prepared) this.#prepareLink(peerId, link);
		if (previous !== undefined && previous !== link) {
			this.#dropLink(peerId, previous, "replacement");
		}
		return link;
	}

	#prepareLink(peerId: string, link: ActiveLink): void {
		link.channel.addEventListener("message", (event) => this.#receive(peerId, link, event));
		link.channel.addEventListener(
			"close",
			() => {
				if (this.#pendingReplacementLinks.get(peerId) === link) this.#discardPendingReplacement(peerId, link);
				else if (this.#retiringLinks.get(peerId) === link) this.#finishRetiringLink(peerId, link);
				else this.#dropLink(peerId, link, "channel-close");
			},
			{ once: true }
		);
		link.pc.addEventListener("connectionstatechange", () => {
			if (link.pc.connectionState !== "closed" && link.pc.connectionState !== "failed") return;
			if (this.#pendingReplacementLinks.get(peerId) === link) this.#discardPendingReplacement(peerId, link);
			else if (this.#retiringLinks.get(peerId) === link) this.#finishRetiringLink(peerId, link);
			else
				this.#dropLink(peerId, link, link.pc.connectionState === "closed" ? "connection-close" : "connection-failed");
		});
	}

	#holdReplacementLink(link: ActiveLink): void {
		const peerId = link.connection.remotePeerId;
		const previous = this.#pendingReplacementLinks.get(peerId);
		if (previous !== undefined) this.#discardPendingReplacement(peerId, previous);
		this.#pendingReplacementLinks.set(peerId, link);
		this.#prepareLink(peerId, link);
	}

	#discardPendingReplacement(peerId: string, link: ActiveLink): void {
		if (link.closing) return;
		link.closing = true;
		if (this.#pendingReplacementLinks.get(peerId) === link) this.#pendingReplacementLinks.delete(peerId);
		this.#pendingPeerConnections.delete(link.pc);
		link.unsubscribeConnection();
		link.channel.close();
		link.pc.close();
	}

	#promotePendingReplacement(peerId: string): boolean {
		const pending = this.#pendingReplacementLinks.get(peerId);
		if (pending === undefined || pending.closing || pending.channel.readyState !== "open") return false;
		if (!this.#isCurrent(pending.connection)) {
			this.#discardPendingReplacement(peerId, pending);
			return false;
		}
		this.#pendingReplacementLinks.delete(peerId);
		this.#pendingPeerConnections.delete(pending.pc);
		this.#registerLink(pending, true);
		return true;
	}

	#receive(peerId: string, link: ActiveLink, event: MessageEvent): void {
		if (
			this.#links.get(peerId) !== link &&
			this.#pendingReplacementLinks.get(peerId) !== link &&
			this.#retiringLinks.get(peerId) !== link
		) {
			return;
		}
		const bytes = messageBytes(event.data);
		if (
			bytes === undefined ||
			bytes.byteLength < ROUTE_HEADER_BYTES ||
			bytes.byteLength > MAX_ROUTED_ENVELOPE_BYTES ||
			bytes[0] !== ROUTE_VERSION
		) {
			return;
		}
		const route = this.#routesByDigest.get(bytesToHex(bytes.subarray(1, ROUTE_HEADER_BYTES)));
		if (route === undefined || route.closed) {
			this.#unknownRouteDrops += 1;
			return;
		}
		const ingress = Object.freeze({ bytes: bytes.slice(ROUTE_HEADER_BYTES), sender: peerId });
		this.#received += 1;
		this.#routedBytesReceived += bytes.byteLength;
		for (const listener of route.listeners) {
			try {
				listener(ingress);
			} catch {
				// A route subscriber cannot tear down authenticated transport ingress.
			}
		}
	}

	#dropLink(peerId: string, link: ActiveLink, reason: NonNullable<DRPUnreliableWebRtcSnapshot["lastLinkDrop"]>): void {
		if (link.closing) return;
		link.closing = true;
		this.#lastLinkDrop = reason;
		this.#linkDrops += 1;
		if (this.#links.get(peerId) === link) this.#links.delete(peerId);
		link.unsubscribeConnection();
		link.channel.close();
		if (this.#retiringLinks.get(peerId) !== link) link.pc.close();
		if (!this.#links.has(peerId) && !this.#promotePendingReplacement(peerId)) this.#scheduleLinkRetry(peerId);
	}

	#finishRetiringLink(peerId: string, link: ActiveLink): void {
		if (this.#retiringLinks.get(peerId) !== link) return;
		this.#retiringLinks.delete(peerId);
		link.pc.close();
	}

	#closeAllLinks(): void {
		this.#activatedPeers.clear();
		this.#clearAllReplacementAdmissions();
		for (const peerId of [...this.#retryLinks.keys()]) this.#clearLinkRetry(peerId);
		for (const [peerId, link] of [...this.#pendingReplacementLinks]) {
			this.#discardPendingReplacement(peerId, link);
		}
		for (const [pc, pending] of this.#pendingPeerConnections) {
			pending.unsubscribeConnection();
			pc.close();
		}
		this.#pendingPeerConnections.clear();
		for (const [peerId, link] of [...this.#retiringLinks]) this.#finishRetiringLink(peerId, link);
		for (const [peerId, link] of [...this.#links]) this.#dropLink(peerId, link, "owner-close");
	}

	#clearLinkRetry(peerId: string): void {
		const retry = this.#retryLinks.get(peerId);
		if (retry === undefined) return;
		clearTimeout(retry);
		this.#retryLinks.delete(peerId);
	}

	#desiredPeers(): readonly string[] {
		return [...new Set([...this.#routes.values()].flatMap(({ peers }) => peers))];
	}

	#reserveReplacementAdmission(peerId: string): void {
		if (
			this.#replacementAdmissions.has(peerId) ||
			!this.#desiredPeers().includes(peerId) ||
			this.#connectionFor(peerId) === undefined
		) {
			return;
		}
		const expiresAt = Date.now() + SETUP_TIMEOUT_MS;
		const timer = setTimeout(() => {
			if (this.#replacementAdmissions.get(peerId)?.timer === timer) this.#replacementAdmissions.delete(peerId);
		}, SETUP_TIMEOUT_MS);
		this.#replacementAdmissions.set(peerId, Object.freeze({ expiresAt, timer }));
	}

	#pruneReplacementAdmissions(): void {
		const desiredPeers = new Set(this.#desiredPeers());
		const now = Date.now();
		for (const [peerId, admission] of this.#replacementAdmissions) {
			if (
				admission.expiresAt <= now ||
				!desiredPeers.has(peerId) ||
				this.#connectionFor(peerId) === undefined ||
				this.#links.has(peerId)
			) {
				this.#clearReplacementAdmission(peerId);
			}
		}
	}

	#logicalAdmissionCount(): number {
		const peers = new Set(this.#links.keys());
		for (const peerId of this.#replacementAdmissions.keys()) peers.add(peerId);
		return peers.size;
	}

	#hasAdmission(peerId: string): boolean {
		return this.#links.has(peerId) || this.#replacementAdmissions.has(peerId);
	}

	#clearReplacementAdmission(peerId: string): void {
		const admission = this.#replacementAdmissions.get(peerId);
		if (admission === undefined) return;
		clearTimeout(admission.timer);
		this.#replacementAdmissions.delete(peerId);
	}

	#clearAllReplacementAdmissions(): void {
		for (const peerId of [...this.#replacementAdmissions.keys()]) this.#clearReplacementAdmission(peerId);
	}

	#scheduleLinkRetry(peerId: string): void {
		if (
			this.#closed ||
			this.#signaling.localPeerId >= peerId ||
			!this.#desiredPeers().includes(peerId) ||
			this.#connectionFor(peerId) === undefined ||
			this.#retryLinks.has(peerId)
		) {
			return;
		}
		const retry = setTimeout(() => {
			this.#retryLinks.delete(peerId);
			void this.#linkFor(peerId).then((link) => {
				if (link === undefined) this.#scheduleLinkRetry(peerId);
			});
		}, 250);
		this.#retryLinks.set(peerId, retry);
	}

	#closePendingForPeer(peerId: string): void {
		const pendingReplacement = this.#pendingReplacementLinks.get(peerId);
		if (pendingReplacement !== undefined) this.#discardPendingReplacement(peerId, pendingReplacement);
		for (const [pc, pending] of this.#pendingPeerConnections) {
			if (pending.peerId !== peerId) continue;
			this.#pendingPeerConnections.delete(pc);
			pending.unsubscribeConnection();
			pc.close();
		}
	}

	#hasPendingPeerConnection(peerId: string): boolean {
		return [...this.#pendingPeerConnections.values()].some((pending) => pending.peerId === peerId);
	}

	#physicalPeerConnectionCount(): number {
		const peerConnections = new Set<RTCPeerConnection>();
		for (const link of this.#links.values()) peerConnections.add(link.pc);
		for (const link of this.#pendingReplacementLinks.values()) peerConnections.add(link.pc);
		for (const pc of this.#pendingPeerConnections.keys()) peerConnections.add(pc);
		for (const link of this.#retiringLinks.values()) peerConnections.add(link.pc);
		return [...peerConnections].filter(({ connectionState }) => connectionState !== "closed").length;
	}

	#snapshot(): DRPUnreliableWebRtcSnapshot {
		return Object.freeze({
			activeLinks: this.#links.size,
			authenticatedConnectionLosses: this.#authenticatedConnectionLosses,
			backpressuredDrops: this.#backpressuredDrops,
			handshakeFailures: this.#handshakeFailures,
			lastLinkDrop: this.#lastLinkDrop,
			linkDrops: this.#linkDrops,
			links: [...this.#links.values()]
				.map(({ channel, connection }) =>
					Object.freeze({
						connectionId: connection.id,
						generation: connection.generation,
						label: channel.label,
						maxRetransmits: channel.maxRetransmits ?? -1,
						ordered: channel.ordered,
						peerId: connection.remotePeerId,
						remoteAddr: connection.remoteAddr,
					})
				)
				.sort((left, right) => left.peerId.localeCompare(right.peerId)),
			received: this.#received,
			routedBytesReceived: this.#routedBytesReceived,
			routedBytesSent: this.#routedBytesSent,
			sent: this.#sent,
			unknownRouteDrops: this.#unknownRouteDrops,
		});
	}
}

/**
 * Create one bounded unreliable WebRTC owner over an authenticated signaling boundary.
 * @param input Peer-connection factory and authenticated signaling port.
 * @returns One route-multiplexing owner.
 */
export function createDRPUnreliableWebRtcOwner(
	input: Readonly<{ createPeerConnection(): RTCPeerConnection; signaling: AuthenticatedWebRtcSignalingPort }>
): DRPUnreliableWebRtcOwner {
	return new UnreliableWebRtcOwner(input);
}

/**
 * Extract bounded, address-free RTC evidence for diagnostics and browser acceptance.
 * @param pc Exact peer connection whose statistics are sampled.
 * @returns Sanitized selected-pair and data-channel evidence.
 */
export async function extractSanitizedRtcEvidence(pc: RTCPeerConnection): Promise<{
	readonly bytesReceived: number;
	readonly bytesSent: number;
	readonly candidateTypes: readonly ("host" | "prflx" | "relay" | "srflx")[];
	readonly dataChannelOpen: boolean;
	readonly selectedPairId: string;
}> {
	const stats = await pc.getStats();
	const pair = [...stats.values()].find(
		(value) =>
			value.type === "candidate-pair" &&
			((value as RTCIceCandidatePairStats).nominated === true ||
				(value as RTCIceCandidatePairStats).state === "succeeded")
	) as (RTCIceCandidatePairStats & { localCandidateId?: string; remoteCandidateId?: string }) | undefined;
	if (pair === undefined) throw new Error("selected RTC candidate pair missing");
	const candidateTypes = [pair.localCandidateId, pair.remoteCandidateId].map((id) => {
		if (id === undefined) throw new Error("selected RTC pair omitted a candidate ID");
		const type = stats.get(id)?.candidateType;
		if (type !== "host" && type !== "prflx" && type !== "relay" && type !== "srflx") {
			throw new Error(`selected RTC pair reported unsupported candidate type ${String(type)}`);
		}
		return type;
	});
	const dataChannelOpen = [...stats.values()].some(
		(value) => value.type === "data-channel" && (value as { state?: string }).state === "open"
	);
	return Object.freeze({
		bytesReceived: pair.bytesReceived ?? 0,
		bytesSent: pair.bytesSent ?? 0,
		candidateTypes,
		dataChannelOpen: dataChannelOpen || pc.sctp?.transport.state === "connected",
		selectedPairId: pair.id,
	});
}

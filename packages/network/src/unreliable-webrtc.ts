import type { Connection, Stream } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { WebRTC, WebRTCDirect } from "@multiformats/multiaddr-matcher";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";

export const DRP_UNRELIABLE_WEBRTC_SIGNALING_PROTOCOL = "/ts-drp/unreliable-webrtc/1.0.0";

const RAW_CHANNEL_LABEL = "ts-drp-ephemeral/1";
const ROUTE_DOMAIN = new TextEncoder().encode("ts-drp-ephemeral-route-v1\0");
const REPLACEMENT_DECISION_DOMAIN = new TextEncoder().encode("ts-drp-unreliable-webrtc-replacement-decision-v1\0");
const ROUTE_VERSION = 1;
const ROUTE_HEADER_BYTES = 33;
const REPLACEMENT_CONTROL_MAGIC_0 = 0x44;
const REPLACEMENT_CONTROL_MAGIC_1 = 0x52;
const REPLACEMENT_CONTROL_VERSION = 1;
const REPLACEMENT_READY = Uint8Array.of(
	REPLACEMENT_CONTROL_MAGIC_0,
	REPLACEMENT_CONTROL_MAGIC_1,
	REPLACEMENT_CONTROL_VERSION,
	1
);
const REPLACEMENT_ACK = Uint8Array.of(
	REPLACEMENT_CONTROL_MAGIC_0,
	REPLACEMENT_CONTROL_MAGIC_1,
	REPLACEMENT_CONTROL_VERSION,
	2
);
const REPLACEMENT_COMMIT = Uint8Array.of(
	REPLACEMENT_CONTROL_MAGIC_0,
	REPLACEMENT_CONTROL_MAGIC_1,
	REPLACEMENT_CONTROL_VERSION,
	3
);
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
	readonly decisionId: string;
	readonly pc: RTCPeerConnection;
	readonly role: "acceptor" | "initiator";
	unsubscribeConnection(): void;
}

interface LinkReadiness {
	ackSends: number;
	commitSends: number;
	complete: boolean;
	readonly commit: Promise<void> | undefined;
	decisionAbort: AbortController | undefined;
	decisionObservation: ReturnType<typeof setTimeout> | undefined;
	readonly deadlineAt: number | undefined;
	expiry: ReturnType<typeof setTimeout> | undefined;
	receivedAck: boolean;
	receivedCommit: boolean;
	receivedReady: boolean;
	readySends: number;
	readonly reliableDecision: boolean;
	readonly replacement: boolean;
	rejectCommit(error: Error): void;
	resolveCommit(): void;
}

type ReplacementDecisionStatus = "aborted" | "committed";

interface ReplacementDecisionWaiter {
	resolve(status: ReplacementDecisionStatus | undefined): void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ReplacementDecisionRecord {
	cleanup: ReturnType<typeof setTimeout> | undefined;
	readonly connection: AuthenticatedWebRtcConnection;
	readonly deadlineAt: number;
	readonly decisionId: string;
	readonly link: ActiveLink;
	observations: number;
	readonly readiness: LinkReadiness;
	status: ReplacementDecisionStatus | "pending";
	readonly waiters: Set<ReplacementDecisionWaiter>;
}

interface ReplacementDecisionRequest {
	readonly decisionId: string;
	readonly type: "replacement-decision";
	readonly version: 1;
}

interface ReplacementDecisionResponse {
	readonly decisionId: string;
	readonly status: ReplacementDecisionStatus;
	readonly type: "replacement-decision-result";
	readonly version: 1;
}

interface PendingPeerConnection {
	readonly peerId: string;
	readonly token: object;
	unsubscribeConnection(): void;
}

const abortedStreams = new WeakSet<object>();
const requestFailedConnections = new WeakSet<object>();

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
		const authenticated = adapt(connection);
		const requestCloseListeners = new Set<() => void>();
		const requestUnsubscribes = new Map<() => void, () => void>();
		let requestComplete = false;
		let requestFailed = false;
		const notifyRequestFailure = (): void => {
			if (requestComplete || requestFailed) return;
			requestFailed = true;
			requestFailedConnections.add(requestConnection);
			for (const listener of requestCloseListeners) listener();
		};
		const requestConnection: AuthenticatedWebRtcConnection = Object.freeze({
			...authenticated,
			onClose(listener: () => void): () => void {
				requestCloseListeners.add(listener);
				const unsubscribeConnection = authenticated.onClose(listener);
				requestUnsubscribes.set(listener, unsubscribeConnection);
				if (requestFailed) {
					queueMicrotask(() => {
						if (requestCloseListeners.has(listener)) listener();
					});
				}
				return (): void => {
					requestCloseListeners.delete(listener);
					requestUnsubscribes.get(listener)?.();
					requestUnsubscribes.delete(listener);
				};
			},
		});
		const onStreamClose = (event: Event): void => {
			const close = event as Event & { readonly error?: Error; readonly local?: boolean };
			if (close.error !== undefined && close.local === false) notifyRequestFailure();
		};
		stream.addEventListener("close", onStreamClose);
		if (stream.status === "reset") notifyRequestFailure();
		try {
			await withDeadline(async (signal) => {
				const onAbort = (): void => abortStream(stream, errorFrom(signal.reason, "RTC signaling request aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					if (requestListener === undefined) throw new Error("unreliable WebRTC signaling owner is unavailable");
					if (authenticated.transport !== "webrtc") {
						throw new Error("unreliable WebRTC signaling transport rejected");
					}
					const request = (await input.read(stream, MAX_SIGNALING_FRAME_BYTES)).slice();
					const response = await requestListener(requestConnection, request);
					await input.write(stream, response.slice());
					requestComplete = true;
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			});
		} catch (error) {
			notifyRequestFailure();
			abortStream(stream, errorFrom(error, "RTC signaling request failed"));
			throw error;
		} finally {
			stream.removeEventListener("close", onStreamClose);
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

function replacementDecisionId(offerBytes: Uint8Array): string {
	return bytesToHex(sha256(concatBytes(REPLACEMENT_DECISION_DOMAIN, offerBytes)));
}

function decodedJson(bytes: Uint8Array): unknown {
	if (bytes.byteLength > MAX_SIGNALING_FRAME_BYTES) throw new Error("RTC signaling frame exceeds its byte bound");
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("RTC signaling frame is malformed");
	}
}

function decodeDecisionRequest(bytes: Uint8Array): ReplacementDecisionRequest | undefined {
	let decoded: unknown;
	try {
		decoded = decodedJson(bytes);
	} catch {
		return undefined;
	}
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
	const value = decoded as Record<string, unknown>;
	if (!("decisionId" in value) && value.type !== "replacement-decision") return undefined;
	if (
		Object.keys(value).sort().join(",") !== "decisionId,type,version" ||
		value.type !== "replacement-decision" ||
		value.version !== 1 ||
		typeof value.decisionId !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.decisionId)
	) {
		throw new Error("RTC replacement decision request is outside its contract");
	}
	return Object.freeze({ decisionId: value.decisionId, type: "replacement-decision", version: 1 });
}

function encodeDecisionRequest(decisionId: string): Uint8Array {
	const request: ReplacementDecisionRequest = Object.freeze({
		decisionId,
		type: "replacement-decision",
		version: 1,
	});
	const bytes = new TextEncoder().encode(JSON.stringify(request));
	if (bytes.byteLength > MAX_SIGNALING_FRAME_BYTES) throw new Error("RTC signaling frame exceeds its byte bound");
	return bytes;
}

function encodeDecisionResponse(decisionId: string, status: ReplacementDecisionStatus): Uint8Array {
	const response: ReplacementDecisionResponse = Object.freeze({
		decisionId,
		status,
		type: "replacement-decision-result",
		version: 1,
	});
	const bytes = new TextEncoder().encode(JSON.stringify(response));
	if (bytes.byteLength > MAX_SIGNALING_FRAME_BYTES) throw new Error("RTC signaling frame exceeds its byte bound");
	return bytes;
}

function decodeDecisionResponse(bytes: Uint8Array, decisionId: string): ReplacementDecisionStatus {
	const decoded = decodedJson(bytes);
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
		throw new Error("RTC replacement decision response is malformed");
	}
	const value = decoded as Record<string, unknown>;
	if (
		Object.keys(value).sort().join(",") !== "decisionId,status,type,version" ||
		value.decisionId !== decisionId ||
		(value.status !== "aborted" && value.status !== "committed") ||
		value.type !== "replacement-decision-result" ||
		value.version !== 1
	) {
		throw new Error("RTC replacement decision response is outside its contract");
	}
	return value.status;
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

function replacementControl(bytes: Uint8Array): 1 | 2 | 3 | undefined {
	if (
		bytes.byteLength !== 4 ||
		bytes[0] !== REPLACEMENT_CONTROL_MAGIC_0 ||
		bytes[1] !== REPLACEMENT_CONTROL_MAGIC_1 ||
		bytes[2] !== REPLACEMENT_CONTROL_VERSION
	) {
		return undefined;
	}
	const kind = bytes[3];
	return kind === 1 || kind === 2 || kind === 3 ? kind : undefined;
}

class UnreliableWebRtcOwner implements DRPUnreliableWebRtcOwner {
	readonly #activatedPeers = new Set<string>();
	readonly #createPeerConnection: () => RTCPeerConnection;
	readonly #links = new Map<string, ActiveLink>();
	readonly #pendingReplacementLinks = new Map<string, ActiveLink>();
	readonly #pendingLinkAborts = new Map<string, AbortController>();
	readonly #pendingLinks = new Map<string, Promise<ActiveLink | undefined>>();
	readonly #pendingPeerConnections = new Map<RTCPeerConnection, PendingPeerConnection>();
	readonly #readiness = new Map<ActiveLink, LinkReadiness>();
	readonly #replacementDecisions = new Map<string, ReplacementDecisionRecord>();
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
		const heldReplacement = this.#pendingReplacementLinks.get(peerId);
		if (heldReplacement !== undefined) {
			if (!this.#isCurrent(heldReplacement.connection)) {
				this.#discardPendingReplacement(peerId, heldReplacement);
			} else {
				return this.#links.get(peerId);
			}
		}
		const pending = this.#pendingLinks.get(peerId);
		if (pending !== undefined) return staleOpen ? existing : pending;
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
		const deadlineAt = Date.now() + SETUP_TIMEOUT_MS;
		const setupAbort = new AbortController();
		this.#pendingLinkAborts.set(peerId, setupAbort);
		const setup = withDeadline(
			(signal) => this.#initiate(connection, AbortSignal.any([signal, setupAbort.signal]), deadlineAt),
			deadlineAt - Date.now()
		)
			.catch(() => {
				this.#closePendingForPeer(peerId);
				this.#handshakeFailures += 1;
				if (staleOpen) this.#scheduleLinkRetry(peerId);
				return undefined;
			})
			.finally(() => {
				if (this.#pendingLinkAborts.get(peerId) === setupAbort) this.#pendingLinkAborts.delete(peerId);
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

	async #initiate(
		connection: AuthenticatedWebRtcConnection,
		signal: AbortSignal,
		deadlineAt: number
	): Promise<ActiveLink | undefined> {
		const pc = this.#createPeerConnection();
		let authenticatedClosed = false;
		let established = false;
		let link: ActiveLink | undefined;
		const unsubscribeConnection = connection.onClose(() => {
			if (!established) {
				authenticatedClosed = true;
				pc.close();
				return;
			}
			this.#authenticatedConnectionLosses += 1;
			if (link !== undefined && this.#pendingReplacementLinks.get(connection.remotePeerId) === link) {
				this.#discardPendingReplacement(connection.remotePeerId, link);
			}
		});
		this.#pendingPeerConnections.set(pc, {
			peerId: connection.remotePeerId,
			token: Object.freeze({}),
			unsubscribeConnection,
		});
		try {
			const channel = pc.createDataChannel(RAW_CHANNEL_LABEL, { maxRetransmits: 0, ordered: false });
			channel.binaryType = "arraybuffer";
			validateChannel(channel);
			const offer = await localDescription(pc, await pc.createOffer());
			const offerBytes = encodeDescription(offer);
			const answer = decodeDescription(await connection.exchange(offerBytes, signal), "answer");
			if (authenticatedClosed || !this.#isCurrent(connection)) throw new Error("authenticated connection changed");
			await pc.setRemoteDescription({ sdp: answer.sdp, type: "answer" });
			await addRemoteCandidates(pc, answer.candidates);
			validateSctp(pc);
			await waitForOpen(channel);
			if (authenticatedClosed || !this.#isCurrent(connection)) throw new Error("authenticated connection changed");
			established = true;
			link = {
				channel,
				closing: false,
				connection,
				decisionId: replacementDecisionId(offerBytes),
				pc,
				role: "initiator" as const,
				unsubscribeConnection,
			};
			const existing = this.#links.get(connection.remotePeerId);
			if (
				this.#activatedPeers.has(connection.remotePeerId) &&
				(existing === undefined || !this.#sameConnection(existing.connection, connection))
			) {
				this.#holdReplacementLink(link, deadlineAt);
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
		const decision = decodeDecisionRequest(request);
		if (decision !== undefined) return this.#handleDecisionRequest(connection, decision);
		if (
			this.#closed ||
			connection.transport !== "webrtc" ||
			connection.remotePeerId >= this.#signaling.localPeerId ||
			!this.#isCurrent(connection)
		) {
			throw new Error("unreliable WebRTC signaling request rejected");
		}
		let offer: SignalDescription;
		try {
			offer = decodeDescription(request, "offer");
		} catch (error) {
			this.#handshakeFailures += 1;
			throw error;
		}
		const pendingReplacement = this.#pendingReplacementLinks.get(connection.remotePeerId);
		if (pendingReplacement !== undefined && pendingReplacement.channel.readyState !== "open") {
			this.#discardPendingReplacement(connection.remotePeerId, pendingReplacement);
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
		const setupToken = Object.freeze({});
		try {
			return await withDeadline((signal) => this.#accept(connection, request, offer, deadlineAt, signal, setupToken));
		} catch (error) {
			this.#handshakeFailures += 1;
			throw error;
		}
	}

	async #handleDecisionRequest(
		connection: AuthenticatedWebRtcConnection,
		request: ReplacementDecisionRequest
	): Promise<Uint8Array> {
		if (
			this.#closed ||
			connection.transport !== "webrtc" ||
			connection.remotePeerId >= this.#signaling.localPeerId ||
			!this.#isCurrent(connection)
		) {
			return encodeDecisionResponse(request.decisionId, "aborted");
		}
		const record = this.#replacementDecisions.get(request.decisionId);
		if (
			record === undefined ||
			!this.#sameConnection(record.connection, connection) ||
			record.link.decisionId !== request.decisionId
		) {
			return encodeDecisionResponse(request.decisionId, "aborted");
		}
		if (record.status !== "pending") return encodeDecisionResponse(request.decisionId, record.status);
		record.observations += 1;
		const now = Date.now();
		const remaining = Math.max(0, record.deadlineAt - now);
		const cutoffAt = record.observations === 1 ? now + Math.floor(remaining / 2) : record.deadlineAt;
		const status = await this.#waitForDecision(record, cutoffAt);
		if (status === undefined) throw new Error("RTC replacement decision remains pending");
		return encodeDecisionResponse(request.decisionId, status);
	}

	#waitForDecision(
		record: ReplacementDecisionRecord,
		cutoffAt: number
	): Promise<ReplacementDecisionStatus | undefined> {
		if (record.status !== "pending") return Promise.resolve(record.status);
		return new Promise<ReplacementDecisionStatus | undefined>((resolve) => {
			const waiter: ReplacementDecisionWaiter = Object.freeze({
				resolve,
				timer: setTimeout(
					() => {
						record.waiters.delete(waiter);
						resolve(undefined);
					},
					Math.max(0, cutoffAt - Date.now())
				),
			});
			record.waiters.add(waiter);
		});
	}

	async #accept(
		connection: AuthenticatedWebRtcConnection,
		request: Uint8Array,
		offer: SignalDescription,
		deadlineAt: number,
		signal: AbortSignal,
		setupToken: object
	): Promise<Uint8Array> {
		const pc = this.#createPeerConnection();
		let authenticatedClosed = false;
		let established = false;
		let inboundChannelError: Error | undefined;
		let link: ActiveLink | undefined;
		const ownsSetup = (): boolean => !signal.aborted && this.#pendingPeerConnections.get(pc)?.token === setupToken;
		const closeSetup = (): boolean => this.#closePendingPeerConnection(pc, setupToken);
		const unsubscribeConnection = connection.onClose(() => {
			if (requestFailedConnections.has(connection)) {
				authenticatedClosed = true;
				if (link !== undefined && this.#pendingReplacementLinks.get(connection.remotePeerId) === link) {
					this.#discardPendingReplacement(connection.remotePeerId, link);
				} else if (link !== undefined && this.#links.get(connection.remotePeerId) === link) {
					this.#handshakeFailures += 1;
					this.#dropLink(connection.remotePeerId, link, "connection-close");
				} else closeSetup();
				return;
			}
			if (!established) {
				authenticatedClosed = true;
				closeSetup();
				return;
			}
			this.#authenticatedConnectionLosses += 1;
			if (link !== undefined && this.#pendingReplacementLinks.get(connection.remotePeerId) === link) {
				this.#discardPendingReplacement(connection.remotePeerId, link);
			}
		});
		this.#pendingPeerConnections.set(pc, {
			peerId: connection.remotePeerId,
			token: setupToken,
			unsubscribeConnection,
		});
		const onAbort = (): void => {
			authenticatedClosed = true;
			closeSetup();
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		try {
			if (!ownsSetup()) throw errorFrom(signal.reason, "RTC accept setup ended");
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
			if (!ownsSetup()) throw errorFrom(signal.reason, "RTC accept setup ended");
			if (inboundChannelError !== undefined) throw inboundChannelError;
			await addRemoteCandidates(pc, offer.candidates);
			if (!ownsSetup()) throw errorFrom(signal.reason, "RTC accept setup ended");
			const answer = await localDescription(pc, await pc.createAnswer());
			if (!ownsSetup()) throw errorFrom(signal.reason, "RTC accept setup ended");
			validateSctp(pc);
			const finish = async (): Promise<void> => {
				const channel = await withDeadline(async () => {
					const pendingChannel = await channelPromise;
					validateChannel(pendingChannel);
					validateSctp(pc);
					await waitForOpen(pendingChannel);
					return pendingChannel;
				}, deadlineAt - Date.now());
				if (!ownsSetup() || authenticatedClosed || !this.#isCurrent(connection)) {
					throw new Error("authenticated connection changed");
				}
				established = true;
				link = {
					channel,
					closing: false,
					connection,
					decisionId: replacementDecisionId(request),
					pc,
					role: "acceptor" as const,
					unsubscribeConnection,
				};
				if (this.#activatedPeers.has(connection.remotePeerId)) {
					const readiness = this.#holdReplacementLink(link, deadlineAt);
					if (readiness.commit === undefined) throw new Error("replacement commit owner is absent");
					await readiness.commit;
				} else {
					if (!ownsSetup()) throw new Error("RTC accept setup ownership changed");
					this.#pendingPeerConnections.delete(pc);
					this.#registerLink(link);
				}
			};
			void finish().catch(() => {
				const pending = this.#pendingReplacementLinks.get(connection.remotePeerId);
				if (pending?.pc === pc) this.#discardPendingReplacement(connection.remotePeerId, pending);
				else closeSetup();
				this.#handshakeFailures += 1;
			});
			return encodeDescription(answer);
		} catch (error) {
			closeSetup();
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
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
		if (!prepared) this.#prepareLink(peerId, link, false);
		if (previous !== undefined && previous !== link) {
			this.#dropLink(peerId, previous, "replacement");
		}
		return link;
	}

	#prepareLink(peerId: string, link: ActiveLink, replacement: boolean, deadlineAt?: number): LinkReadiness {
		let commit: Promise<void> | undefined;
		let rejectCommit = (_error: Error): void => undefined;
		let resolveCommit = (): void => undefined;
		if (replacement && link.role === "acceptor") {
			commit = new Promise<void>((resolve, reject) => {
				let settled = false;
				resolveCommit = (): void => {
					if (settled) return;
					settled = true;
					resolve();
				};
				rejectCommit = (error: Error): void => {
					if (settled) return;
					settled = true;
					reject(error);
				};
			});
		}
		const reliableDecision = replacement && this.#hasUsableSelectedLink(peerId, link);
		const readiness: LinkReadiness = {
			ackSends: 0,
			commit,
			commitSends: 0,
			complete: false,
			deadlineAt,
			decisionAbort: undefined,
			decisionObservation: undefined,
			expiry: undefined,
			receivedAck: false,
			receivedCommit: false,
			receivedReady: false,
			readySends: 0,
			rejectCommit,
			reliableDecision,
			replacement,
			resolveCommit,
		};
		this.#readiness.set(link, readiness);
		if (reliableDecision && link.role === "acceptor") this.#createDecisionRecord(link, readiness);
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
		const sent =
			link.role === "initiator"
				? this.#sendReplacementControl(link, readiness, 1)
				: this.#sendReplacementControl(link, readiness, 2);
		if (!sent && replacement) throw new Error("replacement readiness send failed");
		if (replacement && !readiness.complete) {
			if (deadlineAt === undefined) throw new Error("replacement readiness deadline is absent");
			const remaining = Math.max(0, deadlineAt - Date.now());
			readiness.expiry = setTimeout(() => {
				if (this.#readiness.get(link) === readiness) this.#expireReplacementReadiness(peerId, link, readiness);
			}, remaining);
		}
		return readiness;
	}

	#holdReplacementLink(link: ActiveLink, deadlineAt?: number): LinkReadiness {
		const peerId = link.connection.remotePeerId;
		const previous = this.#pendingReplacementLinks.get(peerId);
		if (previous !== undefined) this.#discardPendingReplacement(peerId, previous);
		this.#pendingReplacementLinks.set(peerId, link);
		try {
			return this.#prepareLink(peerId, link, true, deadlineAt);
		} catch (error) {
			this.#discardPendingReplacement(peerId, link);
			throw error;
		}
	}

	#createDecisionRecord(link: ActiveLink, readiness: LinkReadiness): void {
		if (readiness.deadlineAt === undefined) throw new Error("replacement decision deadline is absent");
		if (this.#replacementDecisions.has(link.decisionId)) {
			throw new Error("replacement decision identity is already active");
		}
		this.#replacementDecisions.set(link.decisionId, {
			cleanup: undefined,
			connection: link.connection,
			deadlineAt: readiness.deadlineAt,
			decisionId: link.decisionId,
			link,
			observations: 0,
			readiness,
			status: "pending",
			waiters: new Set(),
		});
	}

	#settleDecision(record: ReplacementDecisionRecord, status: "aborted" | "committed"): void {
		if (record.status !== "pending") return;
		record.status = status;
		for (const waiter of record.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(status);
		}
		record.waiters.clear();
	}

	#removeDecisionRecord(link: ActiveLink): void {
		const record = this.#replacementDecisions.get(link.decisionId);
		if (record === undefined || record.link !== link) return;
		this.#settleDecision(record, "aborted");
		if (record.cleanup !== undefined) clearTimeout(record.cleanup);
		for (const waiter of record.waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve("aborted");
		}
		record.waiters.clear();
		this.#replacementDecisions.delete(record.decisionId);
	}

	#retainCommittedDecision(link: ActiveLink): void {
		const record = this.#replacementDecisions.get(link.decisionId);
		if (record === undefined || record.link !== link || record.status !== "committed") return;
		if (record.cleanup !== undefined) clearTimeout(record.cleanup);
		record.cleanup = setTimeout(
			() => {
				if (this.#replacementDecisions.get(record.decisionId) === record) {
					this.#replacementDecisions.delete(record.decisionId);
				}
			},
			Math.max(0, record.deadlineAt - Date.now())
		);
	}

	#clearReadinessTimers(readiness: LinkReadiness | undefined): void {
		if (readiness?.expiry !== undefined) clearTimeout(readiness.expiry);
		if (readiness?.decisionObservation !== undefined) clearTimeout(readiness.decisionObservation);
		readiness?.decisionAbort?.abort(new Error("replacement decision observation ended"));
		if (readiness !== undefined) {
			readiness.expiry = undefined;
			readiness.decisionObservation = undefined;
			readiness.decisionAbort = undefined;
		}
	}

	#discardPendingReplacement(peerId: string, link: ActiveLink): void {
		if (link.closing) return;
		link.closing = true;
		const readiness = this.#readiness.get(link);
		this.#readiness.delete(link);
		this.#clearReadinessTimers(readiness);
		this.#removeDecisionRecord(link);
		readiness?.rejectCommit(new Error("replacement readiness ended before commit"));
		if (this.#pendingReplacementLinks.get(peerId) === link) this.#pendingReplacementLinks.delete(peerId);
		this.#pendingPeerConnections.delete(link.pc);
		link.unsubscribeConnection();
		link.channel.close();
		link.pc.close();
		const selected = this.#links.get(peerId);
		if (selected === undefined || !this.#isCurrent(selected.connection)) this.#scheduleLinkRetry(peerId);
	}

	#promotePendingReplacement(peerId: string): boolean {
		const pending = this.#pendingReplacementLinks.get(peerId);
		if (pending === undefined || pending.closing || pending.channel.readyState !== "open") return false;
		const readiness = this.#readiness.get(pending);
		if (
			readiness === undefined ||
			!readiness.replacement ||
			(pending.role === "initiator"
				? !readiness.receivedAck || readiness.commitSends === 0
				: !readiness.receivedReady || !readiness.receivedCommit || readiness.ackSends === 0)
		) {
			return false;
		}
		if (!this.#isCurrent(pending.connection)) {
			this.#discardPendingReplacement(peerId, pending);
			return false;
		}
		this.#pendingReplacementLinks.delete(peerId);
		this.#pendingPeerConnections.delete(pending.pc);
		this.#clearReadinessTimers(readiness);
		readiness.complete = true;
		this.#registerLink(pending, true);
		this.#retainCommittedDecision(pending);
		readiness.resolveCommit();
		return true;
	}

	#hasUsableSelectedLink(peerId: string, replacement: ActiveLink): boolean {
		const selected = this.#links.get(peerId);
		return selected !== undefined && selected !== replacement && selected.channel.readyState === "open";
	}

	#hasDisconnectedSelectedLink(peerId: string, replacement: ActiveLink): boolean {
		const selected = this.#links.get(peerId);
		return (
			selected !== undefined &&
			selected !== replacement &&
			selected.channel.readyState === "open" &&
			selected.pc.connectionState === "disconnected"
		);
	}

	#sendReplacementControl(link: ActiveLink, readiness: LinkReadiness, kind: 1 | 2 | 3): boolean {
		if (link.channel.readyState !== "open" || !this.#isCurrent(link.connection)) return false;
		if (kind === 1) {
			if (readiness.readySends >= 2) return true;
			readiness.readySends += 1;
		} else if (kind === 2) {
			if (readiness.ackSends >= 2) return true;
			readiness.ackSends += 1;
		} else {
			if (readiness.commitSends >= 2) return true;
			readiness.commitSends += 1;
		}
		try {
			link.channel.send(kind === 1 ? REPLACEMENT_READY : kind === 2 ? REPLACEMENT_ACK : REPLACEMENT_COMMIT);
			return true;
		} catch {
			return false;
		}
	}

	async #observeReplacementDecision(peerId: string, link: ActiveLink, readiness: LinkReadiness): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (
				this.#closed ||
				this.#pendingReplacementLinks.get(peerId) !== link ||
				this.#readiness.get(link) !== readiness ||
				!readiness.reliableDecision ||
				link.role !== "initiator" ||
				link.closing ||
				link.channel.readyState !== "open" ||
				!readiness.receivedAck ||
				readiness.commitSends === 0 ||
				readiness.deadlineAt === undefined ||
				!this.#isCurrent(link.connection)
			) {
				return;
			}
			const now = Date.now();
			const remaining = readiness.deadlineAt - now;
			if (remaining <= 0) break;
			const cutoffAt = attempt === 0 ? now + Math.floor(remaining / 2) : readiness.deadlineAt;
			const controller = new AbortController();
			readiness.decisionAbort = controller;
			const cutoff = setTimeout(
				() => controller.abort(new Error("replacement decision attempt deadline exceeded")),
				Math.max(0, cutoffAt - Date.now())
			);
			try {
				const response = await link.connection.exchange(encodeDecisionRequest(link.decisionId), controller.signal);
				const status = decodeDecisionResponse(response, link.decisionId);
				if (
					this.#pendingReplacementLinks.get(peerId) !== link ||
					this.#readiness.get(link) !== readiness ||
					link.closing ||
					link.channel.readyState !== "open" ||
					!this.#isCurrent(link.connection)
				) {
					return;
				}
				if (status === "committed") this.#promotePendingReplacement(peerId);
				else this.#failReplacementReadiness(peerId, link, readiness);
				return;
			} catch {
				// One failed authenticated stream may resume inside the original absolute deadline.
			} finally {
				clearTimeout(cutoff);
				if (readiness.decisionAbort === controller) readiness.decisionAbort = undefined;
			}
		}
		if (this.#readiness.get(link) === readiness) this.#failReplacementReadiness(peerId, link, readiness);
	}

	#scheduleReplacementDecisionObservation(peerId: string, link: ActiveLink, readiness: LinkReadiness): void {
		if (
			!readiness.reliableDecision ||
			readiness.deadlineAt === undefined ||
			readiness.decisionObservation !== undefined ||
			readiness.decisionAbort !== undefined
		) {
			return;
		}
		readiness.decisionObservation = setTimeout(() => {
			readiness.decisionObservation = undefined;
			void this.#observeReplacementDecision(peerId, link, readiness);
		}, 0);
	}

	#expireReplacementReadiness(peerId: string, link: ActiveLink, readiness: LinkReadiness): void {
		if (this.#pendingReplacementLinks.get(peerId) !== link || this.#readiness.get(link) !== readiness) return;
		if (link.role === "acceptor" && readiness.reliableDecision) {
			const record = this.#replacementDecisions.get(link.decisionId);
			if (
				record?.link === link &&
				record.status === "committed" &&
				(!this.#hasUsableSelectedLink(peerId, link) || this.#hasDisconnectedSelectedLink(peerId, link))
			) {
				if (this.#promotePendingReplacement(peerId)) return;
			}
		}
		this.#failReplacementReadiness(peerId, link, readiness);
	}

	#failReplacementReadiness(peerId: string, link: ActiveLink, readiness: LinkReadiness): void {
		if (!readiness.replacement || this.#pendingReplacementLinks.get(peerId) !== link) return;
		if (link.role === "initiator") this.#handshakeFailures += 1;
		this.#discardPendingReplacement(peerId, link);
	}

	#receiveReplacementControl(peerId: string, link: ActiveLink, readiness: LinkReadiness, kind: 1 | 2 | 3): void {
		if (readiness.complete || link.channel.readyState !== "open" || !this.#isCurrent(link.connection)) return;
		if (link.role === "initiator") {
			if (kind !== 2) return;
			const firstAck = !readiness.receivedAck;
			readiness.receivedAck = true;
			if (firstAck && !this.#sendReplacementControl(link, readiness, 1)) {
				this.#failReplacementReadiness(peerId, link, readiness);
				return;
			}
			if (!this.#sendReplacementControl(link, readiness, 3)) {
				this.#failReplacementReadiness(peerId, link, readiness);
				return;
			}
			this.#scheduleReplacementDecisionObservation(peerId, link, readiness);
			if (!this.#links.has(peerId)) this.#promotePendingReplacement(peerId);
			return;
		}
		if (kind === 1) {
			const firstReady = !readiness.receivedReady;
			readiness.receivedReady = true;
			if (firstReady && !this.#sendReplacementControl(link, readiness, 2)) {
				this.#failReplacementReadiness(peerId, link, readiness);
			}
			return;
		}
		if (kind !== 3 || !readiness.receivedReady || readiness.ackSends === 0) return;
		readiness.receivedCommit = true;
		if (readiness.replacement) {
			const record = this.#replacementDecisions.get(link.decisionId);
			if (readiness.reliableDecision && record?.link === link) {
				this.#settleDecision(record, "committed");
				if (!this.#hasUsableSelectedLink(peerId, link) || this.#hasDisconnectedSelectedLink(peerId, link)) {
					this.#promotePendingReplacement(peerId);
				}
			} else this.#promotePendingReplacement(peerId);
		} else {
			readiness.complete = true;
			readiness.resolveCommit();
		}
	}

	#receive(peerId: string, link: ActiveLink, event: MessageEvent): void {
		const active = this.#links.get(peerId) === link;
		const pending = this.#pendingReplacementLinks.get(peerId) === link;
		const retiring = this.#retiringLinks.get(peerId) === link;
		if (!active && !pending && !retiring) return;
		const bytes = messageBytes(event.data);
		if (bytes === undefined) return;
		const control = replacementControl(bytes);
		if (control !== undefined) {
			if (retiring) return;
			const readiness = this.#readiness.get(link);
			if (readiness !== undefined) this.#receiveReplacementControl(peerId, link, readiness, control);
			return;
		}
		if (pending) {
			const readiness = this.#readiness.get(link);
			if (
				link.role !== "initiator" ||
				link.closing ||
				link.channel.readyState !== "open" ||
				readiness === undefined ||
				!readiness.replacement ||
				!readiness.receivedAck ||
				readiness.commitSends === 0 ||
				!this.#isCurrent(link.connection)
			) {
				return;
			}
		}
		if (
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
		if (pending && !this.#promotePendingReplacement(peerId)) return;
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
		const readiness = this.#readiness.get(link);
		this.#readiness.delete(link);
		this.#clearReadinessTimers(readiness);
		this.#removeDecisionRecord(link);
		readiness?.rejectCommit(new Error("active link ended before replacement commit"));
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
		const readiness = this.#readiness.get(link);
		this.#readiness.delete(link);
		this.#clearReadinessTimers(readiness);
		this.#removeDecisionRecord(link);
		link.pc.close();
	}

	#closeAllLinks(): void {
		this.#activatedPeers.clear();
		this.#clearAllReplacementAdmissions();
		for (const peerId of [...this.#retryLinks.keys()]) this.#clearLinkRetry(peerId);
		for (const peerId of [...this.#pendingLinkAborts.keys()]) {
			this.#abortPendingLink(peerId, new Error("unreliable WebRTC owner closed"));
		}
		for (const [peerId, link] of [...this.#pendingReplacementLinks]) {
			this.#discardPendingReplacement(peerId, link);
		}
		for (const [pc, pending] of this.#pendingPeerConnections) {
			this.#closePendingPeerConnection(pc, pending.token);
		}
		for (const [peerId, link] of [...this.#retiringLinks]) this.#finishRetiringLink(peerId, link);
		for (const [peerId, link] of [...this.#links]) this.#dropLink(peerId, link, "owner-close");
		for (const record of [...this.#replacementDecisions.values()]) this.#removeDecisionRecord(record.link);
		this.#readiness.clear();
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

	#abortPendingLink(peerId: string, error: Error): void {
		const controller = this.#pendingLinkAborts.get(peerId);
		if (controller === undefined || controller.signal.aborted) return;
		controller.abort(error);
	}

	#closePendingPeerConnection(pc: RTCPeerConnection, token: object): boolean {
		const pending = this.#pendingPeerConnections.get(pc);
		if (pending?.token !== token) return false;
		this.#pendingPeerConnections.delete(pc);
		pending.unsubscribeConnection();
		pc.close();
		return true;
	}

	#closePendingForPeer(peerId: string): void {
		this.#abortPendingLink(peerId, new Error("unreliable WebRTC pending setup ended"));
		const pendingReplacement = this.#pendingReplacementLinks.get(peerId);
		if (pendingReplacement !== undefined) this.#discardPendingReplacement(peerId, pendingReplacement);
		for (const [pc, pending] of this.#pendingPeerConnections) {
			if (pending.peerId !== peerId) continue;
			this.#closePendingPeerConnection(pc, pending.token);
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

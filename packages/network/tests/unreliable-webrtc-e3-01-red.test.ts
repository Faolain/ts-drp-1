import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const OWNER_PATH = "packages/network/src/unreliable-webrtc.ts";
const ownerExists = existsSync(OWNER_PATH);
const RAW_LABEL = "ts-drp-ephemeral/1";
const SIGNALING_PROTOCOL = "/ts-drp/unreliable-webrtc/1.0.0";
const MAX_ROUTED_ENVELOPE_BYTES = 1_200;
const ROUTE_HEADER_BYTES = 33;
const MAX_PAYLOAD_BYTES = MAX_ROUTED_ENVELOPE_BYTES - ROUTE_HEADER_BYTES;
const MAX_SDP_BYTES = 16_384;
const REPLACEMENT_READY = Uint8Array.of(0x44, 0x52, 0x01, 0x01);
const REPLACEMENT_ACK = Uint8Array.of(0x44, 0x52, 0x01, 0x02);
const REPLACEMENT_COMMIT = Uint8Array.of(0x44, 0x52, 0x01, 0x03);

interface AuthenticatedConnection {
	readonly generation: number;
	readonly id: string;
	readonly remoteAddr: string;
	readonly remotePeerId: string;
	readonly transport: "other" | "webrtc";
	exchange(request: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
	onClose(listener: () => void): () => void;
}

interface SignalingPort {
	readonly localPeerId: string;
	connections(): readonly AuthenticatedConnection[];
	onRequest(listener: (connection: AuthenticatedConnection, request: Uint8Array) => Promise<Uint8Array>): () => void;
}

interface Libp2pConnectionFixture {
	readonly id: string;
	readonly remoteAddr: Readonly<{ toString(): string }>;
	readonly remotePeer: Readonly<{ toString(): string }>;
	addEventListener(type: "close", listener: () => void): void;
	newStream(protocol: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
}

interface IncomingSignalingStream {
	readonly connection: Libp2pConnectionFixture;
	readonly stream: unknown;
}

interface UnreliableWebRtcSnapshot {
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

interface UnreliableWebRtcRoute {
	readonly maxPayloadBytes: number;
	close(): void;
	onMessage(listener: (ingress: { readonly bytes: Uint8Array; readonly sender: string }) => void): () => void;
	reconcile(peers: readonly string[]): Promise<void>;
	send(peers: readonly string[], bytes: Uint8Array): Promise<boolean>;
	restart(): Promise<void>;
	snapshot(): UnreliableWebRtcSnapshot;
}

interface UnreliableWebRtcOwner {
	close(): void;
	openUnreliableWebRtcRoute(routeId: string): UnreliableWebRtcRoute;
}

interface SanitizedRtcEvidence {
	readonly bytesReceived: number;
	readonly bytesSent: number;
	readonly candidateTypes: readonly string[];
	readonly dataChannelOpen: boolean;
	readonly selectedPairId: string;
}

interface OwnerModule {
	readonly DRP_UNRELIABLE_WEBRTC_SIGNALING_PROTOCOL: string;
	createLibp2pWebRtcSignalingPort(
		input: Readonly<{
			connections(): readonly Libp2pConnectionFixture[];
			readonly localPeerId: string;
			onIncoming(listener: (input: IncomingSignalingStream) => Promise<void>): () => void;
			read(stream: unknown, maxBytes: number): Promise<Uint8Array>;
			write(stream: unknown, bytes: Uint8Array): Promise<void>;
		}>
	): SignalingPort;
	createDRPUnreliableWebRtcOwner(
		input: Readonly<{
			createPeerConnection(): RTCPeerConnection;
			readonly signaling: SignalingPort;
		}>
	): UnreliableWebRtcOwner;
	extractSanitizedRtcEvidence(peerConnection: RTCPeerConnection): Promise<SanitizedRtcEvidence>;
}

async function loadOwnerModule(): Promise<OwnerModule> {
	return (await import(pathToFileURL(OWNER_PATH).href)) as OwnerModule;
}

type Listener = (event: unknown) => void;

class FakeDataChannel {
	static readonly controlDrops = new Map<number, number>();
	static readonly controlThrows = new Map<number, number>();

	static clearControlDrops(): void {
		FakeDataChannel.controlDrops.clear();
		FakeDataChannel.controlThrows.clear();
	}

	static dropNextControl(kind: number, count: number): void {
		FakeDataChannel.controlDrops.set(kind, count);
	}

	static throwNextControl(kind: number, count: number): void {
		FakeDataChannel.controlThrows.set(kind, count);
	}

	binaryType: BinaryType = "blob";
	bufferedAmount = 0;
	closeEvents = 0;
	closeTransitions = 0;
	readonly label: string;
	readonly maxRetransmits: number | null;
	openEvents = 0;
	readonly ordered: boolean;
	onclose: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState: RTCDataChannelState = "connecting";
	readonly sent: Uint8Array[] = [];
	#peer?: FakeDataChannel;
	#closeEventBarrier?: FakeInboundOpenBarrier;
	#peerCloseBarrier?: FakeInboundOpenBarrier;
	readonly #listeners = new Map<string, Set<Listener>>();
	#messageBarrier?: FakeInboundOpenBarrier;

	constructor(label: string, options: RTCDataChannelInit = {}) {
		this.label = label;
		this.maxRetransmits = options.maxRetransmits ?? null;
		this.ordered = options.ordered ?? true;
	}

	addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		const selected =
			typeof listener === "function" ? listener : (event: unknown): void => listener.handleEvent(event as Event);
		const listeners = this.#listeners.get(type) ?? new Set<Listener>();
		listeners.add(selected as Listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		if (typeof listener === "function") this.#listeners.get(type)?.delete(listener as Listener);
	}

	close(): void {
		if (this.readyState === "closed") return;
		this.closeTransitions += 1;
		this.readyState = "closed";
		const closeEventBarrier = this.#closeEventBarrier;
		this.#closeEventBarrier = undefined;
		if (closeEventBarrier === undefined) this.#emit("close", new Event("close"));
		else
			void closeEventBarrier.hold().then(() => {
				this.#emit("close", new Event("close"));
			});
		const peerCloseBarrier = this.#peerCloseBarrier;
		this.#peerCloseBarrier = undefined;
		if (this.#peer?.readyState !== "closed") {
			if (peerCloseBarrier === undefined) this.#peer?.close();
			else
				void peerCloseBarrier.hold().then(() => {
					this.#peer?.close();
				});
		}
	}

	pauseCloseEvent(): FakeInboundOpenBarrier {
		if (this.#closeEventBarrier !== undefined) throw new Error("fake close-event barrier is already armed");
		const barrier = new FakeInboundOpenBarrier();
		this.#closeEventBarrier = barrier;
		return barrier;
	}

	pauseNextMessage(): FakeInboundOpenBarrier {
		if (this.#messageBarrier !== undefined) throw new Error("fake message barrier is already armed");
		const barrier = new FakeInboundOpenBarrier();
		this.#messageBarrier = barrier;
		return barrier;
	}

	pausePeerClose(): FakeInboundOpenBarrier {
		if (this.#peerCloseBarrier !== undefined) throw new Error("fake peer-close barrier is already armed");
		const barrier = new FakeInboundOpenBarrier();
		this.#peerCloseBarrier = barrier;
		return barrier;
	}

	link(peer: FakeDataChannel): void {
		this.pair(peer);
		this.open();
	}

	open(): void {
		if (this.readyState === "open") return;
		if (this.readyState === "closed") throw new Error("fake data channel cannot reopen");
		this.readyState = "open";
		queueMicrotask(() => this.#emit("open", new Event("open")));
	}

	pair(peer: FakeDataChannel): void {
		this.#peer = peer;
	}

	listenerCount(type: string): number {
		return this.#listeners.get(type)?.size ?? 0;
	}

	send(data: ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== "open") throw new Error("fake data channel closed");
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data.slice(0))
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
		const controlKind =
			bytes.byteLength === 4 && bytes[0] === 0x44 && bytes[1] === 0x52 && bytes[2] === 0x01 ? bytes[3] : undefined;
		if (controlKind !== undefined) {
			const throws = FakeDataChannel.controlThrows.get(controlKind) ?? 0;
			if (throws > 0) {
				if (throws === 1) FakeDataChannel.controlThrows.delete(controlKind);
				else FakeDataChannel.controlThrows.set(controlKind, throws - 1);
				throw new Error("fake control send failed");
			}
		}
		this.sent.push(bytes);
		if (controlKind !== undefined) {
			const drops = FakeDataChannel.controlDrops.get(controlKind) ?? 0;
			if (drops > 0) {
				if (drops === 1) FakeDataChannel.controlDrops.delete(controlKind);
				else FakeDataChannel.controlDrops.set(controlKind, drops - 1);
				return;
			}
		}
		const peer = this.#peer;
		const messageBarrier = this.#messageBarrier;
		this.#messageBarrier = undefined;
		queueMicrotask(() => {
			void (async (): Promise<void> => {
				if (messageBarrier !== undefined) await messageBarrier.hold();
				if (peer !== undefined) {
					const delivered = peer.binaryType === "arraybuffer" ? bytes.buffer : new Blob([bytes]);
					peer.#emit("message", new MessageEvent("message", { data: delivered }));
				}
			})();
		});
	}

	#emit(type: string, event: Event): void {
		if (type === "close") this.closeEvents += 1;
		if (type === "open") this.openEvents += 1;
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
		if (type === "close") this.onclose?.(event);
		if (type === "message") this.onmessage?.(event as MessageEvent);
		if (type === "open") this.onopen?.(event);
	}
}

interface FakePeerConnectionOptions {
	readonly candidateCount?: number;
	readonly hangAnswer?: boolean;
	readonly hangOffer?: boolean;
	readonly inboundChannel?: Readonly<{
		readonly label?: string;
		readonly maxRetransmits?: number;
		readonly ordered?: boolean;
	}>;
	readonly maxMessageSize?: number;
	readonly sdpBytes?: number;
}

class FakeInboundOpenBarrier {
	readonly #pending: Promise<void>;
	readonly #release: Promise<void>;
	#resolvePending: (() => void) | undefined;
	#resolveRelease: (() => void) | undefined;

	constructor() {
		this.#pending = new Promise<void>((resolve) => {
			this.#resolvePending = resolve;
		});
		this.#release = new Promise<void>((resolve) => {
			this.#resolveRelease = resolve;
		});
	}

	async hold(): Promise<void> {
		this.#resolvePending?.();
		await this.#release;
	}

	release(): void {
		this.#resolveRelease?.();
	}

	waitUntilPending(): Promise<void> {
		return this.#pending;
	}
}

class FakeRemoteInboundOpenBarrier {
	readonly #complete: Promise<void>;
	readonly #pending: Promise<void>;
	readonly #release: Promise<void>;
	#resolveComplete: (() => void) | undefined;
	#resolvePending: (() => void) | undefined;
	#resolveRelease: (() => void) | undefined;

	constructor() {
		this.#complete = new Promise<void>((resolve) => {
			this.#resolveComplete = resolve;
		});
		this.#pending = new Promise<void>((resolve) => {
			this.#resolvePending = resolve;
		});
		this.#release = new Promise<void>((resolve) => {
			this.#resolveRelease = resolve;
		});
	}

	async defer(open: () => void): Promise<void> {
		this.#resolvePending?.();
		await this.#release;
		open();
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		this.#resolveComplete?.();
	}

	release(): void {
		this.#resolveRelease?.();
	}

	waitUntilComplete(): Promise<void> {
		return this.#complete;
	}

	waitUntilPending(): Promise<void> {
		return this.#pending;
	}
}

class FakePeerConnection {
	static nextId = 1;
	static nextInboundHandlerBarrier: FakeInboundOpenBarrier | undefined;
	static nextInboundOpenBarrier: FakeInboundOpenBarrier | undefined;
	static nextInitiatorOutboundOpenBarrier: FakeRemoteInboundOpenBarrier | undefined;
	static nextRemoteInboundOpenBarrier: FakeRemoteInboundOpenBarrier | undefined;
	static readonly registry = new Map<string, FakePeerConnection>();

	static pauseNextInboundOpen(): FakeInboundOpenBarrier {
		if (FakePeerConnection.nextInboundOpenBarrier !== undefined) {
			throw new Error("fake inbound-open barrier is already armed");
		}
		const barrier = new FakeInboundOpenBarrier();
		FakePeerConnection.nextInboundOpenBarrier = barrier;
		return barrier;
	}

	static pauseNextInboundHandler(): FakeInboundOpenBarrier {
		if (FakePeerConnection.nextInboundHandlerBarrier !== undefined) {
			throw new Error("fake inbound-handler barrier is already armed");
		}
		const barrier = new FakeInboundOpenBarrier();
		FakePeerConnection.nextInboundHandlerBarrier = barrier;
		return barrier;
	}

	static pauseNextInitiatorOutboundOpen(): FakeRemoteInboundOpenBarrier {
		if (FakePeerConnection.nextInitiatorOutboundOpenBarrier !== undefined) {
			throw new Error("fake initiator-outbound-open barrier is already armed");
		}
		const barrier = new FakeRemoteInboundOpenBarrier();
		FakePeerConnection.nextInitiatorOutboundOpenBarrier = barrier;
		return barrier;
	}

	static pauseNextRemoteInboundOpen(): FakeRemoteInboundOpenBarrier {
		if (FakePeerConnection.nextRemoteInboundOpenBarrier !== undefined) {
			throw new Error("fake remote-inbound-open barrier is already armed");
		}
		const barrier = new FakeRemoteInboundOpenBarrier();
		FakePeerConnection.nextRemoteInboundOpenBarrier = barrier;
		return barrier;
	}

	static releaseInboundOpenBarrier(barrier: FakeInboundOpenBarrier | undefined): void {
		barrier?.release();
		if (FakePeerConnection.nextInboundOpenBarrier === barrier) {
			FakePeerConnection.nextInboundOpenBarrier = undefined;
		}
	}

	static releaseRemoteInboundOpenBarrier(barrier: FakeRemoteInboundOpenBarrier | undefined): void {
		barrier?.release();
		if (FakePeerConnection.nextRemoteInboundOpenBarrier === barrier) {
			FakePeerConnection.nextRemoteInboundOpenBarrier = undefined;
		}
	}

	static releaseInitiatorOutboundOpenBarrier(barrier: FakeRemoteInboundOpenBarrier | undefined): void {
		barrier?.release();
		if (FakePeerConnection.nextInitiatorOutboundOpenBarrier === barrier) {
			FakePeerConnection.nextInitiatorOutboundOpenBarrier = undefined;
		}
	}

	static releaseInboundHandlerBarrier(barrier: FakeInboundOpenBarrier | undefined): void {
		barrier?.release();
		if (FakePeerConnection.nextInboundHandlerBarrier === barrier) {
			FakePeerConnection.nextInboundHandlerBarrier = undefined;
		}
	}

	connectionState: RTCPeerConnectionState = "new";
	iceGatheringState: RTCIceGatheringState = "new";
	localDescription: RTCSessionDescription | null = null;
	onconnectionstatechange: ((event: Event) => void) | null = null;
	ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
	onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
	onicegatheringstatechange: ((event: Event) => void) | null = null;
	remoteDescription: RTCSessionDescription | null = null;
	readonly sctp: Readonly<{ maxMessageSize: number; transport: Readonly<{ state: string }> }>;
	readonly channels: FakeDataChannel[] = [];
	readonly candidates: RTCIceCandidateInit[] = [];
	readonly #id: string;
	readonly #options: FakePeerConnectionOptions;
	readonly #listeners = new Map<string, Set<Listener>>();

	constructor(options: FakePeerConnectionOptions = {}) {
		this.#id = `pc-${FakePeerConnection.nextId++}`;
		this.#options = options;
		this.sctp = Object.freeze({
			maxMessageSize: options.maxMessageSize ?? 65_536,
			transport: Object.freeze({ state: "connected" }),
		});
		FakePeerConnection.registry.set(this.#id, this);
	}

	addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		const selected =
			typeof listener === "function" ? listener : (event: unknown): void => listener.handleEvent(event as Event);
		const listeners = this.#listeners.get(type) ?? new Set<Listener>();
		listeners.add(selected as Listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		if (typeof listener === "function") this.#listeners.get(type)?.delete(listener as Listener);
	}

	addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
		if (candidate !== null) this.candidates.push(candidate);
		return Promise.resolve();
	}

	close(): void {
		if (this.connectionState === "closed") return;
		this.connectionState = "closed";
		for (const channel of this.channels) channel.close();
		this.#emit("connectionstatechange", new Event("connectionstatechange"));
	}

	createAnswer(): Promise<RTCSessionDescriptionInit> {
		if (this.#options.hangAnswer === true) return new Promise<RTCSessionDescriptionInit>(() => undefined);
		return Promise.resolve({ sdp: this.#description("answer"), type: "answer" });
	}

	createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
		const channel = new FakeDataChannel(label, options);
		this.channels.push(channel);
		return channel as unknown as RTCDataChannel;
	}

	createOffer(): Promise<RTCSessionDescriptionInit> {
		if (this.#options.hangOffer === true) return new Promise<RTCSessionDescriptionInit>(() => undefined);
		return Promise.resolve({ sdp: this.#description("offer"), type: "offer" });
	}

	getStats(): Promise<RTCStatsReport> {
		const stats = new Map<string, Record<string, unknown>>([
			[
				"pair-1",
				{
					bytesReceived: 13,
					bytesSent: 21,
					id: "pair-1",
					localCandidateId: "local-1",
					nominated: true,
					remoteCandidateId: "remote-1",
					state: "succeeded",
					type: "candidate-pair",
				},
			],
			["local-1", { candidateType: "host", id: "local-1", type: "local-candidate" }],
			["remote-1", { candidateType: "srflx", id: "remote-1", type: "remote-candidate" }],
			["channel-1", { id: "channel-1", state: "open", type: "data-channel" }],
		]);
		return Promise.resolve(stats as unknown as RTCStatsReport);
	}

	setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
		this.localDescription = description as RTCSessionDescription;
		this.iceGatheringState = "gathering";
		const candidateCount = this.#options.candidateCount ?? 1;
		for (let index = 0; index < candidateCount; index += 1) {
			this.#emit(
				"icecandidate",
				Object.assign(new Event("icecandidate"), {
					candidate: { candidate: `candidate:${this.#id}:${index}`, sdpMLineIndex: 0, sdpMid: "0" },
				})
			);
		}
		this.iceGatheringState = "complete";
		this.#emit("icecandidate", Object.assign(new Event("icecandidate"), { candidate: null }));
		this.#emit("icegatheringstatechange", new Event("icegatheringstatechange"));
		return Promise.resolve();
	}

	async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
		this.remoteDescription = description as RTCSessionDescription;
		const remoteId = /a=mid:(pc-\d+)/u.exec(description.sdp ?? "")?.[1];
		const remote = remoteId === undefined ? undefined : FakePeerConnection.registry.get(remoteId);
		if (remote === undefined) return Promise.reject(new TypeError("fake remote peer connection missing"));
		this.connectionState = "connected";
		remote.connectionState = "connected";
		if (description.type === "offer") {
			const handlerBarrier = FakePeerConnection.nextInboundHandlerBarrier;
			FakePeerConnection.nextInboundHandlerBarrier = undefined;
			const barrier = FakePeerConnection.nextInboundOpenBarrier;
			FakePeerConnection.nextInboundOpenBarrier = undefined;
			const remoteOpenBarrier = FakePeerConnection.nextRemoteInboundOpenBarrier;
			FakePeerConnection.nextRemoteInboundOpenBarrier = undefined;
			const initiatorOpenBarrier = FakePeerConnection.nextInitiatorOutboundOpenBarrier;
			FakePeerConnection.nextInitiatorOutboundOpenBarrier = undefined;
			for (const outbound of remote.channels) {
				const inbound = new FakeDataChannel(this.#options.inboundChannel?.label ?? outbound.label, {
					maxRetransmits: this.#options.inboundChannel?.maxRetransmits ?? outbound.maxRetransmits ?? undefined,
					ordered: this.#options.inboundChannel?.ordered ?? outbound.ordered,
				});
				outbound.link(inbound);
				if (initiatorOpenBarrier !== undefined) {
					outbound.pair(inbound);
					inbound.link(outbound);
					void initiatorOpenBarrier.defer(() => outbound.open());
				} else if (remoteOpenBarrier === undefined) {
					inbound.link(outbound);
				} else {
					inbound.pair(outbound);
					void remoteOpenBarrier.defer(() => inbound.open());
				}
				this.channels.push(inbound);
				if (handlerBarrier !== undefined) await handlerBarrier.hold();
				this.#emit(
					"datachannel",
					Object.assign(new Event("datachannel"), { channel: inbound as unknown as RTCDataChannel })
				);
			}
			// Hold only after the inbound data-channel handler has observed an already-open B.
			if (barrier !== undefined) await barrier.hold();
		}
		this.#emit("connectionstatechange", new Event("connectionstatechange"));
		remote.#emit("connectionstatechange", new Event("connectionstatechange"));
	}

	#description(type: "answer" | "offer"): string {
		const prefix = `${type}\na=mid:${this.#id}\n`;
		return prefix.padEnd(this.#options.sdpBytes ?? prefix.length, "x");
	}

	#emit(type: string, event: Event): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
		if (type === "connectionstatechange") this.onconnectionstatechange?.(event);
		if (type === "datachannel") this.ondatachannel?.(event as RTCDataChannelEvent);
		if (type === "icecandidate") this.onicecandidate?.(event as RTCPeerConnectionIceEvent);
		if (type === "icegatheringstatechange") this.onicegatheringstatechange?.(event);
	}
}

interface MutableEndpoint {
	connections: Map<string, MutableConnection>;
	handler?(connection: AuthenticatedConnection, request: Uint8Array): Promise<Uint8Array>;
}

interface MutableConnection extends AuthenticatedConnection {
	close(): void;
}

interface ExchangeRecord {
	readonly connectionId: string;
	readonly generation: number;
	readonly remoteAddr: string;
	readonly remotePeerId: string;
}

class FakeSignalingBus {
	readonly exchangeRecords: ExchangeRecord[] = [];
	readonly #endpoints = new Map<string, MutableEndpoint>();
	#nextConnection = 1;
	#nextGeneration = 1;
	#pendingResponse?: Promise<void>;
	#releaseResponse?: () => void;
	#pendingObserved?: Promise<void>;
	#pendingObservedState = false;
	#resolvePendingObserved?: () => void;
	requestTransform: (request: Uint8Array) => Uint8Array = (request) => request;
	responseTransform: (response: Uint8Array) => Uint8Array = (response) => response;

	createPort(peerId: string): SignalingPort {
		const endpoint: MutableEndpoint = this.#endpoints.get(peerId) ?? { connections: new Map() };
		this.#endpoints.set(peerId, endpoint);
		return {
			connections: (): readonly AuthenticatedConnection[] => [...endpoint.connections.values()],
			localPeerId: peerId,
			onRequest: (listener): (() => void) => {
				endpoint.handler = listener;
				return (): void => {
					if (endpoint.handler === listener) endpoint.handler = undefined;
				};
			},
		};
	}

	connect(
		leftPeerId: string,
		rightPeerId: string,
		transport: "other" | "webrtc" = "webrtc",
		ids?: Readonly<{ readonly left: string; readonly right: string }>
	): Readonly<{ left: MutableConnection; right: MutableConnection }> {
		const left = this.#endpoint(leftPeerId);
		const right = this.#endpoint(rightPeerId);
		const generation = this.#nextGeneration++;
		const pairId = this.#nextConnection++;
		const pair = {} as { left: MutableConnection; right: MutableConnection };
		const connection = (
			local: MutableEndpoint,
			remote: MutableEndpoint,
			remotePeerId: string,
			id: string,
			reverse: () => MutableConnection
		): MutableConnection => {
			const closeListeners = new Set<() => void>();
			let closed = false;
			return {
				close(): void {
					if (closed) return;
					closed = true;
					local.connections.delete(id);
					for (const listener of closeListeners) listener();
				},
				exchange: async (request, signal): Promise<Uint8Array> => {
					if (closed || remote.handler === undefined) throw new Error("fake signaling handler missing");
					this.exchangeRecords.push({
						connectionId: id,
						generation,
						remoteAddr: `/webrtc/${remotePeerId}`,
						remotePeerId,
					});
					const response = await remote.handler(reverse(), this.requestTransform(request.slice()));
					this.#pendingObservedState = true;
					this.#resolvePendingObserved?.();
					await this.#waitForResponse(signal);
					return this.responseTransform(response.slice());
				},
				generation,
				id,
				onClose(listener): () => void {
					closeListeners.add(listener);
					return (): void => {
						closeListeners.delete(listener);
					};
				},
				remoteAddr: `/webrtc/${remotePeerId}`,
				remotePeerId,
				transport,
			};
		};
		pair.left = connection(left, right, rightPeerId, ids?.left ?? `conn-${pairId}-left`, () => pair.right);
		pair.right = connection(right, left, leftPeerId, ids?.right ?? `conn-${pairId}-right`, () => pair.left);
		left.connections.set(pair.left.id, pair.left);
		right.connections.set(pair.right.id, pair.right);
		return pair;
	}

	disconnect(pair: Readonly<{ left: MutableConnection; right: MutableConnection }>): void {
		pair.left.close();
		pair.right.close();
	}

	forgetWithoutClose(pair: Readonly<{ left: MutableConnection; right: MutableConnection }>): void {
		this.#endpoint(pair.right.remotePeerId).connections.delete(pair.left.id);
		this.#endpoint(pair.left.remotePeerId).connections.delete(pair.right.id);
	}

	pauseResponses(): Readonly<{ isPending(): boolean; release(): void; waitUntilPending(): Promise<void> }> {
		this.#pendingResponse = new Promise<void>((resolve) => {
			this.#releaseResponse = resolve;
		});
		this.#pendingObservedState = false;
		this.#pendingObserved = new Promise<void>((resolve) => {
			this.#resolvePendingObserved = resolve;
		});
		return {
			isPending: (): boolean => this.#pendingObservedState,
			release: (): void => {
				this.#releaseResponse?.();
				this.#pendingResponse = undefined;
				this.#releaseResponse = undefined;
			},
			waitUntilPending: (): Promise<void> => this.#pendingObserved ?? Promise.resolve(),
		};
	}

	async #waitForResponse(signal: AbortSignal): Promise<void> {
		const pending = this.#pendingResponse;
		if (pending === undefined) return;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (complete: () => void): void => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				complete();
			};
			const onAbort = (): void =>
				finish(() =>
					reject(signal.reason instanceof Error ? signal.reason : new Error("fake signaling exchange aborted"))
				);
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			void pending.then(
				() => finish(resolve),
				(error: unknown) => finish(() => reject(error))
			);
		});
	}

	#endpoint(peerId: string): MutableEndpoint {
		const endpoint = this.#endpoints.get(peerId);
		if (endpoint === undefined) throw new Error(`fake signaling endpoint missing: ${peerId}`);
		return endpoint;
	}
}

function owner(
	module: OwnerModule,
	bus: FakeSignalingBus,
	peerId: string,
	options: FakePeerConnectionOptions = {}
): Readonly<{
	owner: UnreliableWebRtcOwner;
	peerConnections: FakePeerConnection[];
	signaling: SignalingPort;
}> {
	const peerConnections: FakePeerConnection[] = [];
	const signaling = bus.createPort(peerId);
	return {
		owner: module.createDRPUnreliableWebRtcOwner({
			createPeerConnection: (): RTCPeerConnection => {
				const connection = new FakePeerConnection(options);
				peerConnections.push(connection);
				return connection as unknown as RTCPeerConnection;
			},
			signaling,
		}),
		peerConnections,
		signaling,
	};
}

function routeDigest(routeId: string): Uint8Array {
	return new Uint8Array(
		createHash("sha256").update("ts-drp-ephemeral-route-v1\0", "utf8").update(routeId, "utf8").digest()
	);
}

function routedFrame(routeId: string, payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(ROUTE_HEADER_BYTES + payload.byteLength);
	frame[0] = 1;
	frame.set(routeDigest(routeId), 1);
	frame.set(payload, ROUTE_HEADER_BYTES);
	return frame;
}

function routedFrames(channel: FakeDataChannel): readonly Uint8Array[] {
	return channel.sent.filter((bytes) => bytes.byteLength >= ROUTE_HEADER_BYTES && bytes[0] === 1);
}

function controlFrames(channel: FakeDataChannel): readonly Uint8Array[] {
	return channel.sent.filter(
		(bytes) => bytes.byteLength === 4 && bytes[0] === 0x44 && bytes[1] === 0x52 && bytes[2] === 0x01
	);
}

function tick(): Promise<void> {
	return new Promise<void>((resolve) => queueMicrotask(resolve));
}

interface InboundCapacityFixture {
	readonly admittedPeers: readonly string[];
	readonly bus: FakeSignalingBus;
	readonly center: ReturnType<typeof owner>;
	readonly centerRoute: UnreliableWebRtcRoute;
	readonly pairs: readonly ReturnType<FakeSignalingBus["connect"]>[];
	readonly remotes: readonly ReturnType<typeof owner>[];
	readonly remoteRoutes: readonly UnreliableWebRtcRoute[];
}

interface ReservedCapacityFixture extends InboundCapacityFixture {
	readonly replacement: ReturnType<FakeSignalingBus["connect"]>;
}

async function inboundCapacityFixture(
	module: OwnerModule,
	centerPeerId: string,
	centerOptions: FakePeerConnectionOptions = {}
): Promise<InboundCapacityFixture> {
	const bus = new FakeSignalingBus();
	const center = owner(module, bus, centerPeerId, centerOptions);
	const centerRoute = center.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
	const admittedPeers = Array.from({ length: 8 }, (_value, index) => `peer-${String(index).padStart(2, "0")}`);
	const remotes: ReturnType<typeof owner>[] = [];
	const remoteRoutes: UnreliableWebRtcRoute[] = [];
	const pairs: ReturnType<FakeSignalingBus["connect"]>[] = [];
	for (const [index, peerId] of admittedPeers.entries()) {
		const remote = owner(module, bus, peerId);
		const remoteRoute = remote.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
		remotes.push(remote);
		remoteRoutes.push(remoteRoute);
		pairs.push(bus.connect(peerId, centerPeerId));
		expect(await remoteRoute.send([centerPeerId], Uint8Array.of(index))).toBe(true);
	}
	await centerRoute.reconcile(admittedPeers);
	expect(centerRoute.snapshot()).toMatchObject({ activeLinks: 8, linkDrops: 0 });
	return { admittedPeers, bus, center, centerRoute, pairs, remotes, remoteRoutes };
}

async function reservedCapacityFixture(module: OwnerModule, centerPeerId: string): Promise<ReservedCapacityFixture> {
	const fixture = await inboundCapacityFixture(module, centerPeerId);

	const replacedIndex = fixture.admittedPeers.length - 1;
	const replacedPeerId = fixture.admittedPeers[replacedIndex];
	const original = fixture.pairs[replacedIndex];
	const replacedRoute = fixture.remoteRoutes[replacedIndex];
	if (replacedPeerId === undefined || original === undefined || replacedRoute === undefined) {
		throw new Error("reserved capacity fixture is incomplete");
	}
	const centerChannel = fixture.center.peerConnections[replacedIndex]?.channels[0];
	const remoteChannel = fixture.remotes[replacedIndex]?.peerConnections[0]?.channels[0];
	if (centerChannel === undefined || remoteChannel === undefined) {
		throw new Error("reserved capacity raw channel is incomplete");
	}
	// Admission-timer controls use an already-unusable A; open-A replacement is covered separately.
	centerChannel.readyState = "closing";
	remoteChannel.readyState = "closing";
	fixture.bus.disconnect(original);
	const replacement = fixture.bus.connect(replacedPeerId, centerPeerId, "webrtc", {
		left: "replacement-low",
		right: "replacement-owner",
	});
	await fixture.centerRoute.reconcile(fixture.admittedPeers);
	replacedRoute.close();
	expect(fixture.centerRoute.snapshot()).toMatchObject({
		activeLinks: 7,
		lastLinkDrop: "replacement",
		linkDrops: 1,
	});
	expect(fixture.center.peerConnections).toHaveLength(8);
	return { ...fixture, replacement };
}

function closeInboundCapacityFixture(fixture: InboundCapacityFixture): void {
	fixture.center.owner.close();
	for (const remote of fixture.remotes) remote.owner.close();
}

function nodeEphemeralAdapterArguments(source: string): readonly ts.Expression[] {
	const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const matches: ts.NewExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isNewExpression(node) && node.expression.getText(file) === "NodeEphemeralAdapter") matches.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	expect(matches).toHaveLength(1);
	return matches[0]?.arguments ?? [];
}

it("E3-01 RED exposes the missing authenticated unreliable WebRTC owner", () => {
	expect(ownerExists).toBe(true);
});

describe.skipIf(!ownerExists)("E3-01 authenticated unreliable WebRTC", () => {
	it("adapts the exact authenticated libp2p connection and signaling stream", async () => {
		const module = await loadOwnerModule();
		const outboundStream = Object.freeze({ id: "outbound-stream" });
		const inboundStream = Object.freeze({ id: "inbound-stream" });
		let closeListener: (() => void) | undefined;
		let incoming: ((input: IncomingSignalingStream) => Promise<void>) | undefined;
		const newStream = vi.fn<(protocol: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>>(() =>
			Promise.resolve(outboundStream)
		);
		const connection: Libp2pConnectionFixture = {
			addEventListener: (_type, listener): void => {
				closeListener = listener;
			},
			id: "libp2p-connection-7",
			newStream,
			remoteAddr: { toString: (): string => "/webrtc" },
			remotePeer: { toString: (): string => "peer-b" },
		};
		const directConnection: Libp2pConnectionFixture = {
			...connection,
			addEventListener(): void {},
			id: "libp2p-connection-direct",
			remoteAddr: { toString: (): string => "/ip4/127.0.0.1/udp/4002/webrtc-direct" },
		};
		const deceptiveConnection: Libp2pConnectionFixture = {
			...connection,
			addEventListener(): void {},
			id: "libp2p-connection-deceptive",
			remoteAddr: { toString: (): string => "/dns/webrtc/tcp/4003" },
		};
		const writes: Array<{ bytes: Uint8Array; stream: unknown }> = [];
		const readBounds: number[] = [];
		const port = module.createLibp2pWebRtcSignalingPort({
			connections: (): readonly Libp2pConnectionFixture[] => [connection, directConnection, deceptiveConnection],
			localPeerId: "peer-a",
			onIncoming: (listener): (() => void) => {
				incoming = listener;
				return (): void => {
					if (incoming === listener) incoming = undefined;
				};
			},
			read: (stream, maxBytes): Promise<Uint8Array> => {
				readBounds.push(maxBytes);
				return Promise.resolve(stream === outboundStream ? Uint8Array.of(4, 5) : Uint8Array.of(1, 2, 3));
			},
			write: (stream, bytes): Promise<void> => {
				writes.push({ bytes: bytes.slice(), stream });
				return Promise.resolve();
			},
		});
		const adapted = port.connections()[0];
		if (adapted === undefined) throw new Error("adapted authenticated connection missing");
		expect(adapted).toMatchObject({
			generation: 1,
			id: "libp2p-connection-7",
			remoteAddr: "/webrtc",
			remotePeerId: "peer-b",
			transport: "webrtc",
		});
		expect(port.connections().map(({ transport }) => transport)).toEqual(["webrtc", "webrtc", "other"]);
		const exchangeAbort = new AbortController();
		expect(await adapted.exchange(Uint8Array.of(9), exchangeAbort.signal)).toEqual(Uint8Array.of(4, 5));
		expect(newStream).toHaveBeenCalledExactlyOnceWith(SIGNALING_PROTOCOL, { signal: exchangeAbort.signal });
		expect(writes).toEqual([{ bytes: Uint8Array.of(9), stream: outboundStream }]);
		expect(readBounds).toEqual([65_536]);

		const requestEvidence: Array<{ id: string; peerId: string; request: Uint8Array }> = [];
		port.onRequest((authenticated, request): Promise<Uint8Array> => {
			requestEvidence.push({ id: authenticated.id, peerId: authenticated.remotePeerId, request: request.slice() });
			return Promise.resolve(Uint8Array.of(6, 7));
		});
		if (incoming === undefined) throw new Error("incoming signaling handler missing");
		await incoming({ connection, stream: inboundStream });
		expect(requestEvidence).toEqual([{ id: "libp2p-connection-7", peerId: "peer-b", request: Uint8Array.of(1, 2, 3) }]);
		expect(writes.at(-1)).toEqual({ bytes: Uint8Array.of(6, 7), stream: inboundStream });
		expect(readBounds).toEqual([65_536, 65_536]);

		const closed = vi.fn();
		adapted.onClose(closed);
		closeListener?.();
		expect(closed).toHaveBeenCalledOnce();
	});

	it("aborts bounded signaling streams on outbound cancellation and the inbound setup deadline", async () => {
		const module = await loadOwnerModule();
		let incoming: ((input: IncomingSignalingStream) => Promise<void>) | undefined;
		let rejectOutbound: ((error: Error) => void) | undefined;
		let rejectInbound: ((error: Error) => void) | undefined;
		let markOutboundReadStarted: (() => void) | undefined;
		const outboundReadStarted = new Promise<void>((resolve) => {
			markOutboundReadStarted = resolve;
		});
		const outboundStream = {
			abort: vi.fn((error: Error): void => rejectOutbound?.(error)),
			close: vi.fn((): Promise<void> => Promise.resolve()),
		};
		const inboundStream = {
			abort: vi.fn((error: Error): void => rejectInbound?.(error)),
			close: vi.fn((): Promise<void> => Promise.resolve()),
		};
		const connection: Libp2pConnectionFixture = {
			addEventListener(): void {},
			id: "libp2p-connection-cancellable",
			newStream: (): Promise<unknown> => Promise.resolve(outboundStream),
			remoteAddr: { toString: (): string => "/webrtc" },
			remotePeer: { toString: (): string => "peer-b" },
		};
		const port = module.createLibp2pWebRtcSignalingPort({
			connections: (): readonly Libp2pConnectionFixture[] => [connection],
			localPeerId: "peer-a",
			onIncoming: (listener): (() => void) => {
				incoming = listener;
				return (): void => {
					if (incoming === listener) incoming = undefined;
				};
			},
			read: (stream): Promise<Uint8Array> =>
				new Promise<Uint8Array>((_resolve, reject) => {
					if (stream === outboundStream) {
						rejectOutbound = reject;
						markOutboundReadStarted?.();
					} else rejectInbound = reject;
				}),
			write: (): Promise<void> => Promise.resolve(),
		});
		port.onRequest((): Promise<Uint8Array> => Promise.resolve(Uint8Array.of(1)));
		const adapted = port.connections()[0];
		if (adapted === undefined || incoming === undefined) throw new Error("cancellable signaling fixture missing");

		const controller = new AbortController();
		const outbound = adapted.exchange(Uint8Array.of(1), controller.signal);
		const outboundResult = outbound.then(
			() => undefined,
			(error: unknown) => error
		);
		await outboundReadStarted;
		controller.abort(new Error("controlled outbound cancellation"));
		await tick();
		const outboundAborted = outboundStream.abort.mock.calls.length === 1;
		if (!outboundAborted) outboundStream.abort(new Error("controlled outbound cleanup"));
		expect(outboundAborted).toBe(true);
		expect(await outboundResult).toMatchObject({ message: "controlled outbound cancellation" });

		vi.useFakeTimers();
		const inbound = incoming({ connection, stream: inboundStream });
		const inboundResult = inbound.then(
			() => undefined,
			(error: unknown) => error
		);
		try {
			await tick();
			await vi.advanceTimersByTimeAsync(10_000);
			const inboundAborted = inboundStream.abort.mock.calls.length === 1;
			if (!inboundAborted) inboundStream.abort(new Error("controlled inbound cleanup"));
			expect(inboundAborted).toBe(true);
			expect(await inboundResult).toMatchObject({ message: "RTC setup deadline exceeded" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("exports the network owner, composes only the default node, and promotes sanitized RTC evidence", async () => {
		const module = await loadOwnerModule();
		expect(module.DRP_UNRELIABLE_WEBRTC_SIGNALING_PROTOCOL).toBe(SIGNALING_PROTOCOL);
		expect(await module.extractSanitizedRtcEvidence(new FakePeerConnection() as unknown as RTCPeerConnection)).toEqual({
			bytesReceived: 13,
			bytesSent: 21,
			candidateTypes: ["host", "srflx"],
			dataChannelOpen: true,
			selectedPairId: "pair-1",
		});

		const ownerSource = readFileSync(OWNER_PATH, "utf8");
		const networkIndex = readFileSync("packages/network/src/index.ts", "utf8");
		const networkNode = readFileSync("packages/network/src/node.ts", "utf8");
		const nodeComposition = readFileSync("packages/node/src/index.ts", "utf8");
		const nodeAdapter = readFileSync("packages/node/src/ephemeral.ts", "utf8");
		const spike = readFileSync("packages/network-spike/src/grid/fixture.ts", "utf8");
		expect(networkIndex).toContain('export * from "./unreliable-webrtc.js"');
		expect(ownerSource).toContain("connection.newStream");
		expect(networkNode).toContain("unreliableWebRtcOwner");
		expect(networkNode).toContain("createLibp2pWebRtcSignalingPort");
		expect(networkNode).toContain("this._node.getConnections()");
		expect(nodeAdapter).toContain("DRPUnreliableWebRtcOwner");
		const adapterArguments = nodeEphemeralAdapterArguments(nodeComposition);
		expect(adapterArguments).toHaveLength(3);
		const rawOwner = adapterArguments[2];
		expect(rawOwner !== undefined && ts.isConditionalExpression(rawOwner)).toBe(true);
		if (rawOwner === undefined || !ts.isConditionalExpression(rawOwner)) throw new Error("raw owner selection missing");
		expect(rawOwner.condition.getText()).toBe("this.networkNode instanceof DefaultDRPNetworkNode");
		expect(rawOwner.whenTrue.getText()).toBe("this.networkNode.unreliableWebRtcOwner");
		expect(rawOwner.whenFalse.kind).toBe(ts.SyntaxKind.NullKeyword);
		expect(spike).toContain("extractSanitizedRtcEvidence");
		expect(spike).not.toMatch(/async function rtcEvidence/u);
		expect(ownerSource).not.toMatch(/\.(?:connect|dial|safeDial)\s*\(/u);
		expect(ownerSource).not.toMatch(/discovery|peerSelector|priorityAdmission|relayPolicy/u);
	});

	it("uses the lower authenticated peer, exact raw channel, ICE, route header, and detached ingress", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const left = owner(module, bus, "peer-a");
		const right = owner(module, bus, "peer-b");
		const pair = bus.connect("peer-a", "peer-b");
		const leftRoute = left.owner.openUnreliableWebRtcRoute("zone:alpha");
		const rightRoute = right.owner.openUnreliableWebRtcRoute("zone:alpha");
		const received: Array<{ bytes: Uint8Array; sender: string }> = [];
		rightRoute.onMessage((ingress) => received.push({ bytes: ingress.bytes.slice(), sender: ingress.sender }));

		const higherAttempt = rightRoute.send(["peer-a"], Uint8Array.of(8));
		const payload = Uint8Array.of(1, 2, 3);
		const lowerAttempt = leftRoute.send(["peer-b"], payload);
		expect(await Promise.all([lowerAttempt, higherAttempt])).toEqual([true, false]);
		payload.fill(9);
		await tick();

		expect(received).toEqual([{ bytes: Uint8Array.of(1, 2, 3), sender: "peer-a" }]);
		expect(left.peerConnections).toHaveLength(1);
		expect(right.peerConnections).toHaveLength(1);
		expect(left.peerConnections[0]?.channels).toHaveLength(1);
		expect(right.peerConnections[0]?.channels).toHaveLength(1);
		expect(left.peerConnections[0]?.channels[0]).toMatchObject({
			binaryType: "arraybuffer",
			label: RAW_LABEL,
			maxRetransmits: 0,
			ordered: false,
		});
		expect(right.peerConnections[0]?.channels[0]?.binaryType).toBe("arraybuffer");
		expect(left.peerConnections[0]?.candidates).toHaveLength(1);
		expect(right.peerConnections[0]?.candidates).toHaveLength(1);
		expect(bus.exchangeRecords).toEqual([
			{
				connectionId: pair.left.id,
				generation: pair.left.generation,
				remoteAddr: pair.left.remoteAddr,
				remotePeerId: "peer-b",
			},
		]);
		expect(leftRoute.maxPayloadBytes).toBe(MAX_PAYLOAD_BYTES);
		const rawChannel = left.peerConnections[0]?.channels[0];
		const wire = rawChannel === undefined ? undefined : routedFrames(rawChannel)[0];
		if (wire === undefined) throw new Error("routed wire envelope missing");
		expect(wire[0]).toBe(1);
		expect(wire.slice(1, ROUTE_HEADER_BYTES)).toEqual(routeDigest("zone:alpha"));
		expect(wire.slice(ROUTE_HEADER_BYTES)).toEqual(Uint8Array.of(1, 2, 3));
		expect(leftRoute.snapshot()).toMatchObject({ activeLinks: 1, received: 0, sent: 1 });
		expect(rightRoute.snapshot()).toMatchObject({ activeLinks: 1, received: 1, sent: 0 });
	});

	it("fails closed without an authenticated WebRTC connection and has no dial capability", async () => {
		const module = await loadOwnerModule();
		const absentBus = new FakeSignalingBus();
		const absent = owner(module, absentBus, "peer-a");
		const absentRoute = absent.owner.openUnreliableWebRtcRoute("zone:alpha");
		expect(await absentRoute.send(["peer-b"], Uint8Array.of(1))).toBe(false);
		expect(absent.peerConnections).toHaveLength(0);
		expect("connect" in absent.signaling).toBe(false);
		expect("dial" in absent.signaling).toBe(false);

		const otherBus = new FakeSignalingBus();
		const other = owner(module, otherBus, "peer-a");
		owner(module, otherBus, "peer-b");
		otherBus.connect("peer-a", "peer-b", "other");
		expect(await other.owner.openUnreliableWebRtcRoute("zone:alpha").send(["peer-b"], Uint8Array.of(1))).toBe(false);
		expect(other.peerConnections).toHaveLength(0);
	});

	it.each([
		["reserved init label", { label: "init" }],
		["wrong label", { label: "ts-drp-ephemeral/2" }],
		["ordered channel", { ordered: true }],
		["reliable channel", { maxRetransmits: 1 }],
	] as const)("rejects inbound %s", async (_name, inboundChannel) => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const left = owner(module, bus, "peer-a");
		const right = owner(module, bus, "peer-b", { inboundChannel });
		bus.connect("peer-a", "peer-b");
		right.owner.openUnreliableWebRtcRoute("zone:alpha");
		const leftRoute = left.owner.openUnreliableWebRtcRoute("zone:alpha");
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(1))).toBe(false);
		expect(leftRoute.snapshot()).toMatchObject({ activeLinks: 0, handshakeFailures: 1 });
		expect(left.peerConnections.every(({ connectionState }) => connectionState === "closed")).toBe(true);
		expect(right.peerConnections.every(({ connectionState }) => connectionState === "closed")).toBe(true);
	});

	it("caps sibling links at eight, replaces one in place, and rejects a ninth without allocating it", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const center = owner(module, bus, "peer-00");
		const centerRoute = center.owner.openUnreliableWebRtcRoute("zone:alpha");
		const remotes: ReturnType<typeof owner>[] = [];
		const admittedPeers: string[] = [];
		let replacedPair: ReturnType<FakeSignalingBus["connect"]> | undefined;
		let barrier: ReturnType<FakeSignalingBus["pauseResponses"]> | undefined;
		let pending: Promise<void> | undefined;
		try {
			for (let index = 1; index <= 9; index += 1) {
				const peerId = `peer-${String(index).padStart(2, "0")}`;
				const remote = owner(module, bus, peerId);
				remotes.push(remote);
				remote.owner.openUnreliableWebRtcRoute("zone:alpha");
				const pair = bus.connect("peer-00", peerId);
				if (index <= 8) admittedPeers.push(peerId);
				if (index === 8) replacedPair = pair;
				expect(await centerRoute.send([peerId], Uint8Array.of(index))).toBe(index <= 8);
			}
			expect(center.peerConnections).toHaveLength(8);
			expect(centerRoute.snapshot()).toMatchObject({ activeLinks: 8, linkDrops: 0 });

			if (replacedPair === undefined) throw new Error("capacity replacement fixture missing");
			const replacedPeerConnection = center.peerConnections.at(-1);
			bus.disconnect(replacedPair);
			const replacement = bus.connect("peer-00", "peer-08");
			await centerRoute.reconcile(admittedPeers);
			expect(replacedPeerConnection?.connectionState).toBe("connected");
			expect(centerRoute.snapshot()).toMatchObject({
				activeLinks: 8,
				lastLinkDrop: undefined,
				linkDrops: 0,
			});
			expect(center.peerConnections).toHaveLength(8);
			expect(center.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(8);
			expect(await centerRoute.send(["peer-08"], Uint8Array.of(80))).toBe(true);

			replacedPeerConnection?.close();
			barrier = bus.pauseResponses();
			pending = centerRoute.reconcile(admittedPeers);
			await barrier.waitUntilPending();
			expect(centerRoute.snapshot()).toMatchObject({ activeLinks: 7, lastLinkDrop: "channel-close", linkDrops: 1 });
			expect(center.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(8);

			barrier.release();
			await pending;
			expect(centerRoute.snapshot()).toMatchObject({
				activeLinks: 8,
				lastLinkDrop: "channel-close",
				linkDrops: 1,
				links: expect.arrayContaining([
					expect.objectContaining({
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						peerId: "peer-08",
					}),
				]),
			});
			expect(center.peerConnections.filter(({ connectionState }) => connectionState === "connected")).toHaveLength(8);
			const allocated = center.peerConnections.length;
			expect(await centerRoute.send(["peer-09"], Uint8Array.of(9))).toBe(false);
			expect(center.peerConnections).toHaveLength(allocated);
		} finally {
			barrier?.release();
			await pending?.catch(() => undefined);
			center.owner.close();
			for (const remote of remotes) remote.owner.close();
		}
	});

	it("uses the eighth physical slot for one seven-active replacement and refuses a newcomer", async () => {
		const module = await loadOwnerModule();
		const fixture = await inboundCapacityFixture(module, "peer-99");
		let barrier: FakeInboundOpenBarrier | undefined;
		let newcomer: ReturnType<typeof owner> | undefined;
		let pending: Promise<void> | undefined;
		try {
			await fixture.centerRoute.reconcile(fixture.admittedPeers.slice(0, 7));
			fixture.remoteRoutes[7]?.close();
			await tick();
			expect(fixture.centerRoute.snapshot().activeLinks).toBe(7);
			const replacementIndex = 6;
			const original = fixture.pairs[replacementIndex];
			const remoteRoute = fixture.remoteRoutes[replacementIndex];
			const oldCenterPc = fixture.center.peerConnections[replacementIndex];
			if (original === undefined || remoteRoute === undefined || oldCenterPc === undefined) {
				throw new Error("seven-active replacement fixture is incomplete");
			}
			fixture.bus.disconnect(original);
			const replacement = fixture.bus.connect("peer-06", "peer-99");
			barrier = FakePeerConnection.pauseNextInboundOpen();
			pending = remoteRoute.reconcile(["peer-99"]);
			await barrier.waitUntilPending();
			expect(oldCenterPc.connectionState).toBe("connected");
			expect(fixture.centerRoute.snapshot()).toMatchObject({ activeLinks: 7, linkDrops: 1 });
			expect(fixture.center.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(
				8
			);

			newcomer = owner(module, fixture.bus, "peer-08");
			const newcomerRoute = newcomer.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
			fixture.bus.connect("peer-08", "peer-99");
			const centerAllocations = fixture.center.peerConnections.length;
			expect(await newcomerRoute.send(["peer-99"], Uint8Array.of(8))).toBe(false);
			expect(fixture.center.peerConnections).toHaveLength(centerAllocations);

			FakePeerConnection.releaseInboundOpenBarrier(barrier);
			await pending;
			await vi.waitFor(() =>
				expect(fixture.centerRoute.snapshot().links).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							connectionId: replacement.right.id,
							generation: replacement.right.generation,
							peerId: "peer-06",
						}),
					])
				)
			);
			expect(fixture.centerRoute.snapshot()).toMatchObject({ activeLinks: 7, linkDrops: 2 });
			expect(fixture.center.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(
				7
			);
		} finally {
			FakePeerConnection.releaseInboundOpenBarrier(barrier);
			await pending?.catch(() => undefined);
			newcomer?.owner.close();
			closeInboundCapacityFixture(fixture);
		}
	});

	it("allocates only one free slot under concurrent seven-active replacement pressure", async () => {
		const module = await loadOwnerModule();
		const fixture = await inboundCapacityFixture(module, "peer-99");
		let barrier: FakeInboundOpenBarrier | undefined;
		let firstPending: Promise<void> | undefined;
		let secondPending: Promise<void> | undefined;
		try {
			await fixture.centerRoute.reconcile(fixture.admittedPeers.slice(0, 7));
			fixture.remoteRoutes[7]?.close();
			await tick();
			const firstIndex = 5;
			const secondIndex = 6;
			const firstOriginal = fixture.pairs[firstIndex];
			const secondOriginal = fixture.pairs[secondIndex];
			const firstRoute = fixture.remoteRoutes[firstIndex];
			const secondRoute = fixture.remoteRoutes[secondIndex];
			const firstOldPc = fixture.center.peerConnections[firstIndex];
			const secondOldPc = fixture.center.peerConnections[secondIndex];
			if (
				firstOriginal === undefined ||
				secondOriginal === undefined ||
				firstRoute === undefined ||
				secondRoute === undefined ||
				firstOldPc === undefined ||
				secondOldPc === undefined
			) {
				throw new Error("concurrent replacement fixture is incomplete");
			}

			fixture.bus.disconnect(firstOriginal);
			fixture.bus.connect("peer-05", "peer-99");
			barrier = FakePeerConnection.pauseNextInboundOpen();
			firstPending = firstRoute.reconcile(["peer-99"]);
			await barrier.waitUntilPending();
			fixture.bus.disconnect(secondOriginal);
			fixture.bus.connect("peer-06", "peer-99");
			secondPending = secondRoute.reconcile(["peer-99"]);
			await secondPending;

			expect(firstOldPc.connectionState).toBe("connected");
			expect(secondOldPc.connectionState).toBe("connected");
			expect(fixture.centerRoute.snapshot()).toMatchObject({ activeLinks: 7, linkDrops: 1 });
			expect(fixture.center.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(
				8
			);
		} finally {
			FakePeerConnection.releaseInboundOpenBarrier(barrier);
			await Promise.all([firstPending?.catch(() => undefined), secondPending?.catch(() => undefined)]);
			closeInboundCapacityFixture(fixture);
		}
	});

	it("reserves a non-open inbound link's capacity until its current replacement registers", async () => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		let fixture: ReservedCapacityFixture | undefined;
		let newcomer: ReturnType<typeof owner> | undefined;
		try {
			fixture = await reservedCapacityFixture(module, "peer-99");
			newcomer = owner(module, fixture.bus, "peer-08");
			const newcomerRoute = newcomer.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
			fixture.bus.connect("peer-08", "peer-99");
			const allocatedBefore = fixture.center.peerConnections.length;
			expect(Object.keys(fixture.centerRoute.snapshot()).sort()).toEqual([
				"activeLinks",
				"authenticatedConnectionLosses",
				"backpressuredDrops",
				"handshakeFailures",
				"lastLinkDrop",
				"linkDrops",
				"links",
				"received",
				"routedBytesReceived",
				"routedBytesSent",
				"sent",
				"unknownRouteDrops",
			]);
			expect(await newcomerRoute.send(["peer-99"], Uint8Array.of(8))).toBe(false);
			expect(fixture.center.peerConnections).toHaveLength(allocatedBefore);
			expect(fixture.centerRoute.snapshot().activeLinks).toBe(7);

			const restoredRoute = fixture.remotes.at(-1)?.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
			if (restoredRoute === undefined) throw new Error("reserved peer route missing");
			await restoredRoute.reconcile(["peer-99"]);
			expect(fixture.centerRoute.snapshot()).toMatchObject({
				activeLinks: 8,
				links: expect.arrayContaining([
					expect.objectContaining({
						connectionId: fixture.replacement.right.id,
						generation: fixture.replacement.right.generation,
						peerId: "peer-07",
					}),
				]),
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			newcomer?.owner.close();
			if (fixture !== undefined) closeInboundCapacityFixture(fixture);
			vi.useRealTimers();
		}
	});

	it("applies the same non-open admission to a mixed-order outbound capacity attempt", async () => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		let fixture: ReservedCapacityFixture | undefined;
		let higher: ReturnType<typeof owner> | undefined;
		try {
			fixture = await reservedCapacityFixture(module, "peer-50");
			higher = owner(module, fixture.bus, "peer-99");
			higher.owner.openUnreliableWebRtcRoute("zone:outbound-capacity");
			fixture.bus.connect("peer-50", "peer-99");
			const outboundRoute = fixture.center.owner.openUnreliableWebRtcRoute("zone:outbound-capacity");
			const allocatedBefore = fixture.center.peerConnections.length;
			await outboundRoute.reconcile(["peer-99"]);
			expect(fixture.center.peerConnections).toHaveLength(allocatedBefore);
			expect(fixture.centerRoute.snapshot()).toMatchObject({ activeLinks: 7 });
			expect(fixture.centerRoute.snapshot().links).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ peerId: "peer-99" })])
			);
		} finally {
			higher?.owner.close();
			if (fixture !== undefined) closeInboundCapacityFixture(fixture);
			vi.useRealTimers();
		}
	});

	it("bounds replacement admission across failed same-peer churn and the original setup deadline", async () => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		let fixture: ReservedCapacityFixture | undefined;
		let newcomer: ReturnType<typeof owner> | undefined;
		try {
			fixture = await reservedCapacityFixture(module, "peer-99");
			await vi.advanceTimersByTimeAsync(4_000);
			fixture.bus.disconnect(fixture.replacement);
			fixture.bus.connect("peer-07", "peer-99", "webrtc", {
				left: "churned-low",
				right: "churned-owner",
			});
			fixture.bus.requestTransform = (): Uint8Array => Uint8Array.of(255, 0, 255);
			const churnedRoute = fixture.remotes.at(-1)?.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
			if (churnedRoute === undefined) throw new Error("churned reserved peer route missing");
			await churnedRoute.reconcile(["peer-99"]);
			churnedRoute.close();
			fixture.bus.requestTransform = (request): Uint8Array => request;

			newcomer = owner(module, fixture.bus, "peer-08");
			const newcomerRoute = newcomer.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
			fixture.bus.connect("peer-08", "peer-99");
			await vi.advanceTimersByTimeAsync(5_999);
			expect(await newcomerRoute.send(["peer-99"], Uint8Array.of(1))).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(await newcomerRoute.send(["peer-99"], Uint8Array.of(2))).toBe(true);
			expect(fixture.centerRoute.snapshot().activeLinks).toBe(8);
		} finally {
			newcomer?.owner.close();
			if (fixture !== undefined) closeInboundCapacityFixture(fixture);
			vi.useRealTimers();
		}
	});

	it.each(["connection absence", "membership removal", "restart"] as const)(
		"releases replacement admission on %s",
		async (release) => {
			const module = await loadOwnerModule();
			vi.useFakeTimers();
			let fixture: ReservedCapacityFixture | undefined;
			let newcomer: ReturnType<typeof owner> | undefined;
			try {
				fixture = await reservedCapacityFixture(module, "peer-99");
				if (release === "connection absence") fixture.bus.disconnect(fixture.replacement);
				if (release === "membership removal") {
					await fixture.centerRoute.reconcile(fixture.admittedPeers.slice(0, -1));
				}
				if (release === "restart") {
					await fixture.centerRoute.restart();
					await vi.advanceTimersByTimeAsync(250);
					expect(fixture.centerRoute.snapshot().activeLinks).toBe(7);
				}

				newcomer = owner(module, fixture.bus, "peer-08");
				const newcomerRoute = newcomer.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
				fixture.bus.connect("peer-08", "peer-99");
				expect(await newcomerRoute.send(["peer-99"], Uint8Array.of(3))).toBe(true);
			} finally {
				newcomer?.owner.close();
				if (fixture !== undefined) closeInboundCapacityFixture(fixture);
				vi.useRealTimers();
			}
		}
	);

	it.each(["last route", "owner"] as const)("cancels the bounded admission timer on %s close", async (close) => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		let fixture: ReservedCapacityFixture | undefined;
		try {
			fixture = await reservedCapacityFixture(module, "peer-99");
			for (const route of fixture.remoteRoutes) route.close();
			expect(vi.getTimerCount()).toBe(1);
			if (close === "last route") fixture.centerRoute.close();
			else fixture.center.owner.close();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			if (fixture !== undefined) closeInboundCapacityFixture(fixture);
			vi.useRealTimers();
		}
	});

	it("rejects mapped-peer pending offers at the physical eight-PC ceiling", async () => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		const centerOptions: { hangAnswer?: boolean } = {};
		let fixture: InboundCapacityFixture | undefined;
		const offerSource = new FakePeerConnection();
		const attempts: Promise<"rejected" | "resolved">[] = [];
		try {
			fixture = await inboundCapacityFixture(module, "peer-99", centerOptions);
			centerOptions.hangAnswer = true;
			offerSource.createDataChannel(RAW_LABEL, { maxRetransmits: 0, ordered: false });
			const offer = await offerSource.createOffer();
			const validOffer = new TextEncoder().encode(JSON.stringify({ candidates: [], sdp: offer.sdp, type: "offer" }));
			const mappedConnection = fixture.pairs.at(-1)?.left;
			if (mappedConnection === undefined) throw new Error("mapped capacity peer connection missing");
			const allocatedBefore = fixture.center.peerConnections.length;
			for (let index = 0; index < 8; index += 1) {
				const attempt = mappedConnection.exchange(validOffer, new AbortController().signal);
				attempts.push(
					attempt.then(
						() => "resolved" as const,
						() => "rejected" as const
					)
				);
				await tick();
				expect(fixture.center.peerConnections).toHaveLength(allocatedBefore);
			}
			await expect(mappedConnection.exchange(validOffer, new AbortController().signal)).rejects.toThrow(
				"unreliable WebRTC signaling request rejected"
			);
			expect(fixture.center.peerConnections).toHaveLength(allocatedBefore);
			expect(await Promise.all(attempts)).toEqual(Array.from({ length: 8 }, () => "rejected"));
			expect(fixture.centerRoute.snapshot().activeLinks).toBe(8);
		} finally {
			offerSource.close();
			if (fixture !== undefined) closeInboundCapacityFixture(fixture);
			vi.useRealTimers();
		}
	});

	it("counts a non-open mapped sidecar toward the physical eight-PC ceiling", async () => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		const centerOptions: { hangAnswer?: boolean } = {};
		let fixture: InboundCapacityFixture | undefined;
		const offerSource = new FakePeerConnection();
		try {
			fixture = await inboundCapacityFixture(module, "peer-99", centerOptions);
			centerOptions.hangAnswer = true;
			offerSource.createDataChannel(RAW_LABEL, { maxRetransmits: 0, ordered: false });
			const offer = await offerSource.createOffer();
			const validOffer = new TextEncoder().encode(JSON.stringify({ candidates: [], sdp: offer.sdp, type: "offer" }));
			const mappedConnection = fixture.pairs.at(-1)?.left;
			const mappedChannel = fixture.center.peerConnections.at(-1)?.channels[0];
			if (mappedConnection === undefined || mappedChannel === undefined) {
				throw new Error("non-open mapped capacity fixture is incomplete");
			}
			mappedChannel.readyState = "closing";
			const allocatedBefore = fixture.center.peerConnections.length;

			const attempt = mappedConnection.exchange(validOffer, new AbortController().signal).then(
				() => "resolved" as const,
				(error: unknown) => (error instanceof Error ? error.message : "rejected")
			);
			await tick();
			expect(fixture.center.peerConnections).toHaveLength(allocatedBefore);
			expect(fixture.center.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(
				8
			);
			expect(await attempt).toBe("unreliable WebRTC signaling request rejected");
		} finally {
			offerSource.close();
			if (fixture !== undefined) closeInboundCapacityFixture(fixture);
			vi.useRealTimers();
		}
	});

	it("does not reserve admission when a non-replacement channel close drops a link", async () => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		let fixture: InboundCapacityFixture | undefined;
		let newcomer: ReturnType<typeof owner> | undefined;
		try {
			fixture = await inboundCapacityFixture(module, "peer-99");
			const droppedChannel = fixture.center.peerConnections.at(-1)?.channels[0];
			const droppedRemoteRoute = fixture.remoteRoutes.at(-1);
			if (droppedChannel === undefined || droppedRemoteRoute === undefined) {
				throw new Error("channel-close capacity fixture is incomplete");
			}
			droppedChannel.close();
			droppedRemoteRoute.close();
			expect(fixture.centerRoute.snapshot()).toMatchObject({
				activeLinks: 7,
				lastLinkDrop: "channel-close",
				linkDrops: 1,
			});

			newcomer = owner(module, fixture.bus, "peer-08");
			const newcomerRoute = newcomer.owner.openUnreliableWebRtcRoute("zone:capacity-owner");
			fixture.bus.connect("peer-08", "peer-99");
			expect(await newcomerRoute.send(["peer-99"], Uint8Array.of(8))).toBe(true);
			expect(fixture.centerRoute.snapshot()).toMatchObject({
				activeLinks: 8,
				links: expect.arrayContaining([expect.objectContaining({ peerId: "peer-08" })]),
			});
		} finally {
			newcomer?.owner.close();
			if (fixture !== undefined) closeInboundCapacityFixture(fixture);
			vi.useRealTimers();
		}
	});

	it("allows only one pending physical sidecar per authenticated peer", async () => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		const bus = new FakeSignalingBus();
		const lower = owner(module, bus, "peer-00");
		const higher = owner(module, bus, "peer-99", { hangAnswer: true });
		const pair = bus.connect("peer-00", "peer-99");
		higher.owner.openUnreliableWebRtcRoute("zone:pending-bound");
		const offerSource = new FakePeerConnection();
		offerSource.createDataChannel(RAW_LABEL, { maxRetransmits: 0, ordered: false });
		const offer = await offerSource.createOffer();
		const validOffer = new TextEncoder().encode(JSON.stringify({ candidates: [], sdp: offer.sdp, type: "offer" }));
		try {
			const first = pair.left.exchange(validOffer, new AbortController().signal).then(
				() => "resolved" as const,
				() => "rejected" as const
			);
			await tick();
			expect(higher.peerConnections).toHaveLength(1);
			const duplicate = pair.left.exchange(validOffer, new AbortController().signal).then(
				() => "resolved" as const,
				(error: unknown) => (error instanceof Error ? error.message : "rejected")
			);
			await tick();
			expect(higher.peerConnections).toHaveLength(1);
			expect(await duplicate).toBe("unreliable WebRTC signaling request rejected");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await first).toBe("rejected");
			expect(higher.peerConnections.every(({ connectionState }) => connectionState === "closed")).toBe(true);
		} finally {
			offerSource.close();
			lower.owner.close();
			higher.owner.close();
			vi.useRealTimers();
		}
	});

	it("closes routes independently, releases the last shared link, and reuses capacity", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const left = owner(module, bus, "peer-a");
		const right = owner(module, bus, "peer-b");
		bus.connect("peer-a", "peer-b");
		const leftAlpha = left.owner.openUnreliableWebRtcRoute("zone:alpha");
		const rightAlpha = right.owner.openUnreliableWebRtcRoute("zone:alpha");
		const leftBeta = left.owner.openUnreliableWebRtcRoute("zone:beta");
		const rightBeta = right.owner.openUnreliableWebRtcRoute("zone:beta");
		expect(await leftAlpha.send(["peer-b"], Uint8Array.of(1))).toBe(true);
		expect(await leftBeta.send(["peer-b"], Uint8Array.of(2))).toBe(true);
		expect(left.peerConnections).toHaveLength(1);

		leftAlpha.close();
		rightAlpha.close();
		expect(await leftAlpha.send(["peer-b"], Uint8Array.of(3))).toBe(false);
		expect(await leftBeta.send(["peer-b"], Uint8Array.of(4))).toBe(true);
		expect(leftBeta.snapshot().activeLinks).toBe(1);
		await leftBeta.restart();
		expect(left.peerConnections).toHaveLength(2);
		expect(await leftBeta.send(["peer-b"], Uint8Array.of(5))).toBe(true);

		leftBeta.close();
		rightBeta.close();
		expect(leftBeta.snapshot().activeLinks).toBe(0);
		expect(left.peerConnections[0]?.connectionState).toBe("closed");
		const leftGamma = left.owner.openUnreliableWebRtcRoute("zone:gamma");
		right.owner.openUnreliableWebRtcRoute("zone:gamma");
		expect(await leftGamma.send(["peer-b"], Uint8Array.of(6))).toBe(true);
		expect(left.peerConnections).toHaveLength(3);
		expect(leftGamma.snapshot().activeLinks).toBe(1);
	});

	it("preflights routed size, enforces SCTP/SDP/ICE bounds, and drops backpressure", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const left = owner(module, bus, "peer-a");
		owner(module, bus, "peer-b").owner.openUnreliableWebRtcRoute("zone:alpha");
		bus.connect("peer-a", "peer-b");
		const route = left.owner.openUnreliableWebRtcRoute("zone:alpha");
		expect(await route.send(["peer-b"], new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toBe(false);
		expect(left.peerConnections).toHaveLength(0);
		expect(await route.send(["peer-b"], new Uint8Array(MAX_PAYLOAD_BYTES))).toBe(true);
		expect(left.peerConnections[0]?.channels[0]?.sent.at(-1)).toHaveLength(MAX_ROUTED_ENVELOPE_BYTES);
		const channel = left.peerConnections[0]?.channels[0];
		if (channel === undefined) throw new Error("backpressure setup missing");
		channel.bufferedAmount = 65_537;
		expect(await route.send(["peer-b"], Uint8Array.of(2))).toBe(false);
		expect(route.snapshot().backpressuredDrops).toBe(1);
		expect(route.snapshot().activeLinks).toBe(1);
		await route.restart();
		expect(left.peerConnections).toHaveLength(2);
		expect(route.snapshot().activeLinks).toBe(1);
		expect(await route.send(["peer-b"], Uint8Array.of(3))).toBe(true);

		const replayBus = new FakeSignalingBus();
		const replayLeft = owner(module, replayBus, "peer-a");
		owner(module, replayBus, "peer-b").owner.openUnreliableWebRtcRoute("zone:backpressure-replay");
		replayBus.connect("peer-a", "peer-b");
		const replayRoute = replayLeft.owner.openUnreliableWebRtcRoute("zone:backpressure-replay");
		for (let sequence = 0; sequence < 554; sequence += 1) {
			expect(await replayRoute.send(["peer-b"], Uint8Array.of(sequence % 256)), `admitted ${sequence}`).toBe(true);
		}
		const replayChannel = replayLeft.peerConnections[0]?.channels[0];
		if (replayChannel === undefined) throw new Error("backpressure replay channel missing");
		replayChannel.bufferedAmount = 65_512;
		expect(await replayRoute.send(["peer-b"], new Uint8Array(398)), "admitted 554 at captured boundary").toBe(true);
		expect(replayChannel.sent.at(-1)).toHaveLength(431);
		replayChannel.bufferedAmount = 65_943;
		for (let sequence = 555; sequence < 600; sequence += 1) {
			expect(await replayRoute.send(["peer-b"], new Uint8Array(398)), `refused ${sequence}`).toBe(false);
		}
		expect(routedFrames(replayChannel)).toHaveLength(555);
		expect(replayRoute.snapshot()).toMatchObject({
			activeLinks: 1,
			backpressuredDrops: 45,
			handshakeFailures: 0,
			lastLinkDrop: undefined,
			linkDrops: 0,
			sent: 555,
		});

		for (const [name, leftOptions, rightOptions] of [
			["initiator small SCTP", { maxMessageSize: MAX_ROUTED_ENVELOPE_BYTES - 1 }, {}],
			["responder small SCTP", {}, { maxMessageSize: MAX_ROUTED_ENVELOPE_BYTES - 1 }],
			["offer candidate overflow", { candidateCount: 33 }, {}],
			["answer candidate overflow", {}, { candidateCount: 33 }],
			["offer SDP overflow", { sdpBytes: MAX_SDP_BYTES + 1 }, {}],
			["answer SDP overflow", {}, { sdpBytes: MAX_SDP_BYTES + 1 }],
		] as const) {
			const boundedBus = new FakeSignalingBus();
			const bounded = owner(module, boundedBus, "peer-a", leftOptions);
			owner(module, boundedBus, "peer-b", rightOptions).owner.openUnreliableWebRtcRoute("zone:alpha");
			boundedBus.connect("peer-a", "peer-b");
			const boundedRoute = bounded.owner.openUnreliableWebRtcRoute("zone:alpha");
			expect(await boundedRoute.send(["peer-b"], Uint8Array.of(1)), name).toBe(false);
			expect(boundedRoute.snapshot().handshakeFailures, name).toBe(1);
		}
	});

	it("fails malformed offers and answers independently", async () => {
		const module = await loadOwnerModule();
		for (const direction of ["offer", "answer"] as const) {
			const malformedBus = new FakeSignalingBus();
			if (direction === "offer") {
				malformedBus.requestTransform = (): Uint8Array => Uint8Array.of(255, 0, 255);
			} else {
				malformedBus.responseTransform = (): Uint8Array => Uint8Array.of(255, 0, 255);
			}
			const malformed = owner(module, malformedBus, "peer-a");
			owner(module, malformedBus, "peer-b").owner.openUnreliableWebRtcRoute("zone:alpha");
			malformedBus.connect("peer-a", "peer-b");
			const malformedRoute = malformed.owner.openUnreliableWebRtcRoute("zone:alpha");
			expect(await malformedRoute.send(["peer-b"], Uint8Array.of(1)), direction).toBe(false);
			expect(malformedRoute.snapshot().handshakeFailures, direction).toBe(1);
		}
	});

	it("applies one exact ten-second deadline to offer, answer, and signaling exchange", async () => {
		const module = await loadOwnerModule();
		vi.useFakeTimers();
		try {
			for (const stage of ["offer", "answer", "exchange"] as const) {
				const timeoutBus = new FakeSignalingBus();
				const barrier = stage === "exchange" ? timeoutBus.pauseResponses() : undefined;
				const timeout = owner(module, timeoutBus, "peer-a", { hangOffer: stage === "offer" });
				owner(module, timeoutBus, "peer-b", { hangAnswer: stage === "answer" }).owner.openUnreliableWebRtcRoute(
					"zone:alpha"
				);
				timeoutBus.connect("peer-a", "peer-b");
				const timeoutRoute = timeout.owner.openUnreliableWebRtcRoute("zone:alpha");
				const pending = timeoutRoute.send(["peer-b"], Uint8Array.of(1));
				if (barrier !== undefined) await barrier.waitUntilPending();
				await vi.advanceTimersByTimeAsync(9_999);
				expect(timeoutRoute.snapshot().handshakeFailures, stage).toBe(0);
				await vi.advanceTimersByTimeAsync(1);
				expect(await pending, stage).toBe(false);
				expect(timeoutRoute.snapshot().handshakeFailures, stage).toBe(1);
				barrier?.release();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains the established raw link while its authenticated connection remains current beside an overlapping connection", async () => {
		const module = await loadOwnerModule();
		for (const [name, establishedIds, overlappingIds] of [
			[
				"overlap sorts before established",
				{ left: "z-established-left", right: "z-established-right" },
				{ left: "a-overlap-left", right: "a-overlap-right" },
			],
			[
				"established sorts before overlap",
				{ left: "a-established-left", right: "a-established-right" },
				{ left: "z-overlap-left", right: "z-overlap-right" },
			],
		] as const) {
			const bus = new FakeSignalingBus();
			const left = owner(module, bus, "peer-a");
			const right = owner(module, bus, "peer-b");
			try {
				const established = bus.connect("peer-a", "peer-b", "webrtc", establishedIds);
				const leftRoute = left.owner.openUnreliableWebRtcRoute("zone:alpha");
				const rightRoute = right.owner.openUnreliableWebRtcRoute("zone:alpha");
				const received: Uint8Array[] = [];
				rightRoute.onMessage(({ bytes }) => received.push(bytes.slice()));
				await Promise.all([leftRoute.reconcile(["peer-b"]), rightRoute.reconcile(["peer-a"])]);
				expect(leftRoute.snapshot(), name).toMatchObject({
					activeLinks: 1,
					lastLinkDrop: undefined,
					linkDrops: 0,
					links: [{ connectionId: established.left.id, generation: established.left.generation }],
				});

				bus.connect("peer-a", "peer-b", "webrtc", overlappingIds);
				expect(left.signaling.connections(), name).toHaveLength(2);
				expect(right.signaling.connections(), name).toHaveLength(2);
				expect(await leftRoute.send(["peer-b"], Uint8Array.of(7)), name).toBe(true);
				await tick();
				expect(received, name).toEqual([Uint8Array.of(7)]);
				expect(leftRoute.snapshot(), name).toMatchObject({
					activeLinks: 1,
					lastLinkDrop: undefined,
					linkDrops: 0,
					links: [{ connectionId: established.left.id, generation: established.left.generation }],
				});

				await leftRoute.reconcile(["peer-b"]);
				expect(leftRoute.snapshot(), name).toMatchObject({
					activeLinks: 1,
					lastLinkDrop: undefined,
					linkDrops: 0,
					links: [{ connectionId: established.left.id, generation: established.left.generation }],
				});
				expect(left.peerConnections, name).toHaveLength(1);
				expect(right.peerConnections, name).toHaveLength(1);
			} finally {
				left.owner.close();
				right.owner.close();
			}
		}
	});

	it("D.108e4au separates pending controls from routed application ingress", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4au-control-separation");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4au-control-separation");
			const lowReceived: Uint8Array[] = [];
			const highReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			await tick();

			FakeDataChannel.dropNextControl(2, 2);
			bus.disconnect(original);
			bus.connect("peer-a", "peer-b");
			await lowRoute.reconcile(["peer-b"]);
			await tick();
			await tick();
			const replacementLow = low.peerConnections[1]?.channels[0];
			const replacementHigh = high.peerConnections[1]?.channels[0];
			if (replacementLow === undefined || replacementHigh === undefined) {
				throw new Error("control-separation replacement missing");
			}

			const routed = new Uint8Array(ROUTE_HEADER_BYTES + 1);
			routed[0] = 1;
			routed.set(routeDigest("zone:d108e4au-control-separation"), 1);
			routed[ROUTE_HEADER_BYTES] = 91;
			replacementHigh.send(Uint8Array.of(0x45, 0x52, 0x01, 0x02));
			replacementHigh.send(Uint8Array.of(0x44, 0x52, 0x02, 0x02));
			replacementHigh.send(Uint8Array.of(0x44, 0x52, 0x01, 0x04));
			replacementHigh.send(Uint8Array.of(0x44, 0x52, 0x01));
			replacementHigh.send(Uint8Array.of(0x44, 0x52, 0x01, 0x02, 0x00));
			replacementHigh.send(REPLACEMENT_READY);
			replacementHigh.send(REPLACEMENT_READY);
			replacementHigh.send(REPLACEMENT_COMMIT);
			replacementHigh.send(routed);
			await tick();
			await tick();

			expect(lowReceived).toEqual([]);
			expect(highReceived).toEqual([]);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				received: 0,
				routedBytesReceived: 0,
				unknownRouteDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
			expect(highRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				received: 0,
				routedBytesReceived: 0,
				unknownRouteDrops: 0,
				links: [{ connectionId: original.right.id, generation: original.right.generation }],
			});
		} finally {
			FakeDataChannel.clearControlDrops();
			low.owner.close();
			high.owner.close();
		}
	});

	it.each([
		["initiator", "peer-b"],
		["non-initiator", "peer-a"],
	] as const)(
		"keeps the exact old raw link usable until its authenticated replacement opens as the %s",
		async (role, remotePeerId) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			let pending: Promise<void> | undefined;
			let barrier: FakeRemoteInboundOpenBarrier | undefined;
			let closeEventBarrier: FakeInboundOpenBarrier | undefined;
			let messageBarrier: FakeInboundOpenBarrier | undefined;
			let peerCloseBarrier: FakeInboundOpenBarrier | undefined;
			let retiringSend: Promise<boolean> | undefined;
			try {
				const local = role === "initiator" ? low : high;
				const original = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:alpha");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:alpha");
				const localRoute = role === "initiator" ? lowRoute : highRoute;
				const lowReceived: Uint8Array[] = [];
				const highReceived: Uint8Array[] = [];
				lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
				highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				expect(localRoute.snapshot()).toMatchObject({ activeLinks: 1, lastLinkDrop: undefined, linkDrops: 0 });
				expect(await localRoute.send([remotePeerId], Uint8Array.of(6))).toBe(true);
				await tick();
				expect(lowReceived).toEqual(role === "non-initiator" ? [Uint8Array.of(6)] : []);
				expect(highReceived).toEqual(role === "initiator" ? [Uint8Array.of(6)] : []);
				const oldConnection = localRoute.snapshot().links[0];
				if (oldConnection === undefined) throw new Error("old raw link missing");

				bus.disconnect(original);
				const replacement = bus.connect("peer-a", "peer-b");
				barrier = FakePeerConnection.pauseNextRemoteInboundOpen();
				if (role === "initiator") {
					pending = localRoute.reconcile([remotePeerId]);
				} else {
					await localRoute.reconcile([remotePeerId]);
					pending = lowRoute.reconcile(["peer-b"]);
				}
				await barrier.waitUntilPending();
				expect(local.peerConnections[0]?.connectionState).toBe("connected");
				expect(localRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					lastLinkDrop: undefined,
					linkDrops: 0,
					links: [{ connectionId: oldConnection.connectionId, generation: oldConnection.generation }],
					sent: 1,
				});
				expect(await localRoute.send([remotePeerId], Uint8Array.of(7))).toBe(true);
				await tick();
				expect(lowReceived).toEqual(role === "non-initiator" ? [Uint8Array.of(6), Uint8Array.of(7)] : []);
				expect(highReceived).toEqual(role === "initiator" ? [Uint8Array.of(6), Uint8Array.of(7)] : []);

				const oldUpperSender = high.peerConnections[0]?.channels[0];
				const oldLowerReceiver = low.peerConnections[0]?.channels[0];
				if (oldUpperSender === undefined || oldLowerReceiver === undefined) {
					throw new Error("retiring-ingress channels are missing");
				}
				closeEventBarrier = oldUpperSender.pauseCloseEvent();
				peerCloseBarrier = oldUpperSender.pausePeerClose();

				barrier.release();
				await pending;
				await barrier.waitUntilComplete();
				await Promise.all([closeEventBarrier.waitUntilPending(), peerCloseBarrier.waitUntilPending()]);
				expect(lowRoute.snapshot().links).toEqual([
					expect.objectContaining({ connectionId: original.left.id, generation: original.left.generation }),
				]);
				expect(highRoute.snapshot().links).toEqual([
					expect.objectContaining({ connectionId: replacement.right.id, generation: replacement.right.generation }),
				]);
				expect(low.peerConnections[0]?.connectionState).toBe("connected");

				messageBarrier = oldLowerReceiver.pauseNextMessage();
				retiringSend = lowRoute.send(["peer-b"], Uint8Array.of(8));
				expect(await retiringSend).toBe(true);
				await messageBarrier.waitUntilPending();
				messageBarrier.release();
				await tick();
				expect(highReceived).toEqual(
					role === "initiator" ? [Uint8Array.of(6), Uint8Array.of(7), Uint8Array.of(8)] : [Uint8Array.of(8)]
				);
				closeEventBarrier.release();
				await tick();
				expect(high.peerConnections[0]?.connectionState).toBe("closed");
				peerCloseBarrier.release();
				await tick();
				const localReplacement = role === "initiator" ? replacement.left : replacement.right;
				await vi.waitFor(() =>
					expect(localRoute.snapshot()).toMatchObject({
						activeLinks: 1,
						lastLinkDrop: role === "initiator" ? "channel-close" : "replacement",
						linkDrops: 1,
						links: [{ connectionId: localReplacement.id, generation: localReplacement.generation }],
					})
				);
				expect(await localRoute.send([remotePeerId], Uint8Array.of(9))).toBe(true);
				await tick();
				expect(lowReceived).toEqual(
					role === "non-initiator" ? [Uint8Array.of(6), Uint8Array.of(7), Uint8Array.of(9)] : []
				);
				expect(highReceived).toEqual(
					role === "initiator"
						? [Uint8Array.of(6), Uint8Array.of(7), Uint8Array.of(8), Uint8Array.of(9)]
						: [Uint8Array.of(8)]
				);
			} finally {
				messageBarrier?.release();
				closeEventBarrier?.release();
				peerCloseBarrier?.release();
				FakePeerConnection.releaseRemoteInboundOpenBarrier(barrier);
				await pending?.catch(() => undefined);
				low.owner.close();
				high.owner.close();
			}
		}
	);

	it("D.108e4bi promotes a handshake-qualified pending initiator from peer application proof", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		let openBarrier: FakeRemoteInboundOpenBarrier | undefined;
		let closeEventBarrier: FakeInboundOpenBarrier | undefined;
		let peerCloseBarrier: FakeInboundOpenBarrier | undefined;
		let replacementPending: Promise<void> | undefined;
		try {
			const routeId = "zone:d108e4bi-application-proof";
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute(routeId);
			const highRoute = high.owner.openUnreliableWebRtcRoute(routeId);
			const lowReceived: Uint8Array[] = [];
			const highReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

			bus.disconnect(original);
			const replacement = bus.connect("peer-a", "peer-b");
			openBarrier = FakePeerConnection.pauseNextRemoteInboundOpen();
			replacementPending = lowRoute.reconcile(["peer-b"]);
			await openBarrier.waitUntilPending();
			await replacementPending;

			const oldHigh = high.peerConnections[0]?.channels[0];
			const replacementLow = low.peerConnections[1]?.channels[0];
			const replacementHigh = high.peerConnections[1]?.channels[0];
			if (oldHigh === undefined || replacementLow === undefined || replacementHigh === undefined) {
				throw new Error("D108E4BI_OWNER_ABSENT");
			}
			closeEventBarrier = oldHigh.pauseCloseEvent();
			peerCloseBarrier = oldHigh.pausePeerClose();

			openBarrier.release();
			await openBarrier.waitUntilComplete();
			await Promise.all([closeEventBarrier.waitUntilPending(), peerCloseBarrier.waitUntilPending()]);
			await tick();

			expect(controlFrames(replacementLow).filter((bytes) => bytes[3] === 1).length).toBeGreaterThanOrEqual(1);
			expect(controlFrames(replacementLow).filter((bytes) => bytes[3] === 3).length).toBeGreaterThanOrEqual(1);
			expect(controlFrames(replacementHigh).filter((bytes) => bytes[3] === 2).length).toBeGreaterThanOrEqual(1);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
			expect(highRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: "replacement",
				linkDrops: 1,
				links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
			});
			replacementHigh.send(Uint8Array.of(1, 2, 3));
			replacementHigh.send(routedFrame("zone:d108e4bi-unknown", Uint8Array.of(80)));
			await tick();
			await tick();
			expect(lowReceived).toEqual([]);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				received: 0,
				unknownRouteDrops: 1,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});

			expect(await highRoute.send(["peer-a"], Uint8Array.of(81))).toBe(true);
			await tick();
			await tick();

			expect(lowReceived).toEqual([Uint8Array.of(81)]);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: "replacement",
				linkDrops: 1,
				received: 1,
				routedBytesReceived: ROUTE_HEADER_BYTES + 1,
				links: [{ connectionId: replacement.left.id, generation: replacement.left.generation }],
			});
			expect(await lowRoute.send(["peer-b"], Uint8Array.of(82))).toBe(true);
			await tick();
			expect(highReceived).toEqual([Uint8Array.of(82)]);
		} finally {
			closeEventBarrier?.release();
			peerCloseBarrier?.release();
			FakePeerConnection.releaseRemoteInboundOpenBarrier(openBarrier);
			await replacementPending?.catch(() => undefined);
			low.owner.close();
			high.owner.close();
		}
	});

	it("D.108e4bl retains handshake-qualified B while old-A close is delayed and application traffic is idle", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		let openBarrier: FakeRemoteInboundOpenBarrier | undefined;
		let closeEventBarrier: FakeInboundOpenBarrier | undefined;
		let peerCloseBarrier: FakeInboundOpenBarrier | undefined;
		let replacementPending: Promise<void> | undefined;
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4bl-idle-qualified-replacement");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4bl-idle-qualified-replacement");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

			bus.disconnect(original);
			const replacement = bus.connect("peer-a", "peer-b");
			openBarrier = FakePeerConnection.pauseNextRemoteInboundOpen();
			vi.useFakeTimers();
			replacementPending = lowRoute.reconcile(["peer-b"]);
			await openBarrier.waitUntilPending();
			await replacementPending;

			const oldHigh = high.peerConnections[0]?.channels[0];
			const replacementLow = low.peerConnections[1]?.channels[0];
			const replacementHigh = high.peerConnections[1]?.channels[0];
			if (oldHigh === undefined || replacementLow === undefined || replacementHigh === undefined) {
				throw new Error("D108E4BL_OWNER_ABSENT");
			}
			closeEventBarrier = oldHigh.pauseCloseEvent();
			peerCloseBarrier = oldHigh.pausePeerClose();

			openBarrier.release();
			await openBarrier.waitUntilComplete();
			await Promise.all([closeEventBarrier.waitUntilPending(), peerCloseBarrier.waitUntilPending()]);
			await tick();

			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
			expect(highRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: "replacement",
				linkDrops: 1,
				links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
			});
			expect(replacementLow.readyState).toBe("open");
			expect(replacementHigh.readyState).toBe("open");

			await vi.advanceTimersByTimeAsync(9_999);
			expect(replacementLow.readyState).toBe("open");
			expect(replacementHigh.readyState).toBe("open");
			await vi.advanceTimersByTimeAsync(1);
			await tick();

			const lowAfterDeadline = lowRoute.snapshot();
			const highAfterDeadline = highRoute.snapshot();
			if (
				replacementLow.readyState !== "open" ||
				replacementHigh.readyState !== "open" ||
				lowAfterDeadline.linkDrops !== 0 ||
				highAfterDeadline.linkDrops !== 1
			) {
				throw new Error(
					`D108E4BL_QUALIFIED_B_EXPIRED:${JSON.stringify({
						high: highAfterDeadline,
						low: lowAfterDeadline,
						replacementHigh: replacementHigh.readyState,
						replacementLow: replacementLow.readyState,
					})}`
				);
			}
			expect(lowAfterDeadline).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
			expect(highAfterDeadline).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: "replacement",
				linkDrops: 1,
				links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
			});
		} finally {
			closeEventBarrier?.release();
			peerCloseBarrier?.release();
			FakePeerConnection.releaseRemoteInboundOpenBarrier(openBarrier);
			await replacementPending?.catch(() => undefined);
			low.owner.close();
			high.owner.close();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("D.108e4bi rejects application ingress before pending replacement qualification", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		try {
			const routeId = "zone:d108e4bi-unqualified";
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute(routeId);
			const highRoute = high.owner.openUnreliableWebRtcRoute(routeId);
			const lowReceived: Uint8Array[] = [];
			const highReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

			FakeDataChannel.dropNextControl(2, 2);
			bus.disconnect(original);
			bus.connect("peer-a", "peer-b");
			await lowRoute.reconcile(["peer-b"]);
			await tick();
			await tick();
			const replacementLow = low.peerConnections[1]?.channels[0];
			const replacementHigh = high.peerConnections[1]?.channels[0];
			if (replacementLow === undefined || replacementHigh === undefined) {
				throw new Error("D108E4BI_UNQUALIFIED_OWNER_ABSENT");
			}

			replacementHigh.send(routedFrame(routeId, Uint8Array.of(83)));
			replacementLow.send(routedFrame(routeId, Uint8Array.of(84)));
			await tick();
			await tick();

			expect(lowReceived).toEqual([]);
			expect(highReceived).toEqual([]);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				received: 0,
				unknownRouteDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
			expect(highRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				received: 0,
				unknownRouteDrops: 0,
				links: [{ connectionId: original.right.id, generation: original.right.generation }],
			});
		} finally {
			FakeDataChannel.clearControlDrops();
			low.owner.close();
			high.owner.close();
		}
	});

	it("D.108e4bi rejects application proof from a stale authenticated replacement", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		let openBarrier: FakeRemoteInboundOpenBarrier | undefined;
		let closeEventBarrier: FakeInboundOpenBarrier | undefined;
		let peerCloseBarrier: FakeInboundOpenBarrier | undefined;
		try {
			const routeId = "zone:d108e4bi-stale";
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute(routeId);
			const highRoute = high.owner.openUnreliableWebRtcRoute(routeId);
			const lowReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

			bus.disconnect(original);
			const replacement = bus.connect("peer-a", "peer-b");
			openBarrier = FakePeerConnection.pauseNextRemoteInboundOpen();
			const replacementPending = lowRoute.reconcile(["peer-b"]);
			await openBarrier.waitUntilPending();
			await replacementPending;
			const oldHigh = high.peerConnections[0]?.channels[0];
			const replacementHigh = high.peerConnections[1]?.channels[0];
			if (oldHigh === undefined || replacementHigh === undefined) throw new Error("D108E4BI_STALE_OWNER_ABSENT");
			closeEventBarrier = oldHigh.pauseCloseEvent();
			peerCloseBarrier = oldHigh.pausePeerClose();

			openBarrier.release();
			await openBarrier.waitUntilComplete();
			await Promise.all([closeEventBarrier.waitUntilPending(), peerCloseBarrier.waitUntilPending()]);
			await tick();
			expect(lowRoute.snapshot().links).toEqual([
				expect.objectContaining({ connectionId: original.left.id, generation: original.left.generation }),
			]);

			bus.forgetWithoutClose(replacement);
			replacementHigh.send(routedFrame(routeId, Uint8Array.of(85)));
			await tick();
			await tick();

			expect(lowReceived).toEqual([]);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				received: 0,
				unknownRouteDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
		} finally {
			closeEventBarrier?.release();
			peerCloseBarrier?.release();
			FakePeerConnection.releaseRemoteInboundOpenBarrier(openBarrier);
			low.owner.close();
			high.owner.close();
		}
	});

	it.each(["initiator", "non-initiator"] as const)(
		"D.108e4at keeps A until remote B is ready with the %s application sender",
		async (senderRole) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			let barrier: FakeRemoteInboundOpenBarrier | undefined;
			let replacementPending: Promise<void> | undefined;
			try {
				const original = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4at-remote-readiness");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4at-remote-readiness");
				const lowReceived: Uint8Array[] = [];
				const highReceived: Uint8Array[] = [];
				lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
				highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

				const oldLow = low.peerConnections[0]?.channels[0];
				const oldHigh = high.peerConnections[0]?.channels[0];
				if (oldLow === undefined || oldHigh === undefined) throw new Error("D108E4AT_OLD_OWNER_ABSENT");
				const applicationSender = senderRole === "initiator" ? lowRoute : highRoute;
				const remotePeerId = senderRole === "initiator" ? "peer-b" : "peer-a";
				expect(await applicationSender.send([remotePeerId], Uint8Array.of(71)), senderRole).toBe(true);
				await tick();
				expect(lowReceived, senderRole).toEqual(senderRole === "non-initiator" ? [Uint8Array.of(71)] : []);
				expect(highReceived, senderRole).toEqual(senderRole === "initiator" ? [Uint8Array.of(71)] : []);

				bus.disconnect(original);
				const replacement = bus.connect("peer-a", "peer-b");
				barrier = FakePeerConnection.pauseNextRemoteInboundOpen();
				replacementPending = lowRoute.reconcile(["peer-b"]);
				await barrier.waitUntilPending();
				await replacementPending;
				await tick();

				const replacementLow = low.peerConnections[1]?.channels[0];
				const replacementHigh = high.peerConnections[1]?.channels[0];
				if (replacementLow === undefined || replacementHigh === undefined) {
					throw new Error("D108E4AT_REPLACEMENT_OWNER_ABSENT");
				}
				expect(replacementLow.readyState, senderRole).toBe("open");
				expect(replacementHigh.readyState, senderRole).toBe("connecting");
				expect(replacementHigh.listenerCount("message"), senderRole).toBe(0);
				expect(replacementHigh.openEvents, senderRole).toBe(0);
				expect(lowRoute.snapshot(), senderRole).toMatchObject({
					activeLinks: 1,
					lastLinkDrop: undefined,
					linkDrops: 0,
					links: [{ connectionId: original.left.id, generation: original.left.generation }],
				});
				expect(highRoute.snapshot(), senderRole).toMatchObject({
					activeLinks: 1,
					lastLinkDrop: undefined,
					linkDrops: 0,
					links: [{ connectionId: original.right.id, generation: original.right.generation }],
				});
				expect(oldLow.closeTransitions, senderRole).toBe(0);
				expect(oldHigh.closeTransitions, senderRole).toBe(0);
				expect(oldLow.closeEvents, senderRole).toBe(0);
				expect(oldHigh.closeEvents, senderRole).toBe(0);
				expect(low.peerConnections, senderRole).toHaveLength(2);
				expect(high.peerConnections, senderRole).toHaveLength(2);
				expect(await applicationSender.send([remotePeerId], Uint8Array.of(72)), senderRole).toBe(true);
				await tick();
				expect(lowReceived, senderRole).toEqual(
					senderRole === "non-initiator" ? [Uint8Array.of(71), Uint8Array.of(72)] : []
				);
				expect(highReceived, senderRole).toEqual(
					senderRole === "initiator" ? [Uint8Array.of(71), Uint8Array.of(72)] : []
				);

				// This models delayed peer readiness generically; it does not claim Chrome kept B in "connecting".
				barrier.release();
				await barrier.waitUntilComplete();
				await vi.waitFor(() => {
					expect(lowRoute.snapshot(), senderRole).toMatchObject({
						activeLinks: 1,
						lastLinkDrop: "channel-close",
						linkDrops: 1,
						links: [{ connectionId: replacement.left.id, generation: replacement.left.generation }],
					});
					expect(highRoute.snapshot(), senderRole).toMatchObject({
						activeLinks: 1,
						lastLinkDrop: "replacement",
						linkDrops: 1,
						links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
					});
				});
				expect(oldLow.closeTransitions, senderRole).toBe(1);
				expect(oldHigh.closeTransitions, senderRole).toBe(1);
				expect(oldLow.closeEvents, senderRole).toBe(1);
				expect(oldHigh.closeEvents, senderRole).toBe(1);
				expect(low.peerConnections, senderRole).toHaveLength(2);
				expect(high.peerConnections, senderRole).toHaveLength(2);
				expect(await applicationSender.send([remotePeerId], Uint8Array.of(73)), senderRole).toBe(true);
				await tick();
				expect(lowReceived, senderRole).toEqual(
					senderRole === "non-initiator" ? [Uint8Array.of(71), Uint8Array.of(72), Uint8Array.of(73)] : []
				);
				expect(highReceived, senderRole).toEqual(
					senderRole === "initiator" ? [Uint8Array.of(71), Uint8Array.of(72), Uint8Array.of(73)] : []
				);
			} finally {
				FakePeerConnection.releaseRemoteInboundOpenBarrier(barrier);
				await replacementPending?.catch(() => undefined);
				low.owner.close();
				high.owner.close();
			}
		}
	);

	it("D.108e4au tolerates COMMIT racing ahead of the bounded READY response", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		let openBarrier: FakeRemoteInboundOpenBarrier | undefined;
		let readyBarrier: FakeInboundOpenBarrier | undefined;
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4au-control-reorder");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4au-control-reorder");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			await tick();
			bus.disconnect(original);
			const replacement = bus.connect("peer-a", "peer-b");
			openBarrier = FakePeerConnection.pauseNextRemoteInboundOpen();
			const pending = lowRoute.reconcile(["peer-b"]);
			await openBarrier.waitUntilPending();
			await pending;
			const replacementLow = low.peerConnections[1]?.channels[0];
			if (replacementLow === undefined) throw new Error("reordered control replacement missing");
			readyBarrier = replacementLow.pauseNextMessage();

			openBarrier.release();
			await readyBarrier.waitUntilPending();
			await tick();
			expect(lowRoute.snapshot().links[0]).toMatchObject({ connectionId: original.left.id });
			expect(highRoute.snapshot().links[0]).toMatchObject({ connectionId: original.right.id });

			readyBarrier.release();
			await vi.waitFor(() => {
				expect(lowRoute.snapshot().links[0]).toMatchObject({ connectionId: replacement.left.id });
				expect(highRoute.snapshot().links[0]).toMatchObject({ connectionId: replacement.right.id });
			});
			const replacementHigh = high.peerConnections[1]?.channels[0];
			if (replacementHigh === undefined) throw new Error("reordered control peer replacement missing");
			expect(controlFrames(replacementLow).filter((bytes) => bytes[3] === 1).length).toBeLessThanOrEqual(2);
			expect(controlFrames(replacementLow).filter((bytes) => bytes[3] === 3)).toHaveLength(2);
			expect(controlFrames(replacementHigh).filter((bytes) => bytes[3] === 2).length).toBeLessThanOrEqual(2);
			replacementHigh.send(REPLACEMENT_ACK);
			replacementHigh.send(REPLACEMENT_ACK);
			replacementLow.send(REPLACEMENT_READY);
			replacementLow.send(REPLACEMENT_READY);
			await tick();
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				linkDrops: 1,
				links: [{ connectionId: replacement.left.id, generation: replacement.left.generation }],
			});
			expect(highRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				linkDrops: 1,
				links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
			});
		} finally {
			readyBarrier?.release();
			FakePeerConnection.releaseRemoteInboundOpenBarrier(openBarrier);
			low.owner.close();
			high.owner.close();
		}
	});

	it.each(["initiator-first", "acceptor-first"] as const)(
		"D.108e4au converges after the %s replacement open ordering",
		async (ordering) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			let barrier: FakeRemoteInboundOpenBarrier | undefined;
			try {
				const original = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4au-open-ordering");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4au-open-ordering");
				const lowReceived: Uint8Array[] = [];
				const highReceived: Uint8Array[] = [];
				lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
				highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

				bus.disconnect(original);
				const replacement = bus.connect("peer-a", "peer-b");
				barrier =
					ordering === "initiator-first"
						? FakePeerConnection.pauseNextRemoteInboundOpen()
						: FakePeerConnection.pauseNextInitiatorOutboundOpen();
				const pending = lowRoute.reconcile(["peer-b"]);
				await barrier.waitUntilPending();
				expect(lowRoute.snapshot().links[0], ordering).toMatchObject({ connectionId: original.left.id });
				expect(highRoute.snapshot().links[0], ordering).toMatchObject({ connectionId: original.right.id });

				barrier.release();
				await barrier.waitUntilComplete();
				await pending;
				await vi.waitFor(() => {
					expect(lowRoute.snapshot().links[0], ordering).toMatchObject({ connectionId: replacement.left.id });
					expect(highRoute.snapshot().links[0], ordering).toMatchObject({ connectionId: replacement.right.id });
				});
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(101)), ordering).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(102)), ordering).toBe(true);
				await tick();
				expect(lowReceived.at(-1), ordering).toEqual(Uint8Array.of(102));
				expect(highReceived.at(-1), ordering).toEqual(Uint8Array.of(101));
			} finally {
				FakePeerConnection.releaseRemoteInboundOpenBarrier(barrier);
				FakePeerConnection.releaseInitiatorOutboundOpenBarrier(barrier);
				low.owner.close();
				high.owner.close();
			}
		}
	);

	it.each([
		[1, "READY"],
		[2, "ACK"],
		[3, "COMMIT"],
	] as const)("D.108e4au retains usable A when both bounded %s controls are lost", async (controlKind, name) => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4au-control-loss");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4au-control-loss");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			await tick();
			await tick();

			vi.useFakeTimers();
			FakeDataChannel.dropNextControl(controlKind, 2);
			bus.disconnect(original);
			bus.connect("peer-a", "peer-b");
			await lowRoute.reconcile(["peer-b"]);
			await tick();
			await tick();
			await tick();

			expect(lowRoute.snapshot(), name).toMatchObject({
				activeLinks: 1,
				handshakeFailures: 0,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
			expect(highRoute.snapshot(), name).toMatchObject({
				activeLinks: 1,
				handshakeFailures: 0,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.right.id, generation: original.right.generation }],
			});
			expect(low.peerConnections, name).toHaveLength(2);
			expect(high.peerConnections, name).toHaveLength(2);

			await vi.advanceTimersByTimeAsync(9_999);
			expect(lowRoute.snapshot().links[0], name).toMatchObject({ connectionId: original.left.id });
			expect(highRoute.snapshot().links[0], name).toMatchObject({ connectionId: original.right.id });
			await vi.advanceTimersByTimeAsync(1);
			await tick();
			expect(lowRoute.snapshot(), name).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
			expect(highRoute.snapshot(), name).toMatchObject({
				activeLinks: 1,
				handshakeFailures: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.right.id, generation: original.right.generation }],
			});
			expect(low.peerConnections, name).toHaveLength(2);
			expect(high.peerConnections, name).toHaveLength(2);
			expect(low.peerConnections[1]?.connectionState, name).toBe("closed");
			expect(high.peerConnections[1]?.connectionState, name).toBe("closed");
			await vi.advanceTimersByTimeAsync(249);
			expect(low.peerConnections, name).toHaveLength(2);
			expect(high.peerConnections, name).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			await vi.waitFor(() => {
				expect(low.peerConnections, name).toHaveLength(3);
				expect(high.peerConnections, name).toHaveLength(3);
			});
		} finally {
			FakeDataChannel.clearControlDrops();
			vi.useRealTimers();
			low.owner.close();
			high.owner.close();
		}
	});

	it.each(["initiator", "acceptor"] as const)(
		"D.108e4au expires held B and retries after asymmetric %s prior activation",
		async (priorRole) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const originalLow = owner(module, bus, "peer-a");
			const originalHigh = owner(module, bus, "peer-b");
			const originalLowRoute = originalLow.owner.openUnreliableWebRtcRoute("zone:d108e4au-asymmetric-expiry");
			const originalHighRoute = originalHigh.owner.openUnreliableWebRtcRoute("zone:d108e4au-asymmetric-expiry");
			let freshLow: ReturnType<typeof owner> | undefined;
			let freshHigh: ReturnType<typeof owner> | undefined;
			try {
				bus.connect("peer-a", "peer-b");
				await Promise.all([originalLowRoute.reconcile(["peer-b"]), originalHighRoute.reconcile(["peer-a"])]);
				if (priorRole === "initiator") {
					originalHigh.owner.close();
					freshHigh = owner(module, bus, "peer-b");
					freshHigh.owner.openUnreliableWebRtcRoute("zone:d108e4au-asymmetric-expiry");
					FakeDataChannel.dropNextControl(2, 2);
				} else {
					originalLow.owner.close();
					freshLow = owner(module, bus, "peer-a");
					freshLow.owner.openUnreliableWebRtcRoute("zone:d108e4au-asymmetric-expiry");
					FakeDataChannel.dropNextControl(1, 2);
				}

				vi.useFakeTimers();
				const initiatingRoute =
					priorRole === "initiator"
						? originalLowRoute
						: freshLow?.owner.openUnreliableWebRtcRoute("zone:d108e4au-asymmetric-expiry-trigger");
				if (initiatingRoute === undefined) throw new Error("asymmetric initiating route missing");
				await initiatingRoute.reconcile(["peer-b"]);
				await tick();
				await tick();

				const heldOwner = priorRole === "initiator" ? originalLow : originalHigh;
				const freshOwner = priorRole === "initiator" ? freshHigh : freshLow;
				if (freshOwner === undefined) throw new Error("asymmetric fresh owner missing");
				expect(heldOwner.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(1);
				expect(freshOwner.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(
					1
				);

				await vi.advanceTimersByTimeAsync(9_999);
				expect(heldOwner.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(1);
				await vi.advanceTimersByTimeAsync(1);
				await tick();
				const heldRoute = priorRole === "initiator" ? originalLowRoute : originalHighRoute;
				expect(heldRoute.snapshot(), priorRole).toMatchObject({ activeLinks: 0, handshakeFailures: 1 });
				expect(
					heldOwner.peerConnections.filter(({ connectionState }) => connectionState !== "closed"),
					priorRole
				).toHaveLength(0);
				expect(
					freshOwner.peerConnections.filter(({ connectionState }) => connectionState !== "closed"),
					priorRole
				).toHaveLength(0);

				const heldAllocations = heldOwner.peerConnections.length;
				const freshAllocations = freshOwner.peerConnections.length;
				await vi.advanceTimersByTimeAsync(249);
				expect(heldOwner.peerConnections, priorRole).toHaveLength(heldAllocations);
				expect(freshOwner.peerConnections, priorRole).toHaveLength(freshAllocations);
				await vi.advanceTimersByTimeAsync(1);
				await vi.waitFor(() => {
					expect(heldOwner.peerConnections, priorRole).toHaveLength(heldAllocations + 1);
					expect(freshOwner.peerConnections, priorRole).toHaveLength(freshAllocations + 1);
				});
			} finally {
				FakeDataChannel.clearControlDrops();
				vi.useRealTimers();
				freshLow?.owner.close();
				freshHigh?.owner.close();
				originalLow.owner.close();
				originalHigh.owner.close();
			}
		}
	);

	it("D.108e4au discards a replacement control-send failure without a spurious link drop", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4au-control-send-failure");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4au-control-send-failure");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

			vi.useFakeTimers();
			FakeDataChannel.throwNextControl(1, 1);
			bus.disconnect(original);
			bus.connect("peer-a", "peer-b");
			await lowRoute.reconcile(["peer-b"]);
			await tick();

			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				handshakeFailures: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.left.id, generation: original.left.generation }],
			});
			expect(highRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: original.right.id, generation: original.right.generation }],
			});
			expect(low.peerConnections[1]?.connectionState).toBe("closed");
			expect(high.peerConnections[1]?.connectionState).toBe("closed");

			await vi.advanceTimersByTimeAsync(249);
			expect(low.peerConnections).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			await vi.waitFor(() => {
				expect(low.peerConnections).toHaveLength(3);
				expect(high.peerConnections).toHaveLength(3);
			});
		} finally {
			FakeDataChannel.clearControlDrops();
			vi.useRealTimers();
			low.owner.close();
			high.owner.close();
		}
	});

	it("D.108e4au rejects stale-generation controls before replacing held B with current C", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4au-held-generation");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4au-held-generation");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

			FakeDataChannel.dropNextControl(2, 2);
			bus.disconnect(original);
			const stale = bus.connect("peer-a", "peer-b");
			await lowRoute.reconcile(["peer-b"]);
			await tick();
			await tick();
			const staleLow = low.peerConnections[1]?.channels[0];
			const staleHigh = high.peerConnections[1]?.channels[0];
			if (staleLow === undefined || staleHigh === undefined) throw new Error("stale held B missing");
			expect(lowRoute.snapshot().links[0]).toMatchObject({ connectionId: original.left.id });
			expect(highRoute.snapshot().links[0]).toMatchObject({ connectionId: original.right.id });

			FakeDataChannel.clearControlDrops();
			bus.disconnect(stale);
			const current = bus.connect("peer-a", "peer-b");
			staleHigh.send(REPLACEMENT_ACK);
			staleLow.send(REPLACEMENT_READY);
			staleLow.send(REPLACEMENT_COMMIT);
			await tick();
			expect(lowRoute.snapshot().links[0]).toMatchObject({ connectionId: original.left.id });
			expect(highRoute.snapshot().links[0]).toMatchObject({ connectionId: original.right.id });

			await lowRoute.reconcile(["peer-b"]);
			await vi.waitFor(() => {
				expect(lowRoute.snapshot().links[0]).toMatchObject({
					connectionId: current.left.id,
					generation: current.left.generation,
				});
				expect(highRoute.snapshot().links[0]).toMatchObject({
					connectionId: current.right.id,
					generation: current.right.generation,
				});
			});
			expect(low.peerConnections).toHaveLength(3);
			expect(high.peerConnections).toHaveLength(3);
		} finally {
			FakeDataChannel.clearControlDrops();
			low.owner.close();
			high.owner.close();
		}
	});

	it.each(["initiator", "acceptor"] as const)(
		"D.108e4au closes both active and held links when the %s owner closes",
		async (ownerRole) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			try {
				const original = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4au-held-owner-close");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4au-held-owner-close");
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

				FakeDataChannel.dropNextControl(2, 2);
				bus.disconnect(original);
				bus.connect("peer-a", "peer-b");
				await lowRoute.reconcile(["peer-b"]);
				await tick();
				await tick();
				expect(lowRoute.snapshot().activeLinks, ownerRole).toBe(1);
				expect(highRoute.snapshot().activeLinks, ownerRole).toBe(1);
				expect(
					low.peerConnections.filter(({ connectionState }) => connectionState !== "closed"),
					ownerRole
				).toHaveLength(2);
				expect(
					high.peerConnections.filter(({ connectionState }) => connectionState !== "closed"),
					ownerRole
				).toHaveLength(2);

				(ownerRole === "initiator" ? low : high).owner.close();
				await tick();
				expect(lowRoute.snapshot().activeLinks, ownerRole).toBe(0);
				expect(highRoute.snapshot().activeLinks, ownerRole).toBe(0);
				expect(
					low.peerConnections.every(({ connectionState }) => connectionState === "closed"),
					ownerRole
				).toBe(true);
				expect(
					high.peerConnections.every(({ connectionState }) => connectionState === "closed"),
					ownerRole
				).toBe(true);
			} finally {
				FakeDataChannel.clearControlDrops();
				low.owner.close();
				high.owner.close();
			}
		}
	);

	it.each([
		["direct-close", "initiator"],
		["direct-close", "non-initiator"],
		["send-discovers-unusable", "initiator"],
		["send-discovers-unusable", "non-initiator"],
	] as const)(
		"D.108e4au keeps unready B pending after %s with %s pre-failure traffic",
		async (failureMode, senderRole) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			let barrier: FakeRemoteInboundOpenBarrier | undefined;
			let replacementPending: Promise<void> | undefined;
			try {
				const original = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4au-unready-loss");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4au-unready-loss");
				const lowReceived: Uint8Array[] = [];
				const highReceived: Uint8Array[] = [];
				lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
				highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);

				const oldLow = low.peerConnections[0]?.channels[0];
				const oldHigh = high.peerConnections[0]?.channels[0];
				if (oldLow === undefined || oldHigh === undefined) throw new Error("D108E4AU_OLD_OWNER_ABSENT");
				const applicationSender = senderRole === "initiator" ? lowRoute : highRoute;
				const applicationRemotePeerId = senderRole === "initiator" ? "peer-b" : "peer-a";
				expect(await applicationSender.send([applicationRemotePeerId], Uint8Array.of(81)), senderRole).toBe(true);
				await tick();
				expect(lowReceived, senderRole).toEqual(senderRole === "non-initiator" ? [Uint8Array.of(81)] : []);
				expect(highReceived, senderRole).toEqual(senderRole === "initiator" ? [Uint8Array.of(81)] : []);

				bus.disconnect(original);
				const replacement = bus.connect("peer-a", "peer-b");
				barrier = FakePeerConnection.pauseNextRemoteInboundOpen();
				replacementPending = lowRoute.reconcile(["peer-b"]);
				await barrier.waitUntilPending();
				await replacementPending;
				await tick();

				const replacementLow = low.peerConnections[1]?.channels[0];
				const replacementHigh = high.peerConnections[1]?.channels[0];
				if (replacementLow === undefined || replacementHigh === undefined) {
					throw new Error("D108E4AU_REPLACEMENT_OWNER_ABSENT");
				}
				expect(low.peerConnections, failureMode).toHaveLength(2);
				expect(high.peerConnections, failureMode).toHaveLength(2);
				expect(replacementLow.readyState, failureMode).toBe("open");
				expect(replacementHigh.readyState, failureMode).toBe("connecting");
				expect(replacementHigh.listenerCount("message"), failureMode).toBe(0);
				expect(replacementHigh.openEvents, failureMode).toBe(0);
				expect(lowRoute.snapshot(), failureMode).toMatchObject({
					activeLinks: 1,
					lastLinkDrop: undefined,
					linkDrops: 0,
					links: [{ connectionId: original.left.id, generation: original.left.generation }],
				});
				expect(highRoute.snapshot(), failureMode).toMatchObject({
					activeLinks: 1,
					lastLinkDrop: undefined,
					linkDrops: 0,
					links: [{ connectionId: original.right.id, generation: original.right.generation }],
				});

				if (failureMode === "direct-close") {
					oldLow.close();
					await tick();
					expect(lowRoute.snapshot(), senderRole).toMatchObject({
						activeLinks: 0,
						lastLinkDrop: "channel-close",
						linkDrops: 1,
						links: [],
					});
					expect(highRoute.snapshot(), senderRole).toMatchObject({
						activeLinks: 0,
						lastLinkDrop: "channel-close",
						linkDrops: 1,
						links: [],
					});
					expect(low.peerConnections, senderRole).toHaveLength(2);
					expect(high.peerConnections, senderRole).toHaveLength(2);
					expect(replacementHigh.readyState, senderRole).toBe("connecting");
					expect(replacementHigh.listenerCount("message"), senderRole).toBe(0);
					expect(replacementHigh.openEvents, senderRole).toBe(0);
				} else {
					oldLow.readyState = "closing";
					expect(await lowRoute.send(["peer-b"], Uint8Array.of(82)), senderRole).toBe(false);
					expect(low.peerConnections, senderRole).toHaveLength(2);
					expect(high.peerConnections, senderRole).toHaveLength(2);
					expect(lowRoute.snapshot(), senderRole).toMatchObject({
						activeLinks: 0,
						lastLinkDrop: "replacement",
						linkDrops: 1,
						links: [],
					});
					expect(highRoute.snapshot(), senderRole).toMatchObject({
						activeLinks: 0,
						lastLinkDrop: "channel-close",
						linkDrops: 1,
						links: [],
					});
					expect(replacementHigh.readyState, senderRole).toBe("connecting");
					expect(replacementHigh.listenerCount("message"), senderRole).toBe(0);
					expect(replacementHigh.openEvents, senderRole).toBe(0);
				}

				barrier.release();
				await barrier.waitUntilComplete();
				await vi.waitFor(() => {
					expect(lowRoute.snapshot().links[0], senderRole).toMatchObject({
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
					});
					expect(highRoute.snapshot().links[0], senderRole).toMatchObject({
						connectionId: replacement.right.id,
						generation: replacement.right.generation,
					});
				});
				expect(low.peerConnections, senderRole).toHaveLength(2);
				expect(high.peerConnections, senderRole).toHaveLength(2);
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(83)), senderRole).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(84)), senderRole).toBe(true);
				await tick();
				expect(lowReceived.at(-1), senderRole).toEqual(Uint8Array.of(84));
				expect(highReceived.at(-1), senderRole).toEqual(Uint8Array.of(83));
			} finally {
				FakePeerConnection.releaseRemoteInboundOpenBarrier(barrier);
				await replacementPending?.catch(() => undefined);
				low.owner.close();
				high.owner.close();
			}
		}
	);

	it.each([
		["initiator", "rejection"],
		["initiator", "timeout"],
		["non-initiator", "rejection"],
		["non-initiator", "timeout"],
	] as const)("retains the usable old link after %s replacement %s", async (role, failure) => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		let barrier: FakeInboundOpenBarrier | undefined;
		let pending: Promise<void> | undefined;
		try {
			const local = role === "initiator" ? low : high;
			const localRoute = local.owner.openUnreliableWebRtcRoute("zone:failed-replacement-retention");
			const lowRoute =
				role === "initiator" ? localRoute : low.owner.openUnreliableWebRtcRoute("zone:failed-replacement-retention");
			const highRoute =
				role === "non-initiator"
					? localRoute
					: high.owner.openUnreliableWebRtcRoute("zone:failed-replacement-retention");
			const remoteRoute = role === "initiator" ? highRoute : lowRoute;
			const received: Uint8Array[] = [];
			remoteRoute.onMessage(({ bytes }) => received.push(bytes.slice()));
			const original = bus.connect("peer-a", "peer-b");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			const old = localRoute.snapshot().links[0];
			if (old === undefined) throw new Error("old failed-replacement raw link missing");

			bus.disconnect(original);
			bus.connect("peer-a", "peer-b");
			if (role === "non-initiator") await localRoute.reconcile(["peer-a"]);
			vi.useFakeTimers();
			if (failure === "rejection") {
				bus.requestTransform = (): Uint8Array => Uint8Array.of(255, 0, 255);
			} else {
				barrier = FakePeerConnection.pauseNextInboundOpen();
			}
			pending = lowRoute.reconcile(["peer-b"]);
			if (barrier !== undefined) {
				await barrier.waitUntilPending();
				await vi.advanceTimersByTimeAsync(10_000);
			}
			await pending;
			expect(local.peerConnections[0]?.connectionState).toBe("connected");
			expect(localRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				handshakeFailures: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: old.connectionId, generation: old.generation }],
			});
			const allocationsAfterFailure = local.peerConnections.length;
			expect(local.peerConnections.filter(({ connectionState }) => connectionState !== "closed")).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(1);
			expect(await localRoute.send([role === "initiator" ? "peer-b" : "peer-a"], Uint8Array.of(31))).toBe(true);
			await tick();
			expect(received).toEqual([Uint8Array.of(31)]);
			expect(local.peerConnections).toHaveLength(allocationsAfterFailure);
			await vi.advanceTimersByTimeAsync(249);
			expect(local.peerConnections).toHaveLength(allocationsAfterFailure);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			FakePeerConnection.releaseInboundOpenBarrier(barrier);
			await pending?.catch(() => undefined);
			vi.useRealTimers();
			low.owner.close();
			high.owner.close();
		}
	});

	it("keeps both old links usable when send alone discovers replacement", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		let barrier: FakeInboundOpenBarrier | undefined;
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:send-only-continuity");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:send-only-continuity");
			const lowReceived: Uint8Array[] = [];
			const highReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			const oldLow = lowRoute.snapshot().links[0];
			const oldHigh = highRoute.snapshot().links[0];
			if (oldLow === undefined || oldHigh === undefined) throw new Error("old send-only raw links missing");

			bus.disconnect(original);
			bus.connect("peer-a", "peer-b");
			barrier = FakePeerConnection.pauseNextInboundOpen();
			const [lowSent, highSent] = await Promise.all([
				lowRoute.send(["peer-b"], Uint8Array.of(21)),
				highRoute.send(["peer-a"], Uint8Array.of(22)),
			]);
			expect(lowSent).toBe(true);
			expect(highSent).toBe(true);
			await barrier.waitUntilPending();
			await tick();
			expect(lowReceived).toEqual([Uint8Array.of(22)]);
			expect(highReceived).toEqual([Uint8Array.of(21)]);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: oldLow.connectionId, generation: oldLow.generation }],
			});
			expect(highRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: oldHigh.connectionId, generation: oldHigh.generation }],
			});
		} finally {
			FakePeerConnection.releaseInboundOpenBarrier(barrier);
			low.owner.close();
			high.owner.close();
		}
	});

	it("promotes authenticated inbound replacement before the receiver has reconciled membership", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:inbound-before-reconcile");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:inbound-before-reconcile");
			const received: Uint8Array[] = [];
			highRoute.onMessage(({ bytes }) => received.push(bytes.slice()));
			await lowRoute.reconcile(["peer-b"]);
			expect(highRoute.snapshot().activeLinks).toBe(1);

			bus.disconnect(original);
			const replacement = bus.connect("peer-a", "peer-b");
			await lowRoute.reconcile(["peer-b"]);
			expect(highRoute.snapshot().links).toEqual([
				expect.objectContaining({ connectionId: replacement.right.id, generation: replacement.right.generation }),
			]);
			expect(low.peerConnections).toHaveLength(2);
			expect(high.peerConnections).toHaveLength(2);
			expect(await lowRoute.send(["peer-b"], Uint8Array.of(23))).toBe(true);
			await tick();
			expect(received).toEqual([Uint8Array.of(23)]);
		} finally {
			low.owner.close();
			high.owner.close();
		}
	});

	it("never selects B before the responder installs its inbound handler", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		let barrier: FakeInboundOpenBarrier | undefined;
		let pending: Promise<void> | undefined;
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:handler-order");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:handler-order");
			const received: Uint8Array[] = [];
			highRoute.onMessage(({ bytes }) => received.push(bytes.slice()));
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			const old = lowRoute.snapshot().links[0];
			if (old === undefined) throw new Error("handler-order old link missing");

			bus.disconnect(original);
			bus.connect("peer-a", "peer-b");
			barrier = FakePeerConnection.pauseNextInboundHandler();
			pending = lowRoute.reconcile(["peer-b"]);
			await barrier.waitUntilPending();
			const pendingB = low.peerConnections[1]?.channels[0];
			if (pendingB === undefined) throw new Error("handler-order pending B missing");
			expect(pendingB.readyState).toBe("open");
			expect(pendingB.sent).toEqual([]);
			expect(await lowRoute.send(["peer-b"], Uint8Array.of(41))).toBe(true);
			await tick();
			expect(received).toEqual([Uint8Array.of(41)]);
			expect(pendingB.sent).toEqual([]);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				lastLinkDrop: undefined,
				linkDrops: 0,
				links: [{ connectionId: old.connectionId, generation: old.generation }],
			});
		} finally {
			FakePeerConnection.releaseInboundHandlerBarrier(barrier);
			await pending?.catch(() => undefined);
			low.owner.close();
			high.owner.close();
		}
	});

	it.each(["initiator", "non-initiator"] as const)(
		"starts one failed-send recovery without retaining payloads as the %s",
		async (role) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			let recoveryBarrier: ReturnType<FakeSignalingBus["pauseResponses"]> | undefined;
			try {
				const connection = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:failed-send-recovery");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:failed-send-recovery");
				const localRoute = role === "initiator" ? lowRoute : highRoute;
				const lowReceived: Uint8Array[] = [];
				const highReceived: Uint8Array[] = [];
				lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
				highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));

				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				expect(low.peerConnections).toHaveLength(1);
				expect(high.peerConnections).toHaveLength(1);
				for (const endpoint of [low, high]) {
					const channel = endpoint.peerConnections[0]?.channels[0];
					if (channel === undefined) throw new Error("established raw channel missing");
					channel.readyState = "closing";
				}

				vi.useFakeTimers();
				recoveryBarrier = bus.pauseResponses();
				expect(await localRoute.send([role === "initiator" ? "peer-b" : "peer-a"], Uint8Array.of(11))).toBe(false);
				expect(await localRoute.send([role === "initiator" ? "peer-b" : "peer-a"], Uint8Array.of(12))).toBe(false);
				// Sender-side replacement closes the paired channel synchronously, so the peer records channel-close.
				expect(localRoute.snapshot()).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 0,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: "replacement",
					linkDrops: 1,
					received: 0,
					sent: 0,
					unknownRouteDrops: 0,
				});
				const remoteRoute = role === "initiator" ? highRoute : lowRoute;
				expect(remoteRoute.snapshot()).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 0,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: "channel-close",
					linkDrops: 1,
					received: 0,
					sent: 0,
					unknownRouteDrops: 0,
				});
				expect(lowReceived).toEqual([]);
				expect(highReceived).toEqual([]);

				if (role === "non-initiator") {
					expect(low.peerConnections).toHaveLength(1);
					await vi.advanceTimersByTimeAsync(249);
					expect(low.peerConnections).toHaveLength(1);
					await vi.advanceTimersByTimeAsync(1);
				}
				expect(low.peerConnections).toHaveLength(2);
				await recoveryBarrier.waitUntilPending();
				expect(low.peerConnections).toHaveLength(2);
				expect(high.peerConnections).toHaveLength(2);
				expect(bus.exchangeRecords.map(({ remotePeerId }) => remotePeerId)).toEqual(["peer-b", "peer-b"]);
				expect(localRoute.snapshot().sent).toBe(0);
				expect(lowReceived).toEqual([]);
				expect(highReceived).toEqual([]);

				recoveryBarrier.release();
				await vi.waitFor(() => {
					expect(lowRoute.snapshot().links[0]).toMatchObject({
						connectionId: connection.left.id,
						generation: connection.left.generation,
					});
					expect(highRoute.snapshot().links[0]).toMatchObject({
						connectionId: connection.right.id,
						generation: connection.right.generation,
					});
				});
				expect(await localRoute.send([role === "initiator" ? "peer-b" : "peer-a"], Uint8Array.of(13))).toBe(true);
				await tick();
				expect(lowReceived).toEqual(role === "non-initiator" ? [Uint8Array.of(13)] : []);
				expect(highReceived).toEqual(role === "initiator" ? [Uint8Array.of(13)] : []);
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 0,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: role === "initiator" ? "replacement" : "channel-close",
					linkDrops: 1,
					received: role === "non-initiator" ? 1 : 0,
					sent: role === "initiator" ? 1 : 0,
					unknownRouteDrops: 0,
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 0,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: role === "non-initiator" ? "replacement" : "channel-close",
					linkDrops: 1,
					received: role === "initiator" ? 1 : 0,
					sent: role === "non-initiator" ? 1 : 0,
					unknownRouteDrops: 0,
				});
				await vi.advanceTimersByTimeAsync(250);
				expect(low.peerConnections).toHaveLength(2);
				expect(high.peerConnections).toHaveLength(2);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				recoveryBarrier?.release();
				vi.useRealTimers();
				low.owner.close();
				high.owner.close();
			}
		}
	);

	it.each([
		["lower", "peer-a", "peer-b"],
		["higher", "peer-b", "peer-a"],
	] as const)(
		"D.108e4ax converges after bilateral restart with the %s-id caller first",
		async (_firstRole, firstPeerId, secondPeerId) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const first = owner(module, bus, firstPeerId);
			const second = owner(module, bus, secondPeerId);
			const firstRoute = first.owner.openUnreliableWebRtcRoute("zone:d108e4ax-bilateral-restart");
			const secondRoute = second.owner.openUnreliableWebRtcRoute("zone:d108e4ax-bilateral-restart");
			const firstReceived: Uint8Array[] = [];
			const secondReceived: Uint8Array[] = [];
			firstRoute.onMessage(({ bytes }) => firstReceived.push(bytes.slice()));
			secondRoute.onMessage(({ bytes }) => secondReceived.push(bytes.slice()));
			let recoveryBarrier: ReturnType<FakeSignalingBus["pauseResponses"]> | undefined;
			let peerCloseBarrier: FakeInboundOpenBarrier | undefined;
			let restarts: readonly [Promise<void>, Promise<void>] | undefined;
			try {
				bus.connect(firstPeerId, secondPeerId);
				await Promise.all([firstRoute.reconcile([secondPeerId]), secondRoute.reconcile([firstPeerId])]);
				expect(firstRoute.snapshot().activeLinks).toBe(1);
				expect(secondRoute.snapshot().activeLinks).toBe(1);
				expect(await firstRoute.send([secondPeerId], Uint8Array.of(91))).toBe(true);
				expect(await secondRoute.send([firstPeerId], Uint8Array.of(92))).toBe(true);
				await tick();
				expect(firstReceived).toEqual([Uint8Array.of(92)]);
				expect(secondReceived).toEqual([Uint8Array.of(91)]);

				const oldFirstChannel = first.peerConnections[0]?.channels[0];
				const oldSecondChannel = second.peerConnections[0]?.channels[0];
				if (oldFirstChannel === undefined || oldSecondChannel === undefined) {
					throw new Error("bilateral restart old raw pair missing");
				}
				peerCloseBarrier = oldFirstChannel.pausePeerClose();
				vi.useFakeTimers();
				recoveryBarrier = bus.pauseResponses();
				const exchangeCountBeforeRestart = bus.exchangeRecords.length;

				// Both local drops happen in one synchronous turn. The rows reverse only this call order.
				restarts = [firstRoute.restart(), secondRoute.restart()];
				peerCloseBarrier.release();
				peerCloseBarrier = undefined;

				for (
					let microtask = 0;
					microtask < 20 && bus.exchangeRecords.length === exchangeCountBeforeRestart;
					microtask += 1
				) {
					await tick();
				}
				expect(bus.exchangeRecords).toHaveLength(exchangeCountBeforeRestart + 1);
				for (let microtask = 0; microtask < 20 && !recoveryBarrier.isPending(); microtask += 1) await tick();
				expect(recoveryBarrier.isPending()).toBe(true);
				await recoveryBarrier.waitUntilPending();

				expect(firstRoute.snapshot()).toMatchObject({ lastLinkDrop: "restart", linkDrops: 1 });
				expect(secondRoute.snapshot()).toMatchObject({ lastLinkDrop: "restart", linkDrops: 1 });
				expect(oldFirstChannel.readyState).toBe("closed");
				expect(oldSecondChannel.readyState).toBe("closed");
				expect(first.peerConnections).toHaveLength(2);
				expect(second.peerConnections).toHaveLength(2);

				recoveryBarrier.release();
				await vi.advanceTimersByTimeAsync(10_000);
				await Promise.all(restarts);
				await tick();
				expect(firstRoute.snapshot().activeLinks).toBe(1);
				expect(secondRoute.snapshot().activeLinks).toBe(1);
				expect(first.peerConnections).toHaveLength(2);
				expect(second.peerConnections).toHaveLength(2);

				expect(await firstRoute.send([secondPeerId], Uint8Array.of(93))).toBe(true);
				expect(await secondRoute.send([firstPeerId], Uint8Array.of(94))).toBe(true);
				await tick();
				expect(firstReceived).toEqual([Uint8Array.of(92), Uint8Array.of(94)]);
				expect(secondReceived).toEqual([Uint8Array.of(91), Uint8Array.of(93)]);
				expect(firstRoute.snapshot()).toMatchObject({ activeLinks: 1, received: 2, sent: 2 });
				expect(secondRoute.snapshot()).toMatchObject({ activeLinks: 1, received: 2, sent: 2 });

				const settledFirst = firstRoute.snapshot();
				const settledSecond = secondRoute.snapshot();
				const firstPeerConnectionCount = first.peerConnections.length;
				const secondPeerConnectionCount = second.peerConnections.length;
				for (let retryCycle = 0; retryCycle < 2; retryCycle += 1) {
					await vi.advanceTimersByTimeAsync(250);
					expect(first.peerConnections).toHaveLength(firstPeerConnectionCount);
					expect(second.peerConnections).toHaveLength(secondPeerConnectionCount);
					expect(firstRoute.snapshot().handshakeFailures).toBe(settledFirst.handshakeFailures);
					expect(secondRoute.snapshot().handshakeFailures).toBe(settledSecond.handshakeFailures);
				}
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				peerCloseBarrier?.release();
				recoveryBarrier?.release();
				first.owner.close();
				second.owner.close();
				await Promise.allSettled(restarts ?? []);
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		}
	);

	it.each([
		["before", "lower"],
		["before", "higher"],
		["after", "lower"],
		["after", "higher"],
	] as const)(
		"D.108e4az converges after authenticated loss with replacement %s restart and the %s-id caller first",
		async (replacementTiming, firstRole) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4az-authenticated-loss-restart");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4az-authenticated-loss-restart");
			const lowReceived: Uint8Array[] = [];
			const highReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
			let peerCloseBarrier: FakeInboundOpenBarrier | undefined;
			let restarts: readonly [Promise<void>, Promise<void>] | undefined;
			let reconciles: readonly [Promise<void>, Promise<void>] | undefined;
			try {
				const original = bus.connect("peer-a", "peer-b");
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				expect(lowRoute.snapshot()).toMatchObject({ activeLinks: 1, handshakeFailures: 0, linkDrops: 0 });
				expect(highRoute.snapshot()).toMatchObject({ activeLinks: 1, handshakeFailures: 0, linkDrops: 0 });
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(101))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(102))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(102)]);
				expect(highReceived).toEqual([Uint8Array.of(101)]);

				const oldLowChannel = low.peerConnections[0]?.channels[0];
				const oldHighChannel = high.peerConnections[0]?.channels[0];
				if (oldLowChannel === undefined || oldHighChannel === undefined) {
					throw new Error("authenticated-loss restart old raw pair missing");
				}

				bus.disconnect(original);
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
				});
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(103))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(104))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(102), Uint8Array.of(104)]);
				expect(highReceived).toEqual([Uint8Array.of(101), Uint8Array.of(103)]);

				let replacement = replacementTiming === "before" ? bus.connect("peer-a", "peer-b") : undefined;
				const firstRoute = firstRole === "lower" ? lowRoute : highRoute;
				const secondRoute = firstRole === "lower" ? highRoute : lowRoute;
				const firstOldChannel = firstRole === "lower" ? oldLowChannel : oldHighChannel;
				peerCloseBarrier = firstOldChannel.pausePeerClose();
				vi.useFakeTimers();
				const exchangeCountBeforeRestart = bus.exchangeRecords.length;

				// Both local owners drop in one synchronous turn; only the caller order changes.
				restarts = [firstRoute.restart(), secondRoute.restart()];
				peerCloseBarrier.release();
				peerCloseBarrier = undefined;
				await Promise.all(restarts);

				expect(lowRoute.snapshot()).toMatchObject({ lastLinkDrop: "restart", linkDrops: 1 });
				expect(highRoute.snapshot()).toMatchObject({ lastLinkDrop: "restart", linkDrops: 1 });
				expect(oldLowChannel.readyState).toBe("closed");
				expect(oldHighChannel.readyState).toBe("closed");

				if (replacementTiming === "after") {
					expect(bus.exchangeRecords).toHaveLength(exchangeCountBeforeRestart);
					replacement = bus.connect("peer-a", "peer-b");
					reconciles = [lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])];
					await Promise.all(reconciles);
				}
				if (replacement === undefined) throw new Error("authenticated replacement pair missing");

				for (
					let microtask = 0;
					microtask < 20 &&
					(lowRoute.snapshot().links[0]?.connectionId !== replacement.left.id ||
						highRoute.snapshot().links[0]?.connectionId !== replacement.right.id);
					microtask += 1
				) {
					await tick();
				}

				expect(bus.exchangeRecords.slice(exchangeCountBeforeRestart)).toEqual([
					{
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						remoteAddr: "/webrtc/peer-b",
						remotePeerId: "peer-b",
					},
				]);
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [{ connectionId: replacement.left.id, generation: replacement.left.generation }],
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
				});
				expect(low.peerConnections).toHaveLength(2);
				expect(high.peerConnections).toHaveLength(2);

				expect(await lowRoute.send(["peer-b"], Uint8Array.of(105))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(106))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(102), Uint8Array.of(104), Uint8Array.of(106)]);
				expect(highReceived).toEqual([Uint8Array.of(101), Uint8Array.of(103), Uint8Array.of(105)]);

				const settledLow = lowRoute.snapshot();
				const settledHigh = highRoute.snapshot();
				for (let retryCycle = 0; retryCycle < 2; retryCycle += 1) {
					await vi.advanceTimersByTimeAsync(250);
					expect(low.peerConnections).toHaveLength(2);
					expect(high.peerConnections).toHaveLength(2);
					expect(lowRoute.snapshot()).toEqual(settledLow);
					expect(highRoute.snapshot()).toEqual(settledHigh);
				}
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				peerCloseBarrier?.release();
				low.owner.close();
				high.owner.close();
				await Promise.allSettled([...(restarts ?? []), ...(reconciles ?? [])]);
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		}
	);

	it.each([["lower"], ["higher"]] as const)(
		"D.108e4ba recovers after the observed 27/1 handshake split with the %s-id restart caller first",
		async (firstRole) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4ba-transient-handshake-recovery");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4ba-transient-handshake-recovery");
			const lowReceived: Uint8Array[] = [];
			const highReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
			let peerCloseBarrier: FakeInboundOpenBarrier | undefined;
			let restarts: readonly [Promise<void>, Promise<void>] | undefined;
			let reconciles: readonly [Promise<void>, Promise<void>] | undefined;
			try {
				const original = bus.connect("peer-a", "peer-b");
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				expect(lowRoute.snapshot()).toMatchObject({ activeLinks: 1, handshakeFailures: 0, linkDrops: 0 });
				expect(highRoute.snapshot()).toMatchObject({ activeLinks: 1, handshakeFailures: 0, linkDrops: 0 });
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(111))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(112))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(112)]);
				expect(highReceived).toEqual([Uint8Array.of(111)]);

				const oldLowChannel = low.peerConnections[0]?.channels[0];
				const oldHighChannel = high.peerConnections[0]?.channels[0];
				if (oldLowChannel === undefined || oldHighChannel === undefined) {
					throw new Error("transient-handshake old raw pair missing");
				}

				bus.disconnect(original);
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
				});
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(113))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(114))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(112), Uint8Array.of(114)]);
				expect(highReceived).toEqual([Uint8Array.of(111), Uint8Array.of(113)]);

				const firstRoute = firstRole === "lower" ? lowRoute : highRoute;
				const secondRoute = firstRole === "lower" ? highRoute : lowRoute;
				const firstOldChannel = firstRole === "lower" ? oldLowChannel : oldHighChannel;
				peerCloseBarrier = firstOldChannel.pausePeerClose();
				vi.useFakeTimers();
				const exchangeCountBeforeRestart = bus.exchangeRecords.length;

				restarts = [firstRoute.restart(), secondRoute.restart()];
				peerCloseBarrier.release();
				peerCloseBarrier = undefined;
				await Promise.all(restarts);

				expect(bus.exchangeRecords).toHaveLength(exchangeCountBeforeRestart);
				expect(oldLowChannel.readyState).toBe("closed");
				expect(oldHighChannel.readyState).toBe("closed");
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [],
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [],
				});

				const replacement = bus.connect("peer-a", "peer-b");
				let transformAttempt = 0;
				bus.requestTransform = (request): Uint8Array => {
					transformAttempt += 1;
					if (transformAttempt === 1) return Uint8Array.of(255, 0, 255);
					if (transformAttempt <= 27) throw new Error(`scripted initiator-only failure ${transformAttempt}`);
					return request;
				};

				reconciles = [lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])];
				await Promise.all(reconciles);
				expect(transformAttempt).toBe(1);
				expect(bus.exchangeRecords.slice(exchangeCountBeforeRestart)).toEqual([
					{
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						remoteAddr: "/webrtc/peer-b",
						remotePeerId: "peer-b",
					},
				]);
				expect(lowRoute.snapshot()).toMatchObject({ activeLinks: 0, handshakeFailures: 1, links: [] });
				expect(highRoute.snapshot()).toMatchObject({ activeLinks: 0, handshakeFailures: 1, links: [] });
				expect(vi.getTimerCount()).toBe(1);

				for (let retryCycle = 0; retryCycle < 26; retryCycle += 1) {
					const exchangesBeforeCycle = bus.exchangeRecords.length;
					const expectedAttempt = retryCycle + 2;
					await vi.advanceTimersByTimeAsync(250);
					for (
						let microtask = 0;
						microtask < 20 &&
						(bus.exchangeRecords.length !== exchangesBeforeCycle + 1 ||
							lowRoute.snapshot().handshakeFailures !== expectedAttempt);
						microtask += 1
					) {
						await tick();
					}
					expect(bus.exchangeRecords, `retry cycle ${expectedAttempt}`).toHaveLength(exchangesBeforeCycle + 1);
					expect(transformAttempt, `retry cycle ${expectedAttempt}`).toBe(expectedAttempt);
					expect(bus.exchangeRecords.at(-1), `retry cycle ${expectedAttempt}`).toEqual({
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						remoteAddr: "/webrtc/peer-b",
						remotePeerId: "peer-b",
					});
					expect(lowRoute.snapshot(), `retry cycle ${expectedAttempt}`).toMatchObject({
						activeLinks: 0,
						authenticatedConnectionLosses: 1,
						handshakeFailures: expectedAttempt,
						lastLinkDrop: "restart",
						linkDrops: 1,
						links: [],
					});
					expect(highRoute.snapshot(), `retry cycle ${expectedAttempt}`).toMatchObject({
						activeLinks: 0,
						authenticatedConnectionLosses: 1,
						handshakeFailures: 1,
						lastLinkDrop: "restart",
						linkDrops: 1,
						links: [],
					});
					expect(vi.getTimerCount(), `retry cycle ${expectedAttempt}`).toBe(1);
				}

				expect(bus.exchangeRecords).toHaveLength(exchangeCountBeforeRestart + 27);
				const exchangesBeforeRecovery = bus.exchangeRecords.length;
				await vi.advanceTimersByTimeAsync(250);
				for (
					let microtask = 0;
					microtask < 40 &&
					(bus.exchangeRecords.length !== exchangesBeforeRecovery + 1 ||
						lowRoute.snapshot().activeLinks !== 1 ||
						highRoute.snapshot().activeLinks !== 1);
					microtask += 1
				) {
					await tick();
				}

				expect(transformAttempt).toBe(28);
				expect(bus.exchangeRecords).toHaveLength(exchangesBeforeRecovery + 1);
				expect(bus.exchangeRecords.at(-1)).toEqual({
					connectionId: replacement.left.id,
					generation: replacement.left.generation,
					remoteAddr: "/webrtc/peer-b",
					remotePeerId: "peer-b",
				});
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 27,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [{ connectionId: replacement.left.id, generation: replacement.left.generation }],
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 1,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
				});

				expect(await lowRoute.send(["peer-b"], Uint8Array.of(115))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(116))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(112), Uint8Array.of(114), Uint8Array.of(116)]);
				expect(highReceived).toEqual([Uint8Array.of(111), Uint8Array.of(113), Uint8Array.of(115)]);

				const settledLow = lowRoute.snapshot();
				const settledHigh = highRoute.snapshot();
				const settledExchangeCount = bus.exchangeRecords.length;
				const settledLowAllocations = low.peerConnections.length;
				const settledHighAllocations = high.peerConnections.length;
				for (let quietCycle = 0; quietCycle < 2; quietCycle += 1) {
					await vi.advanceTimersByTimeAsync(250);
					expect(bus.exchangeRecords).toHaveLength(settledExchangeCount);
					expect(low.peerConnections).toHaveLength(settledLowAllocations);
					expect(high.peerConnections).toHaveLength(settledHighAllocations);
					expect(lowRoute.snapshot()).toEqual(settledLow);
					expect(highRoute.snapshot()).toEqual(settledHigh);
				}
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				peerCloseBarrier?.release();
				low.owner.close();
				high.owner.close();
				await Promise.allSettled([...(restarts ?? []), ...(reconciles ?? [])]);
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		}
	);

	it.each([
		["READY", "lower", 1, 1],
		["READY", "higher", 1, 1],
		["ACK", "lower", 2, 2],
		["ACK", "higher", 2, 2],
		["COMMIT", "lower", 3, 1],
		["COMMIT", "higher", 3, 1],
	] as const)(
		"D.108e4bb recovers after bilateral restart and lost %s controls with the %s-id caller first",
		async (controlName, firstRole, controlKind, dropCount) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4bb-held-control-recovery");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4bb-held-control-recovery");
			const lowReceived: Uint8Array[] = [];
			const highReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
			let peerCloseBarrier: FakeInboundOpenBarrier | undefined;
			let restarts: readonly [Promise<void>, Promise<void>] | undefined;
			let reconciles: readonly [Promise<void>, Promise<void>] | undefined;
			try {
				const original = bus.connect("peer-a", "peer-b");
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				expect(lowRoute.snapshot()).toMatchObject({ activeLinks: 1, handshakeFailures: 0, linkDrops: 0 });
				expect(highRoute.snapshot()).toMatchObject({ activeLinks: 1, handshakeFailures: 0, linkDrops: 0 });
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(121)), controlName).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(122)), controlName).toBe(true);
				await tick();
				expect(lowReceived, controlName).toEqual([Uint8Array.of(122)]);
				expect(highReceived, controlName).toEqual([Uint8Array.of(121)]);

				const oldLowChannel = low.peerConnections[0]?.channels[0];
				const oldHighChannel = high.peerConnections[0]?.channels[0];
				if (oldLowChannel === undefined || oldHighChannel === undefined) {
					throw new Error("held-control old raw pair missing");
				}

				bus.disconnect(original);
				expect(lowRoute.snapshot(), controlName).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
				});
				expect(highRoute.snapshot(), controlName).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
				});
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(123)), controlName).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(124)), controlName).toBe(true);
				await tick();
				expect(lowReceived, controlName).toEqual([Uint8Array.of(122), Uint8Array.of(124)]);
				expect(highReceived, controlName).toEqual([Uint8Array.of(121), Uint8Array.of(123)]);

				const firstRoute = firstRole === "lower" ? lowRoute : highRoute;
				const secondRoute = firstRole === "lower" ? highRoute : lowRoute;
				const firstOldChannel = firstRole === "lower" ? oldLowChannel : oldHighChannel;
				peerCloseBarrier = firstOldChannel.pausePeerClose();
				vi.useFakeTimers();
				const exchangeCountBeforeRestart = bus.exchangeRecords.length;

				restarts = [firstRoute.restart(), secondRoute.restart()];
				peerCloseBarrier.release();
				peerCloseBarrier = undefined;
				await Promise.all(restarts);

				expect(bus.exchangeRecords, controlName).toHaveLength(exchangeCountBeforeRestart);
				expect(oldLowChannel.readyState, controlName).toBe("closed");
				expect(oldHighChannel.readyState, controlName).toBe("closed");
				expect(lowRoute.snapshot(), controlName).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [],
				});
				expect(highRoute.snapshot(), controlName).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [],
				});

				FakeDataChannel.dropNextControl(controlKind, dropCount);
				const replacement = bus.connect("peer-a", "peer-b");
				reconciles = [lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])];
				await Promise.all(reconciles);
				for (
					let microtask = 0;
					microtask < 30 &&
					(FakeDataChannel.controlDrops.has(controlKind) || low.peerConnections[1]?.channels[0] === undefined);
					microtask += 1
				) {
					await tick();
				}

				const firstReplacementLow = low.peerConnections[1]?.channels[0];
				const firstReplacementHigh = high.peerConnections[1]?.channels[0];
				if (firstReplacementLow === undefined || firstReplacementHigh === undefined) {
					throw new Error("held-control first replacement raw pair missing");
				}
				expect(FakeDataChannel.controlDrops.has(controlKind), controlName).toBe(false);
				expect(bus.exchangeRecords.slice(exchangeCountBeforeRestart), controlName).toEqual([
					{
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						remoteAddr: "/webrtc/peer-b",
						remotePeerId: "peer-b",
					},
				]);

				const expectedFrames =
					controlKind === 1
						? { acknowledgements: 1, commits: 0, ready: 1 }
						: controlKind === 2
							? { acknowledgements: 2, commits: 0, ready: 1 }
							: { acknowledgements: 2, commits: 1, ready: 2 };
				expect(
					controlFrames(firstReplacementLow).filter((bytes) => bytes[3] === 1),
					controlName
				).toHaveLength(expectedFrames.ready);
				expect(
					controlFrames(firstReplacementLow).filter((bytes) => bytes[3] === 3),
					controlName
				).toHaveLength(expectedFrames.commits);
				expect(
					controlFrames(firstReplacementHigh).filter((bytes) => bytes[3] === 2),
					controlName
				).toHaveLength(expectedFrames.acknowledgements);
				expect(low.peerConnections, controlName).toHaveLength(2);
				expect(high.peerConnections, controlName).toHaveLength(2);

				await vi.advanceTimersByTimeAsync(9_999);
				expect(bus.exchangeRecords, controlName).toHaveLength(exchangeCountBeforeRestart + 1);
				expect(lowRoute.snapshot(), controlName).toMatchObject({
					activeLinks: controlKind === 3 ? 1 : 0,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links:
						controlKind === 3 ? [{ connectionId: replacement.left.id, generation: replacement.left.generation }] : [],
				});
				expect(highRoute.snapshot(), controlName).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [],
				});
				expect(low.peerConnections, controlName).toHaveLength(2);
				expect(high.peerConnections, controlName).toHaveLength(2);

				await vi.advanceTimersByTimeAsync(1);
				await vi.advanceTimersByTimeAsync(250);
				for (
					let microtask = 0;
					microtask < 40 &&
					(bus.exchangeRecords.length !== exchangeCountBeforeRestart + 2 ||
						lowRoute.snapshot().activeLinks !== 1 ||
						highRoute.snapshot().activeLinks !== 1);
					microtask += 1
				) {
					await tick();
				}

				expect(bus.exchangeRecords.slice(exchangeCountBeforeRestart), controlName).toEqual([
					{
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						remoteAddr: "/webrtc/peer-b",
						remotePeerId: "peer-b",
					},
					{
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						remoteAddr: "/webrtc/peer-b",
						remotePeerId: "peer-b",
					},
				]);
				expect(lowRoute.snapshot(), controlName).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: controlKind === 3 ? "channel-close" : "restart",
					linkDrops: controlKind === 3 ? 2 : 1,
					links: [{ connectionId: replacement.left.id, generation: replacement.left.generation }],
				});
				expect(highRoute.snapshot(), controlName).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 1,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
				});
				expect(firstReplacementLow.readyState, controlName).toBe("closed");
				expect(firstReplacementHigh.readyState, controlName).toBe("closed");
				expect(low.peerConnections, controlName).toHaveLength(3);
				expect(high.peerConnections, controlName).toHaveLength(3);

				expect(await lowRoute.send(["peer-b"], Uint8Array.of(125)), controlName).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(126)), controlName).toBe(true);
				await tick();
				expect(lowReceived, controlName).toEqual([Uint8Array.of(122), Uint8Array.of(124), Uint8Array.of(126)]);
				expect(highReceived, controlName).toEqual([Uint8Array.of(121), Uint8Array.of(123), Uint8Array.of(125)]);

				const settledLow = lowRoute.snapshot();
				const settledHigh = highRoute.snapshot();
				const settledExchangeCount = bus.exchangeRecords.length;
				for (let quietCycle = 0; quietCycle < 2; quietCycle += 1) {
					await vi.advanceTimersByTimeAsync(250);
					expect(bus.exchangeRecords, controlName).toHaveLength(settledExchangeCount);
					expect(low.peerConnections, controlName).toHaveLength(3);
					expect(high.peerConnections, controlName).toHaveLength(3);
					expect(lowRoute.snapshot(), controlName).toEqual(settledLow);
					expect(highRoute.snapshot(), controlName).toEqual(settledHigh);
				}
				expect(vi.getTimerCount(), controlName).toBe(0);
			} finally {
				peerCloseBarrier?.release();
				FakeDataChannel.clearControlDrops();
				low.owner.close();
				high.owner.close();
				await Promise.allSettled([...(restarts ?? []), ...(reconciles ?? [])]);
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		}
	);

	it.each([["lower"], ["higher"]] as const)(
		"D.108e4bc recovers from held-acceptor 27/1 after the %s-id restart caller goes first",
		async (firstRole) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:d108e4bc-held-acceptor-recovery");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:d108e4bc-held-acceptor-recovery");
			const lowReceived: Uint8Array[] = [];
			const highReceived: Uint8Array[] = [];
			lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
			highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
			let oldPeerCloseBarrier: FakeInboundOpenBarrier | undefined;
			let heldPeerCloseBarrier: FakeInboundOpenBarrier | undefined;
			let responseBarrier: ReturnType<FakeSignalingBus["pauseResponses"]> | undefined;
			let restarts: readonly [Promise<void>, Promise<void>] | undefined;
			let reconciles: readonly [Promise<void>, Promise<void>] | undefined;
			try {
				const original = bus.connect("peer-a", "peer-b");
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				expect(lowRoute.snapshot()).toMatchObject({ activeLinks: 1, handshakeFailures: 0, linkDrops: 0 });
				expect(highRoute.snapshot()).toMatchObject({ activeLinks: 1, handshakeFailures: 0, linkDrops: 0 });
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(131))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(132))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(132)]);
				expect(highReceived).toEqual([Uint8Array.of(131)]);

				const oldLowChannel = low.peerConnections[0]?.channels[0];
				const oldHighChannel = high.peerConnections[0]?.channels[0];
				if (oldLowChannel === undefined || oldHighChannel === undefined) {
					throw new Error("held-acceptor old raw pair missing");
				}

				bus.disconnect(original);
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
				});
				expect(await lowRoute.send(["peer-b"], Uint8Array.of(133))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(134))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(132), Uint8Array.of(134)]);
				expect(highReceived).toEqual([Uint8Array.of(131), Uint8Array.of(133)]);

				const firstRoute = firstRole === "lower" ? lowRoute : highRoute;
				const secondRoute = firstRole === "lower" ? highRoute : lowRoute;
				const firstOldChannel = firstRole === "lower" ? oldLowChannel : oldHighChannel;
				oldPeerCloseBarrier = firstOldChannel.pausePeerClose();
				vi.useFakeTimers();
				const exchangeCountBeforeRestart = bus.exchangeRecords.length;

				restarts = [firstRoute.restart(), secondRoute.restart()];
				oldPeerCloseBarrier.release();
				oldPeerCloseBarrier = undefined;
				await Promise.all(restarts);
				expect(bus.exchangeRecords).toHaveLength(exchangeCountBeforeRestart);
				expect(oldLowChannel.readyState).toBe("closed");
				expect(oldHighChannel.readyState).toBe("closed");
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [],
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 0,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [],
				});

				responseBarrier = bus.pauseResponses();
				const replacement = bus.connect("peer-a", "peer-b");
				reconciles = [lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])];
				for (let microtask = 0; microtask < 30 && !responseBarrier.isPending(); microtask += 1) await tick();
				expect(responseBarrier.isPending()).toBe(true);
				await responseBarrier.waitUntilPending();
				for (
					let microtask = 0;
					microtask < 20 &&
					(low.peerConnections[1]?.channels[0] === undefined || high.peerConnections[1]?.channels[0] === undefined);
					microtask += 1
				) {
					await tick();
				}

				const firstReplacementLow = low.peerConnections[1]?.channels[0];
				const heldReplacementHigh = high.peerConnections[1]?.channels[0];
				if (firstReplacementLow === undefined || heldReplacementHigh === undefined) {
					throw new Error("held-acceptor replacement raw pair missing");
				}
				expect(firstReplacementLow.readyState).toBe("open");
				expect(heldReplacementHigh.readyState).toBe("open");
				expect(controlFrames(firstReplacementLow)).toHaveLength(0);
				heldPeerCloseBarrier = firstReplacementLow.pausePeerClose();
				FakeDataChannel.throwNextControl(1, 1);
				responseBarrier.release();
				responseBarrier = undefined;
				await Promise.all(reconciles);
				for (
					let microtask = 0;
					microtask < 30 && (lowRoute.snapshot().handshakeFailures !== 1 || FakeDataChannel.controlThrows.has(1));
					microtask += 1
				) {
					await tick();
				}

				expect(FakeDataChannel.controlThrows.has(1)).toBe(false);
				expect(bus.exchangeRecords.slice(exchangeCountBeforeRestart)).toEqual([
					{
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						remoteAddr: "/webrtc/peer-b",
						remotePeerId: "peer-b",
					},
				]);
				expect(firstReplacementLow.readyState).toBe("closed");
				expect(heldReplacementHigh.readyState).toBe("open");
				expect(low.peerConnections[1]?.connectionState).toBe("closed");
				expect(high.peerConnections[1]?.connectionState).toBe("connected");
				expect(lowRoute.snapshot()).toMatchObject({ activeLinks: 0, handshakeFailures: 1, links: [] });
				expect(highRoute.snapshot()).toMatchObject({ activeLinks: 0, handshakeFailures: 0, links: [] });
				expect(low.peerConnections).toHaveLength(2);
				expect(high.peerConnections).toHaveLength(2);
				expect(vi.getTimerCount()).toBe(2);

				for (let retryCycle = 0; retryCycle < 26; retryCycle += 1) {
					const exchangesBeforeCycle = bus.exchangeRecords.length;
					const expectedAttempt = retryCycle + 2;
					await vi.advanceTimersByTimeAsync(250);
					for (
						let microtask = 0;
						microtask < 20 &&
						(bus.exchangeRecords.length !== exchangesBeforeCycle + 1 ||
							lowRoute.snapshot().handshakeFailures !== expectedAttempt);
						microtask += 1
					) {
						await tick();
					}
					expect(bus.exchangeRecords, `held retry ${expectedAttempt}`).toHaveLength(exchangesBeforeCycle + 1);
					expect(bus.exchangeRecords.at(-1), `held retry ${expectedAttempt}`).toEqual({
						connectionId: replacement.left.id,
						generation: replacement.left.generation,
						remoteAddr: "/webrtc/peer-b",
						remotePeerId: "peer-b",
					});
					expect(lowRoute.snapshot(), `held retry ${expectedAttempt}`).toMatchObject({
						activeLinks: 0,
						handshakeFailures: expectedAttempt,
						lastLinkDrop: "restart",
						linkDrops: 1,
						links: [],
					});
					expect(highRoute.snapshot(), `held retry ${expectedAttempt}`).toMatchObject({
						activeLinks: 0,
						handshakeFailures: 0,
						lastLinkDrop: "restart",
						linkDrops: 1,
						links: [],
					});
					expect(low.peerConnections, `held retry ${expectedAttempt}`).toHaveLength(expectedAttempt + 1);
					expect(high.peerConnections, `held retry ${expectedAttempt}`).toHaveLength(2);
					expect(heldReplacementHigh.readyState, `held retry ${expectedAttempt}`).toBe("open");
					expect(vi.getTimerCount(), `held retry ${expectedAttempt}`).toBe(2);
				}

				expect(bus.exchangeRecords).toHaveLength(exchangeCountBeforeRestart + 27);
				expect(low.peerConnections).toHaveLength(28);
				expect(high.peerConnections).toHaveLength(2);
				heldPeerCloseBarrier.release();
				heldPeerCloseBarrier = undefined;
				for (
					let microtask = 0;
					microtask < 30 &&
					(highRoute.snapshot().handshakeFailures !== 1 || heldReplacementHigh.readyState !== "closed");
					microtask += 1
				) {
					await tick();
				}

				expect(bus.exchangeRecords).toHaveLength(exchangeCountBeforeRestart + 27);
				expect(lowRoute.snapshot()).toMatchObject({ activeLinks: 0, handshakeFailures: 27, links: [] });
				expect(highRoute.snapshot()).toMatchObject({ activeLinks: 0, handshakeFailures: 1, links: [] });
				expect(heldReplacementHigh.readyState).toBe("closed");
				expect(vi.getTimerCount()).toBe(1);

				await vi.advanceTimersByTimeAsync(250);
				for (
					let microtask = 0;
					microtask < 40 &&
					(bus.exchangeRecords.length !== exchangeCountBeforeRestart + 28 ||
						lowRoute.snapshot().activeLinks !== 1 ||
						highRoute.snapshot().activeLinks !== 1);
					microtask += 1
				) {
					await tick();
				}

				expect(bus.exchangeRecords).toHaveLength(exchangeCountBeforeRestart + 28);
				expect(bus.exchangeRecords.at(-1)).toEqual({
					connectionId: replacement.left.id,
					generation: replacement.left.generation,
					remoteAddr: "/webrtc/peer-b",
					remotePeerId: "peer-b",
				});
				expect(lowRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 27,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [{ connectionId: replacement.left.id, generation: replacement.left.generation }],
				});
				expect(highRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					handshakeFailures: 1,
					lastLinkDrop: "restart",
					linkDrops: 1,
					links: [{ connectionId: replacement.right.id, generation: replacement.right.generation }],
				});
				expect(low.peerConnections).toHaveLength(29);
				expect(high.peerConnections).toHaveLength(3);

				expect(await lowRoute.send(["peer-b"], Uint8Array.of(135))).toBe(true);
				expect(await highRoute.send(["peer-a"], Uint8Array.of(136))).toBe(true);
				await tick();
				expect(lowReceived).toEqual([Uint8Array.of(132), Uint8Array.of(134), Uint8Array.of(136)]);
				expect(highReceived).toEqual([Uint8Array.of(131), Uint8Array.of(133), Uint8Array.of(135)]);

				const settledLow = lowRoute.snapshot();
				const settledHigh = highRoute.snapshot();
				const settledExchangeCount = bus.exchangeRecords.length;
				for (let quietCycle = 0; quietCycle < 2; quietCycle += 1) {
					await vi.advanceTimersByTimeAsync(250);
					expect(bus.exchangeRecords).toHaveLength(settledExchangeCount);
					expect(low.peerConnections).toHaveLength(29);
					expect(high.peerConnections).toHaveLength(3);
					expect(lowRoute.snapshot()).toEqual(settledLow);
					expect(highRoute.snapshot()).toEqual(settledHigh);
				}
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				responseBarrier?.release();
				oldPeerCloseBarrier?.release();
				heldPeerCloseBarrier?.release();
				FakeDataChannel.clearControlDrops();
				low.owner.close();
				high.owner.close();
				await Promise.allSettled([...(restarts ?? []), ...(reconciles ?? [])]);
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		}
	);

	it("keeps the first absolute recovery deadline across repeated failed sends", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const left = owner(module, bus, "peer-a");
		const right = owner(module, bus, "peer-b");
		const leftRoute = left.owner.openUnreliableWebRtcRoute("zone:failed-send-deadline");
		const rightRoute = right.owner.openUnreliableWebRtcRoute("zone:failed-send-deadline");
		let recoveryBarrier: ReturnType<FakeSignalingBus["pauseResponses"]> | undefined;
		try {
			bus.connect("peer-a", "peer-b");
			await Promise.all([leftRoute.reconcile(["peer-b"]), rightRoute.reconcile(["peer-a"])]);
			for (const endpoint of [left, right]) {
				const channel = endpoint.peerConnections[0]?.channels[0];
				if (channel === undefined) throw new Error("established raw channel missing");
				channel.readyState = "closing";
			}

			vi.useFakeTimers();
			recoveryBarrier = bus.pauseResponses();
			expect(await leftRoute.send(["peer-b"], Uint8Array.of(41))).toBe(false);
			expect(left.peerConnections).toHaveLength(2);
			await recoveryBarrier.waitUntilPending();
			expect(right.peerConnections).toHaveLength(2);

			await vi.advanceTimersByTimeAsync(5_000);
			expect(await leftRoute.send(["peer-b"], Uint8Array.of(42))).toBe(false);
			expect(left.peerConnections).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(4_999);
			expect(leftRoute.snapshot().handshakeFailures).toBe(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(leftRoute.snapshot()).toMatchObject({ handshakeFailures: 1, sent: 0 });
			expect(left.peerConnections).toHaveLength(2);
			expect(left.peerConnections[1]?.connectionState).toBe("closed");
			expect(await leftRoute.send(["peer-b"], Uint8Array.of(43))).toBe(false);
			expect(left.peerConnections).toHaveLength(2);
			// The first absolute setup has settled. Its existing retry owner may start a later setup after this checkpoint.
		} finally {
			recoveryBarrier?.release();
			vi.useRealTimers();
			left.owner.close();
			right.owner.close();
		}
	});

	it.each(["initiator", "non-initiator"] as const)(
		"uses a successful old-link send while joining stale replacement as the %s",
		async (role) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			let recoveryBarrier: ReturnType<FakeSignalingBus["pauseResponses"]> | undefined;
			try {
				const original = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:stale-send-recovery");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:stale-send-recovery");
				const localRoute = role === "initiator" ? lowRoute : highRoute;
				const lowReceived: Uint8Array[] = [];
				const highReceived: Uint8Array[] = [];
				lowRoute.onMessage(({ bytes }) => lowReceived.push(bytes.slice()));
				highRoute.onMessage(({ bytes }) => highReceived.push(bytes.slice()));
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				expect(low.peerConnections).toHaveLength(1);
				expect(high.peerConnections).toHaveLength(1);

				bus.disconnect(original);
				const replacement = bus.connect("peer-a", "peer-b");
				vi.useFakeTimers();
				recoveryBarrier = bus.pauseResponses();
				expect(await localRoute.send([role === "initiator" ? "peer-b" : "peer-a"], Uint8Array.of(31))).toBe(true);
				if (role === "non-initiator") void lowRoute.reconcile(["peer-b"]);
				await tick();
				expect(localRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
					received: 0,
					sent: 1,
					unknownRouteDrops: 0,
				});
				const remoteRoute = role === "initiator" ? highRoute : lowRoute;
				expect(remoteRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: undefined,
					linkDrops: 0,
					received: 1,
					sent: 0,
					unknownRouteDrops: 0,
				});
				expect(lowReceived).toEqual(role === "non-initiator" ? [Uint8Array.of(31)] : []);
				expect(highReceived).toEqual(role === "initiator" ? [Uint8Array.of(31)] : []);
				expect(low.peerConnections).toHaveLength(2);
				await recoveryBarrier.waitUntilPending();
				expect(high.peerConnections).toHaveLength(2);
				expect(bus.exchangeRecords.map(({ remotePeerId }) => remotePeerId)).toEqual(["peer-b", "peer-b"]);

				const localReplacement = role === "initiator" ? replacement.left : replacement.right;
				const remoteReplacement = role === "initiator" ? replacement.right : replacement.left;
				recoveryBarrier.release();
				await vi.waitFor(() => {
					expect(localRoute.snapshot().links[0]).toMatchObject({
						connectionId: localReplacement.id,
						generation: localReplacement.generation,
					});
					expect(remoteRoute.snapshot().links[0]).toMatchObject({
						connectionId: remoteReplacement.id,
						generation: remoteReplacement.generation,
					});
				});
				expect(await localRoute.send([role === "initiator" ? "peer-b" : "peer-a"], Uint8Array.of(32))).toBe(true);
				await tick();
				expect(lowReceived).toEqual(role === "non-initiator" ? [Uint8Array.of(31), Uint8Array.of(32)] : []);
				expect(highReceived).toEqual(role === "initiator" ? [Uint8Array.of(31), Uint8Array.of(32)] : []);
				expect(localRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: role === "initiator" ? "channel-close" : "replacement",
					linkDrops: 1,
					links: [{ connectionId: localReplacement.id, generation: localReplacement.generation }],
					received: 0,
					sent: 2,
					unknownRouteDrops: 0,
				});
				expect(remoteRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					authenticatedConnectionLosses: 1,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: role === "initiator" ? "replacement" : "channel-close",
					linkDrops: 1,
					links: [{ connectionId: remoteReplacement.id, generation: remoteReplacement.generation }],
					received: 2,
					sent: 0,
					unknownRouteDrops: 0,
				});
				expect(low.peerConnections).toHaveLength(2);
				expect(high.peerConnections).toHaveLength(2);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				recoveryBarrier?.release();
				vi.useRealTimers();
				low.owner.close();
				high.owner.close();
			}
		}
	);

	it("does not recover an unusable mapped link after its peer leaves desired membership", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		try {
			bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:undesired-send-recovery");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:undesired-send-recovery");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			expect(low.peerConnections).toHaveLength(1);
			await lowRoute.reconcile([]);
			const channel = low.peerConnections[0]?.channels[0];
			if (channel === undefined) throw new Error("established raw channel missing");
			channel.readyState = "closing";

			expect(await lowRoute.send(["peer-b"], Uint8Array.of(51))).toBe(false);
			expect(lowRoute.snapshot()).toMatchObject({
				activeLinks: 1,
				backpressuredDrops: 0,
				lastLinkDrop: undefined,
				linkDrops: 0,
				sent: 0,
				unknownRouteDrops: 0,
			});
			expect(low.peerConnections).toHaveLength(1);
			expect(high.peerConnections).toHaveLength(1);
		} finally {
			low.owner.close();
			high.owner.close();
		}
	});

	it("does not retain a retry timer while the desired peer has no authenticated connection", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const low = owner(module, bus, "peer-a");
		const high = owner(module, bus, "peer-b");
		try {
			const original = bus.connect("peer-a", "peer-b");
			const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:disconnected-retry-release");
			const highRoute = high.owner.openUnreliableWebRtcRoute("zone:disconnected-retry-release");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			const lowChannel = low.peerConnections[0]?.channels[0];
			if (lowChannel === undefined) throw new Error("established raw channel missing");

			vi.useFakeTimers();
			bus.disconnect(original);
			lowChannel.close();
			expect(lowRoute.snapshot()).toMatchObject({ activeLinks: 0, lastLinkDrop: "channel-close", linkDrops: 1 });
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(low.peerConnections).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);

			bus.connect("peer-a", "peer-b");
			await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
			expect(lowRoute.snapshot().activeLinks).toBe(1);
		} finally {
			vi.useRealTimers();
			low.owner.close();
			high.owner.close();
		}
	});

	it.each(["initiator", "non-initiator"] as const)(
		"does not start stale-open replacement after its peer leaves desired membership as the %s",
		async (role) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			try {
				const original = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:undesired-stale-open");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:undesired-stale-open");
				const local = role === "initiator" ? low : high;
				const localRoute = role === "initiator" ? lowRoute : highRoute;
				const remotePeerId = role === "initiator" ? "peer-b" : "peer-a";
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				await localRoute.reconcile([]);
				bus.disconnect(original);
				bus.connect("peer-a", "peer-b");

				expect(await localRoute.send([remotePeerId], Uint8Array.of(52))).toBe(true);
				await tick();
				expect(localRoute.snapshot()).toMatchObject({ activeLinks: 1, linkDrops: 0, sent: 1 });
				expect(local.peerConnections).toHaveLength(1);
			} finally {
				low.owner.close();
				high.owner.close();
			}
		}
	);

	it("rejects unknown routes, retains established raw links, and cannot revive stale signaling", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const left = owner(module, bus, "peer-a");
		const right = owner(module, bus, "peer-b");
		let pair = bus.connect("peer-a", "peer-b");
		const leftRoute = left.owner.openUnreliableWebRtcRoute("zone:alpha");
		const otherRoute = right.owner.openUnreliableWebRtcRoute("zone:other");
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(1))).toBe(true);
		await tick();
		expect(otherRoute.snapshot()).toMatchObject({ received: 0, unknownRouteDrops: 1 });

		bus.disconnect(pair);
		expect(leftRoute.snapshot()).toMatchObject({ activeLinks: 1, authenticatedConnectionLosses: 1 });
		expect(left.peerConnections.every(({ connectionState }) => connectionState === "connected")).toBe(true);
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(2))).toBe(true);

		pair = bus.connect("peer-a", "peer-b");
		const alphaRoute = right.owner.openUnreliableWebRtcRoute("zone:alpha");
		const received: Uint8Array[] = [];
		alphaRoute.onMessage(({ bytes }) => received.push(bytes.slice()));
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(3))).toBe(true);
		await tick();
		expect(received).toEqual([Uint8Array.of(3)]);
		await vi.waitFor(() => expect(leftRoute.snapshot().links[0]).toMatchObject({ generation: pair.left.generation }));
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(30))).toBe(true);
		await tick();
		expect(received).toEqual([Uint8Array.of(3), Uint8Array.of(30)]);
		expect(leftRoute.snapshot().links[0]).toMatchObject({ generation: pair.left.generation });
		expect(left.peerConnections[0]?.connectionState).toBe("closed");

		const retainedPeerConnection = left.peerConnections.at(-1);
		bus.disconnect(pair);
		pair = bus.connect("peer-a", "peer-b");
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(4))).toBe(true);
		await tick();
		expect(received).toEqual([Uint8Array.of(3), Uint8Array.of(30), Uint8Array.of(4)]);
		await vi.waitFor(() => expect(leftRoute.snapshot().links[0]).toMatchObject({ generation: pair.left.generation }));
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(40))).toBe(true);
		await tick();
		expect(leftRoute.snapshot()).toMatchObject({ activeLinks: 1, links: [{ generation: pair.left.generation }] });
		expect(retainedPeerConnection?.connectionState).toBe("closed");
		expect(received).toEqual([Uint8Array.of(3), Uint8Array.of(30), Uint8Array.of(4), Uint8Array.of(40)]);

		const staleBus = new FakeSignalingBus();
		const staleLeft = owner(module, staleBus, "peer-a");
		const staleRight = owner(module, staleBus, "peer-b");
		staleRight.owner.openUnreliableWebRtcRoute("zone:alpha");
		const stalePair = staleBus.connect("peer-a", "peer-b");
		const barrier = staleBus.pauseResponses();
		const staleRoute = staleLeft.owner.openUnreliableWebRtcRoute("zone:alpha");
		const staleSend = staleRoute.send(["peer-b"], Uint8Array.of(4));
		await barrier.waitUntilPending();
		staleBus.disconnect(stalePair);
		const replacement = staleBus.connect("peer-a", "peer-b");
		barrier.release();
		expect(await staleSend).toBe(false);
		expect(staleRoute.snapshot().activeLinks).toBe(0);
		expect(await staleRoute.send(["peer-b"], Uint8Array.of(5))).toBe(true);
		expect(staleRoute.snapshot().links[0]).toMatchObject({ generation: replacement.left.generation });

		staleLeft.owner.close();
		expect(staleRoute.snapshot().activeLinks).toBe(0);
		expect(staleLeft.peerConnections.every(({ connectionState }) => connectionState === "closed")).toBe(true);
		expect(await staleRoute.send(["peer-b"], Uint8Array.of(6))).toBe(false);
	});
});

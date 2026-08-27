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
	binaryType: BinaryType = "blob";
	bufferedAmount = 0;
	readonly label: string;
	readonly maxRetransmits: number | null;
	readonly ordered: boolean;
	onclose: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState: RTCDataChannelState = "connecting";
	readonly sent: Uint8Array[] = [];
	#peer?: FakeDataChannel;
	readonly #listeners = new Map<string, Set<Listener>>();

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
		this.readyState = "closed";
		this.#emit("close", new Event("close"));
		if (this.#peer?.readyState !== "closed") this.#peer?.close();
	}

	link(peer: FakeDataChannel): void {
		this.#peer = peer;
		this.readyState = "open";
		queueMicrotask(() => this.#emit("open", new Event("open")));
	}

	send(data: ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== "open" || this.#peer?.readyState !== "open") throw new Error("fake data channel closed");
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data.slice(0))
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
		this.sent.push(bytes);
		const peer = this.#peer;
		queueMicrotask(() => {
			if (peer !== undefined) {
				const delivered = peer.binaryType === "arraybuffer" ? bytes.buffer : new Blob([bytes]);
				peer.#emit("message", new MessageEvent("message", { data: delivered }));
			}
		});
	}

	#emit(type: string, event: Event): void {
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

class FakePeerConnection {
	static nextId = 1;
	static readonly registry = new Map<string, FakePeerConnection>();

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

	setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
		this.remoteDescription = description as RTCSessionDescription;
		const remoteId = /a=mid:(pc-\d+)/u.exec(description.sdp ?? "")?.[1];
		const remote = remoteId === undefined ? undefined : FakePeerConnection.registry.get(remoteId);
		if (remote === undefined) return Promise.reject(new TypeError("fake remote peer connection missing"));
		this.connectionState = "connected";
		remote.connectionState = "connected";
		if (description.type === "offer") {
			for (const outbound of remote.channels) {
				const inbound = new FakeDataChannel(this.#options.inboundChannel?.label ?? outbound.label, {
					maxRetransmits: this.#options.inboundChannel?.maxRetransmits ?? outbound.maxRetransmits ?? undefined,
					ordered: this.#options.inboundChannel?.ordered ?? outbound.ordered,
				});
				outbound.link(inbound);
				inbound.link(outbound);
				this.channels.push(inbound);
				this.#emit(
					"datachannel",
					Object.assign(new Event("datachannel"), { channel: inbound as unknown as RTCDataChannel })
				);
			}
		}
		this.#emit("connectionstatechange", new Event("connectionstatechange"));
		remote.#emit("connectionstatechange", new Event("connectionstatechange"));
		return Promise.resolve();
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
				exchange: async (request): Promise<Uint8Array> => {
					if (closed || remote.handler === undefined) throw new Error("fake signaling handler missing");
					this.exchangeRecords.push({
						connectionId: id,
						generation,
						remoteAddr: `/webrtc/${remotePeerId}`,
						remotePeerId,
					});
					const response = await remote.handler(reverse(), this.requestTransform(request.slice()));
					this.#resolvePendingObserved?.();
					if (this.#pendingResponse !== undefined) await this.#pendingResponse;
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

	pauseResponses(): Readonly<{ release(): void; waitUntilPending(): Promise<void> }> {
		this.#pendingResponse = new Promise<void>((resolve) => {
			this.#releaseResponse = resolve;
		});
		this.#pendingObserved = new Promise<void>((resolve) => {
			this.#resolvePendingObserved = resolve;
		});
		return {
			release: (): void => {
				this.#releaseResponse?.();
				this.#pendingResponse = undefined;
				this.#releaseResponse = undefined;
			},
			waitUntilPending: (): Promise<void> => this.#pendingObserved ?? Promise.resolve(),
		};
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

function tick(): Promise<void> {
	return new Promise<void>((resolve) => queueMicrotask(resolve));
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
		const wire = left.peerConnections[0]?.channels[0]?.sent[0];
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

	it("caps sibling links at eight and rejects a ninth without allocating it", async () => {
		const module = await loadOwnerModule();
		const bus = new FakeSignalingBus();
		const center = owner(module, bus, "peer-00");
		const centerRoute = center.owner.openUnreliableWebRtcRoute("zone:alpha");
		for (let index = 1; index <= 9; index += 1) {
			const peerId = `peer-${String(index).padStart(2, "0")}`;
			const remote = owner(module, bus, peerId);
			remote.owner.openUnreliableWebRtcRoute("zone:alpha");
			bus.connect("peer-00", peerId);
			expect(await centerRoute.send([peerId], Uint8Array.of(index))).toBe(index <= 8);
		}
		expect(center.peerConnections).toHaveLength(8);
		expect(centerRoute.snapshot().activeLinks).toBe(8);
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

	it.each([
		["initiator", "peer-b"],
		["non-initiator", "peer-a"],
	] as const)(
		"retires a disappeared authenticated link before replacement setup as the %s",
		async (role, remotePeerId) => {
			const module = await loadOwnerModule();
			const bus = new FakeSignalingBus();
			const low = owner(module, bus, "peer-a");
			const high = owner(module, bus, "peer-b");
			let pending: Promise<void> | undefined;
			let barrier: ReturnType<FakeSignalingBus["pauseResponses"]> | undefined;
			try {
				const local = role === "initiator" ? low : high;
				const remote = role === "initiator" ? high : low;
				const original = bus.connect("peer-a", "peer-b");
				const lowRoute = low.owner.openUnreliableWebRtcRoute("zone:alpha");
				const highRoute = high.owner.openUnreliableWebRtcRoute("zone:alpha");
				const localRoute = role === "initiator" ? lowRoute : highRoute;
				const remoteRoute = role === "initiator" ? highRoute : lowRoute;
				const received: Uint8Array[] = [];
				remoteRoute.onMessage(({ bytes }) => received.push(bytes.slice()));
				await Promise.all([lowRoute.reconcile(["peer-b"]), highRoute.reconcile(["peer-a"])]);
				expect(localRoute.snapshot()).toMatchObject({ activeLinks: 1, lastLinkDrop: undefined, linkDrops: 0 });

				bus.disconnect(original);
				const replacement = bus.connect("peer-a", "peer-b");
				if (role === "initiator") {
					barrier = bus.pauseResponses();
					pending = localRoute.reconcile([remotePeerId]);
					await barrier.waitUntilPending();
				} else {
					await localRoute.reconcile([remotePeerId]);
				}
				expect(local.peerConnections[0]?.connectionState).toBe("closed");
				expect(localRoute.snapshot()).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 1,
					lastLinkDrop: "replacement",
					linkDrops: 1,
					links: [],
					sent: 0,
				});

				if (role === "non-initiator") {
					barrier = bus.pauseResponses();
					pending = lowRoute.reconcile(["peer-b"]);
					await barrier.waitUntilPending();
				}
				barrier?.release();
				await pending;
				const localReplacement = role === "initiator" ? replacement.left : replacement.right;
				expect(localRoute.snapshot()).toMatchObject({
					activeLinks: 1,
					lastLinkDrop: "replacement",
					linkDrops: 1,
					links: [{ connectionId: localReplacement.id, generation: localReplacement.generation }],
				});
				expect(await localRoute.send([remotePeerId], Uint8Array.of(9))).toBe(true);
				await tick();
				expect(received).toEqual([Uint8Array.of(9)]);

				bus.disconnect(replacement);
				bus.connect("peer-a", "peer-b");
				bus.responseTransform = (): Uint8Array => Uint8Array.of(255, 0, 255);
				await localRoute.reconcile([remotePeerId]);
				expect(localRoute.snapshot()).toMatchObject({
					activeLinks: 0,
					authenticatedConnectionLosses: 2,
					handshakeFailures: role === "initiator" ? 1 : 0,
					lastLinkDrop: "replacement",
					linkDrops: 2,
					links: [],
				});
				expect(local.signaling.connections()).toHaveLength(1);
				expect(remote.signaling.connections()).toHaveLength(1);
			} finally {
				barrier?.release();
				await pending?.catch(() => undefined);
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
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(3))).toBe(false);
		await vi.waitFor(() => expect(leftRoute.snapshot().links[0]).toMatchObject({ generation: pair.left.generation }));
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(3))).toBe(true);
		await tick();
		expect(received).toEqual([Uint8Array.of(3)]);
		expect(leftRoute.snapshot().links[0]).toMatchObject({ generation: pair.left.generation });
		expect(left.peerConnections[0]?.connectionState).toBe("closed");

		const retainedPeerConnection = left.peerConnections.at(-1);
		bus.disconnect(pair);
		pair = bus.connect("peer-a", "peer-b");
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(4))).toBe(false);
		await vi.waitFor(() => expect(leftRoute.snapshot().links[0]).toMatchObject({ generation: pair.left.generation }));
		expect(await leftRoute.send(["peer-b"], Uint8Array.of(4))).toBe(true);
		await tick();
		expect(leftRoute.snapshot()).toMatchObject({ activeLinks: 1, links: [{ generation: pair.left.generation }] });
		expect(retainedPeerConnection?.connectionState).toBe("closed");
		expect(received).toEqual([Uint8Array.of(3), Uint8Array.of(4)]);

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

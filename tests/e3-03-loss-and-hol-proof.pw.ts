import { type CDPSession, expect, type Page, test, type TestInfo } from "@playwright/test";

const BROWSER_VERSION = "151.0.7922.34";
const CALIBRATION_LOSS_PERCENT = 100;
const CAMPAIGN_LOSS_PERCENT = 30;
const LATENCY_MS = 40;
const PACKET_QUEUE_LENGTH = 10;
const PRELIMINARY_RAW_DELIVERY_FLOOR = 100;
const SAMPLE_COUNT = 600;
const SAMPLE_INTERVAL_MS = 33;
const SAMPLE_PAYLOAD_BYTES = 256;
const RELIABLE_SENTINEL_BYTES = 12_000;
const RELIABLE_OBSERVATION_TAIL_MS = 15_000;
const TRIAL_COUNT = 3;

interface FabricObservation {
	readonly byteLength: number;
	readonly lane: "raw" | "reliable";
	readonly receivedAtMs: number;
	readonly sentAtMs: number;
	readonly sequence: number;
	readonly sentinel: boolean;
}

interface FabricTransportEvidence {
	readonly fallbackCount: 0;
	readonly raw: readonly Readonly<{
		readonly connectionId: string;
		readonly generation: number;
		readonly iceRestarts: 0;
		readonly maxRetransmits: 0;
		readonly ordered: false;
		readonly peerId: string;
		readonly remoteAddr: string;
		readonly readyState: "open";
	}>[];
}

interface FabricTrialSnapshot {
	readonly attempted: Readonly<{ readonly raw: number; readonly reliable: number }>;
	readonly observations: readonly FabricObservation[];
	readonly transport: FabricTransportEvidence;
	readonly trialId: string;
}

interface FabricWorkbench {
	reset(trialId: string): Promise<void>;
	runTrial(
		input: Readonly<{
			readonly intervalMs: number;
			readonly payloadFormat: "e3-03-ascii-v1";
			readonly payloadBytes: number;
			readonly reliableSentinelBytes: number;
			readonly sampleCount: number;
			readonly trialId: string;
		}>
	): Promise<void>;
	snapshot(trialId: string): FabricTrialSnapshot;
}

interface ZoneSnapshot {
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localPeerId: string;
	readonly rawTransport: Readonly<{
		readonly authenticatedConnectionLosses: number;
		readonly backpressuredDrops: number;
		readonly fallbackCount: 0;
		readonly handshakeFailures: number;
		readonly lastLinkDrop: string;
		readonly linkDrops: number;
		readonly links: readonly Readonly<{
			readonly label: "ts-drp-ephemeral/1";
			readonly maxRetransmits: 0;
			readonly ordered: false;
			readonly peerId: string;
		}>[];
		readonly received: number;
		readonly sent: number;
	}>;
	readonly ready: boolean;
	readonly zoneId: string;
}

interface ZoneApi {
	readonly fabric?: FabricWorkbench;
	close(): Promise<void>;
	move(dx: number, dy: number): void;
	placeBlock(
		input: Readonly<{ readonly id: string; readonly kind: string; readonly x: number; readonly y: number }>
	): Promise<void>;
	snapshot(): ZoneSnapshot;
}

interface GridNetworkSnapshot {
	readonly connections: readonly Readonly<{ readonly peerId: string }>[];
	readonly peerId: string;
}

interface GridNetworkTestSession {
	readonly node: Readonly<{
		readonly networkNode: Readonly<{
			connect(addresses: readonly unknown[]): Promise<void>;
			disconnect(peerId: string): Promise<void>;
			getPeerMultiaddrs(peerId: string): Promise<readonly Readonly<{ readonly multiaddr: unknown }>[]>;
		}>;
	}>;
	snapshot(): GridNetworkSnapshot;
}

type Libp2pMonitorEventKind =
	| "connection-abort"
	| "connection-close"
	| "ping-failure"
	| "ping-read-success"
	| "ping-start"
	| "ping-stream-open"
	| "ping-write-success";

interface Libp2pMonitorObservation {
	readonly atMonotonicMs: number;
	readonly atWallMs: number;
	readonly connectionId: string;
	readonly event: Libp2pMonitorEventKind;
	readonly owner: string;
	readonly peerId: string;
	readonly reason?: string;
	readonly schemaVersion: 2;
	readonly sequence: number;
}

interface Libp2pMonitorObserver {
	reset(): void;
	snapshot(): readonly Libp2pMonitorObservation[];
}

interface NetworkSnapshot {
	readonly connections: readonly string[];
	readonly peerId: string;
}

declare global {
	interface Window {
		readonly __E303_RTC_OBSERVER__?: RtcObserver;
		readonly __E303_LIBP2P_MONITOR_OBSERVER__?: Libp2pMonitorObserver;
		readonly __TS_DRP_GRID_SESSION__?: GridNetworkTestSession;
		readonly __TS_DRP_V3_ZONE__?: ZoneApi;
	}
}

interface CampaignMetric {
	readonly clockSkewMs: number;
	readonly clockSamples: readonly number[];
	readonly rawAoIP50Ms: number;
	readonly rawAoIP95Ms: number;
	readonly rawDelivered: number;
	readonly rawGap: number;
	readonly rawMaxStallMs: number;
	readonly rawDeliveredAfterReliableStart: number;
	readonly reliableAoIP50Ms: number;
	readonly reliableAoIP95Ms: number;
	readonly reliableDelivered: number;
	readonly rendered: RenderedFabricEvidence;
	readonly trialId: string;
}

interface RtcObservation {
	readonly atMs: number;
	readonly byteLength: number;
	readonly channelId: number;
	readonly connectionId: number;
	readonly direction: "message" | "send";
	readonly insertionReadyState: RTCDataChannelState;
	readonly label: string;
	readonly maxRetransmits: number | null;
	readonly ordinal: number;
	readonly ordered: boolean;
	readonly readyState: RTCDataChannelState;
	readonly text: string;
}

type RtcLifecycleKind =
	| "answer-created"
	| "channel-close-call"
	| "channel-close-event"
	| "channel-handler-installed"
	| "channel-message"
	| "channel-message-handler-installed"
	| "channel-open-event"
	| "channel-send-attempt"
	| "channel-send-failure"
	| "channel-send-success"
	| "connection-close-call"
	| "connection-created"
	| "connection-state"
	| "ice-connection-state"
	| "ice-candidate-add"
	| "ice-gathering-state"
	| "local-description"
	| "offer-created"
	| "remote-description"
	| "signaling-state";

interface RtcLifecycleObservation {
	readonly atMonotonicMs: number;
	readonly atWallMs: number;
	readonly bufferedAmount?: number;
	readonly callsite?: string;
	readonly channelId?: number;
	readonly connectionId: number;
	readonly event: RtcLifecycleKind;
	readonly handoffId: string;
	readonly label?: string;
	readonly owner: string;
	readonly attemptId?: number;
	readonly readyState?: RTCDataChannelState;
	readonly schemaVersion: 2;
	readonly sequence: number;
	readonly state?: string;
}

interface RtcChannelStateObservation {
	readonly bufferedAmount: number;
	readonly channelId: number;
	readonly connectionId: number;
	readonly label: string;
	readonly readyState: RTCDataChannelState;
	readonly schemaVersion: 2;
}

interface RtcObserver {
	channelStateSnapshot(): readonly RtcChannelStateObservation[];
	lifecycleSnapshot(): Promise<readonly RtcLifecycleObservation[]>;
	reset(): void;
	snapshot(): Promise<readonly RtcObservation[]>;
}

interface PlatformObservation extends FabricObservation {
	readonly carrierByteLength: number;
	readonly channelLabel: string;
	readonly channelId: number;
	readonly connectionId: number;
	readonly insertionReadyState: RTCDataChannelState;
	readonly maxRetransmits: number | null;
	readonly ordered: boolean;
	readonly ordinal: number;
	readonly readyState: RTCDataChannelState;
}

interface ReceiverEvidencePartition {
	readonly productAccepted: readonly PlatformObservation[];
	readonly productRejected: readonly PlatformObservation[];
}

interface RenderedFabricEvidence {
	readonly maxGap: number;
	readonly rawAoIP50Ms: number;
	readonly rawAoIP95Ms: number;
	readonly rawDelivered: number;
	readonly rawDropped: number;
	readonly reliableAoIP50Ms: number;
	readonly reliableAoIP95Ms: number;
	readonly reliableDelivered: number;
	readonly reliableDropped: number;
}

interface AcceptedObservationIdentity {
	readonly channelId: number;
	readonly connectionId: number;
	readonly insertionReadyState: RTCDataChannelState;
	readonly lane: FabricObservation["lane"];
	readonly ordinal: number;
	readonly readyState: RTCDataChannelState;
	readonly receivedAtMs: number;
	readonly sentAtMs: number;
	readonly sequence: number;
	readonly sentinel: boolean;
}

interface ChannelSequenceEvidence {
	readonly channelId: number;
	readonly connectionId: number;
	readonly lane: FabricObservation["lane"];
	readonly monotonic: boolean;
}

interface CampaignEvidence {
	readonly acceptedObservationIdentities: readonly AcceptedObservationIdentity[];
	readonly application: Readonly<{
		readonly rawAoIP50Ms: number;
		readonly rawAoIP95Ms: number;
		readonly rawDelivered: number;
		readonly rawDeliveredAfterReliableStart: number;
		readonly rawGap: number;
		readonly rawMaxStallMs: number;
		readonly reliableAoIP50Ms: number;
		readonly reliableAoIP95Ms: number;
		readonly reliableDelivered: number;
	}>;
	readonly perChannelMonotonicity: readonly ChannelSequenceEvidence[];
	readonly rawArrivalInversionCount: number;
	readonly clockSamples: readonly number[];
	readonly clockSkewMs: number;
	readonly completeObserverRawGap: number;
	readonly lexicographicRole: Readonly<{
		readonly creatorPeerId: string;
		readonly initiator: "creator" | "receiver";
		readonly receiverPeerId: string;
	}>;
	readonly partitionCardinalities: Readonly<{
		readonly accepted: number;
		readonly observer: number;
		readonly rejected: number;
		readonly roster: number;
	}>;
	readonly productRejected: readonly PlatformObservation[];
	readonly productRoster: readonly FabricObservation[];
	readonly rawCounter: Readonly<{
		readonly after: number;
		readonly before: number;
		readonly matchedObserver: number;
		readonly productRoster: number;
	}>;
	readonly rawTransportDeltas: Readonly<{
		readonly receiver: RawTransportDelta;
		readonly sender: RawTransportDelta;
	}>;
	readonly readyStateMismatches: Readonly<{
		readonly receiver: readonly RtcObservation[];
		readonly sender: readonly RtcObservation[];
	}>;
	readonly rendered: RenderedFabricEvidence;
	readonly receiverWire: readonly PlatformObservation[];
	readonly stages: Readonly<{
		readonly deadline: TransportStageEvidence;
		readonly prepare: TransportStageEvidence;
		readonly reset: TransportStageEvidence;
		readonly runReturned: TransportStageEvidence;
	}>;
	readonly senderWire: readonly PlatformObservation[];
	readonly trialId: string;
}

interface TransportStageEvidence {
	readonly atMs: number;
	readonly creator: ZoneSnapshot["rawTransport"];
	readonly receiver: ZoneSnapshot["rawTransport"];
}

interface RawTransportDelta {
	readonly authenticatedConnectionLosses: number;
	readonly backpressuredDrops: number;
	readonly handshakeFailures: number;
	readonly lastLinkDrop: Readonly<{
		readonly after: string;
		readonly before: string;
		readonly changed: boolean;
	}>;
	readonly linkDrops: number;
}

interface D108e4hAuthenticatedIdentity {
	readonly connectionId: string;
	readonly generation: number;
	readonly peerId: string;
}

interface D108e4hRtcIdentity {
	readonly channelId: number;
	readonly connectionId: number;
	readonly label: "ts-drp-ephemeral/1";
	readonly readyState: RTCDataChannelState;
}

interface D108e4hBoundaryCustody {
	readonly authenticated: readonly D108e4hAuthenticatedIdentity[];
	readonly rtc: readonly D108e4hRtcIdentity[];
	readonly rawTransport: ZoneSnapshot["rawTransport"];
}

interface D108e4hLifecycleObservation {
	readonly attemptId?: number;
	readonly channelId?: number;
	readonly connectionId: number;
	readonly event: RtcLifecycleKind;
	readonly owner: string;
	readonly readyState?: RTCDataChannelState;
	readonly schemaVersion: 3;
	readonly sequence: number;
	readonly trialId: string;
}

interface D108e4hMonitorObservation {
	readonly carryIn: boolean;
	readonly connectionId: string;
	readonly event: Libp2pMonitorEventKind | "monitor-epoch-start";
	readonly owner: string;
	readonly peerId: string;
	readonly pingId: string;
	readonly schemaVersion: 3;
	readonly sequence: number;
	readonly trialId: string;
}

interface D108e4hRawSend {
	readonly attemptId: number;
	readonly channelId: number;
	readonly connectionId: number;
	readonly sequence: number;
}

interface D108e4hEndpointCustody {
	readonly acceptedRaw: readonly AcceptedObservationIdentity[];
	readonly deadline: D108e4hBoundaryCustody;
	readonly lifecycle: readonly D108e4hLifecycleObservation[];
	readonly monitor: readonly D108e4hMonitorObservation[];
	readonly peerId: string;
	readonly prepare: D108e4hBoundaryCustody;
	readonly rawSends: readonly D108e4hRawSend[];
	readonly rejectedRaw: readonly AcceptedObservationIdentity[];
	readonly transmitsRawTrial: boolean;
}

interface D108e4hValidationInput {
	readonly endpoints: Readonly<{
		readonly creator: D108e4hEndpointCustody;
		readonly receiver: D108e4hEndpointCustody;
	}>;
	readonly rawTransportDeltas: Readonly<{
		readonly creator: RawTransportDelta;
		readonly receiver: RawTransportDelta;
	}>;
	readonly sampleCount: number;
	readonly schemaVersion: 3;
	readonly trialId: string;
}

type NetworkProfile = Readonly<{
	readonly connectionType: "wifi";
	readonly downloadThroughput: number;
	readonly latency: number;
	readonly offline: boolean;
	readonly packetLoss: number;
	readonly packetQueueLength: number;
	readonly packetReordering: boolean;
	readonly uploadThroughput: number;
}>;

const NO_LOSS: NetworkProfile = Object.freeze({
	connectionType: "wifi" as const,
	downloadThroughput: -1,
	latency: 0,
	offline: false,
	packetLoss: 0,
	packetQueueLength: 0,
	packetReordering: false,
	uploadThroughput: -1,
});

function installRtcObserver(): void {
	type RtcData = string | Blob | ArrayBuffer | ArrayBufferView;
	const observedWindow = window as Window & { __E303_RTC_OBSERVER__?: RtcObserver };
	if (observedWindow.__E303_RTC_OBSERVER__ !== undefined) return;
	let generation = 0;
	let nextChannelId = 0;
	let nextConnectionId = 0;
	let ordinal = 0;
	let lifecycleSequence = 0;
	let nextAttemptId = 0;
	const records: RtcObservation[] = [];
	const lifecycleRecords: RtcLifecycleObservation[] = [];
	const pending = new Set<Promise<void>>();
	const watchedChannels = new Set<RTCDataChannel>();
	const channelIdentities = new WeakMap<RTCDataChannel, Readonly<{ channelId: number; connectionId: number }>>();
	const connectionIdentities = new WeakMap<RTCPeerConnection, number>();
	const callAttribution = (): Readonly<{ callsite: string; owner: string }> => {
		const stack = new Error().stack ?? "";
		const callsite =
			stack
				.split("\n")
				.map((line) => line.trim())
				.find(
					(line) =>
						line.startsWith("at ") &&
						!line.includes("callAttribution") &&
						!line.includes("RTCDataChannel.value") &&
						!line.includes("RTCPeerConnection.value")
				) ?? "at unknown";
		const normalizedCallsite = callsite
			.replaceAll(window.location.origin, "<origin>")
			.replace(/(?:<origin>\/@fs)?\/[^ )]+\/(examples|packages|tests)\//u, "<workspace>/$1/")
			.replace(/[?#][^ )]+/g, "")
			.slice(0, 240);
		return Object.freeze({
			callsite: normalizedCallsite,
			owner: normalizedCallsite.includes("unreliable-webrtc") ? "product-unreliable-webrtc" : "rtc-observer-or-harness",
		});
	};
	const recordLifecycle = (
		event: RtcLifecycleKind,
		connectionId: number,
		input: Readonly<{
			readonly attemptId?: number;
			readonly bufferedAmount?: number;
			readonly callsite?: string;
			readonly channelId?: number;
			readonly label?: string;
			readonly owner: string;
			readonly readyState?: RTCDataChannelState;
			readonly state?: string;
		}>
	): void => {
		const atMonotonicMs = performance.now();
		lifecycleRecords.push(
			Object.freeze({
				attemptId: input.attemptId,
				atMonotonicMs,
				atWallMs: Date.now(),
				bufferedAmount: input.bufferedAmount,
				callsite: input.callsite,
				channelId: input.channelId,
				connectionId,
				event,
				handoffId: `${connectionId}:${input.channelId ?? "pc"}`,
				label: input.label,
				owner: input.owner,
				readyState: input.readyState,
				schemaVersion: 2 as const,
				sequence: lifecycleSequence,
				state: input.state,
			})
		);
		lifecycleSequence += 1;
	};
	const bytesFrom = async (data: RtcData): Promise<Uint8Array> => {
		if (typeof data === "string") return new TextEncoder().encode(data);
		if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
		if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
	};
	const capture = (channel: RTCDataChannel, direction: "message" | "send", data: RtcData): void => {
		const identity = channelIdentities.get(channel);
		if (identity === undefined) throw new Error("E303_RTC_CHANNEL_IDENTITY_ABSENT");
		const selectedGeneration = generation;
		const selectedOrdinal = ordinal;
		ordinal += 1;
		const atMs = Date.now();
		const label = channel.label;
		const maxRetransmits = channel.maxRetransmits;
		const ordered = channel.ordered;
		const readyState = channel.readyState;
		const operation = bytesFrom(data)
			.then((bytes) => {
				if (selectedGeneration !== generation) return;
				records.push({
					atMs,
					byteLength: bytes.byteLength,
					channelId: identity.channelId,
					connectionId: identity.connectionId,
					direction,
					insertionReadyState: channel.readyState,
					label,
					maxRetransmits,
					ordered,
					ordinal: selectedOrdinal,
					readyState,
					text: new TextDecoder().decode(bytes),
				});
			})
			.finally(() => pending.delete(operation));
		pending.add(operation);
	};
	const watch = (channel: RTCDataChannel, connectionId: number): RTCDataChannel => {
		if (channelIdentities.has(channel)) return channel;
		const channelId = nextChannelId;
		channelIdentities.set(channel, Object.freeze({ channelId, connectionId }));
		watchedChannels.add(channel);
		nextChannelId += 1;
		recordLifecycle("channel-handler-installed", connectionId, {
			bufferedAmount: channel.bufferedAmount,
			channelId,
			label: channel.label,
			owner: "rtc-observer-datachannel-handler",
			readyState: channel.readyState,
		});
		channel.addEventListener("open", () =>
			recordLifecycle("channel-open-event", connectionId, {
				bufferedAmount: channel.bufferedAmount,
				channelId,
				label: channel.label,
				owner: "rtc-datachannel-open-event",
				readyState: channel.readyState,
			})
		);
		channel.addEventListener("close", () =>
			recordLifecycle("channel-close-event", connectionId, {
				bufferedAmount: channel.bufferedAmount,
				channelId,
				label: channel.label,
				owner: "rtc-datachannel-close-event",
				readyState: channel.readyState,
			})
		);
		channel.addEventListener("message", (event) => {
			recordLifecycle("channel-message", connectionId, {
				bufferedAmount: channel.bufferedAmount,
				channelId,
				label: channel.label,
				owner: "rtc-datachannel-message-event",
				readyState: channel.readyState,
			});
			capture(channel, "message", event.data as RtcData);
		});
		return channel;
	};
	const NativePeerConnection = window.RTCPeerConnection;
	const nativeCreateDataChannel = NativePeerConnection.prototype.createDataChannel;
	const nativeCreateAnswer = NativePeerConnection.prototype.createAnswer;
	const nativeCreateOffer = NativePeerConnection.prototype.createOffer;
	const nativeAddIceCandidate = NativePeerConnection.prototype.addIceCandidate;
	const nativeSetLocalDescription = NativePeerConnection.prototype.setLocalDescription;
	const nativeSetRemoteDescription = NativePeerConnection.prototype.setRemoteDescription;
	const nativePeerConnectionClose = NativePeerConnection.prototype.close;
	const nativeDataChannelAddEventListener = RTCDataChannel.prototype.addEventListener;
	const nativeDataChannelClose = RTCDataChannel.prototype.close;
	Object.defineProperty(RTCDataChannel.prototype, "addEventListener", {
		configurable: true,
		value(
			this: RTCDataChannel,
			type: string,
			listener: EventListenerOrEventListenerObject | null,
			options?: boolean | AddEventListenerOptions
		): void {
			const identity = channelIdentities.get(this);
			if (type === "message" && identity !== undefined) {
				const attribution = callAttribution();
				recordLifecycle("channel-message-handler-installed", identity.connectionId, {
					...attribution,
					bufferedAmount: this.bufferedAmount,
					channelId: identity.channelId,
					label: this.label,
					readyState: this.readyState,
				});
			}
			Reflect.apply(nativeDataChannelAddEventListener, this, [type, listener, options]);
		},
		writable: true,
	});
	Object.defineProperty(NativePeerConnection.prototype, "createDataChannel", {
		configurable: true,
		value(this: RTCPeerConnection, label: string, options?: RTCDataChannelInit): RTCDataChannel {
			const channel = nativeCreateDataChannel.call(this, label, options);
			const connectionId = connectionIdentities.get(this);
			return connectionId === undefined ? channel : watch(channel, connectionId);
		},
		writable: true,
	});
	const nativeSend = RTCDataChannel.prototype.send;
	Object.defineProperty(RTCDataChannel.prototype, "send", {
		configurable: true,
		value(this: RTCDataChannel, data: RtcData): void {
			const identity = channelIdentities.get(this);
			if (identity === undefined) {
				Reflect.apply(nativeSend, this, [data]);
				return;
			}
			const attemptId = nextAttemptId;
			nextAttemptId += 1;
			recordLifecycle("channel-send-attempt", identity.connectionId, {
				attemptId,
				bufferedAmount: this.bufferedAmount,
				channelId: identity.channelId,
				label: this.label,
				owner: "rtc-datachannel-send",
				readyState: this.readyState,
			});
			capture(this, "send", data);
			try {
				Reflect.apply(nativeSend, this, [data]);
				recordLifecycle("channel-send-success", identity.connectionId, {
					attemptId,
					bufferedAmount: this.bufferedAmount,
					channelId: identity.channelId,
					label: this.label,
					owner: "rtc-datachannel-send",
					readyState: this.readyState,
				});
			} catch (error) {
				recordLifecycle("channel-send-failure", identity.connectionId, {
					attemptId,
					bufferedAmount: this.bufferedAmount,
					channelId: identity.channelId,
					label: this.label,
					owner: error instanceof Error ? error.name : "rtc-datachannel-send-error",
					readyState: this.readyState,
				});
				throw error;
			}
		},
		writable: true,
	});
	Object.defineProperty(RTCDataChannel.prototype, "close", {
		configurable: true,
		value(this: RTCDataChannel): void {
			const identity = channelIdentities.get(this);
			if (identity !== undefined) {
				const attribution = callAttribution();
				recordLifecycle("channel-close-call", identity.connectionId, {
					...attribution,
					bufferedAmount: this.bufferedAmount,
					channelId: identity.channelId,
					label: this.label,
					readyState: this.readyState,
				});
			}
			Reflect.apply(nativeDataChannelClose, this, []);
		},
		writable: true,
	});
	Object.defineProperty(NativePeerConnection.prototype, "close", {
		configurable: true,
		value(this: RTCPeerConnection): void {
			const connectionId = connectionIdentities.get(this);
			if (connectionId !== undefined) {
				const attribution = callAttribution();
				recordLifecycle("connection-close-call", connectionId, {
					...attribution,
					state: this.connectionState,
				});
			}
			Reflect.apply(nativePeerConnectionClose, this, []);
		},
		writable: true,
	});
	const wrapDescriptionFactory = (
		method: "createAnswer" | "createOffer",
		nativeMethod: typeof nativeCreateAnswer | typeof nativeCreateOffer,
		event: "answer-created" | "offer-created"
	): void => {
		Object.defineProperty(NativePeerConnection.prototype, method, {
			configurable: true,
			async value(
				this: RTCPeerConnection,
				options?: RTCAnswerOptions & RTCOfferOptions
			): Promise<RTCSessionDescriptionInit> {
				const description = await Reflect.apply(nativeMethod, this, [options]);
				const connectionId = connectionIdentities.get(this);
				if (connectionId !== undefined) {
					recordLifecycle(event, connectionId, {
						owner: "rtc-peerconnection-signaling",
						state: description.type,
					});
				}
				return description;
			},
			writable: true,
		});
	};
	wrapDescriptionFactory("createAnswer", nativeCreateAnswer, "answer-created");
	wrapDescriptionFactory("createOffer", nativeCreateOffer, "offer-created");
	Object.defineProperty(NativePeerConnection.prototype, "setLocalDescription", {
		configurable: true,
		async value(this: RTCPeerConnection, description?: RTCLocalSessionDescriptionInit): Promise<void> {
			await Reflect.apply(nativeSetLocalDescription, this, [description]);
			const connectionId = connectionIdentities.get(this);
			if (connectionId !== undefined) {
				recordLifecycle("local-description", connectionId, {
					owner: "rtc-peerconnection-signaling",
					state: this.localDescription?.type ?? description?.type,
				});
			}
		},
		writable: true,
	});
	Object.defineProperty(NativePeerConnection.prototype, "setRemoteDescription", {
		configurable: true,
		async value(this: RTCPeerConnection, description: RTCSessionDescriptionInit): Promise<void> {
			await Reflect.apply(nativeSetRemoteDescription, this, [description]);
			const connectionId = connectionIdentities.get(this);
			if (connectionId !== undefined) {
				recordLifecycle("remote-description", connectionId, {
					owner: "rtc-peerconnection-signaling",
					state: description.type,
				});
			}
		},
		writable: true,
	});
	Object.defineProperty(NativePeerConnection.prototype, "addIceCandidate", {
		configurable: true,
		async value(this: RTCPeerConnection, candidate?: RTCIceCandidateInit | RTCIceCandidate | null): Promise<void> {
			await Reflect.apply(nativeAddIceCandidate, this, [candidate]);
			const connectionId = connectionIdentities.get(this);
			if (connectionId !== undefined) {
				recordLifecycle("ice-candidate-add", connectionId, {
					owner: "rtc-peerconnection-signaling",
					state: candidate === null || candidate === undefined ? "complete" : "candidate",
				});
			}
		},
		writable: true,
	});
	const ObservedPeerConnection = function (
		...args: ConstructorParameters<typeof RTCPeerConnection>
	): RTCPeerConnection {
		const connection = new NativePeerConnection(...args);
		const connectionId = nextConnectionId;
		nextConnectionId += 1;
		connectionIdentities.set(connection, connectionId);
		recordLifecycle("connection-created", connectionId, {
			owner: "rtc-peerconnection-constructor",
			state: connection.connectionState,
		});
		connection.addEventListener("connectionstatechange", () =>
			recordLifecycle("connection-state", connectionId, {
				owner: "rtc-peerconnection-state-event",
				state: connection.connectionState,
			})
		);
		connection.addEventListener("iceconnectionstatechange", () =>
			recordLifecycle("ice-connection-state", connectionId, {
				owner: "rtc-peerconnection-ice-event",
				state: connection.iceConnectionState,
			})
		);
		connection.addEventListener("icegatheringstatechange", () =>
			recordLifecycle("ice-gathering-state", connectionId, {
				owner: "rtc-peerconnection-ice-gathering-event",
				state: connection.iceGatheringState,
			})
		);
		connection.addEventListener("signalingstatechange", () =>
			recordLifecycle("signaling-state", connectionId, {
				owner: "rtc-peerconnection-signaling-event",
				state: connection.signalingState,
			})
		);
		connection.addEventListener("datachannel", (event) => watch(event.channel, connectionId));
		return connection;
	} as unknown as typeof RTCPeerConnection;
	Object.setPrototypeOf(ObservedPeerConnection, NativePeerConnection);
	ObservedPeerConnection.prototype = NativePeerConnection.prototype;
	Object.defineProperty(window, "RTCPeerConnection", {
		configurable: true,
		value: ObservedPeerConnection,
		writable: true,
	});
	Object.defineProperty(observedWindow, "__E303_RTC_OBSERVER__", {
		configurable: false,
		value: Object.freeze({
			channelStateSnapshot(): readonly RtcChannelStateObservation[] {
				return [...watchedChannels]
					.map((channel) => {
						const identity = channelIdentities.get(channel);
						if (identity === undefined) throw new Error("E303_RTC_CHANNEL_IDENTITY_ABSENT");
						return Object.freeze({
							bufferedAmount: channel.bufferedAmount,
							channelId: identity.channelId,
							connectionId: identity.connectionId,
							label: channel.label,
							readyState: channel.readyState,
							schemaVersion: 2 as const,
						});
					})
					.sort((left, right) => left.connectionId - right.connectionId || left.channelId - right.channelId);
			},
			async lifecycleSnapshot(): Promise<readonly RtcLifecycleObservation[]> {
				await Promise.all([...pending]);
				return lifecycleRecords
					.slice()
					.sort((left, right) => left.sequence - right.sequence)
					.map((record) => Object.freeze({ ...record }));
			},
			reset(): void {
				generation += 1;
				records.length = 0;
				lifecycleRecords.length = 0;
				lifecycleSequence = 0;
				nextAttemptId = 0;
			},
			async snapshot(): Promise<readonly RtcObservation[]> {
				await Promise.all([...pending]);
				return records
					.slice()
					.sort((left, right) => left.ordinal - right.ordinal)
					.map((record) => Object.freeze({ ...record }));
			},
		}),
		writable: false,
	});
}

function lossProfile(packetLoss: number): NetworkProfile {
	return Object.freeze({
		connectionType: "wifi",
		downloadThroughput: -1,
		latency: LATENCY_MS,
		offline: false,
		packetLoss,
		packetQueueLength: PACKET_QUEUE_LENGTH,
		packetReordering: true,
		uploadThroughput: -1,
	});
}

async function emulate(session: CDPSession, profile: NetworkProfile): Promise<readonly string[]> {
	const { ruleIds } = await session.send("Network.emulateNetworkConditionsByRule", {
		matchedNetworkConditions: [{ ...profile, urlPattern: "" }],
	});
	return ruleIds;
}

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => window.__TS_DRP_GRID_SESSION__ !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
	await page.waitForFunction(() => window.__TS_DRP_V3_ZONE__ !== undefined, undefined, { timeout: 10_000 });
}

async function zone(page: Page): Promise<ZoneSnapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("E303_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

async function rawReceivedAfterQuiescence(page: Page): Promise<number> {
	let previous = (await zone(page)).rawTransport.received;
	let stableReads = 0;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		const current = (await zone(page)).rawTransport.received;
		if (current === previous) {
			stableReads += 1;
			if (stableReads === 10) return current;
		} else {
			stableReads = 0;
			previous = current;
		}
	}
	throw new Error("E303_RAW_RECEIVER_DID_NOT_QUIESCE");
}

async function rawSentAfterQuiescence(page: Page): Promise<number> {
	let previous = (await zone(page)).rawTransport.sent;
	let stableReads = 0;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		const current = (await zone(page)).rawTransport.sent;
		if (current === previous) {
			stableReads += 1;
			if (stableReads === 10) return current;
		} else {
			stableReads = 0;
			previous = current;
		}
	}
	throw new Error("E303_RAW_SENDER_DID_NOT_QUIESCE");
}

async function network(page: Page): Promise<NetworkSnapshot> {
	return page.evaluate(() => {
		const session = window.__TS_DRP_GRID_SESSION__;
		if (session === undefined) throw new Error("E303_NETWORK_SESSION_ABSENT");
		const snapshot = session.snapshot();
		return {
			connections: [...new Set(snapshot.connections.map(({ peerId }) => peerId))].sort(),
			peerId: snapshot.peerId,
		};
	});
}

async function createZone(
	creator: Page,
	receiver: Page
): Promise<Readonly<{ creatorPeerId: string; durableBaseline: number; receiverPeerId: string }>> {
	const [receiverZone, creatorNetwork, receiverNetwork] = await Promise.all([
		zone(receiver),
		network(creator),
		network(receiver),
	]);
	await creator.fill("#zoneMemberEnrollment", receiverZone.enrollment);
	await creator.click("#createGrid");
	await expect.poll(async () => (await zone(creator)).ready).toBe(true);
	const created = await zone(creator);
	await receiver.fill("#gridInput", created.invite);
	await receiver.click("#joinGrid");
	await expect.poll(async () => (await zone(receiver)).zoneId).toBe(created.zoneId);
	await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
	await expect.poll(async () => (await zone(receiver)).durableVertexCount).toBe(2);
	const durableBaseline = (await zone(creator)).durableVertexCount;
	await expect
		.poll(
			async () => {
				await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.move(1, 0));
				return (await zone(receiver)).rawTransport.received;
			},
			{ intervals: [100, 250, 500, 1_000] }
		)
		.toBeGreaterThan(0);
	await expect
		.poll(async () => (await zone(creator)).rawTransport.links)
		.toEqual([
			{
				label: "ts-drp-ephemeral/1",
				maxRetransmits: 0,
				ordered: false,
				peerId: receiverNetwork.peerId,
			},
		]);
	return Object.freeze({
		creatorPeerId: creatorNetwork.peerId,
		durableBaseline,
		receiverPeerId: receiverNetwork.peerId,
	});
}

async function sendMovement(page: Page, count: number, intervalMs: number): Promise<void> {
	await page.evaluate(
		async ({ sampleCount, sampleIntervalMs }) => {
			const api = window.__TS_DRP_V3_ZONE__;
			if (api === undefined) throw new Error("E303_ZONE_API_ABSENT");
			for (let index = 0; index < sampleCount; index += 1) {
				api.move(1, 0);
				await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
			}
		},
		{ sampleCount: count, sampleIntervalMs: intervalMs }
	);
}

async function fabricSnapshot(page: Page, trialId: string): Promise<FabricTrialSnapshot> {
	return page.evaluate((selectedTrialId) => {
		const fabric = window.__TS_DRP_V3_ZONE__?.fabric;
		if (fabric === undefined) throw new Error("E303_FABRIC_WORKBENCH_ABSENT");
		return fabric.snapshot(selectedTrialId);
	}, trialId);
}

async function installLibp2pMonitorObserver(page: Page): Promise<void> {
	await page.evaluate(() => {
		if (window.__E303_LIBP2P_MONITOR_OBSERVER__ !== undefined) return;
		type StreamLike = Readonly<{
			addEventListener(type: "close" | "message", listener: (event: Event) => void): void;
			close(options?: unknown): Promise<void>;
			send(data: Uint8Array): boolean;
		}>;
		type ConnectionLike = Readonly<{
			readonly id: string;
			readonly remotePeer: Readonly<{ toString(): string }>;
			abort(error?: Error): void;
			addEventListener(type: "close", listener: () => void): void;
			newStream(protocol: string | readonly string[], options?: unknown): Promise<StreamLike>;
		}>;
		type HostLike = Readonly<{
			addEventListener(type: "connection:open", listener: (event: CustomEvent<ConnectionLike>) => void): void;
			getConnections(): readonly ConnectionLike[];
		}>;
		const session = window.__TS_DRP_GRID_SESSION__ as
			| (GridNetworkTestSession & {
					readonly node: {
						readonly networkNode: { readonly _node?: HostLike };
					};
			  })
			| undefined;
		const host = session?.node.networkNode._node;
		if (host === undefined) throw new Error("E303_LIBP2P_HOST_ABSENT");
		let sequence = 0;
		const records: Libp2pMonitorObservation[] = [];
		const wrapped = new WeakSet<object>();
		const pingInFlight = new Map<string, boolean>();
		const record = (
			connection: ConnectionLike,
			event: Libp2pMonitorEventKind,
			owner: string,
			reason?: string
		): void => {
			records.push(
				Object.freeze({
					atMonotonicMs: performance.now(),
					atWallMs: Date.now(),
					connectionId: connection.id,
					event,
					owner,
					peerId: connection.remotePeer.toString(),
					reason,
					schemaVersion: 2 as const,
					sequence,
				})
			);
			sequence += 1;
		};
		const instrument = (connection: ConnectionLike): void => {
			if (wrapped.has(connection)) return;
			wrapped.add(connection);
			const nativeAbort = connection.abort.bind(connection);
			const nativeNewStream = connection.newStream.bind(connection);
			Object.defineProperty(connection, "abort", {
				configurable: true,
				value(error?: Error): void {
					const stack = new Error().stack ?? "";
					const monitorOwned = stack.includes("connection-monitor");
					if (monitorOwned && pingInFlight.get(connection.id) === true) {
						record(connection, "ping-failure", "libp2p-connection-monitor", error?.name ?? error?.message);
						pingInFlight.delete(connection.id);
					}
					record(
						connection,
						"connection-abort",
						monitorOwned ? "libp2p-connection-monitor" : "other-owner",
						error?.name ?? error?.message
					);
					nativeAbort(error);
				},
				writable: true,
			});
			Object.defineProperty(connection, "newStream", {
				configurable: true,
				async value(protocol: string | readonly string[], options?: unknown): Promise<StreamLike> {
					const protocols = typeof protocol === "string" ? [protocol] : protocol;
					const ping = protocols.includes("/ipfs/ping/1.0.0");
					if (ping) {
						record(connection, "ping-start", "libp2p-connection-monitor");
						pingInFlight.set(connection.id, true);
					}
					try {
						const stream = await nativeNewStream(protocol, options);
						if (!ping) return stream;
						record(connection, "ping-stream-open", "libp2p-connection-monitor");
						stream.addEventListener("message", () =>
							record(connection, "ping-read-success", "libp2p-connection-monitor")
						);
						stream.addEventListener("close", () => pingInFlight.delete(connection.id));
						return new Proxy(stream, {
							get(target, property, receiver): unknown {
								if (property === "send") {
									return (data: Uint8Array): boolean => {
										const accepted = target.send(data);
										record(connection, "ping-write-success", "libp2p-connection-monitor");
										return accepted;
									};
								}
								if (property === "close") {
									return async (closeOptions?: unknown): Promise<void> => {
										await target.close(closeOptions);
										pingInFlight.delete(connection.id);
									};
								}
								const value = Reflect.get(target, property, receiver) as unknown;
								return typeof value === "function" ? value.bind(target) : value;
							},
						});
					} catch (error) {
						if (ping) {
							record(
								connection,
								"ping-failure",
								"libp2p-connection-monitor",
								error instanceof Error ? error.name : String(error)
							);
							pingInFlight.delete(connection.id);
						}
						throw error;
					}
				},
				writable: true,
			});
			connection.addEventListener("close", () => record(connection, "connection-close", "libp2p-connection"));
		};
		for (const connection of host.getConnections()) instrument(connection);
		host.addEventListener("connection:open", (event) => instrument(event.detail));
		Object.defineProperty(window, "__E303_LIBP2P_MONITOR_OBSERVER__", {
			configurable: false,
			value: Object.freeze({
				reset(): void {
					records.length = 0;
					sequence = 0;
				},
				snapshot(): readonly Libp2pMonitorObservation[] {
					return records.slice().map((record) => Object.freeze({ ...record }));
				},
			}),
			writable: false,
		});
	});
}

async function resetRtcObserver(page: Page): Promise<void> {
	await page.evaluate(() => {
		const observer = window.__E303_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
		observer.reset();
	});
}

async function rtcObservations(page: Page): Promise<readonly RtcObservation[]> {
	return page.evaluate(async () => {
		const observer = window.__E303_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
		return observer.snapshot();
	});
}

async function rtcLifecycleObservations(page: Page): Promise<readonly RtcLifecycleObservation[]> {
	return page.evaluate(async () => {
		const observer = window.__E303_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
		return observer.lifecycleSnapshot();
	});
}

async function rtcChannelStates(page: Page): Promise<readonly RtcChannelStateObservation[]> {
	return page.evaluate(() => {
		const observer = window.__E303_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
		return observer.channelStateSnapshot();
	});
}

async function libp2pMonitorObservations(page: Page): Promise<readonly Libp2pMonitorObservation[]> {
	return page.evaluate(() => {
		const observer = window.__E303_LIBP2P_MONITOR_OBSERVER__;
		if (observer === undefined) throw new Error("E303_LIBP2P_MONITOR_OBSERVER_ABSENT");
		return observer.snapshot();
	});
}

async function receiverEvidenceAtDeadline(
	page: Page,
	trialId: string
): Promise<
	Readonly<{
		readonly fabric: FabricTrialSnapshot;
		readonly rtc: readonly RtcObservation[];
		readonly zone: ZoneSnapshot;
	}>
> {
	return page.evaluate(async (selectedTrialId) => {
		const api = window.__TS_DRP_V3_ZONE__;
		const fabric = api?.fabric;
		const observer = window.__E303_RTC_OBSERVER__;
		if (api === undefined || fabric === undefined) throw new Error("E303_FABRIC_WORKBENCH_ABSENT");
		if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
		const rtc = await observer.snapshot();
		return Object.freeze({ fabric: fabric.snapshot(selectedTrialId), rtc, zone: api.snapshot() });
	}, trialId);
}

function rawTransportDelta(
	before: ZoneSnapshot["rawTransport"],
	after: ZoneSnapshot["rawTransport"]
): RawTransportDelta {
	return Object.freeze({
		authenticatedConnectionLosses: after.authenticatedConnectionLosses - before.authenticatedConnectionLosses,
		backpressuredDrops: after.backpressuredDrops - before.backpressuredDrops,
		handshakeFailures: after.handshakeFailures - before.handshakeFailures,
		lastLinkDrop: Object.freeze({
			after: after.lastLinkDrop,
			before: before.lastLinkDrop,
			changed: after.lastLinkDrop !== before.lastLinkDrop,
		}),
		linkDrops: after.linkDrops - before.linkDrops,
	});
}

function transportStageEvidence(
	atMs: number,
	creator: ZoneSnapshot["rawTransport"],
	receiver: ZoneSnapshot["rawTransport"]
): TransportStageEvidence {
	return Object.freeze({ atMs, creator, receiver });
}

function platformObservations(
	records: readonly RtcObservation[],
	direction: RtcObservation["direction"],
	trialId: string
): readonly PlatformObservation[] {
	const marker = /E303\|([a-z0-9-]+)\|(raw|reliable)\|([0-9]+)\|([0-9]+)\|([01])\|x*\|E303END/gu;
	const observations: PlatformObservation[] = [];
	for (const record of records) {
		if (record.direction !== direction) continue;
		const matches = [...record.text.matchAll(marker)].filter((match) => match[1] === trialId);
		if (matches.length === 0) continue;
		if (matches.length !== 1) throw new Error("E303_MULTIPLE_MARKERS_PER_RTC_MESSAGE");
		const match = matches[0];
		if (match === undefined) throw new Error("E303_PLATFORM_MARKER_ABSENT");
		const lane = match[2];
		const sequence = Number(match[3]);
		const sentAtMs = Number(match[4]);
		if ((lane !== "raw" && lane !== "reliable") || !Number.isSafeInteger(sequence) || !Number.isSafeInteger(sentAtMs)) {
			throw new Error("E303_PLATFORM_MARKER_INVALID");
		}
		observations.push(
			Object.freeze({
				byteLength: match[0].length,
				carrierByteLength: record.byteLength,
				channelId: record.channelId,
				channelLabel: record.label,
				connectionId: record.connectionId,
				insertionReadyState: record.insertionReadyState,
				lane,
				maxRetransmits: record.maxRetransmits,
				ordered: record.ordered,
				ordinal: record.ordinal,
				receivedAtMs: record.atMs,
				readyState: record.readyState,
				sentAtMs,
				sequence,
				sentinel: match[5] === "1",
			})
		);
	}
	return observations;
}

function expectRawReceiverSamples(observations: readonly PlatformObservation[]): readonly PlatformObservation[] {
	const samples = observations.filter(({ lane, sentinel }) => lane === "raw" && !sentinel);
	expect(new Set(samples.map(({ sequence }) => sequence)).size).toBe(samples.length);
	expect(samples.every(({ sequence }) => sequence >= 0 && sequence < SAMPLE_COUNT)).toBe(true);
	return samples;
}

function expectRawSenderSamples(observations: readonly PlatformObservation[]): readonly PlatformObservation[] {
	const samples = observations.filter(({ lane, sentinel }) => lane === "raw" && !sentinel);
	expect(samples.length).toBeGreaterThanOrEqual(PRELIMINARY_RAW_DELIVERY_FLOOR);
	expect(samples.length).toBeLessThanOrEqual(SAMPLE_COUNT);
	expect(new Set(samples.map(({ sequence }) => sequence)).size).toBe(samples.length);
	expect(samples.every(({ sequence }) => sequence >= 0 && sequence < SAMPLE_COUNT)).toBe(true);
	return samples;
}

function expectReliableReceiverSamples(observations: readonly PlatformObservation[]): void {
	const wireSamples = observations.filter(({ lane, sentinel }) => lane === "reliable" && !sentinel);
	expect(wireSamples.length).toBeGreaterThan(0);
	expect(wireSamples.map(({ sequence }) => sequence)).toEqual(
		[...wireSamples].map(({ sequence }) => sequence).sort((a, b) => a - b)
	);
	expect(wireSamples.every(({ sequence }) => sequence >= 0 && sequence < SAMPLE_COUNT)).toBe(true);
}

function firstReliableBySequence(observations: readonly PlatformObservation[]): readonly PlatformObservation[] {
	const firstBySequence = new Map<number, PlatformObservation>();
	for (const sample of observations) {
		if (sample.lane !== "reliable" || sample.sentinel) continue;
		if (!firstBySequence.has(sample.sequence)) firstBySequence.set(sample.sequence, sample);
	}
	const logicalSamples = [...firstBySequence.values()];
	expect(logicalSamples.length).toBeLessThan(SAMPLE_COUNT);
	return logicalSamples;
}

function expectReliableSenderSamples(observations: readonly PlatformObservation[]): readonly PlatformObservation[] {
	const samples = observations.filter(({ lane, sentinel }) => lane === "reliable" && !sentinel);
	expect(samples.length).toBeGreaterThan(0);
	expect(samples.length).toBeLessThanOrEqual(SAMPLE_COUNT);
	expect(new Set(samples.map(({ sequence }) => sequence)).size).toBe(samples.length);
	expect(samples.map(({ sequence }) => sequence)).toEqual(
		[...samples].map(({ sequence }) => sequence).sort((a, b) => a - b)
	);
	expect(samples.every(({ sequence }) => sequence >= 0 && sequence < SAMPLE_COUNT)).toBe(true);
	return samples;
}

function partitionReceiverEvidence(
	observations: readonly PlatformObservation[],
	productRoster: readonly FabricObservation[]
): ReceiverEvidencePartition {
	const key = ({ lane, sentAtMs, sequence }: FabricObservation): string => `${lane}|${sequence}|${sentAtMs}`;
	const remaining = new Map<string, number>();
	for (const productObservation of productRoster) {
		const productKey = key(productObservation);
		remaining.set(productKey, (remaining.get(productKey) ?? 0) + 1);
	}
	const productAccepted: PlatformObservation[] = [];
	const productRejected: PlatformObservation[] = [];
	for (const observation of observations) {
		const observationKey = key(observation);
		const count = remaining.get(observationKey) ?? 0;
		if (count === 0) {
			productRejected.push(observation);
			continue;
		}
		productAccepted.push(observation);
		if (count === 1) remaining.delete(observationKey);
		else remaining.set(observationKey, count - 1);
	}
	if (remaining.size !== 0) throw new Error("E303_PRODUCT_ROSTER_UNMATCHED");
	return Object.freeze({
		productAccepted: Object.freeze(productAccepted),
		productRejected: Object.freeze(productRejected),
	});
}

function acceptedObservationIdentity(observation: PlatformObservation): AcceptedObservationIdentity {
	return Object.freeze({
		channelId: observation.channelId,
		connectionId: observation.connectionId,
		insertionReadyState: observation.insertionReadyState,
		lane: observation.lane,
		ordinal: observation.ordinal,
		readyState: observation.readyState,
		receivedAtMs: observation.receivedAtMs,
		sentAtMs: observation.sentAtMs,
		sequence: observation.sequence,
		sentinel: observation.sentinel,
	});
}

function arrivalInversionCount(observations: readonly PlatformObservation[]): number {
	let inversions = 0;
	let previousSequence: number | undefined;
	for (const observation of observations) {
		if (observation.lane !== "raw" || observation.sentinel) continue;
		if (previousSequence !== undefined && observation.sequence < previousSequence) inversions += 1;
		previousSequence = observation.sequence;
	}
	return inversions;
}

function channelSequenceEvidence(observations: readonly PlatformObservation[]): readonly ChannelSequenceEvidence[] {
	const channels = new Map<
		string,
		{
			channelId: number;
			connectionId: number;
			lane: FabricObservation["lane"];
			monotonic: boolean;
			previousSequence: number | undefined;
		}
	>();
	for (const observation of observations) {
		if (observation.sentinel) continue;
		const key = `${observation.lane}|${observation.connectionId}|${observation.channelId}`;
		const channel = channels.get(key) ?? {
			channelId: observation.channelId,
			connectionId: observation.connectionId,
			lane: observation.lane,
			monotonic: true,
			previousSequence: undefined,
		};
		if (channel.previousSequence !== undefined && observation.sequence < channel.previousSequence) {
			channel.monotonic = false;
		}
		channel.previousSequence = observation.sequence;
		channels.set(key, channel);
	}
	return Object.freeze(
		[...channels.values()]
			.map(({ channelId, connectionId, lane, monotonic }) =>
				Object.freeze({ channelId, connectionId, lane, monotonic })
			)
			.sort(
				(left, right) =>
					left.connectionId - right.connectionId ||
					left.channelId - right.channelId ||
					(left.lane < right.lane ? -1 : left.lane > right.lane ? 1 : 0)
			)
	);
}

function productRosterFromSnapshot(snapshot: FabricTrialSnapshot): readonly FabricObservation[] {
	if (!Array.isArray(snapshot.observations)) throw new Error("E303_FABRIC_OBSERVATIONS_ABSENT");
	return snapshot.observations;
}

function acceptedSequencedObservations<Observation extends FabricObservation>(
	observations: readonly Observation[]
): readonly Observation[] {
	const accepted: Observation[] = [];
	let watermark = -1;
	for (const observation of observations) {
		if (observation.sequence <= watermark) continue;
		watermark = observation.sequence;
		accepted.push(observation);
	}
	return accepted;
}

async function clockEvidence(
	left: Page,
	right: Page
): Promise<Readonly<{ readonly maximumSkewMs: number; readonly samples: readonly number[] }>> {
	const samples: number[] = [];
	for (let index = 0; index < 8; index += 1) {
		const [leftNow, rightNow] = await Promise.all([left.evaluate(() => Date.now()), right.evaluate(() => Date.now())]);
		samples.push(Math.abs(leftNow - rightNow));
	}
	return Object.freeze({ maximumSkewMs: Math.max(...samples), samples: Object.freeze(samples) });
}

function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) throw new Error("E303_AOI_SERIES_EMPTY");
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
}

function ageOfInformation(
	observations: readonly FabricObservation[],
	startedAtMs: number,
	deadlineMs: number,
	intervalMs: number
): readonly number[] {
	const delivered = observations
		.filter(({ sentinel }) => !sentinel)
		.sort((left, right) => left.receivedAtMs - right.receivedAtMs);
	const ages: number[] = [];
	let cursor = 0;
	let freshestSentAt = startedAtMs;
	for (let sampledAt = startedAtMs; sampledAt <= deadlineMs; sampledAt += intervalMs) {
		while (cursor < delivered.length && (delivered[cursor]?.receivedAtMs ?? Number.POSITIVE_INFINITY) <= sampledAt) {
			freshestSentAt = Math.max(freshestSentAt, delivered[cursor]?.sentAtMs ?? freshestSentAt);
			cursor += 1;
		}
		ages.push(sampledAt - freshestSentAt);
	}
	return ages;
}

function renderedProductRosterMetrics(
	observations: readonly FabricObservation[],
	deadlineMs: number,
	intervalMs: number,
	sampleCount: number
): RenderedFabricEvidence {
	const accepted = observations.filter(({ sentinel }) => !sentinel);
	if (accepted.length === 0) throw new Error("E303_PRODUCT_ROSTER_EMPTY");
	const startedAtMs = Math.min(...accepted.map(({ sentAtMs }) => sentAtMs));
	const raw = observations.filter(({ lane, sentinel }) => lane === "raw" && !sentinel);
	const reliableBySequence = new Map<number, FabricObservation>();
	for (const observation of observations) {
		if (observation.lane !== "reliable" || observation.sentinel || reliableBySequence.has(observation.sequence)) {
			continue;
		}
		reliableBySequence.set(observation.sequence, observation);
	}
	const reliable = [...reliableBySequence.values()];
	const rawAoI = ageOfInformation(raw, startedAtMs, deadlineMs, intervalMs);
	const reliableAoI = ageOfInformation(reliable, startedAtMs, deadlineMs, intervalMs);
	const receivedRaw = [...raw].sort((left, right) => left.receivedAtMs - right.receivedAtMs);
	let maxGap = receivedRaw[0]?.sequence ?? 0;
	for (let index = 1; index < receivedRaw.length; index += 1) {
		maxGap = Math.max(maxGap, (receivedRaw[index]?.sequence ?? 0) - (receivedRaw[index - 1]?.sequence ?? 0));
	}
	return Object.freeze({
		maxGap,
		rawAoIP50Ms: percentile(rawAoI, 0.5),
		rawAoIP95Ms: percentile(rawAoI, 0.95),
		rawDelivered: raw.length,
		rawDropped: sampleCount - raw.length,
		reliableAoIP50Ms: percentile(reliableAoI, 0.5),
		reliableAoIP95Ms: percentile(reliableAoI, 0.95),
		reliableDelivered: reliable.length,
		reliableDropped: sampleCount - reliable.length,
	});
}

function productDeadlineFromRoster(
	productRoster: readonly FabricObservation[],
	intervalMs: number,
	sampleCount: number,
	tailMs: number
): number {
	const first = productRoster[0];
	if (first === undefined || first.sentinel) throw new Error("E303_PRODUCT_ROSTER_START_ABSENT");
	return first.sentAtMs - first.sequence * intervalMs + (sampleCount - 1) * intervalMs + tailMs;
}

function rawSequenceEvidence(
	observations: readonly FabricObservation[]
): Readonly<{ gap: number; maxStallMs: number }> {
	const received = observations
		.filter(({ lane, sentinel }) => lane === "raw" && !sentinel)
		.sort((left, right) => left.receivedAtMs - right.receivedAtMs);
	const sequences = [...new Set(received.map(({ sequence }) => sequence))].sort((left, right) => left - right);
	const firstSequence = sequences[0];
	const lastSequence = sequences.at(-1);
	if (firstSequence === undefined || lastSequence === undefined) return Object.freeze({ gap: 0, maxStallMs: 0 });
	let gap = firstSequence + 1;
	for (let index = 1; index < sequences.length; index += 1) {
		const previous = sequences[index - 1];
		const current = sequences[index];
		if (previous === undefined || current === undefined) continue;
		gap = Math.max(gap, current - previous);
	}
	gap = Math.max(gap, SAMPLE_COUNT - lastSequence);
	let maxStallMs = 0;
	for (let index = 1; index < received.length; index += 1) {
		const previous = received[index - 1];
		const current = received[index];
		if (previous === undefined || current === undefined) continue;
		maxStallMs = Math.max(maxStallMs, current.receivedAtMs - previous.receivedAtMs);
	}
	return Object.freeze({ gap, maxStallMs });
}

function expectOpenTransport(snapshot: FabricTrialSnapshot, remotePeerId: string): void {
	expect(snapshot.transport.fallbackCount).toBe(0);
	expect(snapshot.transport.raw).toEqual([
		expect.objectContaining({
			iceRestarts: 0,
			maxRetransmits: 0,
			ordered: false,
			peerId: remotePeerId,
			readyState: "open",
		}),
	]);
}

async function waitForOpenTransportPair(creator: Page, receiver: Page): Promise<void> {
	await expect
		.poll(
			async () => {
				const [sender, remote, senderNetwork, remoteNetwork] = await Promise.all([
					zone(creator),
					zone(receiver),
					network(creator),
					network(receiver),
				]);
				return {
					remoteAuthenticatedLosses: remote.rawTransport.authenticatedConnectionLosses,
					remoteHandshakeFailures: remote.rawTransport.handshakeFailures,
					remoteLastDrop: remote.rawTransport.lastLinkDrop,
					remoteLinkDrops: remote.rawTransport.linkDrops,
					remotePeers: remoteNetwork.connections.length,
					remoteRaw: remote.rawTransport.links.length,
					senderAuthenticatedLosses: sender.rawTransport.authenticatedConnectionLosses,
					senderHandshakeFailures: sender.rawTransport.handshakeFailures,
					senderLastDrop: sender.rawTransport.lastLinkDrop,
					senderLinkDrops: sender.rawTransport.linkDrops,
					senderPeers: senderNetwork.connections.length,
					senderRaw: sender.rawTransport.links.length,
				};
			},
			{ timeout: 10_000 }
		)
		.toEqual({
			remoteAuthenticatedLosses: expect.any(Number),
			remoteHandshakeFailures: expect.any(Number),
			remoteLastDrop: expect.any(String),
			remoteLinkDrops: expect.any(Number),
			remotePeers: expect.any(Number),
			remoteRaw: 1,
			senderAuthenticatedLosses: expect.any(Number),
			senderHandshakeFailures: expect.any(Number),
			senderLastDrop: expect.any(String),
			senderLinkDrops: expect.any(Number),
			senderPeers: expect.any(Number),
			senderRaw: 1,
		});
}

async function waitForNetworkPair(
	creator: Page,
	receiver: Page,
	creatorExpected: NetworkSnapshot,
	receiverExpected: NetworkSnapshot
): Promise<void> {
	await expect
		.poll(async () => Promise.all([network(creator), network(receiver)]), { timeout: 15_000 })
		.toEqual([creatorExpected, receiverExpected]);
}

async function waitForRawDelivery(sender: Page, receiver: Page): Promise<void> {
	const before = (await zone(receiver)).rawTransport.received;
	await expect
		.poll(
			async () => {
				await sender.evaluate(() => window.__TS_DRP_V3_ZONE__?.move(0, 0));
				await new Promise((resolve) => setTimeout(resolve, 100));
				return (await zone(receiver)).rawTransport.received - before;
			},
			{ timeout: 10_000 }
		)
		.toBeGreaterThan(0);
	let previous = await Promise.all([zone(sender), zone(receiver)]).then(([left, right]) => [
		left.rawTransport.sent,
		right.rawTransport.received,
	]);
	let stableReads = 0;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		const current = await Promise.all([zone(sender), zone(receiver)]).then(([left, right]) => [
			left.rawTransport.sent,
			right.rawTransport.received,
		]);
		if (current[0] === previous[0] && current[1] === previous[1]) {
			stableReads += 1;
			if (stableReads === 5) return;
		} else {
			stableReads = 0;
			previous = current;
		}
	}
	throw new Error("E303_RAW_READINESS_DID_NOT_QUIESCE");
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
	await testInfo.attach(name, { body: JSON.stringify(value, undefined, 2), contentType: "application/json" });
}

function diagnosticError(
	error: unknown
): Readonly<{ readonly message: string; readonly name: string; readonly stack?: string }> {
	if (error instanceof Error) {
		return Object.freeze({
			message: error.message,
			name: error.name,
			...(error.stack === undefined ? {} : { stack: error.stack }),
		});
	}
	return Object.freeze({ message: String(error), name: "NonError" });
}

async function diagnosticAttempt<T>(
	operation: () => Promise<T>
): Promise<Readonly<{ ok: true; value: T } | { error: ReturnType<typeof diagnosticError>; ok: false }>> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const value = await Promise.race([
			operation(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("E303_DIAGNOSTIC_TIMEOUT")), 2_000);
			}),
		]);
		return Object.freeze({ ok: true, value });
	} catch (error) {
		return Object.freeze({ error: diagnosticError(error), ok: false });
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function pageFailureEvidence(page: Page, trialId: string | null): Promise<unknown> {
	if (page.isClosed()) return Object.freeze({ pageClosed: true });
	const [networkResult, rtcResult, zoneResult] = await Promise.all([
		diagnosticAttempt(() => network(page)),
		diagnosticAttempt(() => rtcObservations(page)),
		diagnosticAttempt(() => zone(page)),
	]);
	if (!rtcResult.ok)
		return Object.freeze({ network: networkResult, pageClosed: false, rtc: rtcResult, zone: zoneResult });
	const records = rtcResult.value;
	let wire: unknown = null;
	if (trialId !== null) {
		try {
			wire = Object.freeze({
				message: platformObservations(records, "message", trialId),
				send: platformObservations(records, "send", trialId),
			});
		} catch (error) {
			wire = Object.freeze({ error: diagnosticError(error) });
		}
	}
	return Object.freeze({
		network: networkResult,
		pageClosed: false,
		rtc: Object.freeze({
			count: records.length,
			readyStateMismatches: records.filter(({ insertionReadyState, readyState }) => insertionReadyState !== readyState),
			recentRecords: records
				.slice(-64)
				.map(({ text, ...record }) =>
					Object.freeze({ ...record, textLength: text.length, textPreview: text.slice(0, 512) })
				),
			wire,
		}),
		zone: zoneResult,
	});
}

type D108e4hFixtureMode =
	| "creator-replacement"
	| "none"
	| "receiver-channel-close"
	| "receiver-repeated-replacement"
	| "receiver-replacement";

function d108e4hRawTransport(
	peerId: string,
	input: Readonly<{
		readonly authenticatedConnectionLosses?: number;
		readonly lastLinkDrop?: string;
		readonly linkDrops?: number;
		readonly received?: number;
		readonly sent?: number;
	}> = {}
): ZoneSnapshot["rawTransport"] {
	return Object.freeze({
		authenticatedConnectionLosses: input.authenticatedConnectionLosses ?? 0,
		backpressuredDrops: 0,
		fallbackCount: 0 as const,
		handshakeFailures: 0,
		lastLinkDrop: input.lastLinkDrop ?? "restart",
		linkDrops: input.linkDrops ?? 0,
		links: Object.freeze([
			Object.freeze({
				label: "ts-drp-ephemeral/1" as const,
				maxRetransmits: 0 as const,
				ordered: false as const,
				peerId,
			}),
		]),
		received: input.received ?? 0,
		sent: input.sent ?? 0,
	});
}

function d108e4hBoundary(
	localPeerId: string,
	remotePeerId: string,
	connection: "A" | "B",
	rawTransport: ZoneSnapshot["rawTransport"]
): D108e4hBoundaryCustody {
	const selected = connection === "A" ? 1 : 2;
	return Object.freeze({
		authenticated: Object.freeze([
			Object.freeze({
				connectionId: `${localPeerId}-${connection}`,
				generation: selected,
				peerId: remotePeerId,
			}),
		]),
		rawTransport,
		rtc: Object.freeze([
			Object.freeze({
				channelId: selected,
				connectionId: selected,
				label: "ts-drp-ephemeral/1" as const,
				readyState: "open" as const,
			}),
		]),
	});
}

function d108e4hMonitor(trialId: string, peerId: string): readonly D108e4hMonitorObservation[] {
	return Object.freeze([
		Object.freeze({
			carryIn: false,
			connectionId: `${peerId}-reliable`,
			event: "monitor-epoch-start" as const,
			owner: "e3-03-monitor-observer",
			peerId,
			pingId: `${trialId}:epoch`,
			schemaVersion: 3 as const,
			sequence: 0,
			trialId,
		}),
	]);
}

function d108e4hSendEvidence(
	trialId: string,
	connectionId: number,
	channelId: number,
	sequenceOffset: number
): Readonly<{
	readonly lifecycle: readonly D108e4hLifecycleObservation[];
	readonly rawSends: readonly D108e4hRawSend[];
}> {
	const lifecycle: D108e4hLifecycleObservation[] = [];
	const rawSends: D108e4hRawSend[] = [];
	for (let sequence = 0; sequence < SAMPLE_COUNT; sequence += 1) {
		const attemptId = sequence;
		rawSends.push(Object.freeze({ attemptId, channelId, connectionId, sequence }));
		lifecycle.push(
			Object.freeze({
				attemptId,
				channelId,
				connectionId,
				event: "channel-send-attempt" as const,
				owner: "rtc-datachannel-send",
				readyState: "open" as const,
				schemaVersion: 3 as const,
				sequence: sequenceOffset + sequence * 2,
				trialId,
			}),
			Object.freeze({
				attemptId,
				channelId,
				connectionId,
				event: "channel-send-success" as const,
				owner: "rtc-datachannel-send",
				readyState: "open" as const,
				schemaVersion: 3 as const,
				sequence: sequenceOffset + sequence * 2 + 1,
				trialId,
			})
		);
	}
	return Object.freeze({ lifecycle: Object.freeze(lifecycle), rawSends: Object.freeze(rawSends) });
}

function d108e4hAcceptedRaw(connectionId: number, channelId: number, sequence: number): AcceptedObservationIdentity {
	return Object.freeze({
		channelId,
		connectionId,
		insertionReadyState: "open",
		lane: "raw",
		ordinal: sequence,
		readyState: "open",
		receivedAtMs: sequence,
		sentAtMs: 10_000 + sequence,
		sequence,
		sentinel: false,
	});
}

function d108e4hFixture(mode: D108e4hFixtureMode): D108e4hValidationInput {
	const trialId = `d108e4h-${mode}`;
	const creatorPeerId = "peer-creator";
	const receiverPeerId = "peer-receiver";
	const creatorReplacement = mode === "creator-replacement";
	const receiverReplacement = mode === "receiver-replacement" || mode === "receiver-repeated-replacement";
	const receiverChannelClose = mode === "receiver-channel-close";
	const receiverTransition = receiverReplacement || receiverChannelClose;
	const creatorPrepareReason = "restart";
	const receiverPrepareReason = mode === "receiver-repeated-replacement" ? "replacement" : "restart";
	const creatorDeadlineReason = creatorReplacement ? "replacement" : creatorPrepareReason;
	const receiverDeadlineReason = receiverReplacement
		? "replacement"
		: receiverChannelClose
			? "channel-close"
			: receiverPrepareReason;
	const creatorPrepareTransport = d108e4hRawTransport(receiverPeerId, {
		lastLinkDrop: creatorPrepareReason,
		linkDrops: 4,
	});
	const receiverPrepareTransport = d108e4hRawTransport(creatorPeerId, {
		lastLinkDrop: receiverPrepareReason,
		linkDrops: 7,
	});
	const creatorDeadlineTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: creatorReplacement ? 1 : 0,
		lastLinkDrop: creatorDeadlineReason,
		linkDrops: creatorReplacement ? 5 : 4,
		sent: SAMPLE_COUNT,
	});
	const receiverDeadlineTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: mode === "none" ? 1 : receiverTransition ? 1 : 0,
		lastLinkDrop: receiverDeadlineReason,
		linkDrops: receiverTransition ? 8 : 7,
		received: 1,
	});
	const creatorSend = d108e4hSendEvidence(
		trialId,
		creatorReplacement ? 2 : 1,
		creatorReplacement ? 2 : 1,
		creatorReplacement ? 3 : 0
	);
	const creatorTransitionLifecycle: readonly D108e4hLifecycleObservation[] = creatorReplacement
		? Object.freeze([
				Object.freeze({
					channelId: 2,
					connectionId: 2,
					event: "channel-open-event" as const,
					owner: "rtc-datachannel-open-event",
					readyState: "open" as const,
					schemaVersion: 3 as const,
					sequence: 0,
					trialId,
				}),
				Object.freeze({
					channelId: 1,
					connectionId: 1,
					event: "channel-close-call" as const,
					owner: "product-unreliable-webrtc",
					readyState: "open" as const,
					schemaVersion: 3 as const,
					sequence: 1,
					trialId,
				}),
				Object.freeze({
					channelId: 1,
					connectionId: 1,
					event: "channel-close-event" as const,
					owner: "rtc-datachannel-close-event",
					readyState: "closed" as const,
					schemaVersion: 3 as const,
					sequence: 2,
					trialId,
				}),
			])
		: Object.freeze([]);
	const receiverTransitionLifecycle: readonly D108e4hLifecycleObservation[] = receiverTransition
		? Object.freeze([
				Object.freeze({
					channelId: 2,
					connectionId: 2,
					event: "channel-message-handler-installed" as const,
					owner: "product-unreliable-webrtc",
					readyState: "open" as const,
					schemaVersion: 3 as const,
					sequence: 0,
					trialId,
				}),
				Object.freeze({
					channelId: 2,
					connectionId: 2,
					event: "channel-open-event" as const,
					owner: "rtc-datachannel-open-event",
					readyState: "open" as const,
					schemaVersion: 3 as const,
					sequence: 1,
					trialId,
				}),
				Object.freeze({
					channelId: 1,
					connectionId: 1,
					event: "channel-close-call" as const,
					owner: "product-unreliable-webrtc",
					readyState: "open" as const,
					schemaVersion: 3 as const,
					sequence: 2,
					trialId,
				}),
				Object.freeze({
					channelId: 1,
					connectionId: 1,
					event: "channel-close-event" as const,
					owner: "rtc-datachannel-close-event",
					readyState: "closed" as const,
					schemaVersion: 3 as const,
					sequence: 3,
					trialId,
				}),
				Object.freeze({
					channelId: 2,
					connectionId: 2,
					event: "channel-message" as const,
					owner: "rtc-datachannel-message-event",
					readyState: "open" as const,
					schemaVersion: 3 as const,
					sequence: 4,
					trialId,
				}),
			])
		: Object.freeze([
				Object.freeze({
					channelId: 1,
					connectionId: 1,
					event: "channel-message" as const,
					owner: "rtc-datachannel-message-event",
					readyState: "open" as const,
					schemaVersion: 3 as const,
					sequence: 0,
					trialId,
				}),
			]);
	const delta = (before: ZoneSnapshot["rawTransport"], after: ZoneSnapshot["rawTransport"]): RawTransportDelta =>
		rawTransportDelta(before, after);
	return Object.freeze({
		endpoints: Object.freeze({
			creator: Object.freeze({
				acceptedRaw: Object.freeze([]),
				deadline: d108e4hBoundary(
					creatorPeerId,
					receiverPeerId,
					creatorReplacement ? "B" : "A",
					creatorDeadlineTransport
				),
				lifecycle: Object.freeze([...creatorTransitionLifecycle, ...creatorSend.lifecycle]),
				monitor: d108e4hMonitor(trialId, creatorPeerId),
				peerId: creatorPeerId,
				prepare: d108e4hBoundary(creatorPeerId, receiverPeerId, "A", creatorPrepareTransport),
				rawSends: creatorSend.rawSends,
				rejectedRaw: Object.freeze([]),
				transmitsRawTrial: true,
			}),
			receiver: Object.freeze({
				acceptedRaw: Object.freeze([receiverTransition ? d108e4hAcceptedRaw(2, 2, 0) : d108e4hAcceptedRaw(1, 1, 0)]),
				deadline: d108e4hBoundary(
					receiverPeerId,
					creatorPeerId,
					receiverTransition ? "B" : "A",
					receiverDeadlineTransport
				),
				lifecycle: receiverTransitionLifecycle,
				monitor: d108e4hMonitor(trialId, receiverPeerId),
				peerId: receiverPeerId,
				prepare: d108e4hBoundary(receiverPeerId, creatorPeerId, "A", receiverPrepareTransport),
				rawSends: Object.freeze([]),
				rejectedRaw: Object.freeze([]),
				transmitsRawTrial: false,
			}),
		}),
		rawTransportDeltas: Object.freeze({
			creator: delta(creatorPrepareTransport, creatorDeadlineTransport),
			receiver: delta(receiverPrepareTransport, receiverDeadlineTransport),
		}),
		sampleCount: SAMPLE_COUNT,
		schemaVersion: 3 as const,
		trialId,
	});
}

function validateD108e4hCampaignCustody(_input: D108e4hValidationInput): void {
	throw new Error("D108E4H_RED_UNIMPLEMENTED");
}

if (process.env["D108E4H_TELEMETRY"] === "1") {
	test("validates schema-v3 replacement custody without cross-peer clocks", () => {
		const noReplacement = d108e4hFixture("none");
		const creatorReplacement = d108e4hFixture("creator-replacement");
		const receiverReplacement = d108e4hFixture("receiver-replacement");
		const repeatedReplacement = d108e4hFixture("receiver-repeated-replacement");
		const receiverChannelClose = d108e4hFixture("receiver-channel-close");
		const carryInMonitor = Object.freeze({
			...noReplacement,
			endpoints: Object.freeze({
				...noReplacement.endpoints,
				receiver: Object.freeze({
					...noReplacement.endpoints.receiver,
					monitor: Object.freeze([
						...noReplacement.endpoints.receiver.monitor,
						Object.freeze({
							carryIn: true,
							connectionId: "peer-receiver-reliable",
							event: "ping-start" as const,
							owner: "libp2p-connection-monitor",
							peerId: "peer-receiver",
							pingId: `${noReplacement.trialId}:carry-in:0`,
							schemaVersion: 3 as const,
							sequence: 1,
							trialId: noReplacement.trialId,
						}),
					]),
				}),
			}),
		});
		for (const fixture of [
			noReplacement,
			creatorReplacement,
			receiverReplacement,
			repeatedReplacement,
			receiverChannelClose,
			carryInMonitor,
		]) {
			expect(() => validateD108e4hCampaignCustody(fixture)).not.toThrow();
		}
		const withReceiverLifecycle = (
			fixture: D108e4hValidationInput,
			lifecycle: readonly D108e4hLifecycleObservation[]
		): D108e4hValidationInput =>
			Object.freeze({
				...fixture,
				endpoints: Object.freeze({
					...fixture.endpoints,
					receiver: Object.freeze({ ...fixture.endpoints.receiver, lifecycle: Object.freeze(lifecycle) }),
				}),
			});
		const withReceiverDeadlineTransport = (
			fixture: D108e4hValidationInput,
			rawTransport: ZoneSnapshot["rawTransport"]
		): D108e4hValidationInput =>
			Object.freeze({
				...fixture,
				endpoints: Object.freeze({
					...fixture.endpoints,
					receiver: Object.freeze({
						...fixture.endpoints.receiver,
						deadline: Object.freeze({ ...fixture.endpoints.receiver.deadline, rawTransport }),
					}),
				}),
				rawTransportDeltas: Object.freeze({
					...fixture.rawTransportDeltas,
					receiver: rawTransportDelta(fixture.endpoints.receiver.prepare.rawTransport, rawTransport),
				}),
			});
		const withCreatorDeadlineTransport = (
			fixture: D108e4hValidationInput,
			rawTransport: ZoneSnapshot["rawTransport"]
		): D108e4hValidationInput =>
			Object.freeze({
				...fixture,
				endpoints: Object.freeze({
					...fixture.endpoints,
					creator: Object.freeze({
						...fixture.endpoints.creator,
						deadline: Object.freeze({ ...fixture.endpoints.creator.deadline, rawTransport }),
					}),
				}),
				rawTransportDeltas: Object.freeze({
					...fixture.rawTransportDeltas,
					creator: rawTransportDelta(fixture.endpoints.creator.prepare.rawTransport, rawTransport),
				}),
			});

		const wrongEnvelopeSchema = Object.freeze({
			...noReplacement,
			schemaVersion: 2,
		}) as unknown as D108e4hValidationInput;
		expect(() => validateD108e4hCampaignCustody(wrongEnvelopeSchema)).toThrowError("D108E4H_SCHEMA_INVALID");
		const wrongLifecycleSchema = withReceiverLifecycle(
			receiverReplacement,
			receiverReplacement.endpoints.receiver.lifecycle.map((record, index) =>
				index === 0
					? (Object.freeze({ ...record, schemaVersion: 2 }) as unknown as D108e4hLifecycleObservation)
					: record
			)
		);
		expect(() => validateD108e4hCampaignCustody(wrongLifecycleSchema)).toThrowError("D108E4H_SCHEMA_INVALID");
		const wrongMonitorSchema = Object.freeze({
			...noReplacement,
			endpoints: Object.freeze({
				...noReplacement.endpoints,
				receiver: Object.freeze({
					...noReplacement.endpoints.receiver,
					monitor: Object.freeze(
						noReplacement.endpoints.receiver.monitor.map(
							(record) => Object.freeze({ ...record, schemaVersion: 2 }) as unknown as D108e4hMonitorObservation
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(wrongMonitorSchema)).toThrowError("D108E4H_SCHEMA_INVALID");

		const missingMonitor = Object.freeze({
			...noReplacement,
			endpoints: Object.freeze({
				...noReplacement.endpoints,
				receiver: Object.freeze({ ...noReplacement.endpoints.receiver, monitor: Object.freeze([]) }),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(missingMonitor)).toThrowError("D108E4H_MONITOR_CUSTODY_ABSENT");

		const staleEpoch = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					lifecycle: Object.freeze(
						receiverReplacement.endpoints.receiver.lifecycle.map((record, index) =>
							index === 0 ? Object.freeze({ ...record, trialId: "stale-trial" }) : record
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(staleEpoch)).toThrowError("D108E4H_TRIAL_MISMATCH");
		const staleMonitorEpoch = Object.freeze({
			...noReplacement,
			endpoints: Object.freeze({
				...noReplacement.endpoints,
				receiver: Object.freeze({
					...noReplacement.endpoints.receiver,
					monitor: Object.freeze(
						noReplacement.endpoints.receiver.monitor.map((record) =>
							Object.freeze({ ...record, trialId: "stale-trial" })
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(staleMonitorEpoch)).toThrowError("D108E4H_TRIAL_MISMATCH");

		const ambiguousDrop = withReceiverDeadlineTransport(
			receiverReplacement,
			d108e4hRawTransport("peer-creator", {
				authenticatedConnectionLosses: 1,
				lastLinkDrop: "replacement",
				linkDrops: 9,
				received: 1,
			})
		);
		expect(() => validateD108e4hCampaignCustody(ambiguousDrop)).toThrowError("D108E4H_DROP_AMBIGUOUS");
		const unsupportedDrop = withReceiverDeadlineTransport(
			receiverReplacement,
			d108e4hRawTransport("peer-creator", {
				authenticatedConnectionLosses: 1,
				lastLinkDrop: "send-error",
				linkDrops: 8,
				received: 1,
			})
		);
		expect(() => validateD108e4hCampaignCustody(unsupportedDrop)).toThrowError("D108E4H_DROP_AMBIGUOUS");

		const missingIdentity = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					deadline: Object.freeze({
						...receiverReplacement.endpoints.receiver.deadline,
						authenticated: Object.freeze([]),
					}),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(missingIdentity)).toThrowError("D108E4H_IDENTITY_JOIN_INVALID");

		const firstSuccess = creatorReplacement.endpoints.creator.lifecycle.find(
			({ event }) => event === "channel-send-success"
		);
		if (firstSuccess === undefined) throw new Error("D108E4H_FIXTURE_SUCCESS_ABSENT");
		const finalLifecycleSequence = Math.max(
			...creatorReplacement.endpoints.creator.lifecycle.map(({ sequence }) => sequence)
		);
		const duplicateTerminal = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({
					...creatorReplacement.endpoints.creator,
					lifecycle: Object.freeze([
						...creatorReplacement.endpoints.creator.lifecycle,
						Object.freeze({
							...firstSuccess,
							sequence: finalLifecycleSequence + 1,
						}),
					]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(duplicateTerminal)).toThrowError(
			"D108E4H_ATTEMPT_TERMINAL_CARDINALITY"
		);
		const missingTerminal = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({
					...creatorReplacement.endpoints.creator,
					lifecycle: Object.freeze(
						creatorReplacement.endpoints.creator.lifecycle.filter((record) => record !== firstSuccess)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(missingTerminal)).toThrowError("D108E4H_ATTEMPT_TERMINAL_CARDINALITY");

		const receiverLifecycle = receiverReplacement.endpoints.receiver.lifecycle;
		const closeBeforeOpen = withReceiverLifecycle(
			receiverReplacement,
			receiverLifecycle.map((record, index) => {
				if (index === 1)
					return Object.freeze({
						...record,
						channelId: 1,
						connectionId: 1,
						event: "channel-close-call" as const,
						owner: "product-unreliable-webrtc",
					});
				if (index === 2)
					return Object.freeze({
						...record,
						channelId: 2,
						connectionId: 2,
						event: "channel-open-event" as const,
						owner: "rtc-datachannel-open-event",
					});
				return record;
			})
		);
		expect(() => validateD108e4hCampaignCustody(closeBeforeOpen)).toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		const closeEventBeforeCall = withReceiverLifecycle(
			receiverReplacement,
			receiverLifecycle.map((record, index) => {
				if (index === 2)
					return Object.freeze({
						...record,
						event: "channel-close-event" as const,
						owner: "rtc-datachannel-close-event",
						readyState: "closed" as const,
					});
				if (index === 3)
					return Object.freeze({
						...record,
						event: "channel-close-call" as const,
						owner: "product-unreliable-webrtc",
						readyState: "open" as const,
					});
				return record;
			})
		);
		expect(() => validateD108e4hCampaignCustody(closeEventBeforeCall)).toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");

		const missingOverlap = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({ ...receiverReplacement.endpoints.receiver, acceptedRaw: Object.freeze([]) }),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(missingOverlap)).toThrowError("D108E4H_OVERLAP_LEDGER_INVALID");
		const acceptedB = receiverReplacement.endpoints.receiver.acceptedRaw[0];
		if (acceptedB === undefined) throw new Error("D108E4H_FIXTURE_ACCEPTED_RAW_ABSENT");
		const duplicateOverlap = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					acceptedRaw: Object.freeze([acceptedB, acceptedB]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(duplicateOverlap)).toThrowError("D108E4H_OVERLAP_LEDGER_INVALID");
		const crossSetOverlap = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					rejectedRaw: Object.freeze([acceptedB]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(crossSetOverlap)).toThrowError("D108E4H_OVERLAP_LEDGER_INVALID");

		const missingRawSequence = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({
					...creatorReplacement.endpoints.creator,
					rawSends: Object.freeze(creatorReplacement.endpoints.creator.rawSends.slice(0, -1)),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(missingRawSequence)).toThrowError("D108E4H_RAW_SEND_DOMAIN_INVALID");
		const lastRawSend = creatorReplacement.endpoints.creator.rawSends.at(-1);
		if (lastRawSend === undefined) throw new Error("D108E4H_FIXTURE_RAW_SEND_ABSENT");
		const duplicateRawSequence = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({
					...creatorReplacement.endpoints.creator,
					rawSends: Object.freeze([
						...creatorReplacement.endpoints.creator.rawSends.slice(0, -1),
						Object.freeze({ ...lastRawSend, sequence: SAMPLE_COUNT - 2 }),
					]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(duplicateRawSequence)).toThrowError("D108E4H_RAW_SEND_DOMAIN_INVALID");
		const creatorBackpressure = withCreatorDeadlineTransport(
			creatorReplacement,
			Object.freeze({
				...creatorReplacement.endpoints.creator.deadline.rawTransport,
				backpressuredDrops: 1,
			})
		);
		expect(() => validateD108e4hCampaignCustody(creatorBackpressure)).toThrowError("D108E4H_RAW_BACKPRESSURE");
		const inconsistentSentCounter = withCreatorDeadlineTransport(
			creatorReplacement,
			Object.freeze({
				...creatorReplacement.endpoints.creator.deadline.rawTransport,
				sent: SAMPLE_COUNT - 1,
			})
		);
		expect(() => validateD108e4hCampaignCustody(inconsistentSentCounter)).toThrowError("D108E4H_RAW_COUNTER_MISMATCH");
	});
}

test("raw sequence evidence includes the fixed sample-domain boundaries", () => {
	const observations = Array.from({ length: SAMPLE_COUNT }, (_, sequence) =>
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: sequence * SAMPLE_INTERVAL_MS,
			sentAtMs: sequence * SAMPLE_INTERVAL_MS,
			sequence,
			sentinel: false,
		})
	);
	expect({
		complete: rawSequenceEvidence(observations).gap,
		internal: rawSequenceEvidence(observations.filter(({ sequence }) => sequence !== 300)).gap,
		leading: rawSequenceEvidence(observations.slice(1)).gap,
		trailing: rawSequenceEvidence(observations.slice(0, -1)).gap,
	}).toEqual({ complete: 1, internal: 2, leading: 2, trailing: 2 });
});

test("partitions receiver evidence by exact product roster without losing observations", () => {
	const observation = (
		ordinal: number,
		lane: FabricObservation["lane"],
		sequence: number,
		sentAtMs: number,
		readyState: RTCDataChannelState,
		insertionReadyState: RTCDataChannelState
	): PlatformObservation =>
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			carrierByteLength: SAMPLE_PAYLOAD_BYTES,
			channelId: lane === "raw" ? 1 : 2,
			channelLabel: lane === "raw" ? "ts-drp-ephemeral/1" : "",
			connectionId: 1,
			insertionReadyState,
			lane,
			maxRetransmits: lane === "raw" ? 0 : null,
			ordered: lane === "reliable",
			ordinal,
			receivedAtMs: 1_000 + ordinal,
			readyState,
			sentAtMs,
			sequence,
			sentinel: false,
		});
	const observations = Object.freeze([
		observation(0, "reliable", 1, 100, "open", "open"),
		observation(1, "raw", 1, 100, "open", "open"),
		observation(2, "raw", 2, 200, "open", "open"),
		observation(3, "reliable", 3, 300, "open", "open"),
		observation(4, "reliable", 3, 301, "open", "open"),
		observation(5, "reliable", 4, 400, "open", "open"),
		observation(6, "reliable", 4, 400, "open", "open"),
		observation(7, "raw", 5, 500, "closing", "closing"),
		observation(8, "raw", 6, 600, "closing", "open"),
	]);
	const productObservation = (source: PlatformObservation, receivedAtMs: number): FabricObservation =>
		Object.freeze({
			byteLength: source.byteLength,
			lane: source.lane,
			receivedAtMs,
			sentAtMs: source.sentAtMs,
			sequence: source.sequence,
			sentinel: source.sentinel,
		});
	const productRoster = Object.freeze([
		productObservation(observations[1] as PlatformObservation, 2_000),
		productObservation(observations[4] as PlatformObservation, 2_001),
		productObservation(observations[5] as PlatformObservation, 2_002),
		productObservation(observations[7] as PlatformObservation, 2_003),
	]);
	expect(() =>
		productRosterFromSnapshot({
			attempted: { raw: 0, reliable: 0 },
			transport: { fallbackCount: 0, raw: [] },
			trialId: "missing-observations",
		} as unknown as FabricTrialSnapshot)
	).toThrow("E303_FABRIC_OBSERVATIONS_ABSENT");
	const partition = partitionReceiverEvidence(observations, productRoster);

	expect(partition).toEqual({
		productAccepted: [observations[1], observations[4], observations[5], observations[7]],
		productRejected: [observations[0], observations[2], observations[3], observations[6], observations[8]],
	});
	for (const member of [...partition.productAccepted, ...partition.productRejected]) {
		const original = observations.find(({ ordinal }) => ordinal === member.ordinal);
		expect(member).toBe(original);
	}
	expect(
		[...partition.productAccepted, ...partition.productRejected].sort((left, right) => left.ordinal - right.ordinal)
	).toEqual(observations);
	expect(partition.productAccepted.map(({ lane, sentAtMs, sequence }) => ({ lane, sentAtMs, sequence }))).toEqual(
		productRoster.map(({ lane, sentAtMs, sequence }) => ({ lane, sentAtMs, sequence }))
	);
	const unmatchedProduct = Object.freeze([
		...productRoster,
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "reliable" as const,
			receivedAtMs: 2_004,
			sentAtMs: 999,
			sequence: 999,
			sentinel: false,
		}),
	]);
	expect(() => partitionReceiverEvidence(observations, unmatchedProduct)).toThrow("E303_PRODUCT_ROSTER_UNMATCHED");
});

test("separates rendered product-roster metrics from boundary-aware application evidence", () => {
	const observations = Object.freeze([
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: 500,
			sentAtMs: 300,
			sequence: 30,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: 500,
			sentAtMs: 500,
			sequence: 32,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: 600,
			sentAtMs: 400,
			sequence: 31,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "reliable" as const,
			receivedAtMs: 600,
			sentAtMs: 300,
			sequence: 30,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "reliable" as const,
			receivedAtMs: 650,
			sentAtMs: 300,
			sequence: 30,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: 0,
			sentAtMs: 0,
			sequence: 599,
			sentinel: true,
		}),
	]);
	const applicationRaw = acceptedSequencedObservations(
		observations.filter(({ lane, sentinel }) => lane === "raw" && !sentinel)
	);
	const applicationReliable = acceptedSequencedObservations(
		observations.filter(({ lane, sentinel }) => lane === "reliable" && !sentinel)
	);

	expect({
		rawAoIP50Ms: percentile(ageOfInformation(applicationRaw, 0, 700, 100), 0.5),
		rawAoIP95Ms: percentile(ageOfInformation(applicationRaw, 0, 700, 100), 0.95),
		rawDelivered: applicationRaw.length,
		rawGap: rawSequenceEvidence(applicationRaw).gap,
		reliableAoIP50Ms: percentile(ageOfInformation(applicationReliable, 0, 700, 100), 0.5),
		reliableAoIP95Ms: percentile(ageOfInformation(applicationReliable, 0, 700, 100), 0.95),
	}).toEqual({
		rawAoIP50Ms: 100,
		rawAoIP95Ms: 400,
		rawDelivered: 2,
		rawGap: 568,
		reliableAoIP50Ms: 300,
		reliableAoIP95Ms: 500,
	});
	expect(renderedProductRosterMetrics(observations, 700, 100, SAMPLE_COUNT)).toEqual({
		maxGap: 30,
		rawAoIP50Ms: 100,
		rawAoIP95Ms: 200,
		rawDelivered: 3,
		rawDropped: 597,
		reliableAoIP50Ms: 200,
		reliableAoIP95Ms: 400,
		reliableDelivered: 1,
		reliableDropped: 599,
	});
	const arrivalOrderControl = Object.freeze([
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: 100,
			sentAtMs: 0,
			sequence: 2,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: 200,
			sentAtMs: 0,
			sequence: 10,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: 300,
			sentAtMs: 0,
			sequence: 3,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "reliable" as const,
			receivedAtMs: 100,
			sentAtMs: 0,
			sequence: 0,
			sentinel: false,
		}),
	]);
	expect(renderedProductRosterMetrics(arrivalOrderControl, 300, 100, 12).maxGap).toBe(8);
	const bothLaneStartControl = Object.freeze([
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "raw" as const,
			receivedAtMs: 500,
			sentAtMs: 300,
			sequence: 30,
			sentinel: false,
		}),
		Object.freeze({
			byteLength: SAMPLE_PAYLOAD_BYTES,
			lane: "reliable" as const,
			receivedAtMs: 600,
			sentAtMs: 0,
			sequence: 0,
			sentinel: false,
		}),
	]);
	expect(renderedProductRosterMetrics(bothLaneStartControl, 700, 100, SAMPLE_COUNT)).toMatchObject({
		rawAoIP50Ms: 200,
		rawAoIP95Ms: 400,
	});
});

test("freezes RTC metadata at the event boundary before async payload conversion", async ({ browser }) => {
	const context = await browser.newContext();
	await context.addInitScript(installRtcObserver);
	const page = await context.newPage();
	try {
		await page.goto("about:blank");
		const records = await page.evaluate(async () => {
			interface SyntheticChannelState {
				label: string;
				maxRetransmits: number | null;
				ordered: boolean;
				readyState: RTCDataChannelState;
			}
			const observer = window.__E303_RTC_OBSERVER__;
			if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
			const connection = new RTCPeerConnection();
			const dispatchMessage = (state: SyntheticChannelState, byte: number): void => {
				const channelTarget = new EventTarget();
				Object.defineProperties(channelTarget, {
					label: { get: () => state.label },
					maxRetransmits: { get: () => state.maxRetransmits },
					ordered: { get: () => state.ordered },
					readyState: { get: () => state.readyState },
				});
				const channel = channelTarget as unknown as RTCDataChannel;
				const dataChannelEvent = new Event("datachannel");
				Object.defineProperty(dataChannelEvent, "channel", { value: channel });
				connection.dispatchEvent(dataChannelEvent);
				channel.dispatchEvent(new MessageEvent("message", { data: Uint8Array.of(byte).buffer }));
			};

			const openState: SyntheticChannelState = {
				label: "ts-drp-ephemeral/1",
				maxRetransmits: 0,
				ordered: false,
				readyState: "open",
			};
			dispatchMessage(openState, 65);
			Object.assign(openState, {
				label: "mutated-open",
				maxRetransmits: 4,
				ordered: true,
				readyState: "closing" as const,
			});

			const closingState: SyntheticChannelState = {
				label: "ts-drp-ephemeral/1",
				maxRetransmits: 0,
				ordered: false,
				readyState: "closing",
			};
			dispatchMessage(closingState, 66);
			Object.assign(closingState, {
				label: "mutated-closing",
				maxRetransmits: 5,
				ordered: true,
				readyState: "closed" as const,
			});

			const observed = await observer.snapshot();
			connection.close();
			const first = observed[0];
			if (first === undefined) return [];
			return observed.map(({ atMs: _atMs, ...record }) => ({
				...record,
				channelId: record.channelId - first.channelId,
				connectionId: record.connectionId - first.connectionId,
				ordinal: record.ordinal - first.ordinal,
			}));
		});

		expect(records).toEqual([
			{
				byteLength: 1,
				channelId: 0,
				connectionId: 0,
				direction: "message",
				insertionReadyState: "closing",
				label: "ts-drp-ephemeral/1",
				maxRetransmits: 0,
				ordered: false,
				ordinal: 0,
				readyState: "open",
				text: "A",
			},
			{
				byteLength: 1,
				channelId: 1,
				connectionId: 0,
				direction: "message",
				insertionReadyState: "closed",
				label: "ts-drp-ephemeral/1",
				maxRetransmits: 0,
				ordered: false,
				ordinal: 1,
				readyState: "closing",
				text: "B",
			},
		]);
	} finally {
		await context.close();
	}
});

if (process.env["D108E4G_TELEMETRY"] === "1") {
	test("records a versioned and causally joined RTC lifecycle without changing delivery", async ({ browser }) => {
		const context = await browser.newContext();
		await context.addInitScript(installRtcObserver);
		const page = await context.newPage();
		try {
			await page.goto("about:blank");
			const evidence = await page.evaluate(async () => {
				const observer = window.__E303_RTC_OBSERVER__;
				if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
				const left = new RTCPeerConnection();
				const right = new RTCPeerConnection();
				left.addEventListener("icecandidate", (event) => {
					if (event.candidate !== null) void right.addIceCandidate(event.candidate);
				});
				right.addEventListener("icecandidate", (event) => {
					if (event.candidate !== null) void left.addIceCandidate(event.candidate);
				});
				let settleRightChannel: ((channel: RTCDataChannel) => void) | undefined;
				const rightChannel = new Promise<RTCDataChannel>((resolve) => {
					settleRightChannel = resolve;
				});
				right.addEventListener("datachannel", (event) => settleRightChannel?.(event.channel), { once: true });
				const outbound = left.createDataChannel("ts-drp-ephemeral/1", {
					maxRetransmits: 0,
					ordered: false,
				});
				const offer = await left.createOffer();
				await left.setLocalDescription(offer);
				await right.setRemoteDescription(offer);
				const answer = await right.createAnswer();
				await right.setLocalDescription(answer);
				await left.setRemoteDescription(answer);
				const inbound = await rightChannel;
				inbound.binaryType = "arraybuffer";
				await Promise.all(
					[outbound, inbound].map((channel) =>
						channel.readyState === "open"
							? Promise.resolve()
							: new Promise<void>((resolve, reject) => {
									channel.addEventListener("open", () => resolve(), { once: true });
									channel.addEventListener("close", () => reject(new Error("RTC_SELF_CHECK_CLOSED")), {
										once: true,
									});
								})
					)
				);
				const received = new Promise<string>((resolve) => {
					inbound.addEventListener(
						"message",
						(event) => resolve(new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer))),
						{ once: true }
					);
				});
				outbound.send(Uint8Array.of(65));
				const text = await received;
				outbound.close();
				let sendFailureName = "absent";
				try {
					outbound.send(Uint8Array.of(66));
				} catch (error) {
					sendFailureName = error instanceof Error ? error.name : "non-error";
				}
				const closed = new RTCPeerConnection();
				closed.close();
				const signalingFailureNames: string[] = [];
				for (const operation of [
					(): Promise<RTCSessionDescriptionInit> => closed.createOffer(),
					(): Promise<RTCSessionDescriptionInit> => closed.createAnswer(),
					(): Promise<void> => closed.setLocalDescription({ sdp: "v=0\r\n", type: "offer" }),
					(): Promise<void> => closed.setRemoteDescription({ sdp: "v=0\r\n", type: "answer" }),
					(): Promise<void> => closed.addIceCandidate(null),
				]) {
					try {
						await operation();
						signalingFailureNames.push("absent");
					} catch (error) {
						signalingFailureNames.push(error instanceof Error ? error.name : "non-error");
					}
				}
				left.close();
				right.close();
				await new Promise((resolve) => setTimeout(resolve, 0));
				return Object.freeze({
					lifecycle: await observer.lifecycleSnapshot(),
					sendFailureName,
					signalingFailureNames,
					text,
				});
			});

			expect(evidence.text).toBe("A");
			expect(evidence.sendFailureName).toBe("InvalidStateError");
			expect(evidence.signalingFailureNames).toEqual(Array.from({ length: 5 }, () => "InvalidStateError"));
			expect(evidence.lifecycle).not.toHaveLength(0);
			expect(evidence.lifecycle.map(({ sequence }) => sequence)).toEqual(
				Array.from({ length: evidence.lifecycle.length }, (_value, index) => index)
			);
			expect(evidence.lifecycle.every(({ schemaVersion }) => schemaVersion === 2)).toBe(true);
			for (let index = 1; index < evidence.lifecycle.length; index += 1) {
				expect(evidence.lifecycle[index]?.atMonotonicMs).toBeGreaterThanOrEqual(
					evidence.lifecycle[index - 1]?.atMonotonicMs ?? 0
				);
			}
			const kinds = evidence.lifecycle.map(({ event }) => event);
			expect(kinds).toEqual(
				expect.arrayContaining([
					"channel-close-call",
					"channel-handler-installed",
					"channel-message",
					"channel-message-handler-installed",
					"channel-open-event",
					"channel-send-attempt",
					"channel-send-failure",
					"channel-send-success",
					"answer-created",
					"connection-close-call",
					"connection-created",
					"connection-state",
					"ice-candidate-add",
					"ice-connection-state",
					"ice-gathering-state",
					"local-description",
					"offer-created",
					"remote-description",
					"signaling-state",
				])
			);
			const sendAttempts = evidence.lifecycle.filter(({ event }) => event === "channel-send-attempt");
			expect(sendAttempts).not.toHaveLength(0);
			for (const attempt of sendAttempts) {
				expect(attempt.attemptId).toBeDefined();
				expect(
					evidence.lifecycle.filter(
						({ attemptId, channelId, connectionId, event }) =>
							attemptId === attempt.attemptId &&
							channelId === attempt.channelId &&
							connectionId === attempt.connectionId &&
							(event === "channel-send-success" || event === "channel-send-failure")
					)
				).toHaveLength(1);
			}
			const handler = evidence.lifecycle.find(({ event }) => event === "channel-handler-installed");
			if (handler === undefined) throw new Error("D108E4G_RTC_HANDLER_EVENT_ABSENT");
			const remoteOpen = evidence.lifecycle.find(
				({ channelId, connectionId, event }) =>
					event === "channel-open-event" && channelId === handler.channelId && connectionId === handler.connectionId
			);
			expect(remoteOpen?.sequence).toBeGreaterThan(handler.sequence);
		} finally {
			await context.close();
		}
	});
}

if (process.env["D108E4G_TELEMETRY"] === "1") {
	test("proves replacement open before retiring the stale authenticated raw owner", async ({ browser }, testInfo) => {
		test.setTimeout(180_000);
		const creatorContext = await browser.newContext();
		const receiverContext = await browser.newContext();
		await Promise.all([
			creatorContext.addInitScript(installRtcObserver),
			receiverContext.addInitScript(installRtcObserver),
		]);
		const creator = await creatorContext.newPage();
		const receiver = await receiverContext.newPage();
		const trialId = "d108e4g-current-owner";
		try {
			await Promise.all([openGrid(creator), openGrid(receiver)]);
			const peers = await createZone(creator, receiver);
			await Promise.all([installLibp2pMonitorObserver(creator), installLibp2pMonitorObserver(receiver)]);
			await Promise.all(
				[creator, receiver].map((page) =>
					page.evaluate((selectedTrialId) => window.__TS_DRP_V3_ZONE__?.fabric?.reset(selectedTrialId), trialId)
				)
			);
			await waitForOpenTransportPair(creator, receiver);
			const initialNetworks = await Promise.all([network(creator), network(receiver)]);
			const [initialCreatorFabric, initialReceiverFabric, initialCreatorZone, initialReceiverZone] = await Promise.all([
				fabricSnapshot(creator, trialId),
				fabricSnapshot(receiver, trialId),
				zone(creator),
				zone(receiver),
			]);
			const creatorIsInitiator = peers.creatorPeerId < peers.receiverPeerId;
			const initiator = creatorIsInitiator ? creator : receiver;
			const responder = creatorIsInitiator ? receiver : creator;
			const initiatorPeerId = creatorIsInitiator ? peers.creatorPeerId : peers.receiverPeerId;
			const responderPeerId = creatorIsInitiator ? peers.receiverPeerId : peers.creatorPeerId;
			const initialInitiatorFabric = creatorIsInitiator ? initialCreatorFabric : initialReceiverFabric;
			const initialInitiatorZone = creatorIsInitiator ? initialCreatorZone : initialReceiverZone;
			const initialResponderZone = creatorIsInitiator ? initialReceiverZone : initialCreatorZone;
			const oldRaw = initialInitiatorFabric.transport.raw[0];
			if (oldRaw === undefined) throw new Error("D108E4G_OLD_RAW_LINK_ABSENT");
			const oldRtcChannels = (await rtcChannelStates(initiator)).filter(
				({ label, readyState }) => label === "ts-drp-ephemeral/1" && readyState === "open"
			);
			expect(oldRtcChannels, "the two-peer control must have one exact open raw RTC owner").toHaveLength(1);
			const oldRtc = oldRtcChannels[0];
			if (oldRtc === undefined) throw new Error("D108E4G_OLD_RTC_OWNER_ABSENT");
			const oldResponderRtcChannels = (await rtcChannelStates(responder)).filter(
				({ label, readyState }) => label === "ts-drp-ephemeral/1" && readyState === "open"
			);
			expect(oldResponderRtcChannels, "the responder control must have one exact open raw RTC owner").toHaveLength(1);
			const oldResponderRtc = oldResponderRtcChannels[0];
			if (oldResponderRtc === undefined) throw new Error("D108E4G_OLD_RESPONDER_RTC_OWNER_ABSENT");
			await Promise.all([resetRtcObserver(creator), resetRtcObserver(receiver)]);
			await Promise.all(
				[creator, receiver].map((page) => page.evaluate(() => window.__E303_LIBP2P_MONITOR_OBSERVER__?.reset()))
			);

			await initiator.evaluate(async (remotePeerId) => {
				const networkNode = window.__TS_DRP_GRID_SESSION__?.node.networkNode;
				if (networkNode === undefined) throw new Error("D108E4G_NETWORK_NODE_ABSENT");
				const addresses = await networkNode.getPeerMultiaddrs(remotePeerId);
				if (addresses.length === 0) throw new Error("D108E4G_REMOTE_ADDRESS_ABSENT");
				await networkNode.disconnect(remotePeerId);
				await networkNode.connect(addresses.map(({ multiaddr }) => multiaddr));
			}, responderPeerId);
			await waitForNetworkPair(
				creator,
				receiver,
				initialNetworks[0] as NetworkSnapshot,
				initialNetworks[1] as NetworkSnapshot
			);
			await expect
				.poll(async () => (await zone(initiator)).rawTransport.linkDrops, { timeout: 20_000 })
				.toBeGreaterThan(initialInitiatorZone.rawTransport.linkDrops);
			await waitForOpenTransportPair(creator, receiver);
			const preSendInitiatorChannels = (await rtcChannelStates(initiator)).filter(
				({ channelId, connectionId, label, readyState }) =>
					label === "ts-drp-ephemeral/1" &&
					readyState === "open" &&
					(connectionId !== oldRtc.connectionId || channelId !== oldRtc.channelId)
			);
			const preSendResponderChannels = (await rtcChannelStates(responder)).filter(
				({ channelId, connectionId, label, readyState }) =>
					label === "ts-drp-ephemeral/1" &&
					readyState === "open" &&
					(connectionId !== oldResponderRtc.connectionId || channelId !== oldResponderRtc.channelId)
			);
			expect(preSendInitiatorChannels, "the replacement send owner must be open at the causal gate").toHaveLength(1);
			expect(preSendResponderChannels, "the replacement ingress owner must be open at the causal gate").toHaveLength(1);
			const preSendInitiator = preSendInitiatorChannels[0];
			const preSendResponder = preSendResponderChannels[0];
			if (preSendInitiator === undefined || preSendResponder === undefined) {
				throw new Error("D108E4G_CAUSAL_GATE_REPLACEMENT_ABSENT");
			}
			await expect
				.poll(
					async () =>
						(await rtcLifecycleObservations(responder)).some(
							({ channelId, connectionId, event, owner }) =>
								event === "channel-message-handler-installed" &&
								owner === "product-unreliable-webrtc" &&
								connectionId === preSendResponder.connectionId &&
								channelId === preSendResponder.channelId
						),
					{ timeout: 20_000 }
				)
				.toBe(true);
			const responderBeforeSend = await rtcLifecycleObservations(responder);
			const responderHandlerAtGate = responderBeforeSend.find(
				({ channelId, connectionId, event, owner }) =>
					event === "channel-message-handler-installed" &&
					owner === "product-unreliable-webrtc" &&
					connectionId === preSendResponder.connectionId &&
					channelId === preSendResponder.channelId
			);
			const initiatorBeforeSend = await rtcLifecycleObservations(initiator);
			const replacementAttemptsBeforeGate = initiatorBeforeSend.filter(
				({ channelId, connectionId, event }) =>
					event === "channel-send-attempt" &&
					connectionId === preSendInitiator.connectionId &&
					channelId === preSendInitiator.channelId
			);
			expect(responderHandlerAtGate).toBeDefined();
			expect(replacementAttemptsBeforeGate).toHaveLength(0);
			const causalHandlerBeforeSendGate = Object.freeze({
				initiatorReplacement: preSendInitiator,
				initiatorReplacementAttemptsBeforeGate: replacementAttemptsBeforeGate.length,
				owner: "playwright-serial-command-gate",
				responderHandler: responderHandlerAtGate,
				responderReplacement: preSendResponder,
			});
			await sendMovement(initiator, 1, 1);
			await waitForRawDelivery(initiator, responder);

			const [
				initiatorFabric,
				initiatorZone,
				responderZone,
				initiatorChannels,
				responderChannels,
				initiatorRtc,
				responderRtc,
				initiatorMonitor,
				responderMonitor,
			] = await Promise.all([
				fabricSnapshot(initiator, trialId),
				zone(initiator),
				zone(responder),
				rtcChannelStates(initiator),
				rtcChannelStates(responder),
				rtcLifecycleObservations(initiator),
				rtcLifecycleObservations(responder),
				libp2pMonitorObservations(initiator),
				libp2pMonitorObservations(responder),
			]);
			const newRaw = initiatorFabric.transport.raw[0];
			if (newRaw === undefined) throw new Error("D108E4G_NEW_RAW_LINK_ABSENT");
			const newRtcChannels = initiatorChannels.filter(
				({ channelId, connectionId, label, readyState }) =>
					label === "ts-drp-ephemeral/1" &&
					readyState === "open" &&
					(connectionId !== oldRtc.connectionId || channelId !== oldRtc.channelId)
			);
			expect(newRtcChannels, "the replacement must have one exact open raw RTC owner").toHaveLength(1);
			const newRtc = newRtcChannels[0];
			if (newRtc === undefined) throw new Error("D108E4G_NEW_RTC_OWNER_ABSENT");
			const newResponderRtcChannels = responderChannels.filter(
				({ channelId, connectionId, label, readyState }) =>
					label === "ts-drp-ephemeral/1" &&
					readyState === "open" &&
					(connectionId !== oldResponderRtc.connectionId || channelId !== oldResponderRtc.channelId)
			);
			expect(newResponderRtcChannels, "the responder must have one exact replacement RTC owner").toHaveLength(1);
			const newResponderRtc = newResponderRtcChannels[0];
			if (newResponderRtc === undefined) throw new Error("D108E4G_NEW_RESPONDER_RTC_OWNER_ABSENT");
			const openRawClose = initiatorRtc.find(
				({ channelId, connectionId, event, readyState }) =>
					event === "channel-close-call" &&
					connectionId === oldRtc.connectionId &&
					channelId === oldRtc.channelId &&
					readyState === "open"
			);
			const newRawOpen = initiatorRtc.find(
				({ channelId, connectionId, event }) =>
					event === "channel-open-event" && connectionId === newRtc.connectionId && channelId === newRtc.channelId
			);
			const newRawSendAttempt = initiatorRtc.find(
				({ channelId, connectionId, event }) =>
					event === "channel-send-attempt" && connectionId === newRtc.connectionId && channelId === newRtc.channelId
			);
			const newRawSendSuccess = initiatorRtc.find(
				({ attemptId, channelId, connectionId, event }) =>
					event === "channel-send-success" &&
					attemptId === newRawSendAttempt?.attemptId &&
					connectionId === newRtc.connectionId &&
					channelId === newRtc.channelId
			);
			const responderProductHandler = responderRtc.find(
				({ channelId, connectionId, event, owner }) =>
					event === "channel-message-handler-installed" &&
					owner === "product-unreliable-webrtc" &&
					connectionId === newResponderRtc.connectionId &&
					channelId === newResponderRtc.channelId
			);
			const responderFirstMessage = responderRtc.find(
				({ channelId, connectionId, event }) =>
					event === "channel-message" &&
					connectionId === newResponderRtc.connectionId &&
					channelId === newResponderRtc.channelId
			);
			const evidence = Object.freeze({
				causalHandlerBeforeSendGate,
				initiator: Object.freeze({
					monitor: initiatorMonitor,
					peerId: initiatorPeerId,
					rawAfter: Object.freeze({ authenticated: newRaw, rtc: newRtc }),
					rawBefore: Object.freeze({ authenticated: oldRaw, rtc: oldRtc }),
					rtc: initiatorRtc,
					zoneAfter: initiatorZone.rawTransport,
					zoneBefore: initialInitiatorZone.rawTransport,
				}),
				responder: Object.freeze({
					monitor: responderMonitor,
					peerId: responderPeerId,
					rawAfter: Object.freeze({ rtc: newResponderRtc }),
					rawBefore: Object.freeze({ rtc: oldResponderRtc }),
					rtc: responderRtc,
					zoneAfter: responderZone.rawTransport,
					zoneBefore: initialResponderZone.rawTransport,
				}),
			});
			await attachJson(testInfo, "d108e4g-current-owner-lifecycle.json", evidence);

			expect(openRawClose, "handoff must retire the exact previously-open raw channel").toBeDefined();
			expect(newRawOpen, "the replacement raw channel must emit its own joined open event").toBeDefined();
			expect(newRawOpen?.sequence).toBeLessThan(openRawClose?.sequence ?? -1);
			expect(newRawSendAttempt, "the replacement must record its first exact send attempt").toBeDefined();
			expect(
				newRawSendSuccess,
				"the replacement send attempt must have an exact successful terminal event"
			).toBeDefined();
			expect(newRawSendAttempt?.sequence).toBeGreaterThan(openRawClose?.sequence ?? Number.MAX_SAFE_INTEGER);
			expect(newRawSendSuccess?.sequence).toBeGreaterThan(newRawSendAttempt?.sequence ?? Number.MAX_SAFE_INTEGER);
			expect(
				responderProductHandler,
				"the responder must attribute the replacement product message handler"
			).toBeDefined();
			expect(responderFirstMessage, "the responder must observe the first replacement message").toBeDefined();
			expect(responderProductHandler?.sequence).toBeLessThan(
				responderFirstMessage?.sequence ?? Number.MIN_SAFE_INTEGER
			);
			expect(newRtc.connectionId).toBe(causalHandlerBeforeSendGate.initiatorReplacement.connectionId);
			expect(newRtc.channelId).toBe(causalHandlerBeforeSendGate.initiatorReplacement.channelId);
			expect(newResponderRtc.connectionId).toBe(causalHandlerBeforeSendGate.responderReplacement.connectionId);
			expect(newResponderRtc.channelId).toBe(causalHandlerBeforeSendGate.responderReplacement.channelId);
			expect(initiatorZone.rawTransport.lastLinkDrop).toBe("replacement");
			expect(newRaw.connectionId).not.toBe(oldRaw.connectionId);
			expect(newRaw.generation).toBeGreaterThan(oldRaw.generation);
			expect(initiatorMonitor.every(({ schemaVersion }) => schemaVersion === 2)).toBe(true);
			expect(responderMonitor.every(({ schemaVersion }) => schemaVersion === 2)).toBe(true);
		} finally {
			await Promise.all([creatorContext.close(), receiverContext.close()]);
		}
	});
}

test("three fixed browser trials prove raw freshness and no head-of-line blocking under 30% loss", async ({
	browser,
}, testInfo) => {
	test.setTimeout(300_000);
	expect(browser.browserType().name()).toBe("chromium");
	expect(browser.version()).toBe(BROWSER_VERSION);
	const creatorContext = await browser.newContext();
	const receiverContext = await browser.newContext();
	await Promise.all([
		creatorContext.addInitScript(installRtcObserver),
		receiverContext.addInitScript(installRtcObserver),
	]);
	const creator = await creatorContext.newPage();
	const receiver = await receiverContext.newPage();
	const cdp = await creatorContext.newCDPSession(creator);
	const cdpEvidence: Array<
		Readonly<{
			readonly label: string;
			readonly profile: NetworkProfile;
			readonly ruleIds: readonly string[];
		}>
	> = [];
	const applyProfile = async (label: string, profile: NetworkProfile): Promise<void> => {
		const ruleIds = await emulate(cdp, profile);
		cdpEvidence.push(Object.freeze({ label, profile, ruleIds: Object.freeze([...ruleIds]) }));
	};
	let activeTrialId: string | null = null;
	const campaignEvidence: CampaignEvidence[] = [];
	const metrics: CampaignMetric[] = [];
	let currentTrialEvidence: Readonly<Record<string, unknown>> | CampaignEvidence | undefined;
	let stage = "network-enable";
	try {
		await cdp.send("Network.enable");
		// The global profile must exist before Chromium creates either peer-to-peer socket.
		stage = "pre-signaling-profile";
		await applyProfile("pre-signaling-capability", NO_LOSS);
		expect(cdpEvidence[0]?.ruleIds).toHaveLength(1);
		stage = "grid-open";
		await Promise.all([openGrid(creator), openGrid(receiver)]);
		stage = "zone-create";
		const peers = await createZone(creator, receiver);
		const initialCreatorNetwork = await network(creator);
		const initialReceiverNetwork = await network(receiver);
		const initialCreatorLinks = (await zone(creator)).rawTransport.links;
		const initialReceiverLinks = (await zone(receiver)).rawTransport.links;

		stage = "raw-total-loss-calibration";
		const beforeTotalLoss = (await zone(receiver)).rawTransport.received;
		await applyProfile("raw-total-loss-calibration", lossProfile(CALIBRATION_LOSS_PERCENT));
		const totalLossSend = sendMovement(creator, 30, 20);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const receivedDuringTotalLoss = (await zone(receiver)).rawTransport.received;
		await totalLossSend;
		expect(receivedDuringTotalLoss).toBe(beforeTotalLoss);
		expect((await zone(creator)).rawTransport.links).toEqual(initialCreatorLinks);
		expect((await zone(receiver)).rawTransport.links).toEqual(initialReceiverLinks);
		expect(await network(creator)).toEqual(initialCreatorNetwork);
		expect(await network(receiver)).toEqual(initialReceiverNetwork);

		stage = "preliminary-loss-campaign";
		await applyProfile("raw-total-loss-reset", NO_LOSS);
		await new Promise((resolve) => setTimeout(resolve, 250));
		const beforePreliminary = (await zone(receiver)).rawTransport.received;
		await applyProfile("preliminary-thirty-percent", lossProfile(CAMPAIGN_LOSS_PERCENT));
		await sendMovement(creator, SAMPLE_COUNT, SAMPLE_INTERVAL_MS);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const preliminaryDelivered = (await zone(receiver)).rawTransport.received - beforePreliminary;
		expect(preliminaryDelivered).toBeGreaterThanOrEqual(PRELIMINARY_RAW_DELIVERY_FLOOR);
		expect(preliminaryDelivered).toBeLessThan(SAMPLE_COUNT);
		await attachJson(testInfo, "e3-03-preliminary-calibration.json", {
			browserVersion: browser.version(),
			cdpEvidence,
			creatorPeerId: peers.creatorPeerId,
			delivered: preliminaryDelivered,
			floor: PRELIMINARY_RAW_DELIVERY_FLOOR,
			profile: lossProfile(CAMPAIGN_LOSS_PERCENT),
			receiverPeerId: peers.receiverPeerId,
			sent: SAMPLE_COUNT,
			totalLoss: { before: beforeTotalLoss, during: receivedDuringTotalLoss },
		});
		stage = "preliminary-reset";
		await applyProfile("preliminary-reset", NO_LOSS);
		await waitForOpenTransportPair(creator, receiver);
		await waitForNetworkPair(creator, receiver, initialCreatorNetwork, initialReceiverNetwork);
		await waitForRawDelivery(creator, receiver);
		expect((await zone(creator)).durableVertexCount).toBe(peers.durableBaseline);
		expect((await zone(receiver)).durableVertexCount).toBe(peers.durableBaseline);

		const readiness = await Promise.all(
			[creator, receiver].map((page) =>
				page.evaluate(() => {
					const fabric = window.__TS_DRP_V3_ZONE__?.fabric;
					return {
						reset: typeof fabric?.reset,
						runTrial: typeof fabric?.runTrial,
						snapshot: typeof fabric?.snapshot,
					};
				})
			)
		);
		expect.soft(readiness, "the public fabric workbench is the sole E3-03 RED owner").toEqual([
			{ reset: "function", runTrial: "function", snapshot: "function" },
			{ reset: "function", runTrial: "function", snapshot: "function" },
		]);
		if (readiness.some(({ reset, runTrial, snapshot }) => [reset, runTrial, snapshot].includes("undefined"))) return;

		stage = "workbench-total-loss-calibration";
		const calibrationTrialId = "e3-03-total-loss-calibration";
		activeTrialId = calibrationTrialId;
		await Promise.all(
			[creator, receiver].map((page) =>
				page.evaluate(
					(selectedTrialId) => window.__TS_DRP_V3_ZONE__?.fabric?.reset(selectedTrialId),
					calibrationTrialId
				)
			)
		);
		await waitForOpenTransportPair(creator, receiver);
		await waitForNetworkPair(creator, receiver, initialCreatorNetwork, initialReceiverNetwork);
		await Promise.all([resetRtcObserver(creator), resetRtcObserver(receiver)]);
		expectOpenTransport(await fabricSnapshot(creator, calibrationTrialId), peers.receiverPeerId);
		expectOpenTransport(await fabricSnapshot(receiver, calibrationTrialId), peers.creatorPeerId);
		const workbenchCalibration = creator.evaluate((input) => window.__TS_DRP_V3_ZONE__?.fabric?.runTrial(input), {
			intervalMs: 20,
			payloadFormat: "e3-03-ascii-v1" as const,
			payloadBytes: SAMPLE_PAYLOAD_BYTES,
			reliableSentinelBytes: RELIABLE_SENTINEL_BYTES,
			sampleCount: 300,
			trialId: calibrationTrialId,
		});
		await expect
			.poll(
				async () => {
					const sends = platformObservations(await rtcObservations(creator), "send", calibrationTrialId);
					return {
						raw: sends.some(({ lane }) => lane === "raw"),
						reliable: sends.some(({ lane }) => lane === "reliable"),
					};
				},
				{ timeout: 5_000 }
			)
			.toEqual({ raw: true, reliable: true });
		await applyProfile("workbench-total-loss", lossProfile(CALIBRATION_LOSS_PERCENT));
		await new Promise((resolve) => setTimeout(resolve, 250));
		const calibrationReceiverBefore = platformObservations(
			await rtcObservations(receiver),
			"message",
			calibrationTrialId
		).length;
		await new Promise((resolve) => setTimeout(resolve, 500));
		const calibrationReceiverAfter = platformObservations(
			await rtcObservations(receiver),
			"message",
			calibrationTrialId
		).length;
		expect(calibrationReceiverBefore).toBeGreaterThan(0);
		expect(calibrationReceiverAfter).toBe(calibrationReceiverBefore);
		const calibrationSends = platformObservations(await rtcObservations(creator), "send", calibrationTrialId);
		expect(calibrationSends.some(({ lane }) => lane === "raw")).toBe(true);
		expect(calibrationSends.some(({ lane }) => lane === "reliable")).toBe(true);
		const calibrationRawConnections = new Set(
			calibrationSends.filter(({ lane }) => lane === "raw").map(({ connectionId }) => connectionId)
		);
		const calibrationReliableConnections = new Set(
			calibrationSends.filter(({ lane }) => lane === "reliable").map(({ connectionId }) => connectionId)
		);
		expect(calibrationRawConnections.size).toBe(1);
		expect(calibrationReliableConnections.size).toBe(1);
		const duringWorkbenchCalibration = await fabricSnapshot(receiver, calibrationTrialId);
		expectOpenTransport(duringWorkbenchCalibration, peers.creatorPeerId);
		expect((await zone(creator)).rawTransport.links).toEqual(initialCreatorLinks);
		expect((await zone(receiver)).rawTransport.links).toEqual(initialReceiverLinks);
		expect(await network(creator)).toEqual(initialCreatorNetwork);
		expect(await network(receiver)).toEqual(initialReceiverNetwork);
		stage = "workbench-total-loss-reset";
		await applyProfile("workbench-total-loss-reset", NO_LOSS);
		await workbenchCalibration;
		await waitForOpenTransportPair(creator, receiver);
		await waitForNetworkPair(creator, receiver, initialCreatorNetwork, initialReceiverNetwork);
		await waitForRawDelivery(creator, receiver);

		for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
			const trialId = "e3-03-" + String(trial);
			const lexicographicRole = Object.freeze({
				creatorPeerId: peers.creatorPeerId,
				initiator: peers.creatorPeerId < peers.receiverPeerId ? ("creator" as const) : ("receiver" as const),
				receiverPeerId: peers.receiverPeerId,
			});
			let trialProgress: Readonly<Record<string, unknown>> = Object.freeze({ lexicographicRole, trialId });
			const updateTrialProgress = (patch: Readonly<Record<string, unknown>>): void => {
				trialProgress = Object.freeze({ ...trialProgress, ...patch });
				currentTrialEvidence = trialProgress;
			};
			activeTrialId = trialId;
			currentTrialEvidence = trialProgress;
			stage = trialId + "-prepare";
			await Promise.all(
				[creator, receiver].map((page) =>
					page.evaluate((selectedTrialId) => window.__TS_DRP_V3_ZONE__?.fabric?.reset(selectedTrialId), trialId)
				)
			);
			await waitForOpenTransportPair(creator, receiver);
			await waitForNetworkPair(creator, receiver, initialCreatorNetwork, initialReceiverNetwork);
			await Promise.all([resetRtcObserver(creator), resetRtcObserver(receiver)]);
			const clock = await clockEvidence(creator, receiver);
			updateTrialProgress({ clockSamples: clock.samples, clockSkewMs: clock.maximumSkewMs });
			expect(clock.maximumSkewMs).toBeLessThanOrEqual(20);
			const receiverRawBefore = await rawReceivedAfterQuiescence(receiver);
			const [senderRawTransportBefore, receiverRawTransportBefore] = await Promise.all([
				zone(creator).then(({ rawTransport }) => rawTransport),
				zone(receiver).then(({ rawTransport }) => rawTransport),
			]);
			const trialEvidenceStartedAtMs = Date.now();
			const prepareStage = transportStageEvidence(0, senderRawTransportBefore, receiverRawTransportBefore);
			updateTrialProgress({ stages: Object.freeze({ prepare: prepareStage }) });
			const senderRawBefore = senderRawTransportBefore.sent;
			stage = trialId + "-run";
			const trialOperation = creator.evaluate((input) => window.__TS_DRP_V3_ZONE__?.fabric?.runTrial(input), {
				intervalMs: SAMPLE_INTERVAL_MS,
				payloadFormat: "e3-03-ascii-v1" as const,
				payloadBytes: SAMPLE_PAYLOAD_BYTES,
				reliableSentinelBytes: RELIABLE_SENTINEL_BYTES,
				sampleCount: SAMPLE_COUNT,
				trialId,
			});
			await expect
				.poll(
					async () => {
						const sends = platformObservations(await rtcObservations(creator), "send", trialId);
						return {
							raw: sends.some(({ lane }) => lane === "raw"),
							reliable: sends.some(({ lane }) => lane === "reliable"),
						};
					},
					{ timeout: 5_000 }
				)
				.toEqual({ raw: true, reliable: true });
			await applyProfile(trialId + "-thirty-percent", lossProfile(CAMPAIGN_LOSS_PERCENT));
			await trialOperation;
			stage = trialId + "-sender-evidence";
			const runTrialReturnedAtMs = await creator.evaluate(() => Date.now());
			const [senderRawTransportAtRunReturn, receiverRawTransportAtRunReturn] = await Promise.all([
				zone(creator).then(({ rawTransport }) => rawTransport),
				zone(receiver).then(({ rawTransport }) => rawTransport),
			]);
			const runReturnedStage = transportStageEvidence(
				Date.now() - trialEvidenceStartedAtMs,
				senderRawTransportAtRunReturn,
				receiverRawTransportAtRunReturn
			);
			updateTrialProgress({
				stages: Object.freeze({ prepare: prepareStage, runReturned: runReturnedStage }),
			});
			const senderRawAfter = await rawSentAfterQuiescence(creator);
			const senderRtc = await rtcObservations(creator);
			const senderWire = platformObservations(senderRtc, "send", trialId);
			const senderRawCandidateCount = senderWire.filter(({ lane, sentinel }) => lane === "raw" && !sentinel).length;
			updateTrialProgress({ senderRawCandidateCount, senderWire });
			if (senderRawCandidateCount < PRELIMINARY_RAW_DELIVERY_FLOOR) {
				throw new Error(
					`E303_RAW_SENDER_FLOOR:${JSON.stringify({
						rawSamples: senderRawCandidateCount,
						transport: (await zone(creator)).rawTransport,
					})}`
				);
			}
			const senderRaw = expectRawSenderSamples(senderWire);
			const senderReliable = expectReliableSenderSamples(senderWire);
			const senderSentinels = senderWire.filter(({ lane, sentinel }) => lane === "reliable" && sentinel);
			expect(senderSentinels.length).toBeLessThanOrEqual(1);
			const scheduledRaw = [...senderRaw].sort((left, right) => left.sequence - right.sequence);
			const scheduledReliable = [...senderReliable].sort((left, right) => left.sequence - right.sequence);
			const campaignStartedAtMs = Math.min(
				scheduledRaw[0]?.receivedAtMs ?? Number.POSITIVE_INFINITY,
				scheduledReliable[0]?.receivedAtMs ?? Number.POSITIVE_INFINITY
			);
			const expectedCampaignSpanMs = (SAMPLE_COUNT - 1) * SAMPLE_INTERVAL_MS;
			const deadlineMs = campaignStartedAtMs + expectedCampaignSpanMs + RELIABLE_OBSERVATION_TAIL_MS;
			stage = trialId + "-deadline";
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineMs - Date.now())));
			const preliminaryReceiverSnapshot = await fabricSnapshot(receiver, trialId);
			updateTrialProgress({ preliminaryReceiverSnapshot });
			const preliminaryProductRoster = productRosterFromSnapshot(preliminaryReceiverSnapshot);
			updateTrialProgress({ preliminaryProductRoster });
			const productDeadlineMs = productDeadlineFromRoster(
				preliminaryProductRoster,
				SAMPLE_INTERVAL_MS,
				SAMPLE_COUNT,
				RELIABLE_OBSERVATION_TAIL_MS
			);
			const receiverNowMs = await receiver.evaluate(() => Date.now());
			updateTrialProgress({ productDeadlineMs, receiverNowMs });
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, productDeadlineMs + 1 - receiverNowMs)));
			const receiverAtDeadline = await receiverEvidenceAtDeadline(receiver, trialId);
			const senderRawTransportAtDeadline = (await zone(creator)).rawTransport;
			const productRoster = productRosterFromSnapshot(receiverAtDeadline.fabric);
			const receiverWire = platformObservations(receiverAtDeadline.rtc, "message", trialId);
			const deadlineStage = transportStageEvidence(
				Date.now() - trialEvidenceStartedAtMs,
				senderRawTransportAtDeadline,
				receiverAtDeadline.zone.rawTransport
			);
			updateTrialProgress({
				preliminaryProductRoster: undefined,
				productRoster,
				receiverRawTransportAtDeadline: receiverAtDeadline.zone.rawTransport,
				receiverWire,
				stages: Object.freeze({
					deadline: deadlineStage,
					prepare: prepareStage,
					runReturned: runReturnedStage,
				}),
			});
			stage = trialId + "-reset";
			await applyProfile(trialId + "-reset", NO_LOSS);
			await waitForOpenTransportPair(creator, receiver);
			await waitForNetworkPair(creator, receiver, initialCreatorNetwork, initialReceiverNetwork);
			const [senderSnapshot, receiverSnapshot, senderAfterReset, receiverAfterReset] = await Promise.all([
				fabricSnapshot(creator, trialId),
				fabricSnapshot(receiver, trialId),
				zone(creator),
				zone(receiver),
			]);
			const resetStage = transportStageEvidence(
				Date.now() - trialEvidenceStartedAtMs,
				senderAfterReset.rawTransport,
				receiverAfterReset.rawTransport
			);
			updateTrialProgress({
				stages: Object.freeze({
					deadline: deadlineStage,
					prepare: prepareStage,
					reset: resetStage,
					runReturned: runReturnedStage,
				}),
			});
			expect(senderSnapshot.attempted).toEqual({ raw: SAMPLE_COUNT, reliable: SAMPLE_COUNT });
			expectOpenTransport(senderSnapshot, peers.receiverPeerId);
			expectOpenTransport(receiverSnapshot, peers.creatorPeerId);

			stage = trialId + "-assertions";
			const receiverPartition = partitionReceiverEvidence(receiverWire, productRoster);
			const acceptedObservationIdentities = Object.freeze(
				receiverPartition.productAccepted.map(acceptedObservationIdentity)
			);
			const partitionCardinalities = Object.freeze({
				accepted: receiverPartition.productAccepted.length,
				observer: receiverWire.length,
				rejected: receiverPartition.productRejected.length,
				roster: productRoster.length,
			});
			updateTrialProgress({
				acceptedObservationIdentities,
				partitionCardinalities,
				productRejected: receiverPartition.productRejected,
			});
			const rawWire = expectRawReceiverSamples(receiverWire);
			const acceptedRawWire = receiverPartition.productAccepted.filter(
				({ lane, sentinel }) => lane === "raw" && !sentinel
			);
			const raw = acceptedSequencedObservations(acceptedRawWire);
			expectReliableReceiverSamples(receiverWire);
			const reliable = firstReliableBySequence(receiverPartition.productAccepted);
			const reliableWire = receiverWire.filter(({ lane, sentinel }) => lane === "reliable" && !sentinel);
			expect(receiverWire.filter(({ lane, sentinel }) => lane === "reliable" && sentinel)).toEqual([]);
			expect(rawWire.length).toBeGreaterThan(0);
			expect(raw.length).toBeGreaterThan(0);
			expect(senderRawAfter - senderRawBefore).toBe(senderRaw.length);
			const receiverRawCounterDelta = receiverAtDeadline.zone.rawTransport.received - receiverRawBefore;
			const productRosterRawCount = productRoster.filter(({ lane, sentinel }) => lane === "raw" && !sentinel).length;
			const receiverSequence = rawSequenceEvidence(raw);
			const senderSequence = rawSequenceEvidence(senderRaw);
			const rawAoI = ageOfInformation(raw, campaignStartedAtMs, deadlineMs, SAMPLE_INTERVAL_MS);
			const reliableAoI = ageOfInformation(reliable, campaignStartedAtMs, deadlineMs, SAMPLE_INTERVAL_MS);
			const rawAoIP50Ms = percentile(rawAoI, 0.5);
			const rawAoIP95Ms = percentile(rawAoI, 0.95);
			const reliableAoIP50Ms = percentile(reliableAoI, 0.5);
			const reliableAoIP95Ms = percentile(reliableAoI, 0.95);
			const firstReliableReceivedAtMs = reliable[0]?.receivedAtMs;
			if (firstReliableReceivedAtMs === undefined) throw new Error("E303_RELIABLE_OBSERVATION_ABSENT");
			const rawDeliveredAfterReliableStart = raw.filter(
				({ receivedAtMs }) => receivedAtMs > firstReliableReceivedAtMs
			).length;
			const rendered = renderedProductRosterMetrics(productRoster, productDeadlineMs, SAMPLE_INTERVAL_MS, SAMPLE_COUNT);
			const trialEvidence = Object.freeze({
				acceptedObservationIdentities,
				application: Object.freeze({
					rawAoIP50Ms,
					rawAoIP95Ms,
					rawDelivered: raw.length,
					rawDeliveredAfterReliableStart,
					rawGap: receiverSequence.gap,
					rawMaxStallMs: senderSequence.maxStallMs,
					reliableAoIP50Ms,
					reliableAoIP95Ms,
					reliableDelivered: reliable.length,
				}),
				clockSamples: clock.samples,
				clockSkewMs: clock.maximumSkewMs,
				completeObserverRawGap: rawSequenceEvidence(rawWire).gap,
				lexicographicRole,
				partitionCardinalities,
				perChannelMonotonicity: channelSequenceEvidence(receiverPartition.productAccepted),
				productRejected: receiverPartition.productRejected,
				productRoster,
				rawArrivalInversionCount: arrivalInversionCount(receiverPartition.productAccepted),
				rawCounter: Object.freeze({
					after: receiverAtDeadline.zone.rawTransport.received,
					before: receiverRawBefore,
					matchedObserver: acceptedRawWire.length,
					productRoster: productRosterRawCount,
				}),
				rawTransportDeltas: Object.freeze({
					receiver: rawTransportDelta(receiverRawTransportBefore, receiverAtDeadline.zone.rawTransport),
					sender: rawTransportDelta(senderRawTransportBefore, senderRawTransportAtDeadline),
				}),
				readyStateMismatches: Object.freeze({
					receiver: Object.freeze(
						receiverAtDeadline.rtc.filter(({ insertionReadyState, readyState }) => insertionReadyState !== readyState)
					),
					sender: Object.freeze(
						senderRtc.filter(({ insertionReadyState, readyState }) => insertionReadyState !== readyState)
					),
				}),
				rendered,
				receiverWire,
				stages: Object.freeze({
					deadline: deadlineStage,
					prepare: prepareStage,
					reset: resetStage,
					runReturned: runReturnedStage,
				}),
				senderWire,
				trialId,
			}) satisfies CampaignEvidence;
			currentTrialEvidence = trialEvidence;
			expect(receiverRawCounterDelta).toBe(acceptedRawWire.length);
			expect(productRosterRawCount).toBe(acceptedRawWire.length);
			expect(
				[...senderRaw, ...rawWire].every(
					({ byteLength, carrierByteLength, channelLabel, maxRetransmits, ordered }) =>
						byteLength === SAMPLE_PAYLOAD_BYTES &&
						carrierByteLength >= byteLength &&
						carrierByteLength <= byteLength + 1_024 &&
						channelLabel === "ts-drp-ephemeral/1" &&
						maxRetransmits === 0 &&
						!ordered
				)
			).toBe(true);
			expect(
				[...senderReliable, ...reliableWire].every(
					({ byteLength, carrierByteLength, channelLabel, maxRetransmits, ordered }) =>
						byteLength === SAMPLE_PAYLOAD_BYTES &&
						carrierByteLength >= byteLength &&
						carrierByteLength <= byteLength + 1_024 &&
						channelLabel === "" &&
						maxRetransmits === null &&
						ordered
				)
			).toBe(true);
			expect(senderRaw.every(({ readyState }) => readyState === "open")).toBe(true);
			expect(senderReliable.every(({ readyState }) => readyState === "open")).toBe(true);
			expect(receiverPartition.productAccepted.every(({ readyState }) => readyState === "open")).toBe(true);
			expect(receiverPartition.productRejected.every(({ readyState }) => readyState !== "connecting")).toBe(true);
			expect(
				senderSentinels.every(
					({ byteLength, carrierByteLength, channelLabel, maxRetransmits, ordered, readyState }) =>
						byteLength === RELIABLE_SENTINEL_BYTES &&
						carrierByteLength >= byteLength &&
						carrierByteLength <= byteLength + 1_024 &&
						channelLabel === "" &&
						maxRetransmits === null &&
						ordered &&
						readyState === "open"
				)
			).toBe(true);
			expect(new Set(senderRaw.map(({ connectionId }) => connectionId)).size).toBeGreaterThanOrEqual(1);
			expect(new Set(rawWire.map(({ connectionId }) => connectionId)).size).toBeGreaterThanOrEqual(1);
			expect(
				new Set([...senderReliable, ...senderSentinels].map(({ connectionId }) => connectionId)).size
			).toBeGreaterThanOrEqual(1);
			expect(new Set(reliable.map(({ connectionId }) => connectionId)).size).toBeGreaterThanOrEqual(1);
			expect(
				Math.max(...senderRaw.map(({ receivedAtMs, sentAtMs }) => Math.abs(receivedAtMs - sentAtMs)))
			).toBeLessThanOrEqual(SAMPLE_INTERVAL_MS);
			expect(runTrialReturnedAtMs - campaignStartedAtMs).toBeGreaterThanOrEqual(expectedCampaignSpanMs - 1_000);
			expect(
				scheduledRaw.every(
					({ receivedAtMs, sequence }) =>
						Math.abs(receivedAtMs - campaignStartedAtMs - sequence * SAMPLE_INTERVAL_MS) <= 1_000
				)
			).toBe(true);
			expect(
				scheduledReliable.every(({ receivedAtMs, sentAtMs }) => receivedAtMs >= sentAtMs && receivedAtMs <= deadlineMs)
			).toBe(true);
			expect(receiverSequence.gap).toBeGreaterThan(1);
			expect(senderSequence.maxStallMs).toBeLessThanOrEqual(500);
			expect(rawAoIP95Ms).toBeLessThanOrEqual(reliableAoIP95Ms * 0.8);
			expect(rawDeliveredAfterReliableStart).toBeGreaterThanOrEqual(10);
			metrics.push(
				Object.freeze({
					clockSamples: clock.samples,
					clockSkewMs: clock.maximumSkewMs,
					rawAoIP50Ms,
					rawAoIP95Ms,
					rawDelivered: raw.length,
					rawGap: receiverSequence.gap,
					rawMaxStallMs: senderSequence.maxStallMs,
					rawDeliveredAfterReliableStart,
					reliableAoIP50Ms,
					reliableAoIP95Ms,
					reliableDelivered: reliable.length,
					rendered,
					trialId,
				})
			);
			campaignEvidence.push(trialEvidence);
			currentTrialEvidence = undefined;
		}
		expect(
			campaignEvidence.reduce(
				(total, { receiverWire }) =>
					total + receiverWire.filter(({ lane, sentinel }) => lane === "raw" && !sentinel).length,
				0
			)
		).toBeGreaterThanOrEqual(PRELIMINARY_RAW_DELIVERY_FLOOR * TRIAL_COUNT);
		expect(
			new Set(
				campaignEvidence.flatMap(({ senderWire }) =>
					senderWire.filter(({ lane }) => lane === "raw").map(({ connectionId }) => connectionId)
				)
			).size
		).toBeGreaterThanOrEqual(calibrationRawConnections.size);
		expect(
			new Set(
				campaignEvidence.flatMap(({ receiverWire }) =>
					receiverWire.filter(({ lane }) => lane === "raw").map(({ connectionId }) => connectionId)
				)
			).size
		).toBeGreaterThanOrEqual(1);
		expect(
			new Set(
				campaignEvidence.flatMap(({ receiverWire }) =>
					receiverWire.filter(({ lane }) => lane === "reliable").map(({ connectionId }) => connectionId)
				)
			).size
		).toBeGreaterThanOrEqual(1);

		activeTrialId = null;
		stage = "durable-control";
		expect((await zone(creator)).durableVertexCount).toBe(peers.durableBaseline);
		expect((await zone(receiver)).durableVertexCount).toBe(peers.durableBaseline);
		await Promise.all(
			[creator, receiver].map((page) =>
				page.evaluate(() => window.__TS_DRP_V3_ZONE__?.fabric?.reset("e3-03-durable-control"))
			)
		);
		await waitForOpenTransportPair(creator, receiver);
		await waitForNetworkPair(creator, receiver, initialCreatorNetwork, initialReceiverNetwork);
		await creator.evaluate(() =>
			window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "e3-03-durable-control", kind: "stone", x: 89, y: 144 })
		);
		await expect.poll(async () => (await zone(receiver)).durableVertexCount).toBe(peers.durableBaseline + 1);
		expect((await zone(creator)).durableVertexCount).toBe(peers.durableBaseline + 1);
		expect((await zone(creator)).rawTransport.fallbackCount).toBe(0);
		expect((await zone(receiver)).rawTransport.fallbackCount).toBe(0);
		expect(await network(creator)).toEqual(initialCreatorNetwork);
		expect(await network(receiver)).toEqual(initialReceiverNetwork);
		expect((await zone(creator)).rawTransport.links).toEqual(initialCreatorLinks);
		expect((await zone(receiver)).rawTransport.links).toEqual(initialReceiverLinks);
		expect(metrics).toHaveLength(TRIAL_COUNT);
		await attachJson(testInfo, "e3-03-fixed-loss-campaign.json", {
			browserVersion: browser.version(),
			calibration: lossProfile(CALIBRATION_LOSS_PERCENT),
			campaign: lossProfile(CAMPAIGN_LOSS_PERCENT),
			cdpEvidence,
			durableBaseline: peers.durableBaseline,
			metrics,
			observations: campaignEvidence,
			trialCount: TRIAL_COUNT,
		});
		stage = "rendered-metrics";
		for (const metric of metrics) {
			const row = receiver.locator(`[data-e3-03-trial="${metric.trialId}"]`);
			const readMilliseconds = async (name: string): Promise<number> => {
				const text = await row.locator(`[data-metric="${name}"]`).textContent();
				const match = /^(\d+) ms$/u.exec(text ?? "");
				expect(match, `${name} must render integer milliseconds`).not.toBeNull();
				const value = Number(match?.[1]);
				if (!Number.isSafeInteger(value)) throw new Error("E303_RENDERED_MILLISECONDS_INVALID");
				return value;
			};
			const renderedRawP50 = await readMilliseconds("raw-aoi-p50");
			const renderedRawP95 = await readMilliseconds("raw-aoi-p95");
			const renderedReliableP50 = await readMilliseconds("reliable-aoi-p50");
			const renderedReliableP95 = await readMilliseconds("reliable-aoi-p95");
			expect(renderedRawP50).toBe(metric.rendered.rawAoIP50Ms);
			expect(renderedRawP95).toBe(metric.rendered.rawAoIP95Ms);
			expect(renderedReliableP50).toBe(metric.rendered.reliableAoIP50Ms);
			expect(renderedReliableP95).toBe(metric.rendered.reliableAoIP95Ms);
			expect(renderedRawP95).toBeLessThanOrEqual(renderedReliableP95 * 0.8);
			await expect(row.locator('[data-metric="max-gap"]')).toHaveText(String(metric.rendered.maxGap));
			await expect(row.locator('[data-metric="raw-delivered"]')).toHaveText(String(metric.rendered.rawDelivered));
			await expect(row.locator('[data-metric="raw-dropped"]')).toHaveText(String(metric.rendered.rawDropped));
			await expect(row.locator('[data-metric="reliable-delivered"]')).toHaveText(
				String(metric.rendered.reliableDelivered)
			);
			await expect(row.locator('[data-metric="reliable-dropped"]')).toHaveText(String(metric.rendered.reliableDropped));
			await expect(row.locator('[data-metric="fallback-count"]')).toHaveText("0");
			await expect(row.locator('[data-metric="durable-delta"]')).toHaveText("1");
		}
		stage = "complete";
	} catch (error) {
		const [creatorEvidence, receiverEvidence] = await Promise.all([
			pageFailureEvidence(creator, activeTrialId),
			pageFailureEvidence(receiver, activeTrialId),
		]);
		await attachJson(testInfo, "e3-03-failure-telemetry.json", {
			activeTrialId,
			browserVersion: browser.version(),
			campaignEvidence,
			cdpEvidence,
			creator: creatorEvidence,
			currentTrialEvidence,
			error: diagnosticError(error),
			metrics,
			receiver: receiverEvidence,
			stage,
		}).catch(() => undefined);
		throw error;
	} finally {
		await emulate(cdp, NO_LOSS).catch(() => undefined);
		await Promise.allSettled([
			creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
			receiver.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
		]);
		await Promise.allSettled([creatorContext.close(), receiverContext.close()]);
	}
});

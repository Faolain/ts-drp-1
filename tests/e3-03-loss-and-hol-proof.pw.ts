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
	| "monitor-epoch-start"
	| "ping-failure"
	| "ping-read-success"
	| "ping-start"
	| "ping-stream-open"
	| "ping-write-success";

interface Libp2pMonitorObservation {
	readonly atMonotonicMs: number;
	readonly atWallMs: number;
	readonly carryIn: boolean;
	readonly connectionId: string;
	readonly event: Libp2pMonitorEventKind;
	readonly owner: string;
	readonly peerId: string;
	readonly pingId: string;
	readonly reason?: string;
	readonly schemaVersion: 3;
	readonly sequence: number;
	readonly trialId: string;
}

interface Libp2pMonitorObserver {
	reset(trialId: string): void;
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
	readonly attemptId?: number;
	readonly atMs: number;
	readonly byteLength: number;
	readonly channelId: number;
	readonly connectionId: number;
	readonly direction: "message" | "send";
	readonly insertionReadyState: RTCDataChannelState;
	readonly lifecycleSequence?: number;
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
	readonly schemaVersion: 3;
	readonly sequence: number;
	readonly state?: string;
	readonly trialId: string;
}

interface RtcChannelStateObservation {
	readonly bufferedAmount: number;
	readonly channelId: number;
	readonly connectionId: number;
	readonly label: string;
	readonly readyState: RTCDataChannelState;
	readonly schemaVersion: 2;
}

interface RtcCustodySnapshot {
	readonly channelStates: readonly RtcChannelStateObservation[];
	readonly lifecycle: readonly RtcLifecycleObservation[];
	readonly lifecycleSequenceFence: number;
	readonly records: readonly RtcObservation[];
}

interface RtcObserver {
	channelStateSnapshot(): readonly RtcChannelStateObservation[];
	custodySnapshot(): Promise<RtcCustodySnapshot>;
	lifecycleSnapshot(): Promise<readonly RtcLifecycleObservation[]>;
	reset(trialId: string): void;
	snapshot(): Promise<readonly RtcObservation[]>;
}

interface PlatformObservation extends FabricObservation {
	readonly attemptId?: number;
	readonly carrierByteLength: number;
	readonly channelLabel: string;
	readonly channelId: number;
	readonly connectionId: number;
	readonly insertionReadyState: RTCDataChannelState;
	readonly lifecycleSequence?: number;
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
	readonly replacementCustody: D108e4hValidationInput;
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
	readonly atMonotonicMs?: number;
	readonly atWallMs?: number;
	readonly bufferedAmount?: number;
	readonly callsite?: string;
	readonly channelId?: number;
	readonly connectionId: number;
	readonly event: RtcLifecycleKind;
	readonly label?: string;
	readonly owner: string;
	readonly readyState?: RTCDataChannelState;
	readonly schemaVersion: 3;
	readonly sequence: number;
	readonly state?: string;
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

interface D108e4hOverlapObservation extends AcceptedObservationIdentity {
	readonly lifecycleSequence: number;
}

interface D108e4hEndpointCustody {
	readonly acceptedRaw: readonly D108e4hOverlapObservation[];
	readonly deadline: D108e4hBoundaryCustody;
	readonly lifecycle: readonly D108e4hLifecycleObservation[];
	readonly monitor: readonly D108e4hMonitorObservation[];
	readonly peerId: string;
	readonly prepare: D108e4hBoundaryCustody;
	readonly rawSends: readonly D108e4hRawSend[];
	readonly rejectedRaw: readonly D108e4hOverlapObservation[];
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

interface D108e4hPageCapture {
	readonly fabric: FabricTrialSnapshot;
	readonly monitor: readonly Libp2pMonitorObservation[];
	readonly rtc: RtcCustodySnapshot;
	readonly zone: ZoneSnapshot;
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
	let activeTrialId = "observer-install";
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
	): number => {
		const atMonotonicMs = performance.now();
		const selectedSequence = lifecycleSequence;
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
				schemaVersion: 3 as const,
				sequence: selectedSequence,
				state: input.state,
				trialId: activeTrialId,
			})
		);
		lifecycleSequence += 1;
		return selectedSequence;
	};
	const bytesFrom = async (data: RtcData): Promise<Uint8Array> => {
		if (typeof data === "string") return new TextEncoder().encode(data);
		if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
		if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
	};
	const capture = (
		channel: RTCDataChannel,
		direction: "message" | "send",
		data: RtcData,
		lifecycleSequence: number,
		attemptId?: number
	): void => {
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
					...(attemptId === undefined ? {} : { attemptId }),
					atMs,
					byteLength: bytes.byteLength,
					channelId: identity.channelId,
					connectionId: identity.connectionId,
					direction,
					insertionReadyState: channel.readyState,
					lifecycleSequence,
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
			const messageSequence = recordLifecycle("channel-message", connectionId, {
				bufferedAmount: channel.bufferedAmount,
				channelId,
				label: channel.label,
				owner: "rtc-datachannel-message-event",
				readyState: channel.readyState,
			});
			capture(channel, "message", event.data as RtcData, messageSequence);
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
			const attemptSequence = recordLifecycle("channel-send-attempt", identity.connectionId, {
				attemptId,
				bufferedAmount: this.bufferedAmount,
				channelId: identity.channelId,
				label: this.label,
				owner: "rtc-datachannel-send",
				readyState: this.readyState,
			});
			capture(this, "send", data, attemptSequence, attemptId);
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
	const snapshotChannelStates = (): readonly RtcChannelStateObservation[] =>
		[...watchedChannels]
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
	Object.defineProperty(observedWindow, "__E303_RTC_OBSERVER__", {
		configurable: false,
		value: Object.freeze({
			channelStateSnapshot(): readonly RtcChannelStateObservation[] {
				return snapshotChannelStates();
			},
			async custodySnapshot() {
				await Promise.all([...pending]);
				const lifecycleSequenceFence = lifecycleSequence;
				return Object.freeze({
					channelStates: Object.freeze(snapshotChannelStates()),
					lifecycle: Object.freeze(
						lifecycleRecords
							.filter(({ sequence }) => sequence < lifecycleSequenceFence)
							.map((record) => Object.freeze({ ...record }))
					),
					lifecycleSequenceFence,
					records: Object.freeze(
						records
							.slice()
							.sort((left, right) => left.ordinal - right.ordinal)
							.map((record) => Object.freeze({ ...record }))
					),
				});
			},
			async lifecycleSnapshot(): Promise<readonly RtcLifecycleObservation[]> {
				await Promise.all([...pending]);
				return lifecycleRecords
					.slice()
					.sort((left, right) => left.sequence - right.sequence)
					.map((record) => Object.freeze({ ...record }));
			},
			reset(trialId: string): void {
				activeTrialId = trialId;
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
		let activeTrialId = "observer-install";
		let nextPingOrdinal = 0;
		let sequence = 0;
		const records: Libp2pMonitorObservation[] = [];
		const wrapped = new WeakSet<object>();
		type PingEvidence = {
			carryIn: boolean;
			readonly connection: ConnectionLike;
			failureRecorded: boolean;
			readonly pingId: string;
			successObserved: boolean;
		};
		const pingInFlight = new Map<string, PingEvidence>();
		const failedPingAwaitingAbort = new Map<string, PingEvidence>();
		const record = (
			connection: ConnectionLike,
			event: Libp2pMonitorEventKind,
			owner: string,
			input: Readonly<{ readonly carryIn?: boolean; readonly pingId?: string; readonly reason?: string }> = {}
		): void => {
			records.push(
				Object.freeze({
					atMonotonicMs: performance.now(),
					atWallMs: Date.now(),
					carryIn: input.carryIn ?? false,
					connectionId: connection.id,
					event,
					owner,
					peerId: connection.remotePeer.toString(),
					pingId: input.pingId ?? `${activeTrialId}:event:${connection.id}:${sequence}`,
					reason: input.reason,
					schemaVersion: 3 as const,
					sequence,
					trialId: activeTrialId,
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
					const ping = pingInFlight.get(connection.id) ?? failedPingAwaitingAbort.get(connection.id);
					if (monitorOwned && ping !== undefined && !ping.failureRecorded) {
						record(connection, "ping-failure", "libp2p-connection-monitor", {
							carryIn: ping.carryIn,
							pingId: ping.pingId,
							reason: error?.name ?? error?.message,
						});
						ping.failureRecorded = true;
					}
					pingInFlight.delete(connection.id);
					failedPingAwaitingAbort.delete(connection.id);
					record(connection, "connection-abort", monitorOwned ? "libp2p-connection-monitor" : "other-owner", {
						carryIn: ping?.carryIn,
						pingId: ping?.pingId,
						reason: error?.name ?? error?.message,
					});
					nativeAbort(error);
				},
				writable: true,
			});
			Object.defineProperty(connection, "newStream", {
				configurable: true,
				async value(protocol: string | readonly string[], options?: unknown): Promise<StreamLike> {
					const protocols = typeof protocol === "string" ? [protocol] : protocol;
					const ping = protocols.includes("/ipfs/ping/1.0.0");
					const pingEvidence = ping
						? {
								carryIn: false,
								connection,
								failureRecorded: false,
								pingId: `${activeTrialId}:ping:${nextPingOrdinal}`,
								successObserved: false,
							}
						: undefined;
					if (ping) {
						nextPingOrdinal += 1;
						record(connection, "ping-start", "libp2p-connection-monitor", {
							pingId: pingEvidence?.pingId,
						});
						if (pingEvidence !== undefined) pingInFlight.set(connection.id, pingEvidence);
					}
					try {
						const stream = await nativeNewStream(protocol, options);
						if (!ping) return stream;
						record(connection, "ping-stream-open", "libp2p-connection-monitor", {
							carryIn: pingEvidence?.carryIn,
							pingId: pingEvidence?.pingId,
						});
						stream.addEventListener("message", () => {
							if (pingEvidence !== undefined) pingEvidence.successObserved = true;
							record(connection, "ping-read-success", "libp2p-connection-monitor", {
								carryIn: pingEvidence?.carryIn,
								pingId: pingEvidence?.pingId,
							});
						});
						stream.addEventListener("close", () => {
							pingInFlight.delete(connection.id);
							if (pingEvidence === undefined || pingEvidence.successObserved) {
								failedPingAwaitingAbort.delete(connection.id);
							} else {
								failedPingAwaitingAbort.set(connection.id, pingEvidence);
							}
						});
						return new Proxy(stream, {
							get(target, property, receiver): unknown {
								if (property === "send") {
									return (data: Uint8Array): boolean => {
										const accepted = target.send(data);
										record(connection, "ping-write-success", "libp2p-connection-monitor", {
											carryIn: pingEvidence?.carryIn,
											pingId: pingEvidence?.pingId,
										});
										return accepted;
									};
								}
								if (property === "close") {
									return async (closeOptions?: unknown): Promise<void> => {
										await target.close(closeOptions);
										pingInFlight.delete(connection.id);
										failedPingAwaitingAbort.delete(connection.id);
									};
								}
								const value = Reflect.get(target, property, receiver) as unknown;
								return typeof value === "function" ? value.bind(target) : value;
							},
						});
					} catch (error) {
						if (ping) {
							record(connection, "ping-failure", "libp2p-connection-monitor", {
								carryIn: pingEvidence?.carryIn,
								pingId: pingEvidence?.pingId,
								reason: error instanceof Error ? error.name : String(error),
							});
							if (pingEvidence !== undefined) {
								pingEvidence.failureRecorded = true;
								failedPingAwaitingAbort.set(connection.id, pingEvidence);
							}
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
				reset(trialId: string): void {
					activeTrialId = trialId;
					records.length = 0;
					sequence = 0;
					for (const connection of host.getConnections()) {
						record(connection, "monitor-epoch-start", "e3-03-monitor-observer", {
							pingId: `${trialId}:epoch:${connection.id}`,
						});
					}
					for (const ping of pingInFlight.values()) {
						ping.carryIn = true;
						record(ping.connection, "ping-start", "libp2p-connection-monitor", {
							carryIn: true,
							pingId: ping.pingId,
						});
					}
					for (const ping of failedPingAwaitingAbort.values()) {
						ping.carryIn = true;
						record(ping.connection, "ping-start", "libp2p-connection-monitor", {
							carryIn: true,
							pingId: ping.pingId,
						});
						record(ping.connection, "ping-failure", "libp2p-connection-monitor", {
							carryIn: true,
							pingId: ping.pingId,
						});
					}
				},
				snapshot(): readonly Libp2pMonitorObservation[] {
					return records.slice().map((record) => Object.freeze({ ...record }));
				},
			}),
			writable: false,
		});
	});
}

async function resetRtcObserver(page: Page, trialId: string): Promise<void> {
	await page.evaluate((selectedTrialId) => {
		const observer = window.__E303_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
		observer.reset(selectedTrialId);
	}, trialId);
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

async function resetLibp2pMonitorObserver(page: Page, trialId: string): Promise<void> {
	await page.evaluate((selectedTrialId) => {
		const observer = window.__E303_LIBP2P_MONITOR_OBSERVER__;
		if (observer === undefined) throw new Error("E303_LIBP2P_MONITOR_OBSERVER_ABSENT");
		observer.reset(selectedTrialId);
	}, trialId);
}

async function d108e4hPageCapture(page: Page, trialId: string): Promise<D108e4hPageCapture> {
	return page.evaluate(async (selectedTrialId) => {
		const api = window.__TS_DRP_V3_ZONE__;
		const fabric = api?.fabric;
		const rtc = window.__E303_RTC_OBSERVER__;
		const monitor = window.__E303_LIBP2P_MONITOR_OBSERVER__;
		if (api === undefined || fabric === undefined) throw new Error("E303_FABRIC_WORKBENCH_ABSENT");
		if (rtc === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
		if (monitor === undefined) throw new Error("E303_LIBP2P_MONITOR_OBSERVER_ABSENT");
		const rtcCustody = await rtc.custodySnapshot();
		return Object.freeze({
			fabric: fabric.snapshot(selectedTrialId),
			monitor: monitor.snapshot(),
			rtc: rtcCustody,
			zone: api.snapshot(),
		});
	}, trialId);
}

function d108e4hBoundaryFromCapture(
	capture: Pick<D108e4hPageCapture, "fabric" | "rtc" | "zone">,
	remotePeerId: string
): D108e4hBoundaryCustody {
	return Object.freeze({
		authenticated: Object.freeze(
			capture.fabric.transport.raw
				.filter(({ peerId }) => peerId === remotePeerId)
				.map(({ connectionId, generation, peerId }) => Object.freeze({ connectionId, generation, peerId }))
		),
		rawTransport: capture.zone.rawTransport,
		rtc: Object.freeze(
			capture.rtc.channelStates
				.filter(({ label, readyState }) => label === "ts-drp-ephemeral/1" && readyState === "open")
				.map(({ channelId, connectionId }) =>
					Object.freeze({
						channelId,
						connectionId,
						label: "ts-drp-ephemeral/1" as const,
						readyState: "open" as const,
					})
				)
		),
	});
}

function d108e4hLifecycleFromCapture(
	records: readonly RtcLifecycleObservation[],
	trialId: string
): readonly D108e4hLifecycleObservation[] {
	d108e4hAssert(
		records.every(({ schemaVersion, trialId: recordTrialId }) => schemaVersion === 3 && recordTrialId === trialId),
		"D108E4H_TRIAL_MISMATCH"
	);
	return Object.freeze(
		records.map((record) =>
			Object.freeze({
				attemptId: record.attemptId,
				atMonotonicMs: record.atMonotonicMs,
				atWallMs: record.atWallMs,
				bufferedAmount: record.bufferedAmount,
				callsite: record.callsite,
				channelId: record.channelId,
				connectionId: record.connectionId,
				event: record.event,
				label: record.label,
				owner: record.owner,
				readyState: record.readyState,
				schemaVersion: record.schemaVersion,
				sequence: record.sequence,
				state: record.state,
				trialId: record.trialId,
			})
		)
	);
}

function d108e4hRawSendsFromWire(records: readonly PlatformObservation[]): readonly D108e4hRawSend[] {
	return Object.freeze(
		records
			.filter(({ lane, sentinel }) => lane === "raw" && !sentinel)
			.map(({ attemptId, channelId, connectionId, sequence }) => {
				if (attemptId === undefined) throw new Error("D108E4H_RAW_ATTEMPT_ID_ABSENT");
				return Object.freeze({ attemptId, channelId, connectionId, sequence });
			})
	);
}

function d108e4hOverlapFromWire(records: readonly PlatformObservation[]): readonly D108e4hOverlapObservation[] {
	return Object.freeze(
		records
			.filter(({ lane, sentinel }) => lane === "raw" && !sentinel)
			.map((record) => {
				if (record.lifecycleSequence === undefined) throw new Error("D108E4H_LIFECYCLE_SEQUENCE_ABSENT");
				return Object.freeze({
					...acceptedObservationIdentity(record),
					lifecycleSequence: record.lifecycleSequence,
				});
			})
	);
}

function d108e4hEndpointFromCapture(
	capture: D108e4hPageCapture,
	input: Readonly<{
		readonly acceptedRaw: readonly PlatformObservation[];
		readonly peerId: string;
		readonly prepare: D108e4hBoundaryCustody;
		readonly rawSends: readonly PlatformObservation[];
		readonly rejectedRaw: readonly PlatformObservation[];
		readonly remotePeerId: string;
		readonly transmitsRawTrial: boolean;
		readonly trialId: string;
	}>
): D108e4hEndpointCustody {
	return Object.freeze({
		acceptedRaw: d108e4hOverlapFromWire(input.acceptedRaw),
		deadline: d108e4hBoundaryFromCapture(capture, input.remotePeerId),
		lifecycle: d108e4hLifecycleFromCapture(capture.rtc.lifecycle, input.trialId),
		monitor: Object.freeze(capture.monitor.filter(({ peerId }) => peerId === input.remotePeerId)),
		peerId: input.peerId,
		prepare: input.prepare,
		rawSends: d108e4hRawSendsFromWire(input.rawSends),
		rejectedRaw: d108e4hOverlapFromWire(input.rejectedRaw),
		transmitsRawTrial: input.transmitsRawTrial,
	});
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
				attemptId: record.attemptId,
				byteLength: match[0].length,
				carrierByteLength: record.byteLength,
				channelId: record.channelId,
				channelLabel: record.label,
				connectionId: record.connectionId,
				insertionReadyState: record.insertionReadyState,
				lane,
				lifecycleSequence: record.lifecycleSequence,
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
	| "creator-channel-close"
	| "creator-replacement"
	| "none"
	| "none-persisted-replacement"
	| "receiver-channel-close"
	| "receiver-repeated-replacement"
	| "receiver-replacement";

const D108E4H_RTC_A = Object.freeze({
	channelId: 1_001,
	connectionId: 101,
	generation: 11,
	label: "ts-drp-ephemeral/1" as const,
	readyState: "open" as const,
});
const D108E4H_RTC_B = Object.freeze({
	channelId: 2_003,
	connectionId: 203,
	generation: 29,
	label: "ts-drp-ephemeral/1" as const,
	readyState: "open" as const,
});

function d108e4hRawTransport(
	peerId: string,
	input: Readonly<{
		readonly authenticatedConnectionLosses?: number;
		readonly handshakeFailures?: number;
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
		handshakeFailures: input.handshakeFailures ?? 0,
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
	const selected = connection === "A" ? D108E4H_RTC_A : D108E4H_RTC_B;
	return Object.freeze({
		authenticated: Object.freeze([
			Object.freeze({
				connectionId: `${localPeerId}:${remotePeerId}:authenticated-${connection}`,
				generation: selected.generation,
				peerId: remotePeerId,
			}),
		]),
		rawTransport,
		rtc: Object.freeze([
			Object.freeze({
				channelId: selected.channelId,
				connectionId: selected.connectionId,
				label: selected.label,
				readyState: selected.readyState,
			}),
		]),
	});
}

function d108e4hMonitor(trialId: string, remotePeerId: string): readonly D108e4hMonitorObservation[] {
	return Object.freeze([
		Object.freeze({
			carryIn: false,
			connectionId: `libp2p:${trialId}:0`,
			event: "monitor-epoch-start" as const,
			owner: "e3-03-monitor-observer",
			peerId: remotePeerId,
			pingId: `${trialId}:epoch`,
			schemaVersion: 3 as const,
			sequence: 0,
			trialId,
		}),
	]);
}

function d108e4hLifecycle(
	trialId: string,
	sequence: number,
	event: RtcLifecycleKind,
	rtc: D108e4hRtcIdentity,
	owner: string,
	input: Readonly<{ readonly attemptId?: number; readonly readyState?: RTCDataChannelState }> = {}
): D108e4hLifecycleObservation {
	return Object.freeze({
		attemptId: input.attemptId,
		bufferedAmount: 0,
		channelId: rtc.channelId,
		connectionId: rtc.connectionId,
		event,
		label: rtc.label,
		owner,
		readyState: input.readyState ?? rtc.readyState,
		schemaVersion: 3 as const,
		sequence,
		trialId,
	});
}

function d108e4hSendSlice(
	trialId: string,
	rtc: D108e4hRtcIdentity,
	payloadStart: number,
	payloadCount: number,
	lifecycleStart: number
): Readonly<{
	readonly lifecycle: readonly D108e4hLifecycleObservation[];
	readonly rawSends: readonly D108e4hRawSend[];
}> {
	const lifecycle: D108e4hLifecycleObservation[] = [];
	const rawSends: D108e4hRawSend[] = [];
	for (let offset = 0; offset < payloadCount; offset += 1) {
		const payloadSequence = payloadStart + offset;
		const attemptId = 50_000 + payloadSequence * 3;
		rawSends.push(
			Object.freeze({
				attemptId,
				channelId: rtc.channelId,
				connectionId: rtc.connectionId,
				sequence: payloadSequence,
			})
		);
		lifecycle.push(
			d108e4hLifecycle(trialId, lifecycleStart + offset * 2, "channel-send-attempt", rtc, "rtc-datachannel-send", {
				attemptId,
			}),
			d108e4hLifecycle(trialId, lifecycleStart + offset * 2 + 1, "channel-send-success", rtc, "rtc-datachannel-send", {
				attemptId,
			})
		);
	}
	return Object.freeze({ lifecycle: Object.freeze(lifecycle), rawSends: Object.freeze(rawSends) });
}

function d108e4hAcceptedRaw(
	rtc: D108e4hRtcIdentity,
	payloadSequence: number,
	lifecycleSequence: number
): D108e4hOverlapObservation {
	return Object.freeze({
		channelId: rtc.channelId,
		connectionId: rtc.connectionId,
		insertionReadyState: "open",
		lane: "raw",
		lifecycleSequence,
		ordinal: 70_000 + payloadSequence,
		readyState: "open",
		receivedAtMs: payloadSequence,
		sentAtMs: 10_000 + payloadSequence,
		sequence: payloadSequence,
		sentinel: false,
	});
}

function d108e4hFixture(mode: D108e4hFixtureMode): D108e4hValidationInput {
	const trialId = `d108e4h-${mode}`;
	const creatorPeerId = "peer-creator";
	const receiverPeerId = "peer-receiver";
	const creatorTransition = mode === "creator-replacement" || mode === "creator-channel-close";
	const receiverReplacement = mode === "receiver-replacement" || mode === "receiver-repeated-replacement";
	const receiverChannelClose = mode === "receiver-channel-close";
	const receiverTransition = receiverReplacement || receiverChannelClose;
	const creatorPrepareReason = "restart";
	const receiverPrepareReason =
		mode === "receiver-repeated-replacement" || mode === "none-persisted-replacement" ? "replacement" : "restart";
	const creatorDeadlineReason =
		mode === "creator-replacement"
			? "replacement"
			: mode === "creator-channel-close"
				? "channel-close"
				: creatorPrepareReason;
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
		authenticatedConnectionLosses: creatorTransition ? 1 : 0,
		lastLinkDrop: creatorDeadlineReason,
		linkDrops: creatorTransition ? 5 : 4,
		sent: SAMPLE_COUNT,
	});
	const receiverDeadlineTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses:
			mode === "none" || mode === "none-persisted-replacement" ? 1 : receiverTransition ? 1 : 0,
		lastLinkDrop: receiverDeadlineReason,
		linkDrops: receiverTransition ? 8 : 7,
		received: receiverTransition ? 3 : 1,
	});
	const creatorSendA = d108e4hSendSlice(
		trialId,
		D108E4H_RTC_A,
		0,
		creatorTransition ? SAMPLE_COUNT / 2 : SAMPLE_COUNT,
		0
	);
	const creatorTransitionLifecycle: readonly D108e4hLifecycleObservation[] = creatorTransition
		? Object.freeze([
				d108e4hLifecycle(trialId, 600, "channel-open-event", D108E4H_RTC_B, "rtc-datachannel-open-event"),
				d108e4hLifecycle(trialId, 601, "channel-message-handler-installed", D108E4H_RTC_B, "product-unreliable-webrtc"),
				...(mode === "creator-channel-close"
					? [
							d108e4hLifecycle(trialId, 602, "channel-close-event", D108E4H_RTC_A, "rtc-datachannel-close-event", {
								readyState: "closed",
							}),
							d108e4hLifecycle(trialId, 603, "channel-close-call", D108E4H_RTC_A, "product-unreliable-webrtc"),
						]
					: [
							d108e4hLifecycle(trialId, 602, "channel-close-call", D108E4H_RTC_A, "product-unreliable-webrtc"),
							d108e4hLifecycle(trialId, 603, "channel-close-event", D108E4H_RTC_A, "rtc-datachannel-close-event", {
								readyState: "closed",
							}),
						]),
			])
		: Object.freeze([]);
	const creatorSendB = creatorTransition
		? d108e4hSendSlice(trialId, D108E4H_RTC_B, SAMPLE_COUNT / 2, SAMPLE_COUNT / 2, 604)
		: Object.freeze({ lifecycle: Object.freeze([]), rawSends: Object.freeze([]) });
	const receiverTransitionLifecycle: readonly D108e4hLifecycleObservation[] = receiverTransition
		? Object.freeze([
				d108e4hLifecycle(trialId, 0, "channel-message-handler-installed", D108E4H_RTC_B, "product-unreliable-webrtc"),
				d108e4hLifecycle(trialId, 1, "channel-open-event", D108E4H_RTC_B, "rtc-datachannel-open-event"),
				d108e4hLifecycle(trialId, 2, "channel-message", D108E4H_RTC_B, "rtc-datachannel-message-event"),
				d108e4hLifecycle(trialId, 3, "channel-message", D108E4H_RTC_A, "rtc-datachannel-message-event"),
				...(receiverChannelClose
					? [
							d108e4hLifecycle(trialId, 4, "channel-close-event", D108E4H_RTC_A, "rtc-datachannel-close-event", {
								readyState: "closed",
							}),
							d108e4hLifecycle(trialId, 5, "channel-close-call", D108E4H_RTC_A, "product-unreliable-webrtc"),
						]
					: [
							d108e4hLifecycle(trialId, 4, "channel-close-call", D108E4H_RTC_A, "product-unreliable-webrtc"),
							d108e4hLifecycle(trialId, 5, "channel-close-event", D108E4H_RTC_A, "rtc-datachannel-close-event", {
								readyState: "closed",
							}),
						]),
				d108e4hLifecycle(trialId, 6, "channel-message", D108E4H_RTC_B, "rtc-datachannel-message-event"),
				d108e4hLifecycle(trialId, 7, "channel-message", D108E4H_RTC_A, "rtc-datachannel-message-event", {
					readyState: "closed",
				}),
			])
		: Object.freeze([d108e4hLifecycle(trialId, 0, "channel-message", D108E4H_RTC_A, "rtc-datachannel-message-event")]);
	const delta = (before: ZoneSnapshot["rawTransport"], after: ZoneSnapshot["rawTransport"]): RawTransportDelta =>
		rawTransportDelta(before, after);
	return Object.freeze({
		endpoints: Object.freeze({
			creator: Object.freeze({
				acceptedRaw: Object.freeze([]),
				deadline: d108e4hBoundary(
					creatorPeerId,
					receiverPeerId,
					creatorTransition ? "B" : "A",
					creatorDeadlineTransport
				),
				lifecycle: Object.freeze([...creatorSendA.lifecycle, ...creatorTransitionLifecycle, ...creatorSendB.lifecycle]),
				monitor: d108e4hMonitor(trialId, receiverPeerId),
				peerId: creatorPeerId,
				prepare: d108e4hBoundary(creatorPeerId, receiverPeerId, "A", creatorPrepareTransport),
				rawSends: Object.freeze([...creatorSendA.rawSends, ...creatorSendB.rawSends]),
				rejectedRaw: Object.freeze([]),
				transmitsRawTrial: true,
			}),
			receiver: Object.freeze({
				acceptedRaw: receiverTransition
					? Object.freeze([
							d108e4hAcceptedRaw(D108E4H_RTC_B, 0, 2),
							d108e4hAcceptedRaw(D108E4H_RTC_A, 1, 3),
							d108e4hAcceptedRaw(D108E4H_RTC_B, 2, 6),
						])
					: Object.freeze([d108e4hAcceptedRaw(D108E4H_RTC_A, 0, 0)]),
				deadline: d108e4hBoundary(
					receiverPeerId,
					creatorPeerId,
					receiverTransition ? "B" : "A",
					receiverDeadlineTransport
				),
				lifecycle: receiverTransitionLifecycle,
				monitor: d108e4hMonitor(trialId, creatorPeerId),
				peerId: receiverPeerId,
				prepare: d108e4hBoundary(receiverPeerId, creatorPeerId, "A", receiverPrepareTransport),
				rawSends: Object.freeze([]),
				rejectedRaw: receiverTransition ? Object.freeze([d108e4hAcceptedRaw(D108E4H_RTC_A, 3, 7)]) : Object.freeze([]),
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

function d108e4iPreservedCampaignReplay(): D108e4hValidationInput {
	const trialId = "e3-03-2";
	const creatorPeerId = "peer-creator";
	const receiverPeerId = "peer-receiver";
	const creatorA = Object.freeze({ ...D108E4H_RTC_A, channelId: 416, connectionId: 10 });
	const creatorB = Object.freeze({ ...D108E4H_RTC_B, channelId: 437, connectionId: 12 });
	const receiverA = Object.freeze({ ...D108E4H_RTC_A, channelId: 413, connectionId: 9 });
	const receiverB = Object.freeze({ ...D108E4H_RTC_B, channelId: 438, connectionId: 11 });
	const creatorSendA = d108e4hSendSlice(trialId, creatorA, 0, 595, 0);
	const creatorSendB = d108e4hSendSlice(trialId, creatorB, 595, 5, 1_752);
	const creatorPrepareTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: 2,
		handshakeFailures: 2,
		lastLinkDrop: "restart",
		linkDrops: 4,
		sent: 2_134,
	});
	const creatorDeadlineTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: 3,
		handshakeFailures: 2,
		lastLinkDrop: "replacement",
		linkDrops: 5,
		sent: 2_734,
	});
	const receiverPrepareTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: 2,
		handshakeFailures: 1,
		lastLinkDrop: "restart",
		linkDrops: 4,
		received: 1_505,
	});
	const receiverDeadlineTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: 3,
		handshakeFailures: 1,
		lastLinkDrop: "channel-close",
		linkDrops: 5,
		received: 1_923,
	});
	const receiverMessages = Object.freeze(
		Array.from({ length: 418 }, (_, index) =>
			d108e4hLifecycle(
				trialId,
				index === 417 ? 953 : index,
				"channel-message",
				receiverA,
				"rtc-datachannel-message-event"
			)
		)
	);
	const receiverAccepted = Object.freeze(
		receiverMessages.map(({ sequence }, index) => d108e4hAcceptedRaw(receiverA, index, sequence))
	);
	const boundary = (
		peerId: string,
		generation: number,
		authenticatedConnectionId: string,
		rtc: D108e4hRtcIdentity,
		rawTransport: ZoneSnapshot["rawTransport"]
	): D108e4hBoundaryCustody =>
		Object.freeze({
			authenticated: Object.freeze([Object.freeze({ connectionId: authenticatedConnectionId, generation, peerId })]),
			rawTransport,
			rtc: Object.freeze([rtc]),
		});
	return Object.freeze({
		endpoints: Object.freeze({
			creator: Object.freeze({
				acceptedRaw: Object.freeze([]),
				deadline: boundary(receiverPeerId, 8, "creator-authenticated-B", creatorB, creatorDeadlineTransport),
				lifecycle: Object.freeze([
					...creatorSendA.lifecycle,
					d108e4hLifecycle(trialId, 1_749, "channel-open-event", creatorB, "rtc-datachannel-open-event"),
					d108e4hLifecycle(trialId, 1_750, "channel-message-handler-installed", creatorB, "product-unreliable-webrtc"),
					d108e4hLifecycle(trialId, 1_751, "channel-close-call", creatorA, "product-unreliable-webrtc"),
					...creatorSendB.lifecycle,
				]),
				monitor: d108e4hMonitor(trialId, receiverPeerId),
				peerId: creatorPeerId,
				prepare: boundary(receiverPeerId, 6, "creator-authenticated-A", creatorA, creatorPrepareTransport),
				rawSends: Object.freeze([...creatorSendA.rawSends, ...creatorSendB.rawSends]),
				rejectedRaw: Object.freeze([]),
				transmitsRawTrial: true,
			}),
			receiver: Object.freeze({
				acceptedRaw: receiverAccepted,
				deadline: boundary(creatorPeerId, 8, "receiver-authenticated-B", receiverB, receiverDeadlineTransport),
				lifecycle: Object.freeze([
					...receiverMessages,
					d108e4hLifecycle(trialId, 956, "channel-message-handler-installed", receiverB, "product-unreliable-webrtc"),
					d108e4hLifecycle(trialId, 957, "channel-open-event", receiverB, "rtc-datachannel-open-event"),
					d108e4hLifecycle(trialId, 1_115, "channel-close-event", receiverA, "rtc-datachannel-close-event", {
						readyState: "closed",
					}),
					d108e4hLifecycle(trialId, 1_116, "channel-close-call", receiverA, "product-unreliable-webrtc"),
				]),
				monitor: d108e4hMonitor(trialId, creatorPeerId),
				peerId: receiverPeerId,
				prepare: boundary(creatorPeerId, 6, "receiver-authenticated-A", receiverA, receiverPrepareTransport),
				rawSends: Object.freeze([]),
				rejectedRaw: Object.freeze([]),
				transmitsRawTrial: false,
			}),
		}),
		rawTransportDeltas: Object.freeze({
			creator: rawTransportDelta(creatorPrepareTransport, creatorDeadlineTransport),
			receiver: rawTransportDelta(receiverPrepareTransport, receiverDeadlineTransport),
		}),
		sampleCount: SAMPLE_COUNT,
		schemaVersion: 3,
		trialId,
	});
}

function d108e4hAssert(condition: unknown, code: string): asserts condition {
	if (!condition) throw new Error(code);
}

function d108e4hAssertClosedSequence(records: readonly { readonly sequence: number }[]): void {
	let previous = -1;
	for (const { sequence } of records) {
		d108e4hAssert(Number.isSafeInteger(sequence) && sequence >= 0 && sequence > previous, "D108E4H_SEQUENCE_INVALID");
		previous = sequence;
	}
}

function d108e4hOnly<T>(records: readonly T[]): T {
	d108e4hAssert(records.length === 1, "D108E4H_IDENTITY_JOIN_INVALID");
	return records[0] as T;
}

function d108e4hAssertDelta(actual: RawTransportDelta, expected: RawTransportDelta): void {
	d108e4hAssert(
		actual.authenticatedConnectionLosses === expected.authenticatedConnectionLosses &&
			actual.backpressuredDrops === expected.backpressuredDrops &&
			actual.handshakeFailures === expected.handshakeFailures &&
			actual.linkDrops === expected.linkDrops &&
			actual.lastLinkDrop.after === expected.lastLinkDrop.after &&
			actual.lastLinkDrop.before === expected.lastLinkDrop.before &&
			actual.lastLinkDrop.changed === expected.lastLinkDrop.changed,
		"D108E4H_DELTA_MISMATCH"
	);
}

function d108e4hAssertBoundaryIdentity(
	endpoint: D108e4hEndpointCustody,
	remotePeerId: string,
	replaced: boolean
): Readonly<{ readonly after: D108e4hRtcIdentity; readonly before: D108e4hRtcIdentity }> {
	const beforeAuthenticated = d108e4hOnly(endpoint.prepare.authenticated);
	const afterAuthenticated = d108e4hOnly(endpoint.deadline.authenticated);
	const beforeRtc = d108e4hOnly(endpoint.prepare.rtc);
	const afterRtc = d108e4hOnly(endpoint.deadline.rtc);
	d108e4hAssert(
		beforeAuthenticated.peerId === remotePeerId &&
			afterAuthenticated.peerId === remotePeerId &&
			beforeRtc.label === "ts-drp-ephemeral/1" &&
			afterRtc.label === "ts-drp-ephemeral/1" &&
			beforeRtc.readyState === "open" &&
			afterRtc.readyState === "open",
		"D108E4H_IDENTITY_JOIN_INVALID"
	);
	const authenticatedChanged =
		beforeAuthenticated.connectionId !== afterAuthenticated.connectionId &&
		beforeAuthenticated.generation < afterAuthenticated.generation;
	const rtcChanged = beforeRtc.connectionId !== afterRtc.connectionId && beforeRtc.channelId !== afterRtc.channelId;
	if (replaced) {
		d108e4hAssert(authenticatedChanged && rtcChanged, "D108E4H_IDENTITY_JOIN_INVALID");
	} else {
		d108e4hAssert(
			beforeAuthenticated.connectionId === afterAuthenticated.connectionId &&
				beforeAuthenticated.generation === afterAuthenticated.generation &&
				beforeRtc.connectionId === afterRtc.connectionId &&
				beforeRtc.channelId === afterRtc.channelId,
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
	}
	return Object.freeze({ after: afterRtc, before: beforeRtc });
}

function d108e4hAssertMonitor(endpoint: D108e4hEndpointCustody, remotePeerId: string, trialId: string): void {
	d108e4hAssert(endpoint.monitor.length > 0, "D108E4H_MONITOR_CUSTODY_ABSENT");
	d108e4hAssertClosedSequence(endpoint.monitor);
	const byPing = new Map<string, D108e4hMonitorObservation[]>();
	for (const record of endpoint.monitor) {
		d108e4hAssert(record.schemaVersion === 3, "D108E4H_SCHEMA_INVALID");
		d108e4hAssert(record.trialId === trialId, "D108E4H_TRIAL_MISMATCH");
		d108e4hAssert(record.peerId === remotePeerId, "D108E4H_MONITOR_PEER_INVALID");
		d108e4hAssert(record.pingId.length > 0, "D108E4H_MONITOR_PING_CUSTODY_INVALID");
		const records = byPing.get(record.pingId) ?? [];
		records.push(record);
		byPing.set(record.pingId, records);
	}
	for (const records of byPing.values()) {
		const carryIn = new Set(records.map((record) => record.carryIn));
		const uniqueEvents = ["monitor-epoch-start", "ping-start", "ping-failure", "connection-abort"] as const;
		d108e4hAssert(
			carryIn.size === 1 &&
				uniqueEvents.every((event) => records.filter((record) => record.event === event).length <= 1),
			"D108E4H_MONITOR_PING_CUSTODY_INVALID"
		);
		const start = records.find(({ event }) => event === "ping-start");
		const failure = records.find(({ event }) => event === "ping-failure");
		const abort = records.find(({ event }) => event === "connection-abort");
		if (records.some(({ event }) => event.startsWith("ping-"))) {
			d108e4hAssert(start !== undefined, "D108E4H_MONITOR_PING_CUSTODY_INVALID");
		}
		if (failure !== undefined && start !== undefined) {
			d108e4hAssert(start !== undefined && start.sequence < failure.sequence, "D108E4H_MONITOR_PING_CUSTODY_INVALID");
		}
		if (abort?.owner === "libp2p-connection-monitor") {
			d108e4hAssert(failure !== undefined && failure.sequence < abort.sequence, "D108E4H_MONITOR_PING_CUSTODY_INVALID");
		}
	}
}

function d108e4hAssertAttemptCustody(
	endpoint: D108e4hEndpointCustody,
	before: D108e4hRtcIdentity,
	after: D108e4hRtcIdentity,
	replaced: boolean,
	sampleCount: number
): void {
	const attempts = endpoint.lifecycle.filter(
		({ event, label }) => event === "channel-send-attempt" && label === "ts-drp-ephemeral/1"
	);
	const terminals = endpoint.lifecycle.filter(
		({ event, label }) =>
			label === "ts-drp-ephemeral/1" && (event === "channel-send-success" || event === "channel-send-failure")
	);
	if (!endpoint.transmitsRawTrial) {
		d108e4hAssert(
			endpoint.rawSends.length === 0 && attempts.length === 0 && terminals.length === 0,
			"D108E4H_RAW_SEND_ROLE_INVALID"
		);
		return;
	}
	d108e4hAssert(endpoint.rawSends.length > 0, "D108E4H_RAW_SEND_ROLE_INVALID");
	const sequences = new Set<number>();
	const attemptIds = new Set<number>();
	for (const send of endpoint.rawSends) {
		d108e4hAssert(
			Number.isSafeInteger(send.sequence) &&
				send.sequence >= 0 &&
				send.sequence < sampleCount &&
				!sequences.has(send.sequence),
			"D108E4H_RAW_SEND_DOMAIN_INVALID"
		);
		sequences.add(send.sequence);
		d108e4hAssert(!attemptIds.has(send.attemptId), "D108E4H_IDENTITY_JOIN_INVALID");
		attemptIds.add(send.attemptId);
		const joinedAttempts = attempts.filter(({ attemptId }) => attemptId === send.attemptId);
		d108e4hAssert(joinedAttempts.length === 1, "D108E4H_IDENTITY_JOIN_INVALID");
		const attempt = joinedAttempts[0] as D108e4hLifecycleObservation;
		d108e4hAssert(
			attempt.channelId === send.channelId && attempt.connectionId === send.connectionId,
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
		const joinedTerminals = terminals.filter(({ attemptId }) => attemptId === send.attemptId);
		d108e4hAssert(joinedTerminals.length === 1, "D108E4H_ATTEMPT_TERMINAL_CARDINALITY");
		const terminal = joinedTerminals[0] as D108e4hLifecycleObservation;
		d108e4hAssert(
			terminal.channelId === send.channelId && terminal.connectionId === send.connectionId,
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
		d108e4hAssert(terminal.event === "channel-send-success", "D108E4H_RAW_SEND_NOT_SUCCESSFUL");
		d108e4hAssert(attempt.sequence < terminal.sequence, "D108E4H_LIFECYCLE_ORDER_INVALID");
	}
	d108e4hAssert(sequences.size === sampleCount, "D108E4H_RAW_SEND_DOMAIN_INVALID");
	d108e4hAssert(
		attempts.every(({ attemptId }) => attemptId !== undefined && attemptIds.has(attemptId)) &&
			terminals.every(({ attemptId }) => attemptId !== undefined && attemptIds.has(attemptId)),
		"D108E4H_IDENTITY_JOIN_INVALID"
	);
	if (replaced) {
		const replacementOpens = endpoint.lifecycle.filter(
			({ channelId, connectionId, event, label }) =>
				connectionId === after.connectionId &&
				channelId === after.channelId &&
				event === "channel-open-event" &&
				label === "ts-drp-ephemeral/1"
		);
		const replacementHandlers = endpoint.lifecycle.filter(
			({ channelId, connectionId, event, label, owner }) =>
				connectionId === after.connectionId &&
				channelId === after.channelId &&
				event === "channel-message-handler-installed" &&
				label === "ts-drp-ephemeral/1" &&
				owner === "product-unreliable-webrtc"
		);
		d108e4hAssert(replacementOpens.length === 1 && replacementHandlers.length === 1, "D108E4H_LIFECYCLE_ORDER_INVALID");
		const replacementOpen = replacementOpens[0] as D108e4hLifecycleObservation;
		const replacementHandler = replacementHandlers[0] as D108e4hLifecycleObservation;
		for (const send of endpoint.rawSends) {
			if (send.connectionId !== after.connectionId || send.channelId !== after.channelId) continue;
			const attempt = attempts.find(({ attemptId }) => attemptId === send.attemptId);
			d108e4hAssert(
				attempt !== undefined &&
					replacementOpen.sequence < attempt.sequence &&
					replacementHandler.sequence < attempt.sequence,
				"D108E4H_LIFECYCLE_ORDER_INVALID"
			);
		}
	}
	d108e4hAssert(
		endpoint.rawSends.every(
			({ channelId, connectionId }) =>
				(connectionId === before.connectionId && channelId === before.channelId) ||
				(connectionId === after.connectionId && channelId === after.channelId)
		),
		"D108E4H_IDENTITY_JOIN_INVALID"
	);
}

function d108e4hAssertOverlapCustody(
	endpoint: D108e4hEndpointCustody,
	before: D108e4hRtcIdentity,
	after: D108e4hRtcIdentity,
	replaced: boolean,
	transitionReason: "channel-close" | "replacement" | undefined
): void {
	const messages = endpoint.lifecycle.filter(
		({ event, label }) => event === "channel-message" && label === "ts-drp-ephemeral/1"
	);
	const ledger = [...endpoint.acceptedRaw, ...endpoint.rejectedRaw];
	const joined = new Set<number>();
	for (const record of ledger) {
		d108e4hAssert(!joined.has(record.lifecycleSequence), "D108E4H_OVERLAP_LEDGER_INVALID");
		joined.add(record.lifecycleSequence);
		const message = messages.find(({ sequence }) => sequence === record.lifecycleSequence);
		d108e4hAssert(
			message !== undefined &&
				message.connectionId === record.connectionId &&
				message.channelId === record.channelId &&
				record.lane === "raw" &&
				!record.sentinel,
			"D108E4H_OVERLAP_LEDGER_INVALID"
		);
	}
	d108e4hAssert(
		messages.length === ledger.length && messages.every(({ sequence }) => joined.has(sequence)),
		"D108E4H_OVERLAP_LEDGER_INVALID"
	);
	if (!replaced) return;
	const replacementOpens = endpoint.lifecycle.filter(
		({ channelId, connectionId, event, label }) =>
			connectionId === after.connectionId &&
			channelId === after.channelId &&
			event === "channel-open-event" &&
			label === "ts-drp-ephemeral/1"
	);
	const replacementHandlers = endpoint.lifecycle.filter(
		({ channelId, connectionId, event, label, owner }) =>
			connectionId === after.connectionId &&
			channelId === after.channelId &&
			event === "channel-message-handler-installed" &&
			label === "ts-drp-ephemeral/1" &&
			owner === "product-unreliable-webrtc"
	);
	const oldCloseCalls = endpoint.lifecycle.filter(
		({ channelId, connectionId, event, label, owner }) =>
			connectionId === before.connectionId &&
			channelId === before.channelId &&
			event === "channel-close-call" &&
			label === "ts-drp-ephemeral/1" &&
			owner === "product-unreliable-webrtc"
	);
	const oldCloseEvents = endpoint.lifecycle.filter(
		({ channelId, connectionId, event, label, owner }) =>
			connectionId === before.connectionId &&
			channelId === before.channelId &&
			event === "channel-close-event" &&
			label === "ts-drp-ephemeral/1" &&
			owner === "rtc-datachannel-close-event"
	);
	d108e4hAssert(replacementOpens.length === 1 && replacementHandlers.length === 1, "D108E4H_LIFECYCLE_ORDER_INVALID");
	const replacementOpen = replacementOpens[0] as D108e4hLifecycleObservation;
	const replacementHandler = replacementHandlers[0] as D108e4hLifecycleObservation;
	let acceptedBefore: D108e4hLifecycleObservation;
	if (transitionReason === "channel-close") {
		d108e4hAssert(
			oldCloseCalls.length === 1 && oldCloseCalls[0]?.bufferedAmount === 0,
			"D108E4H_CHANNEL_CLOSE_DRAIN_INVALID"
		);
		d108e4hAssert(oldCloseEvents.length === 1, "D108E4H_LIFECYCLE_CUSTODY_ABSENT");
		const oldCloseCall = oldCloseCalls[0] as D108e4hLifecycleObservation;
		const oldCloseEvent = oldCloseEvents[0] as D108e4hLifecycleObservation;
		d108e4hAssert(
			replacementOpen.sequence < oldCloseEvent.sequence &&
				replacementHandler.sequence < oldCloseEvent.sequence &&
				oldCloseEvent.sequence < oldCloseCall.sequence,
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const postCloseReplacementMessages = messages.filter(
			({ channelId, connectionId, sequence }) =>
				connectionId === after.connectionId && channelId === after.channelId && sequence > oldCloseEvent.sequence
		);
		d108e4hAssert(
			postCloseReplacementMessages.every(({ sequence }) =>
				endpoint.acceptedRaw.some(({ lifecycleSequence }) => lifecycleSequence === sequence)
			),
			"D108E4H_CHANNEL_CLOSE_INGRESS_INVALID"
		);
		acceptedBefore = oldCloseEvent;
	} else {
		d108e4hAssert(
			transitionReason === "replacement" && oldCloseCalls.length === 1 && oldCloseEvents.length <= 1,
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const oldCloseCall = oldCloseCalls[0] as D108e4hLifecycleObservation;
		const oldCloseEvent = oldCloseEvents[0];
		d108e4hAssert(
			replacementOpen.sequence < oldCloseCall.sequence &&
				replacementHandler.sequence < oldCloseCall.sequence &&
				(oldCloseEvent === undefined || oldCloseCall.sequence < oldCloseEvent.sequence),
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		acceptedBefore = oldCloseCall;
	}
	const replacementMessages = messages.filter(
		({ channelId, connectionId }) => connectionId === after.connectionId && channelId === after.channelId
	);
	d108e4hAssert(
		replacementMessages.every(
			({ sequence }) => replacementHandler.sequence < sequence && replacementOpen.sequence < sequence
		),
		"D108E4H_LIFECYCLE_ORDER_INVALID"
	);
	d108e4hAssert(
		replacementMessages.every(({ sequence }) =>
			endpoint.acceptedRaw.some(({ lifecycleSequence }) => lifecycleSequence === sequence)
		),
		"D108E4H_OVERLAP_LEDGER_INVALID"
	);
	for (const accepted of endpoint.acceptedRaw) {
		if (accepted.connectionId === before.connectionId && accepted.channelId === before.channelId) {
			d108e4hAssert(accepted.lifecycleSequence < acceptedBefore.sequence, "D108E4H_OVERLAP_LEDGER_INVALID");
		}
	}
}

function d108e4hValidateEndpoint(
	endpoint: D108e4hEndpointCustody,
	remotePeerId: string,
	delta: RawTransportDelta,
	sampleCount: number,
	trialId: string
): void {
	d108e4hAssert(endpoint.lifecycle.length > 0, "D108E4H_LIFECYCLE_CUSTODY_ABSENT");
	for (const record of endpoint.lifecycle) {
		d108e4hAssert(record.schemaVersion === 3, "D108E4H_SCHEMA_INVALID");
		d108e4hAssert(record.trialId === trialId, "D108E4H_TRIAL_MISMATCH");
	}
	d108e4hAssertClosedSequence(endpoint.lifecycle);
	d108e4hAssertMonitor(endpoint, remotePeerId, trialId);
	const expectedDelta = rawTransportDelta(endpoint.prepare.rawTransport, endpoint.deadline.rawTransport);
	d108e4hAssertDelta(delta, expectedDelta);
	d108e4hAssert(
		Number.isSafeInteger(delta.linkDrops) && delta.linkDrops >= 0 && delta.linkDrops <= 1,
		"D108E4H_DROP_COUNT_AMBIGUOUS"
	);
	const replaced = delta.linkDrops === 1;
	let transitionReason: "channel-close" | "replacement" | undefined;
	if (replaced) {
		const recordedReason = delta.lastLinkDrop.after;
		d108e4hAssert(
			recordedReason === "replacement" || recordedReason === "channel-close",
			"D108E4H_DROP_REASON_UNSUPPORTED"
		);
		transitionReason = recordedReason;
	}
	const { after, before } = d108e4hAssertBoundaryIdentity(endpoint, remotePeerId, replaced);
	d108e4hAssertAttemptCustody(endpoint, before, after, replaced, sampleCount);
	d108e4hAssertOverlapCustody(endpoint, before, after, replaced, transitionReason);
	d108e4hAssert(delta.backpressuredDrops === 0, "D108E4H_RAW_BACKPRESSURE");
	d108e4hAssert(
		endpoint.deadline.rawTransport.sent - endpoint.prepare.rawTransport.sent === endpoint.rawSends.length &&
			endpoint.deadline.rawTransport.received - endpoint.prepare.rawTransport.received === endpoint.acceptedRaw.length,
		"D108E4H_RAW_COUNTER_MISMATCH"
	);
}

function validateD108e4hCampaignCustody(input: D108e4hValidationInput): void {
	d108e4hAssert(
		input !== null &&
			typeof input === "object" &&
			input.endpoints !== null &&
			typeof input.endpoints === "object" &&
			input.endpoints.creator !== undefined &&
			input.endpoints.receiver !== undefined,
		"D108E4H_ENDPOINT_CUSTODY_ABSENT"
	);
	d108e4hAssert(input.schemaVersion === 3, "D108E4H_SCHEMA_INVALID");
	d108e4hAssert(
		Number.isSafeInteger(input.sampleCount) && input.sampleCount > 0 && input.trialId.length > 0,
		"D108E4H_SCHEMA_INVALID"
	);
	d108e4hValidateEndpoint(
		input.endpoints.creator,
		input.endpoints.receiver.peerId,
		input.rawTransportDeltas.creator,
		input.sampleCount,
		input.trialId
	);
	d108e4hValidateEndpoint(
		input.endpoints.receiver,
		input.endpoints.creator.peerId,
		input.rawTransportDeltas.receiver,
		input.sampleCount,
		input.trialId
	);
}

if (process.env["D108E4H_TELEMETRY"] === "1") {
	test("validates schema-v3 replacement custody without cross-peer clocks", () => {
		const noReplacement = d108e4hFixture("none");
		const persistedReplacementWithoutDrop = d108e4hFixture("none-persisted-replacement");
		const creatorChannelClose = d108e4hFixture("creator-channel-close");
		const creatorReplacement = d108e4hFixture("creator-replacement");
		const receiverReplacement = d108e4hFixture("receiver-replacement");
		const repeatedReplacement = d108e4hFixture("receiver-repeated-replacement");
		const receiverChannelClose = d108e4hFixture("receiver-channel-close");
		const preservedCampaignReplay = d108e4iPreservedCampaignReplay();
		const replayCreator = preservedCampaignReplay.endpoints.creator;
		const replayReceiver = preservedCampaignReplay.endpoints.receiver;
		expect([
			replayCreator.prepare.rtc.map(({ channelId, connectionId }) => [connectionId, channelId]),
			replayCreator.deadline.rtc.map(({ channelId, connectionId }) => [connectionId, channelId]),
			replayReceiver.prepare.rtc.map(({ channelId, connectionId }) => [connectionId, channelId]),
			replayReceiver.deadline.rtc.map(({ channelId, connectionId }) => [connectionId, channelId]),
		]).toEqual([[[10, 416]], [[12, 437]], [[9, 413]], [[11, 438]]]);
		expect(
			[10, 12].map((connectionId) => replayCreator.rawSends.filter((send) => send.connectionId === connectionId).length)
		).toEqual([595, 5]);
		expect({
			receiverA: replayReceiver.acceptedRaw.filter(({ connectionId }) => connectionId === 9).length,
			receiverB: replayReceiver.acceptedRaw.filter(({ connectionId }) => connectionId === 11).length,
		}).toEqual({ receiverA: 418, receiverB: 0 });
		expect(
			replayCreator.lifecycle
				.filter(
					({ channelId, connectionId, event, owner }) =>
						(connectionId === 12 && channelId === 437) ||
						(event === "channel-close-call" && owner === "product-unreliable-webrtc")
				)
				.filter(({ event }) =>
					[
						"channel-open-event",
						"channel-message-handler-installed",
						"channel-close-call",
						"channel-send-attempt",
						"channel-send-success",
					].includes(event)
				)
				.slice(0, 5)
				.map(({ event, sequence }) => [sequence, event])
		).toEqual([
			[1_749, "channel-open-event"],
			[1_750, "channel-message-handler-installed"],
			[1_751, "channel-close-call"],
			[1_752, "channel-send-attempt"],
			[1_753, "channel-send-success"],
		]);
		expect(
			replayReceiver.lifecycle
				.filter(
					({ channelId, connectionId, event, owner }) =>
						(connectionId === 11 && channelId === 438 && owner === "product-unreliable-webrtc") ||
						(event === "channel-open-event" && connectionId === 11 && channelId === 438) ||
						(connectionId === 9 &&
							channelId === 413 &&
							(event === "channel-close-event" ||
								(event === "channel-close-call" && owner === "product-unreliable-webrtc")))
				)
				.map(({ event, sequence }) => [sequence, event])
		).toEqual([
			[956, "channel-message-handler-installed"],
			[957, "channel-open-event"],
			[1_115, "channel-close-event"],
			[1_116, "channel-close-call"],
		]);
		expect(() => validateD108e4hCampaignCustody(preservedCampaignReplay)).not.toThrow();
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
							connectionId: "libp2p:carry-in:0",
							event: "ping-start" as const,
							owner: "libp2p-connection-monitor",
							peerId: "peer-creator",
							pingId: `${noReplacement.trialId}:carry-in:0`,
							schemaVersion: 3 as const,
							sequence: 1,
							trialId: noReplacement.trialId,
						}),
						Object.freeze({
							carryIn: true,
							connectionId: "libp2p:carry-in:0",
							event: "ping-failure" as const,
							owner: "libp2p-connection-monitor",
							peerId: "peer-creator",
							pingId: `${noReplacement.trialId}:carry-in:0`,
							schemaVersion: 3 as const,
							sequence: 2,
							trialId: noReplacement.trialId,
						}),
						Object.freeze({
							carryIn: true,
							connectionId: "libp2p:carry-in:0",
							event: "connection-abort" as const,
							owner: "libp2p-connection-monitor",
							peerId: "peer-creator",
							pingId: `${noReplacement.trialId}:carry-in:0`,
							schemaVersion: 3 as const,
							sequence: 3,
							trialId: noReplacement.trialId,
						}),
					]),
				}),
			}),
		});
		for (const fixture of [
			noReplacement,
			persistedReplacementWithoutDrop,
			creatorChannelClose,
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
		const withCreatorLifecycle = (
			fixture: D108e4hValidationInput,
			lifecycle: readonly D108e4hLifecycleObservation[]
		): D108e4hValidationInput =>
			Object.freeze({
				...fixture,
				endpoints: Object.freeze({
					...fixture.endpoints,
					creator: Object.freeze({ ...fixture.endpoints.creator, lifecycle: Object.freeze(lifecycle) }),
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

		const creatorReplacementWithoutCloseEvent = withCreatorLifecycle(
			creatorReplacement,
			creatorReplacement.endpoints.creator.lifecycle.filter(
				({ channelId, connectionId, event }) =>
					!(
						event === "channel-close-event" &&
						connectionId === D108E4H_RTC_A.connectionId &&
						channelId === D108E4H_RTC_A.channelId
					)
			)
		);
		const creatorChannelCloseRemoteOrder = creatorChannelClose;
		const receiverDirectionalFixture = (
			fixture: D108e4hValidationInput,
			input: Readonly<{
				readonly omitCloseEvent?: boolean;
				readonly removeBDelivery?: boolean;
			}>
		): D108e4hValidationInput => {
			const accepted = input.removeBDelivery
				? fixture.endpoints.receiver.acceptedRaw.filter(
						({ channelId, connectionId }) =>
							connectionId === D108E4H_RTC_A.connectionId && channelId === D108E4H_RTC_A.channelId
					)
				: fixture.endpoints.receiver.acceptedRaw;
			const transportAdjusted = withReceiverDeadlineTransport(
				fixture,
				Object.freeze({
					...fixture.endpoints.receiver.deadline.rawTransport,
					received: accepted.length,
				})
			);
			const lifecycle = fixture.endpoints.receiver.lifecycle.flatMap((record) => {
				if (
					input.removeBDelivery &&
					record.event === "channel-message" &&
					record.connectionId === D108E4H_RTC_B.connectionId &&
					record.channelId === D108E4H_RTC_B.channelId
				) {
					return Object.freeze([]);
				}
				if (
					input.omitCloseEvent &&
					record.event === "channel-close-event" &&
					record.connectionId === D108E4H_RTC_A.connectionId &&
					record.channelId === D108E4H_RTC_A.channelId
				) {
					return Object.freeze([]);
				}
				return Object.freeze([record]);
			});
			return Object.freeze({
				...transportAdjusted,
				endpoints: Object.freeze({
					...transportAdjusted.endpoints,
					receiver: Object.freeze({
						...transportAdjusted.endpoints.receiver,
						acceptedRaw: Object.freeze(accepted),
						lifecycle: Object.freeze(lifecycle),
					}),
				}),
			});
		};
		const receiverReplacementWithoutCloseEvent = receiverDirectionalFixture(receiverReplacement, {
			omitCloseEvent: true,
		});
		const receiverReplacementWithoutBDelivery = receiverDirectionalFixture(receiverReplacement, {
			removeBDelivery: true,
		});
		const receiverChannelCloseRemoteOrder = receiverDirectionalFixture(receiverChannelClose, {});
		const receiverChannelCloseRemoteOrderWithoutBDelivery = receiverDirectionalFixture(receiverChannelClose, {
			removeBDelivery: true,
		});
		for (const [name, fixture] of [
			["replacement/transmitter without deadline close-event", creatorReplacementWithoutCloseEvent],
			["replacement/nontransmitter without deadline close-event", receiverReplacementWithoutCloseEvent],
			["replacement/nontransmitter without B delivery", receiverReplacementWithoutBDelivery],
			["channel-close/transmitter remote order", creatorChannelCloseRemoteOrder],
			["channel-close/nontransmitter remote order with accepted B", receiverChannelCloseRemoteOrder],
			["channel-close/nontransmitter without B delivery", receiverChannelCloseRemoteOrderWithoutBDelivery],
		] as const) {
			expect.soft(() => validateD108e4hCampaignCustody(fixture), `D108E4I_RED ${name}`).not.toThrow();
		}
		const channelCloseWithoutProductCall = withReceiverLifecycle(
			receiverChannelCloseRemoteOrder,
			receiverChannelCloseRemoteOrder.endpoints.receiver.lifecycle.filter(
				({ channelId, connectionId, event }) =>
					!(
						event === "channel-close-call" &&
						connectionId === D108E4H_RTC_A.connectionId &&
						channelId === D108E4H_RTC_A.channelId
					)
			)
		);
		expect
			.soft(
				() => validateD108e4hCampaignCustody(channelCloseWithoutProductCall),
				"D108E4I_RED channel-close owns a mandatory zero-buffer product close-call"
			)
			.toThrowError("D108E4H_CHANNEL_CLOSE_DRAIN_INVALID");

		const creatorRecord = (
			fixture: D108e4hValidationInput,
			event: RtcLifecycleKind,
			rtc: D108e4hRtcIdentity
		): D108e4hLifecycleObservation => {
			const record = fixture.endpoints.creator.lifecycle.find(
				(candidate) =>
					candidate.event === event &&
					candidate.connectionId === rtc.connectionId &&
					candidate.channelId === rtc.channelId
			);
			if (record === undefined) throw new Error(`D108E4I_FIXTURE_${event.toUpperCase()}_ABSENT`);
			return record;
		};
		const swapCreatorSequences = (
			fixture: D108e4hValidationInput,
			left: D108e4hLifecycleObservation,
			right: D108e4hLifecycleObservation
		): D108e4hValidationInput =>
			withCreatorLifecycle(
				fixture,
				Object.freeze(
					fixture.endpoints.creator.lifecycle
						.map((record) =>
							record === left
								? Object.freeze({ ...record, sequence: right.sequence })
								: record === right
									? Object.freeze({ ...record, sequence: left.sequence })
									: record
						)
						.sort((a, b) => a.sequence - b.sequence)
				)
			);
		const creatorReplacementCloseCall = creatorRecord(creatorReplacement, "channel-close-call", D108E4H_RTC_A);
		const creatorReplacementCloseEvent = creatorRecord(creatorReplacement, "channel-close-event", D108E4H_RTC_A);
		const creatorReplacementOpen = creatorRecord(creatorReplacement, "channel-open-event", D108E4H_RTC_B);
		const creatorReplacementHandler = creatorRecord(
			creatorReplacement,
			"channel-message-handler-installed",
			D108E4H_RTC_B
		);
		const creatorReplacementFirstBAttempt = creatorRecord(creatorReplacement, "channel-send-attempt", D108E4H_RTC_B);
		for (const fixture of [
			swapCreatorSequences(creatorReplacement, creatorReplacementCloseCall, creatorReplacementCloseEvent),
			swapCreatorSequences(creatorReplacement, creatorReplacementOpen, creatorReplacementCloseCall),
		] as const) {
			expect(() => validateD108e4hCampaignCustody(fixture)).toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		}
		const creatorSendBeforeHandler = swapCreatorSequences(
			creatorReplacement,
			creatorReplacementHandler,
			creatorReplacementFirstBAttempt
		);
		expect
			.soft(
				() => validateD108e4hCampaignCustody(creatorSendBeforeHandler),
				"D108E4I_RED B native send cannot precede its exact product handler"
			)
			.toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");

		const receiverChannelCloseHandler = receiverChannelCloseRemoteOrder.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-message-handler-installed" &&
				connectionId === D108E4H_RTC_B.connectionId &&
				channelId === D108E4H_RTC_B.channelId
		);
		const receiverChannelCloseOpen = receiverChannelCloseRemoteOrder.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-open-event" &&
				connectionId === D108E4H_RTC_B.connectionId &&
				channelId === D108E4H_RTC_B.channelId
		);
		const receiverChannelCloseFirstB = receiverChannelCloseRemoteOrder.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-message" &&
				connectionId === D108E4H_RTC_B.connectionId &&
				channelId === D108E4H_RTC_B.channelId
		);
		const receiverChannelCloseAcceptedA = receiverChannelCloseRemoteOrder.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-message" &&
				connectionId === D108E4H_RTC_A.connectionId &&
				channelId === D108E4H_RTC_A.channelId
		);
		const receiverChannelCloseEvent = receiverChannelCloseRemoteOrder.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-close-event" &&
				connectionId === D108E4H_RTC_A.connectionId &&
				channelId === D108E4H_RTC_A.channelId
		);
		if (
			receiverChannelCloseHandler === undefined ||
			receiverChannelCloseOpen === undefined ||
			receiverChannelCloseFirstB === undefined ||
			receiverChannelCloseAcceptedA === undefined ||
			receiverChannelCloseEvent === undefined
		) {
			throw new Error("D108E4I_FIXTURE_CHANNEL_CLOSE_RECORD_ABSENT");
		}
		const channelCloseBeforeBReadyBase = withReceiverLifecycle(
			receiverChannelCloseRemoteOrder,
			Object.freeze(
				receiverChannelCloseRemoteOrder.endpoints.receiver.lifecycle
					.map((record) =>
						record === receiverChannelCloseAcceptedA
							? Object.freeze({ ...record, sequence: 0 })
							: record === receiverChannelCloseEvent
								? Object.freeze({ ...record, sequence: 1 })
								: record === receiverChannelCloseHandler
									? Object.freeze({ ...record, sequence: 2 })
									: record === receiverChannelCloseOpen
										? Object.freeze({ ...record, sequence: 3 })
										: record === receiverChannelCloseFirstB
											? Object.freeze({ ...record, sequence: 4 })
											: record
					)
					.sort((a, b) => a.sequence - b.sequence)
			)
		);
		const channelCloseBeforeBReady = Object.freeze({
			...channelCloseBeforeBReadyBase,
			endpoints: Object.freeze({
				...channelCloseBeforeBReadyBase.endpoints,
				receiver: Object.freeze({
					...channelCloseBeforeBReadyBase.endpoints.receiver,
					acceptedRaw: Object.freeze(
						channelCloseBeforeBReadyBase.endpoints.receiver.acceptedRaw.map((record) =>
							record.lifecycleSequence === 2
								? Object.freeze({ ...record, lifecycleSequence: 4 })
								: record.lifecycleSequence === 3
									? Object.freeze({ ...record, lifecycleSequence: 0 })
									: record
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(channelCloseBeforeBReady)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);

		const postCloseAcceptedA = receiverChannelCloseRemoteOrder.endpoints.receiver.rejectedRaw[0];
		if (postCloseAcceptedA === undefined) throw new Error("D108E4I_FIXTURE_POST_CLOSE_A_ABSENT");
		const channelCloseAcceptedABetweenEventAndCallBase = withReceiverDeadlineTransport(
			receiverChannelCloseRemoteOrder,
			Object.freeze({
				...receiverChannelCloseRemoteOrder.endpoints.receiver.deadline.rawTransport,
				received: receiverChannelCloseRemoteOrder.endpoints.receiver.acceptedRaw.length + 1,
			})
		);
		const channelCloseAcceptedABetweenEventAndCall = Object.freeze({
			...channelCloseAcceptedABetweenEventAndCallBase,
			endpoints: Object.freeze({
				...channelCloseAcceptedABetweenEventAndCallBase.endpoints,
				receiver: Object.freeze({
					...channelCloseAcceptedABetweenEventAndCallBase.endpoints.receiver,
					acceptedRaw: Object.freeze([
						...channelCloseAcceptedABetweenEventAndCallBase.endpoints.receiver.acceptedRaw.map((record) =>
							record.lifecycleSequence === 6 ? Object.freeze({ ...record, lifecycleSequence: 7 }) : record
						),
						Object.freeze({ ...postCloseAcceptedA, lifecycleSequence: 5 }),
					]),
					lifecycle: Object.freeze(
						channelCloseAcceptedABetweenEventAndCallBase.endpoints.receiver.lifecycle
							.map((record) =>
								record.event === "channel-close-call"
									? Object.freeze({ ...record, sequence: 6 })
									: record.event === "channel-message" && record.sequence === 6
										? Object.freeze({ ...record, sequence: 7 })
										: record.event === "channel-message" && record.sequence === 7
											? Object.freeze({ ...record, sequence: 5 })
											: record
							)
							.sort((a, b) => a.sequence - b.sequence)
					),
					rejectedRaw: Object.freeze([]),
				}),
			}),
		});
		expect
			.soft(
				() => validateD108e4hCampaignCustody(channelCloseAcceptedABetweenEventAndCall),
				"D108E4I_RED accepted A must precede the remote close-event rather than the later idempotent call"
			)
			.toThrowError("D108E4H_OVERLAP_LEDGER_INVALID");

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

		const missingReplacementLifecycle = withReceiverLifecycle(receiverReplacement, Object.freeze([]));
		expect(() => validateD108e4hCampaignCustody(missingReplacementLifecycle)).toThrowError(
			"D108E4H_LIFECYCLE_CUSTODY_ABSENT"
		);
		const missingSenderLifecycle = withCreatorLifecycle(creatorReplacement, Object.freeze([]));
		expect(() => validateD108e4hCampaignCustody(missingSenderLifecycle)).toThrowError(
			"D108E4H_LIFECYCLE_CUSTODY_ABSENT"
		);
		const duplicateLifecycleSequence = withReceiverLifecycle(
			receiverReplacement,
			receiverReplacement.endpoints.receiver.lifecycle.map((record, index) =>
				index === 1 ? Object.freeze({ ...record, sequence: 0 }) : record
			)
		);
		expect(() => validateD108e4hCampaignCustody(duplicateLifecycleSequence)).toThrowError("D108E4H_SEQUENCE_INVALID");
		const nonmonotonicMonitor = Object.freeze({
			...carryInMonitor,
			endpoints: Object.freeze({
				...carryInMonitor.endpoints,
				receiver: Object.freeze({
					...carryInMonitor.endpoints.receiver,
					monitor: Object.freeze(
						carryInMonitor.endpoints.receiver.monitor.map((record, index) =>
							index === 2 ? Object.freeze({ ...record, sequence: 0 }) : record
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(nonmonotonicMonitor)).toThrowError("D108E4H_SEQUENCE_INVALID");
		const wrongMonitorPeer = Object.freeze({
			...noReplacement,
			endpoints: Object.freeze({
				...noReplacement.endpoints,
				receiver: Object.freeze({
					...noReplacement.endpoints.receiver,
					monitor: Object.freeze(
						noReplacement.endpoints.receiver.monitor.map((record) =>
							Object.freeze({ ...record, peerId: "unrelated-peer" })
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(wrongMonitorPeer)).toThrowError("D108E4H_MONITOR_PEER_INVALID");
		const carryInAttributedCurrent = Object.freeze({
			...carryInMonitor,
			endpoints: Object.freeze({
				...carryInMonitor.endpoints,
				receiver: Object.freeze({
					...carryInMonitor.endpoints.receiver,
					monitor: Object.freeze(
						carryInMonitor.endpoints.receiver.monitor.map((record) =>
							record.event === "ping-failure" || record.event === "connection-abort"
								? Object.freeze({ ...record, carryIn: false })
								: record
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(carryInAttributedCurrent)).toThrowError(
			"D108E4H_MONITOR_PING_CUSTODY_INVALID"
		);
		const duplicatePingEpoch = Object.freeze({
			...carryInMonitor,
			endpoints: Object.freeze({
				...carryInMonitor.endpoints,
				receiver: Object.freeze({
					...carryInMonitor.endpoints.receiver,
					monitor: Object.freeze([
						...carryInMonitor.endpoints.receiver.monitor,
						Object.freeze({
							...(carryInMonitor.endpoints.receiver.monitor[1] as D108e4hMonitorObservation),
							carryIn: false,
							sequence: 4,
						}),
					]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(duplicatePingEpoch)).toThrowError(
			"D108E4H_MONITOR_PING_CUSTODY_INVALID"
		);
		const unnamedCarryInPing = Object.freeze({
			...carryInMonitor,
			endpoints: Object.freeze({
				...carryInMonitor.endpoints,
				receiver: Object.freeze({
					...carryInMonitor.endpoints.receiver,
					monitor: Object.freeze(
						carryInMonitor.endpoints.receiver.monitor.map((record) =>
							record.carryIn ? Object.freeze({ ...record, pingId: "" }) : record
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(unnamedCarryInPing)).toThrowError(
			"D108E4H_MONITOR_PING_CUSTODY_INVALID"
		);

		const ambiguousDrop = withReceiverDeadlineTransport(
			receiverReplacement,
			d108e4hRawTransport("peer-creator", {
				authenticatedConnectionLosses: 1,
				lastLinkDrop: "replacement",
				linkDrops: 9,
				received: 1,
			})
		);
		expect(() => validateD108e4hCampaignCustody(ambiguousDrop)).toThrowError("D108E4H_DROP_COUNT_AMBIGUOUS");
		const unsupportedDrop = withReceiverDeadlineTransport(
			receiverReplacement,
			d108e4hRawTransport("peer-creator", {
				authenticatedConnectionLosses: 1,
				lastLinkDrop: "send-error",
				linkDrops: 8,
				received: 1,
			})
		);
		expect(() => validateD108e4hCampaignCustody(unsupportedDrop)).toThrowError("D108E4H_DROP_REASON_UNSUPPORTED");

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
		const repeatedAuthenticatedIdentity = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					deadline: Object.freeze({
						...receiverReplacement.endpoints.receiver.deadline,
						authenticated: receiverReplacement.endpoints.receiver.prepare.authenticated,
					}),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(repeatedAuthenticatedIdentity)).toThrowError(
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
		const repeatedRtcIdentity = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					deadline: Object.freeze({
						...receiverReplacement.endpoints.receiver.deadline,
						rtc: receiverReplacement.endpoints.receiver.prepare.rtc,
					}),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(repeatedRtcIdentity)).toThrowError("D108E4H_IDENTITY_JOIN_INVALID");
		const nonIncreasingGeneration = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					deadline: Object.freeze({
						...receiverReplacement.endpoints.receiver.deadline,
						authenticated: Object.freeze([
							Object.freeze({
								...(receiverReplacement.endpoints.receiver.deadline.authenticated[0] as D108e4hAuthenticatedIdentity),
								generation: D108E4H_RTC_A.generation,
							}),
						]),
					}),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(nonIncreasingGeneration)).toThrowError("D108E4H_IDENTITY_JOIN_INVALID");
		const duplicateBoundaryIdentities = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					deadline: Object.freeze({
						...receiverReplacement.endpoints.receiver.deadline,
						authenticated: Object.freeze([
							...(receiverReplacement.endpoints.receiver.deadline
								.authenticated as readonly D108e4hAuthenticatedIdentity[]),
							...(receiverReplacement.endpoints.receiver.prepare
								.authenticated as readonly D108e4hAuthenticatedIdentity[]),
						]),
						rtc: Object.freeze([
							...(receiverReplacement.endpoints.receiver.deadline.rtc as readonly D108e4hRtcIdentity[]),
							...(receiverReplacement.endpoints.receiver.prepare.rtc as readonly D108e4hRtcIdentity[]),
						]),
					}),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(duplicateBoundaryIdentities)).toThrowError(
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
		const unmatchedAttemptIdentity = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({
					...creatorReplacement.endpoints.creator,
					rawSends: Object.freeze(
						creatorReplacement.endpoints.creator.rawSends.map((send, index) =>
							index === 0 ? Object.freeze({ ...send, attemptId: 999_999 }) : send
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(unmatchedAttemptIdentity)).toThrowError(
			"D108E4H_IDENTITY_JOIN_INVALID"
		);

		const firstSuccess = creatorReplacement.endpoints.creator.lifecycle.find(
			({ event }) => event === "channel-send-success"
		);
		const secondSuccess = creatorReplacement.endpoints.creator.lifecycle.find(
			({ attemptId, event }) => event === "channel-send-success" && attemptId !== firstSuccess?.attemptId
		);
		if (firstSuccess?.attemptId === undefined || secondSuccess?.attemptId === undefined) {
			throw new Error("D108E4H_FIXTURE_SUCCESS_ABSENT");
		}
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
							event: "channel-send-failure" as const,
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
						creatorReplacement.endpoints.creator.lifecycle.map((record) =>
							record === firstSuccess ? Object.freeze({ ...record, attemptId: secondSuccess.attemptId }) : record
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(missingTerminal)).toThrowError("D108E4H_ATTEMPT_TERMINAL_CARDINALITY");

		const firstReplacementAttempt = creatorReplacement.endpoints.creator.lifecycle.find(
			({ connectionId, event }) => connectionId === D108E4H_RTC_B.connectionId && event === "channel-send-attempt"
		);
		if (firstReplacementAttempt?.attemptId === undefined) {
			throw new Error("D108E4H_FIXTURE_REPLACEMENT_ATTEMPT_ABSENT");
		}
		const firstReplacementSuccess = creatorReplacement.endpoints.creator.lifecycle.find(
			({ attemptId, event }) => attemptId === firstReplacementAttempt.attemptId && event === "channel-send-success"
		);
		if (firstReplacementSuccess === undefined) throw new Error("D108E4H_FIXTURE_REPLACEMENT_SUCCESS_ABSENT");
		const failedReplacementSend = withCreatorLifecycle(
			creatorReplacement,
			creatorReplacement.endpoints.creator.lifecycle.map((record) =>
				record === firstReplacementSuccess
					? Object.freeze({ ...record, event: "channel-send-failure" as const })
					: record
			)
		);
		expect(() => validateD108e4hCampaignCustody(failedReplacementSend)).toThrowError("D108E4H_RAW_SEND_NOT_SUCCESSFUL");
		const replacementOpen = creatorReplacement.endpoints.creator.lifecycle.find(
			({ connectionId, event }) => connectionId === D108E4H_RTC_B.connectionId && event === "channel-open-event"
		);
		if (replacementOpen === undefined) throw new Error("D108E4H_FIXTURE_REPLACEMENT_OPEN_ABSENT");
		const sendBeforeReplacementOpen = withCreatorLifecycle(
			creatorReplacement,
			creatorReplacement.endpoints.creator.lifecycle.map((record) => {
				if (record === replacementOpen) {
					return Object.freeze({ ...firstReplacementAttempt, sequence: replacementOpen.sequence });
				}
				if (record === firstReplacementAttempt) {
					return Object.freeze({ ...replacementOpen, sequence: firstReplacementAttempt.sequence });
				}
				return record;
			})
		);
		expect(() => validateD108e4hCampaignCustody(sendBeforeReplacementOpen)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const creatorRoleContradiction = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({ ...creatorReplacement.endpoints.creator, transmitsRawTrial: false }),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(creatorRoleContradiction)).toThrowError(
			"D108E4H_RAW_SEND_ROLE_INVALID"
		);
		const receiverSendSlice = d108e4hSendSlice(receiverReplacement.trialId, D108E4H_RTC_B, 0, SAMPLE_COUNT, 8);
		const receiverTransmitterContradictionBase = withReceiverDeadlineTransport(
			receiverReplacement,
			Object.freeze({
				...receiverReplacement.endpoints.receiver.deadline.rawTransport,
				sent: SAMPLE_COUNT,
			})
		);
		const receiverTransmitterContradiction = Object.freeze({
			...receiverTransmitterContradictionBase,
			endpoints: Object.freeze({
				...receiverTransmitterContradictionBase.endpoints,
				receiver: Object.freeze({
					...receiverTransmitterContradictionBase.endpoints.receiver,
					lifecycle: Object.freeze([
						...receiverTransmitterContradictionBase.endpoints.receiver.lifecycle,
						...receiverSendSlice.lifecycle,
					]),
					rawSends: receiverSendSlice.rawSends,
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(receiverTransmitterContradiction)).toThrowError(
			"D108E4H_RAW_SEND_ROLE_INVALID"
		);

		const receiverLifecycle = receiverReplacement.endpoints.receiver.lifecycle;
		const closeBeforeOpen = withReceiverLifecycle(
			receiverReplacement,
			receiverLifecycle.map((record, index) => {
				if (index === 1)
					return Object.freeze({ ...(receiverLifecycle[4] as D108e4hLifecycleObservation), sequence: 1 });
				if (index === 4)
					return Object.freeze({ ...(receiverLifecycle[1] as D108e4hLifecycleObservation), sequence: 4 });
				return record;
			})
		);
		expect(() => validateD108e4hCampaignCustody(closeBeforeOpen)).toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		const closeEventBeforeCall = withReceiverLifecycle(
			receiverReplacement,
			receiverLifecycle.map((record, index) => {
				if (index === 4)
					return Object.freeze({ ...(receiverLifecycle[5] as D108e4hLifecycleObservation), sequence: 4 });
				if (index === 5)
					return Object.freeze({ ...(receiverLifecycle[4] as D108e4hLifecycleObservation), sequence: 5 });
				return record;
			})
		);
		expect(() => validateD108e4hCampaignCustody(closeEventBeforeCall)).toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");

		const receiverWithTwoAccepted = withReceiverDeadlineTransport(
			receiverReplacement,
			Object.freeze({
				...receiverReplacement.endpoints.receiver.deadline.rawTransport,
				received: 2,
			})
		);
		const missingOverlap = Object.freeze({
			...receiverWithTwoAccepted,
			endpoints: Object.freeze({
				...receiverWithTwoAccepted.endpoints,
				receiver: Object.freeze({
					...receiverWithTwoAccepted.endpoints.receiver,
					acceptedRaw: Object.freeze(receiverWithTwoAccepted.endpoints.receiver.acceptedRaw.slice(0, -1)),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(missingOverlap)).toThrowError("D108E4H_OVERLAP_LEDGER_INVALID");
		const acceptedB = receiverReplacement.endpoints.receiver.acceptedRaw[0];
		if (acceptedB === undefined) throw new Error("D108E4H_FIXTURE_ACCEPTED_RAW_ABSENT");
		const receiverWithFourAccepted = withReceiverDeadlineTransport(
			receiverReplacement,
			Object.freeze({
				...receiverReplacement.endpoints.receiver.deadline.rawTransport,
				received: 4,
			})
		);
		const duplicateOverlap = Object.freeze({
			...receiverWithFourAccepted,
			endpoints: Object.freeze({
				...receiverWithFourAccepted.endpoints,
				receiver: Object.freeze({
					...receiverWithFourAccepted.endpoints.receiver,
					acceptedRaw: Object.freeze([...receiverWithFourAccepted.endpoints.receiver.acceptedRaw, acceptedB]),
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
		const wrongAcceptedIdentity = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					acceptedRaw: Object.freeze(
						receiverReplacement.endpoints.receiver.acceptedRaw.map((record, index) =>
							index === 0
								? Object.freeze({
										...record,
										channelId: D108E4H_RTC_A.channelId,
										connectionId: D108E4H_RTC_A.connectionId,
									})
								: record
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(wrongAcceptedIdentity)).toThrowError("D108E4H_OVERLAP_LEDGER_INVALID");
		const bMessageBeforeOpen = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					acceptedRaw: Object.freeze(
						receiverReplacement.endpoints.receiver.acceptedRaw.map((record, index) =>
							index === 0 ? Object.freeze({ ...record, lifecycleSequence: 1 }) : record
						)
					),
					lifecycle: Object.freeze(
						receiverLifecycle.map((record, index) => {
							if (index === 1)
								return Object.freeze({ ...(receiverLifecycle[2] as D108e4hLifecycleObservation), sequence: 1 });
							if (index === 2)
								return Object.freeze({ ...(receiverLifecycle[1] as D108e4hLifecycleObservation), sequence: 2 });
							return record;
						})
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(bMessageBeforeOpen)).toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		const acceptedAAfterClose = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					acceptedRaw: Object.freeze([
						acceptedB,
						...(receiverReplacement.endpoints.receiver.acceptedRaw.slice(2) as readonly D108e4hOverlapObservation[]),
						...receiverReplacement.endpoints.receiver.rejectedRaw,
					]),
					rejectedRaw: Object.freeze([
						receiverReplacement.endpoints.receiver.acceptedRaw[1] as D108e4hOverlapObservation,
					]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(acceptedAAfterClose)).toThrowError("D108E4H_OVERLAP_LEDGER_INVALID");
		const acceptedReplacementB = receiverReplacement.endpoints.receiver.acceptedRaw.filter(
			({ connectionId }) => connectionId === D108E4H_RTC_B.connectionId
		);
		const acceptedOverlapA = receiverReplacement.endpoints.receiver.acceptedRaw.filter(
			({ connectionId }) => connectionId === D108E4H_RTC_A.connectionId
		);
		const allReplacementBRejectedBase = withReceiverDeadlineTransport(
			receiverReplacement,
			Object.freeze({
				...receiverReplacement.endpoints.receiver.deadline.rawTransport,
				received: acceptedOverlapA.length,
			})
		);
		const allReplacementBRejected = Object.freeze({
			...allReplacementBRejectedBase,
			endpoints: Object.freeze({
				...allReplacementBRejectedBase.endpoints,
				receiver: Object.freeze({
					...allReplacementBRejectedBase.endpoints.receiver,
					acceptedRaw: Object.freeze(acceptedOverlapA),
					rejectedRaw: Object.freeze([
						...allReplacementBRejectedBase.endpoints.receiver.rejectedRaw,
						...acceptedReplacementB,
					]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(allReplacementBRejected)).toThrowError(
			"D108E4H_OVERLAP_LEDGER_INVALID"
		);
		const allOverlapARejectedBase = withReceiverDeadlineTransport(
			receiverReplacement,
			Object.freeze({
				...receiverReplacement.endpoints.receiver.deadline.rawTransport,
				received: acceptedReplacementB.length,
			})
		);
		const allOverlapARejected = Object.freeze({
			...allOverlapARejectedBase,
			endpoints: Object.freeze({
				...allOverlapARejectedBase.endpoints,
				receiver: Object.freeze({
					...allOverlapARejectedBase.endpoints.receiver,
					acceptedRaw: Object.freeze(acceptedReplacementB),
					rejectedRaw: Object.freeze([...allOverlapARejectedBase.endpoints.receiver.rejectedRaw, ...acceptedOverlapA]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(allOverlapARejected)).not.toThrow();
		const handlerAfterFirstBMessage = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({
				...receiverReplacement.endpoints,
				receiver: Object.freeze({
					...receiverReplacement.endpoints.receiver,
					acceptedRaw: Object.freeze(
						receiverReplacement.endpoints.receiver.acceptedRaw.map((record, index) =>
							index === 0
								? Object.freeze({ ...record, lifecycleSequence: 3 })
								: index === 1
									? Object.freeze({ ...record, lifecycleSequence: 0 })
									: Object.freeze({ ...record, lifecycleSequence: 7 })
						)
					),
					lifecycle: Object.freeze([
						Object.freeze({ ...(receiverLifecycle[3] as D108e4hLifecycleObservation), sequence: 0 }),
						Object.freeze({
							...(receiverLifecycle[0] as D108e4hLifecycleObservation),
							owner: "rtc-observer",
							sequence: 1,
						}),
						Object.freeze({ ...(receiverLifecycle[1] as D108e4hLifecycleObservation), sequence: 2 }),
						Object.freeze({ ...(receiverLifecycle[2] as D108e4hLifecycleObservation), sequence: 3 }),
						Object.freeze({ ...(receiverLifecycle[0] as D108e4hLifecycleObservation), sequence: 4 }),
						Object.freeze({ ...(receiverLifecycle[4] as D108e4hLifecycleObservation), sequence: 5 }),
						Object.freeze({ ...(receiverLifecycle[5] as D108e4hLifecycleObservation), sequence: 6 }),
						Object.freeze({ ...(receiverLifecycle[6] as D108e4hLifecycleObservation), sequence: 7 }),
						Object.freeze({ ...(receiverLifecycle[7] as D108e4hLifecycleObservation), sequence: 8 }),
					]),
					rejectedRaw: Object.freeze(
						receiverReplacement.endpoints.receiver.rejectedRaw.map((record) =>
							Object.freeze({ ...record, lifecycleSequence: 8 })
						)
					),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(handlerAfterFirstBMessage)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const wrongReplacementChannel = withReceiverLifecycle(
			receiverReplacement,
			receiverLifecycle.map((record) =>
				record.event === "channel-open-event"
					? Object.freeze({ ...record, channelId: D108E4H_RTC_B.channelId + 1 })
					: record
			)
		);
		expect(() => validateD108e4hCampaignCustody(wrongReplacementChannel)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const wrongCloseEventOwner = withReceiverLifecycle(
			receiverChannelClose,
			receiverChannelClose.endpoints.receiver.lifecycle.map((record) =>
				record.event === "channel-close-event" ? Object.freeze({ ...record, owner: "rtc-observer-or-harness" }) : record
			)
		);
		expect(() => validateD108e4hCampaignCustody(wrongCloseEventOwner)).toThrowError("D108E4H_LIFECYCLE_CUSTODY_ABSENT");
		const postPromotionB = receiverChannelClose.endpoints.receiver.acceptedRaw.find(
			({ connectionId, lifecycleSequence }) => connectionId === D108E4H_RTC_B.connectionId && lifecycleSequence === 6
		);
		if (postPromotionB === undefined) throw new Error("D108E4H_FIXTURE_POST_PROMOTION_B_ABSENT");
		const channelCloseWithoutPostPromotionIngressBase = withReceiverDeadlineTransport(
			receiverChannelClose,
			Object.freeze({
				...receiverChannelClose.endpoints.receiver.deadline.rawTransport,
				received: 2,
			})
		);
		const channelCloseWithoutPostPromotionIngress = Object.freeze({
			...channelCloseWithoutPostPromotionIngressBase,
			endpoints: Object.freeze({
				...channelCloseWithoutPostPromotionIngressBase.endpoints,
				receiver: Object.freeze({
					...channelCloseWithoutPostPromotionIngressBase.endpoints.receiver,
					acceptedRaw: Object.freeze(
						channelCloseWithoutPostPromotionIngressBase.endpoints.receiver.acceptedRaw.filter(
							(record) => record !== postPromotionB
						)
					),
					rejectedRaw: Object.freeze([
						...channelCloseWithoutPostPromotionIngressBase.endpoints.receiver.rejectedRaw,
						postPromotionB,
					]),
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(channelCloseWithoutPostPromotionIngress)).toThrowError(
			"D108E4H_CHANNEL_CLOSE_INGRESS_INVALID"
		);

		const missingRawSequence = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({
					...creatorReplacement.endpoints.creator,
					rawSends: Object.freeze(
						creatorReplacement.endpoints.creator.rawSends.map((send, index) =>
							index === SAMPLE_COUNT - 1 ? Object.freeze({ ...send, sequence: -1 }) : send
						)
					),
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
		const inconsistentReceivedCounter = withReceiverDeadlineTransport(
			receiverReplacement,
			Object.freeze({
				...receiverReplacement.endpoints.receiver.deadline.rawTransport,
				received: 2,
			})
		);
		expect(() => validateD108e4hCampaignCustody(inconsistentReceivedCounter)).toThrowError(
			"D108E4H_RAW_COUNTER_MISMATCH"
		);
		const detachedDelta = Object.freeze({
			...receiverReplacement,
			rawTransportDeltas: Object.freeze({
				...receiverReplacement.rawTransportDeltas,
				receiver: Object.freeze({
					...receiverReplacement.rawTransportDeltas.receiver,
					linkDrops: receiverReplacement.rawTransportDeltas.receiver.linkDrops + 1,
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(detachedDelta)).toThrowError("D108E4H_DELTA_MISMATCH");
		const missingReceiverEndpoint = Object.freeze({
			...receiverReplacement,
			endpoints: Object.freeze({ creator: receiverReplacement.endpoints.creator }),
		}) as unknown as D108e4hValidationInput;
		expect(() => validateD108e4hCampaignCustody(missingReceiverEndpoint)).toThrowError(
			"D108E4H_ENDPOINT_CUSTODY_ABSENT"
		);
		const nonDrainedChannelClose = withCreatorLifecycle(
			creatorChannelClose,
			creatorChannelClose.endpoints.creator.lifecycle.map((record) =>
				record.event === "channel-close-call" ? Object.freeze({ ...record, bufferedAmount: 1 }) : record
			)
		);
		expect(() => validateD108e4hCampaignCustody(nonDrainedChannelClose)).toThrowError(
			"D108E4H_CHANNEL_CLOSE_DRAIN_INVALID"
		);
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
				lifecycleSequence: 2,
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
				lifecycleSequence: 4,
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
			expect(
				evidence.lifecycle.every(({ schemaVersion, trialId }) => schemaVersion === 3 && trialId === "observer-install")
			).toBe(true);
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

			await page.evaluate(() => {
				const stream = new EventTarget() as EventTarget & {
					close(options?: unknown): Promise<void>;
					send(data: Uint8Array): boolean;
				};
				stream.close = (): Promise<void> => Promise.resolve();
				stream.send = (): boolean => true;
				const connection = new EventTarget() as EventTarget & {
					abort(error?: Error): void;
					readonly id: string;
					newStream(protocol: string | readonly string[], options?: unknown): Promise<typeof stream>;
					readonly remotePeer: Readonly<{ toString(): string }>;
				};
				connection.abort = (): void => undefined;
				Object.defineProperty(connection, "id", { value: "monitor-self-check-connection" });
				connection.newStream = (): Promise<typeof stream> => Promise.resolve(stream);
				Object.defineProperty(connection, "remotePeer", {
					value: Object.freeze({ toString: (): string => "monitor-self-check-peer" }),
				});
				const host = new EventTarget() as EventTarget & { getConnections(): readonly [typeof connection] };
				host.getConnections = (): readonly [typeof connection] => [connection];
				const selfCheckWindow = window as typeof window & {
					__D108E4H_MONITOR_SELF_CHECK__?: Readonly<{ connection: typeof connection; stream: typeof stream }>;
				};
				Object.defineProperty(selfCheckWindow, "__TS_DRP_GRID_SESSION__", {
					configurable: true,
					value: Object.freeze({ node: Object.freeze({ networkNode: Object.freeze({ _node: host }) }) }),
				});
				Object.defineProperty(selfCheckWindow, "__D108E4H_MONITOR_SELF_CHECK__", {
					configurable: true,
					value: Object.freeze({ connection, stream }),
				});
			});
			await installLibp2pMonitorObserver(page);
			await resetLibp2pMonitorObserver(page, "d108e4h-monitor-self-check");
			const monitorEvidence = await page.evaluate(async () => {
				const selfCheckWindow = window as typeof window & {
					__D108E4H_MONITOR_SELF_CHECK__?: Readonly<{
						connection: Readonly<{
							abort(error?: Error): void;
							newStream(protocol: string | readonly string[], options?: unknown): Promise<unknown>;
						}>;
						stream: EventTarget;
					}>;
				};
				const selfCheck = selfCheckWindow.__D108E4H_MONITOR_SELF_CHECK__;
				const observer = window.__E303_LIBP2P_MONITOR_OBSERVER__;
				if (selfCheck === undefined || observer === undefined) {
					throw new Error("D108E4H_MONITOR_SELF_CHECK_ABSENT");
				}
				await selfCheck.connection.newStream("/ipfs/ping/1.0.0");
				selfCheck.stream.dispatchEvent(new Event("close"));
				const monitorOwner = {
					"connection-monitor"(connection: typeof selfCheck.connection): void {
						connection.abort(new Error("D108E4H_SYNTHETIC_PING_TIMEOUT"));
					},
				};
				monitorOwner["connection-monitor"](selfCheck.connection);
				return observer.snapshot();
			});
			const joinedMonitorPing = monitorEvidence.filter(
				({ event }) => event === "ping-start" || event === "ping-failure" || event === "connection-abort"
			);
			expect(joinedMonitorPing.map(({ event }) => event)).toEqual(["ping-start", "ping-failure", "connection-abort"]);
			expect(new Set(joinedMonitorPing.map(({ pingId }) => pingId))).toEqual(
				new Set(["d108e4h-monitor-self-check:ping:0"])
			);
			expect(joinedMonitorPing.every(({ owner }) => owner === "libp2p-connection-monitor")).toBe(true);
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
			await Promise.all([resetRtcObserver(creator, trialId), resetRtcObserver(receiver, trialId)]);
			await Promise.all(
				[creator, receiver].map((page) =>
					page.evaluate((selectedTrialId) => window.__E303_LIBP2P_MONITOR_OBSERVER__?.reset(selectedTrialId), trialId)
				)
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
			expect(
				initiatorMonitor.every(
					({ schemaVersion, trialId: recordTrialId }) => schemaVersion === 3 && recordTrialId === trialId
				)
			).toBe(true);
			expect(
				responderMonitor.every(
					({ schemaVersion, trialId: recordTrialId }) => schemaVersion === 3 && recordTrialId === trialId
				)
			).toBe(true);
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
		await Promise.all([installLibp2pMonitorObserver(creator), installLibp2pMonitorObserver(receiver)]);
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
		await Promise.all([
			resetRtcObserver(creator, calibrationTrialId),
			resetRtcObserver(receiver, calibrationTrialId),
			resetLibp2pMonitorObserver(creator, calibrationTrialId),
			resetLibp2pMonitorObserver(receiver, calibrationTrialId),
		]);
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
			const clock = await clockEvidence(creator, receiver);
			updateTrialProgress({ clockSamples: clock.samples, clockSkewMs: clock.maximumSkewMs });
			expect(clock.maximumSkewMs).toBeLessThanOrEqual(20);
			const receiverRawBefore = await rawReceivedAfterQuiescence(receiver);
			const [creatorPrepareCapture, receiverPrepareCapture] = await Promise.all([
				d108e4hPageCapture(creator, trialId),
				d108e4hPageCapture(receiver, trialId),
			]);
			const creatorPrepareCustody = d108e4hBoundaryFromCapture(creatorPrepareCapture, peers.receiverPeerId);
			const receiverPrepareCustody = d108e4hBoundaryFromCapture(receiverPrepareCapture, peers.creatorPeerId);
			const senderRawTransportBefore = creatorPrepareCapture.zone.rawTransport;
			const receiverRawTransportBefore = receiverPrepareCapture.zone.rawTransport;
			expect(receiverRawTransportBefore.received).toBe(receiverRawBefore);
			updateTrialProgress({
				prepareCustody: Object.freeze({ creator: creatorPrepareCustody, receiver: receiverPrepareCustody }),
			});
			await Promise.all([
				resetRtcObserver(creator, trialId),
				resetRtcObserver(receiver, trialId),
				resetLibp2pMonitorObserver(creator, trialId),
				resetLibp2pMonitorObserver(receiver, trialId),
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
			const [creatorAtDeadline, receiverAtDeadline] = await Promise.all([
				d108e4hPageCapture(creator, trialId),
				d108e4hPageCapture(receiver, trialId),
			]);
			const senderRawTransportAtDeadline = creatorAtDeadline.zone.rawTransport;
			const creatorProductRoster = productRosterFromSnapshot(creatorAtDeadline.fabric);
			const productRoster = productRosterFromSnapshot(receiverAtDeadline.fabric);
			const senderWireAtDeadline = platformObservations(creatorAtDeadline.rtc.records, "send", trialId);
			const creatorMessageWireAtDeadline = platformObservations(creatorAtDeadline.rtc.records, "message", trialId);
			const receiverSendWireAtDeadline = platformObservations(receiverAtDeadline.rtc.records, "send", trialId);
			const receiverWire = platformObservations(receiverAtDeadline.rtc.records, "message", trialId);
			const deadlineStage = transportStageEvidence(
				Date.now() - trialEvidenceStartedAtMs,
				senderRawTransportAtDeadline,
				receiverAtDeadline.zone.rawTransport
			);
			updateTrialProgress({
				preliminaryProductRoster: undefined,
				productRoster,
				rtcSequenceFences: Object.freeze({
					creator: creatorAtDeadline.rtc.lifecycleSequenceFence,
					receiver: receiverAtDeadline.rtc.lifecycleSequenceFence,
				}),
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
			const creatorPartition = partitionReceiverEvidence(creatorMessageWireAtDeadline, creatorProductRoster);
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
			const replacementCustody = Object.freeze({
				endpoints: Object.freeze({
					creator: d108e4hEndpointFromCapture(creatorAtDeadline, {
						acceptedRaw: creatorPartition.productAccepted,
						peerId: peers.creatorPeerId,
						prepare: creatorPrepareCustody,
						rawSends: senderWireAtDeadline,
						rejectedRaw: creatorPartition.productRejected,
						remotePeerId: peers.receiverPeerId,
						transmitsRawTrial: true,
						trialId,
					}),
					receiver: d108e4hEndpointFromCapture(receiverAtDeadline, {
						acceptedRaw: receiverPartition.productAccepted,
						peerId: peers.receiverPeerId,
						prepare: receiverPrepareCustody,
						rawSends: receiverSendWireAtDeadline,
						rejectedRaw: receiverPartition.productRejected,
						remotePeerId: peers.creatorPeerId,
						transmitsRawTrial: false,
						trialId,
					}),
				}),
				rawTransportDeltas: Object.freeze({
					creator: rawTransportDelta(senderRawTransportBefore, senderRawTransportAtDeadline),
					receiver: rawTransportDelta(receiverRawTransportBefore, receiverAtDeadline.zone.rawTransport),
				}),
				sampleCount: SAMPLE_COUNT,
				schemaVersion: 3 as const,
				trialId,
			}) satisfies D108e4hValidationInput;
			updateTrialProgress({ replacementCustody });
			validateD108e4hCampaignCustody(replacementCustody);
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
						receiverAtDeadline.rtc.records.filter(
							({ insertionReadyState, readyState }) => insertionReadyState !== readyState
						)
					),
					sender: Object.freeze(
						creatorAtDeadline.rtc.records.filter(
							({ insertionReadyState, readyState }) => insertionReadyState !== readyState
						)
					),
				}),
				rendered,
				receiverWire,
				replacementCustody,
				stages: Object.freeze({
					deadline: deadlineStage,
					prepare: prepareStage,
					reset: resetStage,
					runReturned: runReturnedStage,
				}),
				senderWire: senderWireAtDeadline,
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

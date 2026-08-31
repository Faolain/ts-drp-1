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
		ephemeralUnreliableWebRtcSnapshot(objectId: string): RawOwnerSnapshot | undefined;
		readonly networkNode: Readonly<{
			connect(addresses: readonly unknown[]): Promise<void>;
			disconnect(peerId: string): Promise<void>;
			getPeerMultiaddrs(peerId: string): Promise<readonly Readonly<{ readonly multiaddr: unknown }>[]>;
		}>;
	}>;
	snapshot(): GridNetworkSnapshot;
}

interface RawOwnerSnapshot {
	readonly activeLinks: number;
	readonly authenticatedConnectionLosses: number;
	readonly handshakeFailures: number;
	readonly lastLinkDrop: string | undefined;
	readonly linkDrops: number;
	readonly links: readonly Readonly<{
		readonly connectionId: string;
		readonly generation: number;
		readonly label: string;
		readonly peerId: string;
		readonly remoteAddr: string;
	}>[];
	readonly received: number;
	readonly sent: number;
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
	| "channel-open-repeat-event"
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

interface ResetReplayEndpointCustody {
	readonly libp2pConnections: readonly Readonly<{ readonly connectionId: string; readonly peerId: string }>[];
	readonly monitor: readonly Libp2pMonitorObservation[];
	readonly monitorSequenceFence: number;
	readonly network: NetworkSnapshot;
	readonly raw: RawOwnerSnapshot | undefined;
	readonly rtc: RtcCustodySnapshot;
	readonly zone: ZoneSnapshot;
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
	readonly deadlineSenderWire: readonly PlatformObservation[];
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
	readonly runReturnSenderWire: readonly PlatformObservation[];
	readonly runTrialReturnedAtMs: number;
	readonly stages: Readonly<{
		readonly deadline: TransportStageEvidence;
		readonly prepare: TransportStageEvidence;
		readonly reset: TransportStageEvidence;
		readonly runReturned: TransportStageEvidence;
	}>;
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

type D108e4avControlBytes = readonly [0x44, 0x52, 0x01, 1 | 2 | 3];

interface D108e4avControlReceive {
	readonly bytes: D108e4avControlBytes;
	readonly channelId: number;
	readonly connectionId: number;
	readonly lifecycleSequence: number;
}

interface D108e4avControlSend extends D108e4avControlReceive {
	readonly attemptId: number;
}

interface D108e4hOverlapObservation extends AcceptedObservationIdentity {
	readonly lifecycleSequence: number;
}

interface D108e4hEndpointCustody {
	readonly acceptedRaw: readonly D108e4hOverlapObservation[];
	readonly controlReceives?: readonly D108e4avControlReceive[];
	readonly controlSends?: readonly D108e4avControlSend[];
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
	const channelOpenGenerations = new WeakMap<RTCDataChannel, number>();
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
		channel.addEventListener("open", () => {
			const repeated = channelOpenGenerations.get(channel) === generation;
			channelOpenGenerations.set(channel, generation);
			recordLifecycle(repeated ? "channel-open-repeat-event" : "channel-open-event", connectionId, {
				bufferedAmount: channel.bufferedAmount,
				channelId,
				label: channel.label,
				owner: repeated ? "rtc-datachannel-open-repeat-event" : "rtc-datachannel-open-event",
				readyState: channel.readyState,
			});
		});
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

function d108e4avControlBytes(record: RtcObservation): D108e4avControlBytes | undefined {
	if (record.label !== "ts-drp-ephemeral/1" || record.byteLength !== 4) return undefined;
	const bytes = new TextEncoder().encode(record.text);
	if (
		bytes.byteLength !== 4 ||
		bytes[0] !== 0x44 ||
		bytes[1] !== 0x52 ||
		bytes[2] !== 0x01 ||
		(bytes[3] !== 1 && bytes[3] !== 2 && bytes[3] !== 3)
	) {
		return undefined;
	}
	return Object.freeze([0x44, 0x52, 0x01, bytes[3]]);
}

function d108e4avControlsFromCapture(
	records: readonly RtcObservation[],
	direction: "message"
): readonly D108e4avControlReceive[];
function d108e4avControlsFromCapture(
	records: readonly RtcObservation[],
	direction: "send"
): readonly D108e4avControlSend[];
function d108e4avControlsFromCapture(
	records: readonly RtcObservation[],
	direction: "message" | "send"
): readonly (D108e4avControlReceive | D108e4avControlSend)[] {
	const controls: (D108e4avControlReceive | D108e4avControlSend)[] = [];
	for (const record of records) {
		if (record.direction !== direction) continue;
		const bytes = d108e4avControlBytes(record);
		if (bytes === undefined) continue;
		if (record.lifecycleSequence === undefined) throw new Error("D108E4H_IDENTITY_JOIN_INVALID");
		const identity = Object.freeze({
			bytes,
			channelId: record.channelId,
			connectionId: record.connectionId,
			lifecycleSequence: record.lifecycleSequence,
		});
		if (direction === "message") {
			controls.push(identity);
			continue;
		}
		if (record.attemptId === undefined) throw new Error("D108E4H_IDENTITY_JOIN_INVALID");
		controls.push(Object.freeze({ ...identity, attemptId: record.attemptId }));
	}
	return Object.freeze(controls);
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
		controlReceives: d108e4avControlsFromCapture(capture.rtc.records, "message"),
		controlSends: d108e4avControlsFromCapture(capture.rtc.records, "send"),
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

interface RawSenderContinuityInput {
	readonly backpressuredDrops: number;
	readonly intervalMs: number;
	readonly lifecycle: readonly D108e4hLifecycleObservation[];
	readonly observations: readonly PlatformObservation[];
	readonly receiverLinkDrops: number;
	readonly sampleCount: number;
	readonly senderLinkDrops: number;
}

interface RawSenderContinuityEvidence {
	readonly gap: number;
	readonly rawBackpressureWindowMaxMs: number;
	readonly rawMaxStallMs: number;
	readonly rawNativeGapMaxMs: number;
}

function rawSenderContinuityEvidence(input: RawSenderContinuityInput): RawSenderContinuityEvidence {
	const current = rawSequenceEvidence(input.observations);
	return Object.freeze({
		gap: current.gap,
		rawBackpressureWindowMaxMs: 0,
		rawMaxStallMs: current.maxStallMs,
		rawNativeGapMaxMs: current.maxStallMs,
	});
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

async function resetFabricPairSerially(
	creator: Page,
	receiver: Page,
	trialId: string,
	creatorExpected: NetworkSnapshot,
	receiverExpected: NetworkSnapshot
): Promise<void> {
	await creator.evaluate((selectedTrialId) => window.__TS_DRP_V3_ZONE__?.fabric?.reset(selectedTrialId), trialId);
	await waitForOpenTransportPair(creator, receiver);
	await waitForNetworkPair(creator, receiver, creatorExpected, receiverExpected);
	await receiver.evaluate((selectedTrialId) => window.__TS_DRP_V3_ZONE__?.fabric?.reset(selectedTrialId), trialId);
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

async function resetReplayEndpointCustody(page: Page, objectId: string): Promise<ResetReplayEndpointCustody> {
	const [networkSnapshot, zoneSnapshot, rtc, monitor, owner] = await Promise.all([
		network(page),
		zone(page),
		page.evaluate(async () => {
			const observer = window.__E303_RTC_OBSERVER__;
			if (observer === undefined) throw new Error("E303_RTC_OBSERVER_ABSENT");
			return observer.custodySnapshot();
		}),
		libp2pMonitorObservations(page),
		page.evaluate((selectedObjectId) => {
			type ConnectionLike = Readonly<{
				readonly id: string;
				readonly remotePeer: Readonly<{ toString(): string }>;
			}>;
			type HostLike = Readonly<{ getConnections(): readonly ConnectionLike[] }>;
			const session = window.__TS_DRP_GRID_SESSION__ as
				| (GridNetworkTestSession & {
						readonly node: {
							ephemeralUnreliableWebRtcSnapshot(objectId: string): RawOwnerSnapshot | undefined;
							readonly networkNode: { readonly _node?: HostLike };
						};
				  })
				| undefined;
			const host = session?.node.networkNode._node;
			if (session === undefined || host === undefined) throw new Error("D108E4AY_OWNER_CUSTODY_ABSENT");
			return Object.freeze({
				libp2pConnections: Object.freeze(
					host
						.getConnections()
						.map((connection) =>
							Object.freeze({ connectionId: connection.id, peerId: connection.remotePeer.toString() })
						)
						.sort((left, right) => left.connectionId.localeCompare(right.connectionId))
				),
				raw: session.node.ephemeralUnreliableWebRtcSnapshot(selectedObjectId),
			});
		}, objectId),
	]);
	return Object.freeze({
		libp2pConnections: owner.libp2pConnections,
		monitor,
		monitorSequenceFence: monitor.at(-1)?.sequence ?? -1,
		network: networkSnapshot,
		raw: owner.raw,
		rtc,
		zone: zoneSnapshot,
	});
}

async function pageFailureEvidence(page: Page, trialId: string | null): Promise<unknown> {
	if (page.isClosed()) return Object.freeze({ pageClosed: true });
	const [libp2pMonitorResult, networkResult, rtcChannelStatesResult, rtcLifecycleResult, rtcResult, zoneResult] =
		await Promise.all([
			diagnosticAttempt(() => libp2pMonitorObservations(page)),
			diagnosticAttempt(() => network(page)),
			diagnosticAttempt(() => rtcChannelStates(page)),
			diagnosticAttempt(() => rtcLifecycleObservations(page)),
			diagnosticAttempt(() => rtcObservations(page)),
			diagnosticAttempt(() => zone(page)),
		]);
	if (!rtcResult.ok)
		return Object.freeze({
			libp2pMonitor: libp2pMonitorResult,
			network: networkResult,
			pageClosed: false,
			rtc: rtcResult,
			rtcChannelStates: rtcChannelStatesResult,
			rtcLifecycle: rtcLifecycleResult,
			zone: zoneResult,
		});
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
		libp2pMonitor: libp2pMonitorResult,
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
		rtcChannelStates: rtcChannelStatesResult,
		rtcLifecycle: rtcLifecycleResult,
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

function d108e4aaRetainedAsymmetricReplay(
	swapPageOrder: boolean,
	incomingAnchorOrder: "handler-open" | "open-handler"
): D108e4hValidationInput {
	const trialId = "e3-03-0";
	const creatorPeerId = "16Uiu2HAmFP8Rgu2hBrBG4ZwG7mnFHzYJDGSJ2dU3WESDoiyd7rAr";
	const receiverPeerId = "16Uiu2HAmMuwjeZv1KiXZQUG6nQM1cEC287WknT1BJQrHit4r3EcX";
	const creatorBefore = Object.freeze({
		channelId: 346,
		connectionId: 3,
		label: "ts-drp-ephemeral/1" as const,
		readyState: "open" as const,
	});
	const creatorAfter = Object.freeze({ ...creatorBefore, channelId: 367, connectionId: 5 });
	const receiverBefore = Object.freeze({ ...creatorBefore, channelId: 348 });
	const receiverAfter = Object.freeze({ ...creatorAfter, channelId: 379 });
	const creatorPrepareTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: 0,
		lastLinkDrop: "restart",
		linkDrops: 2,
		sent: 933,
	});
	const creatorDeadlineTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: 1,
		lastLinkDrop: "replacement",
		linkDrops: 3,
		sent: 1_533,
	});
	const receiverPrepareTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: 0,
		lastLinkDrop: "restart",
		linkDrops: 2,
		received: 690,
	});
	const receiverDeadlineTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: 1,
		lastLinkDrop: "restart",
		linkDrops: 2,
		received: 1_112,
	});
	const boundary = (
		peerId: string,
		connectionId: string,
		generation: number,
		rtc: D108e4hRtcIdentity,
		rawTransport: ZoneSnapshot["rawTransport"]
	): D108e4hBoundaryCustody =>
		Object.freeze({
			authenticated: Object.freeze([Object.freeze({ connectionId, generation, peerId })]),
			rawTransport,
			rtc: Object.freeze([rtc]),
		});
	const creatorSend = d108e4hSendSlice(trialId, creatorBefore, 0, SAMPLE_COUNT, 0);
	const receiverMessages = Object.freeze(
		Array.from({ length: 422 }, (_, sequence) =>
			d108e4hLifecycle(trialId, sequence, "channel-message", receiverBefore, "rtc-datachannel-message-event")
		)
	);
	const receiverAccepted = Object.freeze(
		receiverMessages.map(({ sequence }, payloadSequence) =>
			d108e4hAcceptedRaw(receiverBefore, payloadSequence, sequence)
		)
	);
	const receiverReplacementAnchors =
		incomingAnchorOrder === "handler-open"
			? Object.freeze([
					d108e4hLifecycle(
						trialId,
						1_249,
						"channel-message-handler-installed",
						receiverAfter,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(trialId, 1_250, "channel-open-event", receiverAfter, "rtc-datachannel-open-event"),
				])
			: Object.freeze([
					d108e4hLifecycle(trialId, 1_249, "channel-open-event", receiverAfter, "rtc-datachannel-open-event"),
					d108e4hLifecycle(
						trialId,
						1_250,
						"channel-message-handler-installed",
						receiverAfter,
						"product-unreliable-webrtc"
					),
				]);
	const captured = Object.freeze({
		endpoints: Object.freeze({
			creator: Object.freeze({
				acceptedRaw: Object.freeze([]),
				deadline: boundary(receiverPeerId, "31rgyu1787968881083", 4, creatorAfter, creatorDeadlineTransport),
				lifecycle: Object.freeze([
					...creatorSend.lifecycle,
					d108e4hLifecycle(trialId, 2_032, "channel-open-event", creatorAfter, "rtc-datachannel-open-event"),
					d108e4hLifecycle(
						trialId,
						2_033,
						"channel-message-handler-installed",
						creatorAfter,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(trialId, 2_034, "channel-close-call", creatorBefore, "product-unreliable-webrtc"),
					d108e4hLifecycle(trialId, 2_035, "channel-close-event", creatorBefore, "rtc-datachannel-close-event", {
						readyState: "closed",
					}),
				]),
				monitor: d108e4hMonitor(trialId, receiverPeerId),
				peerId: creatorPeerId,
				prepare: boundary(receiverPeerId, "5ckj0p1787968823124", 3, creatorBefore, creatorPrepareTransport),
				rawSends: creatorSend.rawSends,
				rejectedRaw: Object.freeze([]),
				transmitsRawTrial: true,
			}),
			receiver: Object.freeze({
				acceptedRaw: receiverAccepted,
				deadline: boundary(creatorPeerId, "63ccqd1787968823119", 3, receiverAfter, receiverDeadlineTransport),
				lifecycle: Object.freeze([
					...receiverMessages,
					d108e4hLifecycle(
						trialId,
						1_247,
						"channel-handler-installed",
						receiverAfter,
						"rtc-observer-datachannel-handler"
					),
					d108e4hLifecycle(
						trialId,
						1_248,
						"channel-message-handler-installed",
						receiverAfter,
						"rtc-observer-or-harness"
					),
					...receiverReplacementAnchors,
				]),
				monitor: d108e4hMonitor(trialId, creatorPeerId),
				peerId: receiverPeerId,
				prepare: boundary(creatorPeerId, "63ccqd1787968823119", 3, receiverBefore, receiverPrepareTransport),
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
		schemaVersion: 3 as const,
		trialId,
	});
	if (!swapPageOrder) return captured;
	return Object.freeze({
		...captured,
		endpoints: Object.freeze({
			creator: captured.endpoints.receiver,
			receiver: captured.endpoints.creator,
		}),
		rawTransportDeltas: Object.freeze({
			creator: captured.rawTransportDeltas.receiver,
			receiver: captured.rawTransportDeltas.creator,
		}),
	});
}

function d108e4acDualLocalReplacementReplay(swapPageOrder: boolean): D108e4hValidationInput {
	const trialId = "e3-03-0";
	const creatorPeerId = "16Uiu2HAmDmbpqXW4sui8F9r1JjViSCVkSuKcL6mBnqCGUb3jNUTc";
	const receiverPeerId = "16Uiu2HAkvi5DUFivZdjNxyLAxR9sATAKBCLSmKN3qoHHzxKwUttJ";
	const creatorBefore = Object.freeze({
		channelId: 373,
		connectionId: 5,
		label: "ts-drp-ephemeral/1" as const,
		readyState: "open" as const,
	});
	const creatorAfter = Object.freeze({ ...creatorBefore, channelId: 399, connectionId: 7 });
	const receiverBefore = Object.freeze({ ...creatorBefore, channelId: 369 });
	const receiverAfter = Object.freeze({ ...creatorAfter, channelId: 382 });
	const creatorPrepareTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: 1,
		lastLinkDrop: "restart",
		linkDrops: 2,
		sent: 933,
	});
	const creatorDeadlineTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: 2,
		lastLinkDrop: "replacement",
		linkDrops: 3,
		sent: 1_533,
	});
	const receiverPrepareTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: 1,
		lastLinkDrop: "restart",
		linkDrops: 2,
		received: 683,
	});
	const receiverDeadlineTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: 2,
		lastLinkDrop: "replacement",
		linkDrops: 3,
		received: 1_083,
	});
	const boundary = (
		peerId: string,
		connectionId: string,
		generation: number,
		rtc: D108e4hRtcIdentity,
		rawTransport: ZoneSnapshot["rawTransport"]
	): D108e4hBoundaryCustody =>
		Object.freeze({
			authenticated: Object.freeze([Object.freeze({ connectionId, generation, peerId })]),
			rawTransport,
			rtc: Object.freeze([rtc]),
		});
	const creatorOldSends = d108e4hSendSlice(trialId, creatorBefore, 0, 507, 0);
	const creatorNewSends = d108e4hSendSlice(trialId, creatorAfter, 507, 93, 1_658);
	const receiverOldMessageSequences = Object.freeze([
		0, 30, 60, 90, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135,
		136, 137, 138, 139, 140, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 167, 168, 169, 170, 171, 172, 173, 174,
		175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197,
		198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 227,
		232, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259,
		260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282,
		283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 316, 317, 318, 319, 320, 321, 322, 323, 348,
		349, 350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360, 361, 362, 405, 406, 407, 408, 409, 410, 411, 412, 415,
		416, 417, 418, 419, 420, 421, 422, 423, 438, 439, 440, 444, 445, 446, 447, 448, 449, 450, 451, 452, 453, 454, 455,
		456, 457, 458, 459, 460, 461, 462, 463, 464, 465, 466, 467, 468, 489, 493, 494, 495, 496, 497, 498, 499, 500, 501,
		502, 503, 504, 505, 506, 507, 508, 509, 510, 511, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521, 522, 523, 524,
		525, 526, 527, 528, 529, 530, 531, 532, 533, 534, 535, 536, 543, 566, 567, 585, 586, 587, 588, 589, 590, 591, 642,
		653, 654, 655, 656, 658, 659, 660, 661, 662, 670, 671, 688, 695, 741, 742, 743, 746, 747, 748, 755, 794, 805, 806,
		820, 821, 822, 866, 867, 868, 888, 893, 895, 898, 899, 915, 916, 917, 918, 919, 920, 921, 922, 923, 924, 925, 926,
		927, 928, 950, 951, 952, 953, 954, 955, 956, 957, 958, 959, 960,
	]);
	const receiverOldMessages = Object.freeze(
		receiverOldMessageSequences.map((sequence) =>
			d108e4hLifecycle(trialId, sequence, "channel-message", receiverBefore, "rtc-datachannel-message-event")
		)
	);
	const receiverNewMessages = Object.freeze(
		Array.from({ length: 64 }, (_, index) =>
			d108e4hLifecycle(trialId, 977 + index, "channel-message", receiverAfter, "rtc-datachannel-message-event")
		)
	);
	const receiverAccepted = Object.freeze([
		...receiverOldMessages.map(({ sequence }, payloadSequence) =>
			d108e4hAcceptedRaw(receiverBefore, payloadSequence, sequence)
		),
		...receiverNewMessages.map(({ sequence }, index) => d108e4hAcceptedRaw(receiverAfter, 336 + index, sequence)),
	]);
	const captured = Object.freeze({
		endpoints: Object.freeze({
			creator: Object.freeze({
				acceptedRaw: Object.freeze([]),
				deadline: boundary(receiverPeerId, "67j4of1787980800178", 6, creatorAfter, creatorDeadlineTransport),
				lifecycle: Object.freeze([
					...creatorOldSends.lifecycle,
					d108e4hLifecycle(
						trialId,
						1_653,
						"channel-handler-installed",
						creatorAfter,
						"rtc-observer-datachannel-handler"
					),
					d108e4hLifecycle(
						trialId,
						1_654,
						"channel-message-handler-installed",
						creatorAfter,
						"rtc-observer-or-harness"
					),
					d108e4hLifecycle(
						trialId,
						1_655,
						"channel-message-handler-installed",
						creatorAfter,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(trialId, 1_656, "channel-close-call", creatorBefore, "product-unreliable-webrtc", {
						readyState: "closing",
					}),
					d108e4hLifecycle(trialId, 1_657, "channel-open-event", creatorAfter, "rtc-datachannel-open-event"),
					...creatorNewSends.lifecycle,
				]),
				monitor: d108e4hMonitor(trialId, receiverPeerId),
				peerId: creatorPeerId,
				prepare: boundary(receiverPeerId, "2f4n8z1787980768199", 5, creatorBefore, creatorPrepareTransport),
				rawSends: Object.freeze([...creatorOldSends.rawSends, ...creatorNewSends.rawSends]),
				rejectedRaw: Object.freeze([]),
				transmitsRawTrial: true,
			}),
			receiver: Object.freeze({
				acceptedRaw: receiverAccepted,
				deadline: boundary(creatorPeerId, "6rktlz1787980796505", 6, receiverAfter, receiverDeadlineTransport),
				lifecycle: Object.freeze([
					...receiverOldMessages.filter(({ sequence }) => sequence < 428),
					d108e4hLifecycle(
						trialId,
						428,
						"channel-handler-installed",
						receiverAfter,
						"rtc-observer-datachannel-handler",
						{ readyState: "connecting" }
					),
					d108e4hLifecycle(
						trialId,
						429,
						"channel-message-handler-installed",
						receiverAfter,
						"rtc-observer-or-harness",
						{ readyState: "connecting" }
					),
					...receiverOldMessages.filter(({ sequence }) => sequence > 429),
					d108e4hLifecycle(trialId, 961, "channel-open-event", receiverAfter, "rtc-datachannel-open-event"),
					d108e4hLifecycle(
						trialId,
						962,
						"channel-message-handler-installed",
						receiverAfter,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(trialId, 963, "channel-close-call", receiverBefore, "product-unreliable-webrtc"),
					...receiverNewMessages,
				]),
				monitor: d108e4hMonitor(trialId, creatorPeerId),
				peerId: receiverPeerId,
				prepare: boundary(creatorPeerId, "9i8v0y1787980768201", 5, receiverBefore, receiverPrepareTransport),
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
		schemaVersion: 3 as const,
		trialId,
	}) satisfies D108e4hValidationInput;
	if (!swapPageOrder) return captured;
	return Object.freeze({
		...captured,
		endpoints: Object.freeze({ creator: captured.endpoints.receiver, receiver: captured.endpoints.creator }),
		rawTransportDeltas: Object.freeze({
			creator: captured.rawTransportDeltas.receiver,
			receiver: captured.rawTransportDeltas.creator,
		}),
	});
}

function d108e4aaRetainedOldRtcBoundaryReplay(): D108e4hValidationInput {
	const trialId = "e3-03-2";
	const creatorPeerId = "16Uiu2HAm5SQJx1zQbk4bdMf6tsrm3CT399qmYnqmJFTJ5cS5K56X";
	const receiverPeerId = "16Uiu2HAmAX5is4bXzfn5UvM9MRaFA67JNLsub27SSTAFzLWasN19";
	const oldRtc = Object.freeze({
		channelId: 428,
		connectionId: 9,
		label: "ts-drp-ephemeral/1" as const,
		readyState: "open" as const,
	});
	const creatorReplacement = Object.freeze({ ...oldRtc, channelId: 444, connectionId: 12 });
	const receiverCandidate = Object.freeze({ ...creatorReplacement, channelId: 459 });
	const creatorPrepareTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: 1,
		lastLinkDrop: "restart",
		linkDrops: 4,
		sent: 2_133,
	});
	const creatorDeadlineTransport = d108e4hRawTransport(receiverPeerId, {
		authenticatedConnectionLosses: 3,
		lastLinkDrop: "replacement",
		linkDrops: 5,
		sent: 2_733,
	});
	const receiverPrepareTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: 2,
		lastLinkDrop: "restart",
		linkDrops: 4,
		received: 1_462,
	});
	const receiverDeadlineTransport = d108e4hRawTransport(creatorPeerId, {
		authenticatedConnectionLosses: 3,
		lastLinkDrop: "restart",
		linkDrops: 4,
		received: 1_872,
	});
	const boundary = (
		peerId: string,
		connectionId: string,
		generation: number,
		rtc: D108e4hRtcIdentity,
		rawTransport: ZoneSnapshot["rawTransport"]
	): D108e4hBoundaryCustody =>
		Object.freeze({
			authenticated: Object.freeze([Object.freeze({ connectionId, generation, peerId })]),
			rawTransport,
			rtc: Object.freeze([rtc]),
		});
	const creatorSend = d108e4hSendSlice(trialId, oldRtc, 0, SAMPLE_COUNT, 0);
	const receiverMessages = Object.freeze(
		Array.from({ length: 410 }, (_, sequence) =>
			d108e4hLifecycle(trialId, sequence, "channel-message", oldRtc, "rtc-datachannel-message-event")
		)
	);
	return Object.freeze({
		endpoints: Object.freeze({
			creator: Object.freeze({
				acceptedRaw: Object.freeze([]),
				deadline: boundary(receiverPeerId, "89buc51787965730711", 7, creatorReplacement, creatorDeadlineTransport),
				lifecycle: Object.freeze([
					...creatorSend.lifecycle,
					d108e4hLifecycle(trialId, 1_902, "channel-open-event", creatorReplacement, "rtc-datachannel-open-event"),
					d108e4hLifecycle(
						trialId,
						1_903,
						"channel-message-handler-installed",
						creatorReplacement,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(trialId, 1_904, "channel-close-call", oldRtc, "product-unreliable-webrtc"),
				]),
				monitor: d108e4hMonitor(trialId, receiverPeerId),
				peerId: creatorPeerId,
				prepare: boundary(receiverPeerId, "cb7gwl1787965677165", 5, oldRtc, creatorPrepareTransport),
				rawSends: creatorSend.rawSends,
				rejectedRaw: Object.freeze([]),
				transmitsRawTrial: true,
			}),
			receiver: Object.freeze({
				acceptedRaw: Object.freeze(
					receiverMessages.map(({ sequence }, payloadSequence) => d108e4hAcceptedRaw(oldRtc, payloadSequence, sequence))
				),
				deadline: boundary(creatorPeerId, "cle2721787965674006", 7, oldRtc, receiverDeadlineTransport),
				lifecycle: Object.freeze([
					...receiverMessages,
					d108e4hLifecycle(
						trialId,
						1_157,
						"channel-message-handler-installed",
						receiverCandidate,
						"rtc-observer-or-harness"
					),
					d108e4hLifecycle(
						trialId,
						1_158,
						"channel-message-handler-installed",
						receiverCandidate,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(trialId, 1_159, "channel-open-event", receiverCandidate, "rtc-datachannel-open-event"),
				]),
				monitor: d108e4hMonitor(trialId, creatorPeerId),
				peerId: receiverPeerId,
				prepare: boundary(creatorPeerId, "cle2721787965674006", 7, oldRtc, receiverPrepareTransport),
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

function d108e4hRtcIdentityKey({ channelId, connectionId }: D108e4hRtcIdentity): string {
	return `${connectionId}:${channelId}`;
}

function d108e4hSameRtcIdentity(
	left: Readonly<Pick<D108e4hRtcIdentity, "channelId" | "connectionId">>,
	right: Readonly<Pick<D108e4hRtcIdentity, "channelId" | "connectionId">>
): boolean {
	return left.connectionId === right.connectionId && left.channelId === right.channelId;
}

function d108e4hAssertRtcCensusUnique(records: readonly D108e4hRtcIdentity[]): void {
	const keys = new Set<string>();
	for (const record of records) {
		d108e4hAssert(
			Number.isSafeInteger(record.connectionId) &&
				Number.isSafeInteger(record.channelId) &&
				record.label === "ts-drp-ephemeral/1" &&
				record.readyState === "open" &&
				!keys.has(d108e4hRtcIdentityKey(record)),
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
		keys.add(d108e4hRtcIdentityKey(record));
	}
}

function d108e4hAssertDeadlinePendingCandidate(endpoint: D108e4hEndpointCustody, candidate: D108e4hRtcIdentity): void {
	const onCandidate = ({
		channelId,
		connectionId,
	}: {
		readonly channelId?: number;
		readonly connectionId: number;
	}): boolean => connectionId === candidate.connectionId && channelId === candidate.channelId;
	const opens = endpoint.lifecycle.filter(
		(record) =>
			onCandidate(record) &&
			record.event === "channel-open-event" &&
			record.label === "ts-drp-ephemeral/1" &&
			record.owner === "rtc-datachannel-open-event"
	);
	const handlers = endpoint.lifecycle.filter(
		(record) =>
			onCandidate(record) &&
			record.event === "channel-message-handler-installed" &&
			record.label === "ts-drp-ephemeral/1" &&
			record.owner === "product-unreliable-webrtc"
	);
	const terminal = endpoint.lifecycle.filter(
		(record) =>
			record.connectionId === candidate.connectionId &&
			((record.channelId === candidate.channelId &&
				(record.event === "channel-close-call" || record.event === "channel-close-event")) ||
				record.event === "connection-close-call")
	);
	d108e4hAssert(
		opens.length === 1 && handlers.length === 1 && terminal.length === 0,
		"D108E4H_LIFECYCLE_ORDER_INVALID"
	);

	const controlSends = (endpoint.controlSends ?? []).filter(onCandidate);
	const controlReceives = (endpoint.controlReceives ?? []).filter(onCandidate);
	for (const { bytes } of [...controlSends, ...controlReceives]) {
		d108e4avAssertControlBytes(bytes, "D108E4H_LIFECYCLE_ORDER_INVALID");
	}
	const sentKinds = controlSends.map(({ bytes, lifecycleSequence }) =>
		Object.freeze({ kind: bytes[3], lifecycleSequence })
	);
	const receivedKinds = controlReceives.map(({ bytes, lifecycleSequence }) =>
		Object.freeze({ kind: bytes[3], lifecycleSequence })
	);
	const firstSequence = (
		records: readonly Readonly<{ readonly kind: 1 | 2 | 3; readonly lifecycleSequence: number }>[],
		kind: 1 | 2 | 3
	): number | undefined => {
		const sequences = records
			.filter((record) => record.kind === kind)
			.map(({ lifecycleSequence }) => lifecycleSequence);
		return sequences.length === 0 ? undefined : Math.min(...sequences);
	};
	const firstSentReady = firstSequence(sentKinds, 1);
	const firstReceivedReady = firstSequence(receivedKinds, 1);
	const firstReceivedAck = firstSequence(receivedKinds, 2);
	const firstSentAck = firstSequence(sentKinds, 2);
	const open = opens[0] as D108e4hLifecycleObservation;
	const handler = handlers[0] as D108e4hLifecycleObservation;
	const lastAnchorSequence = Math.max(open.sequence, handler.sequence);
	const controlsFollowAnchors = [...sentKinds, ...receivedKinds].every(
		({ lifecycleSequence }) => lastAnchorSequence < lifecycleSequence
	);
	const initiator =
		controlsFollowAnchors &&
		firstSentReady !== undefined &&
		sentKinds.every(({ kind }) => kind === 1 || kind === 3) &&
		receivedKinds.every(({ kind }) => kind === 2) &&
		receivedKinds.every(({ lifecycleSequence }) => firstSentReady < lifecycleSequence) &&
		sentKinds.every(
			({ kind, lifecycleSequence }) =>
				kind !== 3 || (firstReceivedAck !== undefined && firstReceivedAck < lifecycleSequence)
		);
	const controlsFollowHandler = [...sentKinds, ...receivedKinds].every(
		({ lifecycleSequence }) => handler.sequence < lifecycleSequence
	);
	const preOpenSends = sentKinds.filter(({ lifecycleSequence }) => lifecycleSequence < open.sequence);
	const preReadySends =
		firstReceivedReady === undefined
			? []
			: sentKinds.filter(({ lifecycleSequence }) => lifecycleSequence < firstReceivedReady);
	const firstPostReadyAck =
		firstReceivedReady === undefined
			? undefined
			: firstSequence(
					sentKinds.filter(({ kind, lifecycleSequence }) => kind === 2 && firstReceivedReady < lifecycleSequence),
					2
				);
	const commitsFollowPostReadyAck = receivedKinds.every(
		({ kind, lifecycleSequence }) =>
			kind !== 3 || (firstPostReadyAck !== undefined && firstPostReadyAck < lifecycleSequence)
	);
	const acceptor =
		controlsFollowHandler &&
		firstReceivedReady !== undefined &&
		firstSentAck !== undefined &&
		sentKinds.every(({ kind }) => kind === 2) &&
		receivedKinds.every(({ kind }) => kind === 1 || kind === 3) &&
		receivedKinds.every(({ lifecycleSequence }) => open.sequence < lifecycleSequence) &&
		(preReadySends.length === 0 || handler.readyState === "open") &&
		preOpenSends.every(({ kind }) => kind === 2) &&
		preReadySends.length <= 1 &&
		firstPostReadyAck !== undefined &&
		commitsFollowPostReadyAck;
	d108e4hAssert(initiator !== acceptor, "D108E4H_LIFECYCLE_ORDER_INVALID");
}

function d108e4hAssertZeroLocalBoundaryIdentity(
	endpoint: D108e4hEndpointCustody
): Readonly<{ readonly after: D108e4hRtcIdentity; readonly before: D108e4hRtcIdentity }> {
	d108e4hAssertRtcCensusUnique(endpoint.prepare.rtc);
	d108e4hAssertRtcCensusUnique(endpoint.deadline.rtc);
	const common = endpoint.prepare.rtc.filter((before) =>
		endpoint.deadline.rtc.some((after) => d108e4hSameRtcIdentity(before, after))
	);
	const selected = d108e4hOnly(common);
	const prepareCandidates = endpoint.prepare.rtc.filter((record) => !d108e4hSameRtcIdentity(record, selected));
	const deadlineCandidates = endpoint.deadline.rtc.filter((record) => !d108e4hSameRtcIdentity(record, selected));
	d108e4hAssert(prepareCandidates.length <= 1 && deadlineCandidates.length <= 1, "D108E4H_IDENTITY_JOIN_INVALID");
	const applicationRecords = [...endpoint.rawSends, ...endpoint.acceptedRaw, ...endpoint.rejectedRaw];
	d108e4hAssert(
		applicationRecords.every((record) => d108e4hSameRtcIdentity(record, selected)),
		"D108E4H_IDENTITY_JOIN_INVALID"
	);
	const deadlineCandidate = deadlineCandidates[0];
	if (deadlineCandidate !== undefined) d108e4hAssertDeadlinePendingCandidate(endpoint, deadlineCandidate);
	return Object.freeze({ after: selected, before: selected });
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
	replaced: boolean,
	incomingReplacement = false
): Readonly<{ readonly after: D108e4hRtcIdentity; readonly before: D108e4hRtcIdentity }> {
	const beforeAuthenticated = d108e4hOnly(endpoint.prepare.authenticated);
	const afterAuthenticated = d108e4hOnly(endpoint.deadline.authenticated);
	const selectedBoundary =
		!replaced && !incomingReplacement
			? d108e4hAssertZeroLocalBoundaryIdentity(endpoint)
			: Object.freeze({ before: d108e4hOnly(endpoint.prepare.rtc), after: d108e4hOnly(endpoint.deadline.rtc) });
	const { after: afterRtc, before: beforeRtc } = selectedBoundary;
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
	const authenticatedStable =
		beforeAuthenticated.connectionId === afterAuthenticated.connectionId &&
		beforeAuthenticated.generation === afterAuthenticated.generation;
	const rtcChanged = beforeRtc.connectionId !== afterRtc.connectionId && beforeRtc.channelId !== afterRtc.channelId;
	const rtcStable = beforeRtc.connectionId === afterRtc.connectionId && beforeRtc.channelId === afterRtc.channelId;
	if (replaced) {
		d108e4hAssert(authenticatedChanged && rtcChanged, "D108E4H_IDENTITY_JOIN_INVALID");
	} else if (incomingReplacement) {
		d108e4hAssert(authenticatedStable && (rtcStable || rtcChanged), "D108E4H_IDENTITY_JOIN_INVALID");
	} else {
		d108e4hAssert(authenticatedStable && rtcStable, "D108E4H_IDENTITY_JOIN_INVALID");
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

function d108e4hAssertOpenRepeats(lifecycle: readonly D108e4hLifecycleObservation[]): void {
	const repeatKeys = new Set<string>();
	for (const repeat of lifecycle.filter(({ event }) => event === "channel-open-repeat-event")) {
		d108e4hAssert(repeat.channelId !== undefined, "D108E4H_IDENTITY_JOIN_INVALID");
		const sameIdentity = lifecycle.filter(
			(record) =>
				record !== repeat && record.connectionId === repeat.connectionId && record.channelId === repeat.channelId
		);
		d108e4hAssert(sameIdentity.length > 0, "D108E4H_IDENTITY_JOIN_INVALID");
		d108e4hAssert(
			repeat.owner === "rtc-datachannel-open-repeat-event" && repeat.readyState === "open",
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const anchors = sameIdentity.filter(
			({ event, label, owner, trialId }) =>
				event === "channel-open-event" &&
				label === repeat.label &&
				owner === "rtc-datachannel-open-event" &&
				trialId === repeat.trialId
		);
		d108e4hAssert(
			anchors.length === 1 && (anchors[0]?.sequence ?? Number.POSITIVE_INFINITY) < repeat.sequence,
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		d108e4hAssert(
			sameIdentity
				.filter(
					({ event, label, trialId }) =>
						label === repeat.label &&
						trialId === repeat.trialId &&
						(event === "channel-close-call" || event === "channel-close-event")
				)
				.every(({ sequence }) => repeat.sequence < sequence),
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const repeatKey = `${repeat.trialId}\u0000${repeat.connectionId}\u0000${repeat.channelId}\u0000${repeat.label ?? ""}`;
		d108e4hAssert(!repeatKeys.has(repeatKey), "D108E4H_LIFECYCLE_ORDER_INVALID");
		repeatKeys.add(repeatKey);
	}
}

function d108e4avAssertControlBytes(bytes: readonly number[], code: string): void {
	d108e4hAssert(
		bytes.length === 4 &&
			bytes[0] === 0x44 &&
			bytes[1] === 0x52 &&
			bytes[2] === 0x01 &&
			(bytes[3] === 1 || bytes[3] === 2 || bytes[3] === 3),
		code
	);
}

function d108e4hAssertAttemptCustody(
	endpoint: D108e4hEndpointCustody,
	before: D108e4hRtcIdentity,
	after: D108e4hRtcIdentity,
	replaced: boolean,
	sampleCount: number,
	admittedSampleCount: number,
	incomingReplacement = false
): void {
	const allAttempts = endpoint.lifecycle.filter(
		({ event, label }) => event === "channel-send-attempt" && label === "ts-drp-ephemeral/1"
	);
	const allTerminals = endpoint.lifecycle.filter(
		({ event, label }) =>
			label === "ts-drp-ephemeral/1" && (event === "channel-send-success" || event === "channel-send-failure")
	);
	const controlAttemptIds = new Set<number>();
	for (const control of endpoint.controlSends ?? []) {
		d108e4avAssertControlBytes(control.bytes, "D108E4H_IDENTITY_JOIN_INVALID");
		d108e4hAssert(
			Number.isSafeInteger(control.attemptId) &&
				control.attemptId >= 0 &&
				Number.isSafeInteger(control.lifecycleSequence) &&
				control.lifecycleSequence >= 0 &&
				!controlAttemptIds.has(control.attemptId) &&
				!endpoint.rawSends.some(({ attemptId }) => attemptId === control.attemptId),
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
		controlAttemptIds.add(control.attemptId);
		const joinedAttempts = allAttempts.filter(({ attemptId }) => attemptId === control.attemptId);
		d108e4hAssert(joinedAttempts.length === 1, "D108E4H_IDENTITY_JOIN_INVALID");
		const attempt = joinedAttempts[0] as D108e4hLifecycleObservation;
		d108e4hAssert(
			attempt.channelId === control.channelId &&
				attempt.connectionId === control.connectionId &&
				attempt.sequence === control.lifecycleSequence,
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
		const joinedTerminals = allTerminals.filter(({ attemptId }) => attemptId === control.attemptId);
		d108e4hAssert(joinedTerminals.length === 1, "D108E4H_ATTEMPT_TERMINAL_CARDINALITY");
		const terminal = joinedTerminals[0] as D108e4hLifecycleObservation;
		d108e4hAssert(
			terminal.channelId === control.channelId && terminal.connectionId === control.connectionId,
			"D108E4H_IDENTITY_JOIN_INVALID"
		);
		d108e4hAssert(attempt.sequence < terminal.sequence, "D108E4H_LIFECYCLE_ORDER_INVALID");
	}
	const attempts = allAttempts.filter(({ attemptId }) => attemptId === undefined || !controlAttemptIds.has(attemptId));
	const terminals = allTerminals.filter(
		({ attemptId }) => attemptId === undefined || !controlAttemptIds.has(attemptId)
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
	d108e4hAssert(sequences.size === admittedSampleCount, "D108E4H_RAW_SEND_DOMAIN_INVALID");
	d108e4hAssert(
		attempts.every(({ attemptId }) => attemptId !== undefined && attemptIds.has(attemptId)) &&
			terminals.every(({ attemptId }) => attemptId !== undefined && attemptIds.has(attemptId)),
		"D108E4H_IDENTITY_JOIN_INVALID"
	);
	const rtcChanged = before.connectionId !== after.connectionId && before.channelId !== after.channelId;
	if (replaced || (incomingReplacement && rtcChanged)) {
		const replacementOpens = endpoint.lifecycle.filter(
			({ channelId, connectionId, event, label, owner }) =>
				connectionId === after.connectionId &&
				channelId === after.channelId &&
				event === "channel-open-event" &&
				label === "ts-drp-ephemeral/1" &&
				owner === "rtc-datachannel-open-event"
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
	transitionReason: "channel-close" | "replacement" | undefined,
	incomingReplacement = false
): void {
	const allMessages = endpoint.lifecycle.filter(
		({ event, label }) => event === "channel-message" && label === "ts-drp-ephemeral/1"
	);
	const controlMessageSequences = new Set<number>();
	for (const control of endpoint.controlReceives ?? []) {
		d108e4avAssertControlBytes(control.bytes, "D108E4H_OVERLAP_LEDGER_INVALID");
		d108e4hAssert(
			Number.isSafeInteger(control.lifecycleSequence) &&
				control.lifecycleSequence >= 0 &&
				!controlMessageSequences.has(control.lifecycleSequence),
			"D108E4H_OVERLAP_LEDGER_INVALID"
		);
		controlMessageSequences.add(control.lifecycleSequence);
		const joinedMessages = allMessages.filter(({ sequence }) => sequence === control.lifecycleSequence);
		d108e4hAssert(joinedMessages.length === 1, "D108E4H_OVERLAP_LEDGER_INVALID");
		const message = joinedMessages[0] as D108e4hLifecycleObservation;
		d108e4hAssert(
			message.connectionId === control.connectionId && message.channelId === control.channelId,
			"D108E4H_OVERLAP_LEDGER_INVALID"
		);
	}
	const messages = allMessages.filter(({ sequence }) => !controlMessageSequences.has(sequence));
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
	const rtcChanged = before.connectionId !== after.connectionId && before.channelId !== after.channelId;
	if (!replaced && (!incomingReplacement || !rtcChanged)) return;
	const replacementOpens = endpoint.lifecycle.filter(
		({ channelId, connectionId, event, label, owner }) =>
			connectionId === after.connectionId &&
			channelId === after.channelId &&
			event === "channel-open-event" &&
			label === "ts-drp-ephemeral/1" &&
			owner === "rtc-datachannel-open-event"
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
	const replacementOpenHandlers = endpoint.lifecycle.filter(
		({ channelId, connectionId, event, label, owner, readyState }) =>
			connectionId === after.connectionId &&
			channelId === after.channelId &&
			event === "channel-handler-installed" &&
			label === "ts-drp-ephemeral/1" &&
			owner === "rtc-observer-datachannel-handler" &&
			readyState === "open"
	);
	const replacementCloseRecords = endpoint.lifecycle.filter(
		({ channelId, connectionId, event, label }) =>
			connectionId === after.connectionId &&
			channelId === after.channelId &&
			(event === "channel-close-call" || event === "channel-close-event") &&
			label === "ts-drp-ephemeral/1"
	);
	d108e4hAssert(replacementOpens.length === 1 && replacementHandlers.length === 1, "D108E4H_LIFECYCLE_ORDER_INVALID");
	const replacementOpen = replacementOpens[0] as D108e4hLifecycleObservation;
	const replacementHandler = replacementHandlers[0] as D108e4hLifecycleObservation;
	if (incomingReplacement) {
		d108e4hAssert(oldCloseCalls.length === 0, "D108E4H_LIFECYCLE_ORDER_INVALID");
		const replacementReady = Math.max(replacementOpen.sequence, replacementHandler.sequence);
		const replacementStarted = Math.min(replacementOpen.sequence, replacementHandler.sequence);
		for (const record of ledger) {
			const onBefore = record.connectionId === before.connectionId && record.channelId === before.channelId;
			const onAfter = record.connectionId === after.connectionId && record.channelId === after.channelId;
			d108e4hAssert(onBefore || onAfter, "D108E4H_OVERLAP_LEDGER_INVALID");
			d108e4hAssert(
				(onBefore && record.lifecycleSequence < replacementStarted) ||
					(onAfter && replacementReady < record.lifecycleSequence),
				"D108E4H_LIFECYCLE_ORDER_INVALID"
			);
		}
		return;
	}
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
		d108e4hAssert(replacementOpenHandlers.length <= 1, "D108E4H_LIFECYCLE_ORDER_INVALID");
		const oldCloseCall = oldCloseCalls[0] as D108e4hLifecycleObservation;
		const oldCloseEvent = oldCloseEvents[0];
		d108e4hAssert(
			replacementHandler.sequence < oldCloseCall.sequence &&
				(replacementOpen.sequence < oldCloseCall.sequence ||
					replacementOpenHandlers.some(({ sequence }) => sequence < oldCloseCall.sequence)) &&
				replacementCloseRecords.every(({ sequence }) => oldCloseCall.sequence < sequence) &&
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
	trialId: string,
	incomingReplacement: boolean,
	trialWideZeroLocal: boolean
): void {
	d108e4hAssert(endpoint.lifecycle.length > 0, "D108E4H_LIFECYCLE_CUSTODY_ABSENT");
	for (const record of endpoint.lifecycle) {
		d108e4hAssert(record.schemaVersion === 3, "D108E4H_SCHEMA_INVALID");
		d108e4hAssert(record.trialId === trialId, "D108E4H_TRIAL_MISMATCH");
	}
	d108e4hAssertClosedSequence(endpoint.lifecycle);
	d108e4hAssertOpenRepeats(endpoint.lifecycle);
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
	const { after, before } = d108e4hAssertBoundaryIdentity(endpoint, remotePeerId, replaced, incomingReplacement);
	d108e4hAssert(
		Number.isSafeInteger(delta.backpressuredDrops) && delta.backpressuredDrops >= 0,
		"D108E4H_RAW_SEND_DOMAIN_INVALID"
	);
	d108e4hAssert(
		delta.backpressuredDrops === 0 || (endpoint.transmitsRawTrial && trialWideZeroLocal),
		"D108E4H_RAW_BACKPRESSURE"
	);
	const admittedSampleCount = sampleCount - delta.backpressuredDrops;
	d108e4hAssert(
		Number.isSafeInteger(admittedSampleCount) && admittedSampleCount >= 0,
		"D108E4H_RAW_SEND_DOMAIN_INVALID"
	);
	d108e4hAssertAttemptCustody(endpoint, before, after, replaced, sampleCount, admittedSampleCount, incomingReplacement);
	d108e4hAssertOverlapCustody(endpoint, before, after, replaced, transitionReason, incomingReplacement);
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
	const endpointNames = ["creator", "receiver"] as const;
	const replacementOwners = endpointNames.filter((name) => {
		const delta = input.rawTransportDeltas[name];
		return delta.linkDrops === 1 && delta.lastLinkDrop.after === "replacement";
	});
	const isIncomingReplacement = (name: (typeof endpointNames)[number]): boolean => {
		const peerName = name === "creator" ? "receiver" : "creator";
		return input.rawTransportDeltas[name].linkDrops === 0 && replacementOwners.includes(peerName);
	};
	const trialWideZeroLocal = endpointNames.every((name) => input.rawTransportDeltas[name].linkDrops === 0);
	d108e4hValidateEndpoint(
		input.endpoints.creator,
		input.endpoints.receiver.peerId,
		input.rawTransportDeltas.creator,
		input.sampleCount,
		input.trialId,
		isIncomingReplacement("creator"),
		trialWideZeroLocal
	);
	d108e4hValidateEndpoint(
		input.endpoints.receiver,
		input.endpoints.creator.peerId,
		input.rawTransportDeltas.receiver,
		input.sampleCount,
		input.trialId,
		isIncomingReplacement("receiver"),
		trialWideZeroLocal
	);
}

const D108E4AP_RUN_RETURN_BOUND_MS = (SAMPLE_COUNT - 1) * SAMPLE_INTERVAL_MS - 1_000;
const D108E4AR_RUN_RETURN_SENDER_WIRE_KEY = "runReturnSenderWire" as const;

type D108e4arFinalRunReturnCustody = {
	readonly runTrialReturnedAtMs: number;
	readonly runReturnSenderWire: readonly PlatformObservation[];
};
type D108e4arFinalizeRunReturnCustody = <TBase extends { readonly deadlineSenderWire: readonly PlatformObservation[] }>(
	base: TBase,
	custody: Readonly<Record<string, unknown>>
) => Readonly<TBase & D108e4arFinalRunReturnCustody>;

function d108e4apBuildRunReturnProgress(
	progress: Readonly<Record<string, unknown>>,
	runTrialReturnedAtMs: number
): Readonly<Record<string, unknown>> {
	if (!Number.isSafeInteger(runTrialReturnedAtMs) || runTrialReturnedAtMs < 0)
		throw new Error("D108E4AP_RUN_RETURN_CUSTODY_INVALID");
	return Object.freeze({ ...progress, runTrialReturnedAtMs });
}

function d108e4apRunReturnTimestamp(progress: Readonly<Record<string, unknown>>): number {
	const present = Object.hasOwn(progress, "runTrialReturnedAtMs");
	const value = progress["runTrialReturnedAtMs"];
	if (!present || value === undefined) throw new Error("D108E4AP_RUN_RETURN_CUSTODY_ABSENT");
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("D108E4AP_RUN_RETURN_CUSTODY_INVALID");
	return value;
}

function d108e4apAssertRunReturnJoin(progress: Readonly<Record<string, unknown>>, campaignStartedAtMs: number): void {
	if (d108e4apRunReturnTimestamp(progress) - campaignStartedAtMs < D108E4AP_RUN_RETURN_BOUND_MS)
		throw new Error("D108E4AP_RUN_RETURN_JOIN_INVALID");
}

const d108e4arFinalizeRunReturnCustody: D108e4arFinalizeRunReturnCustody = (base, custody) => {
	const present = Object.hasOwn(custody, D108E4AR_RUN_RETURN_SENDER_WIRE_KEY);
	const value = custody[D108E4AR_RUN_RETURN_SENDER_WIRE_KEY];
	if (!present || value === undefined) throw new Error("D108E4AR_FINAL_RUN_RETURN_CUSTODY_ABSENT");
	if (!Array.isArray(value)) throw new Error("D108E4AR_FINAL_RUN_RETURN_CUSTODY_INVALID");
	const runReturnSenderWire = value as readonly PlatformObservation[];
	const runTrialReturnedAtMs = d108e4apRunReturnTimestamp(custody);
	return Object.freeze({ ...base, runReturnSenderWire, runTrialReturnedAtMs });
};

if (process.env["D108E4H_TELEMETRY"] === "1") {
	test("validates schema-v3 replacement custody without cross-peer clocks", () => {
		const noReplacement = d108e4hFixture("none");
		const persistedReplacementWithoutDrop = d108e4hFixture("none-persisted-replacement");
		const creatorChannelClose = d108e4hFixture("creator-channel-close");
		const creatorReplacement = d108e4hFixture("creator-replacement");
		const receiverReplacement = d108e4hFixture("receiver-replacement");
		const repeatedReplacement = d108e4hFixture("receiver-repeated-replacement");
		const receiverChannelClose = d108e4hFixture("receiver-channel-close");
		const d108e4avControlBytes = (kind: 1 | 2 | 3): readonly [0x44, 0x52, 0x01, 1 | 2 | 3] =>
			Object.freeze([0x44, 0x52, 0x01, kind]);
		const creatorControlSequence =
			Math.max(...creatorReplacement.endpoints.creator.lifecycle.map(({ sequence }) => sequence)) + 1;
		const transmitterControlRed = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({
					...creatorReplacement.endpoints.creator,
					controlSends: Object.freeze([
						Object.freeze({
							attemptId: 900_001,
							bytes: d108e4avControlBytes(1),
							channelId: D108E4H_RTC_B.channelId,
							connectionId: D108E4H_RTC_B.connectionId,
							lifecycleSequence: creatorControlSequence,
						}),
					]),
					lifecycle: Object.freeze([
						...creatorReplacement.endpoints.creator.lifecycle,
						d108e4hLifecycle(
							creatorReplacement.trialId,
							creatorControlSequence,
							"channel-send-attempt",
							D108E4H_RTC_B,
							"rtc-datachannel-send",
							{ attemptId: 900_001 }
						),
						d108e4hLifecycle(
							creatorReplacement.trialId,
							creatorControlSequence + 1,
							"channel-send-success",
							D108E4H_RTC_B,
							"rtc-datachannel-send",
							{ attemptId: 900_001 }
						),
					]),
				}),
			}),
		});
		const receiverControlSequence =
			Math.max(...creatorReplacement.endpoints.receiver.lifecycle.map(({ sequence }) => sequence)) + 1;
		const nontransmitterControlRed = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				receiver: Object.freeze({
					...creatorReplacement.endpoints.receiver,
					controlSends: Object.freeze([
						Object.freeze({
							attemptId: 900_002,
							bytes: d108e4avControlBytes(2),
							channelId: D108E4H_RTC_B.channelId,
							connectionId: D108E4H_RTC_B.connectionId,
							lifecycleSequence: receiverControlSequence,
						}),
					]),
					lifecycle: Object.freeze([
						...creatorReplacement.endpoints.receiver.lifecycle,
						d108e4hLifecycle(
							creatorReplacement.trialId,
							receiverControlSequence,
							"channel-send-attempt",
							D108E4H_RTC_B,
							"rtc-datachannel-send",
							{ attemptId: 900_002 }
						),
						d108e4hLifecycle(
							creatorReplacement.trialId,
							receiverControlSequence + 1,
							"channel-send-success",
							D108E4H_RTC_B,
							"rtc-datachannel-send",
							{ attemptId: 900_002 }
						),
					]),
				}),
			}),
		});
		const receivedControlRed = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				receiver: Object.freeze({
					...creatorReplacement.endpoints.receiver,
					controlReceives: Object.freeze([
						Object.freeze({
							bytes: d108e4avControlBytes(3),
							channelId: D108E4H_RTC_B.channelId,
							connectionId: D108E4H_RTC_B.connectionId,
							lifecycleSequence: receiverControlSequence,
						}),
					]),
					lifecycle: Object.freeze([
						...creatorReplacement.endpoints.receiver.lifecycle,
						d108e4hLifecycle(
							creatorReplacement.trialId,
							receiverControlSequence,
							"channel-message",
							D108E4H_RTC_B,
							"rtc-datachannel-message-event"
						),
					]),
				}),
			}),
		});
		const d108e4avCausalRed = (fixture: D108e4hValidationInput, expectedCode: string, token: string): void => {
			let observedCode: string | undefined;
			try {
				validateD108e4hCampaignCustody(fixture);
			} catch (error) {
				observedCode = error instanceof Error ? error.message : String(error);
			}
			if (observedCode !== undefined && observedCode !== expectedCode) {
				throw new Error(`D108E4AV_CAUSE_MISMATCH:${token}:${observedCode}`);
			}
			expect.soft(observedCode, token).toBeUndefined();
		};
		d108e4avCausalRed(transmitterControlRed, "D108E4H_IDENTITY_JOIN_INVALID", "D108E4AV_TRANSMITTER_CONTROL_REJECTED");
		d108e4avCausalRed(
			nontransmitterControlRed,
			"D108E4H_RAW_SEND_ROLE_INVALID",
			"D108E4AV_NONTRANSMITTER_CONTROL_REJECTED"
		);
		d108e4avCausalRed(receivedControlRed, "D108E4H_OVERLAP_LEDGER_INVALID", "D108E4AV_RECEIVED_CONTROL_REJECTED");
		const d108e4avWithEndpoint = (
			fixture: D108e4hValidationInput,
			name: "creator" | "receiver",
			patch: Partial<D108e4hEndpointCustody>
		): D108e4hValidationInput =>
			Object.freeze({
				...fixture,
				endpoints: Object.freeze({
					...fixture.endpoints,
					[name]: Object.freeze({ ...fixture.endpoints[name], ...patch }),
				}),
			});
		const d108e4avExpectCode = (fixture: D108e4hValidationInput, code: string, label: string): void => {
			expect.soft(() => validateD108e4hCampaignCustody(fixture), label).toThrowError(code);
		};
		const d108e4avInvalidBytes = (...bytes: number[]): D108e4avControlBytes =>
			Object.freeze(bytes) as unknown as D108e4avControlBytes;
		const transmitterControl = d108e4hOnly(transmitterControlRed.endpoints.creator.controlSends ?? []);
		const transmitterAttempt = d108e4hOnly(
			transmitterControlRed.endpoints.creator.lifecycle.filter(
				({ attemptId, event }) => attemptId === transmitterControl.attemptId && event === "channel-send-attempt"
			)
		);
		const transmitterTerminal = d108e4hOnly(
			transmitterControlRed.endpoints.creator.lifecycle.filter(
				({ attemptId, event }) =>
					attemptId === transmitterControl.attemptId &&
					(event === "channel-send-success" || event === "channel-send-failure")
			)
		);
		const nontransmitterControl = d108e4hOnly(nontransmitterControlRed.endpoints.receiver.controlSends ?? []);
		const receivedControl = d108e4hOnly(receivedControlRed.endpoints.receiver.controlReceives ?? []);
		for (const kind of [1, 2, 3] as const) {
			expect
				.soft(
					() =>
						validateD108e4hCampaignCustody(
							d108e4avWithEndpoint(transmitterControlRed, "creator", {
								controlSends: Object.freeze([
									Object.freeze({ ...transmitterControl, bytes: d108e4avControlBytes(kind) }),
								]),
							})
						),
					`transmitting endpoint accepts control kind ${kind}`
				)
				.not.toThrow();
			expect
				.soft(
					() =>
						validateD108e4hCampaignCustody(
							d108e4avWithEndpoint(nontransmitterControlRed, "receiver", {
								controlSends: Object.freeze([
									Object.freeze({ ...nontransmitterControl, bytes: d108e4avControlBytes(kind) }),
								]),
							})
						),
					`nontransmitting endpoint accepts control kind ${kind}`
				)
				.not.toThrow();
			expect
				.soft(
					() =>
						validateD108e4hCampaignCustody(
							d108e4avWithEndpoint(receivedControlRed, "receiver", {
								controlReceives: Object.freeze([
									Object.freeze({ ...receivedControl, bytes: d108e4avControlBytes(kind) }),
								]),
							})
						),
					`receive ledger accepts control kind ${kind}`
				)
				.not.toThrow();
		}
		for (const [label, bytes] of [
			["wrong control magic", d108e4avInvalidBytes(0x45, 0x52, 0x01, 1)],
			["wrong control version", d108e4avInvalidBytes(0x44, 0x52, 0x02, 1)],
			["control kind zero", d108e4avInvalidBytes(0x44, 0x52, 0x01, 0)],
			["control kind four", d108e4avInvalidBytes(0x44, 0x52, 0x01, 4)],
			["three-byte control", d108e4avInvalidBytes(0x44, 0x52, 0x01)],
			["five-byte control", d108e4avInvalidBytes(0x44, 0x52, 0x01, 1, 0)],
		] as const) {
			d108e4avExpectCode(
				d108e4avWithEndpoint(transmitterControlRed, "creator", {
					controlSends: Object.freeze([Object.freeze({ ...transmitterControl, bytes })]),
				}),
				"D108E4H_IDENTITY_JOIN_INVALID",
				label
			);
		}
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", { controlSends: Object.freeze([]) }),
			"D108E4H_IDENTITY_JOIN_INVALID",
			"transmitting unledgered control remains an application reverse-join failure"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(nontransmitterControlRed, "receiver", { controlSends: Object.freeze([]) }),
			"D108E4H_RAW_SEND_ROLE_INVALID",
			"nontransmitting unledgered control remains a role failure"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				controlSends: Object.freeze([Object.freeze({ ...transmitterControl, attemptId: Number.MAX_SAFE_INTEGER + 1 })]),
			}),
			"D108E4H_IDENTITY_JOIN_INVALID",
			"unsafe control attempt id"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				controlSends: Object.freeze([transmitterControl, Object.freeze({ ...transmitterControl })]),
			}),
			"D108E4H_IDENTITY_JOIN_INVALID",
			"duplicate control attempt id"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				controlSends: Object.freeze([
					Object.freeze({
						...transmitterControl,
						attemptId: (transmitterControlRed.endpoints.creator.rawSends[0] as D108e4hRawSend).attemptId,
					}),
				]),
			}),
			"D108E4H_IDENTITY_JOIN_INVALID",
			"application and control attempt ids are disjoint"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				lifecycle: Object.freeze(
					transmitterControlRed.endpoints.creator.lifecycle.filter((record) => record !== transmitterAttempt)
				),
			}),
			"D108E4H_IDENTITY_JOIN_INVALID",
			"missing control attempt"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				lifecycle: Object.freeze([
					...transmitterControlRed.endpoints.creator.lifecycle,
					d108e4hLifecycle(
						transmitterControlRed.trialId,
						transmitterTerminal.sequence + 1,
						"channel-send-attempt",
						D108E4H_RTC_B,
						"rtc-datachannel-send",
						{ attemptId: transmitterControl.attemptId }
					),
				]),
			}),
			"D108E4H_IDENTITY_JOIN_INVALID",
			"duplicate matching control attempts"
		);
		for (const [label, control] of [
			["control connection mismatch", Object.freeze({ ...transmitterControl, connectionId: 999_001 })],
			["control channel mismatch", Object.freeze({ ...transmitterControl, channelId: 999_002 })],
			[
				"control lifecycle sequence mismatch",
				Object.freeze({ ...transmitterControl, lifecycleSequence: transmitterControl.lifecycleSequence + 1 }),
			],
		] as const) {
			d108e4avExpectCode(
				d108e4avWithEndpoint(transmitterControlRed, "creator", {
					controlSends: Object.freeze([control]),
				}),
				"D108E4H_IDENTITY_JOIN_INVALID",
				label
			);
		}
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				lifecycle: Object.freeze(
					transmitterControlRed.endpoints.creator.lifecycle.filter((record) => record !== transmitterTerminal)
				),
			}),
			"D108E4H_ATTEMPT_TERMINAL_CARDINALITY",
			"missing control terminal"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				lifecycle: Object.freeze([
					...transmitterControlRed.endpoints.creator.lifecycle,
					d108e4hLifecycle(
						transmitterControlRed.trialId,
						transmitterTerminal.sequence + 1,
						"channel-send-success",
						D108E4H_RTC_B,
						"rtc-datachannel-send",
						{ attemptId: transmitterControl.attemptId }
					),
				]),
			}),
			"D108E4H_ATTEMPT_TERMINAL_CARDINALITY",
			"duplicate control terminal"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				lifecycle: Object.freeze(
					transmitterControlRed.endpoints.creator.lifecycle.map((record) =>
						record === transmitterTerminal
							? Object.freeze({ ...record, channelId: (record.channelId ?? transmitterControl.channelId) + 1 })
							: record
					)
				),
			}),
			"D108E4H_IDENTITY_JOIN_INVALID",
			"control terminal identity mismatch"
		);
		const invertedControlLifecycle = Object.freeze(
			transmitterControlRed.endpoints.creator.lifecycle.map((record) => {
				if (record === transmitterAttempt) return Object.freeze({ ...record, event: "channel-send-success" as const });
				if (record === transmitterTerminal) return Object.freeze({ ...record, event: "channel-send-attempt" as const });
				return record;
			})
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(transmitterControlRed, "creator", {
				controlSends: Object.freeze([
					Object.freeze({ ...transmitterControl, lifecycleSequence: transmitterTerminal.sequence }),
				]),
				lifecycle: invertedControlLifecycle,
			}),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"control terminal precedes attempt"
		);
		for (const [label, eventPatch] of [
			["wrong-label control attempt", Object.freeze({ label: "not-ts-drp" })],
			["message direction forged into send ledger", Object.freeze({ event: "channel-message" as const })],
		] as const) {
			d108e4avExpectCode(
				d108e4avWithEndpoint(transmitterControlRed, "creator", {
					lifecycle: Object.freeze(
						transmitterControlRed.endpoints.creator.lifecycle.map((record) =>
							record === transmitterAttempt ? Object.freeze({ ...record, ...eventPatch }) : record
						)
					),
				}),
				"D108E4H_IDENTITY_JOIN_INVALID",
				label
			);
		}
		expect
			.soft(
				() =>
					validateD108e4hCampaignCustody(
						d108e4avWithEndpoint(transmitterControlRed, "creator", {
							lifecycle: Object.freeze(
								transmitterControlRed.endpoints.creator.lifecycle.map((record) =>
									record === transmitterTerminal
										? Object.freeze({ ...record, event: "channel-send-failure" as const })
										: record
								)
							),
						})
					),
				"proved failed control remains outside the application domain"
			)
			.not.toThrow();
		d108e4avExpectCode(
			d108e4avWithEndpoint(receivedControlRed, "receiver", { controlReceives: Object.freeze([]) }),
			"D108E4H_OVERLAP_LEDGER_INVALID",
			"unledgered exact control receive"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(receivedControlRed, "receiver", {
				controlReceives: Object.freeze([
					Object.freeze({ ...receivedControl, bytes: d108e4avInvalidBytes(0x44, 0x52, 0x02, 3) }),
				]),
			}),
			"D108E4H_OVERLAP_LEDGER_INVALID",
			"malformed receive control"
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(receivedControlRed, "receiver", {
				controlReceives: Object.freeze([receivedControl, Object.freeze({ ...receivedControl })]),
			}),
			"D108E4H_OVERLAP_LEDGER_INVALID",
			"duplicate receive control lifecycle sequence"
		);
		const receivedControlMessage = d108e4hOnly(
			receivedControlRed.endpoints.receiver.lifecycle.filter(
				({ event, sequence }) => event === "channel-message" && sequence === receivedControl.lifecycleSequence
			)
		);
		d108e4avExpectCode(
			d108e4avWithEndpoint(receivedControlRed, "receiver", {
				lifecycle: Object.freeze(
					receivedControlRed.endpoints.receiver.lifecycle.filter((record) => record !== receivedControlMessage)
				),
			}),
			"D108E4H_OVERLAP_LEDGER_INVALID",
			"missing matching control message"
		);
		for (const [label, messagePatch] of [
			["wrong-direction control message", Object.freeze({ event: "channel-open-event" as const })],
			["wrong-label control message", Object.freeze({ label: "not-ts-drp" })],
			["control message connection mismatch", Object.freeze({ connectionId: receivedControl.connectionId + 1 })],
			["control message channel mismatch", Object.freeze({ channelId: receivedControl.channelId + 1 })],
		] as const) {
			d108e4avExpectCode(
				d108e4avWithEndpoint(receivedControlRed, "receiver", {
					lifecycle: Object.freeze(
						receivedControlRed.endpoints.receiver.lifecycle.map((record) =>
							record === receivedControlMessage ? Object.freeze({ ...record, ...messagePatch }) : record
						)
					),
				}),
				"D108E4H_OVERLAP_LEDGER_INVALID",
				label
			);
		}
		const duplicateControlLifecycleMessage = d108e4avWithEndpoint(receivedControlRed, "receiver", {
			lifecycle: Object.freeze([
				...receivedControlRed.endpoints.receiver.lifecycle,
				Object.freeze({ ...receivedControlMessage }),
			]),
		});
		d108e4avExpectCode(
			duplicateControlLifecycleMessage,
			"D108E4H_SEQUENCE_INVALID",
			"global lifecycle sequence gate precedes duplicate control-message join"
		);
		const d108e4avRtcRecord = (
			direction: "message" | "send",
			label: string,
			kind: 1 | 2 | 3,
			ordinal: number
		): RtcObservation =>
			Object.freeze({
				attemptId: direction === "send" ? 910_000 + ordinal : undefined,
				atMs: ordinal,
				byteLength: 4,
				channelId: 310 + ordinal,
				connectionId: 410 + ordinal,
				direction,
				insertionReadyState: "open",
				label,
				lifecycleSequence: 510 + ordinal,
				maxRetransmits: 0,
				ordinal,
				ordered: false,
				readyState: "open",
				text: String.fromCharCode(0x44, 0x52, 0x01, kind),
			});
		const captureSend = d108e4avRtcRecord("send", "ts-drp-ephemeral/1", 1, 1);
		const captureMessage = d108e4avRtcRecord("message", "ts-drp-ephemeral/1", 2, 2);
		const captureWrongLabel = d108e4avRtcRecord("send", "not-ts-drp", 3, 3);
		expect(d108e4avControlsFromCapture([captureSend, captureMessage, captureWrongLabel], "send")).toEqual([
			{
				attemptId: captureSend.attemptId,
				bytes: [0x44, 0x52, 0x01, 1],
				channelId: captureSend.channelId,
				connectionId: captureSend.connectionId,
				lifecycleSequence: captureSend.lifecycleSequence,
			},
		]);
		expect(d108e4avControlsFromCapture([captureSend, captureMessage, captureWrongLabel], "message")).toEqual([
			{
				bytes: [0x44, 0x52, 0x01, 2],
				channelId: captureMessage.channelId,
				connectionId: captureMessage.connectionId,
				lifecycleSequence: captureMessage.lifecycleSequence,
			},
		]);
		const retainedCreatorTransient = Object.freeze({ ...D108E4H_RTC_B, channelId: 390, connectionId: 8 });
		const retainedReceiverTransient = Object.freeze({ ...D108E4H_RTC_B, channelId: 382, connectionId: 10 });
		const reconstructedOrdinaryTwo = d108e4avWithEndpoint(
			d108e4avWithEndpoint(noReplacement, "creator", {
				controlReceives: Object.freeze([
					Object.freeze({
						bytes: d108e4avControlBytes(2),
						channelId: retainedCreatorTransient.channelId,
						connectionId: retainedCreatorTransient.connectionId,
						lifecycleSequence: 1_908,
					}),
				]),
				controlSends: Object.freeze([
					Object.freeze({
						attemptId: 778,
						bytes: d108e4avControlBytes(1),
						channelId: retainedCreatorTransient.channelId,
						connectionId: retainedCreatorTransient.connectionId,
						lifecycleSequence: 1_909,
					}),
				]),
				lifecycle: Object.freeze([
					...noReplacement.endpoints.creator.lifecycle,
					d108e4hLifecycle(
						noReplacement.trialId,
						1_908,
						"channel-message",
						retainedCreatorTransient,
						"rtc-datachannel-message-event"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_909,
						"channel-send-attempt",
						retainedCreatorTransient,
						"rtc-datachannel-send",
						{
							attemptId: 778,
						}
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_910,
						"channel-send-success",
						retainedCreatorTransient,
						"rtc-datachannel-send",
						{
							attemptId: 778,
						}
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_911,
						"channel-open-event",
						retainedCreatorTransient,
						"rtc-datachannel-open-event"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_912,
						"channel-close-call",
						retainedCreatorTransient,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_913,
						"channel-close-event",
						retainedCreatorTransient,
						"rtc-datachannel-close-event",
						{ readyState: "closed" }
					),
				]),
			}),
			"receiver",
			{
				controlReceives: Object.freeze([
					Object.freeze({
						bytes: d108e4avControlBytes(1),
						channelId: retainedReceiverTransient.channelId,
						connectionId: retainedReceiverTransient.connectionId,
						lifecycleSequence: 1_169,
					}),
				]),
				controlSends: Object.freeze([
					Object.freeze({
						attemptId: 196,
						bytes: d108e4avControlBytes(3),
						channelId: retainedReceiverTransient.channelId,
						connectionId: retainedReceiverTransient.connectionId,
						lifecycleSequence: 1_170,
					}),
				]),
				lifecycle: Object.freeze([
					...noReplacement.endpoints.receiver.lifecycle,
					d108e4hLifecycle(
						noReplacement.trialId,
						1_168,
						"channel-open-event",
						retainedReceiverTransient,
						"rtc-datachannel-open-event"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_169,
						"channel-message",
						retainedReceiverTransient,
						"rtc-datachannel-message-event"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_170,
						"channel-send-attempt",
						retainedReceiverTransient,
						"rtc-datachannel-send",
						{
							attemptId: 196,
						}
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_171,
						"channel-send-success",
						retainedReceiverTransient,
						"rtc-datachannel-send",
						{
							attemptId: 196,
						}
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_172,
						"channel-close-call",
						retainedReceiverTransient,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_173,
						"channel-close-event",
						retainedReceiverTransient,
						"rtc-datachannel-close-event",
						{ readyState: "closed" }
					),
				]),
			}
		);
		expect(() => validateD108e4hCampaignCustody(reconstructedOrdinaryTwo)).not.toThrow();
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
		const retainedOldRtcBoundary = d108e4aaRetainedOldRtcBoundaryReplay();
		expect({
			creatorAuthenticated: retainedOldRtcBoundary.endpoints.creator.prepare.authenticated,
			creatorDeadlineAuthenticated: retainedOldRtcBoundary.endpoints.creator.deadline.authenticated,
			creatorDeadlineRtc: retainedOldRtcBoundary.endpoints.creator.deadline.rtc,
			creatorDelta: retainedOldRtcBoundary.rawTransportDeltas.creator,
			creatorPrepareRtc: retainedOldRtcBoundary.endpoints.creator.prepare.rtc,
			creatorRawSends: retainedOldRtcBoundary.endpoints.creator.rawSends.length,
			receiverAccepted: retainedOldRtcBoundary.endpoints.receiver.acceptedRaw.length,
			receiverDeadlineRtc: retainedOldRtcBoundary.endpoints.receiver.deadline.rtc,
			receiverDelta: retainedOldRtcBoundary.rawTransportDeltas.receiver,
			receiverPrepareRtc: retainedOldRtcBoundary.endpoints.receiver.prepare.rtc,
		}).toMatchObject({
			creatorAuthenticated: [{ connectionId: "cb7gwl1787965677165", generation: 5 }],
			creatorDeadlineAuthenticated: [{ connectionId: "89buc51787965730711", generation: 7 }],
			creatorDeadlineRtc: [{ channelId: 444, connectionId: 12 }],
			creatorDelta: {
				authenticatedConnectionLosses: 2,
				lastLinkDrop: { after: "replacement", before: "restart", changed: true },
				linkDrops: 1,
			},
			creatorPrepareRtc: [{ channelId: 428, connectionId: 9 }],
			creatorRawSends: SAMPLE_COUNT,
			receiverAccepted: 410,
			receiverDeadlineRtc: [{ channelId: 428, connectionId: 9 }],
			receiverDelta: {
				authenticatedConnectionLosses: 1,
				lastLinkDrop: { after: "restart", before: "restart", changed: false },
				linkDrops: 0,
			},
			receiverPrepareRtc: [{ channelId: 428, connectionId: 9 }],
		});
		expect(() => validateD108e4hCampaignCustody(retainedOldRtcBoundary)).not.toThrow();
		for (const [name, retainedReplay, initiatingPage, incomingPage, incomingAnchorOrder] of [
			[
				"creator drop owner / handler then open",
				d108e4aaRetainedAsymmetricReplay(false, "handler-open"),
				"creator",
				"receiver",
				"handler-open",
			],
			[
				"creator drop owner / open then handler",
				d108e4aaRetainedAsymmetricReplay(false, "open-handler"),
				"creator",
				"receiver",
				"open-handler",
			],
			[
				"receiver drop owner / handler then open",
				d108e4aaRetainedAsymmetricReplay(true, "handler-open"),
				"receiver",
				"creator",
				"handler-open",
			],
			[
				"receiver drop owner / open then handler",
				d108e4aaRetainedAsymmetricReplay(true, "open-handler"),
				"receiver",
				"creator",
				"open-handler",
			],
		] as const) {
			const initiating = retainedReplay.endpoints[initiatingPage];
			const incoming = retainedReplay.endpoints[incomingPage];
			const initiatingDelta = retainedReplay.rawTransportDeltas[initiatingPage];
			const incomingDelta = retainedReplay.rawTransportDeltas[incomingPage];
			expect({
				incomingAccepted: incoming.acceptedRaw.length,
				incomingAuthenticatedLosses: incomingDelta.authenticatedConnectionLosses,
				incomingLastDrop: incomingDelta.lastLinkDrop,
				incomingLinkDrops: incomingDelta.linkDrops,
				initiatingAuthenticatedLosses: initiatingDelta.authenticatedConnectionLosses,
				initiatingLastDrop: initiatingDelta.lastLinkDrop,
				initiatingLinkDrops: initiatingDelta.linkDrops,
				initiatingRawSends: initiating.rawSends.length,
			}).toEqual({
				incomingAccepted: 422,
				incomingAuthenticatedLosses: 1,
				incomingLastDrop: { after: "restart", before: "restart", changed: false },
				incomingLinkDrops: 0,
				initiatingAuthenticatedLosses: 1,
				initiatingLastDrop: { after: "replacement", before: "restart", changed: true },
				initiatingLinkDrops: 1,
				initiatingRawSends: SAMPLE_COUNT,
			});
			expect([
				incoming.prepare.authenticated.length,
				incoming.deadline.authenticated.length,
				incoming.prepare.rtc.length,
				incoming.deadline.rtc.length,
			]).toEqual([1, 1, 1, 1]);
			const incomingBefore = incoming.prepare.rtc[0] as D108e4hRtcIdentity;
			const incomingAfter = incoming.deadline.rtc[0] as D108e4hRtcIdentity;
			const incomingBeforeAuthenticated = incoming.prepare.authenticated[0] as D108e4hAuthenticatedIdentity;
			const incomingAfterAuthenticated = incoming.deadline.authenticated[0] as D108e4hAuthenticatedIdentity;
			const incomingReplacementHandlers = incoming.lifecycle.filter(
				({ channelId, connectionId, event, owner }) =>
					connectionId === incomingAfter.connectionId &&
					channelId === incomingAfter.channelId &&
					event === "channel-message-handler-installed" &&
					owner === "product-unreliable-webrtc"
			);
			const incomingReplacementOpens = incoming.lifecycle.filter(
				({ channelId, connectionId, event, owner }) =>
					connectionId === incomingAfter.connectionId &&
					channelId === incomingAfter.channelId &&
					event === "channel-open-event" &&
					owner === "rtc-datachannel-open-event"
			);
			const incomingOldProductCloseCalls = incoming.lifecycle.filter(
				({ channelId, connectionId, event, owner }) =>
					connectionId === incomingBefore.connectionId &&
					channelId === incomingBefore.channelId &&
					event === "channel-close-call" &&
					owner === "product-unreliable-webrtc"
			);
			expect([
				incomingReplacementHandlers.length,
				incomingReplacementOpens.length,
				incomingOldProductCloseCalls.length,
			]).toEqual([1, 1, 0]);
			const incomingReplacementHandler = incomingReplacementHandlers[0] as D108e4hLifecycleObservation;
			const incomingReplacementOpen = incomingReplacementOpens[0] as D108e4hLifecycleObservation;
			expect(incomingReplacementHandler.sequence < incomingReplacementOpen.sequence).toBe(
				incomingAnchorOrder === "handler-open"
			);
			expect({
				authenticatedConnectionIdAfter: incomingAfterAuthenticated.connectionId,
				authenticatedConnectionIdBefore: incomingBeforeAuthenticated.connectionId,
				authenticatedGenerationAfter: incomingAfterAuthenticated.generation,
				authenticatedGenerationBefore: incomingBeforeAuthenticated.generation,
				authenticatedPeerIdAfter: incomingAfterAuthenticated.peerId,
				authenticatedPeerIdBefore: incomingBeforeAuthenticated.peerId,
				rtcAfter: [incomingAfter.connectionId, incomingAfter.channelId],
				rtcBefore: [incomingBefore.connectionId, incomingBefore.channelId],
				rtcLabelAfter: incomingAfter.label,
				rtcLabelBefore: incomingBefore.label,
				rtcReadyStateAfter: incomingAfter.readyState,
				rtcReadyStateBefore: incomingBefore.readyState,
			}).toEqual({
				authenticatedConnectionIdAfter: "63ccqd1787968823119",
				authenticatedConnectionIdBefore: "63ccqd1787968823119",
				authenticatedGenerationAfter: 3,
				authenticatedGenerationBefore: 3,
				authenticatedPeerIdAfter: initiating.peerId,
				authenticatedPeerIdBefore: initiating.peerId,
				rtcAfter: [5, 379],
				rtcBefore: [3, 348],
				rtcLabelAfter: "ts-drp-ephemeral/1",
				rtcLabelBefore: "ts-drp-ephemeral/1",
				rtcReadyStateAfter: "open",
				rtcReadyStateBefore: "open",
			});
			const initiatingIdentity = d108e4hAssertBoundaryIdentity(initiating, incoming.peerId, true);
			d108e4hAssertAttemptCustody(
				initiating,
				initiatingIdentity.before,
				initiatingIdentity.after,
				true,
				retainedReplay.sampleCount,
				retainedReplay.sampleCount
			);
			d108e4hAssertOverlapCustody(initiating, initiatingIdentity.before, initiatingIdentity.after, true, "replacement");
			d108e4hAssertAttemptCustody(
				incoming,
				incomingBefore,
				incomingAfter,
				false,
				retainedReplay.sampleCount,
				retainedReplay.sampleCount
			);
			d108e4hAssertOverlapCustody(incoming, incomingBefore, incomingAfter, false, undefined);
			expect(() => d108e4hAssertBoundaryIdentity(incoming, initiating.peerId, false)).toThrowError(
				"D108E4H_IDENTITY_JOIN_INVALID"
			);
			expect
				.soft(
					() => validateD108e4hCampaignCustody(retainedReplay),
					`D108E4AA_RED ${name} accepts stable authenticated identity with an incoming RTC advance`
				)
				.not.toThrow();
		}
		const exactOneOwnerControl = d108e4aaRetainedAsymmetricReplay(false, "handler-open");
		expect(() => validateD108e4hCampaignCustody(exactOneOwnerControl)).not.toThrow();
		for (const [name, swapPageOrder] of [
			["creator page retains physical creator", false],
			["receiver page retains physical creator", true],
		] as const) {
			const dualLocalReplacement = d108e4acDualLocalReplacementReplay(swapPageOrder);
			const endpointValues = Object.values(dualLocalReplacement.endpoints);
			const creatorLocal = endpointValues.find(
				({ peerId }) => peerId === "16Uiu2HAmDmbpqXW4sui8F9r1JjViSCVkSuKcL6mBnqCGUb3jNUTc"
			);
			const receiverLocal = endpointValues.find(
				({ peerId }) => peerId === "16Uiu2HAkvi5DUFivZdjNxyLAxR9sATAKBCLSmKN3qoHHzxKwUttJ"
			);
			if (creatorLocal === undefined || receiverLocal === undefined) {
				throw new Error("D108E4AC_DUAL_LOCAL_ENDPOINT_ABSENT");
			}
			expect(dualLocalReplacement.endpoints.creator.peerId).toBe(
				swapPageOrder
					? "16Uiu2HAkvi5DUFivZdjNxyLAxR9sATAKBCLSmKN3qoHHzxKwUttJ"
					: "16Uiu2HAmDmbpqXW4sui8F9r1JjViSCVkSuKcL6mBnqCGUb3jNUTc"
			);
			expect(Object.values(dualLocalReplacement.rawTransportDeltas)).toEqual([
				{
					authenticatedConnectionLosses: 1,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: { after: "replacement", before: "restart", changed: true },
					linkDrops: 1,
				},
				{
					authenticatedConnectionLosses: 1,
					backpressuredDrops: 0,
					handshakeFailures: 0,
					lastLinkDrop: { after: "replacement", before: "restart", changed: true },
					linkDrops: 1,
				},
			]);
			expect(dualLocalReplacement.rawTransportDeltas).toEqual({
				creator: rawTransportDelta(
					dualLocalReplacement.endpoints.creator.prepare.rawTransport,
					dualLocalReplacement.endpoints.creator.deadline.rawTransport
				),
				receiver: rawTransportDelta(
					dualLocalReplacement.endpoints.receiver.prepare.rawTransport,
					dualLocalReplacement.endpoints.receiver.deadline.rawTransport
				),
			});
			expect({
				creatorAccepted: creatorLocal.acceptedRaw.length,
				creatorAuthenticated: creatorLocal.prepare.authenticated.map(({ connectionId, generation }) => [
					connectionId,
					generation,
				]),
				creatorDeadlineAuthenticated: creatorLocal.deadline.authenticated.map(({ connectionId, generation }) => [
					connectionId,
					generation,
				]),
				creatorRtc: [creatorLocal.prepare.rtc, creatorLocal.deadline.rtc].map((identities) =>
					identities.map(({ channelId, connectionId }) => [connectionId, channelId])
				),
				creatorNewSends: creatorLocal.rawSends.filter(
					({ channelId, connectionId }) => connectionId === 7 && channelId === 399
				).length,
				creatorOldSends: creatorLocal.rawSends.filter(
					({ channelId, connectionId }) => connectionId === 5 && channelId === 373
				).length,
				creatorSends: creatorLocal.rawSends.length,
				receiverAccepted: receiverLocal.acceptedRaw.length,
				receiverAuthenticated: receiverLocal.prepare.authenticated.map(({ connectionId, generation }) => [
					connectionId,
					generation,
				]),
				receiverDeadlineAuthenticated: receiverLocal.deadline.authenticated.map(({ connectionId, generation }) => [
					connectionId,
					generation,
				]),
				receiverRtc: [receiverLocal.prepare.rtc, receiverLocal.deadline.rtc].map((identities) =>
					identities.map(({ channelId, connectionId }) => [connectionId, channelId])
				),
				receiverNewAccepted: receiverLocal.acceptedRaw.filter(
					({ channelId, connectionId }) => connectionId === 7 && channelId === 382
				).length,
				receiverOldAccepted: receiverLocal.acceptedRaw.filter(
					({ channelId, connectionId }) => connectionId === 5 && channelId === 369
				).length,
			}).toEqual({
				creatorAccepted: 0,
				creatorAuthenticated: [["2f4n8z1787980768199", 5]],
				creatorDeadlineAuthenticated: [["67j4of1787980800178", 6]],
				creatorRtc: [[[5, 373]], [[7, 399]]],
				creatorNewSends: 93,
				creatorOldSends: 507,
				creatorSends: SAMPLE_COUNT,
				receiverAccepted: 400,
				receiverAuthenticated: [["9i8v0y1787980768201", 5]],
				receiverDeadlineAuthenticated: [["6rktlz1787980796505", 6]],
				receiverRtc: [[[5, 369]], [[7, 382]]],
				receiverNewAccepted: 64,
				receiverOldAccepted: 336,
			});
			expect(
				creatorLocal.lifecycle
					.filter(({ sequence }) => sequence >= 1_653 && sequence <= 1_657)
					.map(({ channelId, connectionId, event, owner, readyState, sequence }) => [
						sequence,
						event,
						owner,
						readyState,
						connectionId,
						channelId,
					])
			).toEqual([
				[1_653, "channel-handler-installed", "rtc-observer-datachannel-handler", "open", 7, 399],
				[1_654, "channel-message-handler-installed", "rtc-observer-or-harness", "open", 7, 399],
				[1_655, "channel-message-handler-installed", "product-unreliable-webrtc", "open", 7, 399],
				[1_656, "channel-close-call", "product-unreliable-webrtc", "closing", 5, 373],
				[1_657, "channel-open-event", "rtc-datachannel-open-event", "open", 7, 399],
			]);
			expect(
				receiverLocal.lifecycle
					.filter(({ sequence }) => (sequence >= 428 && sequence <= 429) || (sequence >= 961 && sequence <= 963))
					.map(({ channelId, connectionId, event, owner, readyState, sequence }) => [
						sequence,
						event,
						owner,
						readyState,
						connectionId,
						channelId,
					])
			).toEqual([
				[428, "channel-handler-installed", "rtc-observer-datachannel-handler", "connecting", 7, 382],
				[429, "channel-message-handler-installed", "rtc-observer-or-harness", "connecting", 7, 382],
				[961, "channel-open-event", "rtc-datachannel-open-event", "open", 7, 382],
				[962, "channel-message-handler-installed", "product-unreliable-webrtc", "open", 7, 382],
				[963, "channel-close-call", "product-unreliable-webrtc", "open", 5, 369],
			]);
			expect(() =>
				d108e4hAssertOverlapCustody(
					creatorLocal,
					d108e4hOnly(creatorLocal.prepare.rtc),
					d108e4hOnly(creatorLocal.deadline.rtc),
					true,
					"replacement"
				)
			).not.toThrow();
			expect(
				() => validateD108e4hCampaignCustody(dualLocalReplacement),
				`D108E4AC_GREEN ${name} accepts exact dual-local replacement ownership`
			).not.toThrow();
		}
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
		const withCreatorBoundedRefusals = (
			fixture: D108e4hValidationInput,
			admittedCount: number,
			refusedCount: number
		): D108e4hValidationInput => {
			const admittedRawSends = Object.freeze(fixture.endpoints.creator.rawSends.slice(0, admittedCount));
			const admittedAttemptIds = new Set(admittedRawSends.map(({ attemptId }) => attemptId));
			const admittedFixture = Object.freeze({
				...fixture,
				endpoints: Object.freeze({
					...fixture.endpoints,
					creator: Object.freeze({
						...fixture.endpoints.creator,
						lifecycle: Object.freeze(
							fixture.endpoints.creator.lifecycle.filter(
								({ attemptId }) => attemptId === undefined || admittedAttemptIds.has(attemptId)
							)
						),
						rawSends: admittedRawSends,
					}),
				}),
			});
			return withCreatorDeadlineTransport(
				admittedFixture,
				Object.freeze({
					...admittedFixture.endpoints.creator.deadline.rawTransport,
					backpressuredDrops: admittedFixture.endpoints.creator.prepare.rawTransport.backpressuredDrops + refusedCount,
					sent: admittedFixture.endpoints.creator.prepare.rawTransport.sent + admittedRawSends.length,
				})
			);
		};
		const withReceiverEndpoint = (
			fixture: D108e4hValidationInput,
			receiver: D108e4hEndpointCustody
		): D108e4hValidationInput =>
			Object.freeze({
				...fixture,
				endpoints: Object.freeze({ ...fixture.endpoints, receiver }),
			});
		const withCreatorEndpoint = (
			fixture: D108e4hValidationInput,
			creator: D108e4hEndpointCustody
		): D108e4hValidationInput =>
			Object.freeze({
				...fixture,
				endpoints: Object.freeze({ ...fixture.endpoints, creator }),
			});
		const d108e4bhDeadlineCandidate = Object.freeze({
			channelId: 3_007,
			connectionId: 307,
			label: "ts-drp-ephemeral/1" as const,
			readyState: "open" as const,
		});
		const d108e4bhSecondDeadlineCandidate = Object.freeze({
			...d108e4bhDeadlineCandidate,
			channelId: 4_009,
			connectionId: 409,
		});
		const d108e4bhPrepareCandidate = Object.freeze({
			...d108e4bhDeadlineCandidate,
			channelId: 5_003,
			connectionId: 503,
		});
		const d108e4bhReceiver = noReplacement.endpoints.receiver;
		const d108e4bhDeadlineCandidateLifecycle = Object.freeze([
			...d108e4bhReceiver.lifecycle,
			d108e4hLifecycle(
				noReplacement.trialId,
				1,
				"channel-message-handler-installed",
				d108e4bhDeadlineCandidate,
				"product-unreliable-webrtc"
			),
			d108e4hLifecycle(
				noReplacement.trialId,
				2,
				"channel-send-attempt",
				d108e4bhDeadlineCandidate,
				"rtc-datachannel-send",
				{ attemptId: 930_001 }
			),
			d108e4hLifecycle(
				noReplacement.trialId,
				3,
				"channel-send-success",
				d108e4bhDeadlineCandidate,
				"rtc-datachannel-send",
				{ attemptId: 930_001 }
			),
			d108e4hLifecycle(
				noReplacement.trialId,
				4,
				"channel-open-event",
				d108e4bhDeadlineCandidate,
				"rtc-datachannel-open-event"
			),
			d108e4hLifecycle(
				noReplacement.trialId,
				5,
				"channel-message",
				d108e4bhDeadlineCandidate,
				"rtc-datachannel-message-event"
			),
			d108e4hLifecycle(
				noReplacement.trialId,
				6,
				"channel-send-attempt",
				d108e4bhDeadlineCandidate,
				"rtc-datachannel-send",
				{ attemptId: 930_004 }
			),
			d108e4hLifecycle(
				noReplacement.trialId,
				7,
				"channel-send-success",
				d108e4bhDeadlineCandidate,
				"rtc-datachannel-send",
				{ attemptId: 930_004 }
			),
		]);
		const d108e4bhDeadlinePending = withReceiverEndpoint(
			noReplacement,
			Object.freeze({
				...d108e4bhReceiver,
				controlReceives: Object.freeze([
					Object.freeze({
						bytes: d108e4avControlBytes(1),
						channelId: d108e4bhDeadlineCandidate.channelId,
						connectionId: d108e4bhDeadlineCandidate.connectionId,
						lifecycleSequence: 5,
					}),
				]),
				controlSends: Object.freeze([
					Object.freeze({
						attemptId: 930_001,
						bytes: d108e4avControlBytes(2),
						channelId: d108e4bhDeadlineCandidate.channelId,
						connectionId: d108e4bhDeadlineCandidate.connectionId,
						lifecycleSequence: 2,
					}),
					Object.freeze({
						attemptId: 930_004,
						bytes: d108e4avControlBytes(2),
						channelId: d108e4bhDeadlineCandidate.channelId,
						connectionId: d108e4bhDeadlineCandidate.connectionId,
						lifecycleSequence: 6,
					}),
				]),
				deadline: Object.freeze({
					...d108e4bhReceiver.deadline,
					rtc: Object.freeze([D108E4H_RTC_A, d108e4bhDeadlineCandidate]),
				}),
				lifecycle: d108e4bhDeadlineCandidateLifecycle,
			})
		);
		const d108e4bhPreparePending = withReceiverEndpoint(
			noReplacement,
			Object.freeze({
				...d108e4bhReceiver,
				prepare: Object.freeze({
					...d108e4bhReceiver.prepare,
					rtc: Object.freeze([D108E4H_RTC_A, d108e4bhPrepareCandidate]),
				}),
			})
		);
		const d108e4bhInitiatorCandidate = Object.freeze({
			...d108e4bhDeadlineCandidate,
			channelId: 6_011,
			connectionId: 601,
		});
		const d108e4bhCreator = noReplacement.endpoints.creator;
		const d108e4bhInitiatorPending = withCreatorEndpoint(
			noReplacement,
			Object.freeze({
				...d108e4bhCreator,
				controlReceives: Object.freeze([
					Object.freeze({
						bytes: d108e4avControlBytes(2),
						channelId: d108e4bhInitiatorCandidate.channelId,
						connectionId: d108e4bhInitiatorCandidate.connectionId,
						lifecycleSequence: 1_204,
					}),
				]),
				controlSends: Object.freeze([
					Object.freeze({
						attemptId: 930_002,
						bytes: d108e4avControlBytes(1),
						channelId: d108e4bhInitiatorCandidate.channelId,
						connectionId: d108e4bhInitiatorCandidate.connectionId,
						lifecycleSequence: 1_202,
					}),
					Object.freeze({
						attemptId: 930_003,
						bytes: d108e4avControlBytes(3),
						channelId: d108e4bhInitiatorCandidate.channelId,
						connectionId: d108e4bhInitiatorCandidate.connectionId,
						lifecycleSequence: 1_205,
					}),
				]),
				deadline: Object.freeze({
					...d108e4bhCreator.deadline,
					rtc: Object.freeze([D108E4H_RTC_A, d108e4bhInitiatorCandidate]),
				}),
				lifecycle: Object.freeze([
					...d108e4bhCreator.lifecycle,
					d108e4hLifecycle(
						noReplacement.trialId,
						1_200,
						"channel-message-handler-installed",
						d108e4bhInitiatorCandidate,
						"product-unreliable-webrtc"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_201,
						"channel-open-event",
						d108e4bhInitiatorCandidate,
						"rtc-datachannel-open-event"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_202,
						"channel-send-attempt",
						d108e4bhInitiatorCandidate,
						"rtc-datachannel-send",
						{ attemptId: 930_002 }
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_203,
						"channel-send-success",
						d108e4bhInitiatorCandidate,
						"rtc-datachannel-send",
						{ attemptId: 930_002 }
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_204,
						"channel-message",
						d108e4bhInitiatorCandidate,
						"rtc-datachannel-message-event"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_205,
						"channel-send-attempt",
						d108e4bhInitiatorCandidate,
						"rtc-datachannel-send",
						{ attemptId: 930_003 }
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						1_206,
						"channel-send-success",
						d108e4bhInitiatorCandidate,
						"rtc-datachannel-send",
						{ attemptId: 930_003 }
					),
				]),
			})
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhDeadlinePending)).not.toThrow();
		expect(() => validateD108e4hCampaignCustody(d108e4bhPreparePending)).not.toThrow();
		expect(() => validateD108e4hCampaignCustody(d108e4bhInitiatorPending)).not.toThrow();

		const d108e4bjPreHandlerLifecycle = Object.freeze(
			d108e4bhDeadlineCandidateLifecycle
				.map((record) => {
					if (
						record.connectionId === d108e4bhDeadlineCandidate.connectionId &&
						record.channelId === d108e4bhDeadlineCandidate.channelId &&
						record.event === "channel-message-handler-installed"
					)
						return Object.freeze({ ...record, sequence: 2 });
					if (record.attemptId === 930_001 && record.event === "channel-send-attempt")
						return Object.freeze({ ...record, sequence: 1 });
					return record;
				})
				.sort((left, right) => left.sequence - right.sequence)
		);
		d108e4avExpectCode(
			withReceiverEndpoint(
				d108e4bhDeadlinePending,
				Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver,
					controlSends: Object.freeze(
						(d108e4bhDeadlinePending.endpoints.receiver.controlSends ?? []).map((record) =>
							record.attemptId === 930_001 ? Object.freeze({ ...record, lifecycleSequence: 1 }) : record
						)
					),
					lifecycle: d108e4bjPreHandlerLifecycle,
				})
			),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj pre-handler control"
		);
		const d108e4bjPreOpenReceiveLifecycle = Object.freeze(
			d108e4bhDeadlineCandidateLifecycle
				.map((record) => {
					if (
						record.connectionId === d108e4bhDeadlineCandidate.connectionId &&
						record.channelId === d108e4bhDeadlineCandidate.channelId &&
						record.event === "channel-open-event"
					)
						return Object.freeze({ ...record, sequence: 5 });
					if (
						record.connectionId === d108e4bhDeadlineCandidate.connectionId &&
						record.channelId === d108e4bhDeadlineCandidate.channelId &&
						record.event === "channel-message"
					)
						return Object.freeze({ ...record, sequence: 4 });
					return record;
				})
				.sort((left, right) => left.sequence - right.sequence)
		);
		d108e4avExpectCode(
			withReceiverEndpoint(
				d108e4bhDeadlinePending,
				Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver,
					controlReceives: Object.freeze(
						(d108e4bhDeadlinePending.endpoints.receiver.controlReceives ?? []).map((record) =>
							Object.freeze({ ...record, lifecycleSequence: 4 })
						)
					),
					lifecycle: d108e4bjPreOpenReceiveLifecycle,
				})
			),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj pre-open received control"
		);
		const d108e4bjWithFirstSendKind = (kind: 1 | 2 | 3): D108e4hValidationInput =>
			withReceiverEndpoint(
				d108e4bhDeadlinePending,
				Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver,
					controlSends: Object.freeze(
						(d108e4bhDeadlinePending.endpoints.receiver.controlSends ?? []).map((record) =>
							record.attemptId === 930_001 ? Object.freeze({ ...record, bytes: d108e4avControlBytes(kind) }) : record
						)
					),
				})
			);
		d108e4avExpectCode(
			d108e4bjWithFirstSendKind(1),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj pre-open non-ACK send"
		);
		d108e4avExpectCode(
			withReceiverLifecycle(
				d108e4bhDeadlinePending,
				Object.freeze(
					d108e4bhDeadlineCandidateLifecycle.map((record) =>
						record.connectionId === d108e4bhDeadlineCandidate.connectionId &&
						record.channelId === d108e4bhDeadlineCandidate.channelId &&
						record.event === "channel-message-handler-installed"
							? Object.freeze({ ...record, readyState: "connecting" as const })
							: record
					)
				)
			),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj pre-open control without open handler state"
		);
		const d108e4bjPostOpenPreReadyLifecycle = Object.freeze(
			d108e4bhDeadlineCandidateLifecycle
				.map((record) => {
					if (
						record.connectionId === d108e4bhDeadlineCandidate.connectionId &&
						record.channelId === d108e4bhDeadlineCandidate.channelId &&
						record.event === "channel-message-handler-installed"
					)
						return Object.freeze({ ...record, readyState: "connecting" as const });
					if (
						record.connectionId === d108e4bhDeadlineCandidate.connectionId &&
						record.channelId === d108e4bhDeadlineCandidate.channelId &&
						record.event === "channel-open-event"
					)
						return Object.freeze({ ...record, sequence: 2 });
					if (record.attemptId === 930_001 && record.event === "channel-send-attempt")
						return Object.freeze({ ...record, sequence: 3 });
					if (record.attemptId === 930_001 && record.event === "channel-send-success")
						return Object.freeze({ ...record, sequence: 4 });
					return record;
				})
				.sort((left, right) => left.sequence - right.sequence)
		);
		d108e4avExpectCode(
			withReceiverEndpoint(
				d108e4bhDeadlinePending,
				Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver,
					controlSends: Object.freeze(
						(d108e4bhDeadlinePending.endpoints.receiver.controlSends ?? []).map((record) =>
							record.attemptId === 930_001 ? Object.freeze({ ...record, lifecycleSequence: 3 }) : record
						)
					),
					lifecycle: d108e4bjPostOpenPreReadyLifecycle,
				})
			),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj post-open pre-READY ACK without open handler state"
		);
		const d108e4bjSecondEagerLifecycle = Object.freeze(
			[
				...d108e4bhDeadlineCandidateLifecycle.map((record) => {
					if (
						record.connectionId === d108e4bhDeadlineCandidate.connectionId &&
						record.channelId === d108e4bhDeadlineCandidate.channelId &&
						record.sequence >= 4
					)
						return Object.freeze({ ...record, sequence: record.sequence + 2 });
					return record;
				}),
				d108e4hLifecycle(
					noReplacement.trialId,
					4,
					"channel-send-attempt",
					d108e4bhDeadlineCandidate,
					"rtc-datachannel-send",
					{ attemptId: 930_005 }
				),
				d108e4hLifecycle(
					noReplacement.trialId,
					5,
					"channel-send-success",
					d108e4bhDeadlineCandidate,
					"rtc-datachannel-send",
					{ attemptId: 930_005 }
				),
			].sort((left, right) => left.sequence - right.sequence)
		);
		d108e4avExpectCode(
			withReceiverEndpoint(
				d108e4bhDeadlinePending,
				Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver,
					controlReceives: Object.freeze(
						(d108e4bhDeadlinePending.endpoints.receiver.controlReceives ?? []).map((record) =>
							Object.freeze({ ...record, lifecycleSequence: record.lifecycleSequence + 2 })
						)
					),
					controlSends: Object.freeze(
						[
							...(d108e4bhDeadlinePending.endpoints.receiver.controlSends ?? []).map((record) =>
								record.lifecycleSequence >= 4
									? Object.freeze({ ...record, lifecycleSequence: record.lifecycleSequence + 2 })
									: record
							),
							Object.freeze({
								attemptId: 930_005,
								bytes: d108e4avControlBytes(2),
								channelId: d108e4bhDeadlineCandidate.channelId,
								connectionId: d108e4bhDeadlineCandidate.connectionId,
								lifecycleSequence: 4,
							}),
						].sort((left, right) => left.lifecycleSequence - right.lifecycleSequence)
					),
					lifecycle: d108e4bjSecondEagerLifecycle,
				})
			),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj second eager ACK"
		);
		d108e4avExpectCode(
			withReceiverEndpoint(
				d108e4bhDeadlinePending,
				Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver,
					controlSends: Object.freeze(
						(d108e4bhDeadlinePending.endpoints.receiver.controlSends ?? []).filter(
							({ attemptId }) => attemptId !== 930_004
						)
					),
					lifecycle: Object.freeze(d108e4bhDeadlineCandidateLifecycle.filter(({ attemptId }) => attemptId !== 930_004)),
				})
			),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj no post-READY ACK"
		);
		for (const [label, kind] of [
			["post-open sent READY", 1],
			["post-open sent COMMIT", 3],
		] as const) {
			d108e4avExpectCode(
				withReceiverEndpoint(
					d108e4bhDeadlinePending,
					Object.freeze({
						...d108e4bhDeadlinePending.endpoints.receiver,
						controlSends: Object.freeze(
							(d108e4bhDeadlinePending.endpoints.receiver.controlSends ?? []).map((record) =>
								record.attemptId === 930_004 ? Object.freeze({ ...record, bytes: d108e4avControlBytes(kind) }) : record
							)
						),
					})
				),
				"D108E4H_LIFECYCLE_ORDER_INVALID",
				`D.108e4bj ${label}`
			);
		}
		d108e4avExpectCode(
			withReceiverEndpoint(
				d108e4bhDeadlinePending,
				Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver,
					controlReceives: Object.freeze(
						(d108e4bhDeadlinePending.endpoints.receiver.controlReceives ?? []).map((record) =>
							Object.freeze({ ...record, bytes: d108e4avControlBytes(2) })
						)
					),
				})
			),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj post-open received ACK"
		);
		const d108e4bjInitiatorPreOpenLifecycle = Object.freeze(
			d108e4bhInitiatorPending.endpoints.creator.lifecycle
				.map((record) => {
					if (
						record.connectionId === d108e4bhInitiatorCandidate.connectionId &&
						record.channelId === d108e4bhInitiatorCandidate.channelId &&
						record.event === "channel-open-event"
					)
						return Object.freeze({ ...record, sequence: 1_203 });
					if (record.attemptId === 930_002 && record.event === "channel-send-attempt")
						return Object.freeze({ ...record, sequence: 1_201 });
					if (record.attemptId === 930_002 && record.event === "channel-send-success")
						return Object.freeze({ ...record, sequence: 1_202 });
					return record;
				})
				.sort((left, right) => left.sequence - right.sequence)
		);
		d108e4avExpectCode(
			withCreatorEndpoint(
				d108e4bhInitiatorPending,
				Object.freeze({
					...d108e4bhInitiatorPending.endpoints.creator,
					controlSends: Object.freeze(
						(d108e4bhInitiatorPending.endpoints.creator.controlSends ?? []).map((record) =>
							record.attemptId === 930_002 ? Object.freeze({ ...record, lifecycleSequence: 1_201 }) : record
						)
					),
					lifecycle: d108e4bjInitiatorPreOpenLifecycle,
				})
			),
			"D108E4H_LIFECYCLE_ORDER_INVALID",
			"D.108e4bj initiator READY before observer open"
		);

		const d108e4bhMissingCommon = withReceiverEndpoint(
			d108e4bhDeadlinePending,
			Object.freeze({
				...d108e4bhDeadlinePending.endpoints.receiver,
				deadline: Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver.deadline,
					rtc: Object.freeze([d108e4bhDeadlineCandidate]),
				}),
			})
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhMissingCommon)).toThrowError("D108E4H_IDENTITY_JOIN_INVALID");
		const d108e4bhDuplicateCommon = withReceiverEndpoint(
			noReplacement,
			Object.freeze({
				...d108e4bhReceiver,
				deadline: Object.freeze({
					...d108e4bhReceiver.deadline,
					rtc: Object.freeze([D108E4H_RTC_A, D108E4H_RTC_A]),
				}),
			})
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhDuplicateCommon)).toThrowError("D108E4H_IDENTITY_JOIN_INVALID");
		const d108e4bhSecondCandidate = withReceiverEndpoint(
			d108e4bhDeadlinePending,
			Object.freeze({
				...d108e4bhDeadlinePending.endpoints.receiver,
				deadline: Object.freeze({
					...d108e4bhDeadlinePending.endpoints.receiver.deadline,
					rtc: Object.freeze([D108E4H_RTC_A, d108e4bhDeadlineCandidate, d108e4bhSecondDeadlineCandidate]),
				}),
			})
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhSecondCandidate)).toThrowError("D108E4H_IDENTITY_JOIN_INVALID");
		const d108e4bhWithoutOpen = withReceiverLifecycle(
			d108e4bhDeadlinePending,
			d108e4bhDeadlineCandidateLifecycle.filter(
				({ channelId, connectionId, event }) =>
					connectionId !== d108e4bhDeadlineCandidate.connectionId ||
					channelId !== d108e4bhDeadlineCandidate.channelId ||
					event !== "channel-open-event"
			)
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhWithoutOpen)).toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		const d108e4bhWithoutHandler = withReceiverLifecycle(
			d108e4bhDeadlinePending,
			d108e4bhDeadlineCandidateLifecycle.filter(
				({ channelId, connectionId, event, owner }) =>
					connectionId !== d108e4bhDeadlineCandidate.connectionId ||
					channelId !== d108e4bhDeadlineCandidate.channelId ||
					event !== "channel-message-handler-installed" ||
					owner !== "product-unreliable-webrtc"
			)
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhWithoutHandler)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const d108e4bhWithoutRolePrefix = withReceiverEndpoint(
			d108e4bhDeadlinePending,
			Object.freeze({
				...d108e4bhDeadlinePending.endpoints.receiver,
				controlReceives: Object.freeze([]),
				controlSends: Object.freeze([]),
				lifecycle: Object.freeze(
					d108e4bhDeadlineCandidateLifecycle.filter(
						({ channelId, connectionId, event }) =>
							connectionId !== d108e4bhDeadlineCandidate.connectionId ||
							channelId !== d108e4bhDeadlineCandidate.channelId ||
							(event !== "channel-send-attempt" && event !== "channel-send-success" && event !== "channel-message")
					)
				),
			})
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhWithoutRolePrefix)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const d108e4bhDeadlineCandidateTail = Math.max(
			...d108e4bhDeadlineCandidateLifecycle.map(({ sequence }) => sequence)
		);
		const d108e4bhTerminalCandidate = withReceiverLifecycle(
			d108e4bhDeadlinePending,
			Object.freeze([
				...d108e4bhDeadlineCandidateLifecycle,
				d108e4hLifecycle(
					noReplacement.trialId,
					d108e4bhDeadlineCandidateTail + 1,
					"channel-close-call",
					d108e4bhDeadlineCandidate,
					"product-unreliable-webrtc"
				),
			])
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhTerminalCandidate)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const d108e4bhAcceptorReceivedCommit = withReceiverEndpoint(
			d108e4bhDeadlinePending,
			Object.freeze({
				...d108e4bhDeadlinePending.endpoints.receiver,
				controlReceives: Object.freeze([
					...(d108e4bhDeadlinePending.endpoints.receiver.controlReceives ?? []),
					Object.freeze({
						bytes: d108e4avControlBytes(1),
						channelId: d108e4bhDeadlineCandidate.channelId,
						connectionId: d108e4bhDeadlineCandidate.connectionId,
						lifecycleSequence: d108e4bhDeadlineCandidateTail + 1,
					}),
					Object.freeze({
						bytes: d108e4avControlBytes(3),
						channelId: d108e4bhDeadlineCandidate.channelId,
						connectionId: d108e4bhDeadlineCandidate.connectionId,
						lifecycleSequence: d108e4bhDeadlineCandidateTail + 2,
					}),
					Object.freeze({
						bytes: d108e4avControlBytes(3),
						channelId: d108e4bhDeadlineCandidate.channelId,
						connectionId: d108e4bhDeadlineCandidate.connectionId,
						lifecycleSequence: d108e4bhDeadlineCandidateTail + 3,
					}),
				]),
				lifecycle: Object.freeze([
					...d108e4bhDeadlineCandidateLifecycle,
					d108e4hLifecycle(
						noReplacement.trialId,
						d108e4bhDeadlineCandidateTail + 1,
						"channel-message",
						d108e4bhDeadlineCandidate,
						"rtc-datachannel-message-event"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						d108e4bhDeadlineCandidateTail + 2,
						"channel-message",
						d108e4bhDeadlineCandidate,
						"rtc-datachannel-message-event"
					),
					d108e4hLifecycle(
						noReplacement.trialId,
						d108e4bhDeadlineCandidateTail + 3,
						"channel-message",
						d108e4bhDeadlineCandidate,
						"rtc-datachannel-message-event"
					),
				]),
			})
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhAcceptorReceivedCommit)).not.toThrow();
		const d108e4bqCommitBeforeQualifyingAck = withReceiverEndpoint(
			d108e4bhAcceptorReceivedCommit,
			Object.freeze({
				...d108e4bhAcceptorReceivedCommit.endpoints.receiver,
				controlSends: Object.freeze(
					(d108e4bhAcceptorReceivedCommit.endpoints.receiver.controlSends ?? []).map((record) =>
						record.attemptId === 930_004 ? Object.freeze({ ...record, lifecycleSequence: 11 }) : record
					)
				),
				lifecycle: Object.freeze(
					d108e4bhAcceptorReceivedCommit.endpoints.receiver.lifecycle
						.map((record) => {
							if (record.attemptId !== 930_004) return record;
							return Object.freeze({
								...record,
								sequence: record.event === "channel-send-attempt" ? 11 : 12,
							});
						})
						.sort((left, right) => left.sequence - right.sequence)
				),
			})
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bqCommitBeforeQualifyingAck)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const d108e4bhCandidateApplicationOwner = withReceiverEndpoint(
			d108e4bhDeadlinePending,
			Object.freeze({
				...d108e4bhDeadlinePending.endpoints.receiver,
				acceptedRaw: Object.freeze([
					Object.freeze({
						...(d108e4bhDeadlinePending.endpoints.receiver.acceptedRaw[0] as D108e4hOverlapObservation),
						channelId: d108e4bhDeadlineCandidate.channelId,
						connectionId: d108e4bhDeadlineCandidate.connectionId,
					}),
				]),
			})
		);
		expect(() => validateD108e4hCampaignCustody(d108e4bhCandidateApplicationOwner)).toThrowError(
			"D108E4H_IDENTITY_JOIN_INVALID"
		);

		const incomingMutationBase = d108e4aaRetainedAsymmetricReplay(false, "handler-open");
		const incomingBefore = incomingMutationBase.endpoints.receiver.prepare.rtc[0] as D108e4hRtcIdentity;
		const incomingAfter = incomingMutationBase.endpoints.receiver.deadline.rtc[0] as D108e4hRtcIdentity;
		const incomingAcceptedAt = (sequence: number): D108e4hValidationInput => {
			const withAcceptedMessage = Object.freeze({
				...incomingMutationBase,
				endpoints: Object.freeze({
					...incomingMutationBase.endpoints,
					receiver: Object.freeze({
						...incomingMutationBase.endpoints.receiver,
						acceptedRaw: Object.freeze([
							...incomingMutationBase.endpoints.receiver.acceptedRaw,
							d108e4hAcceptedRaw(incomingAfter, 422, sequence),
						]),
						lifecycle: Object.freeze(
							[
								...incomingMutationBase.endpoints.receiver.lifecycle,
								d108e4hLifecycle(
									incomingMutationBase.trialId,
									sequence,
									"channel-message",
									incomingAfter,
									"rtc-datachannel-message-event"
								),
							].sort((a, b) => a.sequence - b.sequence)
						),
					}),
				}),
			});
			return withReceiverDeadlineTransport(
				withAcceptedMessage,
				Object.freeze({
					...withAcceptedMessage.endpoints.receiver.deadline.rawTransport,
					received: withAcceptedMessage.endpoints.receiver.deadline.rawTransport.received + 1,
				})
			);
		};
		const incomingAcceptedAfterReadiness = incomingAcceptedAt(1_251);
		expect(() => validateD108e4hCampaignCustody(incomingAcceptedAfterReadiness)).not.toThrow();
		const incomingAcceptedBeforeReadiness = incomingAcceptedAt(1_246);
		expect
			.soft(() => validateD108e4hCampaignCustody(incomingAcceptedBeforeReadiness), "incomingAcceptedBeforeReadiness")
			.toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");

		const incomingTransmitterCreatorBefore = incomingMutationBase.endpoints.creator.prepare
			.rtc[0] as D108e4hRtcIdentity;
		const incomingTransmitterCreatorAfter = incomingMutationBase.endpoints.creator.deadline
			.rtc[0] as D108e4hRtcIdentity;
		const incomingTransmitterReceiverBefore = incomingMutationBase.endpoints.receiver.prepare
			.rtc[0] as D108e4hRtcIdentity;
		const incomingTransmitterReceiverAuthenticated = incomingMutationBase.endpoints.receiver.deadline
			.authenticated[0] as D108e4hAuthenticatedIdentity;
		const finalIncomingTransmitterSend = incomingMutationBase.endpoints.creator.rawSends.find(
			({ sequence }) => sequence === SAMPLE_COUNT - 1
		);
		if (finalIncomingTransmitterSend === undefined) throw new Error("D108E4AA_FINAL_TRANSMITTER_SEND_ABSENT");
		const incomingTransmitterCreatorTransport = Object.freeze({
			...incomingMutationBase.endpoints.creator.deadline.rawTransport,
			authenticatedConnectionLosses:
				incomingMutationBase.endpoints.creator.prepare.rawTransport.authenticatedConnectionLosses,
			lastLinkDrop: incomingMutationBase.endpoints.creator.prepare.rawTransport.lastLinkDrop,
			linkDrops: incomingMutationBase.endpoints.creator.prepare.rawTransport.linkDrops,
		});
		const incomingTransmitterReceiverTransport = Object.freeze({
			...incomingMutationBase.endpoints.receiver.deadline.rawTransport,
			lastLinkDrop: "replacement" as const,
			linkDrops: incomingMutationBase.endpoints.receiver.prepare.rawTransport.linkDrops + 1,
		});
		const incomingTransmitterCreatorLifecycle = Object.freeze(
			incomingMutationBase.endpoints.creator.lifecycle
				.filter(
					({ channelId, connectionId, event }) =>
						!(
							(event === "channel-close-call" || event === "channel-close-event") &&
							connectionId === incomingTransmitterCreatorBefore.connectionId &&
							channelId === incomingTransmitterCreatorBefore.channelId
						)
				)
				.map((record) => {
					if (record.attemptId !== finalIncomingTransmitterSend.attemptId) return record;
					return d108e4hLifecycle(
						incomingMutationBase.trialId,
						record.event === "channel-send-attempt" ? 2_034 : 2_035,
						record.event,
						incomingTransmitterCreatorAfter,
						record.owner,
						{ attemptId: record.attemptId }
					);
				})
				.sort((a, b) => a.sequence - b.sequence)
		);
		const incomingTransmitter = Object.freeze({
			...incomingMutationBase,
			endpoints: Object.freeze({
				creator: Object.freeze({
					...incomingMutationBase.endpoints.creator,
					deadline: Object.freeze({
						...incomingMutationBase.endpoints.creator.deadline,
						authenticated: incomingMutationBase.endpoints.creator.prepare.authenticated,
						rawTransport: incomingTransmitterCreatorTransport,
					}),
					lifecycle: incomingTransmitterCreatorLifecycle,
					rawSends: Object.freeze(
						incomingMutationBase.endpoints.creator.rawSends.map((send) =>
							send === finalIncomingTransmitterSend
								? Object.freeze({
										...send,
										channelId: incomingTransmitterCreatorAfter.channelId,
										connectionId: incomingTransmitterCreatorAfter.connectionId,
									})
								: send
						)
					),
				}),
				receiver: Object.freeze({
					...incomingMutationBase.endpoints.receiver,
					deadline: Object.freeze({
						...incomingMutationBase.endpoints.receiver.deadline,
						authenticated: Object.freeze([
							Object.freeze({
								...incomingTransmitterReceiverAuthenticated,
								connectionId: "d108e4aa-receiver-replacement",
								generation: (incomingMutationBase.endpoints.receiver.prepare.authenticated[0]?.generation ?? 0) + 1,
							}),
						]),
						rawTransport: incomingTransmitterReceiverTransport,
					}),
					lifecycle: Object.freeze([
						...incomingMutationBase.endpoints.receiver.lifecycle,
						d108e4hLifecycle(
							incomingMutationBase.trialId,
							1_251,
							"channel-close-call",
							incomingTransmitterReceiverBefore,
							"product-unreliable-webrtc"
						),
					]),
				}),
			}),
			rawTransportDeltas: Object.freeze({
				creator: rawTransportDelta(
					incomingMutationBase.endpoints.creator.prepare.rawTransport,
					incomingTransmitterCreatorTransport
				),
				receiver: rawTransportDelta(
					incomingMutationBase.endpoints.receiver.prepare.rawTransport,
					incomingTransmitterReceiverTransport
				),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(incomingTransmitter)).not.toThrow();
		const incomingTransmitterAttemptBeforeReadiness = Object.freeze({
			...incomingTransmitter,
			endpoints: Object.freeze({
				...incomingTransmitter.endpoints,
				creator: Object.freeze({
					...incomingTransmitter.endpoints.creator,
					lifecycle: Object.freeze(
						incomingTransmitter.endpoints.creator.lifecycle
							.map((record) =>
								record.attemptId === finalIncomingTransmitterSend.attemptId && record.event === "channel-send-attempt"
									? Object.freeze({ ...record, sequence: 2_031 })
									: record
							)
							.sort((a, b) => a.sequence - b.sequence)
					),
				}),
			}),
		});
		expect
			.soft(
				() => validateD108e4hCampaignCustody(incomingTransmitterAttemptBeforeReadiness),
				"incomingTransmitterAttemptBeforeReadiness"
			)
			.toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		const incomingRtcWithoutProductHandler = withReceiverLifecycle(
			incomingMutationBase,
			incomingMutationBase.endpoints.receiver.lifecycle.filter(
				({ channelId, connectionId, event, owner }) =>
					!(
						connectionId === incomingAfter.connectionId &&
						channelId === incomingAfter.channelId &&
						event === "channel-message-handler-installed" &&
						owner === "product-unreliable-webrtc"
					)
			)
		);
		const incomingRtcWithoutOpen = withReceiverLifecycle(
			incomingMutationBase,
			incomingMutationBase.endpoints.receiver.lifecycle.filter(
				({ channelId, connectionId, event, owner }) =>
					!(
						connectionId === incomingAfter.connectionId &&
						channelId === incomingAfter.channelId &&
						event === "channel-open-event" &&
						owner === "rtc-datachannel-open-event"
					)
			)
		);
		for (const [name, fixture] of [
			["incomingRtcWithoutProductHandler", incomingRtcWithoutProductHandler],
			["incomingRtcWithoutOpen", incomingRtcWithoutOpen],
		] as const) {
			expect.soft(() => validateD108e4hCampaignCustody(fixture), name).toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		}
		const missingInitiatorReplacementDrop = withCreatorDeadlineTransport(
			incomingMutationBase,
			Object.freeze({
				...incomingMutationBase.endpoints.creator.deadline.rawTransport,
				lastLinkDrop: incomingMutationBase.endpoints.creator.prepare.rawTransport.lastLinkDrop,
				linkDrops: incomingMutationBase.endpoints.creator.prepare.rawTransport.linkDrops,
			})
		);
		expect
			.soft(() => validateD108e4hCampaignCustody(missingInitiatorReplacementDrop), "missingInitiatorReplacementDrop")
			.toThrowError("D108E4H_IDENTITY_JOIN_INVALID");
		const ambiguousDoubleReplacementDrop = withCreatorDeadlineTransport(
			creatorReplacement,
			Object.freeze({
				...creatorReplacement.endpoints.creator.deadline.rawTransport,
				lastLinkDrop: "replacement",
				linkDrops: creatorReplacement.endpoints.creator.prepare.rawTransport.linkDrops + 2,
			})
		);
		expect
			.soft(() => validateD108e4hCampaignCustody(ambiguousDoubleReplacementDrop), "ambiguousDoubleReplacementDrop")
			.toThrowError("D108E4H_DROP_COUNT_AMBIGUOUS");
		const incomingAuthenticated = incomingMutationBase.endpoints.receiver.deadline
			.authenticated[0] as D108e4hAuthenticatedIdentity;
		const nonInitiatorAuthenticatedIdentityDrift = Object.freeze({
			...incomingMutationBase,
			endpoints: Object.freeze({
				...incomingMutationBase.endpoints,
				receiver: Object.freeze({
					...incomingMutationBase.endpoints.receiver,
					deadline: Object.freeze({
						...incomingMutationBase.endpoints.receiver.deadline,
						authenticated: Object.freeze([
							Object.freeze({
								...incomingAuthenticated,
								connectionId: `${incomingAuthenticated.connectionId}:drift`,
								generation: incomingAuthenticated.generation + 1,
							}),
						]),
					}),
				}),
			}),
		});
		expect
			.soft(
				() => validateD108e4hCampaignCustody(nonInitiatorAuthenticatedIdentityDrift),
				"nonInitiatorAuthenticatedIdentityDrift"
			)
			.toThrowError("D108E4H_IDENTITY_JOIN_INVALID");
		const nonInitiatorProductOldCloseCall = withReceiverLifecycle(
			incomingMutationBase,
			Object.freeze([
				...incomingMutationBase.endpoints.receiver.lifecycle,
				d108e4hLifecycle(
					incomingMutationBase.trialId,
					1_251,
					"channel-close-call",
					incomingBefore,
					"product-unreliable-webrtc"
				),
			])
		);
		expect
			.soft(() => validateD108e4hCampaignCustody(nonInitiatorProductOldCloseCall), "nonInitiatorProductOldCloseCall")
			.toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		const initiatingOpen = incomingMutationBase.endpoints.creator.lifecycle.find(
			({ channelId, connectionId, event }) => connectionId === 5 && channelId === 367 && event === "channel-open-event"
		);
		const initiatingCloseCall = incomingMutationBase.endpoints.creator.lifecycle.find(
			({ channelId, connectionId, event, owner }) =>
				connectionId === 3 &&
				channelId === 346 &&
				event === "channel-close-call" &&
				owner === "product-unreliable-webrtc"
		);
		if (initiatingOpen === undefined || initiatingCloseCall === undefined) {
			throw new Error("D108E4AA_INITIATING_ANCHOR_ABSENT");
		}
		const initiatorOldCloseBeforeReplacementOpen = withCreatorLifecycle(
			incomingMutationBase,
			Object.freeze(
				incomingMutationBase.endpoints.creator.lifecycle
					.map((record) =>
						record === initiatingOpen
							? Object.freeze({ ...record, sequence: initiatingCloseCall.sequence })
							: record === initiatingCloseCall
								? Object.freeze({ ...record, sequence: initiatingOpen.sequence })
								: record
					)
					.sort((a, b) => a.sequence - b.sequence)
			)
		);
		expect
			.soft(
				() => validateD108e4hCampaignCustody(initiatorOldCloseBeforeReplacementOpen),
				"initiatorOldCloseBeforeReplacementOpen"
			)
			.toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");
		const finalIncomingMessage = incomingMutationBase.endpoints.receiver.lifecycle.find(
			({ event, sequence }) => event === "channel-message" && sequence === 421
		);
		if (finalIncomingMessage === undefined) throw new Error("D108E4AA_FINAL_INCOMING_MESSAGE_ABSENT");
		const failedIncomingReplacementDisplacesUsableOldChannel = Object.freeze({
			...incomingMutationBase,
			endpoints: Object.freeze({
				...incomingMutationBase.endpoints,
				receiver: Object.freeze({
					...incomingMutationBase.endpoints.receiver,
					acceptedRaw: Object.freeze(
						incomingMutationBase.endpoints.receiver.acceptedRaw.map((record) =>
							record.lifecycleSequence === finalIncomingMessage.sequence
								? Object.freeze({ ...record, lifecycleSequence: 1_252 })
								: record
						)
					),
					lifecycle: Object.freeze(
						incomingMutationBase.endpoints.receiver.lifecycle
							.map((record) =>
								record === finalIncomingMessage ? Object.freeze({ ...record, sequence: 1_252 }) : record
							)
							.sort((a, b) => a.sequence - b.sequence)
					),
				}),
			}),
		});
		expect
			.soft(
				() => validateD108e4hCampaignCustody(failedIncomingReplacementDisplacesUsableOldChannel),
				"failedIncomingReplacementDisplacesUsableOldChannel"
			)
			.toThrowError("D108E4H_LIFECYCLE_ORDER_INVALID");

		const dualLocalMutationBase = d108e4acDualLocalReplacementReplay(false);
		const dualCreator = dualLocalMutationBase.endpoints.creator;
		const dualReceiver = dualLocalMutationBase.endpoints.receiver;
		const dualCreatorAfter = d108e4hOnly(dualCreator.deadline.rtc);
		const dualReceiverAfter = d108e4hOnly(dualReceiver.deadline.rtc);
		const withDualCreatorDeadline = (
			fixture: D108e4hValidationInput,
			deadline: D108e4hBoundaryCustody
		): D108e4hValidationInput =>
			Object.freeze({
				...fixture,
				endpoints: Object.freeze({
					...fixture.endpoints,
					creator: Object.freeze({ ...fixture.endpoints.creator, deadline }),
				}),
			});
		const dualLocalWithoutAuthenticatedAdvance = withDualCreatorDeadline(
			dualLocalMutationBase,
			Object.freeze({ ...dualCreator.deadline, authenticated: dualCreator.prepare.authenticated })
		);

		const zeroOwnerCreatorTransport = Object.freeze({
			...dualCreator.deadline.rawTransport,
			authenticatedConnectionLosses: dualCreator.prepare.rawTransport.authenticatedConnectionLosses,
			lastLinkDrop: dualCreator.prepare.rawTransport.lastLinkDrop,
			linkDrops: dualCreator.prepare.rawTransport.linkDrops,
		});
		const zeroOwnerReceiverTransport = Object.freeze({
			...dualReceiver.deadline.rawTransport,
			authenticatedConnectionLosses: dualReceiver.prepare.rawTransport.authenticatedConnectionLosses,
			lastLinkDrop: dualReceiver.prepare.rawTransport.lastLinkDrop,
			linkDrops: dualReceiver.prepare.rawTransport.linkDrops,
		});
		const zeroOwnerStableAuthenticated = Object.freeze({
			...dualLocalMutationBase,
			endpoints: Object.freeze({
				creator: Object.freeze({
					...dualCreator,
					deadline: Object.freeze({ ...dualCreator.deadline, authenticated: dualCreator.prepare.authenticated }),
				}),
				receiver: Object.freeze({
					...dualReceiver,
					deadline: Object.freeze({ ...dualReceiver.deadline, authenticated: dualReceiver.prepare.authenticated }),
				}),
			}),
		});
		const zeroOwnerRtcAdvance = withReceiverDeadlineTransport(
			withCreatorDeadlineTransport(zeroOwnerStableAuthenticated, zeroOwnerCreatorTransport),
			zeroOwnerReceiverTransport
		);
		expect({
			creatorAuthenticated: zeroOwnerRtcAdvance.endpoints.creator.deadline.authenticated,
			creatorRtc: zeroOwnerRtcAdvance.endpoints.creator.deadline.rtc,
			receiverAuthenticated: zeroOwnerRtcAdvance.endpoints.receiver.deadline.authenticated,
			receiverRtc: zeroOwnerRtcAdvance.endpoints.receiver.deadline.rtc,
		}).toEqual({
			creatorAuthenticated: dualCreator.prepare.authenticated,
			creatorRtc: dualCreator.deadline.rtc,
			receiverAuthenticated: dualReceiver.prepare.authenticated,
			receiverRtc: dualReceiver.deadline.rtc,
		});

		const dualLocalUnsupportedReason = withCreatorDeadlineTransport(
			dualLocalMutationBase,
			Object.freeze({ ...dualCreator.deadline.rawTransport, lastLinkDrop: "restart" })
		);

		const dualLocalMissingSelectedIdentity = withDualCreatorDeadline(
			dualLocalMutationBase,
			Object.freeze({ ...dualCreator.deadline, rtc: Object.freeze([]) })
		);
		const dualLocalDuplicateSelectedIdentity = withDualCreatorDeadline(
			dualLocalMutationBase,
			Object.freeze({ ...dualCreator.deadline, rtc: Object.freeze([dualCreatorAfter, dualCreatorAfter]) })
		);

		const isDualCreatorOpen = ({ channelId, connectionId, event, owner }: D108e4hLifecycleObservation): boolean =>
			connectionId === dualCreatorAfter.connectionId &&
			channelId === dualCreatorAfter.channelId &&
			event === "channel-open-event" &&
			owner === "rtc-datachannel-open-event";
		const isDualCreatorProductHandler = ({
			channelId,
			connectionId,
			event,
			owner,
		}: D108e4hLifecycleObservation): boolean =>
			connectionId === dualCreatorAfter.connectionId &&
			channelId === dualCreatorAfter.channelId &&
			event === "channel-message-handler-installed" &&
			owner === "product-unreliable-webrtc";
		const isDualReceiverOpen = ({ channelId, connectionId, event, owner }: D108e4hLifecycleObservation): boolean =>
			connectionId === dualReceiverAfter.connectionId &&
			channelId === dualReceiverAfter.channelId &&
			event === "channel-open-event" &&
			owner === "rtc-datachannel-open-event";
		const dualLocalMissingOpen = withCreatorLifecycle(
			dualLocalMutationBase,
			dualCreator.lifecycle.filter((record) => !isDualCreatorOpen(record))
		);
		const dualLocalDuplicateOpen = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				[
					...dualCreator.lifecycle,
					d108e4hLifecycle(
						dualLocalMutationBase.trialId,
						1_652,
						"channel-open-event",
						dualCreatorAfter,
						"rtc-datachannel-open-event"
					),
				].sort((a, b) => a.sequence - b.sequence)
			)
		);
		const dualLocalMissingProductHandler = withCreatorLifecycle(
			dualLocalMutationBase,
			dualCreator.lifecycle.filter((record) => !isDualCreatorProductHandler(record))
		);
		const dualLocalReceiverMissingOpen = withReceiverLifecycle(
			dualLocalMutationBase,
			dualReceiver.lifecycle.filter((record) => !isDualReceiverOpen(record))
		);
		const dualLocalWrongOldCloseIdentity = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				dualCreator.lifecycle.map((record) =>
					record.sequence === 1_656 &&
					record.event === "channel-close-call" &&
					record.owner === "product-unreliable-webrtc"
						? Object.freeze({
								...record,
								channelId: dualCreatorAfter.channelId,
								connectionId: dualCreatorAfter.connectionId,
							})
						: record
				)
			)
		);
		const dualLocalReadinessNotOpen = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				dualCreator.lifecycle.map((record) =>
					record.sequence === 1_653 && record.event === "channel-handler-installed"
						? Object.freeze({ ...record, readyState: "connecting" as const })
						: record
				)
			)
		);
		const dualLocalReadinessWrongOwner = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				dualCreator.lifecycle.map((record) =>
					record.sequence === 1_653 && record.event === "channel-handler-installed"
						? Object.freeze({ ...record, owner: "rtc-observer-or-harness" as const })
						: record
				)
			)
		);
		const dualLocalDuplicateReadiness = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				[
					...dualCreator.lifecycle,
					d108e4hLifecycle(
						dualLocalMutationBase.trialId,
						1_652,
						"channel-handler-installed",
						dualCreatorAfter,
						"rtc-observer-datachannel-handler"
					),
				].sort((a, b) => a.sequence - b.sequence)
			)
		);
		const dualLocalCloseBeforeReadiness = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				dualCreator.lifecycle
					.map((record) => {
						if (record.sequence === 1_653 && record.event === "channel-handler-installed") {
							return Object.freeze({ ...record, sequence: 1_658 });
						}
						return record.sequence >= 1_658 ? Object.freeze({ ...record, sequence: record.sequence + 1 }) : record;
					})
					.sort((a, b) => a.sequence - b.sequence)
			)
		);
		const dualLocalNewIdentityCloseBeforeOldClose = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				[
					...dualCreator.lifecycle,
					d108e4hLifecycle(
						dualLocalMutationBase.trialId,
						1_652,
						"channel-close-call",
						dualCreatorAfter,
						"product-unreliable-webrtc"
					),
				].sort((a, b) => a.sequence - b.sequence)
			)
		);
		const dualLocalProductHandlerAfterOldClose = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				dualCreator.lifecycle
					.map((record) => {
						if (record.sequence === 1_655 && isDualCreatorProductHandler(record)) {
							return Object.freeze({ ...record, sequence: 1_657 });
						}
						if (record.sequence === 1_657 && isDualCreatorOpen(record)) {
							return Object.freeze({ ...record, sequence: 1_655 });
						}
						return record;
					})
					.sort((a, b) => a.sequence - b.sequence)
			)
		);

		const failedReplacementCandidate = Object.freeze({
			channelId: 444,
			connectionId: 9,
			label: "ts-drp-ephemeral/1" as const,
			readyState: "open" as const,
		});
		const dualLocalFailedReplacementDisplacement = withDualCreatorDeadline(
			dualLocalMutationBase,
			Object.freeze({ ...dualCreator.deadline, rtc: Object.freeze([failedReplacementCandidate]) })
		);

		const dualCreatorDeadlineAuthenticated = d108e4hOnly(dualCreator.deadline.authenticated);
		const dualLocalBoundaryPeerMismatch = withDualCreatorDeadline(
			dualLocalMutationBase,
			Object.freeze({
				...dualCreator.deadline,
				authenticated: Object.freeze([
					Object.freeze({
						...dualCreatorDeadlineAuthenticated,
						peerId: `${dualCreatorDeadlineAuthenticated.peerId}:mismatch`,
					}),
				]),
			})
		);

		const dualLocalLifecycleTrialMismatch = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				dualCreator.lifecycle.map((record) =>
					record.sequence === 1_653 ? Object.freeze({ ...record, trialId: `${record.trialId}:mismatch` }) : record
				)
			)
		);
		const dualLocalMutantRoster = Object.freeze([
			["dualLocalWithoutAuthenticatedAdvance", dualLocalWithoutAuthenticatedAdvance, "D108E4H_IDENTITY_JOIN_INVALID"],
			["zeroOwnerRtcAdvance", zeroOwnerRtcAdvance, "D108E4H_IDENTITY_JOIN_INVALID"],
			["dualLocalUnsupportedReason", dualLocalUnsupportedReason, "D108E4H_DROP_REASON_UNSUPPORTED"],
			["dualLocalMissingSelectedIdentity", dualLocalMissingSelectedIdentity, "D108E4H_IDENTITY_JOIN_INVALID"],
			["dualLocalDuplicateSelectedIdentity", dualLocalDuplicateSelectedIdentity, "D108E4H_IDENTITY_JOIN_INVALID"],
			["dualLocalMissingOpen", dualLocalMissingOpen, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["dualLocalDuplicateOpen", dualLocalDuplicateOpen, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["dualLocalMissingProductHandler", dualLocalMissingProductHandler, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["dualLocalReceiverMissingOpen", dualLocalReceiverMissingOpen, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["dualLocalWrongOldCloseIdentity", dualLocalWrongOldCloseIdentity, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["dualLocalReadinessNotOpen", dualLocalReadinessNotOpen, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["dualLocalReadinessWrongOwner", dualLocalReadinessWrongOwner, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["dualLocalDuplicateReadiness", dualLocalDuplicateReadiness, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["dualLocalCloseBeforeReadiness", dualLocalCloseBeforeReadiness, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			[
				"dualLocalNewIdentityCloseBeforeOldClose",
				dualLocalNewIdentityCloseBeforeOldClose,
				"D108E4H_LIFECYCLE_ORDER_INVALID",
			],
			["dualLocalProductHandlerAfterOldClose", dualLocalProductHandlerAfterOldClose, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			[
				"dualLocalFailedReplacementDisplacement",
				dualLocalFailedReplacementDisplacement,
				"D108E4H_LIFECYCLE_ORDER_INVALID",
			],
			["dualLocalBoundaryPeerMismatch", dualLocalBoundaryPeerMismatch, "D108E4H_IDENTITY_JOIN_INVALID"],
			["dualLocalLifecycleTrialMismatch", dualLocalLifecycleTrialMismatch, "D108E4H_TRIAL_MISMATCH"],
		] as const);
		for (const [name, fixture, expectedError] of dualLocalMutantRoster) {
			expect.soft(() => validateD108e4hCampaignCustody(fixture), name).toThrowError(expectedError);
		}

		const d108e4aeRepeatRecord = (
			sequence: number,
			identity: D108e4hRtcIdentity,
			overrides: Readonly<
				Partial<Pick<D108e4hLifecycleObservation, "owner" | "readyState" | "trialId">>
			> = Object.freeze({})
		): D108e4hLifecycleObservation =>
			Object.freeze({
				...d108e4hLifecycle(
					dualLocalMutationBase.trialId,
					sequence,
					"channel-open-event",
					identity,
					"rtc-datachannel-open-event"
				),
				event: "channel-open-repeat-event",
				owner: "rtc-datachannel-open-repeat-event",
				...overrides,
			});
		const withReceiverRepeatRecords = (...records: readonly D108e4hLifecycleObservation[]): D108e4hValidationInput =>
			withReceiverLifecycle(
				dualLocalMutationBase,
				Object.freeze([...dualReceiver.lifecycle, ...records].sort((left, right) => left.sequence - right.sequence))
			);
		const receiverOpenAnchors = dualReceiver.lifecycle.filter(
			({ channelId, connectionId, event }) =>
				connectionId === dualReceiverAfter.connectionId &&
				channelId === dualReceiverAfter.channelId &&
				event === "channel-open-event"
		);
		if (
			receiverOpenAnchors.length !== 1 ||
			receiverOpenAnchors[0]?.sequence !== 961 ||
			dualReceiver.lifecycle.some(({ sequence }) => sequence === 940 || sequence === 964 || sequence === 965)
		) {
			throw new Error("D108E4AE_RECEIVER_REPEAT_BASE_INVALID");
		}
		const receiverRepeat = d108e4aeRepeatRecord(964, dualReceiverAfter);
		const greenShapedReceiverRepeat = withReceiverRepeatRecords(receiverRepeat);
		expect(() => validateD108e4hCampaignCustody(greenShapedReceiverRepeat)).not.toThrow();

		const finalTransmittingLifecycle = dualCreator.lifecycle.at(-1);
		if (finalTransmittingLifecycle?.sequence !== 1_843) {
			throw new Error("D108E4AE_TRANSMITTING_REPEAT_BASE_INVALID");
		}
		const transmittingRepeat = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze([...dualCreator.lifecycle, d108e4aeRepeatRecord(1_844, dualCreatorAfter)])
		);
		expect(() => validateD108e4hCampaignCustody(transmittingRepeat)).not.toThrow();

		const repeatBeforeAnchor = withReceiverRepeatRecords(d108e4aeRepeatRecord(940, dualReceiverAfter));
		const transmittingRepeatBeforeAnchor = withCreatorLifecycle(
			dualLocalMutationBase,
			Object.freeze(
				[...dualCreator.lifecycle, d108e4aeRepeatRecord(1_652, dualCreatorAfter)].sort(
					(left, right) => left.sequence - right.sequence
				)
			)
		);
		const repeatWrongOwner = withReceiverRepeatRecords(
			d108e4aeRepeatRecord(964, dualReceiverAfter, { owner: "rtc-datachannel-open-event" })
		);
		const repeatNonOpenState = withReceiverRepeatRecords(
			d108e4aeRepeatRecord(964, dualReceiverAfter, { readyState: "connecting" })
		);
		const unmatchedRepeatIdentity = Object.freeze({
			...dualReceiverAfter,
			channelId: dualReceiverAfter.channelId + 10_000,
		});
		const repeatUnmatchedIdentity = withReceiverRepeatRecords(d108e4aeRepeatRecord(964, unmatchedRepeatIdentity));
		const repeatWrongTrial = withReceiverRepeatRecords(
			d108e4aeRepeatRecord(964, dualReceiverAfter, { trialId: `${dualLocalMutationBase.trialId}:mismatch` })
		);
		const selectedIdentityClose = d108e4hLifecycle(
			dualLocalMutationBase.trialId,
			964,
			"channel-close-event",
			dualReceiverAfter,
			"rtc-datachannel-close-event",
			{ readyState: "closed" }
		);
		const selectedIdentityCloseOnly = withReceiverRepeatRecords(selectedIdentityClose);
		expect(() => validateD108e4hCampaignCustody(selectedIdentityCloseOnly)).not.toThrow();
		const repeatAfterSelectedIdentityClose = withReceiverRepeatRecords(
			selectedIdentityClose,
			d108e4aeRepeatRecord(965, dualReceiverAfter)
		);
		const dualReceiverBefore = d108e4hOnly(dualReceiver.prepare.rtc);
		const repeatWithoutTrialAnchor = withReceiverRepeatRecords(d108e4aeRepeatRecord(940, dualReceiverBefore));
		const repeatCardinalityTwo = withReceiverRepeatRecords(
			d108e4aeRepeatRecord(964, dualReceiverAfter),
			d108e4aeRepeatRecord(965, dualReceiverAfter)
		);
		const noReplacementReceiver = noReplacement.endpoints.receiver;
		const noReplacementReceiverIdentity = d108e4hOnly(noReplacementReceiver.deadline.rtc);
		const nonReplacementRepeatWithoutAnchor = withReceiverLifecycle(
			noReplacement,
			Object.freeze([
				...noReplacementReceiver.lifecycle,
				d108e4aeRepeatRecord(1, noReplacementReceiverIdentity, { trialId: noReplacement.trialId }),
			])
		);
		const repeatRedRoster = Object.freeze([
			["repeatBeforeAnchor", repeatBeforeAnchor, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["transmittingRepeatBeforeAnchor", transmittingRepeatBeforeAnchor, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["repeatWrongOwner", repeatWrongOwner, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["repeatNonOpenState", repeatNonOpenState, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["repeatUnmatchedIdentity", repeatUnmatchedIdentity, "D108E4H_IDENTITY_JOIN_INVALID"],
			["repeatAfterSelectedIdentityClose", repeatAfterSelectedIdentityClose, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["repeatWithoutTrialAnchor", repeatWithoutTrialAnchor, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["repeatCardinalityTwo", repeatCardinalityTwo, "D108E4H_LIFECYCLE_ORDER_INVALID"],
			["nonReplacementRepeatWithoutAnchor", nonReplacementRepeatWithoutAnchor, "D108E4H_LIFECYCLE_ORDER_INVALID"],
		] as const);
		for (const [name, fixture, expectedError] of repeatRedRoster) {
			expect.soft(() => validateD108e4hCampaignCustody(fixture), `D108E4AE_RED ${name}`).toThrowError(expectedError);
		}
		expect(() => validateD108e4hCampaignCustody(repeatWrongTrial)).toThrowError("D108E4H_TRIAL_MISMATCH");

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
		const receiverChannelCloseWithoutBDelivery = receiverDirectionalFixture(receiverChannelClose, {
			removeBDelivery: true,
		});
		for (const [name, fixture] of [
			["replacement/transmitter without deadline close-event", creatorReplacementWithoutCloseEvent],
			["replacement/nontransmitter without deadline close-event", receiverReplacementWithoutCloseEvent],
			["replacement/nontransmitter without B delivery", receiverReplacementWithoutBDelivery],
			["channel-close/nontransmitter without B delivery", receiverChannelCloseWithoutBDelivery],
		] as const) {
			expect.soft(() => validateD108e4hCampaignCustody(fixture), `D108E4I_RED ${name}`).not.toThrow();
		}
		const channelCloseWithoutProductCall = withReceiverLifecycle(
			receiverChannelClose,
			receiverChannelClose.endpoints.receiver.lifecycle.filter(
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

		const receiverChannelCloseHandler = receiverChannelClose.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-message-handler-installed" &&
				connectionId === D108E4H_RTC_B.connectionId &&
				channelId === D108E4H_RTC_B.channelId
		);
		const receiverChannelCloseOpen = receiverChannelClose.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-open-event" &&
				connectionId === D108E4H_RTC_B.connectionId &&
				channelId === D108E4H_RTC_B.channelId
		);
		const receiverChannelCloseFirstB = receiverChannelClose.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-message" &&
				connectionId === D108E4H_RTC_B.connectionId &&
				channelId === D108E4H_RTC_B.channelId
		);
		const receiverChannelCloseAcceptedA = receiverChannelClose.endpoints.receiver.lifecycle.find(
			({ channelId, connectionId, event }) =>
				event === "channel-message" &&
				connectionId === D108E4H_RTC_A.connectionId &&
				channelId === D108E4H_RTC_A.channelId
		);
		const receiverChannelCloseEvent = receiverChannelClose.endpoints.receiver.lifecycle.find(
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
			receiverChannelClose,
			Object.freeze(
				receiverChannelClose.endpoints.receiver.lifecycle
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

		const postCloseAcceptedA = receiverChannelClose.endpoints.receiver.rejectedRaw[0];
		if (postCloseAcceptedA === undefined) throw new Error("D108E4I_FIXTURE_POST_CLOSE_A_ABSENT");
		const channelCloseAcceptedABetweenEventAndCallBase = withReceiverDeadlineTransport(
			receiverChannelClose,
			Object.freeze({
				...receiverChannelClose.endpoints.receiver.deadline.rawTransport,
				received: receiverChannelClose.endpoints.receiver.acceptedRaw.length + 1,
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
		const ownershipTruthTable = [
			["0/0", noReplacement, [0, 0], undefined],
			["1/0", creatorReplacement, [1, 0], undefined],
			["0/1", receiverReplacement, [0, 1], undefined],
			["1/1", d108e4acDualLocalReplacementReplay(false), [1, 1], undefined],
			["2/0", ambiguousDoubleReplacementDrop, [2, 0], "D108E4H_DROP_COUNT_AMBIGUOUS"],
			["0/2", ambiguousDrop, [0, 2], "D108E4H_DROP_COUNT_AMBIGUOUS"],
		] as const;
		for (const [name, fixture, counts, expectedError] of ownershipTruthTable) {
			expect(
				[fixture.rawTransportDeltas.creator.linkDrops, fixture.rawTransportDeltas.receiver.linkDrops],
				`D108E4AC_OWNERSHIP_COUNTS ${name}`
			).toEqual(counts);
			if (expectedError === undefined) {
				expect(() => validateD108e4hCampaignCustody(fixture), `D108E4AC_OWNERSHIP_RESULT ${name}`).not.toThrow();
			} else {
				expect(() => validateD108e4hCampaignCustody(fixture), `D108E4AC_OWNERSHIP_RESULT ${name}`).toThrowError(
					expectedError
				);
			}
		}
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
		const replacementWithoutProductCall = withReceiverLifecycle(
			receiverReplacement,
			receiverReplacement.endpoints.receiver.lifecycle.filter(
				({ channelId, connectionId, event, owner }) =>
					!(
						event === "channel-close-call" &&
						owner === "product-unreliable-webrtc" &&
						connectionId === D108E4H_RTC_A.connectionId &&
						channelId === D108E4H_RTC_A.channelId
					)
			)
		);
		expect(() => validateD108e4hCampaignCustody(replacementWithoutProductCall)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);
		const channelCloseCallBeforeEvent = withReceiverLifecycle(
			receiverChannelClose,
			receiverChannelClose.endpoints.receiver.lifecycle.map((record, index) => {
				if (index === 4)
					return Object.freeze({
						...(receiverChannelClose.endpoints.receiver.lifecycle[5] as D108e4hLifecycleObservation),
						sequence: 4,
					});
				if (index === 5)
					return Object.freeze({
						...(receiverChannelClose.endpoints.receiver.lifecycle[4] as D108e4hLifecycleObservation),
						sequence: 5,
					});
				return record;
			})
		);
		expect(() => validateD108e4hCampaignCustody(channelCloseCallBeforeEvent)).toThrowError(
			"D108E4H_LIFECYCLE_ORDER_INVALID"
		);

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
		const wrongReplacementOpenOwner = withReceiverLifecycle(
			receiverReplacement,
			receiverLifecycle.map((record) =>
				record.event === "channel-open-event" ? Object.freeze({ ...record, owner: "rtc-observer-or-harness" }) : record
			)
		);
		expect(() => validateD108e4hCampaignCustody(wrongReplacementOpenOwner)).toThrowError(
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
		const zeroLocalBoundedRefusal = withCreatorBoundedRefusals(noReplacement, 527, 73);
		expect(() => validateD108e4hCampaignCustody(zeroLocalBoundedRefusal)).not.toThrow();
		const zeroLocalRefusalUnderflow = withCreatorBoundedRefusals(noReplacement, 527, 72);
		expect(() => validateD108e4hCampaignCustody(zeroLocalRefusalUnderflow)).toThrowError(
			"D108E4H_RAW_SEND_DOMAIN_INVALID"
		);
		const zeroLocalRefusalOverflow = withCreatorBoundedRefusals(noReplacement, 527, 74);
		expect(() => validateD108e4hCampaignCustody(zeroLocalRefusalOverflow)).toThrowError(
			"D108E4H_RAW_SEND_DOMAIN_INVALID"
		);
		const nonTransmitterBackpressure = withReceiverDeadlineTransport(
			noReplacement,
			Object.freeze({
				...noReplacement.endpoints.receiver.deadline.rawTransport,
				backpressuredDrops: noReplacement.endpoints.receiver.prepare.rawTransport.backpressuredDrops + 1,
			})
		);
		expect(() => validateD108e4hCampaignCustody(nonTransmitterBackpressure)).toThrowError("D108E4H_RAW_BACKPRESSURE");
		for (const replacementBackpressure of [
			withCreatorBoundedRefusals(creatorReplacement, 527, 73),
			withCreatorBoundedRefusals(receiverReplacement, 527, 73),
			withCreatorBoundedRefusals(creatorChannelClose, 527, 73),
			withCreatorBoundedRefusals(receiverChannelClose, 527, 73),
		]) {
			expect(() => validateD108e4hCampaignCustody(replacementBackpressure)).toThrowError("D108E4H_RAW_BACKPRESSURE");
		}
		const creatorBackpressure = withCreatorDeadlineTransport(
			creatorReplacement,
			Object.freeze({
				...creatorReplacement.endpoints.creator.deadline.rawTransport,
				backpressuredDrops: 1,
			})
		);
		expect(() => validateD108e4hCampaignCustody(creatorBackpressure)).toThrowError("D108E4H_RAW_BACKPRESSURE");
		const detachedCreatorDeltaWithBackpressure = Object.freeze({
			...creatorBackpressure,
			rawTransportDeltas: Object.freeze({
				...creatorBackpressure.rawTransportDeltas,
				creator: Object.freeze({
					...creatorBackpressure.rawTransportDeltas.creator,
					linkDrops: creatorBackpressure.rawTransportDeltas.creator.linkDrops + 1,
				}),
			}),
		});
		expect(() => validateD108e4hCampaignCustody(detachedCreatorDeltaWithBackpressure)).toThrowError(
			"D108E4H_DELTA_MISMATCH"
		);
		const admittedRawSends = Object.freeze(creatorReplacement.endpoints.creator.rawSends.slice(0, 555));
		expect([admittedRawSends.length, admittedRawSends.at(-1)?.sequence]).toEqual([555, 554]);
		const admittedAttemptIds = new Set(admittedRawSends.map(({ attemptId }) => attemptId));
		const capturedBackpressureBase = Object.freeze({
			...creatorReplacement,
			endpoints: Object.freeze({
				...creatorReplacement.endpoints,
				creator: Object.freeze({
					...creatorReplacement.endpoints.creator,
					lifecycle: Object.freeze(
						creatorReplacement.endpoints.creator.lifecycle.filter(
							({ attemptId }) => attemptId === undefined || admittedAttemptIds.has(attemptId)
						)
					),
					rawSends: admittedRawSends,
				}),
			}),
		});
		const capturedBackpressure = withCreatorDeadlineTransport(
			capturedBackpressureBase,
			Object.freeze({
				...capturedBackpressureBase.endpoints.creator.deadline.rawTransport,
				backpressuredDrops: capturedBackpressureBase.endpoints.creator.prepare.rawTransport.backpressuredDrops + 45,
				sent: capturedBackpressureBase.endpoints.creator.prepare.rawTransport.sent + admittedRawSends.length,
			})
		);
		expect
			.soft(
				() => validateD108e4hCampaignCustody(capturedBackpressure),
				"D.108e4am captured 555-success/45-backpressure attribution"
			)
			.toThrowError("D108E4H_RAW_BACKPRESSURE");
		const incompleteRawDomain = withCreatorDeadlineTransport(
			capturedBackpressureBase,
			Object.freeze({
				...capturedBackpressureBase.endpoints.creator.deadline.rawTransport,
				backpressuredDrops: capturedBackpressureBase.endpoints.creator.prepare.rawTransport.backpressuredDrops,
				sent: capturedBackpressureBase.endpoints.creator.prepare.rawTransport.sent + admittedRawSends.length,
			})
		);
		expect(() => validateD108e4hCampaignCustody(incompleteRawDomain)).toThrowError("D108E4H_RAW_SEND_DOMAIN_INVALID");
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

		expect(D108E4AP_RUN_RETURN_BOUND_MS).toBe(18_767);
		const d108e4apCampaignStartedAtMs = 1_000_000;
		const d108e4apExactRunReturnAtMs = d108e4apCampaignStartedAtMs + D108E4AP_RUN_RETURN_BOUND_MS;
		const d108e4apMissing = Object.freeze({ trialId: "d108e4ap-missing" });
		expect(() => d108e4apRunReturnTimestamp(d108e4apMissing)).toThrowError("D108E4AP_RUN_RETURN_CUSTODY_ABSENT");
		const d108e4apNonSafe = Object.freeze({ runTrialReturnedAtMs: Number.NaN });
		expect(() => d108e4apRunReturnTimestamp(d108e4apNonSafe)).toThrowError("D108E4AP_RUN_RETURN_CUSTODY_INVALID");
		const d108e4apNegative = Object.freeze({ runTrialReturnedAtMs: -1 });
		expect(() => d108e4apRunReturnTimestamp(d108e4apNegative)).toThrowError("D108E4AP_RUN_RETURN_CUSTODY_INVALID");
		expect(() => d108e4apAssertRunReturnJoin(d108e4apNegative, d108e4apCampaignStartedAtMs)).toThrowError(
			"D108E4AP_RUN_RETURN_CUSTODY_INVALID"
		);
		const d108e4apBelowBoundary = Object.freeze({
			runTrialReturnedAtMs: d108e4apExactRunReturnAtMs - 1,
		});
		expect(() => d108e4apAssertRunReturnJoin(d108e4apBelowBoundary, d108e4apCampaignStartedAtMs)).toThrowError(
			"D108E4AP_RUN_RETURN_JOIN_INVALID"
		);
		const d108e4apExactBoundary = Object.freeze({ runTrialReturnedAtMs: d108e4apExactRunReturnAtMs });
		expect(() => d108e4apAssertRunReturnJoin(d108e4apExactBoundary, d108e4apCampaignStartedAtMs)).not.toThrow();
		const d108e4apLiveProgress = d108e4apBuildRunReturnProgress(
			Object.freeze({ trialId: "d108e4ap-live" }),
			d108e4apExactRunReturnAtMs
		);
		d108e4apRunReturnTimestamp(d108e4apLiveProgress);
		expect(d108e4apLiveProgress["runTrialReturnedAtMs"]).toBe(d108e4apExactRunReturnAtMs);
		expect(d108e4apLiveProgress["trialId"]).toBe("d108e4ap-live");
		d108e4apAssertRunReturnJoin(d108e4apLiveProgress, d108e4apCampaignStartedAtMs);

		const d108e4arDeadlineSenderWire: readonly PlatformObservation[] = Object.freeze([]);
		const d108e4arRunReturnSenderWire: readonly PlatformObservation[] = Object.freeze([]);
		const d108e4arRelativeStage = Object.freeze({ atMs: 321 });
		const d108e4arFinalBase = {
			deadlineSenderWire: d108e4arDeadlineSenderWire,
			stages: Object.freeze({ runReturned: d108e4arRelativeStage }),
			trialId: "d108e4ar-round-trip",
		};
		const d108e4arProgress = Object.freeze({
			[D108E4AR_RUN_RETURN_SENDER_WIRE_KEY]: d108e4arRunReturnSenderWire,
			runTrialReturnedAtMs: d108e4apExactRunReturnAtMs,
		});
		const d108e4arFinalEvidence = d108e4arFinalizeRunReturnCustody(d108e4arFinalBase, d108e4arProgress);
		expect(d108e4arRunReturnSenderWire).not.toBe(d108e4arDeadlineSenderWire);
		expect(d108e4arFinalEvidence.runTrialReturnedAtMs).toBe(d108e4apExactRunReturnAtMs);
		expect(d108e4arFinalEvidence.runReturnSenderWire).toBe(d108e4arRunReturnSenderWire);
		expect(d108e4arFinalEvidence.deadlineSenderWire).toBe(d108e4arDeadlineSenderWire);
		expect(d108e4arFinalEvidence.trialId).toBe("d108e4ar-round-trip");
		expect(d108e4arFinalEvidence.stages.runReturned.atMs).toBe(d108e4arRelativeStage.atMs);
		expect(Object.isFrozen(d108e4arFinalEvidence)).toBe(true);
		const d108e4arTimestampOnly = Object.freeze({ runTrialReturnedAtMs: d108e4apExactRunReturnAtMs });
		expect(() => d108e4arFinalizeRunReturnCustody(d108e4arFinalBase, d108e4arTimestampOnly)).toThrowError(
			"D108E4AR_FINAL_RUN_RETURN_CUSTODY_ABSENT"
		);
		const d108e4arUndefinedSender = Object.freeze({
			[D108E4AR_RUN_RETURN_SENDER_WIRE_KEY]: undefined,
			runTrialReturnedAtMs: d108e4apExactRunReturnAtMs,
		});
		expect(() => d108e4arFinalizeRunReturnCustody(d108e4arFinalBase, d108e4arUndefinedSender)).toThrowError(
			"D108E4AR_FINAL_RUN_RETURN_CUSTODY_ABSENT"
		);
		const d108e4arInvalidSender = Object.freeze({
			[D108E4AR_RUN_RETURN_SENDER_WIRE_KEY]: Object.freeze({}),
			runTrialReturnedAtMs: d108e4apExactRunReturnAtMs,
		});
		expect(() => d108e4arFinalizeRunReturnCustody(d108e4arFinalBase, d108e4arInvalidSender)).toThrowError(
			"D108E4AR_FINAL_RUN_RETURN_CUSTODY_INVALID"
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

	const senderObservation = (
		sequence: number,
		receivedAtMs: number,
		connectionId = 8,
		channelId = 377
	): PlatformObservation =>
		Object.freeze({
			attemptId: sequence,
			byteLength: SAMPLE_PAYLOAD_BYTES,
			carrierByteLength: 431,
			channelId,
			channelLabel: "ts-drp-ephemeral/1",
			connectionId,
			insertionReadyState: "open",
			lane: "raw",
			lifecycleSequence: sequence + 1_000,
			maxRetransmits: 0,
			ordered: false,
			ordinal: sequence,
			receivedAtMs,
			readyState: "open",
			sentAtMs: receivedAtMs,
			sequence,
			sentinel: false,
		});
	const lifecycleRecord = (
		sequence: number,
		event: "channel-send-attempt" | "channel-send-success",
		attemptId: number,
		bufferedAmount: number,
		atWallMs: number,
		connectionId = 8,
		channelId = 377
	): D108e4hLifecycleObservation =>
		Object.freeze({
			attemptId,
			atMonotonicMs: atWallMs,
			atWallMs,
			bufferedAmount,
			channelId,
			connectionId,
			event,
			label: "ts-drp-ephemeral/1",
			owner: "rtc-datachannel-send",
			readyState: "open",
			schemaVersion: 3,
			sequence,
			trialId: "d108e4bs-refusal-window",
		});
	const firstBoundaryAtMs = 393 * SAMPLE_INTERVAL_MS;
	const secondBoundaryAtMs = firstBoundaryAtMs + 5_506;
	const qualifiedObservations = Object.freeze(
		Array.from({ length: SAMPLE_COUNT }, (_, sequence) => sequence)
			.filter((sequence) => sequence <= 393 || sequence >= 560)
			.map((sequence) =>
				senderObservation(
					sequence,
					sequence <= 393 ? sequence * SAMPLE_INTERVAL_MS : secondBoundaryAtMs + (sequence - 560) * SAMPLE_INTERVAL_MS
				)
			)
	);
	const qualifiedLifecycle = Object.freeze([
		lifecycleRecord(100, "channel-send-attempt", 393, 65_512, firstBoundaryAtMs),
		lifecycleRecord(101, "channel-send-success", 393, 65_943, firstBoundaryAtMs),
		lifecycleRecord(102, "channel-send-attempt", 560, 0, secondBoundaryAtMs),
		lifecycleRecord(103, "channel-send-success", 560, 431, secondBoundaryAtMs),
	]);
	const qualifiedInput: RawSenderContinuityInput = Object.freeze({
		backpressuredDrops: 166,
		intervalMs: SAMPLE_INTERVAL_MS,
		lifecycle: qualifiedLifecycle,
		observations: qualifiedObservations,
		receiverLinkDrops: 0,
		sampleCount: SAMPLE_COUNT,
		senderLinkDrops: 0,
	});
	const withLifecycle = (lifecycle: readonly D108e4hLifecycleObservation[]): RawSenderContinuityInput =>
		Object.freeze({ ...qualifiedInput, lifecycle: Object.freeze(lifecycle) });
	const mutateLifecycle = (
		selectedEvent: D108e4hLifecycleObservation["event"],
		selectedAttemptId: number,
		mutation: Readonly<Partial<D108e4hLifecycleObservation>>
	): readonly D108e4hLifecycleObservation[] =>
		qualifiedLifecycle.map((record) =>
			record.event === selectedEvent && record.attemptId === selectedAttemptId
				? Object.freeze({ ...record, ...mutation })
				: record
		);

	expect(rawSenderContinuityEvidence(qualifiedInput)).toEqual({
		gap: 167,
		rawBackpressureWindowMaxMs: 5_506,
		rawMaxStallMs: SAMPLE_INTERVAL_MS,
		rawNativeGapMaxMs: 5_506,
	});

	const changedIdentityObservations = qualifiedObservations.map((record) =>
		record.sequence >= 560 ? Object.freeze({ ...record, channelId: 378 }) : record
	);
	const overBoundObservations = qualifiedObservations.map((record) =>
		record.sequence >= 560
			? Object.freeze({ ...record, receivedAtMs: record.receivedAtMs + 506, sentAtMs: record.sentAtMs + 506 })
			: record
	);
	const consecutiveStallObservations = qualifiedObservations.map((record) =>
		record.sequence >= 101
			? Object.freeze({ ...record, receivedAtMs: record.receivedAtMs + 5_473, sentAtMs: record.sentAtMs + 5_473 })
			: record
	);
	const splitGapSequences = Array.from({ length: SAMPLE_COUNT }, (_, sequence) => sequence).filter(
		(sequence) => sequence < 100 || (sequence >= 200 && sequence < 400) || sequence >= 466
	);
	const splitGapObservations = Object.freeze(
		splitGapSequences.map((sequence) => {
			if (sequence < 400) return senderObservation(sequence, sequence * SAMPLE_INTERVAL_MS);
			const secondSplitBoundaryAtMs = 399 * SAMPLE_INTERVAL_MS + 5_506;
			return senderObservation(sequence, secondSplitBoundaryAtMs + (sequence - 466) * SAMPLE_INTERVAL_MS);
		})
	);
	const firstSplitBoundaryAtMs = 99 * SAMPLE_INTERVAL_MS;
	const splitGapLifecycle = Object.freeze([
		lifecycleRecord(200, "channel-send-attempt", 99, 65_512, firstSplitBoundaryAtMs),
		lifecycleRecord(201, "channel-send-success", 99, 65_943, firstSplitBoundaryAtMs),
		lifecycleRecord(202, "channel-send-attempt", 200, 0, 200 * SAMPLE_INTERVAL_MS),
		lifecycleRecord(203, "channel-send-success", 200, 431, 200 * SAMPLE_INTERVAL_MS),
	]);
	const negativeRows: readonly Readonly<{
		readonly expected: number;
		readonly input: RawSenderContinuityInput;
		readonly name: string;
	}>[] = Object.freeze([
		Object.freeze({
			expected: 5_506,
			input: Object.freeze({ ...qualifiedInput, backpressuredDrops: 0 }),
			name: "absent refusal delta",
		}),
		Object.freeze({
			expected: 5_506,
			input: Object.freeze({ ...qualifiedInput, backpressuredDrops: 165 }),
			name: "inconsistent refusal delta",
		}),
		Object.freeze({
			expected: 5_506,
			input: Object.freeze({ ...qualifiedInput, senderLinkDrops: 1 }),
			name: "local replacement",
		}),
		Object.freeze({
			expected: 5_506,
			input: Object.freeze({ ...qualifiedInput, receiverLinkDrops: 1 }),
			name: "peer replacement",
		}),
		Object.freeze({
			expected: 5_506,
			input: Object.freeze({ ...qualifiedInput, observations: changedIdentityObservations }),
			name: "changed RTC identity",
		}),
		Object.freeze({
			expected: 5_506,
			input: withLifecycle(mutateLifecycle("channel-send-attempt", 393, { bufferedAmount: 65_537 })),
			name: "preceding attempt already over ceiling",
		}),
		Object.freeze({
			expected: 5_506,
			input: withLifecycle(mutateLifecycle("channel-send-success", 393, { bufferedAmount: 65_536 })),
			name: "preceding success did not cross ceiling",
		}),
		Object.freeze({
			expected: 5_506,
			input: withLifecycle(mutateLifecycle("channel-send-attempt", 560, { bufferedAmount: 65_537 })),
			name: "resume remained over ceiling",
		}),
		Object.freeze({
			expected: 5_506,
			input: withLifecycle([
				...qualifiedLifecycle.slice(0, 2),
				Object.freeze({
					...qualifiedLifecycle[1],
					attemptId: undefined,
					event: "channel-close-call" as const,
					owner: "rtc-observer-or-harness",
					sequence: 102,
				}),
				...qualifiedLifecycle.slice(2).map((record) => Object.freeze({ ...record, sequence: record.sequence + 1 })),
			]),
			name: "close inside refusal window",
		}),
		Object.freeze({
			expected: 6_012,
			input: Object.freeze({ ...qualifiedInput, observations: overBoundObservations }),
			name: "cadence bound exceeded",
		}),
		Object.freeze({
			expected: 5_506,
			input: Object.freeze({ ...qualifiedInput, observations: consecutiveStallObservations }),
			name: "consecutive sequence stall",
		}),
		Object.freeze({
			expected: 5_506,
			input: Object.freeze({
				...qualifiedInput,
				lifecycle: splitGapLifecycle,
				observations: splitGapObservations,
			}),
			name: "second nonconsecutive window lacks lifecycle",
		}),
	]);
	for (const { expected, input, name } of negativeRows) {
		expect.soft(rawSenderContinuityEvidence(input).rawMaxStallMs, name).toBe(expected);
	}
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
				inbound.dispatchEvent(new Event("open"));
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
				const lifecycle = await observer.lifecycleSnapshot();
				observer.reset("observer-repeat-generation");
				inbound.dispatchEvent(new Event("open"));
				const postResetLifecycle = await observer.lifecycleSnapshot();
				return Object.freeze({
					lifecycle,
					postResetLifecycle,
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
			const openCallbacksByIdentity = new Map<string, RtcLifecycleObservation[]>();
			for (const record of evidence.lifecycle) {
				if (record.event !== "channel-open-event" && record.event !== "channel-open-repeat-event") {
					continue;
				}
				const key = `${record.connectionId}/${record.channelId ?? "absent"}`;
				const callbacks = openCallbacksByIdentity.get(key) ?? [];
				callbacks.push(record);
				openCallbacksByIdentity.set(key, callbacks);
			}
			const repeatedCallbacks = [...openCallbacksByIdentity.values()].find((records) => records.length === 2);
			expect(repeatedCallbacks).toBeDefined();
			expect
				.soft(
					repeatedCallbacks?.map(({ event, owner }) => [event, owner]),
					"D108E4AE_RED observer emits first-open plus repeat kinds"
				)
				.toEqual([
					["channel-open-event", "rtc-datachannel-open-event"],
					["channel-open-repeat-event", "rtc-datachannel-open-repeat-event"],
				]);
			expect
				.soft(
					evidence.postResetLifecycle
						.filter(({ event }) => event === "channel-open-event" || event === "channel-open-repeat-event")
						.map(({ event, owner, sequence, trialId }) => [event, owner, sequence, trialId]),
					"D108E4AE_RED observer reset starts a new object generation"
				)
				.toEqual([["channel-open-event", "rtc-datachannel-open-event", 0, "observer-repeat-generation"]]);
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
			const [responderBeforeSend, initiatorBeforeSend, initiatorRecordsBeforeSend] = await Promise.all([
				rtcLifecycleObservations(responder),
				rtcLifecycleObservations(initiator),
				rtcObservations(initiator),
			]);
			const responderHandlerAtGate = responderBeforeSend.find(
				({ channelId, connectionId, event, owner }) =>
					event === "channel-message-handler-installed" &&
					owner === "product-unreliable-webrtc" &&
					connectionId === preSendResponder.connectionId &&
					channelId === preSendResponder.channelId
			);
			const replacementAttemptsBeforeGate = initiatorBeforeSend.filter(
				({ channelId, connectionId, event }) =>
					event === "channel-send-attempt" &&
					connectionId === preSendInitiator.connectionId &&
					channelId === preSendInitiator.channelId
			);
			const replacementControlAttemptIdsBeforeGate = new Set(
				d108e4avControlsFromCapture(initiatorRecordsBeforeSend, "send")
					.filter(
						({ channelId, connectionId }) =>
							connectionId === preSendInitiator.connectionId && channelId === preSendInitiator.channelId
					)
					.map(({ attemptId }) => attemptId)
			);
			const replacementApplicationAttemptsBeforeGate = replacementAttemptsBeforeGate.filter(
				({ attemptId }) => attemptId === undefined || !replacementControlAttemptIdsBeforeGate.has(attemptId)
			);
			expect(responderHandlerAtGate).toBeDefined();
			expect(replacementControlAttemptIdsBeforeGate.size).toBe(replacementAttemptsBeforeGate.length);
			expect(replacementApplicationAttemptsBeforeGate).toHaveLength(0);
			const causalHandlerBeforeSendGate = Object.freeze({
				initiatorReplacement: preSendInitiator,
				initiatorReplacementApplicationAttemptsBeforeGate: replacementApplicationAttemptsBeforeGate.length,
				initiatorReplacementControlAttemptsBeforeGate: replacementControlAttemptIdsBeforeGate.size,
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
				initiatorRtcRecords,
				responderRtcRecords,
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
				rtcObservations(initiator),
				rtcObservations(responder),
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
				({ channelId, connectionId, event, owner }) =>
					event === "channel-close-call" &&
					owner === "product-unreliable-webrtc" &&
					connectionId === oldRtc.connectionId &&
					channelId === oldRtc.channelId
			);
			const newRawOpen = initiatorRtc.find(
				({ channelId, connectionId, event }) =>
					event === "channel-open-event" && connectionId === newRtc.connectionId && channelId === newRtc.channelId
			);
			const initiatorControlAttemptIds = new Set(
				d108e4avControlsFromCapture(initiatorRtcRecords, "send").map(({ attemptId }) => attemptId)
			);
			const responderControlMessageSequences = new Set(
				d108e4avControlsFromCapture(responderRtcRecords, "message").map(({ lifecycleSequence }) => lifecycleSequence)
			);
			const newRawSendAttempt = initiatorRtc.find(
				({ attemptId, channelId, connectionId, event }) =>
					event === "channel-send-attempt" &&
					connectionId === newRtc.connectionId &&
					channelId === newRtc.channelId &&
					(attemptId === undefined || !initiatorControlAttemptIds.has(attemptId))
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
				({ channelId, connectionId, event, sequence }) =>
					event === "channel-message" &&
					connectionId === newResponderRtc.connectionId &&
					channelId === newResponderRtc.channelId &&
					!responderControlMessageSequences.has(sequence)
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
			expect(["channel-close", "replacement"]).toContain(initiatorZone.rawTransport.lastLinkDrop);
			expect(initiatorZone.rawTransport.linkDrops - initialInitiatorZone.rawTransport.linkDrops).toBe(1);
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

if (process.env["D108E4AY_RESET_REPLAY"] === "1") {
	test("D.108e4ay attributes the post-loss bilateral fabric reset", async ({ browser }, testInfo) => {
		test.setTimeout(180_000);
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
		const replayId = "e3-03-total-loss-calibration";
		let objectId: string | undefined;
		let peers:
			| Readonly<{ readonly creatorPeerId: string; readonly durableBaseline: number; readonly receiverPeerId: string }>
			| undefined;
		let preCustody: readonly [ResetReplayEndpointCustody, ResetReplayEndpointCustody] | undefined;
		let stage = "network-enable";
		try {
			await cdp.send("Network.enable");
			stage = "pre-signaling-profile";
			await applyProfile("pre-signaling-capability", NO_LOSS);
			expect(cdpEvidence[0]?.ruleIds).toHaveLength(1);
			stage = "grid-open";
			await Promise.all([openGrid(creator), openGrid(receiver)]);
			stage = "zone-create";
			peers = await createZone(creator, receiver);
			objectId = (await zone(creator)).zoneId;
			expect((await zone(receiver)).zoneId).toBe(objectId);
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
			expect(readiness, "the focused replay requires the exact public fabric workbench").toEqual([
				{ reset: "function", runTrial: "function", snapshot: "function" },
				{ reset: "function", runTrial: "function", snapshot: "function" },
			]);

			stage = "pre-reset-custody";
			preCustody = await Promise.all([
				resetReplayEndpointCustody(creator, objectId),
				resetReplayEndpointCustody(receiver, objectId),
			]);
			for (const custody of preCustody) {
				expect(custody.raw?.links).toHaveLength(1);
				const selected = custody.raw?.links[0];
				if (selected === undefined) throw new Error("D108E4AY_PRE_RESET_RAW_OWNER_ABSENT");
				expect(custody.libp2pConnections).toContainEqual(
					expect.objectContaining({ connectionId: selected.connectionId, peerId: selected.peerId })
				);
				expect(
					custody.rtc.channelStates.filter(
						({ label, readyState }) => label === "ts-drp-ephemeral/1" && readyState === "open"
					)
				).toHaveLength(1);
			}

			stage = "workbench-total-loss-calibration";
			await Promise.all(
				[creator, receiver].map((page) =>
					page.evaluate((selectedTrialId) => window.__TS_DRP_V3_ZONE__?.fabric?.reset(selectedTrialId), replayId)
				)
			);
			await waitForOpenTransportPair(creator, receiver);
			await waitForNetworkPair(creator, receiver, initialCreatorNetwork, initialReceiverNetwork);
			await waitForRawDelivery(creator, receiver);
			await waitForRawDelivery(receiver, creator);
			stage = "post-reset-custody";
			const postCustody = await Promise.all([
				resetReplayEndpointCustody(creator, objectId),
				resetReplayEndpointCustody(receiver, objectId),
			]);
			await attachJson(testInfo, "d108e4ay-reset-replay.json", {
				browserVersion: browser.version(),
				cdpEvidence,
				error: null,
				peers,
				post: { creator: postCustody[0], receiver: postCustody[1] },
				pre: { creator: preCustody[0], receiver: preCustody[1] },
				replayId,
				stage: "complete",
			});
			stage = "complete";
		} catch (error) {
			const selectedObjectId = objectId;
			const postCustody =
				selectedObjectId === undefined
					? undefined
					: await Promise.all([
							diagnosticAttempt(() => resetReplayEndpointCustody(creator, selectedObjectId)),
							diagnosticAttempt(() => resetReplayEndpointCustody(receiver, selectedObjectId)),
						]);
			await attachJson(testInfo, "d108e4ay-reset-replay.json", {
				browserVersion: browser.version(),
				cdpEvidence,
				error: diagnosticError(error),
				peers,
				post: postCustody === undefined ? undefined : { creator: postCustody[0], receiver: postCustody[1] },
				pre: preCustody === undefined ? undefined : { creator: preCustody[0], receiver: preCustody[1] },
				replayId,
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
		await resetFabricPairSerially(creator, receiver, calibrationTrialId, initialCreatorNetwork, initialReceiverNetwork);
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
			await resetFabricPairSerially(creator, receiver, trialId, initialCreatorNetwork, initialReceiverNetwork);
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
			trialProgress = d108e4apBuildRunReturnProgress(trialProgress, runTrialReturnedAtMs);
			currentTrialEvidence = trialProgress;
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
			updateTrialProgress({ senderRawCandidateCount, [D108E4AR_RUN_RETURN_SENDER_WIRE_KEY]: senderWire });
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
			const trialEvidenceBase: Omit<CampaignEvidence, "runTrialReturnedAtMs" | "runReturnSenderWire"> = {
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
				deadlineSenderWire: senderWireAtDeadline,
				trialId,
			};
			const trialEvidence = d108e4arFinalizeRunReturnCustody(
				trialEvidenceBase,
				trialProgress
			) satisfies CampaignEvidence;
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
				campaignEvidence.flatMap(({ deadlineSenderWire }) =>
					deadlineSenderWire.filter(({ lane }) => lane === "raw").map(({ connectionId }) => connectionId)
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
		await resetFabricPairSerially(
			creator,
			receiver,
			"e3-03-durable-control",
			initialCreatorNetwork,
			initialReceiverNetwork
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

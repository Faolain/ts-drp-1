/**
 * Worker side of the room worker's WebRTC split: an RTCPeerConnection stand-in whose signalling
 * runs on the page's real peer connection (rtc-page.ts). Data channels are created on the page and
 * transferred here, so their traffic stays in the worker. createDataChannel must return at once,
 * so it returns a stand-in that attaches to the real channel one page round trip later; that round
 * trip is measured (roomWorkerRtcStats) because libp2p opens a channel per stream.
 *
 * installWorkerRtc must run before any network module is evaluated: @libp2p/webrtc captures the
 * RTCPeerConnection global at module evaluation (serveRoomWorker loads the app after it).
 */
import type { PageToWorkerRtc, PeerConnectionState } from "./rtc-page.js";

type Post = (message: unknown, transfer?: Transferable[]) => void;

/** Round trips kept for the latency quantiles. */
const RTC_SAMPLE_LIMIT = 1024;

export interface RoomWorkerRtcStats {
	/** Peer connections created. */
	readonly peerConnections: number;
	/** Data channels the worker created (each a page round trip). */
	readonly channelsCreated: number;
	/** Data channels the remote opened (transferred on arrival, no round trip). */
	readonly channelsReceived: number;
	/** Created channels whose real channel arrived. */
	readonly channelsAttached: number;
	/** createDataChannel to attach, in ms: the newest RTC_SAMPLE_LIMIT samples. */
	readonly attachMs: readonly number[];
	/** Signalling calls proxied to the page. */
	readonly signallingCalls: number;
	/** Synthetic open events dispatched for channels that arrived already open. */
	readonly syntheticOpens: number;
}

const stats = {
	peerConnections: 0,
	channelsCreated: 0,
	channelsReceived: 0,
	channelsAttached: 0,
	attachMs: [] as number[],
	signallingCalls: 0,
	syntheticOpens: 0,
};

/** @returns A copy of this worker's RTC split counters. */
export function roomWorkerRtcStats(): RoomWorkerRtcStats {
	return Object.freeze({ ...stats, attachMs: Object.freeze([...stats.attachMs]) });
}

class SessionDescription {
	readonly type: RTCSdpType;
	readonly sdp: string;
	constructor(init: RTCSessionDescriptionInit) {
		this.type = init.type;
		this.sdp = init.sdp ?? "";
	}
	toJSON(): RTCSessionDescriptionInit {
		return { type: this.type, sdp: this.sdp };
	}
}

class IceCandidate {
	readonly candidate: string;
	readonly sdpMid: string | null;
	readonly sdpMLineIndex: number | null;
	readonly usernameFragment: string | null;
	constructor(init: RTCIceCandidateInit = {}) {
		this.candidate = init.candidate ?? "";
		this.sdpMid = init.sdpMid ?? null;
		this.sdpMLineIndex = init.sdpMLineIndex ?? null;
		this.usernameFragment = init.usernameFragment ?? null;
	}
	toJSON(): RTCIceCandidateInit {
		return {
			candidate: this.candidate,
			sdpMid: this.sdpMid,
			sdpMLineIndex: this.sdpMLineIndex,
			usernameFragment: this.usernameFragment,
		};
	}
}

const plain = (value: unknown): unknown => {
	if (value === null || value === undefined || typeof value !== "object") return value;
	const json = (value as { toJSON?(): unknown }).toJSON;
	return typeof json === "function" ? json.call(value) : { ...(value as object) };
};

const HANDLER_EVENTS = [
	"icecandidate",
	"icecandidateerror",
	"connectionstatechange",
	"iceconnectionstatechange",
	"icegatheringstatechange",
	"signalingstatechange",
	"datachannel",
	"negotiationneeded",
	"track",
] as const;

const CHANNEL_EVENTS = ["open", "close", "closing", "error", "message", "bufferedamountlow"] as const;

function defineHandlers(target: EventTarget, events: readonly string[]): void {
	for (const name of events) {
		let current: ((event: Event) => void) | null = null;
		Object.defineProperty(target, `on${name}`, {
			configurable: true,
			get: () => current,
			set: (value: ((event: Event) => void) | null) => {
				if (current !== null) target.removeEventListener(name, current);
				current = typeof value === "function" ? value : null;
				if (current !== null) target.addEventListener(name, current);
			},
		});
	}
}

/**
 * A data channel created in this worker. Until the real channel arrives it is "connecting" and
 * refuses sends; afterwards it forwards everything to the real channel and re-dispatches its events.
 */
class PendingDataChannel extends EventTarget {
	readonly label: string;
	readonly #init: RTCDataChannelInit;
	readonly #syntheticId: number;
	readonly #requestedAt = performance.now();
	#real: RTCDataChannel | undefined;
	#binaryType: BinaryType = "arraybuffer";
	#threshold = 0;
	#closeRequested = false;
	constructor(label: string, init: RTCDataChannelInit, syntheticId: number) {
		super();
		this.label = label;
		this.#init = init;
		this.#syntheticId = syntheticId;
		defineHandlers(this, CHANNEL_EVENTS);
	}
	attach(real: RTCDataChannel): void {
		this.#real = real;
		stats.channelsAttached++;
		stats.attachMs.push(performance.now() - this.#requestedAt);
		if (stats.attachMs.length > RTC_SAMPLE_LIMIT) stats.attachMs.shift();
		real.binaryType = this.#binaryType;
		real.bufferedAmountLowThreshold = this.#threshold;
		let opened = false;
		for (const type of CHANNEL_EVENTS) {
			real.addEventListener(type, (event) => {
				if (type === "open") {
					if (opened) return;
					opened = true;
				}
				let copy: Event;
				if (type === "message") copy = new MessageEvent("message", { data: (event as MessageEvent).data });
				else {
					copy = new Event(type);
					if (type === "error") Object.defineProperty(copy, "error", { value: (event as RTCErrorEvent).error });
				}
				this.dispatchEvent(copy);
			});
		}
		if (this.#closeRequested) {
			real.close();
			return;
		}
		// A channel can arrive already open (some engines open it before the transfer lands); its
		// open event then may never reach this worker, so one is dispatched, at most once.
		if (real.readyState === "open")
			setTimeout(() => {
				if (opened || real.readyState !== "open") return;
				opened = true;
				stats.syntheticOpens++;
				this.dispatchEvent(new Event("open"));
			}, 0);
	}
	get id(): number | null {
		return this.#real?.id ?? this.#syntheticId;
	}
	get readyState(): RTCDataChannelState {
		if (this.#real !== undefined) return this.#real.readyState;
		return this.#closeRequested ? "closing" : "connecting";
	}
	get bufferedAmount(): number {
		return this.#real?.bufferedAmount ?? 0;
	}
	get bufferedAmountLowThreshold(): number {
		return this.#real?.bufferedAmountLowThreshold ?? this.#threshold;
	}
	set bufferedAmountLowThreshold(value: number) {
		this.#threshold = value;
		if (this.#real !== undefined) this.#real.bufferedAmountLowThreshold = value;
	}
	get binaryType(): BinaryType {
		return this.#real?.binaryType ?? this.#binaryType;
	}
	set binaryType(value: BinaryType) {
		this.#binaryType = value;
		if (this.#real !== undefined) this.#real.binaryType = value;
	}
	get ordered(): boolean {
		return this.#real?.ordered ?? this.#init.ordered ?? true;
	}
	get maxRetransmits(): number | null {
		return this.#real?.maxRetransmits ?? this.#init.maxRetransmits ?? null;
	}
	get maxPacketLifeTime(): number | null {
		return this.#real?.maxPacketLifeTime ?? this.#init.maxPacketLifeTime ?? null;
	}
	get negotiated(): boolean {
		return this.#real?.negotiated ?? this.#init.negotiated ?? false;
	}
	get protocol(): string {
		return this.#real?.protocol ?? this.#init.protocol ?? "";
	}
	send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
		if (this.#real === undefined) throw new DOMException("RTCDataChannel is not open", "InvalidStateError");
		this.#real.send(data as never);
	}
	close(): void {
		this.#closeRequested = true;
		this.#real?.close();
	}
}

export interface WorkerRtc {
	receive(message: unknown): void;
}

/**
 * Installs the worker-side RTC globals (RTCPeerConnection, RTCSessionDescription, RTCIceCandidate).
 * @param post - Posts an RTC message to the page.
 * @returns The receiver of the page's RTC messages.
 */
export function installWorkerRtc(post: Post): WorkerRtc {
	let nextPc = 1;
	let nextChannel = 1;
	let nextCall = 1;
	const connections = new Map<number, WorkerPeerConnection>();
	const pendingChannels = new Map<number, PendingDataChannel>();
	const calls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
	const call = (id: number, method: string, args: unknown[]): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const callId = nextCall++;
			stats.signallingCalls++;
			calls.set(callId, { resolve, reject });
			post({ t: "call", id, call: callId, method, args });
		});

	class WorkerPeerConnection extends EventTarget {
		readonly #id: number;
		connectionState: RTCPeerConnectionState = "new";
		iceConnectionState: RTCIceConnectionState = "new";
		iceGatheringState: RTCIceGatheringState = "new";
		signalingState: RTCSignalingState = "stable";
		localDescription: SessionDescription | null = null;
		remoteDescription: SessionDescription | null = null;
		sctp: PeerConnectionState["sctp"] = null;
		readonly #configuration: RTCConfiguration;
		/**
		 *
		 * @param configuration
		 */
		constructor(configuration: RTCConfiguration = {}) {
			super();
			this.#id = nextPc++;
			this.#configuration = configuration;
			stats.peerConnections++;
			connections.set(this.#id, this);
			defineHandlers(this, HANDLER_EVENTS);
			post({ t: "new", id: this.#id, configuration });
		}
		/**
		 *
		 * @param state
		 */
		apply(state: PeerConnectionState): void {
			this.connectionState = state.connectionState;
			this.iceConnectionState = state.iceConnectionState;
			this.iceGatheringState = state.iceGatheringState;
			this.signalingState = state.signalingState;
			this.localDescription = state.localDescription === null ? null : new SessionDescription(state.localDescription);
			this.remoteDescription =
				state.remoteDescription === null ? null : new SessionDescription(state.remoteDescription);
			this.sctp = state.sctp;
		}
		/**
		 *
		 * @param options
		 */
		createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
			return call(this.#id, "createOffer", [options]) as Promise<RTCSessionDescriptionInit>;
		}
		/**
		 *
		 * @param options
		 */
		createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
			return call(this.#id, "createAnswer", [options]) as Promise<RTCSessionDescriptionInit>;
		}
		/**
		 *
		 * @param value
		 */
		async setLocalDescription(value?: RTCSessionDescriptionInit): Promise<void> {
			await call(this.#id, "setLocalDescription", value === undefined ? [] : [plain(value)]);
		}
		/**
		 *
		 * @param value
		 */
		async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
			await call(this.#id, "setRemoteDescription", [plain(value)]);
		}
		/**
		 *
		 * @param candidate
		 */
		async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
			await call(this.#id, "addIceCandidate", candidate === undefined ? [] : [plain(candidate)]);
		}
		/**
		 *
		 */
		async getStats(): Promise<Map<string, unknown>> {
			return new Map((await call(this.#id, "getStats", [])) as [string, unknown][]);
		}
		/**
		 *
		 * @param label
		 * @param init
		 */
		createDataChannel(label: string, init: RTCDataChannelInit = {}): PendingDataChannel {
			const wid = nextChannel++;
			stats.channelsCreated++;
			// Synthetic ids stay unique and outside the SCTP range until the real channel's id is known.
			const channel = new PendingDataChannel(label, init, 1_000_000 + wid);
			pendingChannels.set(wid, channel);
			post({ t: "createDataChannel", id: this.#id, wid, label, init });
			return channel;
		}
		/**
		 *
		 */
		close(): void {
			this.signalingState = "closed";
			this.connectionState = "closed";
			connections.delete(this.#id);
			post({ t: "close", id: this.#id });
		}
		/**
		 *
		 */
		getConfiguration(): RTCConfiguration {
			return { ...this.#configuration };
		}
	}

	Reflect.set(globalThis, "RTCPeerConnection", WorkerPeerConnection);
	Reflect.set(globalThis, "RTCSessionDescription", SessionDescription);
	Reflect.set(globalThis, "RTCIceCandidate", IceCandidate);

	return {
		receive(raw: unknown): void {
			const message = raw as PageToWorkerRtc;
			switch (message.t) {
				case "state": {
					const pc = connections.get(message.id);
					if (pc === undefined) return;
					pc.apply(message.s);
					if (message.event === "icecandidate") {
						const event = new Event("icecandidate");
						Object.defineProperty(event, "candidate", {
							value:
								message.candidate === null || message.candidate === undefined
									? null
									: new IceCandidate(message.candidate),
						});
						pc.dispatchEvent(event);
					} else if (message.event !== undefined) pc.dispatchEvent(new Event(message.event));
					return;
				}
				case "result": {
					const pending = calls.get(message.call);
					calls.delete(message.call);
					if (pending === undefined) return;
					if (message.ok) pending.resolve(message.value);
					else pending.reject(new DOMException(message.error ?? "RTC call failed", "OperationError"));
					return;
				}
				case "datachannel": {
					stats.channelsReceived++;
					const pc = connections.get(message.id);
					if (pc === undefined) {
						message.channel.close();
						return;
					}
					const event = new Event("datachannel");
					Object.defineProperty(event, "channel", { value: message.channel });
					pc.dispatchEvent(event);
					return;
				}
				case "channel": {
					const pending = pendingChannels.get(message.wid);
					pendingChannels.delete(message.wid);
					if (pending === undefined) message.channel.close();
					else pending.attach(message.channel);
					return;
				}
			}
		},
	};
}

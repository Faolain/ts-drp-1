import type { Page } from "@playwright/test";

export interface RtcObservation {
	readonly bytes: readonly number[];
	readonly direction: "message" | "send";
	readonly label: string;
	readonly maxRetransmits: number | null;
	readonly ordered: boolean;
	readonly ordinal: number;
}

export interface RtcBandwidthSample {
	readonly bytesReceived: number;
	readonly connectionOrdinal: number;
	readonly dataChannelOpen: true;
	readonly maxRetransmits: 0;
	readonly ordered: false;
	readonly selectedPairId: string;
}

interface RtcObserver {
	reset(): void;
	sampleBandwidth(): Promise<RtcBandwidthSample>;
	snapshot(): Promise<readonly RtcObservation[]>;
}

declare global {
	interface Window {
		readonly __E4_RTC_OBSERVER__?: RtcObserver;
	}
}

export function installRtcObserver(): void {
	type RtcData = string | Blob | ArrayBuffer | ArrayBufferView;
	interface RawLink {
		readonly channel: RTCDataChannel;
		readonly connection: RTCPeerConnection;
		readonly connectionOrdinal: number;
	}
	const observedWindow = window as Window & { __E4_RTC_OBSERVER__?: RtcObserver };
	if (observedWindow.__E4_RTC_OBSERVER__ !== undefined) return;
	let generation = 0;
	let ordinal = 0;
	let nextConnectionOrdinal = 0;
	const records: RtcObservation[] = [];
	const pending = new Set<Promise<void>>();
	const rawLinks = new Map<RTCDataChannel, RawLink>();
	const watched = new WeakSet<RTCDataChannel>();
	const bytesFrom = async (data: RtcData): Promise<Uint8Array> => {
		if (typeof data === "string") return new TextEncoder().encode(data);
		if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
		if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
	};
	const capture = (channel: RTCDataChannel, direction: RtcObservation["direction"], data: RtcData): void => {
		const selectedGeneration = generation;
		const selectedOrdinal = ordinal;
		ordinal += 1;
		const operation = bytesFrom(data)
			.then((bytes) => {
				if (selectedGeneration !== generation) return;
				records.push({
					bytes: [...bytes],
					direction,
					label: channel.label,
					maxRetransmits: channel.maxRetransmits,
					ordered: channel.ordered,
					ordinal: selectedOrdinal,
				});
			})
			.finally(() => pending.delete(operation));
		pending.add(operation);
	};
	const watch = (connection: RTCPeerConnection, connectionOrdinal: number, channel: RTCDataChannel): RTCDataChannel => {
		if (watched.has(channel)) return channel;
		watched.add(channel);
		if (channel.label === "ts-drp-ephemeral/1") {
			rawLinks.set(channel, { channel, connection, connectionOrdinal });
		}
		channel.addEventListener("message", (event) => capture(channel, "message", event.data as RtcData));
		return channel;
	};
	const NativePeerConnection = window.RTCPeerConnection;
	const nativeCreateDataChannel = NativePeerConnection.prototype.createDataChannel;
	Object.defineProperty(NativePeerConnection.prototype, "createDataChannel", {
		configurable: true,
		value(this: RTCPeerConnection & { __e4Ordinal?: number }, label: string, options?: RTCDataChannelInit) {
			const connectionOrdinal = this.__e4Ordinal;
			if (connectionOrdinal === undefined) throw new Error("E404_RTC_CONNECTION_UNTRACKED");
			return watch(this, connectionOrdinal, nativeCreateDataChannel.call(this, label, options));
		},
		writable: true,
	});
	const nativeSend = RTCDataChannel.prototype.send;
	Object.defineProperty(RTCDataChannel.prototype, "send", {
		configurable: true,
		value(this: RTCDataChannel, data: RtcData): void {
			capture(this, "send", data);
			Reflect.apply(nativeSend, this, [data]);
		},
		writable: true,
	});
	const ObservedPeerConnection = function (
		...args: ConstructorParameters<typeof RTCPeerConnection>
	): RTCPeerConnection {
		const connection = new NativePeerConnection(...args) as RTCPeerConnection & { __e4Ordinal?: number };
		const connectionOrdinal = nextConnectionOrdinal;
		nextConnectionOrdinal += 1;
		Object.defineProperty(connection, "__e4Ordinal", { value: connectionOrdinal });
		connection.addEventListener("datachannel", (event) => watch(connection, connectionOrdinal, event.channel));
		return connection;
	} as unknown as typeof RTCPeerConnection;
	Object.setPrototypeOf(ObservedPeerConnection, NativePeerConnection);
	ObservedPeerConnection.prototype = NativePeerConnection.prototype;
	Object.defineProperty(window, "RTCPeerConnection", {
		configurable: true,
		value: ObservedPeerConnection,
		writable: true,
	});
	Object.defineProperty(observedWindow, "__E4_RTC_OBSERVER__", {
		configurable: false,
		value: Object.freeze({
			reset(): void {
				generation += 1;
				records.length = 0;
			},
			async sampleBandwidth(): Promise<RtcBandwidthSample> {
				const activeLinks = [...rawLinks.values()].filter(
					({ channel, connection }) =>
						channel.readyState === "open" &&
						(channel.maxRetransmits ?? -1) === 0 &&
						!channel.ordered &&
						connection.connectionState !== "closed" &&
						connection.connectionState !== "failed"
				);
				if (activeLinks.length !== 1) throw new Error("E404_RAW_LINK_AMBIGUOUS");
				const [{ connection, connectionOrdinal }] = activeLinks;
				const stats = await connection.getStats();
				const transports = [...stats.values()].filter(
					(value) => value.type === "transport" && typeof Reflect.get(value, "selectedCandidatePairId") === "string"
				);
				let selectedPairId: string;
				if (transports.length === 1) {
					selectedPairId = Reflect.get(transports[0], "selectedCandidatePairId") as string;
				} else if (transports.length === 0) {
					const pairs = [...stats.values()].filter(
						(value) =>
							value.type === "candidate-pair" &&
							Reflect.get(value, "nominated") === true &&
							Reflect.get(value, "state") === "succeeded"
					);
					if (pairs.length !== 1) throw new Error("E404_SELECTED_PAIR_AMBIGUOUS");
					selectedPairId = pairs[0].id;
				} else {
					throw new Error("E404_SELECTED_TRANSPORT_AMBIGUOUS");
				}
				const pair = stats.get(selectedPairId);
				const bytesReceived = pair === undefined ? undefined : Reflect.get(pair, "bytesReceived");
				if (
					pair?.type !== "candidate-pair" ||
					typeof bytesReceived !== "number" ||
					!Number.isSafeInteger(bytesReceived) ||
					bytesReceived < 0
				) {
					throw new Error("E404_SELECTED_PAIR_COUNTER_INVALID");
				}
				return Object.freeze({
					bytesReceived,
					connectionOrdinal,
					dataChannelOpen: true as const,
					maxRetransmits: 0 as const,
					ordered: false as const,
					selectedPairId,
				});
			},
			async snapshot(): Promise<readonly RtcObservation[]> {
				await Promise.all([...pending]);
				return records.slice().sort((left, right) => left.ordinal - right.ordinal);
			},
		}),
		writable: false,
	});
}

export async function resetRtcObserver(page: Page): Promise<void> {
	await page.evaluate(() => {
		const observer = window.__E4_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E4_RTC_OBSERVER_ABSENT");
		observer.reset();
	});
}

export async function rtcBandwidthSample(page: Page): Promise<RtcBandwidthSample> {
	return page.evaluate(async () => {
		const observer = window.__E4_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E4_RTC_OBSERVER_ABSENT");
		return observer.sampleBandwidth();
	});
}

export async function rtcObservations(page: Page): Promise<readonly RtcObservation[]> {
	return page.evaluate(async () => {
		const observer = window.__E4_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E4_RTC_OBSERVER_ABSENT");
		return observer.snapshot();
	});
}

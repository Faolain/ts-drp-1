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
		readonly iceRestarts: 0;
		readonly maxRetransmits: 0;
		readonly ordered: false;
		readonly peerId: string;
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

interface NetworkSnapshot {
	readonly connections: readonly string[];
	readonly peerId: string;
}

declare global {
	interface Window {
		readonly __E303_RTC_OBSERVER__?: RtcObserver;
		readonly __TS_DRP_GRID_SESSION__?: { snapshot(): GridNetworkSnapshot };
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

interface RtcObserver {
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

interface CampaignEvidence {
	readonly rawTransportDeltas: Readonly<{
		readonly receiver: RawTransportDelta;
		readonly sender: RawTransportDelta;
	}>;
	readonly readyStateMismatches: Readonly<{
		readonly receiver: readonly RtcObservation[];
		readonly sender: readonly RtcObservation[];
	}>;
	readonly receiverWire: readonly PlatformObservation[];
	readonly senderWire: readonly PlatformObservation[];
	readonly trialId: string;
}

interface RawTransportDelta {
	readonly authenticatedConnectionLosses: number;
	readonly lastLinkDrop: Readonly<{
		readonly after: string;
		readonly before: string;
		readonly changed: boolean;
	}>;
	readonly linkDrops: number;
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
	const records: RtcObservation[] = [];
	const pending = new Set<Promise<void>>();
	const channelIdentities = new WeakMap<RTCDataChannel, Readonly<{ channelId: number; connectionId: number }>>();
	const connectionIdentities = new WeakMap<RTCPeerConnection, number>();
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
		channelIdentities.set(channel, Object.freeze({ channelId: nextChannelId, connectionId }));
		nextChannelId += 1;
		channel.addEventListener("message", (event) => capture(channel, "message", event.data as RtcData));
		return channel;
	};
	const NativePeerConnection = window.RTCPeerConnection;
	const nativeCreateDataChannel = NativePeerConnection.prototype.createDataChannel;
	Object.defineProperty(NativePeerConnection.prototype, "createDataChannel", {
		configurable: true,
		value(this: RTCPeerConnection, label: string, options?: RTCDataChannelInit): RTCDataChannel {
			const connectionId = connectionIdentities.get(this);
			if (connectionId === undefined) throw new Error("E303_RTC_CONNECTION_IDENTITY_ABSENT");
			return watch(nativeCreateDataChannel.call(this, label, options), connectionId);
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
		const connection = new NativePeerConnection(...args);
		const connectionId = nextConnectionId;
		nextConnectionId += 1;
		connectionIdentities.set(connection, connectionId);
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
			reset(): void {
				generation += 1;
				records.length = 0;
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
		lastLinkDrop: Object.freeze({
			after: after.lastLinkDrop,
			before: before.lastLinkDrop,
			changed: after.lastLinkDrop !== before.lastLinkDrop,
		}),
		linkDrops: after.linkDrops - before.linkDrops,
	});
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

function expectReliableReceiverSamples(observations: readonly PlatformObservation[]): readonly PlatformObservation[] {
	const wireSamples = observations.filter(({ lane, sentinel }) => lane === "reliable" && !sentinel);
	expect(wireSamples.length).toBeGreaterThan(0);
	expect(wireSamples.map(({ sequence }) => sequence)).toEqual(
		[...wireSamples].map(({ sequence }) => sequence).sort((a, b) => a - b)
	);
	expect(wireSamples.every(({ sequence }) => sequence >= 0 && sequence < SAMPLE_COUNT)).toBe(true);
	const firstBySequence = new Map<number, PlatformObservation>();
	for (const sample of wireSamples) {
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
	_productRoster: readonly FabricObservation[]
): ReceiverEvidencePartition {
	return Object.freeze({
		productAccepted: Object.freeze([...observations]),
		productRejected: Object.freeze([]),
	});
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
	startedAtMs: number,
	deadlineMs: number,
	intervalMs: number,
	sampleCount: number
): RenderedFabricEvidence {
	const raw = acceptedSequencedObservations(observations.filter(({ lane, sentinel }) => lane === "raw" && !sentinel));
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
	return Object.freeze({
		maxGap: rawSequenceEvidence(raw).gap,
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
		observation(0, "raw", 1, 100, "open", "open"),
		observation(1, "raw", 2, 200, "open", "open"),
		observation(2, "reliable", 3, 300, "open", "open"),
		observation(3, "reliable", 3, 301, "open", "open"),
		observation(4, "reliable", 4, 400, "open", "open"),
		observation(5, "reliable", 4, 400, "open", "open"),
		observation(6, "raw", 5, 500, "closing", "closing"),
		observation(7, "raw", 6, 600, "closing", "open"),
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
		productObservation(observations[0] as PlatformObservation, 2_000),
		productObservation(observations[2] as PlatformObservation, 2_001),
		productObservation(observations[4] as PlatformObservation, 2_002),
		productObservation(observations[6] as PlatformObservation, 2_003),
	]);
	const partition = partitionReceiverEvidence(observations, productRoster);

	expect(partition).toEqual({
		productAccepted: [observations[0], observations[2], observations[4], observations[6]],
		productRejected: [observations[1], observations[3], observations[5], observations[7]],
	});
	for (const accepted of partition.productAccepted) {
		expect(observations).toContain(accepted);
	}
	expect(
		[...partition.productAccepted, ...partition.productRejected].sort((left, right) => left.ordinal - right.ordinal)
	).toEqual(observations);
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
	]);
	const applicationRaw = acceptedSequencedObservations(observations.filter(({ lane }) => lane === "raw"));
	const applicationReliable = observations.filter(({ lane }) => lane === "reliable");

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
	expect(renderedProductRosterMetrics(observations, 0, 700, 100, SAMPLE_COUNT)).toEqual({
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

		const metrics: CampaignMetric[] = [];
		const campaignEvidence: CampaignEvidence[] = [];
		for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
			const trialId = "e3-03-" + String(trial);
			activeTrialId = trialId;
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
			expect(clock.maximumSkewMs).toBeLessThanOrEqual(20);
			const receiverRawBefore = await rawReceivedAfterQuiescence(receiver);
			const [senderRawTransportBefore, receiverRawTransportBefore] = await Promise.all([
				zone(creator).then(({ rawTransport }) => rawTransport),
				zone(receiver).then(({ rawTransport }) => rawTransport),
			]);
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
			const senderRawAfter = await rawSentAfterQuiescence(creator);
			const senderRtc = await rtcObservations(creator);
			const senderWire = platformObservations(senderRtc, "send", trialId);
			const senderRawCandidateCount = senderWire.filter(({ lane, sentinel }) => lane === "raw" && !sentinel).length;
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
			const receiverAtDeadline = await receiverEvidenceAtDeadline(receiver, trialId);
			const senderRawTransportAtDeadline = (await zone(creator)).rawTransport;
			const receiverWire = platformObservations(receiverAtDeadline.rtc, "message", trialId).filter(
				({ receivedAtMs }) => receivedAtMs <= deadlineMs
			);
			stage = trialId + "-reset";
			await applyProfile(trialId + "-reset", NO_LOSS);
			await waitForOpenTransportPair(creator, receiver);
			await waitForNetworkPair(creator, receiver, initialCreatorNetwork, initialReceiverNetwork);
			const [senderSnapshot, receiverSnapshot] = await Promise.all([
				fabricSnapshot(creator, trialId),
				fabricSnapshot(receiver, trialId),
			]);
			expect(senderSnapshot.attempted).toEqual({ raw: SAMPLE_COUNT, reliable: SAMPLE_COUNT });
			expectOpenTransport(senderSnapshot, peers.receiverPeerId);
			expectOpenTransport(receiverSnapshot, peers.creatorPeerId);

			stage = trialId + "-assertions";
			const rawWire = expectRawReceiverSamples(receiverWire);
			const raw = acceptedSequencedObservations(rawWire);
			const reliable = expectReliableReceiverSamples(receiverWire);
			expect(receiverWire.filter(({ lane, sentinel }) => lane === "reliable" && sentinel)).toEqual([]);
			expect(rawWire.length).toBeGreaterThan(0);
			expect(raw.length).toBeGreaterThan(0);
			expect(senderRawAfter - senderRawBefore).toBe(senderRaw.length);
			expect(receiverAtDeadline.zone.rawTransport.received - receiverRawBefore).toBe(rawWire.length);
			expect(
				[...senderRaw, ...rawWire].every(
					({ byteLength, carrierByteLength, channelLabel, maxRetransmits, ordered, readyState }) =>
						byteLength === SAMPLE_PAYLOAD_BYTES &&
						carrierByteLength >= byteLength &&
						carrierByteLength <= byteLength + 1_024 &&
						channelLabel === "ts-drp-ephemeral/1" &&
						maxRetransmits === 0 &&
						!ordered &&
						readyState === "open"
				)
			).toBe(true);
			expect(
				[...senderReliable, ...reliable].every(
					({ byteLength, carrierByteLength, channelLabel, maxRetransmits, ordered, readyState }) =>
						byteLength === SAMPLE_PAYLOAD_BYTES &&
						carrierByteLength >= byteLength &&
						carrierByteLength <= byteLength + 1_024 &&
						channelLabel === "" &&
						maxRetransmits === null &&
						ordered &&
						readyState === "open"
				)
			).toBe(true);
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
			const receiverSequence = rawSequenceEvidence(raw);
			const senderSequence = rawSequenceEvidence(senderRaw);
			expect(receiverSequence.gap).toBeGreaterThan(1);
			expect(senderSequence.maxStallMs).toBeLessThanOrEqual(500);
			const rawAoI = ageOfInformation(raw, campaignStartedAtMs, deadlineMs, SAMPLE_INTERVAL_MS);
			const reliableAoI = ageOfInformation(reliable, campaignStartedAtMs, deadlineMs, SAMPLE_INTERVAL_MS);
			const rawAoIP50Ms = percentile(rawAoI, 0.5);
			const rawAoIP95Ms = percentile(rawAoI, 0.95);
			const reliableAoIP50Ms = percentile(reliableAoI, 0.5);
			const reliableAoIP95Ms = percentile(reliableAoI, 0.95);
			expect(rawAoIP95Ms).toBeLessThanOrEqual(reliableAoIP95Ms * 0.8);
			const firstReliableReceivedAtMs = reliable[0]?.receivedAtMs;
			if (firstReliableReceivedAtMs === undefined) throw new Error("E303_RELIABLE_OBSERVATION_ABSENT");
			const rawDeliveredAfterReliableStart = raw.filter(
				({ receivedAtMs }) => receivedAtMs > firstReliableReceivedAtMs
			).length;
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
					trialId,
				})
			);
			campaignEvidence.push(
				Object.freeze({
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
					receiverWire,
					senderWire,
					trialId,
				})
			);
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
			expect(Math.abs(renderedRawP50 - metric.rawAoIP50Ms)).toBeLessThanOrEqual(10);
			expect(Math.abs(renderedRawP95 - metric.rawAoIP95Ms)).toBeLessThanOrEqual(10);
			expect(Math.abs(renderedReliableP50 - metric.reliableAoIP50Ms)).toBeLessThanOrEqual(10);
			expect(Math.abs(renderedReliableP95 - metric.reliableAoIP95Ms)).toBeLessThanOrEqual(10);
			expect(renderedRawP95).toBeLessThanOrEqual(renderedReliableP95 * 0.8);
			await expect(row.locator('[data-metric="max-gap"]')).toHaveText(String(metric.rawGap));
			await expect(row.locator('[data-metric="raw-delivered"]')).toHaveText(String(metric.rawDelivered));
			await expect(row.locator('[data-metric="raw-dropped"]')).toHaveText(String(SAMPLE_COUNT - metric.rawDelivered));
			await expect(row.locator('[data-metric="reliable-delivered"]')).toHaveText(String(metric.reliableDelivered));
			await expect(row.locator('[data-metric="reliable-dropped"]')).toHaveText(
				String(SAMPLE_COUNT - metric.reliableDelivered)
			);
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
			cdpEvidence,
			creator: creatorEvidence,
			error: diagnosticError(error),
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

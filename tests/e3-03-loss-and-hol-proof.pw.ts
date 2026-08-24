import { type CDPSession, expect, type Page, test, type TestInfo } from "@playwright/test";

const BROWSER_VERSION = "151.0.7922.34";
const CALIBRATION_LOSS_PERCENT = 100;
const CAMPAIGN_LOSS_PERCENT = 30;
const LATENCY_MS = 40;
const PACKET_QUEUE_LENGTH = 20;
const PRELIMINARY_RAW_DELIVERY_FLOOR = 100;
const SAMPLE_COUNT = 600;
const SAMPLE_INTERVAL_MS = 33;
const SAMPLE_PAYLOAD_BYTES = 256;
const RELIABLE_SENTINEL_BYTES = 12_000;
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
	readonly transport: FabricTransportEvidence;
	readonly trialId: string;
}

interface FabricWorkbench {
	reset(trialId: string): void;
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
		readonly fallbackCount: 0;
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
	readonly rawSentBeforeReliableSentinel: number;
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
	readonly maxRetransmits: number | null;
	readonly ordered: boolean;
	readonly ordinal: number;
	readonly readyState: RTCDataChannelState;
}

interface CampaignEvidence {
	readonly receiverWire: readonly PlatformObservation[];
	readonly senderWire: readonly PlatformObservation[];
	readonly trialId: string;
}

const NO_LOSS = Object.freeze({
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
		const operation = bytesFrom(data)
			.then((bytes) => {
				if (selectedGeneration !== generation) return;
				records.push({
					atMs,
					byteLength: bytes.byteLength,
					channelId: identity.channelId,
					connectionId: identity.connectionId,
					direction,
					label: channel.label,
					maxRetransmits: channel.maxRetransmits,
					ordered: channel.ordered,
					ordinal: selectedOrdinal,
					readyState: channel.readyState,
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

function lossProfile(packetLoss: number): Readonly<Record<string, boolean | number | string>> {
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

async function emulate(
	session: CDPSession,
	profile: Readonly<Record<string, boolean | number | string>>
): Promise<readonly string[]> {
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

function expectExactSamples(
	observations: readonly PlatformObservation[],
	lane: FabricObservation["lane"]
): readonly PlatformObservation[] {
	const samples = observations.filter((observation) => observation.lane === lane && !observation.sentinel);
	expect(samples).toHaveLength(SAMPLE_COUNT);
	expect([...samples].sort((left, right) => left.sequence - right.sequence).map(({ sequence }) => sequence)).toEqual(
		Array.from({ length: SAMPLE_COUNT }, (_, index) => index)
	);
	return samples;
}

function expectRawReceiverSamples(observations: readonly PlatformObservation[]): readonly PlatformObservation[] {
	const samples = observations.filter(({ lane, sentinel }) => lane === "raw" && !sentinel);
	expect(new Set(samples.map(({ sequence }) => sequence)).size).toBe(samples.length);
	expect(samples.every(({ sequence }) => sequence >= 0 && sequence < SAMPLE_COUNT)).toBe(true);
	return samples;
}

function expectReliableSentinel(observations: readonly PlatformObservation[]): PlatformObservation {
	const sentinels = observations.filter(({ lane, sentinel }) => lane === "reliable" && sentinel);
	expect(sentinels).toHaveLength(1);
	const sentinel = sentinels[0];
	expect(sentinel?.sequence).toBe(SAMPLE_COUNT);
	if (sentinel === undefined) throw new Error("E303_RELIABLE_SENTINEL_ABSENT");
	return sentinel;
}

function acceptedSequencedObservations(observations: readonly PlatformObservation[]): readonly PlatformObservation[] {
	const accepted: PlatformObservation[] = [];
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
	deadlineMs: number
): readonly number[] {
	const delivered = observations
		.filter(({ sentinel }) => !sentinel)
		.sort((left, right) => left.receivedAtMs - right.receivedAtMs);
	const ages: number[] = [];
	let cursor = 0;
	let freshestSentAt = startedAtMs;
	for (let sampledAt = startedAtMs; sampledAt <= deadlineMs; sampledAt += SAMPLE_INTERVAL_MS) {
		while (cursor < delivered.length && (delivered[cursor]?.receivedAtMs ?? Number.POSITIVE_INFINITY) <= sampledAt) {
			freshestSentAt = Math.max(freshestSentAt, delivered[cursor]?.sentAtMs ?? freshestSentAt);
			cursor += 1;
		}
		ages.push(sampledAt - freshestSentAt);
	}
	return ages;
}

function rawSequenceEvidence(
	observations: readonly FabricObservation[],
	startedAtMs: number,
	completedAtMs: number
): Readonly<{ gap: number; maxStallMs: number }> {
	const received = observations
		.filter(({ lane, sentinel }) => lane === "raw" && !sentinel)
		.sort((left, right) => left.receivedAtMs - right.receivedAtMs);
	let gap = 0;
	let maxStallMs = Math.max(
		(received[0]?.receivedAtMs ?? completedAtMs) - startedAtMs,
		completedAtMs - (received.at(-1)?.receivedAtMs ?? startedAtMs)
	);
	for (let index = 1; index < received.length; index += 1) {
		const previous = received[index - 1];
		const current = received[index];
		if (previous === undefined || current === undefined) continue;
		expect(current.sequence).toBeGreaterThan(previous.sequence);
		gap = Math.max(gap, current.sequence - previous.sequence);
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

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
	await testInfo.attach(name, { body: JSON.stringify(value, undefined, 2), contentType: "application/json" });
}

test("three fixed browser trials prove raw freshness and no head-of-line blocking under 30% loss", async ({
	browser,
}, testInfo) => {
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
			readonly profile: Readonly<Record<string, boolean | number | string>>;
			readonly ruleIds: readonly string[];
		}>
	> = [];
	const applyProfile = async (
		label: string,
		profile: Readonly<Record<string, boolean | number | string>>
	): Promise<void> => {
		const ruleIds = await emulate(cdp, profile);
		cdpEvidence.push(Object.freeze({ label, profile, ruleIds: Object.freeze([...ruleIds]) }));
	};
	try {
		await cdp.send("Network.enable");
		// The global profile must exist before Chromium creates either peer-to-peer socket.
		await applyProfile("pre-signaling-capability", NO_LOSS);
		expect(cdpEvidence[0]?.ruleIds).toHaveLength(1);
		await Promise.all([openGrid(creator), openGrid(receiver)]);
		const peers = await createZone(creator, receiver);
		const initialCreatorNetwork = await network(creator);
		const initialReceiverNetwork = await network(receiver);
		const initialCreatorLinks = (await zone(creator)).rawTransport.links;
		const initialReceiverLinks = (await zone(receiver)).rawTransport.links;

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
		await applyProfile("preliminary-reset", NO_LOSS);
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

		const calibrationTrialId = "e3-03-total-loss-calibration";
		await Promise.all(
			[creator, receiver].map((page) =>
				page.evaluate(
					(selectedTrialId) => window.__TS_DRP_V3_ZONE__?.fabric?.reset(selectedTrialId),
					calibrationTrialId
				)
			)
		);
		await Promise.all([resetRtcObserver(creator), resetRtcObserver(receiver)]);
		expectOpenTransport(await fabricSnapshot(creator, calibrationTrialId), peers.receiverPeerId);
		expectOpenTransport(await fabricSnapshot(receiver, calibrationTrialId), peers.creatorPeerId);
		await applyProfile("workbench-total-loss", lossProfile(CALIBRATION_LOSS_PERCENT));
		const workbenchCalibration = creator.evaluate((input) => window.__TS_DRP_V3_ZONE__?.fabric?.runTrial(input), {
			intervalMs: 20,
			payloadFormat: "e3-03-ascii-v1" as const,
			payloadBytes: SAMPLE_PAYLOAD_BYTES,
			reliableSentinelBytes: RELIABLE_SENTINEL_BYTES,
			sampleCount: 30,
			trialId: calibrationTrialId,
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
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
		expect(platformObservations(await rtcObservations(receiver), "message", calibrationTrialId)).toEqual([]);
		expectOpenTransport(duringWorkbenchCalibration, peers.creatorPeerId);
		expect((await zone(creator)).rawTransport.links).toEqual(initialCreatorLinks);
		expect((await zone(receiver)).rawTransport.links).toEqual(initialReceiverLinks);
		expect(await network(creator)).toEqual(initialCreatorNetwork);
		expect(await network(receiver)).toEqual(initialReceiverNetwork);
		await applyProfile("workbench-total-loss-reset", NO_LOSS);
		await workbenchCalibration;

		const metrics: CampaignMetric[] = [];
		const campaignEvidence: CampaignEvidence[] = [];
		for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
			const trialId = "e3-03-" + String(trial);
			await Promise.all(
				[creator, receiver].map((page) =>
					page.evaluate((selectedTrialId) => window.__TS_DRP_V3_ZONE__?.fabric?.reset(selectedTrialId), trialId)
				)
			);
			await Promise.all([resetRtcObserver(creator), resetRtcObserver(receiver)]);
			const clock = await clockEvidence(creator, receiver);
			expect(clock.maximumSkewMs).toBeLessThanOrEqual(5);
			const senderRawBefore = (await zone(creator)).rawTransport.sent;
			const receiverRawBefore = (await zone(receiver)).rawTransport.received;
			await applyProfile(trialId + "-thirty-percent", lossProfile(CAMPAIGN_LOSS_PERCENT));
			await creator.evaluate((input) => window.__TS_DRP_V3_ZONE__?.fabric?.runTrial(input), {
				intervalMs: SAMPLE_INTERVAL_MS,
				payloadFormat: "e3-03-ascii-v1" as const,
				payloadBytes: SAMPLE_PAYLOAD_BYTES,
				reliableSentinelBytes: RELIABLE_SENTINEL_BYTES,
				sampleCount: SAMPLE_COUNT,
				trialId,
			});
			const runTrialReturnedAtMs = await creator.evaluate(() => Date.now());
			await expect
				.poll(
					async () => {
						const reliable = platformObservations(await rtcObservations(receiver), "message", trialId).filter(
							({ lane }) => lane === "reliable"
						);
						return {
							samples: reliable.filter(({ sentinel }) => !sentinel).length,
							sentinels: reliable.filter(({ sentinel }) => sentinel).length,
						};
					},
					{ timeout: 15_000 }
				)
				.toEqual({ samples: SAMPLE_COUNT, sentinels: 1 });
			await applyProfile(trialId + "-reset", NO_LOSS);
			const [senderSnapshot, receiverSnapshot] = await Promise.all([
				fabricSnapshot(creator, trialId),
				fabricSnapshot(receiver, trialId),
			]);
			expect(senderSnapshot.attempted).toEqual({ raw: SAMPLE_COUNT, reliable: SAMPLE_COUNT });
			expectOpenTransport(senderSnapshot, peers.receiverPeerId);
			expectOpenTransport(receiverSnapshot, peers.creatorPeerId);

			const senderWire = platformObservations(await rtcObservations(creator), "send", trialId);
			const receiverWire = platformObservations(await rtcObservations(receiver), "message", trialId);
			const senderRaw = expectExactSamples(senderWire, "raw");
			const senderReliable = expectExactSamples(senderWire, "reliable");
			const senderSentinel = expectReliableSentinel(senderWire);
			const rawWire = expectRawReceiverSamples(receiverWire);
			const raw = acceptedSequencedObservations(rawWire);
			const reliable = expectExactSamples(receiverWire, "reliable");
			const sentinel = expectReliableSentinel(receiverWire);
			expect(raw.length).toBeGreaterThanOrEqual(PRELIMINARY_RAW_DELIVERY_FLOOR);
			expect((await zone(creator)).rawTransport.sent - senderRawBefore).toBe(SAMPLE_COUNT);
			expect((await zone(receiver)).rawTransport.received - receiverRawBefore).toBe(rawWire.length);
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
				[senderSentinel, sentinel].every(
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
			expect(new Set(senderRaw.map(({ connectionId }) => connectionId)).size).toBe(1);
			expect(new Set(rawWire.map(({ connectionId }) => connectionId)).size).toBe(1);
			expect(new Set([...senderReliable, senderSentinel].map(({ connectionId }) => connectionId)).size).toBe(1);
			expect(new Set([...reliable, sentinel].map(({ connectionId }) => connectionId)).size).toBe(1);
			expect(senderWire.every(({ receivedAtMs, sentAtMs }) => Math.abs(receivedAtMs - sentAtMs) <= 5)).toBe(true);
			const scheduledRaw = [...senderRaw].sort((left, right) => left.sequence - right.sequence);
			const scheduledReliable = [...senderReliable].sort((left, right) => left.sequence - right.sequence);
			const campaignStartedAtMs = Math.min(
				scheduledRaw[0]?.receivedAtMs ?? Number.POSITIVE_INFINITY,
				scheduledReliable[0]?.receivedAtMs ?? Number.POSITIVE_INFINITY
			);
			const senderCompletedAtMs = Math.max(
				scheduledRaw.at(-1)?.receivedAtMs ?? 0,
				scheduledReliable.at(-1)?.receivedAtMs ?? 0,
				senderSentinel.receivedAtMs
			);
			const expectedCampaignSpanMs = (SAMPLE_COUNT - 1) * SAMPLE_INTERVAL_MS;
			expect(senderCompletedAtMs - campaignStartedAtMs).toBeGreaterThanOrEqual(expectedCampaignSpanMs - 1_000);
			expect(
				scheduledRaw.every(
					({ receivedAtMs, sequence }) =>
						Math.abs(receivedAtMs - campaignStartedAtMs - sequence * SAMPLE_INTERVAL_MS) <= 1_000
				)
			).toBe(true);
			expect(
				scheduledReliable.every(
					({ receivedAtMs, sequence }) =>
						Math.abs(receivedAtMs - campaignStartedAtMs - sequence * SAMPLE_INTERVAL_MS) <= 1_000
				)
			).toBe(true);
			expect(runTrialReturnedAtMs).toBeGreaterThanOrEqual(senderCompletedAtMs);
			const deadlineMs = Math.max(runTrialReturnedAtMs, sentinel.receivedAtMs);
			const sequence = rawSequenceEvidence(raw, campaignStartedAtMs, senderCompletedAtMs);
			expect(sequence.gap).toBeGreaterThan(1);
			expect(sequence.maxStallMs).toBeLessThanOrEqual(500);
			const rawAoI = ageOfInformation(raw, campaignStartedAtMs, deadlineMs);
			const reliableAoI = ageOfInformation(reliable, campaignStartedAtMs, deadlineMs);
			const rawAoIP50Ms = percentile(rawAoI, 0.5);
			const rawAoIP95Ms = percentile(rawAoI, 0.95);
			const reliableAoIP50Ms = percentile(reliableAoI, 0.5);
			const reliableAoIP95Ms = percentile(reliableAoI, 0.95);
			expect(rawAoIP95Ms).toBeLessThanOrEqual(reliableAoIP95Ms * 0.8);
			const rawSentBeforeReliableSentinel = raw.filter(
				({ receivedAtMs, sentAtMs }) => receivedAtMs < sentinel.receivedAtMs && sentAtMs > sentinel.sentAtMs
			).length;
			expect(rawSentBeforeReliableSentinel).toBeGreaterThanOrEqual(10);
			metrics.push(
				Object.freeze({
					clockSamples: clock.samples,
					clockSkewMs: clock.maximumSkewMs,
					rawAoIP50Ms,
					rawAoIP95Ms,
					rawDelivered: raw.length,
					rawGap: sequence.gap,
					rawMaxStallMs: sequence.maxStallMs,
					rawSentBeforeReliableSentinel,
					reliableAoIP50Ms,
					reliableAoIP95Ms,
					reliableDelivered: reliable.length,
					trialId,
				})
			);
			campaignEvidence.push(Object.freeze({ receiverWire, senderWire, trialId }));
		}
		expect(
			new Set(
				campaignEvidence.flatMap(({ senderWire }) =>
					senderWire.filter(({ lane }) => lane === "raw").map(({ connectionId }) => connectionId)
				)
			)
		).toEqual(calibrationRawConnections);
		expect(
			new Set(
				campaignEvidence.flatMap(({ senderWire }) =>
					senderWire.filter(({ lane }) => lane === "reliable").map(({ connectionId }) => connectionId)
				)
			)
		).toEqual(calibrationReliableConnections);
		expect(
			new Set(
				campaignEvidence.flatMap(({ receiverWire }) =>
					receiverWire.filter(({ lane }) => lane === "raw").map(({ connectionId }) => connectionId)
				)
			).size
		).toBe(1);
		expect(
			new Set(
				campaignEvidence.flatMap(({ receiverWire }) =>
					receiverWire.filter(({ lane }) => lane === "reliable").map(({ connectionId }) => connectionId)
				)
			).size
		).toBe(1);

		expect((await zone(creator)).durableVertexCount).toBe(peers.durableBaseline);
		expect((await zone(receiver)).durableVertexCount).toBe(peers.durableBaseline);
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
	} finally {
		await emulate(cdp, NO_LOSS).catch(() => undefined);
		await Promise.allSettled([
			creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
			receiver.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
		]);
		await Promise.allSettled([creatorContext.close(), receiverContext.close()]);
	}
});

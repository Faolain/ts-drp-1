import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { existsSync } from "node:fs";

const OWNER_READY = existsSync("packages/ephemeral/src/aoi-projection.ts");
const LOSS_PERCENT = 30;
const SAMPLE_INTERVAL_MS = 33;

interface Entity {
	readonly entityId: number;
	readonly sequence: number;
	readonly x: number;
	readonly y: number;
}

interface ProjectionPacket {
	readonly baseKeyframeId: number;
	readonly baseKeyframeSequence: number;
	readonly batchId: number;
	readonly chunkCount: number;
	readonly chunkIndex: number;
	readonly generation: number;
	readonly kind: 1 | 2;
	readonly sequence: number;
}

interface RtcObservation {
	readonly bytes: readonly number[];
	readonly direction: "message" | "send";
	readonly label: string;
	readonly maxRetransmits: number | null;
	readonly ordered: boolean;
	readonly ordinal: number;
}

interface RtcObserver {
	reset(): void;
	snapshot(): Promise<readonly RtcObservation[]>;
}

interface ZoneSnapshot {
	readonly aoiPopulations: Readonly<Record<string, readonly Entity[]>>;
	readonly aoiProjection: Readonly<
		Record<
			string,
			Readonly<{
				readonly baseKeyframeId: number | null;
				readonly baseKeyframeSequence: number | null;
				readonly generation: number | null;
				readonly lastSequence: number | null;
				readonly waitingForKeyframe: boolean;
			}>
		>
	>;
	readonly blocks: readonly Readonly<{
		readonly id: string;
		readonly kind: string;
		readonly x: number;
		readonly y: number;
	}>[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localPeerId: string;
	readonly rawTransport: Readonly<{
		readonly fallbackCount: 0;
		readonly links: readonly Readonly<{ readonly peerId: string }>[];
	}>;
	readonly zoneId: string;
}

interface ZoneApi {
	close(): Promise<void>;
	create(memberEnrollments: readonly string[]): Promise<void>;
	join(invite: string): Promise<void>;
	placeBlock(
		input: Readonly<{ readonly id: string; readonly kind: string; readonly x: number; readonly y: number }>
	): Promise<void>;
	publishAoiPopulation(
		input: Readonly<{
			readonly entities: readonly Entity[];
			readonly observerPeerId: string;
			readonly observerX: number;
			readonly observerY: number;
			readonly radius: number;
		}>
	): Promise<boolean>;
	snapshot(): ZoneSnapshot;
}

declare global {
	interface Window {
		readonly __E403_RTC_OBSERVER__?: RtcObserver;
		readonly __TS_DRP_V3_ZONE__?: ZoneApi;
	}
}

function installRtcObserver(): void {
	type RtcData = string | Blob | ArrayBuffer | ArrayBufferView;
	const observedWindow = window as Window & { __E403_RTC_OBSERVER__?: RtcObserver };
	if (observedWindow.__E403_RTC_OBSERVER__ !== undefined) return;
	let generation = 0;
	let ordinal = 0;
	const records: RtcObservation[] = [];
	const pending = new Set<Promise<void>>();
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
	const watch = (channel: RTCDataChannel): RTCDataChannel => {
		if (watched.has(channel)) return channel;
		watched.add(channel);
		channel.addEventListener("message", (event) => capture(channel, "message", event.data as RtcData));
		return channel;
	};
	const NativePeerConnection = window.RTCPeerConnection;
	const nativeCreateDataChannel = NativePeerConnection.prototype.createDataChannel;
	Object.defineProperty(NativePeerConnection.prototype, "createDataChannel", {
		configurable: true,
		value(this: RTCPeerConnection, label: string, options?: RTCDataChannelInit): RTCDataChannel {
			return watch(nativeCreateDataChannel.call(this, label, options));
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
		connection.addEventListener("datachannel", (event) => watch(event.channel));
		return connection;
	} as unknown as typeof RTCPeerConnection;
	Object.setPrototypeOf(ObservedPeerConnection, NativePeerConnection);
	ObservedPeerConnection.prototype = NativePeerConnection.prototype;
	Object.defineProperty(window, "RTCPeerConnection", {
		configurable: true,
		value: ObservedPeerConnection,
		writable: true,
	});
	Object.defineProperty(observedWindow, "__E403_RTC_OBSERVER__", {
		configurable: false,
		value: Object.freeze({
			reset(): void {
				generation += 1;
				records.length = 0;
			},
			async snapshot(): Promise<readonly RtcObservation[]> {
				await Promise.all([...pending]);
				return records.slice().sort((left, right) => left.ordinal - right.ordinal);
			},
		}),
		writable: false,
	});
}

function networkProfile(packetLoss: number): Readonly<Record<string, boolean | number | string>> {
	return Object.freeze({
		connectionType: "wifi",
		downloadThroughput: -1,
		latency: 40,
		offline: false,
		packetLoss,
		packetQueueLength: 10,
		packetReordering: packetLoss > 0,
		uploadThroughput: -1,
	});
}

async function emulateLoss(session: CDPSession, packetLoss: number): Promise<readonly string[]> {
	const { ruleIds } = await session.send("Network.emulateNetworkConditionsByRule", {
		matchedNetworkConditions: [{ ...networkProfile(packetLoss), urlPattern: "" }],
	});
	return ruleIds;
}

function decodeProjectionPacket(bytes: Uint8Array): ProjectionPacket | undefined {
	if (bytes.byteLength < 25 || bytes[0] !== 1 || (bytes[1] !== 1 && bytes[1] !== 2)) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const recordCount = view.getUint8(24);
	const chunkIndex = view.getUint8(22);
	const chunkCount = view.getUint8(23);
	if (bytes.byteLength !== 25 + recordCount * 17 || chunkCount < 1 || chunkCount > 32 || chunkIndex >= chunkCount) {
		return undefined;
	}
	for (let index = 0; index < recordCount; index += 1) {
		const offset = 25 + index * 17;
		const operation = view.getUint8(offset);
		if (operation !== 1 && operation !== 2) return undefined;
		if (operation === 2 && (view.getInt32(offset + 9, false) !== 0 || view.getInt32(offset + 13, false) !== 0)) {
			return undefined;
		}
	}
	return Object.freeze({
		baseKeyframeId: view.getUint32(14, false),
		baseKeyframeSequence: view.getUint32(18, false),
		batchId: view.getUint32(6, false),
		chunkCount,
		chunkIndex,
		generation: view.getUint32(2, false),
		kind: view.getUint8(1) as 1 | 2,
		sequence: view.getUint32(10, false),
	});
}

function projectionPacketFromCarrier(carrier: readonly number[]): ProjectionPacket | undefined {
	const bytes = Uint8Array.from(carrier);
	const matches: ProjectionPacket[] = [];
	for (let offset = 0; offset <= bytes.byteLength - 25; offset += 1) {
		const decoded = decodeProjectionPacket(bytes.subarray(offset));
		if (decoded !== undefined) matches.push(decoded);
	}
	if (matches.length > 1) throw new Error("E403_AMBIGUOUS_PROJECTION_CARRIER");
	return matches[0];
}

function projectionPackets(
	records: readonly RtcObservation[],
	direction: RtcObservation["direction"]
): readonly ProjectionPacket[] {
	return records
		.filter(
			(record) =>
				record.direction === direction &&
				record.label === "ts-drp-ephemeral/1" &&
				record.maxRetransmits === 0 &&
				!record.ordered
		)
		.map(({ bytes }) => projectionPacketFromCarrier(bytes))
		.filter((packet): packet is ProjectionPacket => packet !== undefined);
}

async function resetRtcObserver(page: Page): Promise<void> {
	await page.evaluate(() => {
		const observer = window.__E403_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E403_RTC_OBSERVER_ABSENT");
		observer.reset();
	});
}

async function rtcObservations(page: Page): Promise<readonly RtcObservation[]> {
	return page.evaluate(async () => {
		const observer = window.__E403_RTC_OBSERVER__;
		if (observer === undefined) throw new Error("E403_RTC_OBSERVER_ABSENT");
		return observer.snapshot();
	});
}

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => window.__TS_DRP_V3_ZONE__ !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
}

async function zone(page: Page): Promise<ZoneSnapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("E403_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

async function publishCampaign(
	page: Page,
	observerPeerId: string,
	startSequence: number,
	count: number
): Promise<void> {
	await page.evaluate(
		async ({ observerId, sampleCount, sequenceStart }) => {
			const api = window.__TS_DRP_V3_ZONE__;
			if (api === undefined) throw new Error("E403_ZONE_API_ABSENT");
			for (let offset = 0; offset < sampleCount; offset += 1) {
				const sequence = sequenceStart + offset;
				const accepted = await api.publishAoiPopulation({
					entities: Array.from({ length: 34 }, (_, index) => ({
						entityId: index + 1,
						sequence,
						x: index + sequence,
						y: index,
					})),
					observerPeerId: observerId,
					observerX: sequence,
					observerY: 0,
					radius: 64,
				});
				if (!accepted) throw new Error("E403_TARGETED_PUBLICATION_REJECTED");
				await new Promise((resolve) => setTimeout(resolve, 33));
			}
		},
		{ observerId: observerPeerId, sampleCount: count, sequenceStart: startSequence }
	);
}

test.skip(!OWNER_READY, "E4-03 GREEN is dormant until the AOI projection owner exists");

test("three real clients recover targeted AOI state after raw loss without durable projection", async ({ browser }) => {
	test.setTimeout(300_000);
	const creatorContext = await browser.newContext();
	const observerContext = await browser.newContext();
	const excludedContext = await browser.newContext();
	await Promise.all([
		creatorContext.addInitScript(installRtcObserver),
		observerContext.addInitScript(installRtcObserver),
		excludedContext.addInitScript(installRtcObserver),
	]);
	const creator = await creatorContext.newPage();
	const observer = await observerContext.newPage();
	const excluded = await excludedContext.newPage();
	const lossSession = await creatorContext.newCDPSession(creator);
	try {
		await lossSession.send("Network.enable");
		expect(await emulateLoss(lossSession, 0)).toHaveLength(1);
		await Promise.all([openGrid(creator), openGrid(observer), openGrid(excluded)]);
		const observerEnrollment = (await zone(observer)).enrollment;
		const excludedEnrollment = (await zone(excluded)).enrollment;
		await creator.evaluate(
			async ({ excludedMember, observerMember }) => {
				const api = window.__TS_DRP_V3_ZONE__;
				if (api === undefined) throw new Error("E403_ZONE_API_ABSENT");
				await api.create([observerMember, excludedMember]);
			},
			{ excludedMember: excludedEnrollment, observerMember: observerEnrollment }
		);
		const created = await zone(creator);
		await Promise.all([
			observer.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite),
			excluded.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite),
		]);
		const observerPeerId = (await zone(observer)).localPeerId;
		const excludedPeerId = (await zone(excluded)).localPeerId;
		await expect
			.poll(async () => (await zone(creator)).rawTransport.links.map(({ peerId }) => peerId).sort())
			.toEqual([excludedPeerId, observerPeerId].sort());
		const creatorPeerId = (await zone(creator)).localPeerId;
		const durableBaseline = (await zone(creator)).durableVertexCount;

		await Promise.all([resetRtcObserver(creator), resetRtcObserver(observer)]);
		await publishCampaign(creator, observerPeerId, 0, 31);
		await expect.poll(async () => (await zone(observer)).aoiProjection[creatorPeerId]?.lastSequence).toBe(30);
		const installedSnapshot = await zone(observer);
		const installed = installedSnapshot.aoiPopulations[creatorPeerId];
		expect(installedSnapshot.aoiProjection[creatorPeerId]).toMatchObject({
			baseKeyframeId: 30,
			baseKeyframeSequence: 30,
			lastSequence: 30,
			waitingForKeyframe: false,
		});
		const initialSenderPackets = projectionPackets(await rtcObservations(creator), "send");
		const initialReceiverPackets = projectionPackets(await rtcObservations(observer), "message");
		expect(initialSenderPackets.map(({ sequence }) => sequence)).toEqual(
			Array.from({ length: 31 }, (_value, sequence) => sequence)
		);
		const initialSenderBySequence = new Map(initialSenderPackets.map((packet) => [packet.sequence, packet]));
		expect(initialReceiverPackets.length).toBeGreaterThan(0);
		expect(new Set(initialReceiverPackets.map(({ sequence }) => sequence)).size).toBe(initialReceiverPackets.length);
		for (const packet of initialReceiverPackets) expect(packet).toEqual(initialSenderBySequence.get(packet.sequence));
		expect(initialReceiverPackets.find(({ sequence }) => sequence === 30)).toMatchObject({
			baseKeyframeId: 30,
			baseKeyframeSequence: 30,
			batchId: 30,
			kind: 1,
			sequence: 30,
		});
		expect(initialSenderPackets[0]).toMatchObject({
			baseKeyframeId: 0,
			baseKeyframeSequence: 0,
			batchId: 0,
			chunkCount: 1,
			chunkIndex: 0,
			kind: 1,
			sequence: 0,
		});
		expect(
			initialSenderPackets.slice(1, 30).every(({ baseKeyframeId, kind }) => baseKeyframeId === 0 && kind === 2)
		).toBe(true);
		expect(initialSenderPackets[30]).toMatchObject({
			baseKeyframeId: 30,
			baseKeyframeSequence: 30,
			batchId: 30,
			kind: 1,
			sequence: 30,
		});

		await Promise.all([resetRtcObserver(creator), resetRtcObserver(observer)]);
		expect(await emulateLoss(lossSession, 100)).toHaveLength(1);
		await publishCampaign(creator, observerPeerId, 31, 5);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect((await zone(observer)).aoiPopulations[creatorPeerId]).toEqual(installed);
		expect(projectionPackets(await rtcObservations(creator), "send").map(({ sequence }) => sequence)).toEqual([
			31, 32, 33, 34, 35,
		]);
		expect(projectionPackets(await rtcObservations(observer), "message")).toEqual([]);

		expect(await emulateLoss(lossSession, 0)).toHaveLength(1);
		await publishCampaign(creator, observerPeerId, 36, 1);
		await expect.poll(async () => (await zone(observer)).aoiProjection[creatorPeerId]?.waitingForKeyframe).toBe(true);
		expect((await zone(observer)).aoiPopulations[creatorPeerId]).toEqual(installed);
		const afterGapPackets = projectionPackets(await rtcObservations(observer), "message");
		expect(afterGapPackets.at(-1)).toMatchObject({
			baseKeyframeId: 30,
			baseKeyframeSequence: 30,
			kind: 2,
			sequence: 36,
		});

		expect(await emulateLoss(lossSession, LOSS_PERCENT)).toHaveLength(1);
		await publishCampaign(creator, observerPeerId, 37, 23);
		expect(await emulateLoss(lossSession, 0)).toHaveLength(1);
		await publishCampaign(creator, observerPeerId, 60, 1);
		await expect.poll(async () => (await zone(observer)).aoiProjection[creatorPeerId]?.lastSequence).toBe(60);
		const senderPackets = projectionPackets(await rtcObservations(creator), "send");
		const receiverPackets = projectionPackets(await rtcObservations(observer), "message");
		expect(senderPackets.map(({ sequence }) => sequence)).toEqual(
			Array.from({ length: 30 }, (_value, index) => index + 31)
		);
		expect(receiverPackets.some(({ sequence }) => sequence >= 37 && sequence < 60)).toBe(true);
		expect(receiverPackets.filter(({ sequence }) => sequence >= 37 && sequence < 60).length).toBeLessThan(23);
		expect(receiverPackets.find(({ sequence }) => sequence === 60)).toMatchObject({
			baseKeyframeId: 60,
			baseKeyframeSequence: 60,
			batchId: 60,
			kind: 1,
			sequence: 60,
		});
		const recovered = await zone(observer);
		expect(recovered.aoiProjection[creatorPeerId]).toMatchObject({
			baseKeyframeId: 60,
			baseKeyframeSequence: 60,
			lastSequence: 60,
			waitingForKeyframe: false,
		});
		expect(recovered.aoiPopulations[creatorPeerId]).toHaveLength(32);
		expect((await zone(excluded)).aoiPopulations[creatorPeerId]).toBeUndefined();
		for (const page of [creator, observer, excluded]) {
			expect((await zone(page)).durableVertexCount).toBe(durableBaseline);
			expect((await zone(page)).rawTransport.fallbackCount).toBe(0);
		}

		await creator.evaluate(async () => {
			const api = window.__TS_DRP_V3_ZONE__;
			if (api === undefined) throw new Error("E403_ZONE_API_ABSENT");
			await api.placeBlock({ id: "e4-03-after-loss", kind: "stone", x: 4, y: 3 });
		});
		await observer.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await observer.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		for (const page of [creator, observer, excluded]) {
			await expect
				.poll(async () => (await zone(page)).blocks)
				.toEqual([{ id: "e4-03-after-loss", kind: "stone", x: 4, y: 3 }]);
		}
	} finally {
		await emulateLoss(lossSession, 0).catch(() => []);
		await Promise.all([creatorContext.close(), observerContext.close(), excludedContext.close()]);
	}
});

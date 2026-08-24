import { type CDPSession, expect, type Page, test } from "@playwright/test";

import {
	installRtcObserver,
	resetRtcObserver,
	rtcBandwidthSample,
	rtcObservations,
} from "./fixtures/e4-aoi/rtc-observer.js";

const ENTITY_COUNT = 128;
const EXPECTED_ROUTED_BYTES = 570 * 691 + 30 * 708;
const SAMPLE_COUNT = 600;
const SAMPLE_INTERVAL_MS = 1_000 / 30;
const VISIBLE_COUNT = 32;

interface Entity {
	readonly entityId: number;
	readonly sequence: number;
	readonly x: number;
	readonly y: number;
}

interface ZoneSnapshot {
	readonly aoiPopulations: Readonly<Record<string, readonly Entity[]>>;
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
		readonly overLimit?: number;
		readonly routedBytesReceived: number;
		readonly routedBytesSent: number;
	}>;
}

interface ZoneApi {
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
		readonly __TS_DRP_V3_ZONE__?: ZoneApi;
	}
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

async function emulateLoss(session: CDPSession, packetLoss: number): Promise<void> {
	const { ruleIds } = await session.send("Network.emulateNetworkConditionsByRule", {
		matchedNetworkConditions: [{ ...networkProfile(packetLoss), urlPattern: "" }],
	});
	expect(ruleIds).toHaveLength(1);
}

function expectedIds(observerX: -1 | 1): readonly number[] {
	return Object.freeze([...Array.from({ length: 31 }, (_value, index) => index + 1), observerX === -1 ? 32 : 33]);
}

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => window.__TS_DRP_V3_ZONE__ !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
}

async function zone(page: Page): Promise<ZoneSnapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("E404_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

async function publishSegment(
	page: Page,
	observerPeerId: string,
	startSequence: number,
	count: number,
	observerX: -1 | 1
): Promise<void> {
	await page.evaluate(
		async ({ firstSequence, intervalMs, observerId, observerPosition, sampleCount }) => {
			const api = window.__TS_DRP_V3_ZONE__;
			if (api === undefined) throw new Error("E404_ZONE_API_ABSENT");
			const startedAt = performance.now();
			for (let offset = 0; offset < sampleCount; offset += 1) {
				if (offset > 0) {
					const dueAt = startedAt + offset * intervalMs;
					await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueAt - performance.now())));
				}
				const sequence = firstSequence + offset;
				const movingY = sequence % 2;
				const entities = Array.from({ length: 128 }, (_value, index) => {
					const entityId = index + 1;
					const x = entityId <= 31 ? 0 : entityId === 32 ? -100 : entityId === 33 ? 100 : 1_000 + entityId * 4;
					return { entityId, sequence, x, y: movingY };
				});
				if (
					!(await api.publishAoiPopulation({
						entities,
						observerPeerId: observerId,
						observerX: observerPosition,
						observerY: movingY,
						radius: 2_000,
					}))
				) {
					throw new Error("E404_TARGETED_PUBLICATION_REJECTED");
				}
			}
		},
		{
			firstSequence: startSequence,
			intervalMs: SAMPLE_INTERVAL_MS,
			observerId: observerPeerId,
			observerPosition: observerX,
			sampleCount: count,
		}
	);
}

function rawBytes(records: Awaited<ReturnType<typeof rtcObservations>>, direction: "message" | "send"): number {
	return records
		.filter(
			(record) =>
				record.direction === direction &&
				record.label === "ts-drp-ephemeral/1" &&
				record.maxRetransmits === 0 &&
				!record.ordered
		)
		.reduce((total, { bytes }) => total + bytes.length, 0);
}

test("one real receiver sustains nearest-32 AOI recovery below the selected-pair budget", async ({ browser }) => {
	test.setTimeout(300_000);
	const creatorContext = await browser.newContext();
	const observerContext = await browser.newContext();
	await Promise.all([
		creatorContext.addInitScript(installRtcObserver),
		observerContext.addInitScript(installRtcObserver),
	]);
	const creator = await creatorContext.newPage();
	const observer = await observerContext.newPage();
	const lossSession = await creatorContext.newCDPSession(creator);
	try {
		await lossSession.send("Network.enable");
		await emulateLoss(lossSession, 0);
		await Promise.all([openGrid(creator), openGrid(observer)]);
		const observerEnrollment = (await zone(observer)).enrollment;
		await creator.evaluate(async (observerMember) => {
			const api = window.__TS_DRP_V3_ZONE__;
			if (api === undefined) throw new Error("E404_ZONE_API_ABSENT");
			await api.create([observerMember]);
		}, observerEnrollment);
		const created = await zone(creator);
		await observer.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		const creatorPeerId = (await zone(creator)).localPeerId;
		const observerPeerId = (await zone(observer)).localPeerId;
		await expect
			.poll(async () => (await zone(creator)).rawTransport.links.map(({ peerId }) => peerId))
			.toEqual([observerPeerId]);
		await expect
			.poll(async () => (await zone(observer)).rawTransport.links.map(({ peerId }) => peerId))
			.toEqual([creatorPeerId]);

		const durableBaseline = (await zone(creator)).durableVertexCount;
		const creatorRoutedBaseline = (await zone(creator)).rawTransport.routedBytesSent;
		const observerRoutedBaseline = (await zone(observer)).rawTransport.routedBytesReceived;
		await Promise.all([resetRtcObserver(creator), resetRtcObserver(observer)]);
		const pairBaseline = await rtcBandwidthSample(observer);
		const campaignStartedAt = Date.now();

		await publishSegment(creator, observerPeerId, 0, 200, -1);
		await publishSegment(creator, observerPeerId, 200, 30, 1);
		await expect
			.poll(async () => (await zone(observer)).aoiPopulations[creatorPeerId]?.map(({ entityId }) => entityId))
			.toEqual(expectedIds(1));

		await publishSegment(creator, observerPeerId, 230, 170, 1);
		await emulateLoss(lossSession, 100);
		await publishSegment(creator, observerPeerId, 400, 10, -1);
		await emulateLoss(lossSession, 0);
		await publishSegment(creator, observerPeerId, 410, 41, -1);
		await expect
			.poll(async () => (await zone(observer)).aoiPopulations[creatorPeerId]?.map(({ entityId }) => entityId))
			.toEqual(expectedIds(-1));
		await publishSegment(creator, observerPeerId, 451, 149, -1);
		await expect
			.poll(async () => (await zone(observer)).aoiPopulations[creatorPeerId]?.map(({ entityId }) => entityId))
			.toEqual(expectedIds(-1));
		const elapsedMs = Date.now() - campaignStartedAt;

		const creatorAfter = await zone(creator);
		const observerAfter = await zone(observer);
		const finalEntities = observerAfter.aoiPopulations[creatorPeerId];
		expect(finalEntities).toHaveLength(VISIBLE_COUNT);
		expect(finalEntities.map(({ entityId }) => entityId)).toEqual(expectedIds(-1));
		expect(elapsedMs).toBeGreaterThanOrEqual(19_000);
		expect(elapsedMs).toBeLessThan(22_500);
		const creatorRoutedBytes = creatorAfter.rawTransport.routedBytesSent - creatorRoutedBaseline;
		const observerRoutedBytes = observerAfter.rawTransport.routedBytesReceived - observerRoutedBaseline;
		const [creatorRecords, observerRecords] = await Promise.all([rtcObservations(creator), rtcObservations(observer)]);
		expect(creatorRoutedBytes).toBe(EXPECTED_ROUTED_BYTES);
		expect(rawBytes(creatorRecords, "send")).toBe(EXPECTED_ROUTED_BYTES);
		expect(observerRoutedBytes).toBe(rawBytes(observerRecords, "message"));
		expect(observerRoutedBytes).toBeGreaterThanOrEqual(Math.floor((EXPECTED_ROUTED_BYTES - 10 * 708) * 0.9));

		let pairAfter = await rtcBandwidthSample(observer);
		await expect
			.poll(async () => {
				pairAfter = await rtcBandwidthSample(observer);
				expect(pairAfter.connectionOrdinal).toBe(pairBaseline.connectionOrdinal);
				expect(pairAfter.selectedPairId).toBe(pairBaseline.selectedPairId);
				return pairAfter.bytesReceived - pairBaseline.bytesReceived;
			})
			.toBeGreaterThanOrEqual(observerRoutedBytes);
		const pairBytesReceived = pairAfter.bytesReceived - pairBaseline.bytesReceived;
		expect((pairBytesReceived * 8) / 20).toBeLessThanOrEqual(256_000);
		for (const page of [creator, observer]) {
			expect((await zone(page)).durableVertexCount).toBe(durableBaseline);
			expect((await zone(page)).rawTransport.fallbackCount).toBe(0);
		}

		await creator.evaluate(async () => {
			const api = window.__TS_DRP_V3_ZONE__;
			if (api === undefined) throw new Error("E404_ZONE_API_ABSENT");
			await api.placeBlock({ id: "e4-04-after-bandwidth", kind: "stone", x: 5, y: 4 });
		});
		for (const page of [creator, observer]) {
			await expect
				.poll(async () => (await zone(page)).blocks)
				.toEqual([{ id: "e4-04-after-bandwidth", kind: "stone", x: 5, y: 4 }]);
		}

		const [creatorWorkbench, observerProjectionWorkbench] = await Promise.all([
			creator.evaluate(() => document.getElementById("aoiBandwidthWorkbench")?.textContent ?? null),
			observer.evaluate(() => document.getElementById("aoiProjectionWorkbench")?.textContent ?? null),
		]);
		expect({
			creatorOverLimit: creatorAfter.rawTransport.overLimit,
			creatorWorkbench,
			observerOverLimit: observerAfter.rawTransport.overLimit,
			observerProjectionWorkbench,
		}).toEqual({
			creatorOverLimit: 0,
			creatorWorkbench: expect.stringMatching(/32 \/ 128[\s\S]*kbps/iu),
			observerOverLimit: 0,
			observerProjectionWorkbench: expect.stringContaining("current"),
		});
	} finally {
		await emulateLoss(lossSession, 0).catch(() => undefined);
		await Promise.all([creatorContext.close(), observerContext.close()]);
	}
});

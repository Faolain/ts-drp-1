import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const SAMPLE_COUNT = 300;
const SAMPLE_INTERVAL_MS = 33;
const TARGETED_READY = readFileSync("packages/ephemeral/src/index.ts", "utf8").includes("publishTo(");
const ZONE_SOURCE = readFileSync("examples/grid/src/v3-zone.ts", "utf8");
const ROUTE_HEADER_BYTES = 33;
const AUTHORITY_HEADER_BYTES = 73;
const EPHEMERAL_HEADER_BYTES = 16;
const MAX_ENTITY_BATCH_BYTES = 514;

function targetedCompositionIsOwned(): boolean {
	const start = ZONE_SOURCE.indexOf("async publishAoiPopulation(");
	const end = ZONE_SOURCE.indexOf("async rehearseMigration(", start);
	if (start < 0 || end <= start) return false;
	const owner = ZONE_SOURCE.slice(start, end);
	return (
		owner.includes("selectAoiEntityDeltas(") &&
		owner.includes("encodeEntityDeltaBatch(") &&
		owner.includes("ephemeral.publishTo(") &&
		!owner.includes("ephemeral.publish({")
	);
}

interface EntityDelta {
	readonly entityId: number;
	readonly sequence: number;
	readonly x: number;
	readonly y: number;
}

interface ZoneSnapshot {
	readonly acceptedOperationDigest: string;
	readonly aoiPopulations: Readonly<Record<string, readonly EntityDelta[]>>;
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
		readonly routedBytesReceived: number;
		readonly routedBytesSent: number;
	}>;
	readonly ready: boolean;
	readonly zoneId: string;
}

interface ZoneApi {
	create(memberEnrollments: string | readonly string[]): Promise<void>;
	join(invite: string): Promise<void>;
	placeBlock(
		input: Readonly<{ readonly id: string; readonly kind: string; readonly x: number; readonly y: number }>
	): Promise<void>;
	publishAoiPopulation(
		input: Readonly<{
			readonly entities: readonly EntityDelta[];
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

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => window.__TS_DRP_V3_ZONE__ !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
}

async function zone(page: Page): Promise<ZoneSnapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("E402_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

test.skip(!TARGETED_READY, "E4-02 GREEN is dormant until targeted publication exists");

test("one real observer receives 32 targeted entities below the routed downstream budget", async ({ browser }) => {
	test.setTimeout(300_000);
	expect(targetedCompositionIsOwned()).toBe(true);
	const creatorContext = await browser.newContext();
	const observerContext = await browser.newContext();
	const excludedContext = await browser.newContext();
	const creator = await creatorContext.newPage();
	const observer = await observerContext.newPage();
	const excluded = await excludedContext.newPage();
	try {
		await Promise.all([openGrid(creator), openGrid(observer), openGrid(excluded)]);
		const observerEnrollment = (await zone(observer)).enrollment;
		const excludedEnrollment = (await zone(excluded)).enrollment;
		await creator.evaluate(
			async ({ excludedMember, observerMember }) => {
				const api = window.__TS_DRP_V3_ZONE__;
				if (api === undefined) throw new Error("E402_ZONE_API_ABSENT");
				await api.create([observerMember, excludedMember]);
			},
			{ excludedMember: excludedEnrollment, observerMember: observerEnrollment }
		);
		const created = await zone(creator);
		await Promise.all([
			observer.evaluate(async (invite) => {
				const api = window.__TS_DRP_V3_ZONE__;
				if (api === undefined) throw new Error("E402_ZONE_API_ABSENT");
				await api.join(invite);
			}, created.invite),
			excluded.evaluate(async (invite) => {
				const api = window.__TS_DRP_V3_ZONE__;
				if (api === undefined) throw new Error("E402_ZONE_API_ABSENT");
				await api.join(invite);
			}, created.invite),
		]);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(3);
		await expect.poll(async () => (await zone(observer)).durableVertexCount).toBe(3);
		await expect.poll(async () => (await zone(excluded)).durableVertexCount).toBe(3);
		const observerPeerId = (await zone(observer)).localPeerId;
		const excludedPeerId = (await zone(excluded)).localPeerId;
		await expect
			.poll(async () => (await zone(creator)).rawTransport.links.map(({ peerId }) => peerId).sort())
			.toEqual([excludedPeerId, observerPeerId].sort());

		const creatorPeerId = (await zone(creator)).localPeerId;
		const durableBaseline = (await zone(creator)).durableVertexCount;
		const senderBytesBaseline = (await zone(creator)).rawTransport.routedBytesSent;
		const receiverBytesBaseline = (await zone(observer)).rawTransport.routedBytesReceived;
		const excludedBytesBaseline = (await zone(excluded)).rawTransport.routedBytesReceived;
		const entities = Array.from({ length: 34 }, (_, index) => ({
			entityId: index + 1,
			sequence: 0,
			x: index,
			y: 0,
		}));
		const startedAt = Date.now();
		await creator.evaluate(
			async ({ campaignEntities, intervalMs, observerId, sampleCount }) => {
				const api = window.__TS_DRP_V3_ZONE__;
				if (api === undefined) throw new Error("E402_ZONE_API_ABSENT");
				const campaignStartedAt = performance.now();
				for (let sequence = 0; sequence < sampleCount; sequence += 1) {
					if (sequence > 0) {
						const dueAt = campaignStartedAt + sequence * intervalMs;
						await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueAt - performance.now())));
					}
					const accepted = await api.publishAoiPopulation({
						entities: campaignEntities.map((entity) => ({ ...entity, sequence })),
						observerPeerId: observerId,
						observerX: 0,
						observerY: 0,
						radius: 64,
					});
					if (!accepted) throw new Error("E402_TARGETED_PUBLICATION_REJECTED");
				}
			},
			{
				campaignEntities: entities,
				intervalMs: SAMPLE_INTERVAL_MS,
				observerId: observerPeerId,
				sampleCount: SAMPLE_COUNT,
			}
		);
		const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, (SAMPLE_COUNT * SAMPLE_INTERVAL_MS) / 1_000);
		await expect
			.poll(async () => (await zone(observer)).aoiPopulations[creatorPeerId]?.[0]?.sequence)
			.toBe(SAMPLE_COUNT - 1);
		const observerAfter = await zone(observer);
		const excludedAfter = await zone(excluded);
		expect(observerAfter.aoiPopulations[creatorPeerId]).toEqual(
			Array.from({ length: 32 }, (_, index) => ({
				entityId: index + 1,
				sequence: SAMPLE_COUNT - 1,
				x: index,
				y: 0,
			}))
		);
		expect(excludedAfter.aoiPopulations[creatorPeerId]).toBeUndefined();
		const routedBytesReceived = observerAfter.rawTransport.routedBytesReceived - receiverBytesBaseline;
		const routedBytesSent = (await zone(creator)).rawTransport.routedBytesSent - senderBytesBaseline;
		const excludedRoutedBytes = excludedAfter.rawTransport.routedBytesReceived - excludedBytesBaseline;
		const targetedKeyBytes = new TextEncoder().encode(`aoi:${observerPeerId}`).byteLength;
		const expectedRoutedBytesPerBatch =
			ROUTE_HEADER_BYTES + AUTHORITY_HEADER_BYTES + EPHEMERAL_HEADER_BYTES + targetedKeyBytes + MAX_ENTITY_BATCH_BYTES;
		expect(routedBytesSent).toBe(expectedRoutedBytesPerBatch * SAMPLE_COUNT);
		expect(routedBytesReceived).toBe(routedBytesSent);
		expect(excludedRoutedBytes).toBe(0);
		expect(observerAfter.rawTransport.links.map(({ peerId }) => peerId)).toContain(creatorPeerId);
		expect(excludedAfter.rawTransport.links.map(({ peerId }) => peerId)).toContain(creatorPeerId);
		const routedBitsPerSecond = (routedBytesReceived * 8) / elapsedSeconds;
		expect(routedBitsPerSecond).toBeGreaterThan(123_360);
		expect(routedBitsPerSecond).toBeLessThan(256_000);
		for (const page of [creator, observer, excluded]) {
			expect((await zone(page)).durableVertexCount).toBe(durableBaseline);
			expect((await zone(page)).rawTransport.fallbackCount).toBe(0);
		}

		await creator.evaluate(async () => {
			const api = window.__TS_DRP_V3_ZONE__;
			if (api === undefined) throw new Error("E402_ZONE_API_ABSENT");
			await api.placeBlock({ id: "after-aoi", kind: "stone", x: 1, y: 2 });
		});
		for (const page of [creator, observer, excluded]) {
			await expect
				.poll(async () => (await zone(page)).blocks)
				.toEqual([{ id: "after-aoi", kind: "stone", x: 1, y: 2 }]);
			expect((await zone(page)).durableVertexCount).toBe(durableBaseline + 1);
		}
	} finally {
		await Promise.all([creatorContext.close(), observerContext.close(), excludedContext.close()]);
	}
});

import { expect, type Page, test } from "@playwright/test";

interface ZoneSnapshot {
	readonly acceptedOperationDigest: string;
	readonly blocks: readonly Readonly<{
		readonly id: string;
		readonly kind: string;
		readonly x: number;
		readonly y: number;
	}>[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localAuthor: string;
	readonly localPeerId: string;
	readonly ready: boolean;
	readonly transientPositions: Readonly<Record<string, Readonly<{ readonly x: number; readonly y: number }>>>;
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly zoneId: string;
}

interface ZoneApi {
	close(): Promise<void>;
	placeBlock(
		input: Readonly<{ readonly id: string; readonly kind: string; readonly x: number; readonly y: number }>
	): Promise<void>;
	snapshot(): ZoneSnapshot;
}

interface NetworkSnapshot {
	readonly peerId: string;
}

declare global {
	interface Window {
		readonly __TS_DRP_GRID_SESSION__?: { snapshot(): NetworkSnapshot };
		readonly __TS_DRP_V3_ZONE__?: ZoneApi;
	}
}

const DIGEST = /^[0-9a-f]{64}$/u;

function escaped(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
		if (api === undefined) throw new Error("D9346_V3_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

async function peerId(page: Page): Promise<string> {
	return page.evaluate(() => {
		const session = window.__TS_DRP_GRID_SESSION__;
		if (session === undefined) throw new Error("D9346_GRID_NETWORK_SESSION_ABSENT");
		return session.snapshot().peerId;
	});
}

test("two real network clients recover and converge one durable v3 zone while movement stays transient", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	const creator = await creatorContext.newPage();
	let joiner = await joinerContext.newPage();
	try {
		await Promise.all([openGrid(creator), openGrid(joiner)]);
		const [creatorPeerId, joinerPeerId] = await Promise.all([peerId(creator), peerId(joiner)]);
		const [creatorEnrollment, joinerEnrollment] = await Promise.all([zone(creator), zone(joiner)]);
		expect(creatorEnrollment.ready).toBe(false);
		expect(joinerEnrollment.ready).toBe(false);
		expect(creatorEnrollment.localPeerId).toBe(creatorPeerId);
		expect(joinerEnrollment.localPeerId).toBe(joinerPeerId);
		expect(creatorEnrollment.localAuthor).toMatch(DIGEST);
		expect(joinerEnrollment.localAuthor).toMatch(DIGEST);
		expect(creatorEnrollment.enrollment).not.toBe(joinerEnrollment.enrollment);
		expect(creatorEnrollment.transientPositions).toEqual({});
		expect(joinerEnrollment.transientPositions).toEqual({});

		await creator.fill("#zoneMemberEnrollment", joinerEnrollment.enrollment);
		await creator.click("#createGrid");
		await expect.poll(async () => (await zone(creator)).ready).toBe(true);
		const created = await zone(creator);
		expect(created.zoneId).toMatch(new RegExp(`^${escaped(creatorPeerId)}:[0-9a-f]{32}$`, "u"));
		expect(created.invite).toMatch(/^[0-9a-f]+$/u);
		expect(created.durableVertexCount).toBe(1);
		expect(created.transportPeerAuthors).toEqual([
			{ author: creatorEnrollment.localAuthor, peerId: creatorPeerId },
			{ author: joinerEnrollment.localAuthor, peerId: joinerPeerId },
		]);

		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).zoneId).toBe(created.zoneId);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
		await expect.poll(async () => (await zone(joiner)).durableVertexCount).toBe(2);
		expect((await zone(joiner)).transportPeerAuthors).toEqual(created.transportPeerAuthors);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);

		await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "spawn", kind: "stone", x: 2, y: 3 }));
		await expect.poll(async () => (await zone(creator)).blocks).toEqual([{ id: "spawn", kind: "stone", x: 2, y: 3 }]);
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual([{ id: "spawn", kind: "stone", x: 2, y: 3 }]);
		await expect(creator.locator('[data-block-id="spawn"]')).toBeVisible();
		await expect(joiner.locator('[data-block-id="spawn"]')).toBeVisible();

		const afterBlock = await zone(creator);
		const joinedAfterBlock = await zone(joiner);
		expect(afterBlock.acceptedOperationDigest).toMatch(DIGEST);
		expect(joinedAfterBlock.acceptedOperationDigest).toBe(afterBlock.acceptedOperationDigest);
		expect(afterBlock.durableVertexCount).toBe(3);
		expect(joinedAfterBlock.durableVertexCount).toBe(3);
		const beforeCreatorMovement = joinedAfterBlock.transientPositions[creatorPeerId];
		await creator.keyboard.press("w");
		await expect
			.poll(async () => (await zone(joiner)).transientPositions[creatorPeerId])
			.not.toEqual(beforeCreatorMovement);
		expect((await zone(creator)).durableVertexCount).toBe(afterBlock.durableVertexCount);
		expect((await zone(joiner)).durableVertexCount).toBe(afterBlock.durableVertexCount);
		expect((await zone(creator)).acceptedOperationDigest).toBe(afterBlock.acceptedOperationDigest);
		expect((await zone(joiner)).acceptedOperationDigest).toBe(afterBlock.acceptedOperationDigest);

		const beforeJoinerMovement = (await zone(creator)).transientPositions[joinerPeerId];
		await joiner.keyboard.press("d");
		await expect
			.poll(async () => (await zone(creator)).transientPositions[joinerPeerId])
			.not.toEqual(beforeJoinerMovement);
		expect((await zone(creator)).durableVertexCount).toBe(afterBlock.durableVertexCount);
		expect((await zone(joiner)).durableVertexCount).toBe(afterBlock.durableVertexCount);

		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await joiner.close();
		await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "offline", kind: "wood", x: 5, y: 8 }));
		await expect.poll(async () => (await zone(creator)).blocks).toHaveLength(2);
		const afterOfflineProgress = await zone(creator);
		expect(afterOfflineProgress.durableVertexCount).toBe(afterBlock.durableVertexCount + 1);
		expect(afterOfflineProgress.acceptedOperationDigest).not.toBe(afterBlock.acceptedOperationDigest);
		await expect(creator.locator('[data-block-id="offline"]')).toBeVisible();

		joiner = await joinerContext.newPage();
		await openGrid(joiner);
		const reopened = await zone(joiner);
		expect(reopened.enrollment).toBe(joinerEnrollment.enrollment);
		expect(reopened.localAuthor).toBe(joinerEnrollment.localAuthor);
		expect(reopened.localPeerId).toBe(joinerPeerId);
		expect(reopened.transientPositions).toEqual({});
		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual((await zone(creator)).blocks);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
		expect((await zone(joiner)).transientPositions).toEqual({});
		expect((await zone(joiner)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount);
		await expect(joiner.locator('[data-block-id="offline"]')).toBeVisible();

		await creator.keyboard.press("a");
		await expect.poll(async () => (await zone(joiner)).transientPositions[creatorPeerId]).toBeDefined();
		expect((await zone(joiner)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount);

		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "rejoined", kind: "glass", x: 13, y: 21 }));
		await expect.poll(async () => (await zone(creator)).blocks).toHaveLength(3);
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual((await zone(creator)).blocks);
		expect((await zone(creator)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount + 1);
		expect((await zone(joiner)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount + 1);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
		expect((await zone(joiner)).acceptedOperationDigest).not.toBe(afterOfflineProgress.acceptedOperationDigest);
		await expect(creator.locator('[data-block-id="rejoined"]')).toBeVisible();
		await expect(joiner.locator('[data-block-id="rejoined"]')).toBeVisible();
	} finally {
		await Promise.allSettled([
			creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
			joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
		]);
		await Promise.allSettled([creator.close(), joiner.close(), creatorContext.close(), joinerContext.close()]);
	}
});

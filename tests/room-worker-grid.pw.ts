import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "./fixtures/phase-3a1b/grid-room-head-authority";

/**
 * Grid as the opt-in room worker's first adopter (`?roomWorker`): crash ambiguity resolved exactly
 * once (condition A), the fallback to the main thread, and an engine smoke. The two-client parity
 * scenario is d9346's, run with D9346_ROOM_WORKER=both|creator|joiner.
 */

interface Block {
	readonly id: string;
	readonly kind: string;
	readonly x: number;
	readonly y: number;
}

interface ZoneSnapshot {
	readonly acceptedOperationDigest: string;
	readonly blocks: readonly Block[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly ready: boolean;
	readonly zoneId: string;
}

interface WorkerZone {
	create(members: readonly string[]): Promise<void>;
	join(invite: string): Promise<void>;
	close(): Promise<void>;
	placeBlock(block: Block): Promise<void>;
	snapshot(): ZoneSnapshot;
	refresh?(): Promise<ZoneSnapshot>;
}

interface RoomWorkerControl {
	terminate(reason?: string): void;
	reopen(): Promise<void>;
	observe(stream: "projection", listener: (value: unknown) => void): () => void;
	recoverBlockPlacement(block: Block): Promise<"landed" | "offered" | "kept">;
	rtcStats(): Promise<Readonly<{ channelsCreated: number; channelsReceived: number; attachMs: readonly number[] }>>;
}

declare global {
	interface Window {
		readonly __TS_DRP_V3_ZONE__?: WorkerZone;
		readonly __TS_DRP_GRID_ROOM_WORKER__?: RoomWorkerControl;
		readonly __TS_DRP_GRID_SESSION__?: Readonly<{ snapshot(): Readonly<{ peerId: string }> }>;
	}
}

async function openGrid(page: Page, query: string): Promise<void> {
	await page.goto(`/${query}`);
	await page.waitForFunction(() => window.__TS_DRP_GRID_SESSION__ !== undefined, undefined, { timeout: 60_000 });
	await expect(page.locator("#loadingMessage")).toBeHidden({ timeout: 60_000 });
	await page.waitForFunction(() => window.__TS_DRP_V3_ZONE__ !== undefined);
}

async function zone(page: Page): Promise<ZoneSnapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("ROOM_WORKER_GRID_ZONE_ABSENT");
		return api.snapshot();
	});
}

/**
 * A creator (main thread) and a member (room worker) sharing one zone, both converged.
 * @param browser
 */
async function sharedZone(
	browser: Browser
): Promise<Readonly<{ creator: Page; member: Page; contexts: readonly BrowserContext[]; created: ZoneSnapshot }>> {
	const creatorContext = await browser.newContext();
	const memberContext = await browser.newContext();
	await installGridRoomHeadAuthority([creatorContext, memberContext]);
	const creator = await creatorContext.newPage();
	const member = await memberContext.newPage();
	await Promise.all([openGrid(creator, ""), openGrid(member, "?roomWorker")]);
	expect(await member.evaluate(() => window.__TS_DRP_GRID_ROOM_WORKER__ !== undefined)).toBe(true);
	const memberEnrollment = (await zone(member)).enrollment;
	await creator.evaluate((enrollment) => window.__TS_DRP_V3_ZONE__?.create([enrollment]), memberEnrollment);
	const created = await zone(creator);
	await member.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
	await expect.poll(async () => (await zone(member)).zoneId).toBe(created.zoneId);
	await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
	await expect.poll(async () => (await zone(member)).durableVertexCount).toBe(2);
	return { creator, member, contexts: [creatorContext, memberContext], created };
}

async function closeAll(pages: readonly Page[], contexts: readonly BrowserContext[]): Promise<void> {
	await Promise.allSettled(pages.map((page) => page.evaluate(() => window.__TS_DRP_V3_ZONE__?.close())));
	await Promise.allSettled([...pages.map((page) => page.close()), ...contexts.map((context) => context.close())]);
}

/**
 * The member's placement, as each side's durable projection holds it.
 * @param creator - The creator's page.
 * @param member - The member's page.
 * @param block - The placement.
 * @param durableVertexCount - Both sides' durable vertex count once it landed.
 * @param timeout - How long to wait (a move the room kept waits for the next epoch: Grid's idle
 * rollover is 30 s).
 */
async function expectLandedOnce(
	creator: Page,
	member: Page,
	block: Block,
	durableVertexCount: number,
	timeout = 20_000
): Promise<void> {
	for (const page of [creator, member]) {
		await expect
			.poll(async () => (await zone(page)).blocks.filter((placed) => placed.id === block.id), { timeout })
			.toEqual([block]);
		await expect.poll(async () => (await zone(page)).durableVertexCount, { timeout }).toBe(durableVertexCount);
	}
	expect((await zone(member)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
}

test("A: a placement whose reply is lost to a worker crash after local durable admission lands exactly once", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const { creator, member, contexts, created } = await sharedZone(browser);
	try {
		const block: Block = { id: "crash-after-admission", kind: "stone", x: 4, y: 9 };
		const before = (await zone(creator)).durableVertexCount;
		// Terminate the worker the moment the member's durable projection holds the block: the room
		// admitted it, the call's reply has not been handled. The call's outcome is then unknown.
		const outcome = await member.evaluate(async (placed) => {
			const control = window.__TS_DRP_GRID_ROOM_WORKER__;
			const api = window.__TS_DRP_V3_ZONE__;
			if (control === undefined || api === undefined) throw new Error("ROOM_WORKER_GRID_CONTROL_ABSENT");
			let terminatedOnProjection = false;
			const stop = control.observe("projection", (value) => {
				const snapshot = value as ZoneSnapshot;
				if (terminatedOnProjection || !snapshot.blocks.some((candidate) => candidate.id === placed.id)) return;
				terminatedOnProjection = true;
				control.terminate("test: crash between durable admission and the reply");
			});
			try {
				await api.placeBlock(placed);
				return { terminatedOnProjection, settled: "resolved", name: "" };
			} catch (error) {
				return { terminatedOnProjection, settled: "rejected", name: (error as Error).name };
			} finally {
				stop();
			}
		}, block);
		expect(outcome).toEqual({ terminatedOnProjection: true, settled: "rejected", name: "RoomWorkerCrashed" });

		// The documented recovery: reopen, rejoin, then resolve the placement by its block id.
		await member.evaluate(() => window.__TS_DRP_GRID_ROOM_WORKER__?.reopen());
		await member.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		await expect.poll(async () => (await zone(member)).zoneId).toBe(created.zoneId);
		const recovered = await member.evaluate(
			(placed) => window.__TS_DRP_GRID_ROOM_WORKER__?.recoverBlockPlacement(placed),
			block
		);
		expect(recovered).toBe("landed");
		await expectLandedOnce(creator, member, block, before + 1);

		// The reopened worker is a working member: its next placement lands once too.
		const next: Block = { id: "after-recovery", kind: "wood", x: 5, y: 9 };
		await member.evaluate((placed) => window.__TS_DRP_V3_ZONE__?.placeBlock(placed), next);
		await expectLandedOnce(creator, member, next, before + 2);
	} finally {
		await closeAll([creator, member], contexts);
	}
});

test("A control: a placement lost to a crash before the worker admitted it is offered again and lands once", async ({
	browser,
}) => {
	test.setTimeout(360_000);
	const { creator, member, contexts, created } = await sharedZone(browser);
	try {
		const block: Block = { id: "crash-before-admission", kind: "glass", x: 6, y: 2 };
		const before = (await zone(creator)).durableVertexCount;
		// The call is posted and the worker stopped in the same page task: the worker never runs it.
		const name = await member.evaluate(async (placed) => {
			const pending = window.__TS_DRP_V3_ZONE__?.placeBlock(placed);
			window.__TS_DRP_GRID_ROOM_WORKER__?.terminate("test: crash before admission");
			try {
				await pending;
				return "resolved";
			} catch (error) {
				return (error as Error).name;
			}
		}, block);
		expect(name).toBe("RoomWorkerCrashed");
		await member.evaluate(() => window.__TS_DRP_GRID_ROOM_WORKER__?.reopen());
		await member.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		await expect.poll(async () => (await zone(member)).zoneId).toBe(created.zoneId);
		expect((await zone(creator)).blocks.some((placed) => placed.id === block.id)).toBe(false);
		// The reopened member reaches its creator again before it offers anything: a creator placement
		// reaches it (a member offering earlier is read-only, and the room keeps its move to the next epoch).
		const marker: Block = { id: "creator-after-reopen", kind: "sand", x: 0, y: 7 };
		await creator.evaluate((placed) => window.__TS_DRP_V3_ZONE__?.placeBlock(placed), marker);
		await expect
			.poll(async () => (await zone(member)).blocks.some((placed) => placed.id === marker.id), { timeout: 60_000 })
			.toBe(true);
		// Offered again: accepted at once, or kept by the room until the member reaches its creator.
		const recovered = await member.evaluate(
			(placed) => window.__TS_DRP_GRID_ROOM_WORKER__?.recoverBlockPlacement(placed),
			block
		);
		expect(["offered", "kept"]).toContain(recovered);
		await expectLandedOnce(creator, member, block, before + 2, 120_000);
		// No late second copy: a kept move is offered by the room itself, once.
		await new Promise((resolve) => setTimeout(resolve, 5_000));
		expect((await zone(creator)).durableVertexCount).toBe(before + 2);
		expect((await zone(member)).durableVertexCount).toBe(before + 2);
	} finally {
		await closeAll([creator, member], contexts);
	}
});

test("a browser that cannot host the room in a worker opens the zone on the main thread", async ({ browser }) => {
	test.setTimeout(120_000);
	const context = await browser.newContext();
	await installGridRoomHeadAuthority([context]);
	await context.addInitScript(() => Reflect.deleteProperty(globalThis, "Worker"));
	const page = await context.newPage();
	const warnings: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "warning") warnings.push(message.text());
	});
	try {
		await openGrid(page, "?roomWorker");
		expect(await page.evaluate(() => window.__TS_DRP_GRID_ROOM_WORKER__ === undefined)).toBe(true);
		expect(warnings.some((text) => text.includes("Grid room worker unsupported"))).toBe(true);
		expect((await zone(page)).enrollment.length).toBeGreaterThan(0);
	} finally {
		await closeAll([page], [context]);
	}
});

test("@engines a worker-hosted zone opens, creates and places a block", async ({ browser }) => {
	test.setTimeout(180_000);
	const creatorContext = await browser.newContext();
	const memberContext = await browser.newContext();
	await installGridRoomHeadAuthority([creatorContext, memberContext]);
	const creator = await creatorContext.newPage();
	const member = await memberContext.newPage();
	try {
		await Promise.all([openGrid(creator, "?roomWorker"), openGrid(member, "?roomWorker")]);
		const memberEnrollment = (await zone(member)).enrollment;
		await creator.evaluate((enrollment) => window.__TS_DRP_V3_ZONE__?.create([enrollment]), memberEnrollment);
		const created = await zone(creator);
		expect(created.ready).toBe(true);
		await member.evaluate((invite) => window.__TS_DRP_V3_ZONE__?.join(invite), created.invite);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
		await expect.poll(async () => (await zone(member)).durableVertexCount).toBe(2);
		const block: Block = { id: "engine-smoke", kind: "stone", x: 1, y: 1 };
		await member.evaluate((placed) => window.__TS_DRP_V3_ZONE__?.placeBlock(placed), block);
		await expectLandedOnce(creator, member, block, 3);
		await expect(creator.locator('[data-block-id="engine-smoke"]')).toBeVisible();
		const stats = await member.evaluate(() => window.__TS_DRP_GRID_ROOM_WORKER__?.rtcStats());
		expect((stats?.channelsCreated ?? 0) + (stats?.channelsReceived ?? 0)).toBeGreaterThan(0);
	} finally {
		await closeAll([creator, member], [creatorContext, memberContext]);
	}
});

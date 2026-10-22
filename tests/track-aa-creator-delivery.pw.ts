import { expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "./fixtures/phase-3a1b/grid-room-head-authority";

// Track AA browser check (decision row 73): the shipped Grid page (examples/grid, its own dev
// server, real browser networking through the local relays, as
// phase-3a1b-d9346-v3-zone.pw.ts and track-v-grid-long-room.pw.ts serve it) in Chromium. A
// creator and one enrolled Writer open a zone and wait until the Writer's open-time
// republication schedule (0-15 s after its transport opens) has run out. The creator's page
// is then stopped (a busy main thread: a slow creator) while the Writer places blocks as fast
// as its own page issues them. When the creator runs again the copies arrive together, and
// the creator's admission owners refuse what they cannot queue. The check: every Writer
// block reaches the creator within DELIVERY_MS of the creator running again, and the
// creator's page logged at least one capacity refusal (otherwise the scenario did not
// exercise the gap and the check says so).
const SETTLE_MS = Number(process.env.TRACK_AA_BROWSER_SETTLE_MS ?? 17_000);
const BLOCK_MS = Number(process.env.TRACK_AA_BROWSER_BLOCK_MS ?? 8_000);
const BLOCKS = Number(process.env.TRACK_AA_BROWSER_BLOCKS ?? 80);
const DELIVERY_MS = Number(process.env.TRACK_AA_BROWSER_DELIVERY_MS ?? 60_000);

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Reflect.get(window, "__TS_DRP_GRID_SESSION__") !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
	await page.waitForFunction(() => Reflect.get(window, "__TS_DRP_V3_ZONE__") !== undefined, undefined, {
		timeout: 10_000,
	});
}

async function zone(page: Page): Promise<{
	readonly blocks: readonly { readonly id?: string }[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly ready: boolean;
}> {
	return page.evaluate(() => {
		const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { snapshot(): unknown } | undefined;
		if (api === undefined) throw new Error("TRACK_AA_ZONE_API_ABSENT");
		const snapshot = api.snapshot() as Record<string, unknown>;
		return {
			blocks: snapshot.blocks as { id?: string }[],
			durableVertexCount: snapshot.durableVertexCount as number,
			enrollment: snapshot.enrollment as string,
			invite: snapshot.invite as string,
			ready: snapshot.ready as boolean,
		};
	});
}

test("the shipped Grid creator admits every block of a Writer that outpaced it", async ({ browser }) => {
	test.setTimeout(600_000);
	const creatorContext = await browser.newContext();
	const writerContext = await browser.newContext();
	await installGridRoomHeadAuthority([creatorContext]);
	await installGridRoomHeadAuthority([writerContext], "__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__", "create");
	const creator = await creatorContext.newPage();
	const writer = await writerContext.newPage();
	const warnings = { creator: new Map<string, number>(), writer: new Map<string, number>() };
	for (const [label, page] of [
		["creator", creator],
		["writer", writer],
	] as const)
		page.on("console", (message) => {
			if (message.type() !== "warning" && message.type() !== "error") return;
			const key = `${message.type()} ${message.text().split(/\s+/u).slice(0, 2).join(" ").slice(0, 80)}`;
			warnings[label].set(key, (warnings[label].get(key) ?? 0) + 1);
		});
	try {
		await Promise.all([openGrid(creator), openGrid(writer)]);
		const writerEnrollment = await zone(writer);
		await creator.fill("#zoneMemberEnrollment", writerEnrollment.enrollment);
		await creator.click("#createGrid");
		await expect.poll(async () => (await zone(creator)).ready).toBe(true);
		await writer.fill("#gridInput", (await zone(creator)).invite);
		await writer.click("#joinGrid");
		await expect.poll(async () => (await zone(writer)).durableVertexCount).toBe(2);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
		// One block first, so the Writer's bootstrap row is not part of the burst.
		await writer.evaluate(async () => {
			const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { placeBlock(input: unknown): Promise<void> };
			await api.placeBlock({ id: "warmup", kind: "stone", x: 0, y: 0 });
		});
		await expect
			.poll(async () => (await zone(creator)).blocks.map((block) => block.id), { timeout: 30_000 })
			.toContain("warmup");
		// Let the Writer's open-time republication schedule run out.
		await creator.waitForTimeout(SETTLE_MS);
		warnings.creator.clear();
		const blocked = creator.evaluate((ms) => {
			const end = performance.now() + ms;
			while (performance.now() < end) {
				// A slow creator: its page runs nothing else meanwhile.
			}
			return true;
		}, BLOCK_MS);
		await writer.waitForTimeout(200);
		const placed = await writer.evaluate(async (count) => {
			const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { placeBlock(input: unknown): Promise<void> };
			const started = performance.now();
			const ids: string[] = [];
			for (let index = 0; index < count; index++) {
				const id = `burst-${index}`;
				await api.placeBlock({ id, kind: "stone", x: index % 16, y: 1 + Math.floor(index / 16) });
				ids.push(id);
			}
			return { ids, ms: performance.now() - started };
		}, BLOCKS);
		await blocked;
		const resumed = Date.now();
		let creatorIds = new Set<string>();
		let complete = false;
		while (Date.now() - resumed < DELIVERY_MS) {
			creatorIds = new Set((await zone(creator)).blocks.map((block) => block.id ?? ""));
			if (placed.ids.every((id) => creatorIds.has(id))) {
				complete = true;
				break;
			}
			await creator.waitForTimeout(250);
		}
		const elapsed = Date.now() - resumed;
		const refused = warnings.creator.get("warning ::v3-ingress admission-rejected") ?? 0;
		process.stdout.write(
			`TRACK_AA_BROWSER ${JSON.stringify({
				blocks: placed.ids.length,
				writerIssueMs: Math.round(placed.ms),
				creatorBlockedMs: BLOCK_MS,
				creatorHas: placed.ids.filter((id) => creatorIds.has(id)).length,
				complete,
				msAfterCreatorResumed: elapsed,
				creatorWarnings: Object.fromEntries(warnings.creator),
			})}\n`
		);
		expect(refused, "precondition: the creator refused copies at a capacity bound").toBeGreaterThan(0);
		expect(complete, `TRACK_AA_BROWSER creator has ${creatorIds.size} blocks; expected every burst block`).toBe(true);
	} finally {
		await Promise.allSettled([creatorContext.close(), writerContext.close()]);
	}
});

import { expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "../../../tests/fixtures/phase-3a1b/grid-room-head-authority";

// App rollover delivery: the shipped Canvas page in two browsers. The creator paints past two of
// its rollover budgets (7 paints per epoch, examples/canvas/src/rollover.ts); the observer's page
// follows each successor through the page's own successor delivery (no window publisher hook is
// installed) and shows every paint. A paint made after a rollover reaches the observer only once it
// has installed that successor.

const HEAD_FACTORY = "__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__";
const PAINTS = 22;

test.beforeEach(async ({ request }) => {
	const response = await request.post("http://127.0.0.1:4175/grid-control/registry/reset");
	expect(response.ok()).toBe(true);
});

test("an observer's page follows the creator's automatic rollovers through the page delivery", async ({ browser }) => {
	test.setTimeout(300_000);
	const creatorContext = await browser.newContext();
	const observerContext = await browser.newContext();
	// Each page has its own external account (as tests/track-x-shipped-app-long-room.pw.ts does).
	await installGridRoomHeadAuthority([creatorContext], HEAD_FACTORY);
	await installGridRoomHeadAuthority([observerContext], HEAD_FACTORY, "create");
	const creator = await creatorContext.newPage();
	const observer = await observerContext.newPage();
	const pageErrors: string[] = [];
	const logs: string[] = [];
	creator.on("pageerror", (error) => pageErrors.push(`creator: ${error.message}`));
	observer.on("pageerror", (error) => pageErrors.push(`observer: ${error.message}`));
	for (const [name, page] of [
		["creator", creator],
		["observer", observer],
	] as const)
		page.on("console", (message) => {
			if (
				/successor|install|authority|chain|lull|maintain|paint|rollover|refused|failed|invalid/iu.test(message.text())
			)
				logs.push(`${Date.now()} ${name}: ${message.type()} ${message.text().slice(0, 600)}`);
		});
	try {
		await Promise.all([creator.goto("http://127.0.0.1:4180/"), observer.goto("http://127.0.0.1:4180/")]);
		await Promise.all([waitForRelayReservation(creator), waitForRelayReservation(observer)]);
		await expect(creator.locator("#create")).toBeEnabled();
		await creator.locator("#create").click();
		await expect(creator.locator("#canvas > div")).toHaveCount(100);
		await expect(creator.locator("#canvasId")).not.toBeEmpty();
		await expect(creator.locator("#canvasInvite")).not.toHaveValue("");
		const invite = await creator.locator("#canvasInvite").inputValue();
		await expect(observer.locator("#connect")).toBeEnabled();
		await observer.locator("#canvasIdInput").fill(invite);
		await observer.locator("#connect").click();
		await expect(observer.locator("#canvas > div")).toHaveCount(100);
		await expect(observer.locator("#canvasId")).not.toBeEmpty();
		await expect(creator.locator("#object_peers")).not.toHaveText("[]", { timeout: 60_000 });
		const painted: { id: string; color: string }[] = [];
		for (let index = 0; index < PAINTS; index++) {
			const id = `${index % 10}-${Math.floor(index / 10)}`;
			const pixel = creator.locator(`[id="${id}"]`);
			const before = await pixel.evaluate((element) => getComputedStyle(element).backgroundColor);
			await pixel.click();
			await expect(pixel).not.toHaveCSS("background-color", before);
			painted.push({ id, color: await pixel.evaluate((element) => getComputedStyle(element).backgroundColor) });
			// Paints come in bursts; let each epoch's rollover start between them now and then.
			if (index % 7 === 6) await creator.waitForTimeout(1_500);
		}
		for (const { id, color } of painted)
			await expect(observer.locator(`[id="${id}"]`), `observer shows paint ${id}`).toHaveCSS(
				"background-color",
				color,
				{
					timeout: 180_000,
				}
			);
		expect(pageErrors).toEqual([]);
	} finally {
		console.log(`CANVAS_ROLLOVER_BROWSER_LOGS\n${logs.slice(-120).join("\n")}`);
		await Promise.allSettled([creatorContext.close(), observerContext.close()]);
	}
});

async function waitForRelayReservation(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const session = (
			window as typeof window & {
				__TS_DRP_CANVAS_SESSION__?: { snapshot(): { relayReservations: readonly unknown[] } };
			}
		).__TS_DRP_CANVAS_SESSION__;
		return (session?.snapshot().relayReservations.length ?? 0) >= 1;
	});
}

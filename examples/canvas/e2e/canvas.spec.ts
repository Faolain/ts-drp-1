import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
	const response = await request.post("http://127.0.0.1:4175/grid-control/registry/reset");
	expect(response.ok()).toBe(true);
});

test("two modular peers join a canvas and converge on a painted pixel", async ({ browser }) => {
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	const creator = await creatorContext.newPage();
	const joiner = await joinerContext.newPage();
	const pageErrors: string[] = [];
	creator.on("pageerror", (error) => pageErrors.push(`creator: ${error.message}`));
	joiner.on("pageerror", (error) => pageErrors.push(`joiner: ${error.message}`));

	try {
		await Promise.all([creator.goto("http://127.0.0.1:4180/"), joiner.goto("http://127.0.0.1:4180/")]);
		await Promise.all([waitForRelayReservation(creator), waitForRelayReservation(joiner)]);
		await expect(creator.locator("#canvas > div")).toHaveCount(50);
		await expect(joiner.locator("#canvas > div")).toHaveCount(50);
		expect(pageErrors).toEqual([]);

		await creator.locator("#create").click();
		await expect(creator.locator("#canvasId")).not.toBeEmpty();
		const canvasId = (await creator.locator("#canvasId").textContent())?.trim();
		if (canvasId === undefined || canvasId === "") throw new Error("creator did not expose a canvas ID");

		await joiner.locator("#canvasIdInput").fill(canvasId);
		await joiner.locator("#connect").click();
		await expect(joiner.locator("#canvasId")).toHaveText(canvasId);
		await expect(creator.locator("#object_peers")).not.toHaveText("[]");
		await expect(joiner.locator("#object_peers")).not.toHaveText("[]");

		const creatorPixel = creator.locator("#canvas > div").first();
		const joinerPixel = joiner.locator("#canvas > div").first();
		await expect(creatorPixel).toHaveCSS("background-color", "rgb(0, 0, 0)");
		await creatorPixel.click();
		await expect(creatorPixel).not.toHaveCSS("background-color", "rgb(0, 0, 0)");
		const paintedColor = await creatorPixel.evaluate((pixel) => getComputedStyle(pixel).backgroundColor);
		await expect(joinerPixel).toHaveCSS("background-color", paintedColor);
	} finally {
		await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
	}
});

async function waitForRelayReservation(page: import("@playwright/test").Page): Promise<void> {
	await page.waitForFunction(() => {
		const session = (
			window as typeof window & {
				__TS_DRP_CANVAS_SESSION__?: { snapshot(): { relayReservations: readonly unknown[] } };
			}
		).__TS_DRP_CANVAS_SESSION__;
		return (session?.snapshot().relayReservations.length ?? 0) >= 1;
	});
}

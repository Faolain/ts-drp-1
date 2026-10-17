import { expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "../../../tests/fixtures/phase-3a1b/grid-room-head-authority";

const HEAD_FACTORY = "__TS_DRP_CANVAS_ROOM_HEAD_AUTHORITY_FOR_OPEN__";

test.beforeEach(async ({ request, context }) => {
	const response = await request.post("http://127.0.0.1:4175/grid-control/registry/reset");
	expect(response.ok()).toBe(true);
	await installGridRoomHeadAuthority([context], HEAD_FACTORY);
});

test("two modular peers join a canvas and converge on a painted pixel", async ({ browser }) => {
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	await installGridRoomHeadAuthority([creatorContext, joinerContext], HEAD_FACTORY);
	const creator = await creatorContext.newPage();
	const joiner = await joinerContext.newPage();
	const pageErrors: string[] = [];
	creator.on("pageerror", (error) => pageErrors.push(`creator: ${error.message}`));
	joiner.on("pageerror", (error) => pageErrors.push(`joiner: ${error.message}`));

	try {
		await Promise.all([creator.goto("http://127.0.0.1:4180/"), joiner.goto("http://127.0.0.1:4180/")]);
		await Promise.all([waitForRelayReservation(creator), waitForRelayReservation(joiner)]);
		await Promise.all([waitForCanvasControls(creator), waitForCanvasControls(joiner)]);
		await expect(creator.getByTestId("canvas-stage")).toBeHidden();
		await expect(joiner.getByTestId("canvas-stage")).toBeHidden();
		await expect(creator.getByTestId("canvas-empty-state")).toContainText(/create or join a canvas/iu);
		await expect(joiner.getByTestId("canvas-empty-state")).toContainText(/create or join a canvas/iu);
		expect(pageErrors).toEqual([]);

		await creator.locator("#create").click();
		await expect(creator.getByTestId("canvas-empty-state")).toBeHidden();
		await expect(creator.getByTestId("canvas-stage")).toBeVisible();
		await expect(creator.locator("#canvas > div")).toHaveCount(100);
		await expect(creator.locator("#canvasId")).not.toBeEmpty();
		const canvasId = (await creator.locator("#canvasId").textContent())?.trim();
		if (canvasId === undefined || canvasId === "") throw new Error("creator did not expose a canvas ID");
		const invite = await creator.locator("#canvasInvite").inputValue();
		expect(invite).not.toBe(canvasId);
		expect(invite).not.toBe("");

		await joiner.locator("#canvasIdInput").fill(invite);
		await expect(joiner.locator("#connect")).toBeEnabled();
		await joiner.locator("#connect").click();
		await expect(joiner.locator("#canvasId")).toHaveText(canvasId);
		await expect(joiner.getByTestId("canvas-empty-state")).toBeHidden();
		await expect(joiner.getByTestId("canvas-stage")).toBeVisible();
		await expect(joiner.locator("#canvas > div")).toHaveCount(100);
		await expect(creator.locator("#object_peers")).not.toHaveText("[]");
		await expect(joiner.locator("#object_peers")).not.toHaveText("[]");

		const creatorPixel = creator.locator('[id="9-9"]');
		const joinerPixel = joiner.locator('[id="9-9"]');
		await expect(creatorPixel).toHaveCSS("background-color", "rgb(0, 0, 0)");
		await creatorPixel.click();
		await expect(creatorPixel).not.toHaveCSS("background-color", "rgb(0, 0, 0)");
		const paintedColor = await creatorPixel.evaluate((pixel) => getComputedStyle(pixel).backgroundColor);
		await expect(joinerPixel).toHaveCSS("background-color", paintedColor);
		// The original creator-only Writer policy remains intact: the second
		// independently authenticated author is an observer, not an enrolled writer.
		await joinerPixel.click();
		await expect(joiner.getByRole("status", { name: "Canvas connection status" })).toContainText(
			/observer|read.only|receive.only/iu
		);
		await expect(joinerPixel).toHaveCSS("background-color", paintedColor);
		await expect(creatorPixel).toHaveCSS("background-color", paintedColor);
		expect(pageErrors).toEqual([]);
	} finally {
		await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
	}
});

test("canvas stage stays hidden behind an actionable empty state until create", async ({ page }) => {
	await page.goto("http://127.0.0.1:4180/");
	await waitForRelayReservation(page);
	await waitForCanvasControls(page);

	const stage = page.getByTestId("canvas-stage");
	const emptyState = page.getByTestId("canvas-empty-state");
	await expect(stage).toBeHidden();
	await expect(emptyState).toContainText(/create or join a canvas/iu);

	await expect(page.locator("#create")).toBeEnabled();
	await page.locator("#create").click();
	await expect(emptyState).toBeHidden();
	await expect(stage).toBeVisible();
	await expect(page.locator("#canvas > div")).toHaveCount(100);
	await expect(page.getByRole("button", { name: /copy canvas invite/iu })).toBeVisible();

	const canvasBox = await page.locator("#canvas").boundingBox();
	const stageBox = await stage.boundingBox();
	if (canvasBox === null || stageBox === null) throw new Error("created canvas layout is not visible");
	expect(canvasBox.width).toBeGreaterThanOrEqual(320);
	expect(Math.abs(canvasBox.width - canvasBox.height)).toBeLessThanOrEqual(2);
	expect(Math.abs(canvasBox.x + canvasBox.width / 2 - (stageBox.x + stageBox.width / 2))).toBeLessThanOrEqual(4);
});

test("live canvas is a large centered 10 by 10 square", async ({ page }, testInfo) => {
	await page.goto("http://127.0.0.1:4180/");
	await waitForRelayReservation(page);
	await waitForCanvasControls(page);
	await page.locator("#create").click();

	const canvas = page.locator("#canvas");
	await expect(page.getByTestId("canvas-stage")).toBeVisible();
	await expect(canvas.locator(":scope > div")).toHaveCount(100);

	const canvasBox = await canvas.boundingBox();
	if (canvasBox === null) throw new Error("canvas is not visible");
	const stage = page.getByTestId("canvas-stage");
	await expect(stage).toBeVisible();
	const stageBox = await stage.boundingBox();
	if (stageBox === null) throw new Error("canvas stage is not visible");

	expect(canvasBox.width, "canvas width").toBeGreaterThanOrEqual(320);
	expect(canvasBox.height, "canvas height").toBeGreaterThanOrEqual(320);
	expect(Math.abs(canvasBox.width - canvasBox.height), "square aspect-ratio delta").toBeLessThanOrEqual(2);

	const canvasCenter = canvasBox.x + canvasBox.width / 2;
	const stageCenter = stageBox.x + stageBox.width / 2;
	expect(Math.abs(canvasCenter - stageCenter), "horizontal centering delta").toBeLessThanOrEqual(4);

	const geometry = await canvas.evaluate((element) => {
		const style = getComputedStyle(element);
		const firstCell = element.firstElementChild?.getBoundingClientRect();
		return {
			cellHeight: firstCell?.height ?? 0,
			cellWidth: firstCell?.width ?? 0,
			columnCount: style.gridTemplateColumns.split(" ").filter(Boolean).length,
			rowCount: style.gridTemplateRows.split(" ").filter(Boolean).length,
		};
	});
	expect(geometry.columnCount).toBe(10);
	expect(geometry.rowCount).toBe(10);
	expect(geometry.cellWidth).toBeGreaterThan(0);
	expect(Math.abs(geometry.cellWidth - geometry.cellHeight), "cell square delta").toBeLessThanOrEqual(1);
	await page.screenshot({ path: testInfo.outputPath("canvas-desktop.png"), fullPage: true });
});

test("canvas remains square and centered without horizontal overflow on a narrow viewport", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ height: 844, width: 390 });
	await page.goto("http://127.0.0.1:4180/");
	await waitForRelayReservation(page);
	await waitForCanvasControls(page);
	await page.locator("#create").click();

	const canvas = page.locator("#canvas");
	const stage = page.getByTestId("canvas-stage");
	await expect(stage).toBeVisible();
	await expect(canvas.locator(":scope > div")).toHaveCount(100);
	const canvasBox = await canvas.boundingBox();
	const stageBox = await stage.boundingBox();
	if (canvasBox === null || stageBox === null) throw new Error("mobile canvas layout is not visible");

	expect(canvasBox.width).toBeGreaterThanOrEqual(280);
	expect(Math.abs(canvasBox.width - canvasBox.height), "mobile square delta").toBeLessThanOrEqual(2);
	expect(
		Math.abs(canvasBox.x + canvasBox.width / 2 - (stageBox.x + stageBox.width / 2)),
		"mobile centering delta"
	).toBeLessThanOrEqual(4);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("canvas-narrow.png"), fullPage: true });
});

test("authenticated canvas invite is manually copyable with accessible clipboard feedback", async ({ browser }) => {
	const context = await browser.newContext();
	await installGridRoomHeadAuthority([context], HEAD_FACTORY);
	await context.addInitScript(() => {
		const target = window as typeof window & { __CANVAS_CLIPBOARD_WRITES__?: string[] };
		target.__CANVAS_CLIPBOARD_WRITES__ = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (value: string): Promise<void> => {
					target.__CANVAS_CLIPBOARD_WRITES__?.push(value);
					return Promise.resolve();
				},
			},
		});
	});
	const page = await context.newPage();

	try {
		await page.goto("http://127.0.0.1:4180/");
		await waitForRelayReservation(page);
		await waitForCanvasControls(page);
		await expect(page.getByTestId("canvas-stage")).toBeHidden();
		await expect(page.getByTestId("canvas-empty-state")).toContainText(/create or join a canvas/iu);
		await expect(page.locator("#copyCanvasId")).toBeHidden();
		await expect(page.locator("#copyCanvasId")).toBeDisabled();
		await page.locator("#create").click();
		await expect(page.getByTestId("canvas-stage")).toBeVisible();
		await expect(page.locator("#canvasId")).not.toBeEmpty();
		await expect(page.locator("#canvas > div")).toHaveCount(100);
		const canvasId = (await page.locator("#canvasId").textContent())?.trim();
		if (canvasId === undefined || canvasId === "") throw new Error("creator did not expose a canvas ID");
		const inviteField = page.locator("#canvasInvite");
		await expect(inviteField).toBeVisible();
		await expect(inviteField).toHaveAttribute("readonly", "");
		const invite = await inviteField.inputValue();
		expect(invite).not.toBe("");
		expect(invite).not.toBe(canvasId);
		const inviteBox = await inviteField.boundingBox();
		if (inviteBox === null) throw new Error("authenticated canvas invite is not visible for manual copying");
		expect(inviteBox.height, "invite field has bounded visual height").toBeLessThanOrEqual(160);

		const copyableId = page.getByRole("button", { name: /copy canvas invite/iu });
		await expect(copyableId).toBeVisible();
		await expect(copyableId).toContainText(canvasId);
		await expect(copyableId).toHaveAccessibleName(`Copy canvas invite: ${canvasId}`);
		await copyableId.click();

		await expect
			.poll(() =>
				page.evaluate(
					() => (window as typeof window & { __CANVAS_CLIPBOARD_WRITES__?: string[] }).__CANVAS_CLIPBOARD_WRITES__
				)
			)
			.toEqual([invite]);
		await expect(page.getByRole("status", { name: "Canvas copy status" })).toContainText(/copied/iu);
	} finally {
		await context.close();
	}
});

test("clipboard rejection preserves visible canvas ID and manually copyable authenticated invite", async ({
	browser,
}) => {
	const context = await browser.newContext();
	await installGridRoomHeadAuthority([context], HEAD_FACTORY);
	await context.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (): Promise<void> => Promise.reject(new Error("Clipboard permission denied")),
			},
		});
	});
	const page = await context.newPage();

	try {
		await page.goto("http://127.0.0.1:4180/");
		await waitForRelayReservation(page);
		await waitForCanvasControls(page);
		await expect(page.getByTestId("canvas-stage")).toBeHidden();
		await expect(page.getByTestId("canvas-empty-state")).toContainText(/create or join a canvas/iu);
		await page.locator("#create").click();
		await expect(page.getByTestId("canvas-stage")).toBeVisible();
		await expect(page.locator("#canvasId")).not.toBeEmpty();
		await expect(page.locator("#canvas > div")).toHaveCount(100);
		const canvasId = (await page.locator("#canvasId").textContent())?.trim();
		if (canvasId === undefined || canvasId === "") throw new Error("creator did not expose a canvas ID");
		const invite = await page.locator("#canvasInvite").inputValue();
		expect(invite).not.toBe("");

		const copyableId = page.getByRole("button", { name: /copy canvas invite/iu });
		await copyableId.click();
		await expect(page.getByRole("status", { name: "Canvas copy status" })).toContainText(/could not copy/iu);
		await expect(copyableId).toContainText(canvasId);
		await expect(copyableId).toBeVisible();
		await expect(page.locator("#canvasInvite")).toBeVisible();
		await expect(page.locator("#canvasInvite")).toHaveValue(invite);
	} finally {
		await context.close();
	}
});

test("join refuses a bare object ID and altered invite, then accepts the original authenticated invite", async ({
	browser,
}) => {
	const creatorContext = await browser.newContext();
	const observerContext = await browser.newContext();
	await installGridRoomHeadAuthority([creatorContext, observerContext], HEAD_FACTORY);
	const creator = await creatorContext.newPage();
	const observer = await observerContext.newPage();
	try {
		await Promise.all([creator.goto("http://127.0.0.1:4180/"), observer.goto("http://127.0.0.1:4180/")]);
		await Promise.all([waitForRelayReservation(creator), waitForRelayReservation(observer)]);
		await Promise.all([waitForCanvasControls(creator), waitForCanvasControls(observer)]);
		await creator.locator("#create").click();
		await expect(creator.getByTestId("canvas-stage")).toBeVisible();
		const id = (await creator.locator("#canvasId").textContent())?.trim();
		if (!id) throw new Error("creator did not expose a canvas ID");
		const invite = await creator.locator("#canvasInvite").inputValue();
		for (const invalid of [id, `${invite}00`]) {
			await observer.locator("#canvasIdInput").fill(invalid);
			await observer.locator("#connect").click();
			await expect(observer.getByRole("status", { name: "Canvas connection status" })).toContainText(
				/invalid|could not|failed|refus/iu
			);
			await expect(observer.getByTestId("canvas-stage")).toBeHidden();
			await expect(observer.locator("#create")).toBeEnabled();
			await expect(observer.locator("#connect")).toBeEnabled();
		}
		await observer.locator("#canvasIdInput").fill(invite);
		await observer.locator("#connect").click();
		await expect(observer.getByTestId("canvas-stage")).toBeVisible();
		await expect(observer.locator("#canvasId")).toHaveText(id);
	} finally {
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

async function waitForCanvasControls(page: Page): Promise<void> {
	await expect(page.locator("#create")).toBeEnabled();
	await expect(page.locator("#connect")).toBeEnabled();
}

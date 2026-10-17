import { expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "../../../tests/fixtures/phase-3a1b/grid-room-head-authority";

const HEAD_FACTORY = "__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__";

test.beforeEach(async ({ request, context }) => {
	const response = await request.post("http://127.0.0.1:4175/grid-control/registry/reset");
	expect(response.ok()).toBe(true);
	await installGridRoomHeadAuthority([context], HEAD_FACTORY);
});

test("two modular peers join a room and exchange a message", async ({ browser }) => {
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	await installGridRoomHeadAuthority([creatorContext, joinerContext], HEAD_FACTORY);
	const creator = await creatorContext.newPage();
	const joiner = await joinerContext.newPage();
	const pageErrors: string[] = [];
	creator.on("pageerror", (error) => pageErrors.push("creator: " + error.message));
	joiner.on("pageerror", (error) => pageErrors.push("joiner: " + error.message));

	try {
		await Promise.all([creator.goto("http://127.0.0.1:4181/"), joiner.goto("http://127.0.0.1:4181/")]);
		await Promise.all([waitForRelayReservation(creator), waitForRelayReservation(joiner)]);
		await Promise.all([waitForChatControls(creator), waitForChatControls(joiner)]);
		await expect(creator.locator("#peerId")).not.toBeEmpty();
		await expect(joiner.locator("#peerId")).not.toBeEmpty();

		await creator.locator("#createRoom").click();
		await expect(creator.locator("#chatId")).toHaveAttribute("data-full-id", /.+/u);
		const roomId = await creator.locator("#chatId").getAttribute("data-full-id");
		if (roomId === null) throw new Error("creator did not expose a room ID");
		const invite = await creator.locator("#chatInvite").inputValue();
		expect(invite).not.toBe("");
		expect(invite).not.toBe(roomId);

		await joiner.locator("#roomInput").fill(roomId);
		await joiner.locator("#joinRoom").click();
		await expect(joiner.getByRole("status", { name: "Chat connection status" })).toHaveAttribute("data-state", "error");
		await expect(joiner.locator("#chatId")).toBeEmpty();
		await waitForChatControls(joiner);
		await joiner.locator("#roomInput").fill(invite);
		await joiner.locator("#roomInput").press("Enter");
		await expect(joiner.locator("#chatId")).toHaveAttribute("data-full-id", roomId);
		await expect(joiner.locator("#objectPeers")).not.toBeEmpty();
		await expect(joiner.getByRole("status", { name: "Chat connection status" })).toContainText(/observer|read.only/iu);
		await expect(joiner.locator("#messageInput")).toBeDisabled();
		await expect(joiner.locator("#sendMessage")).toBeDisabled();

		await creator.locator("#messageInput").fill("hello from the creator");
		await creator.locator("#messageInput").press("Enter");
		await expect(joiner.locator(".message-content")).toContainText("hello from the creator");
		await expect(creator.locator("#messageInput")).toHaveValue("");
		const message = creator.locator(".message").filter({ hasText: "hello from the creator" });
		const identity = await message.getAttribute("data-client-operation-id");
		const author = await message.getAttribute("data-author");
		const displayTime = await message.getAttribute("data-display-time-ms");
		const peerColor = await message.getAttribute("data-peer-color");
		expect(identity).not.toBeNull();
		expect(author).toMatch(/^[0-9a-f]{64}$/u);
		expect(displayTime).toMatch(/^[0-9]+$/u);
		if (identity === null || author === null || displayTime === null || peerColor === null)
			throw new Error("accepted Chat message is missing immutable display metadata");
		await expect(joiner.locator(".message")).toHaveAttribute("data-client-operation-id", identity);
		await expect(joiner.locator(".message")).toHaveAttribute("data-author", author);
		await expect(joiner.locator(".message")).toHaveAttribute("data-display-time-ms", displayTime);
		await expect(joiner.locator(".message")).toHaveAttribute("data-peer-color", peerColor);

		await joiner.reload();
		await waitForChatControls(joiner);
		await joiner.locator("#roomInput").fill(invite);
		await joiner.locator("#joinRoom").click();
		await expect(joiner.locator(".message-content")).toContainText("hello from the creator");
		await expect(joiner.locator(".message")).toHaveAttribute("data-client-operation-id", identity);
		await creator.locator("#messageInput").fill("continued after recipient reopen");
		await creator.locator("#sendMessage").click();
		await expect(joiner.locator(".message-content")).toHaveText([
			"hello from the creator",
			"continued after recipient reopen",
		]);
		expect(pageErrors).toEqual([]);
	} finally {
		await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
	}
});

test("signed Chat invite stays visible when clipboard fails and refused sends retain text", async ({
	page,
}, testInfo) => {
	await page.goto("http://127.0.0.1:4181/");
	await waitForRelayReservation(page);
	await waitForChatControls(page);
	await page.locator("#createRoom").click();
	await expect(page.locator("#messageInput")).toBeEnabled();
	const invite = await page.locator("#chatInvite").inputValue();
	await page.evaluate(() => {
		const writes: string[] = [];
		(window as typeof window & { __CHAT_CLIPBOARD_WRITES__?: string[] }).__CHAT_CLIPBOARD_WRITES__ = writes;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (text: string) => {
					writes.push(text);
					return Promise.resolve();
				},
			},
		});
	});
	await page.locator("#copyButton").click();
	await expect(page.getByRole("status", { name: "Chat invite copy status" })).toContainText(/copied/iu);
	expect(
		await page.evaluate(
			() => (window as typeof window & { __CHAT_CLIPBOARD_WRITES__?: string[] }).__CHAT_CLIPBOARD_WRITES__
		)
	).toEqual([invite]);
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: () => Promise.reject(new Error("clipboard denied")) },
		});
	});
	await page.locator("#copyButton").click();
	await expect(page.getByRole("status", { name: "Chat invite copy status" })).toContainText(/manual copying/iu);
	await expect(page.locator("#chatInvite")).toHaveValue(invite);
	// A complete oversize command refuses under the existing product bound.
	// This is not proof-budget success or a capacity/performance benchmark.
	const refused = "x".repeat(65_537);
	await page.locator("#messageInput").fill(refused);
	await page.locator("#sendMessage").click();
	await expect(page.getByRole("status", { name: "Chat connection status" })).toHaveAttribute("data-state", "error");
	await expect(page.locator("#messageInput")).toHaveValue(refused);
	await expect(page.locator(".message")).toHaveCount(0);
	await page.locator("#messageInput").fill("valid after refusal");
	await page.locator("#sendMessage").click();
	await expect(page.locator(".message-content")).toHaveText("valid after refusal");
	await expect(page.locator("#messageInput")).toHaveValue("");
	await expect(page.getByRole("status", { name: "Chat connection status" })).toHaveAttribute("data-state", "ready");
	await page.locator("#themeToggle").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(page.locator("body")).toHaveCSS("background-color", "rgb(18, 18, 18)");
	await expect(page.locator("body")).toHaveCSS("color", "rgb(224, 224, 224)");
	await expect(page.locator("#chat")).toHaveCSS("background-color", "rgb(30, 30, 30)");
	await page.screenshot({ path: testInfo.outputPath("chat-desktop-dark.png"), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator("#infoToggle")).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("chat-narrow-dark.png"), fullPage: true });
});

async function waitForChatControls(page: Page): Promise<void> {
	await expect(page.locator("#createRoom")).toBeEnabled();
	await expect(page.locator("#joinRoom")).toBeEnabled();
}

async function waitForRelayReservation(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const session = (
			window as typeof window & {
				__TS_DRP_CHAT_SESSION__?: { snapshot(): { relayReservations: readonly unknown[] } };
			}
		).__TS_DRP_CHAT_SESSION__;
		return (session?.snapshot().relayReservations.length ?? 0) >= 1;
	});
}

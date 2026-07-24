import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
	const response = await request.post("http://127.0.0.1:4175/grid-control/registry/reset");
	expect(response.ok()).toBe(true);
});

test("two modular peers join a room and exchange a message", async ({ browser }) => {
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	const creator = await creatorContext.newPage();
	const joiner = await joinerContext.newPage();

	try {
		await Promise.all([creator.goto("http://127.0.0.1:4181/"), joiner.goto("http://127.0.0.1:4181/")]);
		await Promise.all([waitForRelayReservation(creator), waitForRelayReservation(joiner)]);
		await expect(creator.locator("#peerId")).not.toBeEmpty();
		await expect(joiner.locator("#peerId")).not.toBeEmpty();

		await creator.locator("#createRoom").click();
		await expect(creator.locator("#chatId")).toHaveAttribute("data-full-id", /.+/u);
		const roomId = await creator.locator("#chatId").getAttribute("data-full-id");
		if (roomId === null) throw new Error("creator did not expose a room ID");

		await joiner.locator("#roomInput").fill(roomId);
		await joiner.locator("#joinRoom").click();
		await expect(joiner.locator("#chatId")).toHaveAttribute("data-full-id", roomId);
		await expect(joiner.locator("#objectPeers")).not.toBeEmpty();

		await creator.locator("#messageInput").fill("hello from the creator");
		await creator.locator("#sendMessage").click();
		await expect(joiner.locator(".message-content")).toContainText("hello from the creator");
	} finally {
		await Promise.allSettled([creatorContext.close(), joinerContext.close()]);
	}
});

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

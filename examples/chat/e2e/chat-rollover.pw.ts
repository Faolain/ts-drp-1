import { expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "../../../tests/fixtures/phase-3a1b/grid-room-head-authority";

// App rollover delivery: the shipped Chat page in two browsers. The creator sends past two of its
// rollover budgets (20 messages, or half the checkpoint allowance, examples/chat/src/rollover.ts);
// the joiner's page (an observer) follows each successor through the page's own successor
// delivery (no window publisher hook is installed) and shows every message. A message sent after
// a rollover reaches the joiner only once it has installed that successor.

const HEAD_FACTORY = "__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__";
const MESSAGES = 46;

test.beforeEach(async ({ request }) => {
	const response = await request.post("http://127.0.0.1:4175/grid-control/registry/reset");
	expect(response.ok()).toBe(true);
});

test("a joiner's page follows the creator's automatic rollovers through the page delivery", async ({ browser }) => {
	test.setTimeout(300_000);
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	await installGridRoomHeadAuthority([creatorContext], HEAD_FACTORY);
	await installGridRoomHeadAuthority([joinerContext], HEAD_FACTORY, "create");
	const creator = await creatorContext.newPage();
	const joiner = await joinerContext.newPage();
	const pageErrors: string[] = [];
	const logs: string[] = [];
	creator.on("pageerror", (error) => pageErrors.push(`creator: ${error.message}`));
	joiner.on("pageerror", (error) => pageErrors.push(`joiner: ${error.message}`));
	for (const [name, page] of [
		["creator", creator],
		["joiner", joiner],
	] as const)
		page.on("console", (message) => {
			if (/successor|rollover|refused|failed/iu.test(message.text()))
				logs.push(`${Date.now()} ${name}: ${message.type()} ${message.text().slice(0, 400)}`);
		});
	try {
		await Promise.all([creator.goto("http://127.0.0.1:4181/"), joiner.goto("http://127.0.0.1:4181/")]);
		await Promise.all([waitForRelayReservation(creator), waitForRelayReservation(joiner)]);
		await expect(creator.locator("#createRoom")).toBeEnabled();
		await creator.locator("#createRoom").click();
		await expect(creator.locator("#chatId")).toHaveAttribute("data-full-id", /.+/u);
		const roomId = await creator.locator("#chatId").getAttribute("data-full-id");
		await expect(creator.locator("#chatInvite")).not.toHaveValue("");
		const invite = await creator.locator("#chatInvite").inputValue();
		await expect(joiner.locator("#joinRoom")).toBeEnabled();
		await joiner.locator("#roomInput").fill(invite);
		await joiner.locator("#roomInput").press("Enter");
		await expect(joiner.locator("#chatId")).toHaveAttribute("data-full-id", roomId ?? "");
		const sent: string[] = [];
		for (let index = 0; index < MESSAGES; index++) {
			const text = `rollover message ${String(index).padStart(2, "0")}`;
			await creator.locator("#messageInput").fill(text);
			await creator.locator("#messageInput").press("Enter");
			await expect(creator.locator("#messageInput")).toHaveValue("", { timeout: 60_000 });
			sent.push(text);
		}
		for (const text of sent)
			await expect(joiner.locator(".message-content", { hasText: text }), `joiner shows "${text}"`).toHaveCount(1, {
				timeout: 180_000,
			});
		expect(pageErrors).toEqual([]);
	} finally {
		console.log(`CHAT_ROLLOVER_BROWSER_LOGS\n${logs.slice(-80).join("\n")}`);
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

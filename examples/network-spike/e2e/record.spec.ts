import { expect, test } from "@playwright/test";

test("renders accepted canonical record evidence and exact altered-fixture codes", async ({ page, browserName }) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.goto("/record");

	await expect(page.locator("[data-record-status]")).toHaveAttribute("data-record-status", "accepted");
	await expect(page.locator(".record-terminal-boundary")).toContainText("NOT MEMBERSHIP");
	await expect(page.locator(".record-terminal-boundary")).toContainText("NOT DRP-AUTHORIZED");
	await expect(page.locator(".record-trace")).toContainText("record-fixture-v1");
	await expect(page.locator(".record-trace")).toContainText("sha256:");
	for (const code of [
		"accepted",
		"invalid-signature",
		"expired",
		"unsafe-address",
		"admission-required",
		"replayed-sequence",
		"response-cap-exceeded",
	]) {
		await expect(page.locator(`[data-record-case="${code}"]`)).toHaveAttribute("data-pass", "true");
	}
	await expect(page.locator(".record-boundary")).toContainText("A signature is not membership");
	await expect(page.locator(".record-pipeline-external")).toContainText("EXTERNAL POLICY BOUNDARY");
	await expect(page.locator('[data-record-case="invalid-signature"]')).toContainText("EXPECTED REJECTION MATCHED");
	await expect(page.locator('[data-record-case="invalid-signature"]')).toContainText("Expected");
	await expect(page.locator('[data-record-case="invalid-signature"]')).toContainText("Actual");
	await expect(page.locator(".record-facts")).toContainText("ABSENT FROM RECORD");
	await expect(page.locator(".record-raw")).not.toContainText('"peerId"');
	await expect(page.locator(".record-raw")).not.toContainText('"signature"');

	await page.setViewportSize({ width: 390, height: 844 });
	const dimensions = await page.evaluate(() => ({
		client: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth,
	}));
	expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
	expect(consoleErrors, `${browserName} console errors`).toEqual([]);
});

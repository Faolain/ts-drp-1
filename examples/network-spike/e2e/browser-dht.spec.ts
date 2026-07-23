import { expect, test } from "@playwright/test";

test("renders an evidence-backed browser DHT rejection", async ({ page, browserName }) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.goto("/browser-dht");
	const terminal = page.locator("[data-dht-status]");
	await expect(terminal).toHaveAttribute("data-dht-status", "rejected", { timeout: 20_000 });
	await expect(terminal).toHaveAttribute("data-dht-reason", "browser-provider-has-no-dialable-address");
	await expect(page.locator('[data-check="host-construction"]')).toHaveAttribute("data-pass", "true");
	await expect(page.locator('[data-check="fixture-connection"]')).toHaveAttribute("data-pass", "true");
	await expect(page.locator('[data-check="dht-peer-lookup"]')).toHaveAttribute("data-pass", "true");
	await expect(page.locator('[data-check="add_provider-response"]')).toHaveAttribute("data-pass", "true");
	await expect(page.locator('[data-check="provider-query-completed"]')).toHaveAttribute("data-pass", "true");
	await expect(page.locator('[data-check="provider-observed"]')).toHaveAttribute("data-pass", "false");
	await expect(page.locator("[data-bundle-forbidden-count]")).toHaveAttribute("data-bundle-forbidden-count", "0");
	await expect(page.locator(".dht-terminal")).toContainText("rejected");
	await expect(page.locator(".dht-metric-rack")).toContainText("DIALABLE ADDRS");
	await page.setViewportSize({ width: 390, height: 844 });
	const dimensions = await page.evaluate(() => ({
		client: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth,
	}));
	expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
	expect(consoleErrors, `${browserName} console errors`).toEqual([]);
});

test("renders a typed, versioned rejection when the local fixture is unavailable", async ({ page }) => {
	await page.route("http://127.0.0.1:4177/health", (route) => route.abort());
	await page.goto("/browser-dht");
	const terminal = page.locator("[data-dht-status]");
	await expect(terminal).toHaveAttribute("data-dht-status", "rejected");
	await expect(terminal).toHaveAttribute("data-dht-reason", "fixture-unreachable");
	await expect(page.locator(".dht-raw")).toContainText('"packageVersions"');
	await expect(page.locator(".dht-raw")).toContainText('"bundleEvidence"');
});

import { expect, test } from "@playwright/test";

test("proves two-endpoint signed-registry refresh and failover with bounded admission evidence", async ({ page }) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.goto("/rendezvous");
	await expect(page.locator("[data-registry-status]")).toHaveAttribute("data-registry-status", "accepted");
	await expect(page.locator("[data-registry-status]")).toContainText("FIXTURE MATCH");
	await expect(page.locator("[data-registry-status]")).toContainText("10/10 FIXTURE ASSERTIONS");
	await expect(page.locator("[data-registry-status]")).toContainText("6 REGISTRY · 4 ANCHOR");
	await expect(page.locator(".endpoint-down")).toContainText("OFFLINE");
	await expect(page.locator(".endpoint-down")).toContainText("endpoint-unavailable");
	await expect(page.locator(".endpoint-live")).toContainText("RECORD FOUND");
	await expect(page.locator(".endpoint-live")).toContainText("sequence 2");
	await expect(page.locator(".endpoint-live")).toContainText("untrusted dial candidate");
	await expect(page.locator(".admission-card")).toHaveCount(4);
	await expect(page.locator(".admission-card > strong").filter({ hasText: "ACCEPTED" })).toHaveCount(0);
	await expect(page.locator(".admission-open")).toContainText("CANARY REGISTERED");
	await expect(page.locator(".admission-open")).toContainText("EXPLICITLY SYBIL-UNSAFE CANARY");
	await expect(page.locator(".registry-comparison")).toContainText("Neither path proves DRP authorization");
	await expect(page.locator(".registry-raw")).not.toContainText("fixture-invite-token");
	await expect(page.locator(".registry-trace")).toContainText("CREDENTIAL FIELDS 0");
	expect(consoleErrors).toEqual([]);
});

test("shows that the DHT anchor advertises only its Node and exposes a longer dependency chain", async ({ page }) => {
	await page.goto("/anchor");
	await expect(page.locator("[data-registry-status]")).toHaveAttribute("data-registry-status", "accepted");
	await expect(page.getByRole("heading", { name: /waypoint/i })).toBeVisible();
	await expect(page.locator(".anchor-warning")).toContainText("BROWSER PROVIDER CLAIM: REJECTED");
	await expect(page.locator(".anchor-chain li")).toHaveCount(4);
	await expect(page.locator(".anchor-case-grid article")).toHaveCount(4);
	await expect(page.locator(".anchor-assertion-note")).toContainText("4 / 4 ANCHOR-SPECIFIC");
	await expect(page.locator(".anchor-chain")).toContainText("configured-node-anchor-only");
	await expect(page.locator(".comparison-table")).toContainText(
		"public DHT + delegated endpoint + Node anchor operator"
	);
	await expect(page.locator(".comparison-note")).toContainText("literal TTL + DNS safety recheck");
	await expect(page.locator(".comparison-note")).toContainText("must not be compared across reloads");
});

test("keeps both Phase 05 decision views usable on a narrow browser without overflow", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	for (const route of ["/rendezvous", "/anchor"]) {
		await page.goto(route);
		await expect(page.locator("[data-registry-status]")).toHaveAttribute("data-registry-status", "accepted");
		const dimensions = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
	}
});

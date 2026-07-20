import { expect, test } from "@playwright/test";

const FAILOVER_SCENARIOS = [
	"cors",
	"timeout",
	"malformed",
	"oversized",
	"poisoned",
	"rate-limit",
	"outage",
	"failover",
] as const;

test("delegated workbench shows raw/accepted addresses and structural no-publication proof", async ({ page }) => {
	await page.goto("/delegated?fixture=success&operation=peer");
	await expect(page.getByRole("heading", { name: /HTTP routing/i })).toBeVisible();
	await expect(page.locator("[data-terminal]")).toHaveAttribute("data-terminal", "success");
	await expect(page.locator(".address-row")).toHaveCount(4);
	await expect(page.locator(".address-row.accepted")).toHaveCount(2);
	await expect(page.locator(".address-row.rejected")).toHaveCount(2);
	await expect(page.locator("[data-can-provide]")).toHaveAttribute("data-can-provide", "false");
	await expect(page.locator("[data-can-provide]")).toContainText("ABSENT");
});

for (const scenario of FAILOVER_SCENARIOS) {
	test(`${scenario} is diagnosed and fails over in order`, async ({ page }) => {
		await page.goto(`/delegated?fixture=${scenario}&operation=peer`);
		await expect(page.locator("[data-terminal]")).toHaveAttribute("data-terminal", "success");
		await expect(page.locator(".trace-card").last().locator(".attempt-row")).toHaveCount(2);
		await expect(page.locator(".trace-card").last().locator(".attempt-row").first()).toContainText("primary");
		await expect(page.locator(".trace-card").last().locator(".attempt-row").last()).toContainText("secondary");
	});
}

test("empty and legacy 404 are exact empty terminals, not outages", async ({ page }) => {
	for (const scenario of ["empty", "404"]) {
		await page.goto(`/delegated?fixture=${scenario}&operation=providers`);
		await expect(page.locator("[data-terminal]")).toHaveAttribute("data-terminal", "empty");
		await expect(page.locator(".attempt-row")).toHaveCount(1);
		await expect(page.locator(".attempt-row")).toContainText("404");
	}
});

test("cache TTL, disabled cache, and stale refresh are visible", async ({ page }) => {
	await page.goto("/delegated?fixture=cache&operation=peer");
	await expect(page.locator(".trace-card")).toHaveCount(2);
	await expect(page.locator(".trace-card").last()).toContainText("HIT");
	await expect(page.locator(".trace-card").last()).toContainText("No network attempt");

	await page.goto("/delegated?fixture=cache-disabled&operation=peer");
	await expect(page.locator(".trace-card")).toHaveCount(2);
	await expect(page.locator(".trace-card").last()).toContainText("DISABLED");
	await expect(page.locator(".trace-card").last().locator(".attempt-row")).toHaveCount(1);

	await page.goto("/delegated?fixture=stale&operation=peer");
	await expect(page.locator(".trace-card")).toHaveCount(2);
	await expect(page.locator(".trace-card").last()).toContainText("STALE");
	await expect(page.locator(".trace-card").last().locator(".attempt-row")).toHaveCount(1);
});

test("caller abort is terminal and does not fail over", async ({ page }) => {
	await page.goto("/delegated?fixture=abort&operation=peer");
	await expect(page.locator("[data-terminal]")).toHaveAttribute("data-terminal", "aborted");
	await expect(page.locator(".attempt-row")).toHaveCount(1);
});

test("provider and closest operations use the same bounded adapter", async ({ page }) => {
	for (const operation of ["providers", "closest"]) {
		await page.goto(`/delegated?fixture=success&operation=${operation}`);
		await expect(page.locator("[data-terminal]")).toHaveAttribute("data-terminal", "success");
		await expect(page.locator(".peer-card")).toHaveCount(1);
	}
});

test("public mode remains blocked without the exact acknowledgement", async ({ page }) => {
	await page.goto("/delegated?mode=public&endpoint=https%3A%2F%2Fdelegated-ipfs.dev");
	await expect(page.getByRole("heading", { name: /Explicit consent required/i })).toBeVisible();
	await expect(page.locator("body")).toContainText("No request was made");
});

import { expect, test } from "@playwright/test";

test("all-refused evidence replay is complete, filterable, and redacted", async ({ page }) => {
	await page.goto("/evidence?fixture=all-refused");
	await expect(page.getByRole("heading", { name: /Every refusal/i })).toBeVisible();
	await expect(page.getByLabel("Expected terminal failure")).toContainText("REFUSED");
	await expect(page.locator(".event-card")).toHaveCount(30);
	await expect(page.locator(".event-card").last()).toContainText("all-candidates-refused");
	await expect(page.locator(".event-card").last()).toContainText("T+1526 ms");

	await page.getByRole("button", { name: /Replay sequence/u }).click();
	await expect(page.locator("[data-timeline]")).toHaveClass(/is-replaying/u);

	await page.getByRole("button", { name: "Relay", exact: true }).click();
	await expect(page.locator(".event-card:visible")).toHaveCount(20);
	await page.getByRole("button", { name: "Terminal", exact: true }).click();
	await expect(page.locator(".event-card:visible")).toHaveCount(2);

	await page.getByText(/Open 30 sanitized rows/u).click();
	const jsonl = await page.locator("pre").textContent();
	expect(jsonl).not.toMatch(/12D3Koo|16Uiu2H|Qm|\/ip[46]\//u);
	expect(jsonl?.trim().split("\n")).toHaveLength(30);
});

import { expect, type Page, test } from "@playwright/test";
import type { EnvironmentBlockedCampaignReport } from "@ts-drp/network-spike/public-campaign";

test("Phase 09 reports environment-blocked coverage without public egress or synthetic trials", async ({ page }) => {
	const publicRequests: string[] = [];
	page.on("request", (request) => {
		const target = new URL(request.url());
		if (!["127.0.0.1", "localhost"].includes(target.hostname)) publicRequests.push(request.url());
	});

	await page.goto("/public-campaign");
	const root = page.locator("[data-public-campaign-ready]");
	await expect(root).toHaveAttribute("data-status", "environment-blocked");
	await expect(root).toHaveAttribute("data-public-requests", "0");
	await expect(page.locator('[data-satisfied="false"]')).toHaveCount(3);
	await expect(page.getByText("UNSATISFIED")).toBeVisible();
	await expect(page.getByText("Missing evidence stays missing.")).toBeVisible();

	const report = await readReport(page);
	expect(report).toMatchObject({
		criterionSatisfied: false,
		observations: [],
		publicRequests: 0,
		requestBudget: { consumed: 0, hardCap: 12_920 },
		status: "environment-blocked",
	});
	expect(report.plannedMatrix).toMatchObject({
		browserTrials: 600,
		nodeTrials: 200,
		requiredTrialCount: 800,
	});
	for (const browser of ["chromium", "firefox", "webkit"]) {
		await expect(page.getByText(`${browser} canary`, { exact: true })).toHaveCount(2);
	}
	await page.setViewportSize({ height: 844, width: 390 });
	await page.reload();
	const viewport = await page.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
	await expect(page.locator(".public-board__matrix-table")).toBeHidden();
	await expect(page.locator(".public-board__mobile-matrix section")).toHaveCount(2);
	await expect(page.locator(".public-board__mobile-matrix section").first().locator("div")).toHaveCount(4);
	await expect(
		page
			.locator(".public-board__mobile-matrix section")
			.first()
			.getByText(/1 Phase 07 canary/u)
	).toHaveCount(3);
	expect(publicRequests).toEqual([]);
});

async function readReport(page: Page): Promise<EnvironmentBlockedCampaignReport> {
	const raw = await page.locator("[data-public-campaign-json]").textContent();
	if (raw === null) throw new Error("public campaign report missing");
	return JSON.parse(raw) as EnvironmentBlockedCampaignReport;
}

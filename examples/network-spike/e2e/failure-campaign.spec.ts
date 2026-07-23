import { expect, type Page, test } from "@playwright/test";
import type { FailureCampaignReport } from "@ts-drp/network-spike/failure-campaign";

test("Phase 08 deterministic campaign renders every bounded terminal without public egress", async ({ page }) => {
	const publicRequests: string[] = [];
	page.on("request", (request) => {
		const target = new URL(request.url());
		if (!["127.0.0.1", "localhost"].includes(target.hostname)) publicRequests.push(request.url());
	});
	await page.goto("/failure-campaign");
	await expect(page.locator("[data-failure-ready]")).toHaveAttribute("data-total", "24");
	await expect(page.locator("[data-failure-ready]")).toHaveAttribute("data-passed", "24");
	await expect(page.locator("[data-scenario]")).toHaveCount(24);
	await expect(page.locator('[data-verdict="fail"]')).toHaveCount(0);
	await expect(page.locator("[data-category]")).toHaveCount(6);

	const report = await readReport(page);
	expect(report.noPublicEgress).toBe(true);
	expect(report.summary).toEqual({ failed: 0, passed: 24, total: 24 });
	expect(report.scenarios.every(({ checks }) => checks.every(({ passed }) => passed))).toBe(true);
	expect(report.scenarios.every(({ cleanup }) => cleanup.failed === 0)).toBe(true);
	expect(report.scenarios.find(({ id }) => id === "all-dependencies-down")).toMatchObject({
		attempts: 8,
		backoffs: 2,
		childBudgets: [
			{ abortObserved: true, budgetMs: 8_000, outcome: "timed-out", owner: "registry-and-routing" },
			{ abortObserved: true, budgetMs: 5_000, outcome: "timed-out", owner: "relay-search" },
			{ abortObserved: true, budgetMs: 12_000, outcome: "timed-out", owner: "owned-fallback" },
		],
		controlPlaneHealth: {
			productionReconnectRedesignUnshipped: true,
			reconnectAttempts: 1,
			state: "terminal",
		},
		durationMs: 29_999,
		passed: true,
		status: "failure",
		terminal: "total-outage",
	});
	await expect(page.locator('[data-scenario="all-dependencies-down"]')).toHaveAttribute(
		"data-terminal",
		"total-outage"
	);
	await expect(page.locator(".failure-lab__egress")).toHaveText("LOCAL FIXTURE ONLY");
	expect(publicRequests).toEqual([]);
});

async function readReport(page: Page): Promise<FailureCampaignReport> {
	const raw = await page.locator("[data-failure-json]").textContent();
	if (raw === null) throw new Error("failure campaign report missing");
	return JSON.parse(raw) as FailureCampaignReport;
}

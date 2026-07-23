import { expect, test } from "@playwright/test";

test.describe("Phase 06 relay policy lab", () => {
	test("renders the mixed closest-peer fixture with two decoded diverse reservations", async ({ page }) => {
		const errors: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
		await page.goto("/relay?scenario=mixed&profile=broad-browser");
		await expect(page.locator("[data-relay-terminal=reserved]")).toBeVisible();
		await expect(page.locator("[data-relay-assertion]")).toHaveCount(8);
		await expect(page.locator("[data-relay-assertion][data-pass=true]")).toHaveCount(8);
		await expect(page.getByText("RESERVED × 2")).toBeVisible();
		await expect(page.getByText("DIVERSITY CONTRACT MET")).toBeVisible();
		await expect(page.locator("[data-relay-status=reserved]")).toHaveCount(2);
		await expect(page.locator(".relay-provenance")).toContainText("browser-closest-peers");
		await expect(page.getByText("Actual reservation status decoded", { exact: true })).toBeVisible();
		await expect(page.getByText("OVERFLOW VERDICT ONLY")).toBeVisible();
		await expect(page.locator("[data-relay-bound=max-candidates]")).toHaveAttribute("data-relay-bound-value", "6");
		await expect(page.locator("[data-relay-bound=per-candidate-deadline-ms]")).toHaveAttribute(
			"data-relay-bound-value",
			"100 ms"
		);
		await expect(page.locator("[data-relay-bound=total-deadline-ms]")).toHaveAttribute(
			"data-relay-bound-value",
			"500 ms"
		);
		expect(errors).toEqual([]);
	});

	test("switches to all-refused and reaches the fresh owned fallback", async ({ page }) => {
		await page.goto("/relay");
		await page.locator("[data-relay-scenario=all-refused]").click();
		await page.locator("[data-relay-run]").click();
		await expect(page).toHaveURL(/scenario=all-refused/u);
		await expect(page.locator("[data-relay-terminal=owned-fallback]")).toBeVisible();
		await expect(page.getByText("OWNED FALLBACK", { exact: true }).first()).toBeVisible();
		await expect(page.locator("[data-relay-status=refused]")).toHaveCount(4);
		await expect(page.locator("[data-relay-assertion][data-pass=true]")).toHaveCount(8);
	});

	test("shows WSS-only exhaustion without claiming baseline readiness", async ({ page }) => {
		await page.goto("/relay?scenario=mixed&profile=wss-only");
		await expect(page.locator("[data-relay-terminal=exhausted]")).toBeVisible();
		await expect(page.locator("[data-relay-status=reserved]")).toHaveCount(1);
		await expect(page.locator("[data-relay-status=no-compatible-address]")).toHaveCount(2);
		await expect(page.getByText("PUBLIC PATH NOT BASELINE-READY")).toBeVisible();
		await expect(page.locator("[data-relay-assertion][data-pass=true]")).toHaveCount(8);
	});

	test("keeps the full policy legible at a narrow viewport without overflow", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/relay?scenario=stale-fallback&profile=broad-browser");
		await expect(page.locator("[data-relay-terminal=exhausted]")).toBeVisible();
		await expect(page.getByText("Neither public reservations nor a fresh owned fallback")).toBeVisible();
		const dimensions = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
	});
});

import { expect, test } from "@playwright/test";

import type { BrowserControl } from "./browser-entry.js";
import { type BrowserServer, startBrowserServer } from "./browser-server.js";

let server: BrowserServer;
test.beforeAll(async () => {
	server = await startBrowserServer();
});
test.afterAll(async () => {
	await server.close();
});

for (const group of ["named", "messages", "exhaustive", "bom-surrogate-reset"] satisfies BrowserControl[]) {
	test(`unmodified built canonical browser compatibility: ${group}`, async ({ page }, info) => {
		await page.goto(server.origin);
		await page.waitForFunction(() => typeof window.runCanonicalBrowserControls === "function");
		const result = await page.evaluate((group) => window.runCanonicalBrowserControls(group), group);
		expect(result.moduleUrl).toBe(`${server.origin}/entry.js`);
		expect(result.group).toBe(group);
		expect(result.cases).toBe({ "named": 168, "messages": 8, "exhaustive": 65792, "bom-surrogate-reset": 14 }[group]);
		if (group === "exhaustive") {
			expect(result.accepted).toBe(18432);
			expect(result.rejected).toBe(47360);
		}
		await info.attach("ordinary-codec-compatibility", {
			body: JSON.stringify({ engine: info.project.name, ...result, artifact: server.evidence }),
			contentType: "application/json",
		});
	});
}

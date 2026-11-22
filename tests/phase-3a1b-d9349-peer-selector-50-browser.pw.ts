import { expect, test } from "@playwright/test";
import path from "node:path";

test("50 isolated browser nodes retain the 42 discovery plus six explicit ceiling", async ({ browser, baseURL }) => {
	if (baseURL === undefined) throw new Error("expected browser fixture base URL");
	const moduleUrl = `/@fs/${path.join(
		process.cwd(),
		"tests/fixtures/phase-3a1b-d9349-peer-selector/browser-fixture.ts"
	)}`;
	const probe = await browser.newPage();
	await probe.route("**/__t3_blank", async (route) =>
		route.fulfill({ body: "<!doctype html><title>T3 fixture</title>", contentType: "text/html" })
	);
	await probe.goto(`${baseURL}/__t3_blank`);
	const installed = await probe.evaluate(async (url) => {
		const fixture = (await import(url)) as { hasPeerSelectorRuntime(): boolean };
		return fixture.hasPeerSelectorRuntime();
	}, moduleUrl);
	await probe.close();
	test.skip(!installed, "T3 production selector is not installed by GREEN");
	const totals = { admitted: 0, refused: 0 };

	for (let offset = 0; offset < 50; offset += 5) {
		const pages = await Promise.all(
			Array.from({ length: 5 }, async () => {
				const page = await browser.newPage();
				await page.route("**/__t3_blank", async (route) =>
					route.fulfill({ body: "<!doctype html><title>T3 fixture</title>", contentType: "text/html" })
				);
				await page.goto(`${baseURL}/__t3_blank`);
				return page;
			})
		);
		try {
			const batch = await Promise.all(
				pages.map((page) =>
					page.evaluate(async (url) => {
						const fixture = (await import(url)) as {
							runBrowserPeerSelectorCeiling(): Promise<{
								afterDiscovery: Readonly<Record<string, number>>;
								afterExplicit: Readonly<Record<string, number>>;
								seventhExplicitDenied: boolean;
							}>;
						};
						return fixture.runBrowserPeerSelectorCeiling();
					}, moduleUrl)
				)
			);
			for (const evidence of batch) {
				expect(evidence.afterDiscovery.selected).toBe(42);
				expect(evidence.afterDiscovery.denied).toBe(7);
				expect(evidence.afterExplicit.charged).toBe(6);
				expect(evidence.seventhExplicitDenied).toBe(true);
				totals.admitted += evidence.afterDiscovery.selected;
				totals.refused += evidence.afterDiscovery.denied;
			}
		} finally {
			await Promise.all(pages.map((page) => page.close()));
		}
	}

	expect(totals).toEqual({ admitted: 2_100, refused: 350 });
});

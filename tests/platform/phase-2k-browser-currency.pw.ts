import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

function requiredEnvironment(name: "PHASE_2K_GIT_SHA" | "PHASE_2K_RUN_ID" | "PHASE_2K_RUN_ROOT"): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} was not established by global setup`);
	return value;
}

test("observes the exact launched root engine build", async ({ browser, browserName, page }) => {
	await page.route("**/*", (route) =>
		route.fulfill({ body: "<!doctype html><title>browser currency</title>", contentType: "text/html", status: 200 })
	);
	await page.goto("https://browser-currency.invalid/");
	expect(await page.title()).toBe("browser currency");
	const runRoot = requiredEnvironment("PHASE_2K_RUN_ROOT");
	const recordPath = path.join(runRoot, "records", `${browserName}.json`);
	fs.writeFileSync(
		recordPath,
		`${JSON.stringify({
			browserVersion: browser.version(),
			engine: browserName,
			gitSha: requiredEnvironment("PHASE_2K_GIT_SHA"),
			runId: requiredEnvironment("PHASE_2K_RUN_ID"),
		})}\n`,
		{ encoding: "utf8", flag: "wx" }
	);
});

import { expect, test } from "@playwright/test";

import { type ReaderServer, start } from "./browser-server.js";
import { READ_CASES } from "./cases.js";
import type { ReadReport } from "./contract.js";
import type {} from "./browser-owner.js";

let server: ReaderServer;
test.beforeAll(async () => {
	server = await start();
});
test.afterAll(async () => {
	await server?.close();
});

for (const name of READ_CASES) {
	test(`native IndexedDB reader: ${name}`, async ({ page, context }, info) => {
		await page.goto(server.origin);
		await page.waitForFunction(() => typeof window.readerRed === "object");
		const baseline = await page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name).sort());
		expect(baseline, "fresh context has no unowned fixture databases").toEqual([]);
		const database = `reader-red-${info.project.name}-${name}-${crypto.randomUUID()}`;
		const setupRealm = await page.evaluate(() => window.readerRed.realm);
		const setup = await page.evaluate(({ name, database }) => window.readerRed.setup(name, database), {
			name,
			database,
		});
		await page.close();
		const recovery = await context.newPage();
		try {
			await recovery.goto(server.origin);
			await recovery.waitForFunction(() => typeof window.readerRed === "object");
			expect(await recovery.evaluate(() => window.readerRed.realm)).not.toBe(setupRealm);
			expect(
				await recovery.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name).sort())
			).toEqual([database + "--drp-snapshot-quarantine-v1"]);
			const result = (await recovery.evaluate(({ name, database }) => window.readerRed.run(name, database), {
				name,
				database,
			})) as ReadReport;
			await info.attach("reader-causal-result", {
				body: JSON.stringify({
					setup,
					result,
					origin: server.origin,
					engine: info.project.name,
					artifact: server.artifact,
				}),
				contentType: "application/json",
			});
			expect(result.preconditions.unchanged, "genuine native preconditions reached independently").toBe(true);
			expect(result.passed, result.mask ?? result.observed.detail).toBe(true);
		} finally {
			await recovery.evaluate((database) => window.readerRed.remove(database), database);
			expect(await recovery.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name))).toEqual([]);
			await recovery.close();
		}
	});
}

import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";
import {
	DISCOVERY_CASES,
	IDB_CASES,
	type Key,
} from "../../../tests/fixtures/snapshot-declaration-discovery/contract.js";
import { stable } from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import type {} from "./assets/snapshot-declaration-discovery-entry.js";

let server: Phase4cBrowserServer;
test.beforeAll(async () => {
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(import.meta.dirname, "assets/snapshot-declaration-discovery-entry.ts"),
	});
});
test.afterAll(async () => {
	await server.close();
});
test("native observation control", async ({ page }) => {
	await page.goto(server.origin);
	expect(await page.evaluate(() => window.runSnapshotDeclarationDiscovery("native-control"))).toEqual({
		native: true,
		instrumented: true,
		invalidObservationRejected: true,
	});
});
test("native setup controls (not discovery behavior)", async ({ page }) => {
	await page.goto(server.origin);
	for (const name of [...DISCOVERY_CASES, ...IDB_CASES])
		expect(await page.evaluate((name) => window.runSnapshotDeclarationDiscovery(name, true), name)).toEqual({
			case: name,
			setupValidated: true,
		});
});
for (const name of [...DISCOVERY_CASES, ...IDB_CASES])
	test(`2a native discovery ${name}`, async ({ page }, info) => {
		await page.goto(server.origin);
		try {
			const result = await page.evaluate((name) => window.runSnapshotDeclarationDiscovery(name), name);
			await info.attach("discovery-observation", { body: JSON.stringify(result), contentType: "application/json" });
			expect(result).toMatchObject({ case: name, passed: true });
		} catch (error) {
			await info.attach("discovery-readiness-or-failure", { body: String(error), contentType: "text/plain" });
			throw error;
		}
	});
test("fresh page reopens with database identity and exact key only", async ({ context, page }) => {
	await page.goto(server.origin);
	const primaryDatabaseName = `fresh-discovery-${crypto.randomUUID()}`;
	const seeded = (await page.evaluate(
		(name) => window.seedSnapshotDeclarationDiscovery(name),
		primaryDatabaseName
	)) as { key: Key; expected: unknown; image: string };
	await page.close();
	const fresh = await context.newPage();
	try {
		await fresh.goto(server.origin);
		const input = { primaryDatabaseName, key: seeded.key };
		expect(Object.keys(input).sort()).toEqual(["key", "primaryDatabaseName"]);
		const observation = (await fresh.evaluate((input) => window.reopenSnapshotDeclarationDiscovery(input), input)) as {
			result: unknown;
			image: string;
		};
		expect(stable(observation.result)).toBe(stable(seeded.expected));
		expect(observation.image).toBe(seeded.image);
	} finally {
		await fresh.evaluate((name) => window.deleteSnapshotDeclarationDiscovery(name), primaryDatabaseName);
		await fresh.close();
	}
});

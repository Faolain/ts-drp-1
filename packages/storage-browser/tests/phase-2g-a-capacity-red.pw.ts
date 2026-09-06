import { expect, test } from "@playwright/test";
import fs from "node:fs";

import { type Phase2gACapacityServer, startPhase2gACapacityServer } from "./phase-2g-a-capacity-server.js";

let server: Phase2gACapacityServer;

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2G_A_CAPACITY_ASSET_DIR;
	if (assetDirectory === undefined || !fs.existsSync(assetDirectory))
		throw new Error("Phase 2g-a capacity assets are absent");
	server = await startPhase2gACapacityServer(assetDirectory);
});

test.afterAll(async () => server.close());

test("inspects same-realm capacity after store open without requesting persistence", async ({ page }) => {
	await page.goto(server.baseURL);
	await page.waitForFunction(() => "phase2gACapacitySmoke" in globalThis);
	const observation = await page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2gACapacitySmoke") as { run(): Promise<unknown> };
		return harness.run();
	});
	expect.soft(observation).toMatchObject({
		factoryArity: 0,
		persistCalls: 0,
		portKeysValid: true,
		reportValidAndFrozen: true,
		storeOpened: true,
		trapReady: true,
	});
	expect.soft((observation as { realFactory: boolean }).realFactory).toBe(true);
});

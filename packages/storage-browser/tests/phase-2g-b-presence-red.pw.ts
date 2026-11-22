import { expect, test } from "@playwright/test";
import fs from "node:fs";

import { type Phase2gBPresenceServer, startPhase2gBPresenceServer } from "./phase-2g-b-presence-server.js";

let server: Phase2gBPresenceServer;

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2G_B_PRESENCE_ASSET_DIR;
	if (assetDirectory === undefined || !fs.existsSync(assetDirectory))
		throw new Error("Phase 2g-b presence assets are absent");
	server = await startPhase2gBPresenceServer(assetDirectory);
});

test.afterAll(async () => server.close());

test("uses one readonly getKey-only batch with detached lifecycle-safe results", async ({ page }) => {
	await page.goto(server.baseURL);
	await page.waitForFunction(() => "phase2gBPresenceContract" in globalThis);
	const observation = await page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2gBPresenceContract") as { run(): Promise<unknown> };
		return harness.run();
	});
	expect(observation).toEqual({
		afterClose: "STORE_CLOSED",
		afterPoison: "STORE_POISONED",
		poisonCause: "NON_CANONICAL_RECORD",
		positive: {
			blobGetKeys: 6,
			blobGets: 0,
			detachedResults: true,
			expected: expect.any(Array),
			first: expect.any(Array),
			frozenFirst: true,
			inputDetached: expect.any(Array),
			readonlyBlobTransactions: 3,
			second: expect.any(Array),
		},
		realProbe: true,
		substrateCauseSame: true,
		substrateReason: "SUBSTRATE_FAILURE",
	});
	const positive = (
		observation as {
			positive: { expected: boolean[]; first: boolean[]; inputDetached: boolean[]; second: boolean[] };
		}
	).positive;
	expect(positive.first).toEqual(positive.expected);
	expect(positive.second).toEqual(positive.expected);
	expect(positive.inputDetached).toEqual(positive.expected);
});

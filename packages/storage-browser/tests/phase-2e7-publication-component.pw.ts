import { expect, test } from "@playwright/test";
import fs from "node:fs";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import { PHASE_2E7_PUBLIC_RUNTIME_KEYS } from "./fixtures/phase-2e7-publication-component-contract.js";

let server: AssetServer;

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2E7_ASSET_DIR;
	if (assetDirectory === undefined || !fs.existsSync(assetDirectory))
		throw new TypeError("Phase 2e7 public component bundle is absent");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => server.close());

test("the package root passes the shared strict browser contract and persists across reopen", async ({ page }) => {
	await page.goto(server.issueTransitionURL("phase-2e7.html"));
	await page.waitForFunction(() => "phase2e7PublicComponent" in globalThis);
	const result = await page.evaluate(async () => {
		const harness = Reflect.get(globalThis, "phase2e7PublicComponent") as { run(): Promise<unknown> };
		return harness.run();
	});
	const { publicKeys, ...component } = result as { publicKeys: readonly string[] } & Record<string, unknown>;
	expect(component).toEqual({
		contract: { durability: "strict", signingEligibility: "backend-capability-required" },
		reopened: true,
		rollbackControl: {
			candidateState: "Complete",
			finalHeadGeneration: "d".repeat(64),
			futureGeneration: "d".repeat(64),
			result: "HEAD_CONFLICT",
		},
	});
	expect(publicKeys).toContain("createBrowserAheDurableStore");
	expect(publicKeys.every((key) => (PHASE_2E7_PUBLIC_RUNTIME_KEYS as readonly string[]).includes(key))).toBe(true);
});

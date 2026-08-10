import { expect, test } from "@playwright/test";
import fs from "node:fs";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import { aggregatePhase2h, phase2hStructuralEntries } from "./fixtures/phase-2h-a-aggregate.js";
import { PHASE_2H_KILL_TUPLE_IDS, PHASE_2H_REQUIRED_TUPLE_IDS } from "./fixtures/phase-2h-a-registry.js";

let server: AssetServer;

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2H_A_ASSET_DIR;
	if (assetDirectory === undefined || !fs.existsSync(assetDirectory))
		throw new TypeError("Phase 2h-a generated asset directory is unavailable");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => server.close());

test("authorized inert campaign emits no records and cannot satisfy the complete aggregate", async ({
	page,
	request,
}) => {
	const transitionURL = server.issueTransitionURL("phase-2h-a.html");
	await page.goto(transitionURL);
	await page.waitForFunction(() => "phase2hAInertCampaign" in globalThis);
	const observation = await page.evaluate(
		() => Reflect.get(globalThis, "phase2hAInertCampaign") as { campaign: string; emittedRecords: number }
	);
	expect(observation).toEqual({ campaign: "phase-2h-a/inert/v1", emittedRecords: 0 });

	const token = new URL(transitionURL).pathname.split("/")[2];
	if (token === undefined) throw new TypeError("Phase 2h-a server token is absent");
	server.revoke(token);
	expect((await request.get(transitionURL)).status()).toBe(404);

	const gitSha = process.env.PHASE_2H_A_GIT_SHA;
	const runId = process.env.PHASE_2H_A_RUN_ID;
	if (gitSha === undefined || runId === undefined) throw new TypeError("Phase 2h-a invocation identity is absent");
	const aggregate = aggregatePhase2h({
		entries: phase2hStructuralEntries(),
		gitSha,
		runId,
	});
	expect(aggregate.records).toEqual([]);
	expect(aggregate.missingTupleIds).toEqual(PHASE_2H_REQUIRED_TUPLE_IDS);
	expect(aggregate.missingKillPoints).toEqual(PHASE_2H_KILL_TUPLE_IDS);
	expect(aggregate.verdict).toBe("pass");
});

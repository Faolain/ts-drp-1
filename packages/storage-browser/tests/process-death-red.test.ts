import { describe, expect, it } from "vitest";

import { orderedKillPoints } from "../src/killpoints.js";
import {
	requireActualCampaignOutcomes,
	requireImplementedDriver,
	runInertCampaign,
} from "./fixtures/inert-campaign.js";

describe("Phase 2b causal process-death RED", () => {
	it("observes a real manifest hit from the Worker", async () => {
		const observation = await runInertCampaign(orderedKillPoints()[0] ?? null);
		requireImplementedDriver(observation, "real-hit");
		expect(observation.hits.length).toBeGreaterThan(0);
	});

	it("observes the armed cell at one without parent synthesis", async () => {
		const observation = await runInertCampaign(orderedKillPoints()[8] ?? null);
		requireImplementedDriver(observation, "armed-state");
		expect(observation.armedCellValue).toBe(1);
	});

	it("proves the non-vacuous thirteen-old/one-new outcome", async () => {
		const observation = await runInertCampaign(null);
		requireImplementedDriver(observation, "non-vacuous-outcome");
		requireActualCampaignOutcomes(observation);
	});

	it("measures exactly the child and browser process groups", async () => {
		const observation = await runInertCampaign(orderedKillPoints()[0] ?? null);
		requireImplementedDriver(observation, "two-pgid-death-proof");
		expect(new Set(observation.forestGroups).size).toBe(2);
	});

	it("covers every manifest-derived tuple with literal Worker evidence", async () => {
		const observation = await runInertCampaign(null);
		requireImplementedDriver(observation, "manifest-coverage");
		expect(observation.manifestPoints).toHaveLength(14);
		expect(observation.hits).toHaveLength(14);
	});
});

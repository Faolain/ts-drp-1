import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	PHASE_2J_PROBE_IDS,
	PHASE_2J_PROJECT_IDS,
	preparePhase2jPublication,
} from "./fixtures/phase-2j-webcrypto-evidence.js";
import {
	aggregatePhase2h,
	consumeCurrentPhase2hAggregate,
} from "../../packages/storage-browser/tests/fixtures/phase-2h-a-aggregate.js";
import {
	phase2hControlEntries,
	PHASE_2H_CONTROL_BROWSER_VERSIONS,
	PHASE_2H_CONTROL_GIT_SHA,
	PHASE_2H_CONTROL_RUN_ID,
	PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
} from "../../packages/storage-browser/tests/fixtures/phase-2h-a-controls.js";
import {
	PHASE_2H_ENGINES,
	PHASE_2H_REQUIRED_TUPLE_IDS,
	PHASE_2H_SCENARIOS,
} from "../../packages/storage-browser/tests/fixtures/phase-2h-a-registry.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
	for (const directory of temporaryDirectories) fs.rmSync(directory, { force: true, recursive: true });
	temporaryDirectories.clear();
});

describe("Phase 2k closed Phase 2h/2j preservation controls", () => {
	it("leaves the closed Phase 2h v1/69 aggregate and three-engine six-scenario registry unchanged", () => {
		const aggregate = aggregatePhase2h({
			browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
			entries: phase2hControlEntries(),
			gitSha: PHASE_2H_CONTROL_GIT_SHA,
			playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
			runId: PHASE_2H_CONTROL_RUN_ID,
		});
		expect(PHASE_2H_REQUIRED_TUPLE_IDS).toHaveLength(69);
		expect(PHASE_2H_ENGINES).toEqual(["chromium", "firefox", "webkit"]);
		expect(PHASE_2H_SCENARIOS).toHaveLength(6);
		expect(Object.keys(aggregate)).toHaveLength(12);
		expect(aggregate.records).toHaveLength(69);
		expect(
			consumeCurrentPhase2hAggregate(aggregate, {
				browserVersions: PHASE_2H_CONTROL_BROWSER_VERSIONS,
				gitSha: PHASE_2H_CONTROL_GIT_SHA,
				playwrightVersion: PHASE_2H_HISTORICAL_PLAYWRIGHT_VERSION,
				runId: PHASE_2H_CONTROL_RUN_ID,
			})
		).toEqual(aggregate);
	});

	it("leaves the independently bound closed Phase 2j five-project/three-probe artifact unchanged", () => {
		const outputBase = fs.mkdtempSync(path.join(os.tmpdir(), "ts-drp-phase-2k-preserve-2j-"));
		temporaryDirectories.add(outputBase);
		const gitSha = "b".repeat(40);
		const publication = preparePhase2jPublication({
			gitSha,
			outputBase,
			uuid: "10000000-0000-4000-8000-000000000000",
		});
		const aggregate = publication.finalize();
		expect(PHASE_2J_PROJECT_IDS).toEqual([
			"chromium",
			"firefox",
			"webkit",
			"ios-safari-emulation",
			"android-chrome-emulation",
		]);
		expect(PHASE_2J_PROBE_IDS).toEqual(["ed25519", "ecdsa-p256", "ecdsa-k256"]);
		expect(Object.keys(aggregate)).toHaveLength(12);
		expect(aggregate.artifactKind).toBe("ts-drp/webcrypto-capability-matrix/v1");
		expect(aggregate.gitSha).toBe(gitSha);
		expect(aggregate.requiredProjectIds).toEqual(PHASE_2J_PROJECT_IDS);
		expect(aggregate.requiredProbeIds).toEqual(PHASE_2J_PROBE_IDS);
	});
});

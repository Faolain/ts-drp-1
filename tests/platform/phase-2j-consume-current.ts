import fs from "node:fs";
import path from "node:path";

import { consumeCurrentPhase2jAggregate, PHASE_2J_PROJECT_IDS } from "./fixtures/phase-2j-webcrypto-evidence.js";

const gitSha = process.env.PHASE_2J_CHECKOUT_SHA;
const uuid = process.env.PHASE_2J_RUN_UUID;
if (gitSha === undefined || uuid === undefined) throw new TypeError("Phase 2j workflow identity is absent");
const runId = `phase-2j/${gitSha}/${uuid}`;
const outputBase = path.resolve("test-results/phase-2j");
const aggregatePath = path.join(outputBase, "webcrypto-capability-matrix.json");
const value = JSON.parse(fs.readFileSync(aggregatePath, "utf8")) as unknown;
const aggregate = consumeCurrentPhase2jAggregate(value, { gitSha, runId });
if (aggregate.verdict !== "pass") throw new TypeError("Phase 2j current aggregate did not pass");
for (const projectId of PHASE_2J_PROJECT_IDS) {
	if (!fs.statSync(path.join(outputBase, runId, "records", `${projectId}.json`)).isFile())
		throw new TypeError(`Phase 2j record is absent: ${projectId}`);
}

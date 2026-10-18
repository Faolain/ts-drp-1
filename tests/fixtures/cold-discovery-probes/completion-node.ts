import { readFileSync } from "node:fs";

import { completionControl, type CompletionMode } from "./completion-control.js";
import { nodeMutations } from "../cold-discovery/node-mutations.js";
import { nodeOwners } from "../cold-discovery/node-owners.js";
import type { SetupReport } from "../cold-discovery/types.js";

const setupPath = process.argv[2];
if (!setupPath) throw new Error("CONTROL_SETUP_PATH_REQUIRED");
const setup = JSON.parse(readFileSync(setupPath, "utf8")) as SetupReport;
const owners = nodeOwners(setup.bootstrap.identity);
try {
	console.log(
		JSON.stringify({
			pid: process.pid,
			report: await completionControl(
				setup,
				process.argv[3] as CompletionMode,
				owners,
				nodeMutations(setup.bootstrap.identity)
			),
		})
	);
} finally {
	await owners.close();
}

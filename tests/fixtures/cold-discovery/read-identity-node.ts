import { readFileSync } from "node:fs";

import { nodeMutations } from "./node-mutations.js";
import { nodeOwners } from "./node-owners.js";
import { identityControl, type IdentityMode } from "./read-identity-control.js";
import type { SetupReport } from "./types.js";

const path = process.argv[2];
if (!path) throw Error("IDENTITY_SETUP_REQUIRED");
const setup = JSON.parse(readFileSync(path, "utf8")) as SetupReport;
const owners = nodeOwners(setup.bootstrap.identity);
try {
	console.log(
		JSON.stringify({
			pid: process.pid,
			report: await identityControl(
				setup,
				process.argv[3] as IdentityMode,
				owners,
				nodeMutations(setup.bootstrap.identity)
			),
		})
	);
} finally {
	await owners.close();
}

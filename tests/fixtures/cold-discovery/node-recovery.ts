import { readFileSync } from "node:fs";

import { nodeMutations } from "./node-mutations.js";
import { nodeOwners } from "./node-owners.js";
import { recover, validateBootstrap } from "./recovery.js";
import { cases, type RecoveryCase } from "./types.js";

const file = process.argv[2];
const mode = process.argv[3] as RecoveryCase;
if (file === undefined || !cases.includes(mode)) throw new Error("RECOVERY_ARGUMENTS");
const bootstrap = validateBootstrap(JSON.parse(readFileSync(file, "utf8")));
const owners = nodeOwners(bootstrap.identity);
try {
	const report = await recover(bootstrap, mode, owners, nodeMutations(bootstrap.identity));
	console.log(JSON.stringify({ kind: "RECOVERY_COMPLETE", pid: process.pid, report }));
} finally {
	await owners.close();
}

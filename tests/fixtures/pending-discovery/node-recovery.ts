import { readFileSync } from "node:fs";

import { validateBootstrap } from "./bootstrap.js";
import { withNativeOwner } from "./cleanup.js";
import { nodeAuthMutation } from "./node-auth-mutations.js";
import { nodeMutations } from "./node-mutations.js";
import { nodeOwners } from "./node-owners.js";
import { recover } from "./recovery.js";
import { type RecoveryCase, recoveryCases } from "./types.js";
const file = process.argv[2],
	mode = process.argv[3] as RecoveryCase;
if (file === undefined || !recoveryCases.includes(mode)) throw new Error("RECOVERY_ARGS");
const bootstrap = validateBootstrap(JSON.parse(readFileSync(file, "utf8"))),
	owners = await nodeOwners(bootstrap.identity);
const report = await withNativeOwner(owners, async () => {
	const mutation = await nodeAuthMutation(bootstrap.identity, bootstrap, mode);
	const report = await recover(bootstrap, mode, owners, nodeMutations(bootstrap.identity));
	report.effects.mutations += mutation;
	return report;
});
console.log(JSON.stringify({ kind: "RECOVERY_COMPLETE", pid: process.pid, ownersClosed: true, report }));

import { readFileSync } from "node:fs";

import { authProbe } from "./auth-probe.js";
import { withNativeOwner } from "./cleanup.js";
import { nodeAuthMutation } from "./node-auth-mutations.js";
import { nodeMutations } from "./node-mutations.js";
import { nodeOwners } from "./node-owners.js";
import type { ProbeInput, RecoveryCase } from "./types.js";
const file = process.argv[2],
	mode = process.argv[3] as RecoveryCase;
if (file === undefined) throw new Error("AUTH_PROBE_ARGS");
const input = JSON.parse(readFileSync(file, "utf8")) as ProbeInput,
	owners = await nodeOwners(input.bootstrap.identity);
const report = await withNativeOwner(owners, async () => {
	const mutation = await nodeAuthMutation(input.bootstrap.identity, input.bootstrap, mode);
	const report = await authProbe(input, mode, owners, nodeMutations(input.bootstrap.identity));
	report.effects.mutations += mutation;
	return report;
});
console.log(JSON.stringify({ kind: "INSTRUMENTATION_ONLY", pid: process.pid, ownersClosed: true, report }));

import { readFileSync } from "node:fs";

import { availabilityProbe } from "./availability-probe.js";
import { withNativeOwner } from "./cleanup.js";
import { nodeMutations } from "./node-mutations.js";
import { nodeOwners } from "./node-owners.js";
import { probe } from "./probe.js";
import { type OwnerCase, ownerCases, type ProbeInput } from "./types.js";
const file = process.argv[2],
	mode = process.argv[3] as OwnerCase;
if (file === undefined || !ownerCases.includes(mode)) throw new Error("PROBE_ARGS");
const input = JSON.parse(readFileSync(file, "utf8")) as ProbeInput;
const owners = await nodeOwners(input.bootstrap.identity);
const report = await withNativeOwner(owners, async () => {
	const mutations = nodeMutations(input.bootstrap.identity);
	const report = await probe(input, mode, owners, mutations);
	if (mode === "verified") report.availability = await availabilityProbe(input, owners, mutations);
	return report;
});
console.log(JSON.stringify({ kind: "PROBE_COMPLETE", pid: process.pid, ownersClosed: true, report }));

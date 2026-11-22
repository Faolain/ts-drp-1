import "fake-indexeddb/auto";
import { withNativeOwner } from "./cleanup.js";
import { nodeCandidateFault } from "./node-candidate-fault.js";
import { nodeSetupOwners } from "./node-setup-owners.js";
import { setup } from "./setup.js";
import type { RecoveryCase } from "./types.js";
const identity = process.argv[2],
	epochs = Number(process.argv[3]),
	published = process.argv[4] === "published";
if (identity === undefined || (epochs !== 1 && epochs !== 2)) throw new Error("SETUP_ARGUMENTS");
const owners = await nodeSetupOwners(identity);
const report = await withNativeOwner(owners, () =>
	setup(identity, epochs, owners, published, process.argv[5] as RecoveryCase | undefined, nodeCandidateFault(identity))
);
console.log(JSON.stringify({ kind: "SETUP_COMPLETE", pid: process.pid, ownersClosed: true, report }));

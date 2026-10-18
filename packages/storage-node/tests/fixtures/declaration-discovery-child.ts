import { reader } from "../../../../tests/fixtures/snapshot-declaration-discovery/contract.js";
import { stable } from "../../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import type { SnapshotQuarantineScopeKey } from "../../../storage/src/snapshot-transfer.js";
import { createNodeSnapshotQuarantineStore } from "../../src/snapshot-transfer.js";

const input = JSON.parse(process.argv[2] ?? "null") as { primaryFilename: string; key: SnapshotQuarantineScopeKey };
if (Object.keys(input).sort().join(",") !== "key,primaryFilename")
	throw new Error("fresh caller boundary contains more than database identity and key");
const store = createNodeSnapshotQuarantineStore({ primaryFilename: input.primaryFilename });
try {
	const result = await reader(store).lookupRecoveryDeclaration(input.key);
	process.stdout.write(`${stable({ pid: process.pid, result })}\n`);
} finally {
	await store.close();
}

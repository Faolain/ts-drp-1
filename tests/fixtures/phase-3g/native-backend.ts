import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSqliteAheDurableStore } from "../../../packages/storage-node/src/index.js";
import { createNodeDurableIssuanceStore } from "../../../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../../../packages/storage-node/src/live-journal.js";

export { mkdtempSync, tmpdir };
export async function removeFixtureDirectory(directory: string): Promise<void> {
	rmSync(directory, { force: true, recursive: true });
}
export async function createFixtureAheStore(input: Parameters<typeof createSqliteAheDurableStore>[0]) {
	return createSqliteAheDurableStore(input);
}
export async function createFixtureIssuanceStore(input: Parameters<typeof createNodeDurableIssuanceStore>[0]) {
	return createNodeDurableIssuanceStore(input);
}
export async function createFixtureJournalStore(input: Parameters<typeof createNodeDurableLiveJournalStore>[0]) {
	return createNodeDurableLiveJournalStore(input);
}

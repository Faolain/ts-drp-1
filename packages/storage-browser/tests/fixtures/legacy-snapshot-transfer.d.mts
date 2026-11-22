import type { LegacyStore } from "../../../../tests/fixtures/snapshot-recovery-owner/contract.js";
export function createBrowserSnapshotQuarantineStore(
	options: Readonly<{ primaryDatabaseName: string }>
): Promise<LegacyStore>;

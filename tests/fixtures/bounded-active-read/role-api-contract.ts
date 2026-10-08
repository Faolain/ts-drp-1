// Uncompensated required exports and concrete native factory calls. No casts or
// expected-error annotations; memory deliberately retains the old capability.
import {
	type AheBoundedRecoveryRoleRead,
	type AheBoundedRecoveryRoleReadInput,
	type AheBoundedRecoveryRoleStore,
	type AheDurableStore,
	createMemoryAheDurableStore,
	type StoreResult,
} from "@ts-drp/storage";
import { createBrowserAheDurableStore } from "@ts-drp/storage-browser";
import { createSqliteAheDurableStore } from "@ts-drp/storage-node";

import { LIMITS, OBJECT } from "./contract.js";

const input: AheBoundedRecoveryRoleReadInput = { objectId: OBJECT, limits: LIMITS };
const sqlite: AheBoundedRecoveryRoleStore = createSqliteAheDurableStore({ filename: "type-only-not-opened.sqlite" });
async function browserFactory(): Promise<StoreResult<AheBoundedRecoveryRoleRead>> {
	const native = await createBrowserAheDurableStore({ databaseName: "type-only-not-opened" });
	const stronger: AheBoundedRecoveryRoleStore = native;
	return stronger.acquireBoundedRecoveryRoleRead(input);
}
const concreteSqlite = createSqliteAheDurableStore({
	filename: "type-only-not-opened.sqlite",
}).acquireBoundedRecoveryRoleRead(input);
async function concreteBrowser(): Promise<unknown> {
	return (await createBrowserAheDurableStore({ databaseName: "type-only-not-opened" })).acquireBoundedRecoveryRoleRead(
		input
	);
}
function handle(reader: AheBoundedRecoveryRoleRead): Promise<StoreResult<{ kind: "current" }>> {
	return reader.checkCurrency();
}
const memory: AheDurableStore = createMemoryAheDurableStore();
void [sqlite, concreteSqlite, browserFactory, concreteBrowser, handle, memory];

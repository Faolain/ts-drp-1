import "fake-indexeddb/auto";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
	captureFailure,
	errorCode,
	F5B0S_SCOPE,
	pruningInput,
	settlementCommit,
	settlementEntry,
	settlementPlan,
	type TestPlanStore,
	type TestPruningMaintenance,
} from "./fixtures/phase-6b-d110c-0c1f5b0s/settlement-plan-contract.js";
import {
	bindDurableIssuancePruningMaintenance,
	durableIssuancePruningMaintenanceForStore,
} from "../packages/issuance-store/src/maintenance.js";

type AdapterName = "browser" | "memory" | "node";

interface OpenedAdapter {
	readonly maintenance: TestPruningMaintenance;
	readonly store: TestPlanStore;
}

const temporaryDirectories: string[] = [];
let browserCounter = 0;

async function openAdapter(name: AdapterName, primaryFilename?: string): Promise<OpenedAdapter> {
	if (name === "memory") {
		const module = await import("../packages/issuance-store/src/conformance.js");
		const store = module.createEphemeralDurableIssuanceStore();
		const maintenance = module.resolveEphemeralDurableIssuancePruningMaintenance(store);
		if (maintenance === undefined) throw new TypeError("D110C_F5B0D_MEMORY_OWNER_MISSING");
		return { maintenance, store };
	}
	if (name === "browser") {
		const [{ createBrowserDurableIssuanceStore }, { resolveBrowserDurableIssuancePruningMaintenance }] =
			await Promise.all([
				import("../packages/storage-browser/src/issuance.js"),
				import("../packages/storage-browser/src/issuance-maintenance.js"),
			]);
		const store = await createBrowserDurableIssuanceStore({
			primaryDatabaseName: `d110c-f5b0d-corrective-${browserCounter++}`,
		});
		const maintenance = resolveBrowserDurableIssuancePruningMaintenance(store);
		if (maintenance === undefined) throw new TypeError("D110C_F5B0D_BROWSER_OWNER_MISSING");
		return { maintenance, store };
	}
	let selectedFilename = primaryFilename;
	if (selectedFilename === undefined) {
		const directory = await mkdtemp(join(tmpdir(), "d110c-f5b0d-corrective-"));
		temporaryDirectories.push(directory);
		selectedFilename = join(directory, "primary.sqlite");
	}
	const [{ createNodeDurableIssuanceStore }, { resolveNodeDurableIssuancePruningMaintenance }] = await Promise.all([
		import("../packages/storage-node/src/issuance.js"),
		import("../packages/storage-node/src/issuance-maintenance.js"),
	]);
	const store = createNodeDurableIssuanceStore({ primaryFilename: selectedFilename });
	const maintenance = resolveNodeDurableIssuancePruningMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D110C_F5B0D_NODE_OWNER_MISSING");
	return { maintenance, store };
}

async function withAdapter(name: AdapterName, run: (opened: OpenedAdapter) => Promise<void>): Promise<void> {
	const opened = await openAdapter(name);
	try {
		await run(opened);
	} finally {
		await opened.store.close();
	}
}

async function issueRows(
	store: TestPlanStore,
	rows: readonly Readonly<{ readonly epoch: number; readonly published: boolean }>[]
): Promise<void> {
	for (const row of rows) {
		const commit = await store.transactIssue(F5B0S_SCOPE, (authorSequence) =>
			Promise.resolve(settlementCommit(F5B0S_SCOPE, authorSequence, undefined, row.epoch))
		);
		if (row.published) {
			await store.compareAndMarkOutboxPublished({
				authorSequence: commit.authorSequence,
				digest: commit.envelope.digest,
				scope: F5B0S_SCOPE,
			});
		}
	}
}

async function installPlan(
	store: TestPlanStore,
	input: Parameters<typeof settlementPlan>[0] = { entries: [], fenceSequence: 0 }
): Promise<void> {
	const plan = settlementPlan(input);
	await store.transactWriteSettlementPlan({ expectedRevision: null, plan, scope: F5B0S_SCOPE });
}

async function assertRowsRemain(store: TestPlanStore, sequences: readonly number[]): Promise<void> {
	for (const sequence of sequences) expect(await store.readIssued(F5B0S_SCOPE, sequence)).not.toBeNull();
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("D.110c-0c1f5b0d corrective store reclamation RED", () => {
	it("pins exact-store identity and the trusted same-realm public maintenance subpath", async () => {
		const module = await import("../packages/issuance-store/src/conformance.js");
		const store = module.createEphemeralDurableIssuanceStore();
		try {
			const owner = durableIssuancePruningMaintenanceForStore(store);
			if (owner === undefined) throw new TypeError("D110C_F5B0D_MEMORY_OWNER_MISSING");
			expect(durableIssuancePruningMaintenanceForStore(Object.freeze({ ...store }))).toBeUndefined();
			expect(durableIssuancePruningMaintenanceForStore(new Proxy(store, {}))).toBeUndefined();
			expect(bindDurableIssuancePruningMaintenance(store, owner)).toBe(false);
		} finally {
			await store.close();
		}
	});

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses absent, null-fence, manual-review and unlinked-anywhere plans before mutation",
		async (adapter) => {
			for (const planInput of [
				undefined,
				{ entries: [], fenceSequence: null },
				{ entries: [settlementEntry(2, "manual-review")], fenceSequence: 1 },
				{ entries: [settlementEntry(2, "rebase")], fenceSequence: 1 },
			] as const) {
				await withAdapter(adapter, async ({ maintenance, store }) => {
					await issueRows(store, [
						{ epoch: 5, published: true },
						{ epoch: 6, published: false },
						{ epoch: 7, published: true },
					]);
					if (planInput !== undefined) await installPlan(store, planInput);
					const before = await maintenance.inspectPruningState(F5B0S_SCOPE);
					const failure = await captureFailure(
						maintenance.pruneAuthenticatedSettledPrefix(pruningInput(before.lineage, 1))
					);
					expect(errorCode(failure)).toBe("ISSUANCE_RETRY_REQUIRED");
					await assertRowsRemain(store, [0, 1, 2]);
					expect((await maintenance.inspectPruningState(F5B0S_SCOPE)).prunedThroughAuthorSequence).toBeNull();
				});
			}
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s deletes one complete mixed-old-epoch pending/published prefix and replays monotonically",
		async (adapter) => {
			await withAdapter(adapter, async ({ maintenance, store }) => {
				await issueRows(store, [
					{ epoch: 5, published: true },
					{ epoch: 6, published: false },
					{ epoch: 7, published: true },
				]);
				await installPlan(store, { entries: [], fenceSequence: 2 });
				const before = await maintenance.inspectPruningState(F5B0S_SCOPE);
				const input = pruningInput(before.lineage, 2);
				await expect(maintenance.pruneAuthenticatedSettledPrefix(input)).resolves.toMatchObject({
					deletedAuthorSequenceRange: { from: 0, through: 2 },
					prunedThroughAuthorSequence: 2,
				});
				for (const sequence of [0, 1, 2]) expect(await store.readIssued(F5B0S_SCOPE, sequence)).toBeNull();
				await expect(maintenance.pruneAuthenticatedSettledPrefix(input)).resolves.toMatchObject({
					deletedAuthorSequenceRange: null,
					prunedThroughAuthorSequence: 2,
				});
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses a row newer than closedEpoch before either table or watermark mutates",
		async (adapter) => {
			await withAdapter(adapter, async ({ maintenance, store }) => {
				await issueRows(store, [
					{ epoch: 6, published: true },
					{ epoch: 7, published: false },
					{ epoch: 8, published: true },
				]);
				await installPlan(store, { entries: [], fenceSequence: 2 });
				const before = await maintenance.inspectPruningState(F5B0S_SCOPE);
				const failure = await captureFailure(
					maintenance.pruneAuthenticatedSettledPrefix({
						...pruningInput(before.lineage, 2),
						closedEpoch: 7,
					})
				);
				expect(errorCode(failure), "D110C_F5B0D_FUTURE_EPOCH_DELETE_ALLOWED").toBe("ISSUANCE_INVALID_ARGUMENT");
				await assertRowsRemain(store, [0, 1, 2]);
				expect((await maintenance.inspectPruningState(F5B0S_SCOPE)).prunedThroughAuthorSequence).toBeNull();
			});
		}
	);

	it("node rolls back both tables and the watermark when authenticated deletion is partial", async () => {
		const directory = await mkdtemp(join(tmpdir(), "d110c-f5b0d-corrective-crash-"));
		temporaryDirectories.push(directory);
		const primaryFilename = join(directory, "primary.sqlite");
		const opened = await openAdapter("node", primaryFilename);
		try {
			await issueRows(opened.store, [
				{ epoch: 6, published: true },
				{ epoch: 7, published: false },
			]);
			await installPlan(opened.store, { entries: [], fenceSequence: 1 });
			const before = await opened.maintenance.inspectPruningState(F5B0S_SCOPE);
			const originalPrepare = DatabaseSync.prototype.prepare;
			DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
				const prepared = originalPrepare.call(this, sql);
				if (!/^DELETE FROM issuance_outbox\b/u.test(sql)) return prepared;
				return new Proxy(prepared, {
					get(statement, property): unknown {
						const value = Reflect.get(statement, property, statement);
						if (property !== "run" || typeof value !== "function") {
							return typeof value === "function" ? value.bind(statement) : value;
						}
						return (...parameters: unknown[]) => {
							const result = Reflect.apply(value, statement, parameters) as object;
							return { ...result, changes: 0 };
						};
					},
				}) as StatementSync;
			};
			let failure: unknown;
			try {
				failure = await captureFailure(
					opened.maintenance.pruneAuthenticatedSettledPrefix(pruningInput(before.lineage, 1))
				);
			} finally {
				DatabaseSync.prototype.prepare = originalPrepare;
			}
			expect(errorCode(failure)).toBe("ISSUANCE_RECOVERY_CORRUPT");
		} finally {
			await opened.store.close();
		}
		const reopened = await openAdapter("node", primaryFilename);
		try {
			await assertRowsRemain(reopened.store, [0, 1]);
			expect((await reopened.maintenance.inspectPruningState(F5B0S_SCOPE)).prunedThroughAuthorSequence).toBeNull();
		} finally {
			await reopened.store.close();
		}
	});

	it("does not relabel a permanently poisoned store as a retryable plan refusal", async () => {
		const module = await import("../packages/issuance-store/src/conformance.js");
		const store = module.createEphemeralDurableIssuanceStore({ initialPoison: "recovery-corrupt" });
		try {
			const owner = module.resolveEphemeralDurableIssuancePruningMaintenance(store);
			if (owner === undefined) throw new TypeError("D110C_F5B0D_MEMORY_OWNER_MISSING");
			const failure = await captureFailure(
				owner.pruneAuthenticatedSettledPrefix(pruningInput({ exhausted: false, next: 1 }, 0))
			);
			expect(errorCode(failure)).toBe("ISSUANCE_RECOVERY_CORRUPT");
		} finally {
			await store.close();
		}
	});
});

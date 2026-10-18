import "fake-indexeddb/auto";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import ts from "typescript";
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

type AdapterName = "browser" | "memory" | "node";

interface OpenedAdapter {
	readonly maintenance: TestPruningMaintenance;
	readonly store: TestPlanStore;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
let browserCounter = 0;

const DEFERRED_D110C_C_SCOPE_RETIREMENT = Object.freeze([
	"ahe-generation-scope",
	"live-journal-scope",
	"seal-evidence-scope",
	"snapshot-scope",
] as const);

async function temporaryPrimary(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "d110c-f5b0d-"));
	temporaryDirectories.push(directory);
	return join(directory, "primary.sqlite");
}

async function openMemory(): Promise<OpenedAdapter> {
	const module = await import("../packages/issuance-store/src/conformance.js");
	const store = module.createEphemeralDurableIssuanceStore();
	const maintenance = module.resolveEphemeralDurableIssuancePruningMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D110C_0C1F5B0D_MEMORY_MAINTENANCE_MISSING");
	return { maintenance, store };
}

async function openBrowser(): Promise<OpenedAdapter> {
	const [{ createBrowserDurableIssuanceStore }, { resolveBrowserDurableIssuancePruningMaintenance }] =
		await Promise.all([
			import("../packages/storage-browser/src/issuance.js"),
			import("../packages/storage-browser/src/issuance-maintenance.js"),
		]);
	const store = await createBrowserDurableIssuanceStore({
		primaryDatabaseName: `d110c-f5b0d-${browserCounter++}`,
	});
	const maintenance = resolveBrowserDurableIssuancePruningMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D110C_0C1F5B0D_BROWSER_MAINTENANCE_MISSING");
	return { maintenance, store };
}

async function openNode(primaryFilename?: string): Promise<OpenedAdapter> {
	const selectedFilename = primaryFilename ?? (await temporaryPrimary());
	const [{ createNodeDurableIssuanceStore }, { resolveNodeDurableIssuancePruningMaintenance }] = await Promise.all([
		import("../packages/storage-node/src/issuance.js"),
		import("../packages/storage-node/src/issuance-maintenance.js"),
	]);
	const store = createNodeDurableIssuanceStore({ primaryFilename: selectedFilename });
	const maintenance = resolveNodeDurableIssuancePruningMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D110C_0C1F5B0D_NODE_MAINTENANCE_MISSING");
	return { maintenance, store };
}

function openAdapter(name: AdapterName): Promise<OpenedAdapter> {
	if (name === "memory") return openMemory();
	if (name === "browser") return openBrowser();
	return openNode();
}

async function withAdapter(name: AdapterName, run: (opened: OpenedAdapter) => Promise<void>): Promise<void> {
	const opened = await openAdapter(name);
	try {
		await run(opened);
	} finally {
		await opened.store.close();
	}
}

function authenticatedSettledPrune(maintenance: TestPruningMaintenance, input: unknown): Promise<unknown> {
	const candidate = Reflect.get(maintenance, "pruneAuthenticatedSettledPrefix");
	if (typeof candidate === "function") return Reflect.apply(candidate, maintenance, [input]) as Promise<unknown>;
	// RED compatibility only: exercise the genuine existing mutation instead of
	// failing at a future import or export. Its wrong result is the causal RED.
	return maintenance.prunePublishedPrefix(input);
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

async function writePlan(store: TestPlanStore, input: Parameters<typeof settlementPlan>[0]): Promise<void> {
	const plan = settlementPlan(input);
	await store.transactWriteSettlementPlan({ expectedRevision: null, plan, scope: F5B0S_SCOPE });
}

async function assertRowsRemain(store: TestPlanStore, sequences: readonly number[]): Promise<void> {
	for (const sequence of sequences) expect(await store.readIssued(F5B0S_SCOPE, sequence)).not.toBeNull();
}

type HistoricalIssuanceCounter = (
	context:
		| {
				readonly countedSequences: Set<number>;
				count: number;
				readonly maxEpochVertices: number;
		  }
		| undefined,
	authorSequence: number
) => boolean;

async function executableHistoricalIssuanceCounter(): Promise<HistoricalIssuanceCounter> {
	const { resolveVerifiedCreatorHistoricalIssuance } = await import(
		"../packages/node/src/internal/creator-transition-advance.js"
	);
	const filename = resolve(REPOSITORY_ROOT, "packages/node/src/v3-live.ts");
	const source = await readFile(filename, "utf8");
	const unit = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const matches = unit.statements.filter(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === "countHistoricalIssuanceRow"
	);
	if (matches.length !== 1) throw new TypeError("D110C_0C1F5B0D_HISTORICAL_SCAN_OWNER_MISSING");
	const emitted = ts.transpileModule(matches[0].getText(unit), {
		compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const load = Function(
		"ReflectApply",
		"SetPrototypeHas",
		"SetPrototypeAdd",
		"resolveVerifiedCreatorHistoricalIssuance",
		`"use strict";\n${emitted}\nreturn countHistoricalIssuanceRow;`
	) as (
		reflectApply: typeof Reflect.apply,
		setPrototypeHas: typeof Set.prototype.has,
		setPrototypeAdd: typeof Set.prototype.add,
		resolveHistoricalIssuance: typeof resolveVerifiedCreatorHistoricalIssuance
	) => HistoricalIssuanceCounter;
	return load(Reflect.apply, Set.prototype.has, Set.prototype.add, resolveVerifiedCreatorHistoricalIssuance);
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("D.110c-0c1f5b0d authenticated settled-prefix reclamation RED", () => {
	it("pins the f5b0d boundary and hands non-issuance scope retirement to D.110c-c", () => {
		expect(DEFERRED_D110C_C_SCOPE_RETIREMENT).toEqual([
			"ahe-generation-scope",
			"live-journal-scope",
			"seal-evidence-scope",
			"snapshot-scope",
		]);
	});

	it("installs one storage-neutral authenticated settled-prefix owner without relying on a missing import", async () => {
		const owners = await Promise.all(
			(
				[
					"packages/issuance-store/src/maintenance.ts",
					"packages/issuance-store/src/conformance.ts",
					"packages/storage-browser/src/internal/browser-issuance-store.ts",
					"packages/storage-node/src/internal/node-issuance-store.ts",
				] as const
			).map(async (path) => ({ path, source: await readFile(resolve(REPOSITORY_ROOT, path), "utf8") }))
		);
		const missing = owners
			.filter(({ source }) => !source.includes("pruneAuthenticatedSettledPrefix"))
			.map(({ path }) => path);
		expect(missing, "D110C_0C1F5B0D_AUTHENTICATED_SETTLED_OWNER_MISSING").toEqual([]);
	});

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses a settlement-profile prefix when the durable plan is absent",
		async (adapter) => {
			await withAdapter(adapter, async ({ maintenance, store }) => {
				await issueRows(store, [{ epoch: 7, published: true }]);
				const state = await maintenance.inspectPruningState(F5B0S_SCOPE);
				const failure = await captureFailure(authenticatedSettledPrune(maintenance, pruningInput(state.lineage, 0)));
				expect(errorCode(failure), "D110C_0C1F5B0D_ABSENT_PLAN_PRUNE_ALLOWED").toBe("ISSUANCE_RETRY_REQUIRED");
				await assertRowsRemain(store, [0]);
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses while the required fence link is incomplete",
		async (adapter) => {
			await withAdapter(adapter, async ({ maintenance, store }) => {
				await issueRows(store, [{ epoch: 7, published: true }]);
				await writePlan(store, { entries: [], fenceSequence: null });
				const state = await maintenance.inspectPruningState(F5B0S_SCOPE);
				const failure = await captureFailure(authenticatedSettledPrune(maintenance, pruningInput(state.lineage, 0)));
				expect(errorCode(failure), "D110C_0C1F5B0D_FENCE_INCOMPLETE_PRUNE_ALLOWED").toBe("ISSUANCE_RETRY_REQUIRED");
				await assertRowsRemain(store, [0]);
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses an unlinked entry outside the selected prefix and deletes nothing",
		async (adapter) => {
			await withAdapter(adapter, async ({ maintenance, store }) => {
				await issueRows(store, [
					{ epoch: 7, published: true },
					{ epoch: 7, published: true },
					{ epoch: 7, published: true },
				]);
				await writePlan(store, {
					entries: [settlementEntry(2, "rebase")],
					fenceSequence: 1,
				});
				const state = await maintenance.inspectPruningState(F5B0S_SCOPE);
				const failure = await captureFailure(authenticatedSettledPrune(maintenance, pruningInput(state.lineage, 0)));
				expect(errorCode(failure), "D110C_0C1F5B0D_OUTSIDE_UNLINKED_ENTRY_IGNORED").toBe("ISSUANCE_RETRY_REQUIRED");
				await assertRowsRemain(store, [0, 1, 2]);
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses manual review outside the selected prefix and deletes nothing",
		async (adapter) => {
			await withAdapter(adapter, async ({ maintenance, store }) => {
				await issueRows(store, [
					{ epoch: 7, published: true },
					{ epoch: 7, published: true },
				]);
				await writePlan(store, {
					entries: [settlementEntry(1, "manual-review")],
					fenceSequence: null,
				});
				const state = await maintenance.inspectPruningState(F5B0S_SCOPE);
				const failure = await captureFailure(authenticatedSettledPrune(maintenance, pruningInput(state.lineage, 0)));
				expect(errorCode(failure), "D110C_0C1F5B0D_MANUAL_REVIEW_PRUNE_ALLOWED").toBe("ISSUANCE_RETRY_REQUIRED");
				await assertRowsRemain(store, [0, 1]);
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s prunes one authenticated complete mixed-epoch pending/published prefix and replays monotonically",
		async (adapter) => {
			await withAdapter(adapter, async ({ maintenance, store }) => {
				await issueRows(store, [
					{ epoch: 5, published: true },
					{ epoch: 6, published: false },
					{ epoch: 7, published: true },
				]);
				await writePlan(store, { entries: [], fenceSequence: 2 });
				const state = await maintenance.inspectPruningState(F5B0S_SCOPE);
				const input = pruningInput(state.lineage, 2);
				const first = await authenticatedSettledPrune(maintenance, input);
				expect(first).toMatchObject({
					deletedAuthorSequenceRange: { from: 0, through: 2 },
					prunedThroughAuthorSequence: 2,
				});
				for (const sequence of [0, 1, 2]) expect(await store.readIssued(F5B0S_SCOPE, sequence)).toBeNull();
				await expect(authenticatedSettledPrune(maintenance, input)).resolves.toMatchObject({
					deletedAuthorSequenceRange: null,
					prunedThroughAuthorSequence: 2,
				});
			});
		}
	);

	it("node rolls back both tables and the watermark when an authenticated prune crashes mid-transaction", async () => {
		const primaryFilename = await temporaryPrimary();
		const opened = await openNode(primaryFilename);
		try {
			await issueRows(opened.store, [
				{ epoch: 7, published: true },
				{ epoch: 7, published: true },
			]);
			await writePlan(opened.store, { entries: [], fenceSequence: 1 });
			const state = await opened.maintenance.inspectPruningState(F5B0S_SCOPE);
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
				failure = await captureFailure(authenticatedSettledPrune(opened.maintenance, pruningInput(state.lineage, 1)));
			} finally {
				DatabaseSync.prototype.prepare = originalPrepare;
			}
			expect(errorCode(failure), "D110C_0C1F5B0D_PARTIAL_DELETE_NOT_REJECTED").toBe("ISSUANCE_RECOVERY_CORRUPT");
		} finally {
			await opened.store.close();
		}
		const reopened = await openNode(primaryFilename);
		try {
			await assertRowsRemain(reopened.store, [0, 1]);
			expect((await reopened.maintenance.inspectPruningState(F5B0S_SCOPE)).prunedThroughAuthorSequence).toBeNull();
		} finally {
			await reopened.store.close();
		}
	});

	it("keeps creator-trusted-v1 historical issuance within one maxEpochVertices window", async () => {
		const countHistoricalIssuanceRow = await executableHistoricalIssuanceCounter();
		const context = { count: 0, countedSequences: new Set<number>(), maxEpochVertices: 8_192 };
		let accepted = 0;
		for (let authorSequence = 0; authorSequence < context.maxEpochVertices; authorSequence += 1) {
			if (countHistoricalIssuanceRow(context, authorSequence)) accepted += 1;
		}
		expect(accepted).toBe(8_192);
		expect(context).toMatchObject({ count: 8_192 });
		expect(context.countedSequences.size).toBe(8_192);
		expect(countHistoricalIssuanceRow(context, 8_191)).toBe(true);
		expect(context).toMatchObject({ count: 8_192 });
		expect(
			countHistoricalIssuanceRow(context, 8_192),
			"D110C_0C1F5B0D_LEGACY_HISTORICAL_SCAN_EXCEEDS_ONE_EPOCH_WINDOW"
		).toBe(false);
	});
});

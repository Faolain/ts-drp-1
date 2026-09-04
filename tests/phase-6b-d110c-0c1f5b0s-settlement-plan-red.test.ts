import "fake-indexeddb/auto";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
	captureFailure,
	errorCode,
	F5B0S_REQUIRED_TYPE_TOKENS,
	F5B0S_SCOPE,
	F5B0S_STORE_CASES,
	planSnapshot,
	pruningInput,
	settlementCommit,
	settlementEntry,
	settlementPlan,
	type TestPlanEffect,
	type TestPlanStore,
	type TestPruningMaintenance,
	type TestSettlementPlan,
} from "./fixtures/phase-6b-d110c-0c1f5b0s/settlement-plan-contract.js";

type AdapterName = "browser" | "memory" | "node";

interface OpenedAdapter {
	readonly maintenance: TestPruningMaintenance;
	readonly nativePlanMethods: boolean;
	reopen(): Promise<OpenedAdapter>;
	readonly store: TestPlanStore;
}

interface FallbackPlanCell {
	plan: TestSettlementPlan | null;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
const browserFallbackPlans = new Map<string, FallbackPlanCell>();
const nodeFallbackPlans = new Map<string, FallbackPlanCell>();
let browserCounter = 0;

const LEGACY_NODE_DDL = Object.freeze({
	issuanceOutbox:
		"CREATE TABLE issuance_outbox (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  publish_state TEXT NOT NULL CHECK(publish_state IN ('pending','published')),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID",
	issuedRecords:
		"CREATE TABLE issued_records (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  author_sequence INTEGER NOT NULL CHECK(author_sequence BETWEEN 0 AND 9007199254740991),\n  canonical_preimage BLOB NOT NULL CHECK(typeof(canonical_preimage) = 'blob' AND length(canonical_preimage) > 0),\n  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) > 0),\n  signature BLOB NOT NULL CHECK(typeof(signature) = 'blob' AND length(signature) > 0),\n  PRIMARY KEY (object_id,author,author_sequence)\n) WITHOUT ROWID",
	lineages:
		"CREATE TABLE lineages (\n  object_id TEXT NOT NULL,\n  author TEXT NOT NULL,\n  next INTEGER NOT NULL CHECK(next BETWEEN 0 AND 9007199254740991),\n  exhausted INTEGER NOT NULL CHECK(exhausted IN (0,1)),\n  pruned_through_author_sequence INTEGER CHECK(pruned_through_author_sequence IS NULL OR pruned_through_author_sequence BETWEEN 0 AND 9007199254740991),\n  PRIMARY KEY (object_id,author)\n) WITHOUT ROWID",
} as const);

async function temporaryPrimary(label: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `d110c-f5b0s-${label}-`));
	temporaryDirectories.push(directory);
	return join(directory, "primary.sqlite");
}

function asPlanStore(value: unknown): TestPlanStore {
	return value as TestPlanStore;
}

function clonePlan(plan: TestSettlementPlan): TestSettlementPlan {
	return {
		entries: plan.entries.map((entry) => ({
			disposition: entry.disposition,
			replacementSequence: entry.replacementSequence,
			sourceDigest: new Uint8Array(entry.sourceDigest),
			sourceSequence: entry.sourceSequence,
		})),
		fenceSequence: plan.fenceSequence,
		revision: plan.revision,
		scope: { ...plan.scope },
	};
}

function fallbackFailure(code: "ISSUANCE_INVALID_ARGUMENT" | "ISSUANCE_RETRY_REQUIRED", message: string): Error {
	return Object.assign(new Error(message), { code });
}

function fallbackPlanValid(plan: TestSettlementPlan, scope: typeof F5B0S_SCOPE): boolean {
	if (
		plan.scope.author !== scope.author ||
		plan.scope.objectId !== scope.objectId ||
		!Number.isSafeInteger(plan.revision) ||
		plan.revision < 0 ||
		(plan.fenceSequence !== null && (!Number.isSafeInteger(plan.fenceSequence) || plan.fenceSequence < 0))
	) {
		return false;
	}
	let prior = -1;
	for (const entry of plan.entries) {
		if (
			!Number.isSafeInteger(entry.sourceSequence) ||
			entry.sourceSequence < 0 ||
			entry.sourceSequence <= prior ||
			!(entry.sourceDigest instanceof Uint8Array) ||
			entry.sourceDigest.byteLength === 0 ||
			!(["expire", "manual-review", "rebase", "transform"] as const).includes(entry.disposition) ||
			(entry.replacementSequence !== null &&
				(!Number.isSafeInteger(entry.replacementSequence) || entry.replacementSequence < 0))
		) {
			return false;
		}
		prior = entry.sourceSequence;
	}
	return true;
}

function withFallbackPlanMethods(
	raw: unknown,
	cell: FallbackPlanCell
): Readonly<{ readonly nativePlanMethods: boolean; readonly store: TestPlanStore }> {
	const candidate = raw as Record<string, unknown>;
	const nativePlanMethods =
		typeof Reflect.get(candidate, "readSettlementPlan") === "function" &&
		typeof Reflect.get(candidate, "transactWriteSettlementPlan") === "function";
	if (nativePlanMethods) return { nativePlanMethods, store: asPlanStore(raw) };
	const base = raw as Omit<TestPlanStore, "readSettlementPlan" | "transactWriteSettlementPlan">;
	return {
		nativePlanMethods,
		store: {
			...base,
			readSettlementPlan: () => Promise.resolve(cell.plan === null ? null : clonePlan(cell.plan)),
			transactWriteSettlementPlan: (input) => {
				if (!fallbackPlanValid(input.plan, input.scope as typeof F5B0S_SCOPE)) {
					return Promise.reject(fallbackFailure("ISSUANCE_INVALID_ARGUMENT", "test fallback rejected plan"));
				}
				const observedRevision = cell.plan?.revision ?? null;
				if (observedRevision !== input.expectedRevision) {
					return Promise.reject(fallbackFailure("ISSUANCE_RETRY_REQUIRED", "test fallback CAS changed"));
				}
				if (input.plan.revision !== (input.expectedRevision === null ? 0 : input.expectedRevision + 1)) {
					return Promise.reject(fallbackFailure("ISSUANCE_INVALID_ARGUMENT", "test fallback revision is not next"));
				}
				cell.plan = clonePlan(input.plan);
				return Promise.resolve(clonePlan(cell.plan));
			},
		} as TestPlanStore,
	};
}

async function openMemory(): Promise<OpenedAdapter> {
	const candidate = (await import("../packages/issuance-store/src/conformance.js")) as Record<string, unknown>;
	const factory = Reflect.get(candidate, "createEphemeralDurableIssuanceStore") as () => unknown;
	const resolver = Reflect.get(candidate, "resolveEphemeralDurableIssuancePruningMaintenance") as (
		store: unknown
	) => unknown;
	const raw = factory();
	const maintenance = resolver(raw) as TestPruningMaintenance;
	const decorated = withFallbackPlanMethods(raw, { plan: null });
	const reopen = (): Promise<OpenedAdapter> => Promise.resolve({ maintenance, reopen, ...decorated });
	return { maintenance, reopen, ...decorated };
}

async function openBrowser(primaryDatabaseName?: string): Promise<OpenedAdapter> {
	const name = primaryDatabaseName ?? `d110c-f5b0s-${browserCounter++}`;
	const [{ createBrowserDurableIssuanceStore }, { resolveBrowserDurableIssuancePruningMaintenance }] =
		await Promise.all([
			import("../packages/storage-browser/src/issuance.js"),
			import("../packages/storage-browser/src/issuance-maintenance.js"),
		]);
	const raw = await createBrowserDurableIssuanceStore({ primaryDatabaseName: name });
	const maintenance = resolveBrowserDurableIssuancePruningMaintenance(raw) as TestPruningMaintenance | undefined;
	if (maintenance === undefined) throw new TypeError("D110C_0C1F5B0S_BROWSER_PRUNING_OWNER_MISSING");
	const cell = browserFallbackPlans.get(name) ?? { plan: null };
	browserFallbackPlans.set(name, cell);
	return { maintenance, reopen: () => openBrowser(name), ...withFallbackPlanMethods(raw, cell) };
}

async function openNode(primaryFilename?: string): Promise<OpenedAdapter> {
	const filename = primaryFilename ?? (await temporaryPrimary("adapter"));
	const [{ createNodeDurableIssuanceStore }, { resolveNodeDurableIssuancePruningMaintenance }] = await Promise.all([
		import("../packages/storage-node/src/issuance.js"),
		import("../packages/storage-node/src/issuance-maintenance.js"),
	]);
	const raw = createNodeDurableIssuanceStore({ primaryFilename: filename });
	const maintenance = resolveNodeDurableIssuancePruningMaintenance(raw) as TestPruningMaintenance | undefined;
	if (maintenance === undefined) throw new TypeError("D110C_0C1F5B0S_NODE_PRUNING_OWNER_MISSING");
	const cell = nodeFallbackPlans.get(filename) ?? { plan: null };
	nodeFallbackPlans.set(filename, cell);
	return { maintenance, reopen: () => openNode(filename), ...withFallbackPlanMethods(raw, cell) };
}

async function openAdapter(name: AdapterName): Promise<OpenedAdapter> {
	if (name === "memory") return openMemory();
	if (name === "browser") return openBrowser();
	return openNode();
}

async function withAdapter(
	name: AdapterName,
	_caseId: string,
	run: (opened: OpenedAdapter) => Promise<void>
): Promise<void> {
	const opened = await openAdapter(name);
	try {
		await run(opened);
	} finally {
		await opened.store.close();
	}
}

async function writePlan(store: TestPlanStore, plan: TestSettlementPlan): Promise<TestSettlementPlan> {
	return store.transactWriteSettlementPlan({ expectedRevision: null, plan, scope: plan.scope });
}

async function attemptIssue(store: TestPlanStore, effect: TestPlanEffect): Promise<unknown> {
	return captureFailure(
		store.transactIssue(F5B0S_SCOPE, (authorSequence) =>
			Promise.resolve(settlementCommit(F5B0S_SCOPE, authorSequence, effect))
		)
	);
}

async function assertRejectedWithoutIssue(
	store: TestPlanStore,
	effect: TestPlanEffect,
	expectedPlan: TestSettlementPlan | null
): Promise<void> {
	const before = planSnapshot(expectedPlan);
	const error = await attemptIssue(store, effect);
	expect(error, "D110C_0C1F5B0S_PLAN_EFFECT_PRECONDITION_NOT_ENFORCED").toBeDefined();
	expect(await store.readLineage(F5B0S_SCOPE)).toEqual({ exhausted: false, next: 0 });
	expect(await store.readIssued(F5B0S_SCOPE, 0)).toBeNull();
	expect(planSnapshot(await store.readSettlementPlan(F5B0S_SCOPE))).toEqual(before);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolvePromise, reject) => {
		request.addEventListener("success", () => resolvePromise(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error), { once: true });
	});
}

function nodeDerived(primaryFilename: string): string {
	return `${primaryFilename}.drp-issuance-v1.sqlite`;
}

function scalar(database: DatabaseSync, sql: string): unknown {
	const statement = database.prepare(sql);
	statement.setReadBigInts(false);
	const row = statement.get();
	return row === undefined ? undefined : Object.values(row)[0];
}

function createLegacyNodeV2(primaryFilename: string): void {
	const database = new DatabaseSync(nodeDerived(primaryFilename));
	const commit = settlementCommit(F5B0S_SCOPE, 0);
	try {
		database.exec("PRAGMA page_size=4096");
		database.prepare("PRAGMA journal_mode=WAL").get();
		database.exec("BEGIN IMMEDIATE");
		database.exec(LEGACY_NODE_DDL.lineages);
		database.exec(LEGACY_NODE_DDL.issuedRecords);
		database.exec(LEGACY_NODE_DDL.issuanceOutbox);
		database
			.prepare(
				"INSERT INTO lineages(object_id,author,next,exhausted,pruned_through_author_sequence) VALUES(?,?,?,?,NULL)"
			)
			.run(F5B0S_SCOPE.objectId, F5B0S_SCOPE.author, 1, 0);
		database
			.prepare(
				"INSERT INTO issued_records(object_id,author,author_sequence,canonical_preimage,digest,signature) VALUES(?,?,?,?,?,?)"
			)
			.run(
				F5B0S_SCOPE.objectId,
				F5B0S_SCOPE.author,
				0,
				commit.envelope.canonicalPreimageBytes,
				commit.envelope.digest,
				commit.envelope.signature
			);
		database
			.prepare("INSERT INTO issuance_outbox(object_id,author,author_sequence,digest,publish_state) VALUES(?,?,?,?,?)")
			.run(F5B0S_SCOPE.objectId, F5B0S_SCOPE.author, 0, commit.envelope.digest, "published");
		database.exec("PRAGMA user_version=2");
		database.exec("COMMIT");
	} finally {
		database.close();
	}
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("D.110c-0c1f5b0s settlement-plan contract RED", () => {
	it("pins the exact contract owners and case inventory without importing future exports", async () => {
		const types = await readFile(resolve(REPOSITORY_ROOT, "packages/issuance-store/src/types.ts"), "utf8");
		const missing = F5B0S_REQUIRED_TYPE_TOKENS.filter((token) => !types.includes(token));
		expect(missing, "D110C_0C1F5B0S_SETTLEMENT_PLAN_PUBLIC_CONTRACT_MISSING").toEqual([]);
		expect(F5B0S_STORE_CASES).toEqual([
			"cas-revision",
			"fence-atomic-link",
			"replacement-atomic-link",
			"fence-plan-missing",
			"fence-already-set",
			"fence-manual-review",
			"replacement-entry-absent",
			"replacement-already-linked",
			"replacement-manual-review",
			"ambiguous-fence-readback",
			"ambiguous-replacement-readback",
			"corrupt-plan-refusal",
			"unlinked-entry-prune-gate",
		]);
	});

	it.each(["memory", "browser", "node"] as const)("%s exposes the two plan methods at runtime", async (adapter) => {
		await withAdapter(adapter, "surface", ({ nativePlanMethods }) => {
			expect(nativePlanMethods, `D110C_0C1F5B0S_${adapter.toUpperCase()}_NATIVE_SETTLEMENT_PLAN_METHODS_MISSING`).toBe(
				true
			);
			return Promise.resolve();
		});
	});

	it.each(["memory", "browser", "node"] as const)(
		"%s applies revision CAS and returns detached durable plans",
		async (adapter) => {
			await withAdapter(adapter, "cas_revision", async ({ store }) => {
				const input = settlementPlan();
				const created = await writePlan(store, input);
				expect(planSnapshot(created)).toEqual(planSnapshot(input));
				(created.entries[0]?.sourceDigest as Uint8Array).fill(0);
				const durable = await store.readSettlementPlan(F5B0S_SCOPE);
				expect(durable?.entries[0]?.sourceDigest).toEqual(Uint8Array.of(27, 0xd1));

				const stale = await captureFailure(
					store.transactWriteSettlementPlan({ expectedRevision: null, plan: input, scope: F5B0S_SCOPE })
				);
				expect(stale, "D110C_0C1F5B0S_STALE_NULL_CAS_ACCEPTED").toBeDefined();
				const next = settlementPlan({ entries: [settlementEntry(11, "transform")], revision: 1 });
				await expect(
					store.transactWriteSettlementPlan({ expectedRevision: 0, plan: next, scope: F5B0S_SCOPE })
				).resolves.toEqual(expect.objectContaining({ revision: 1 }));
				const staleRevision = await captureFailure(
					store.transactWriteSettlementPlan({ expectedRevision: 0, plan: next, scope: F5B0S_SCOPE })
				);
				expect(staleRevision, "D110C_0C1F5B0S_STALE_REVISION_CAS_ACCEPTED").toBeDefined();
				expect(planSnapshot(await store.readSettlementPlan(F5B0S_SCOPE))).toEqual(planSnapshot(next));
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)("%s links a fence atomically with issuance", async (adapter) => {
		await withAdapter(adapter, "fence_atomic_link", async ({ store }) => {
			await writePlan(store, settlementPlan({ entries: [] }));
			const failure = await captureFailure(
				store.transactIssue(F5B0S_SCOPE, (authorSequence) =>
					Promise.resolve(settlementCommit(F5B0S_SCOPE, authorSequence, { kind: "fence" }))
				)
			);
			expect(failure, "D110C_0C1F5B0S_FENCE_PLAN_EFFECT_REJECTED_BY_COMMIT_GRAMMAR").toBeUndefined();
			const commit = await store.readIssued(F5B0S_SCOPE, 0);
			const plan = await store.readSettlementPlan(F5B0S_SCOPE);
			expect(commit?.authorSequence).toBe(0);
			expect(plan).toMatchObject({ fenceSequence: 0 });
			expect(plan?.revision).toBeGreaterThan(0);
			expect(await store.readIssued(F5B0S_SCOPE, 0)).not.toBeNull();
		});
	});

	it.each(["memory", "browser", "node"] as const)(
		"%s links one replacement atomically and makes the source entry the restart idempotence key",
		async (adapter) => {
			await withAdapter(adapter, "replacement_atomic_link", async ({ store }) => {
				await writePlan(store, settlementPlan());
				const failure = await captureFailure(
					store.transactIssue(F5B0S_SCOPE, (authorSequence) =>
						Promise.resolve(settlementCommit(F5B0S_SCOPE, authorSequence, { kind: "replacement", sourceSequence: 10 }))
					)
				);
				expect(failure, "D110C_0C1F5B0S_REPLACEMENT_PLAN_EFFECT_REJECTED_BY_COMMIT_GRAMMAR").toBeUndefined();
				const linked = await store.readSettlementPlan(F5B0S_SCOPE);
				expect(linked?.entries[0]).toMatchObject({ replacementSequence: 0, sourceSequence: 10 });
				expect(linked?.revision).toBeGreaterThan(0);
				await assertRejectedWithoutIssue(store, { kind: "replacement", sourceSequence: 10 }, linked);
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses a fence when the durable plan is absent",
		async (adapter) => {
			await withAdapter(adapter, "fence_plan_missing", async ({ store }) => {
				await assertRejectedWithoutIssue(store, { kind: "fence" }, null);
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses a fence when fenceSequence is already set",
		async (adapter) => {
			await withAdapter(adapter, "fence_already_set", async ({ store }) => {
				const plan = await writePlan(store, settlementPlan({ entries: [], fenceSequence: 7 }));
				await assertRejectedWithoutIssue(store, { kind: "fence" }, plan);
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses a fence while manual review is unresolved",
		async (adapter) => {
			await withAdapter(adapter, "fence_manual_review", async ({ store }) => {
				const plan = await writePlan(store, settlementPlan({ entries: [settlementEntry(10, "manual-review")] }));
				await assertRejectedWithoutIssue(store, { kind: "fence" }, plan);
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)("%s refuses a replacement for an absent entry", async (adapter) => {
		await withAdapter(adapter, "replacement_entry_absent", async ({ store }) => {
			const plan = await writePlan(store, settlementPlan({ entries: [] }));
			await assertRejectedWithoutIssue(store, { kind: "replacement", sourceSequence: 10 }, plan);
		});
	});

	it.each(["memory", "browser", "node"] as const)("%s refuses an already-linked replacement", async (adapter) => {
		await withAdapter(adapter, "replacement_already_linked", async ({ store }) => {
			const plan = await writePlan(store, settlementPlan({ entries: [settlementEntry(10, "rebase", 44)] }));
			await assertRejectedWithoutIssue(store, { kind: "replacement", sourceSequence: 10 }, plan);
		});
	});

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses a replacement for a manual-review entry",
		async (adapter) => {
			await withAdapter(adapter, "replacement_manual_review", async ({ store }) => {
				const plan = await writePlan(store, settlementPlan({ entries: [settlementEntry(10, "manual-review")] }));
				await assertRejectedWithoutIssue(store, { kind: "replacement", sourceSequence: 10 }, plan);
			});
		}
	);

	it.each([
		["memory", { kind: "fence" }],
		["memory", { kind: "replacement", sourceSequence: 10 }],
		["browser", { kind: "fence" }],
		["browser", { kind: "replacement", sourceSequence: 10 }],
		["node", { kind: "fence" }],
		["node", { kind: "replacement", sourceSequence: 10 }],
	] as const)(
		"%s readback after a lost %s transaction receipt observes both the row and link or neither",
		async (adapter, effect) => {
			await withAdapter(adapter, `ambiguous_${effect.kind}_readback`, async (opened) => {
				const { store } = opened;
				await writePlan(store, effect.kind === "fence" ? settlementPlan({ entries: [] }) : settlementPlan());
				const lostReceipt = store
					.transactIssue(F5B0S_SCOPE, (authorSequence) =>
						Promise.resolve(settlementCommit(F5B0S_SCOPE, authorSequence, effect))
					)
					.then(() => Promise.reject(new Error("D110C_0C1F5B0S_SIMULATED_LOST_RECEIPT")));
				const lost = await captureFailure(lostReceipt);
				expect(
					lost instanceof Error ? lost.message : undefined,
					"D110C_0C1F5B0S_AMBIGUOUS_DRIVER_DID_NOT_REACH_POSTCOMMIT"
				).toBe("D110C_0C1F5B0S_SIMULATED_LOST_RECEIPT");
				if (adapter !== "memory") await store.close();
				const reopened = adapter === "memory" ? opened : await opened.reopen();
				try {
					const row = await reopened.store.readIssued(F5B0S_SCOPE, 0);
					const plan = await reopened.store.readSettlementPlan(F5B0S_SCOPE);
					const linked =
						effect.kind === "fence" ? plan?.fenceSequence === 0 : plan?.entries[0]?.replacementSequence === 0;
					expect(row === null, "D110C_0C1F5B0S_AMBIGUOUS_HALF_LINK").toBe(!linked);
					expect(row, "D110C_0C1F5B0S_COMMITTED_READBACK_ROW_MISSING").not.toBeNull();
				} finally {
					if (adapter !== "memory") await reopened.store.close();
				}
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses corrupt plan shapes without creating state",
		async (adapter) => {
			await withAdapter(adapter, "corrupt_plan_refusal", async ({ store }) => {
				const malformed: TestSettlementPlan[] = [
					settlementPlan({ entries: [settlementEntry(11), settlementEntry(10)] }),
					settlementPlan({ entries: [settlementEntry(10), settlementEntry(10)] }),
					settlementPlan({ entries: [{ ...settlementEntry(10), sourceDigest: new Uint8Array() }] }),
					settlementPlan({ revision: -1 }),
					settlementPlan({ scope: { ...F5B0S_SCOPE, author: "other" } }),
				];
				for (const [index, plan] of malformed.entries()) {
					const error = await captureFailure(
						store.transactWriteSettlementPlan({ expectedRevision: null, plan, scope: F5B0S_SCOPE })
					);
					expect(error, `D110C_0C1F5B0S_CORRUPT_PLAN_${index}_ACCEPTED`).toBeDefined();
					expect(errorCode(error), `D110C_0C1F5B0S_CORRUPT_PLAN_${index}_UNTYPED`).toBe("ISSUANCE_INVALID_ARGUMENT");
					expect(await store.readSettlementPlan(F5B0S_SCOPE)).toBeNull();
				}
			});
		}
	);

	it.each(["memory", "browser", "node"] as const)(
		"%s refuses pruning a published source while an unlinked plan entry references it",
		async (adapter) => {
			await withAdapter(adapter, "unlinked_entry_prune_gate", async ({ maintenance, store }) => {
				const issued = await store.transactIssue(F5B0S_SCOPE, (authorSequence) =>
					Promise.resolve(settlementCommit(F5B0S_SCOPE, authorSequence))
				);
				await store.compareAndMarkOutboxPublished({
					authorSequence: 0,
					digest: issued.envelope.digest,
					scope: F5B0S_SCOPE,
				});
				await writePlan(store, settlementPlan({ entries: [settlementEntry(0)] }));
				const state = await maintenance.inspectPruningState(F5B0S_SCOPE);
				const error = await captureFailure(maintenance.prunePublishedPrefix(pruningInput(state.lineage, 0)));
				expect(error, "D110C_0C1F5B0S_UNLINKED_PLAN_PRUNE_ALLOWED").toBeDefined();
				expect(await store.readIssued(F5B0S_SCOPE, 0)).not.toBeNull();
				expect(await store.readSettlementPlan(F5B0S_SCOPE)).toMatchObject({
					entries: [expect.objectContaining({ replacementSequence: null, sourceSequence: 0 })],
				});
			});
		}
	);

	it("browser fresh schema is version 2 with exactly the fourth settlementPlans object store", async () => {
		const primaryDatabaseName = `d110c-f5b0s-schema-${browserCounter++}`;
		const opened = await openBrowser(primaryDatabaseName);
		await opened.store.close();
		const request = indexedDB.open(`${primaryDatabaseName}--drp-issuance-v1`);
		const database = await requestResult(request);
		try {
			expect.soft(database.version, "D110C_0C1F5B0S_BROWSER_SCHEMA_VERSION_NOT_BUMPED").toBe(2);
			expect
				.soft([...database.objectStoreNames].sort(), "D110C_0C1F5B0S_BROWSER_STORE_SET_NOT_EXACT")
				.toEqual(["issuanceOutbox", "issuedRecords", "lineages", "settlementPlans"]);
		} finally {
			database.close();
		}
	});

	it("node migrates the exact v2 authority to a v3 settlement_plans table in place", async () => {
		const primaryFilename = await temporaryPrimary("v2-migration");
		createLegacyNodeV2(primaryFilename);
		const derived = nodeDerived(primaryFilename);
		const before = new DatabaseSync(derived, { readOnly: true });
		try {
			expect(scalar(before, "PRAGMA user_version")).toBe(2);
			expect(scalar(before, "SELECT count(*) FROM issued_records")).toBe(1);
		} finally {
			before.close();
		}

		const opened = await openNode(primaryFilename);
		try {
			const after = new DatabaseSync(derived, { readOnly: true });
			try {
				expect.soft(scalar(after, "PRAGMA user_version"), "D110C_0C1F5B0S_NODE_V3_MIGRATION_MISSING").toBe(3);
				expect
					.soft(
						scalar(after, "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='settlement_plans'"),
						"D110C_0C1F5B0S_NODE_SETTLEMENT_PLAN_TABLE_MISSING"
					)
					.toBe(1);
			} finally {
				after.close();
			}
			expect(opened.nativePlanMethods, "D110C_0C1F5B0S_NODE_MIGRATION_SETTLEMENT_PLAN_METHODS_MISSING").toBe(true);
			expect(await opened.store.readIssued(F5B0S_SCOPE, 0)).not.toBeNull();
			expect(await opened.store.readSettlementPlan(F5B0S_SCOPE)).toBeNull();
		} finally {
			await opened.store.close();
		}
	});
});

import { expect, type Page, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const GREEN_READY = [
	"packages/seal/src/creator.ts",
	"packages/seal/src/internal/creator-close-intent.ts",
	"packages/storage-browser/src/seal-evidence.ts",
	"packages/storage-browser/src/internal/seal-evidence-store.ts",
].every((path) => existsSync(resolve(REPOSITORY_ROOT, path)));
const EXACT_VOTE_TRANSACTION_STORES = ["signerState", "storageMeta", "voteOutbox", "voteSlots"] as const;
const CRASH_CHECKPOINTS = [
	"before-evidence-commit",
	"after-evidence-commit",
	"after-prepare-vote-commit",
	"after-prepare-qc-commit",
	"after-commit-vote-commit",
	"after-commit-qc-commit",
	"after-successor-complete",
] as const;
const EXPECTED_SCHEMA_V3 = Object.freeze({
	stores: Object.freeze([
		Object.freeze({ autoIncrement: false, indexes: Object.freeze([]), keyPath: "digest", name: "blobs" }),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "generationId"]),
			name: "generations",
		}),
		Object.freeze({ autoIncrement: false, indexes: Object.freeze([]), keyPath: "objectId", name: "objects" }),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "generationId", "digest"]),
			name: "promotions",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "signerId"]),
			name: "sealEvidence",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "signerId"]),
			name: "signerState",
		}),
		Object.freeze({ autoIncrement: false, indexes: Object.freeze([]), keyPath: "key", name: "storageMeta" }),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "round", "phase", "signerId"]),
			name: "voteOutbox",
		}),
		Object.freeze({
			autoIncrement: false,
			indexes: Object.freeze([]),
			keyPath: Object.freeze(["objectId", "epoch", "round", "phase", "signerId"]),
			name: "voteSlots",
		}),
	]),
	version: 3,
});
const EXPECTED_EVENT_KINDS = [
	"close_evidence_committed",
	"prepare_vote_committed",
	"prepare_qc_committed",
	"commit_vote_committed",
	"commit_qc_committed",
	"successor_completed",
];

let server: Phase4cBrowserServer | undefined;

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5e-creator-actor-entry.ts"),
	});
});

test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.107b creator actor owners are intentionally absent in RED");

async function installTransactionObserver(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const ledger: string[] = [];
		const observed: { completed: boolean; durability: string; mode: string; stores: string[] }[] = [];
		const original = IDBDatabase.prototype.transaction;
		Object.defineProperty(window, "__phase5eTransactions", { value: observed });
		Object.defineProperty(window, "__phase5eLedger", { value: ledger });
		Object.defineProperty(window, "__phase5eHoldWrites", { value: false, writable: true });
		globalThis.addEventListener("phase5e-creator-observation", (event) => {
			ledger.push(`event:${String((event as CustomEvent<{ kind: string }>).detail.kind)}`);
		});
		IDBDatabase.prototype.transaction = function transaction(
			storeNames: string | string[],
			mode?: IDBTransactionMode,
			options?: IDBTransactionOptions
		): IDBTransaction {
			const selected = original.call(this, storeNames, mode, options);
			const row = {
				completed: false,
				durability: selected.durability,
				mode: selected.mode,
				stores: Array.from(selected.objectStoreNames),
			};
			observed.push(row);
			if (selected.mode === "readwrite") {
				const firstStore = selected.objectStoreNames.item(0);
				const pump = (): void => {
					if (Reflect.get(window, "__phase5eHoldWrites") !== true || firstStore === null) return;
					const request = selected.objectStore(firstStore).getAll(undefined, 1);
					request.addEventListener("success", pump, { once: true });
				};
				pump();
			}
			selected.addEventListener("complete", () => {
				row.completed = true;
				ledger.push(`transaction:${row.stores.join(",")}:complete`);
			});
			return selected;
		};
	});
}

async function rawDatabase(
	page: Page,
	databaseName: string
): Promise<
	Readonly<{
		counts: Readonly<Record<string, number>>;
		rows: Readonly<Record<string, readonly unknown[]>>;
		schema: readonly Readonly<{
			autoIncrement: boolean;
			indexes: readonly string[];
			keyPath: string | readonly string[] | null;
			name: string;
		}>[];
		stores: readonly string[];
		version: number;
	}>
> {
	return page.evaluate(async (name) => {
		const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
			const request = indexedDB.open(name);
			request.addEventListener("error", () => reject(request.error));
			request.addEventListener("success", () => resolvePromise(request.result));
		});
		try {
			const stores = Array.from(database.objectStoreNames);
			const schema = stores.map((storeName) => {
				const store = database.transaction(storeName, "readonly").objectStore(storeName);
				return {
					autoIncrement: store.autoIncrement,
					indexes: Array.from(store.indexNames),
					keyPath: Array.isArray(store.keyPath) ? [...store.keyPath] : store.keyPath,
					name: storeName,
				};
			});
			const counts: Record<string, number> = {};
			const rows: Record<string, readonly unknown[]> = {};
			for (const storeName of stores) {
				counts[storeName] = await new Promise<number>((resolvePromise, reject) => {
					const request = database.transaction(storeName, "readonly").objectStore(storeName).count();
					request.addEventListener("error", () => reject(request.error));
					request.addEventListener("success", () => resolvePromise(request.result));
				});
				rows[storeName] = await new Promise<readonly unknown[]>((resolvePromise, reject) => {
					const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
					request.addEventListener("error", () => reject(request.error));
					request.addEventListener("success", () => resolvePromise(request.result));
				});
			}
			return { counts, rows, schema, stores, version: database.version };
		} finally {
			database.close();
		}
	}, databaseName);
}

function durablePhase(raw: Awaited<ReturnType<typeof rawDatabase>>): string {
	if ((raw.counts.sealEvidence ?? 0) === 0) return "empty";
	const state = raw.rows.signerState?.[0] as Record<string, unknown> | undefined;
	if (state === undefined) return "evidence-committed";
	if (state.finalizedCommitQC !== null && typeof state.finalizedCommitQC === "object") return "finalized";
	if (Number(state.durablePrepareQcCount ?? 0) > 0) return "prepared";
	if ((raw.counts.voteSlots ?? 0) >= 2) return "commit-voted";
	if ((raw.counts.voteSlots ?? 0) >= 1) return "prepare-voted";
	return "evidence-committed";
}

async function waitForEventCount(page: Page, databaseName: string, count: number): Promise<void> {
	await expect
		.poll(
			async () => {
				const observed = (await page.evaluate((name) => window.phase5eCreatorActor.observe(name), databaseName)) as {
					readonly events: readonly unknown[];
				};
				return observed.events.length;
			},
			{ timeout: 20_000 }
		)
		.toBeGreaterThanOrEqual(count);
}

test("migrates the exact v2 database to one additive nine-store v3 schema", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `phase5e-schema-${crypto.randomUUID()}`;
	await page.evaluate(async (name) => {
		await new Promise<void>((resolvePromise, reject) => {
			const request = indexedDB.open(name, 2);
			request.addEventListener("error", () => reject(request.error));
			request.addEventListener("upgradeneeded", () => {
				const database = request.result;
				for (const [store, keyPath] of [
					["objects", "objectId"],
					["generations", ["objectId", "generationId"]],
					["blobs", "digest"],
					["promotions", ["objectId", "generationId", "digest"]],
					["storageMeta", "key"],
					["voteSlots", ["objectId", "epoch", "round", "phase", "signerId"]],
					["signerState", ["objectId", "epoch", "signerId"]],
					["voteOutbox", ["objectId", "epoch", "round", "phase", "signerId"]],
				] as const) {
					database.createObjectStore(store, { keyPath: typeof keyPath === "string" ? keyPath : [...keyPath] });
				}
				request.transaction?.objectStore("objects").add({ objectId: "preserved" });
				request.transaction?.objectStore("storageMeta").add({
					key: "incarnation",
					value: "0123456789abcdef0123456789abcdef",
				});
			});
			request.addEventListener("success", () => {
				request.result.close();
				resolvePromise();
			});
		});
	}, databaseName);
	await page.evaluate((name) => window.phase5eCreatorActor.start(name), databaseName);
	await page.evaluate((name) => window.phase5eCreatorActor.awaitResult(name), databaseName);
	const raw = await rawDatabase(page, databaseName);
	expect(raw.version).toBe(3);
	expect(raw.stores).toEqual(EXPECTED_SCHEMA_V3.stores.map(({ name }) => name).sort());
	expect(raw.schema).toEqual(EXPECTED_SCHEMA_V3.stores);
	expect(raw.counts).toMatchObject({ objects: 1, sealEvidence: 1, signerState: 1, voteOutbox: 2, voteSlots: 2 });
});

test("commits evidence first and retains the exact four-store vote transaction", async ({ page }) => {
	await installTransactionObserver(page);
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `phase5e-order-${crypto.randomUUID()}`;
	await page.evaluate((name) => window.phase5eCreatorActor.start(name), databaseName);
	const result = await page.evaluate((name) => window.phase5eCreatorActor.awaitResult(name), databaseName);
	expect(result).toMatchObject({ ok: true });
	const observed = (await page.evaluate(() => Reflect.get(window, "__phase5eTransactions"))) as readonly Readonly<{
		completed: boolean;
		durability: string;
		mode: string;
		stores: readonly string[];
	}>[];
	const writes = observed.filter(({ mode }) => mode === "readwrite");
	const firstEvidence = writes.findIndex(({ stores }) => stores.join(",") === "sealEvidence");
	const firstVote = writes.findIndex(({ stores }) => stores.join(",") === EXACT_VOTE_TRANSACTION_STORES.join(","));
	expect(firstEvidence).toBeGreaterThanOrEqual(0);
	expect(firstVote).toBeGreaterThan(firstEvidence);
	const voteTransactions = writes.filter(({ stores }) => stores.join(",") === EXACT_VOTE_TRANSACTION_STORES.join(","));
	expect(voteTransactions).toHaveLength(2);
	expect(voteTransactions.every(({ completed, durability }) => completed && durability === "strict")).toBe(true);
	const state = (await page.evaluate((name) => window.phase5eCreatorActor.observe(name), databaseName)) as Readonly<{
		events: readonly Readonly<{ kind: string }>[];
	}>;
	expect(state.events.map(({ kind }) => kind)).toEqual(EXPECTED_EVENT_KINDS);
	const ledger = (await page.evaluate(() => Reflect.get(window, "__phase5eLedger"))) as readonly string[];
	const evidenceComplete = ledger.indexOf("transaction:sealEvidence:complete");
	const evidenceRelease = ledger.indexOf("event:close_evidence_committed");
	const voteCompletions = ledger
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => event === `transaction:${EXACT_VOTE_TRANSACTION_STORES.join(",")}:complete`);
	expect(evidenceComplete).toBeGreaterThanOrEqual(0);
	expect(evidenceRelease).toBeGreaterThan(evidenceComplete);
	expect(voteCompletions).toHaveLength(2);
	expect(ledger.indexOf("event:prepare_vote_committed")).toBeGreaterThan(voteCompletions[0]?.index ?? -1);
	expect(ledger.indexOf("event:commit_vote_committed")).toBeGreaterThan(voteCompletions[1]?.index ?? -1);
	expect(observed.filter(({ mode }) => mode === "readwrite").every(({ completed }) => completed)).toBe(true);
});

test("renderer termination at every durable boundary reopens old or the exact next state", async ({ browser }) => {
	const context = await browser.newContext();
	try {
		const permittedRawPhases = [
			["empty", "evidence-committed"],
			["evidence-committed", "prepare-voted"],
			["prepare-voted", "prepared"],
			["prepared", "commit-voted"],
			["commit-voted", "finalized"],
			["finalized"],
			["finalized"],
		] as const;
		for (const [index, checkpoint] of CRASH_CHECKPOINTS.entries()) {
			const databaseName = `phase5e-crash-${index}-${crypto.randomUUID()}`;
			const first = await context.newPage();
			await first.goto(server?.origin ?? "about:blank");
			if (index === 0) await first.evaluate((name) => window.phase5eCreatorActor.start(name), databaseName);
			else {
				await first.evaluate(([name, eventKind]) => window.phase5eCreatorActor.armCrash(name, eventKind), [
					databaseName,
					EXPECTED_EVENT_KINDS[index - 1] as string,
				] as const);
			}
			if (index > 0) await waitForEventCount(first, databaseName, Math.min(index, EXPECTED_EVENT_KINDS.length));
			await first.close({ runBeforeUnload: false });
			const reopened = await context.newPage();
			await reopened.goto(server?.origin ?? "about:blank");
			const rawAfterDeath = await rawDatabase(reopened, databaseName);
			expect(permittedRawPhases[index], checkpoint).toContain(durablePhase(rawAfterDeath));
			const observed = (await reopened.evaluate(
				(name) => window.phase5eCreatorActor.observe(name),
				databaseName
			)) as Readonly<{ status: Readonly<{ phase: string; terminal: boolean }> }>;
			expect(observed.status.terminal, checkpoint).toBe(false);
			expect(["empty", "evidence-committed", "prepare-voted", "prepared", "commit-voted", "finalized"]).toContain(
				observed.status.phase
			);
			const resumed = await reopened.evaluate((name) => window.phase5eCreatorActor.start(name), databaseName);
			expect(resumed).toBeTruthy();
			const result = await reopened.evaluate((name) => window.phase5eCreatorActor.awaitResult(name), databaseName);
			expect(result).toMatchObject({ ok: true });
			await reopened.close();
		}
	} finally {
		await context.close();
	}
});

test("exact replay is idempotent, a conflicting close is durable failure, and stop fences late effects", async ({
	page,
}) => {
	await page.goto(server?.origin ?? "about:blank");
	const conflict = await page.evaluate(
		(name) => window.phase5eCreatorActor.runConflict(name),
		`phase5e-conflict-${crypto.randomUUID()}`
	);
	expect(conflict).toMatchObject({
		conflict: { ok: false, reason: "CLOSE_CONFLICT" },
		duplicate: { duplicate: true, ok: true },
		first: { ok: true },
		status: { phase: "finalized", terminal: true },
	});
	const stoppedDatabase = `phase5e-stop-${crypto.randomUUID()}`;
	const stopped = (await page.evaluate(
		(name) => window.phase5eCreatorActor.runStop(name),
		stoppedDatabase
	)) as Readonly<{
		afterTurn: unknown;
		atStop: Readonly<{ openReadwriteTransactions: number }>;
		settled: unknown;
	}>;
	expect(stopped.atStop.openReadwriteTransactions).toBeGreaterThan(0);
	expect(stopped.afterTurn).toEqual(stopped.settled);
	const durableAtStopSettlement = await rawDatabase(page, stoppedDatabase);
	await page.waitForTimeout(50);
	expect(await rawDatabase(page, stoppedDatabase)).toEqual(durableAtStopSettlement);
});

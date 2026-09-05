import { expect, type Page, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const REQUIRED_OWNERS = (
	JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-5-v3/seal-safety-contract.json"), "utf8")) as {
		readonly requiredOwners: readonly string[];
	}
).requiredOwners;
const GREEN_READY = REQUIRED_OWNERS.every((path) => existsSync(resolve(REPOSITORY_ROOT, path)));

let server: Phase4cBrowserServer | undefined;

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5c-seal-vote-entry.ts"),
		workerPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5c-seal-vote-worker.ts"),
	});
});

test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.105b product owners are intentionally absent in RED");

async function installTransactionObserver(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const observations: { durability: string; mode: string; stores: string[] }[] = [];
		const original = IDBDatabase.prototype.transaction;
		Object.defineProperty(window, "__phase5cTransactions", { value: observations });
		IDBDatabase.prototype.transaction = function transaction(
			storeNames: string | string[],
			mode?: IDBTransactionMode,
			options?: IDBTransactionOptions
		): IDBTransaction {
			const selected = original.call(this, storeNames, mode, options);
			observations.push({
				durability: selected.durability,
				mode: selected.mode,
				stores: Array.from(selected.objectStoreNames),
			});
			return selected;
		};
	});
}

async function inspectRaw(page: Page, databaseName: string): Promise<unknown> {
	return page.evaluate(async (name) => {
		const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
			const request = indexedDB.open(name);
			request.onerror = (): void => reject(request.error ?? new Error("raw reopen failed"));
			request.onsuccess = (): void => resolvePromise(request.result);
		});
		try {
			const stores = Array.from(database.objectStoreNames);
			const transaction = database.transaction(stores, "readonly");
			const counts = Object.fromEntries(
				await Promise.all(
					stores.map(
						(storeName) =>
							new Promise<readonly [string, number]>((resolvePromise, reject) => {
								const request = transaction.objectStore(storeName).count();
								request.onerror = (): void => reject(request.error ?? new Error("raw count failed"));
								request.onsuccess = (): void => resolvePromise([storeName, request.result]);
							})
					)
				)
			);
			return { counts, stores, version: database.version };
		} finally {
			database.close();
		}
	}, databaseName);
}

test("fresh and exact-v1 databases become the additive version-3 nine-store schema", async ({ page }) => {
	await installTransactionObserver(page);
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `phase-5c-schema-${crypto.randomUUID()}`;
	const result = (await page.evaluate(
		(databaseName) => window.phase5cSealVote.runSchemaScenario(databaseName),
		databaseName
	)) as {
		readonly fresh: { readonly incarnation: string; readonly stores: readonly string[]; readonly version: number };
		readonly malformed: { readonly rejected: boolean; readonly unchanged: boolean };
		readonly upgraded: {
			readonly preservedLegacyRows: number;
			readonly stores: readonly string[];
			readonly version: number;
		};
	};
	const stores = [
		"blobs",
		"generations",
		"objects",
		"promotions",
		"sealEvidence",
		"signerState",
		"storageMeta",
		"voteOutbox",
		"voteSlots",
	];
	expect(result.fresh).toMatchObject({ stores, version: 3 });
	expect(result.fresh.incarnation).toMatch(/^[0-9a-f]{32,}$/u);
	expect(result.upgraded).toEqual({ preservedLegacyRows: 4, stores, version: 3 });
	expect(result.malformed).toEqual({ rejected: true, unchanged: true });
	expect(await inspectRaw(page, databaseName)).toMatchObject({ stores, version: 3 });
});

test("one strict transaction owns incarnation, signer state, slot and outbox before release", async ({ page }) => {
	await installTransactionObserver(page);
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `phase-5c-vote-${crypto.randomUUID()}`;
	const result = (await page.evaluate(
		(databaseName) => window.phase5cSealVote.runStrictVoteScenario(databaseName),
		databaseName
	)) as {
		readonly conflict: { readonly existingBytesExact: boolean; readonly writes: number };
		readonly dispatchAfterComplete: number;
		readonly dispatchBeforeComplete: number;
		readonly duplicate: { readonly exactStoredBytes: boolean; readonly writes: number };
		readonly first: { readonly durability: string; readonly stores: readonly string[]; readonly writes: number };
		readonly recreated: { readonly reason: string; readonly writes: number };
		readonly staleRevision: { readonly reason: string; readonly writes: number };
	};
	expect(result.first).toEqual({
		durability: "strict",
		stores: ["signerState", "storageMeta", "voteOutbox", "voteSlots"],
		writes: 3,
	});
	expect(result.dispatchBeforeComplete).toBe(0);
	expect(result.dispatchAfterComplete).toBe(1);
	expect(result.duplicate).toEqual({ exactStoredBytes: true, writes: 0 });
	expect(result.conflict).toEqual({ existingBytesExact: true, writes: 0 });
	expect(result.staleRevision).toEqual({ reason: "REVALIDATION_REQUIRED", writes: 0 });
	expect(result.recreated).toEqual({ reason: "STORAGE_LOSS", writes: 0 });
	const observed = (await page.evaluate(() => Reflect.get(window, "__phase5cTransactions"))) as readonly {
		readonly durability: string;
		readonly mode: string;
		readonly stores: readonly string[];
	}[];
	const fourStoreTransactions = observed.filter(
		({ mode, stores }) =>
			mode === "readwrite" && stores.join(",") === ["signerState", "storageMeta", "voteOutbox", "voteSlots"].join(",")
	);
	expect(fourStoreTransactions).toHaveLength(5);
	expect(
		fourStoreTransactions.every(
			({ durability, mode, stores }) =>
				durability === "strict" &&
				mode === "readwrite" &&
				stores.join(",") === ["signerState", "storageMeta", "voteOutbox", "voteSlots"].join(",")
		)
	).toBe(true);
	expect(fourStoreTransactions[0]).toEqual({
		durability: "strict",
		mode: "readwrite",
		stores: ["signerState", "storageMeta", "voteOutbox", "voteSlots"],
	});
	expect(await inspectRaw(page, databaseName)).toMatchObject({
		counts: { signerState: 1, storageMeta: 1, voteOutbox: 1, voteSlots: 1 },
	});
});

test("voter enrollment scopes snapshots and round advancement across multiple lawful signer rows", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5cSealVote.runScopedSnapshotScenario(databaseName),
		`phase-5c-scoped-${crypto.randomUUID()}`
	)) as {
		readonly advanced: { readonly ok: boolean; readonly revision: number };
		readonly firstAfter: { readonly enteredRound: number; readonly revision: number };
		readonly firstBefore: { readonly enteredRound: number; readonly revision: number };
		readonly secondAfter: { readonly enteredRound: number; readonly revision: number };
		readonly secondBefore: { readonly enteredRound: number; readonly revision: number };
	};
	expect(result.firstBefore).toMatchObject({ enteredRound: 0, revision: 1 });
	expect(result.secondBefore).toMatchObject({ enteredRound: 0, revision: 1 });
	expect(result.advanced).toEqual({ ok: true, revision: 2 });
	expect(result.firstAfter).toMatchObject({ enteredRound: 2, revision: 2 });
	expect(result.secondAfter).toMatchObject({ enteredRound: 0, revision: 1 });
});

test("worker termination reopens only the committed exact vote state", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `phase-5c-worker-${crypto.randomUUID()}`;
	const runWorker = async (mode: "commit" | "reopen"): Promise<unknown> =>
		page.evaluate(
			([name, selected]) =>
				new Promise((resolvePromise, reject) => {
					const worker = new Worker("/worker.js", { type: "module" });
					const id = crypto.randomUUID();
					const timeout = setTimeout(() => {
						worker.terminate();
						reject(new Error("Phase 5c worker timed out"));
					}, 10_000);
					worker.addEventListener("message", (event: MessageEvent) => {
						const result = event.data as {
							readonly error?: string;
							readonly id?: string;
							readonly ok?: boolean;
							value?: unknown;
						};
						if (result.id !== id) return;
						clearTimeout(timeout);
						worker.terminate();
						if (result.ok === true) resolvePromise(result.value);
						else reject(new Error(result.error ?? "worker request failed"));
					});
					worker.postMessage({ databaseName: name, id, mode: selected });
				}),
			[databaseName, mode] as const
		);
	await runWorker("commit");
	const reopened = await runWorker("reopen");
	expect(reopened).toMatchObject({ pendingCount: 1, state: "exact-new" });
	expect(await inspectRaw(page, databaseName)).toMatchObject({
		counts: { signerState: 1, storageMeta: 1, voteOutbox: 1, voteSlots: 1 },
		version: 3,
	});
});

test("blocked timeout and held-lock versionchange cannot commit late or retain authority", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = await page.evaluate(
		(databaseName) => window.phase5cSealVote.runVersionChangeScenario(databaseName),
		`phase-5c-versionchange-${crypto.randomUUID()}`
	);
	expect(result).toEqual({
		blockedLateUpgradeCommitted: false,
		connectionClosedSynchronously: true,
		lateDispatchMarked: false,
		successorPendingCount: 1,
	});
});

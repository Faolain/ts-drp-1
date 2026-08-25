import { expect, type Page, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const contract = JSON.parse(
	readFileSync(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-5d-v3/pacemaker-contract.json"), "utf8")
) as Readonly<{ readonly runtimeOwners: readonly string[] }>;

function browserRuntimeReady(): boolean {
	if (!contract.runtimeOwners.every((path) => existsSync(resolve(REPOSITORY_ROOT, path)))) return false;
	const packageManifest = JSON.parse(
		readFileSync(resolve(REPOSITORY_ROOT, "packages/seal/package.json"), "utf8")
	) as Readonly<{ readonly exports?: Readonly<Record<string, unknown>> }>;
	const viteSource = readFileSync(resolve(REPOSITORY_ROOT, "vite.config.mts"), "utf8");
	const specificAlias = viteSource.indexOf('"@ts-drp/seal/pacemaker"');
	const bareAlias = viteSource.indexOf('"@ts-drp/seal"');
	return packageManifest.exports?.["./pacemaker"] !== undefined && specificAlias >= 0 && specificAlias < bareAlias;
}

const GREEN_READY = browserRuntimeReady();
const FOUR_STORES = ["signerState", "storageMeta", "voteOutbox", "voteSlots"];
const TWO_STORES = ["signerState", "storageMeta"];

let server: Phase4cBrowserServer | undefined;

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5d-round-change-entry.ts"),
	});
});

test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.106b pacemaker runtime is intentionally absent in RED");

async function installTransactionObserver(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const observed: Readonly<{ durability: string; mode: string; stores: readonly string[] }>[] = [];
		const original = IDBDatabase.prototype.transaction;
		Object.defineProperty(window, "__phase5dTransactions", { value: observed });
		IDBDatabase.prototype.transaction = function transaction(
			storeNames: string | string[],
			mode?: IDBTransactionMode,
			options?: IDBTransactionOptions
		): IDBTransaction {
			const transaction = original.call(this, storeNames, mode, options);
			(observed as { durability: string; mode: string; stores: readonly string[] }[]).push({
				durability: transaction.durability,
				mode: transaction.mode,
				stores: Array.from(transaction.objectStoreNames),
			});
			return transaction;
		};
	});
}

test("round entry persists the exact signed round-change in one strict four-store transaction", async ({ page }) => {
	await installTransactionObserver(page);
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runRoundChangeCommit(databaseName),
		`phase5d-round-${crypto.randomUUID()}`
	)) as {
		readonly afterReopen: Readonly<{
			readonly enteredRound: number;
			readonly pendingRoundChangeCount: number;
			readonly revision: number;
		}>;
		readonly beforeClose: Readonly<{
			readonly enteredRound: number;
			readonly pendingRoundChangeCount: number;
			readonly revision: number;
		}>;
		readonly events: readonly Readonly<Record<string, unknown>>[];
	};
	expect(result.beforeClose.enteredRound).toBe(1);
	expect(result.beforeClose.pendingRoundChangeCount).toBe(1);
	expect(result.beforeClose.revision).toBeGreaterThan(0);
	expect(result.afterReopen).toEqual(result.beforeClose);
	expect(result.events.map(({ kind }) => kind)).toContain("round_entered");
	expect(result.events.map(({ kind }) => kind)).toContain("restart");
	const observed = (await page.evaluate(() => Reflect.get(window, "__phase5dTransactions"))) as readonly Readonly<{
		readonly durability: string;
		readonly mode: string;
		readonly stores: readonly string[];
	}>[];
	const matching = observed.filter(
		({ mode, stores }) => mode === "readwrite" && stores.join(",") === FOUR_STORES.join(",")
	);
	expect(matching).toHaveLength(1);
	expect(matching[0]).toEqual({ durability: "strict", mode: "readwrite", stores: FOUR_STORES });
});

test("complete prepare and commit QCs become durable before lock and finalization observations", async ({ page }) => {
	await installTransactionObserver(page);
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runQcCustody(databaseName),
		`phase5d-qc-${crypto.randomUUID()}`
	)) as {
		readonly afterPostFinalProposal: Readonly<{ readonly phase: string; readonly revision: number }>;
		readonly afterProposalFirst: Readonly<{ readonly phase: string; readonly revision: number }>;
		readonly afterProposalSecond: Readonly<{ readonly phase: string; readonly revision: number }>;
		readonly afterFinal: Readonly<{
			readonly durableCommitQcCount: number;
			readonly finalizedValueDigest: string | null;
			readonly revision: number;
		}>;
		readonly beforeFinal: Readonly<{
			readonly durablePrepareQcCount: number;
			readonly finalizedValueDigest: string | null;
			readonly revision: number;
		}>;
		readonly events: readonly Readonly<Record<string, unknown>>[];
		readonly finalized: Readonly<{ readonly ok: boolean; readonly revision: number }>;
		readonly postFinalProposal: Readonly<{ readonly ok: boolean; readonly reason?: string }>;
		readonly prepare: Readonly<{ readonly ok: boolean; readonly revision: number }>;
		readonly proposal: Readonly<{ readonly ok: boolean }>;
	};
	expect(result.proposal).toMatchObject({ ok: true });
	expect(result.afterProposalSecond).toEqual(result.afterProposalFirst);
	expect(result.prepare).toMatchObject({ ok: true });
	expect(result.beforeFinal.finalizedValueDigest).toBeNull();
	expect(result.beforeFinal.durablePrepareQcCount).toBe(1);
	expect(result.finalized).toMatchObject({ ok: true });
	expect(result.afterFinal.durableCommitQcCount).toBe(1);
	expect(result.afterFinal.finalizedValueDigest).toMatch(/^[0-9a-f]{64}$/u);
	expect(result.postFinalProposal).toEqual({ ok: false, reason: "FINALIZED" });
	expect(result.afterPostFinalProposal).toEqual(result.afterFinal);
	const eventKinds = result.events.map(({ kind }) => kind);
	for (const event of ["vote_cast", "qc_formed", "lock_acquired", "finalized"]) expect(eventKinds).toContain(event);
	for (const [sequence, event] of result.events.entries()) {
		expect(event).toMatchObject({ epoch: 0, kind: eventKinds[sequence], sequence });
		expect(Object.keys(event).sort()).toEqual([
			"anchor",
			"epoch",
			"kind",
			"objectId",
			"phase",
			"qcDigest",
			"round",
			"sequence",
			"signerId",
			"valueDigest",
		]);
	}
	const observed = (await page.evaluate(() => Reflect.get(window, "__phase5dTransactions"))) as readonly Readonly<{
		readonly durability: string;
		readonly mode: string;
		readonly stores: readonly string[];
	}>[];
	const matching = observed.filter(
		({ mode, stores }) => mode === "readwrite" && stores.join(",") === TWO_STORES.join(",")
	);
	expect(matching).toHaveLength(2);
	expect(matching.every(({ durability }) => durability === "strict")).toBe(true);
});

test("serializes concurrent public observations through one durable transition gate", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runSerializedTransitions(databaseName),
		`phase5d-serialized-${crypto.randomUUID()}`
	)) as Readonly<{
		events: readonly Readonly<Record<string, unknown>>[];
		prepare: Readonly<{ ok: boolean; reason?: string }>;
		proposal: Readonly<{ ok: boolean; reason?: string }>;
		status: Readonly<{ durablePrepareQcCount: number; phase: string }>;
	}>;
	expect(result.proposal).toMatchObject({ ok: true });
	expect(result.prepare).toMatchObject({ ok: true });
	expect(result.status).toMatchObject({ durablePrepareQcCount: 1, phase: "committed" });
	expect(result.events.map(({ kind }) => kind)).toEqual(["vote_cast", "qc_formed", "lock_acquired", "vote_cast"]);
});

test("stop drains the active transition and fences all later effects", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runStopFence(databaseName),
		`phase5d-stop-${crypto.randomUUID()}`
	)) as Readonly<{
		eventsAfterTurn: readonly unknown[];
		eventsWhenStopResolved: readonly unknown[];
		proposal: Readonly<{ ok: boolean; reason?: string }>;
		settledWhenStopResolved: boolean;
		statusAfterTurn: Readonly<Record<string, unknown>>;
		statusWhenStopResolved: Readonly<Record<string, unknown>>;
	}>;
	expect(result.settledWhenStopResolved).toBe(true);
	expect(result.proposal).toMatchObject({ ok: true });
	expect(result.eventsAfterTurn).toEqual(result.eventsWhenStopResolved);
	expect(result.statusAfterTurn).toEqual(result.statusWhenStopResolved);
	expect(result.statusWhenStopResolved).toMatchObject({ phase: "stopped" });
});

test("selects the greatest nested prepare QC, ties by digest, and rejects same-round value conflict", async ({
	page,
}) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(() => window.phase5dPacemaker.runCertificateSelection())) as Readonly<{
		accepted: Readonly<{ ok: boolean; reason?: string; selectedPrepareQcDigest?: string }>;
		conflict: Readonly<{ ok: boolean; reason?: string }>;
		expectedSelectedDigest: string;
	}>;
	expect(result.accepted).toMatchObject({
		ok: true,
		selectedPrepareQcDigest: result.expectedSelectedDigest,
	});
	expect(result.conflict).toEqual({ ok: false, reason: "new-round-certificate-conflict" });
});

test("fails closed when complete durable QC authority is corrupt on reopen", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runCorruptQcReopen(databaseName),
		`phase5d-corrupt-qc-${crypto.randomUUID()}`
	)) as Readonly<{ message?: string; ok: boolean }>;
	expect(result.ok).toBe(false);
	expect(result.message).toMatch(/DURABLE_QC_INVALID|durable QC authority invalid/iu);
});

test("cannot durably sign a commit vote before the matching prepare QC is durable", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runCommitWithoutPrepareQc(databaseName),
		`phase5d-commit-guard-${crypto.randomUUID()}`
	)) as Readonly<{
		committed: Readonly<{ ok: boolean; reason?: string }>;
		exposesEnterRound: boolean;
		status: Readonly<{ durableRevision: number; revision: number }>;
	}>;
	expect(result.committed).toEqual({ ok: false, reason: "prepare-qc-required" });
	expect(result.exposesEnterRound).toBe(false);
	expect(result.status.revision).toBe(0);
});

test("prunes stale future evidence after authenticated QC catch-up", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runEvidencePruning(databaseName),
		`phase5d-evidence-${crypto.randomUUID()}`
	)) as Readonly<{
		afterCatchup: Readonly<{ bufferedFutureRounds: number; round: number }>;
		beforeCatchup: Readonly<{ bufferedFutureRounds: number; round: number }>;
		catchup: Readonly<{ ok: boolean; reason?: string }>;
	}>;
	expect(result.beforeCatchup).toMatchObject({ bufferedFutureRounds: 1, round: 0 });
	expect(result.catchup).toMatchObject({ ok: true });
	expect(result.afterCatchup).toMatchObject({ bufferedFutureRounds: 0, round: 2 });
});

import { chromium, expect, firefox, type Page, test, webkit } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";
import { encodeCanonical } from "../../canonical/dist/src/index.js";

import {
	killOwnedRecipient,
	launchOwned,
	publicProcessRecord,
} from "/private/tmp/ts-drp-recipient-install-green-high-vh4kHH/.logs/bounded-storage-lifecycle/recipient-install-green-01/ordinary-2f-qualification-01/owned-process-03.js";
import {
	checkOriginalChildDeath,
	closeAndJoinOriginal,
	retainedError,
} from "/private/tmp/ts-drp-recipient-install-green-high-vh4kHH/.logs/bounded-storage-lifecycle/recipient-install-green-01/ordinary-2f-qualification-01/owned-crash-process-check-02.js";

import { VOTE_TRANSACTION_STORES } from "../src/internal/seal-vote-store.js";

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
const QC_TRANSACTION_STORES = [...VOTE_TRANSACTION_STORES].sort();

let server: Phase4cBrowserServer | undefined;

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5d-round-change-entry.ts"),
	});
});

test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.106b pacemaker runtime is intentionally absent in RED");

async function installTransactionObserver(page: Page, traceQcWrites = false): Promise<void> {
	await page.addInitScript((traceQcWrites) => {
		type Observed = {
			durability: string;
			mode: string;
			stores: readonly string[];
			writtenStores?: string[];
			terminal?: string;
		};
		const observed: Observed[] = [];
		const transactions = new WeakMap<IDBTransaction, Observed>();
		const original = IDBDatabase.prototype.transaction;
		if (traceQcWrites)
			for (const method of ["put", "add", "delete", "clear"] as const) {
				const originalWrite = IDBObjectStore.prototype[method];
				Reflect.set(
					IDBObjectStore.prototype,
					method,
					function (this: IDBObjectStore, ...args: unknown[]): IDBRequest<unknown> {
						const request = Reflect.apply(originalWrite, this, args) as IDBRequest<unknown>;
						const row = transactions.get(this.transaction);
						if (row?.writtenStores !== undefined && !row.writtenStores.includes(this.name))
							row.writtenStores.push(this.name);
						return request;
					}
				);
			}
		Object.defineProperty(window, "__phase5dTransactions", { value: observed });
		IDBDatabase.prototype.transaction = function transaction(
			storeNames: string | string[],
			mode?: IDBTransactionMode,
			options?: IDBTransactionOptions
		): IDBTransaction {
			const transaction = original.call(this, storeNames, mode, options);
			const row: Observed = {
				durability: transaction.durability,
				mode: transaction.mode,
				stores: Array.from(transaction.objectStoreNames),
				...(traceQcWrites ? { writtenStores: [] } : {}),
			};
			transactions.set(transaction, row);
			observed.push(row);
			if (traceQcWrites)
				transaction.addEventListener(
					"complete",
					() => {
						row.terminal = "complete";
					},
					{ once: true }
				);
			if (traceQcWrites)
				transaction.addEventListener(
					"abort",
					() => {
						row.terminal = "abort";
					},
					{ once: true }
				);
			return transaction;
		};
	}, traceQcWrites);
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
	await installTransactionObserver(page, true);
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
	let expectedSequence = 0;
	for (const event of result.events) {
		if (event.kind === "restart") expectedSequence = 0;
		expect(event).toMatchObject({ epoch: 0, kind: event.kind, sequence: expectedSequence++ });
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
		readonly writtenStores: readonly string[];
		readonly terminal?: string;
	}>[];
	const matching = observed.filter(
		({ mode, stores, writtenStores, terminal }) =>
			mode === "readwrite" &&
			stores.join(",") === QC_TRANSACTION_STORES.join(",") &&
			writtenStores.join(",") === "signerState" &&
			terminal === "complete"
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

test("bounds observations behind an entered stalled native signing job and joins before stop", async ({page}, info) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = await page.evaluate(databaseName => window.phase5dPacemaker.runStalledPacemakerAdmission(databaseName),
		`phase5d-stalled-admission-${crypto.randomUUID()}`) as {
		beforeRelease: { settled: {kind: string; result: {ok: boolean; reason?: string}}[]; proposalSettled: boolean; signEntries: number; voterUnchanged: boolean };
		stopBeforeRelease: boolean; afterStop: unknown; proposal: unknown; signEntries: number; stopSettled: boolean;
		settled: {kind: string; result: {ok: boolean; reason?: string}}[]; status: {phase: string};
	};
	await info.attach("stalled-pacemaker-admission", {body: Buffer.from(JSON.stringify(result)),contentType: "application/json"});
	expect(result.beforeRelease.signEntries).toBe(1);
	expect(result.beforeRelease.proposalSettled).toBe(false);
	expect(result.beforeRelease.voterUnchanged).toBe(true);
	expect(result.beforeRelease.settled.filter(row => row.kind === "oversized")).toHaveLength(4);
	expect(result.beforeRelease.settled.filter(row => row.kind === "oversized").every(row => !row.result.ok)).toBe(true);
	//32 total admitted jobs includes the one entered proposal:31 queued QCs.
	expect(result.beforeRelease.settled.filter(row => row.kind === "bounded")).toHaveLength(9);
	expect(result.beforeRelease.settled.filter(row => row.kind === "bounded").every(row =>
		!row.result.ok && row.result.reason === "QUEUE_CAPACITY")).toBe(true);
	expect(result.stopBeforeRelease).toBe(false);
	expect(result.afterStop).toEqual({ok: false, reason: "STOPPED"});
	expect(result.proposal).toMatchObject({ok: true});
	expect(result.settled.filter(row => row.kind === "bounded" && row.result.ok)).toHaveLength(31);
	expect(result.signEntries).toBe(2);
	expect(result.stopSettled).toBe(true);
	expect(result.status.phase).toBe("stopped");
});

test("bounds direct voter work while native signing stalls without invoking caller byte iterators", async ({page}, info) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = await page.evaluate(databaseName => window.phase5dPacemaker.runStalledDirectVoter(databaseName),
		`phase5d-direct-stalled-${crypto.randomUUID()}`) as {
		beforeRelease: {iteratorCalls: number; getterCalls: number; signEntries: number; voteSettled: boolean;
			voterUnchanged: boolean; refused: {ok: boolean; reason: string}[]};
		completedVote: {ok: boolean}; completedQc: {ok: boolean}; signEntries: number;
		status: {durablePrepareQcCount: number; lockedValueDigest: string | null};
	};
	await info.attach("stalled-direct-voter", {body:Buffer.from(JSON.stringify(result)),contentType:"application/json"});
	expect(result.beforeRelease).toMatchObject({iteratorCalls:0,getterCalls:0,signEntries:1,voteSettled:false,voterUnchanged:true});
	expect(result.beforeRelease.refused).toHaveLength(40);
	expect(result.beforeRelease.refused.every(value => !value.ok && value.reason === "BUSY")).toBe(true);
	expect(result.completedVote).toMatchObject({ok:true});
	expect(result.completedQc).toMatchObject({ok:true});
	expect(result.signEntries).toBe(1);
	expect(result.status.durablePrepareQcCount).toBe(1);
	expect(result.status.lockedValueDigest).not.toBeNull();
});

test("rearms a capacity-refused timer after unchanged native QC work joins", async ({page}, info) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = await page.evaluate(databaseName => window.phase5dPacemaker.runStalledPacemakerTimer(databaseName),
		`phase5d-stalled-timer-${crypto.randomUUID()}`) as {
		beforeRelease: {settled: number; round: number}; results: {ok: boolean}[]; status: {round: number};
	};
	await info.attach("stalled-pacemaker-timer", {body: Buffer.from(JSON.stringify(result)),contentType: "application/json"});
	expect(result.beforeRelease).toEqual({settled: 0, round: 0});
	expect(result.results).toHaveLength(32);
	expect(result.results.every(row => row.ok)).toBe(true);
	expect(result.status.round).toBeGreaterThanOrEqual(1);
});

test("captures original record byte and authenticated quorum boundaries without caller iterators or metadata", async ({page}, info) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = await page.evaluate(databaseName => window.phase5dPacemaker.runPacemakerCaptureBounds(databaseName),
		`phase5d-capture-bounds-${crypto.randomUUID()}`) as Record<string,unknown>;
	await info.attach("pacemaker-capture-boundaries",{body:Buffer.from(JSON.stringify(result)),contentType:"application/json"});
	expect(result).toMatchObject({iteratorCalls:0,getterCalls:0,qcCopiedBytes:65536,qcPrivate:true,
		certificateCount:3,proposalCopiedBytes:393472,certificatePrivate:true,metadataDiscarded:true});
	for(const key of ["oversized","wrongCount","accessorRefusal"]) expect(result[key]).toEqual({ok:false,reason:"malformed-input"});
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

test("genuine voter retires authenticated lower-round detail after joined publication and verified higher QC", async ({
	page,
}, testInfo) => {
	await installTransactionObserver(page, true);
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runAuthenticatedDetailRetirement(databaseName),
		`phase6-detail-${crypto.randomUUID()}`
	)) as Readonly<{
		error?: unknown;
		proposal: Readonly<{ ok: boolean }>;
		publication: Readonly<{ sentKeys: readonly string[] }>;
		verifiedQc: Readonly<{ ok: boolean; phase: string; round: number }>;
		persistedQc: Readonly<{ ok: boolean }>;
		before: Readonly<{
			frames: readonly Readonly<{ table: string; key: unknown; bytes: string }>[];
			safety: string;
			revision: number;
			floor: number;
		}>;
		after: Readonly<{
			frames: readonly Readonly<{ table: string; key: unknown; bytes: string }>[];
			safety: string;
			revision: number;
			floor: number;
		}>;
		reopened: unknown;
		retirement: Readonly<{
			ok: boolean;
			deletedRows?: number;
			remaining?: boolean;
			retiredBeforeRound?: number;
			revision?: number;
		}>;
		futureVote: Readonly<{ ok: boolean }>;
		futurePublication: Readonly<{ sentKeys: readonly string[] }>;
		published: readonly string[];
		cleanup: readonly Readonly<{ status: string }>[];
	}>;
	// Save exact original inputs/endpoints before the causal physical-row oracle.
	await testInfo.attach("native-signing-detail.json", {
		body: JSON.stringify({
			result,
			transactions: await page.evaluate(() => Reflect.get(window, "__phase5dTransactions")),
		}),
		contentType: "application/json",
	});
	expect(result.error).toBeUndefined();
	expect(result.cleanup.length).toBe(8);
	expect(result.cleanup.every(({ status }) => status === "fulfilled")).toBe(true);
	expect(result.proposal).toMatchObject({ ok: true });
	expect(result.publication.sentKeys).toHaveLength(1);
	expect(result.verifiedQc).toMatchObject({ ok: true, phase: "prepare", round: 2 });
	expect(result.persistedQc).toMatchObject({ ok: true });
	const lowerDetail = ({ table, key }: Readonly<{ table: string; key: unknown }>): boolean =>
		(table === "voteSlots" || table === "voteOutbox") && Array.isArray(key) && typeof key[2] === "number" && key[2] < 2;
	expect(result.before.frames.filter(lowerDetail)).toHaveLength(2);
	expect(result.before.floor).toBe(0);
	expect(
		result.after.frames.filter(lowerDetail),
		"AUTHENTICATED_LOWER_ROUND_DETAILS_MUST_BE_PHYSICALLY_RETIRED"
	).toHaveLength(0);
	expect(result.retirement).toMatchObject({ ok: true, deletedRows: 2, remaining: false, retiredBeforeRound: 2 });
	expect(result.after.floor).toBe(2);
	expect(result.after.revision).toBe(result.before.revision + 1);
	expect(result.retirement.revision).toBe(result.after.revision);
	expect(result.after.safety).toBe(result.before.safety);
	const protectedFrames = (image: typeof result.before): readonly unknown[] =>
		image.frames.filter((frame) => frame.table !== "signerState" && !lowerDetail(frame));
	expect(protectedFrames(result.after)).toEqual(protectedFrames(result.before));
	expect(result.reopened).toEqual(result.after);
	expect(result.futureVote).toMatchObject({ ok: true });
	expect(result.futurePublication.sentKeys).toHaveLength(1);
	expect(result.published).toHaveLength(2);
	expect(new Set(result.published).size).toBe(2);
});

test("original bound delayed signing refuses before crypto after physical detail retirement while current signing remains lawful", async ({
	page,
}, testInfo) => {
	await installTransactionObserver(page, true);
	await page.goto(server?.origin ?? "about:blank");
	type Frame = Readonly<{ table: string; key: unknown; bytes: string }>;
	type Image = Readonly<{ frames: readonly Frame[]; safety: string; revision: number; floor: number }>;
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runDelayedPhysicalDetailSigning(databaseName),
		`phase6-delayed-physical-sign-${crypto.randomUUID()}`
	)) as Readonly<{
		error?: unknown;
		vote0: Readonly<{ ok: boolean }>;
		publication: Readonly<{ sentKeys: readonly string[] }>;
		binding: Readonly<{
			objectId: string;
			epoch: number;
			anchor: string;
			signerId: string;
			expectedIncarnation: string;
			publicKey: string;
		}>;
		delayedPreimage: string;
		delayedDigest: string;
		delayedTuple: Readonly<{
			kind: string;
			objectId: string;
			epoch: number;
			round: number;
			phase: string;
			signerId: string;
		}>;
		currentPreimage: string;
		currentDigest: string;
		currentTuple: Readonly<{
			kind: string;
			objectId: string;
			epoch: number;
			round: number;
			phase: string;
			signerId: string;
		}>;
		boundBeforeRetirement: Image;
		beforeRetirement: Image;
		afterRetirement: Image;
		afterLateSigning: Image;
		afterCurrentSigning: Image;
		verifiedQc2: Readonly<{ ok: boolean; phase: string; round: number }>;
		persistedQc2: Readonly<{ ok: boolean }>;
		retirement: Readonly<{
			ok: boolean;
			deletedRows: number;
			remaining: boolean;
			retiredBeforeRound: number;
			revision: number;
		}>;
		lateSignature?: string;
		lateError: Readonly<{ name: string; message: string; reason?: string }>;
		currentSignature: string;
		currentVerified: Readonly<{
			ok: boolean;
			epoch: number;
			objectId: string;
			round: number;
			phase: string;
			signerId: string;
		}>;
		cryptoEntries: readonly Readonly<{
			phase: string;
			sameOriginalPrototype: boolean;
			publicKey: string;
			digest: string;
		}>[];
		published: readonly string[];
		cleanup: readonly Readonly<{ name: string; status: string }>[];
	}>;
	await testInfo.attach("native-delayed-physical-signing.json", {
		body: JSON.stringify({
			result,
			transactions: await page.evaluate(() => Reflect.get(window, "__phase5dTransactions")),
		}),
		contentType: "application/json",
	});
	expect(result.error).toBeUndefined();
	expect(result.cleanup).toHaveLength(5);
	expect(result.cleanup.every(({ status }) => status === "fulfilled")).toBe(true);
	expect(result.vote0).toMatchObject({ ok: true });
	expect(result.publication.sentKeys).toHaveLength(1);
	expect(result.published).toHaveLength(1);
	expect(result.binding.expectedIncarnation).toMatch(/^[0-9a-f]{32}$/u);
	expect(result.binding.publicKey).toMatch(/^[0-9a-f]{64}$/u);
	expect(result.delayedTuple).toMatchObject({
		kind: "drp-seal-vote",
		objectId: result.binding.objectId,
		epoch: result.binding.epoch,
		round: 0,
		phase: "prepare",
		signerId: result.binding.signerId,
	});
	expect(result.boundBeforeRetirement.floor).toBe(0);
	const oldDetail = ({ table, key }: Frame): boolean =>
		(table === "voteSlots" || table === "voteOutbox") && Array.isArray(key) && key[2] === 0;
	expect(result.boundBeforeRetirement.frames.filter(oldDetail)).toHaveLength(2);
	expect(result.verifiedQc2).toMatchObject({ ok: true, phase: "prepare", round: 2 });
	expect(result.persistedQc2).toMatchObject({ ok: true });
	expect(result.retirement).toMatchObject({ ok: true, deletedRows: 2, remaining: false, retiredBeforeRound: 2 });
	expect(result.afterRetirement.frames.filter(oldDetail)).toHaveLength(0);
	expect(result.afterRetirement.floor).toBe(2);
	expect(result.afterRetirement.revision).toBe(result.beforeRetirement.revision + 1);
	expect(result.retirement.revision).toBe(result.afterRetirement.revision);
	expect(result.afterRetirement.safety).toBe(result.beforeRetirement.safety);
	expect(result.lateSignature).toBeUndefined();
	expect(result.lateError, "ORIGINAL_BOUND_REQUEST_MUST_REFUSE_NATIVE_FLOOR_NOT_ACTOR_ENTERED_ROUND").toEqual({
		name: "SigningAdmissionRefusal",
		message: "SIGNING_RETIRED",
		reason: "SIGNING_RETIRED",
	});
	expect(
		result.cryptoEntries.filter(({ phase }) => phase === "late"),
		"PERMANENT_FLOOR_MUST_REFUSE_BEFORE_ORIGINAL_CRYPTO_ENTRY"
	).toHaveLength(0);
	expect(result.afterLateSigning).toEqual(result.afterRetirement);
	expect(result.currentTuple).toMatchObject({
		kind: "drp-seal-vote",
		objectId: result.binding.objectId,
		epoch: result.binding.epoch,
		round: 2,
		phase: "prepare",
		signerId: result.binding.signerId,
	});
	expect(result.currentSignature).toMatch(/^[0-9a-f]{128}$/u);
	expect(result.currentVerified).toMatchObject({
		ok: true,
		objectId: result.binding.objectId,
		epoch: result.binding.epoch,
		phase: "prepare",
		round: 2,
		signerId: result.binding.signerId,
	});
	expect(result.cryptoEntries).toEqual([
		{
			phase: "current",
			sameOriginalPrototype: true,
			publicKey: result.binding.publicKey,
			digest: result.currentDigest,
		},
	]);
	expect(result.afterCurrentSigning).toEqual(result.afterRetirement);
});

// Same original producer and native owned launcher; this observer changes only
// the test schedule to hold a concrete native event before promise delivery.
for (const cut of ["first-delete-success", "native-complete-before-delivery"] as const)
	test(`genuine signing detail SIGKILL at ${cut} resumes untouched profile`, async ({ browserName }, info) => {
		const type = { chromium, firefox, webkit }[browserName];
		const executable = process.env[`RECIPIENT_OWNED_${browserName.toUpperCase()}_EXECUTABLE`];
		if (!executable) throw new Error("EXACT_ORIGINAL_NATIVE_EXECUTABLE_REQUIRED");
		const databaseName = `phase6-signing-death-${crypto.randomUUID()}`;
		const profile = info.outputPath("signing-profile");
		const raw: unknown[] = [],
			cleanup: unknown[] = [];
		let warm: Awaited<ReturnType<typeof launchOwned>> | undefined, sentinel: typeof warm, cold: typeof warm;
		let killed = false,
			primary: unknown;
		const launchRecord = (
			owner: NonNullable<typeof warm>
		): {
			root: number | undefined;
			browser: ReturnType<typeof publicProcessRecord>;
			profile: string;
			engine: string;
			executable: string;
		} => ({
			root: owner.processRecord.pid,
			browser: publicProcessRecord(owner.processRecord),
			profile: owner.profile,
			engine: owner.engine,
			executable: owner.executable,
		});
		try {
			sentinel = await launchOwned(type, info.outputPath("sentinel-profile"), executable, (receipt) =>
				raw.push(receipt)
			);
			warm = await launchOwned(type, profile, executable, (receipt) => raw.push(receipt));
			const sentinelPage = sentinel.context.pages()[0] ?? (await sentinel.context.newPage());
			const page = warm.context.pages()[0] ?? (await warm.context.newPage());
			await page.addInitScript(
				({ databaseName, cut, tables }) => {
					const snapshots = new WeakMap<IDBTransaction, Record<string, { keys?: IDBValidKey[]; rows?: unknown[] }>>();
					let before: Record<string, { keys?: IDBValidKey[]; rows?: unknown[] }> | undefined;
					let selected: IDBTransaction | undefined,
						signaled = false,
						deletes = 0;
					const checkpoint = (site: string): void => {
						if (signaled) return;
						const capturedBefore = before;
						if (!capturedBefore || tables.some((table) => !capturedBefore[table]?.keys || !capturedBefore[table]?.rows))
							throw new Error("EXACT_NATIVE_FIXTURE_BEFORE_IMAGE_REQUIRED");
						signaled = true;
						console.log(
							"R6_NATIVE_DEATH_CHECKPOINT:" +
								JSON.stringify({ site, before, deletes }, (_key, value) =>
									value instanceof Uint8Array ? { __signingUint8: Array.from(value) } : value
								)
						);
						// Bounded synchronous event hold. Native request/complete delegates
						// are unchanged; original-child SIGKILL must occur before expiry.
						const deadline = Date.now() + 15_000;
						while (Date.now() < deadline) {
							/* test-only native-event delivery hold */
						}
						console.error("R6_NATIVE_DEATH_HOLD_EXPIRED");
					};
					for (const method of ["getAll", "getAllKeys"] as const) {
						const original = IDBObjectStore.prototype[method];
						Reflect.set(
							IDBObjectStore.prototype,
							method,
							function (this: IDBObjectStore, ...args: unknown[]): IDBRequest<unknown[]> {
								const request = Reflect.apply(original, this, args) as IDBRequest<unknown[]>;
								if (
									this.transaction.db.name === databaseName &&
									this.transaction.mode === "readonly" &&
									args[1] === 65
								) {
									let image = snapshots.get(this.transaction);
									if (!image) {
										image = {};
										snapshots.set(this.transaction, image);
									}
									const captured = image,
										table = this.name;
									request.addEventListener(
										"success",
										() => {
											if (request.result.length > 64) throw new Error("ORIGINAL_FIXTURE_CAPTURE_BOUND");
											const row = (captured[table] ??= {});
											if (method === "getAll") row.rows = request.result;
											else row.keys = request.result as IDBValidKey[];
											if (tables.every((name) => captured[name]?.keys && captured[name]?.rows)) before = captured;
										},
										{ once: true }
									);
								}
								return request;
							}
						);
					}
					const originalDelete = IDBObjectStore.prototype.delete;
					IDBObjectStore.prototype.delete = function (key: IDBValidKey | IDBKeyRange): IDBRequest<undefined> {
						const request = originalDelete.call(this, key);
						if (
							this.transaction.db.name === databaseName &&
							(this.name === "voteSlots" || this.name === "voteOutbox")
						) {
							deletes++;
							if (!selected) {
								selected = this.transaction;
								if (cut === "native-complete-before-delivery")
									selected.addEventListener("complete", () => checkpoint(cut), { once: true });
								else request.addEventListener("success", () => checkpoint(cut), { once: true });
							}
						}
						return request;
					};
				},
				{ databaseName, cut, tables: QC_TRANSACTION_STORES }
			);
			let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
			const reached = new Promise<string>((resolveCheckpoint, reject) => {
				checkpointTimer = setTimeout(() => reject(new Error("NATIVE_DEATH_CHECKPOINT_UNREACHED")), 30_000);
				page.on("console", (message) => {
					if (message.text().startsWith("R6_NATIVE_DEATH_CHECKPOINT:")) resolveCheckpoint(message.text().slice(27));
					if (message.text().includes("R6_NATIVE_DEATH_HOLD_EXPIRED")) raw.push({ holdExpired: true });
				});
			});
			try {
				await page.goto(server?.origin ?? "about:blank");
				await page.evaluate((databaseName) => {
					void window.phase5dPacemaker.runAuthenticatedDetailRetirement(databaseName);
				}, databaseName);
				const checkpoint = JSON.parse(await reached, (_key, value) =>
					value && typeof value === "object" && Array.isArray(value.__signingUint8)
						? Uint8Array.from(value.__signingUint8)
						: value
				) as {
					site: string;
					deletes: number;
					before: Record<string, { keys: IDBValidKey[]; rows: unknown[] }>;
				};
				raw.push({ checkpoint });
				expect(checkpoint.site).toBe(cut);
				expect(checkpoint.deletes).toBe(cut === "first-delete-success" ? 1 : 2);
				const death = await killOwnedRecipient(warm, sentinel, (kind, value) => {
					raw.push({ kind, value });
					if (kind === "owned-native-signal-return" && (value as { returned: boolean }).returned) killed = true;
				});
				const senderResponsive = await sentinelPage.evaluate(() => ({ responsive: true }));
				raw.push({ death, senderResponsive });
				cold = await launchOwned(type, profile, executable, (receipt) => raw.push(receipt));
				checkOriginalChildDeath(launchRecord(sentinel), launchRecord(warm), launchRecord(cold), {
					...death,
					senderResponsive,
				});
				const coldPage = cold.context.pages()[0] ?? (await cold.context.newPage());
				await coldPage.goto(server?.origin ?? "about:blank");
				type CrashImage = {
					frames: { table: string; key: unknown; bytes: string }[];
					safety: string;
					revision: number;
					floor: number;
				};
				const resumed = (await coldPage.evaluate(
					(databaseName) => window.phase5dPacemaker.runColdDetailRetirementResume(databaseName),
					databaseName
				)) as {
					error?: unknown;
					beforeAnyOwner: CrashImage;
					reopened: unknown;
					afterRetirement: CrashImage;
					verifiedQc: { ok: boolean; round: number };
					futureVote: { ok: boolean };
					futurePublication: { sentKeys: unknown[] };
					cleanup: { status: string }[];
				};
				raw.push({ resumed });
				expect(resumed.error).toBeUndefined();
				const native = QC_TRANSACTION_STORES.flatMap((table) => {
					const captured = checkpoint.before[table];
					if (captured === undefined || captured.keys.length !== captured.rows.length)
						throw new Error("EXACT_NATIVE_TABLE_REQUIRED");
					return captured.keys.map((key, index) => ({
						table,
						key,
						row: captured.rows[index] as Record<string, unknown>,
					}));
				});
				const stateFrame = native.find((row) => row.table === "signerState");
				if (stateFrame === undefined) throw new Error("EXACT_NATIVE_SIGNER_STATE_REQUIRED");
				const state = stateFrame.row;
				const eligible = (frame: { table: string; key: unknown }): boolean =>
					(frame.table === "voteSlots" || frame.table === "voteOutbox") &&
					Array.isArray(frame.key) &&
					frame.key[2] === 0;
				expect(native.filter(eligible)).toHaveLength(2);
				const frame = ({
					table,
					key,
					row,
				}: (typeof native)[number]): { table: string; key: unknown; bytes: string } => ({
					table,
					key,
					bytes: Buffer.from(encodeCanonical([table, key, row])).toString("hex"),
				});
				const oldImage = {
					frames: native.map(frame),
					revision: state.revision,
					floor: 0,
					safety: Buffer.from(encodeCanonical({ ...state, revision: 0, retiredBeforeRound: 0 })).toString("hex"),
				};
				const newImage = {
					...oldImage,
					revision: Number(state.revision) + 1,
					floor: 2,
					frames: native
						.filter((row) => !eligible(row))
						.map((row) =>
							frame(
								row.table === "signerState"
									? { ...row, row: { ...row.row, revision: Number(state.revision) + 1, retiredBeforeRound: 2 } }
									: row
							)
						),
				};
				if (cut === "native-complete-before-delivery") expect(resumed.beforeAnyOwner).toEqual(newImage);
				else expect([oldImage, newImage]).toContainEqual(resumed.beforeAnyOwner);
				expect(resumed.reopened).toEqual(resumed.beforeAnyOwner);
				expect(resumed.afterRetirement.frames.filter(eligible)).toHaveLength(0);
				expect(resumed.afterRetirement.safety).toBe(oldImage.safety);
				expect(resumed.afterRetirement.floor).toBe(2);
				expect(resumed.verifiedQc).toMatchObject({ ok: true, round: 2 });
				expect(resumed.futureVote).toMatchObject({ ok: true });
				expect(resumed.futurePublication.sentKeys).toHaveLength(1);
				expect(resumed.cleanup).toHaveLength(4);
				expect(resumed.cleanup.every((row) => row.status === "fulfilled")).toBe(true);
			} finally {
				if (checkpointTimer) clearTimeout(checkpointTimer);
			}
		} catch (cause) {
			primary = cause;
		} finally {
			for (const [name, owner, expected] of [
				["cold", cold, "natural"],
				["warm", warm, killed ? "killed" : "natural"],
				["sentinel", sentinel, "natural"],
			] as const) {
				if (!owner) continue;
				const joined = await closeAndJoinOriginal(owner, expected);
				cleanup.push({ name, receipt: joined.receipt, ok: joined.ok });
				if (!joined.ok)
					primary =
						primary === undefined
							? joined.error
							: new AggregateError([primary, joined.error], "signing crash cleanup failed", { cause: primary });
			}
			await info.attach("native-signing-detail-death.json", {
				body: JSON.stringify({ cut, raw, cleanup, error: retainedError(primary) }, (_key, value) =>
					value instanceof Uint8Array ? { __signingUint8: Array.from(value) } : value
				),
				contentType: "application/json",
			});
		}
		if (primary !== undefined) throw primary;
	});

test("genuine voter joins atomic abort and cold 16 plus 2 lower-round detail batches with permanent late-work refusal", async ({
	page,
}, testInfo) => {
	await installTransactionObserver(page, true);
	await page.goto(server?.origin ?? "about:blank");
	type Frame = Readonly<{ table: string; key: unknown; bytes: string }>;
	type Image = Readonly<{ frames: readonly Frame[]; safety: string; revision: number; floor: number }>;
	type NativeResult = Readonly<{
		ok: boolean;
		reason?: string;
		deletedRows?: number;
		remaining?: boolean;
		retiredBeforeRound?: number;
		revision?: number;
	}>;
	type Transaction = Readonly<{
		mode: string;
		durability: string;
		stores: readonly string[];
		writtenStores: readonly string[];
		terminal: string;
	}>;
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runAuthenticatedDetailRetirementBatches(databaseName),
		`phase6-detail-batches-${crypto.randomUUID()}`
	)) as Readonly<{
		error?: unknown;
		progression: readonly Readonly<{
			round: number;
			vote: NativeResult;
			publication: Readonly<{ sentKeys: readonly string[] }>;
			verifiedQc?: Readonly<{ ok: boolean; round: number; phase: string }>;
			persistedQc?: NativeResult;
		}>[];
		verifiedQc9: Readonly<{ ok: boolean; round: number; phase: string }>;
		persistedQc9: NativeResult;
		verifiedLateVote: Readonly<{ ok: boolean; round: number; phase: string; signerId: string }>;
		verifiedLateRoundChange: Readonly<{ ok: boolean; round: number; highestPrepareQcRound: number; signerId: string }>;
		before: Image;
		afterAbort: Image;
		firstReopened: Image;
		afterFirst: Image;
		secondReopened: Image;
		afterSecond: Image;
		afterFuture: Image;
		abortedRetirement: NativeResult;
		foreignIntent: NativeResult;
		afterForeignIntent: Image;
		firstRetirement: NativeResult;
		secondRetirement: NativeResult;
		abortStatus: Readonly<{ terminal: boolean }>;
		abortDeleteCount: number;
		deleteCalls: readonly Readonly<{ phase: string; table: string; key: unknown }>[];
		abortTransactions: readonly Transaction[];
		firstTransactions: readonly Transaction[];
		secondTransactions: readonly Transaction[];
		negatives: readonly Readonly<{
			operation: string;
			result?: NativeResult;
			error?: Readonly<{ name: string; message: string }>;
			retiredScope?: NativeResult;
			futureScope?: NativeResult;
			expectedRevision?: number;
			expectedIncarnation?: string;
			before: Image;
			after: Image;
		}>[];
		futureVote: NativeResult;
		futurePublication: Readonly<{ sentKeys: readonly string[] }>;
		published: readonly string[];
		cleanup: readonly Readonly<{ name: string; status: string }>[];
	}>;
	await testInfo.attach("native-signing-detail-batches.json", {
		body: JSON.stringify({
			result,
			transactions: await page.evaluate(() => Reflect.get(window, "__phase5dTransactions")),
		}),
		contentType: "application/json",
	});
	expect(result.error).toBeUndefined();
	expect(result.cleanup).toHaveLength(10);
	expect(result.cleanup.every(({ status }) => status === "fulfilled")).toBe(true);
	expect(result.progression.map(({ round }) => round)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	for (const step of result.progression) {
		expect(step.vote).toMatchObject({ ok: true });
		expect(step.publication.sentKeys).toHaveLength(step.round + 1);
		if (step.round > 0) {
			expect(step.verifiedQc).toMatchObject({ ok: true, phase: "prepare", round: step.round });
			expect(step.persistedQc).toMatchObject({ ok: true });
		}
	}
	expect(result.verifiedQc9).toMatchObject({ ok: true, phase: "prepare", round: 9 });
	expect(result.persistedQc9).toMatchObject({ ok: true });
	expect(result.verifiedLateVote).toMatchObject({ ok: true, phase: "prepare", round: 0 });
	expect(result.verifiedLateRoundChange).toMatchObject({
		ok: true,
		round: 8,
		highestPrepareQcRound: 7,
		signerId: result.verifiedLateVote.signerId,
	});
	const lowerDetail = ({ table, key }: Frame): boolean =>
		(table === "voteSlots" || table === "voteOutbox") && Array.isArray(key) && typeof key[2] === "number" && key[2] < 9;
	expect(result.before.frames.filter(lowerDetail)).toHaveLength(18);
	expect(result.before.floor).toBe(0);
	expect(result.foreignIntent).toEqual({ ok: false, reason: "UNTRUSTED_DETAIL_RETIREMENT_INTENT" });
	expect(result.afterForeignIntent).toEqual(result.before);
	expect(result.abortDeleteCount).toBe(2);
	expect(result.abortedRetirement).toMatchObject({ ok: false, reason: "AMBIGUOUS_STORAGE_OUTCOME" });
	expect(result.abortStatus.terminal).toBe(true);
	expect(result.afterAbort, "SECOND_DELETE_ABORT_MUST_LEAVE_WHOLE_NATIVE_IMAGE_UNCHANGED").toEqual(result.before);
	expect(result.firstReopened).toEqual(result.before);
	expect(result.firstRetirement).toMatchObject({ ok: true, deletedRows: 16, remaining: true, retiredBeforeRound: 9 });
	expect(result.afterFirst.frames.filter(lowerDetail)).toHaveLength(2);
	expect(result.afterFirst.floor).toBe(9);
	expect(result.afterFirst.revision).toBe(result.before.revision + 1);
	expect(result.firstRetirement.revision).toBe(result.afterFirst.revision);
	expect(result.afterFirst.safety).toBe(result.before.safety);
	// Native point selection can split a genuine slot/outbox pair. The cold
	// original owner must authenticate its actual remaining rows, not infer
	// completion from disappearance of the partner or an old intent label.
	for (const frame of result.afterFirst.frames.filter(lowerDetail)) {
		expect(result.before.frames).toContainEqual(frame);
		const partner = frame.table === "voteSlots" ? "voteOutbox" : "voteSlots";
		expect(
			result.before.frames.some(
				(other) => other.table === partner && JSON.stringify(other.key) === JSON.stringify(frame.key)
			)
		).toBe(true);
		expect(
			result.afterFirst.frames.some(
				(other) => other.table === partner && JSON.stringify(other.key) === JSON.stringify(frame.key)
			)
		).toBe(false);
	}
	expect(result.secondReopened).toEqual(result.afterFirst);
	expect(result.secondRetirement).toMatchObject({ ok: true, deletedRows: 2, remaining: false, retiredBeforeRound: 9 });
	expect(
		result.afterSecond.frames.filter(lowerDetail),
		"AUTHENTICATED_EIGHTEEN_ROW_DETAIL_MUST_FINISH_IN_SIXTEEN_PLUS_TWO"
	).toHaveLength(0);
	expect(result.afterSecond.floor).toBe(9);
	expect(result.afterSecond.revision).toBe(result.afterFirst.revision + 1);
	expect(result.secondRetirement.revision).toBe(result.afterSecond.revision);
	expect(result.afterSecond.safety).toBe(result.before.safety);
	const protectedFrames = (image: Image): readonly Frame[] =>
		image.frames.filter((frame) => frame.table !== "signerState" && !lowerDetail(frame));
	expect(protectedFrames(result.afterFirst)).toEqual(protectedFrames(result.before));
	expect(protectedFrames(result.afterSecond)).toEqual(protectedFrames(result.before));
	for (const [phase, expected] of [
		["abort", 2],
		["first", 16],
		["second", 2],
	] as const) {
		const calls = result.deleteCalls.filter((call) => call.phase === phase);
		expect(calls).toHaveLength(expected);
		expect(new Set(calls.map(({ table, key }) => JSON.stringify([table, key]))).size).toBe(expected);
		const transactions =
			phase === "abort"
				? result.abortTransactions
				: phase === "first"
					? result.firstTransactions
					: result.secondTransactions;
		const writes = transactions.filter(
			({ mode, writtenStores }) =>
				mode === "readwrite" && writtenStores.some((name) => name === "voteSlots" || name === "voteOutbox")
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			durability: "strict",
			terminal: phase === "abort" ? "abort" : "complete",
			stores: QC_TRANSACTION_STORES,
		});
	}
	expect(result.negatives.map(({ operation }) => operation)).toEqual([
		"read-scope",
		"delayed-ack",
		"late-vote",
		"late-round-change",
	]);
	for (const negative of result.negatives) {
		expect(negative.before).toEqual(result.afterSecond);
		expect(negative.after, `PERMANENT_FLOOR_REFUSAL_MUST_NOT_WRITE:${negative.operation}`).toEqual(negative.before);
		if (negative.operation === "read-scope") {
			expect(negative.retiredScope).toEqual({ ok: false, reason: "SIGNING_RETIRED" });
			expect(negative.futureScope).toEqual({ ok: true });
		} else if (negative.operation === "delayed-ack") {
			expect(negative.error).toEqual({ name: "Error", message: "SIGNING_RETIRED" });
		} else {
			expect(negative.expectedRevision).toBe(result.afterSecond.revision);
			expect(negative.expectedIncarnation).toMatch(/^[0-9a-f]{32}$/u);
			expect(negative.result).toMatchObject({ ok: false, reason: "SIGNING_RETIRED" });
		}
	}
	expect(result.futureVote).toMatchObject({ ok: true });
	expect(result.futurePublication.sentKeys).toHaveLength(1);
	expect(
		result.afterFuture.frames.filter(
			({ table, key }) => (table === "voteSlots" || table === "voteOutbox") && Array.isArray(key) && key[2] === 9
		)
	).toHaveLength(2);
	expect(result.afterFuture.floor).toBe(9);
	expect(result.published).toHaveLength(10);
	expect(new Set(result.published).size).toBe(10);
});

test("genuine voter retires dispatched round-change detail without enabling old proposal justification", async ({
	page,
}, testInfo) => {
	await installTransactionObserver(page, true);
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runAuthenticatedRoundChangeRetirement(databaseName),
		`phase6-rc-detail-${crypto.randomUUID()}`
	)) as Readonly<{
		error?: unknown;
		verifiedQc0: Readonly<{ ok: boolean; phase: string; round: number }>;
		persistedQc0: Readonly<{ ok: boolean }>;
		roundChange1: Readonly<{ ok: boolean }>;
		verifiedQc2: Readonly<{ ok: boolean; phase: string; round: number }>;
		persistedQc2: Readonly<{ ok: boolean }>;
		publication: Readonly<{ sentKeys: readonly string[] }>;
		nativeRcKey: readonly unknown[];
		inlineRc: Readonly<{ exactCanonicalRoundChangeBytes: string; signature: string; qc0: string }>;
		inlineVerification: Readonly<{
			ok: boolean;
			round: number;
			highestPrepareQcRound: number;
			highestPrepareQcBytes: string;
		}>;
		before: Readonly<{
			frames: readonly Readonly<{ table: string; key: unknown; bytes: string }>[];
			safety: string;
			revision: number;
			floor: number;
		}>;
		after: Readonly<{
			frames: readonly Readonly<{ table: string; key: unknown; bytes: string }>[];
			safety: string;
			revision: number;
			floor: number;
		}>;
		reopened: unknown;
		retirement: Readonly<{
			ok: boolean;
			reason?: string;
			deletedRows?: number;
			remaining?: boolean;
			retiredBeforeRound?: number;
			revision?: number;
		}>;
		oldBundleVerification: Readonly<{ ok: boolean; round: number }>;
		mismatchedBundleVerification: Readonly<{ ok: boolean; reason: string }>;
		currentBundleVerification: Readonly<{ ok: boolean; round: number }>;
		coldBeforeAdmission: Readonly<{ enteredRound: number; pendingRoundChangeCount: number }>;
		oldProposalAdmission: Readonly<{ ok: boolean; reason: string }>;
		mismatchedProposalAdmission: Readonly<{ ok: boolean; reason: string }>;
		currentProposalAdmission: Readonly<{ ok: boolean }>;
		futurePublication: Readonly<{ sentKeys: readonly string[] }>;
		published: readonly string[];
		cleanup: readonly Readonly<{ name: string; status: string }>[];
	}>;
	await testInfo.attach("native-round-change-detail.json", {
		body: JSON.stringify({
			result,
			transactions: await page.evaluate(() => Reflect.get(window, "__phase5dTransactions")),
		}),
		contentType: "application/json",
	});
	expect(result.error).toBeUndefined();
	expect(result.cleanup).toEqual(
		[
			"voter",
			"pacemaker",
			"dispatch-store",
			"dispatcher",
			"cold-voter",
			"cold-pacemaker",
			"future-store",
			"future-dispatcher",
		].map((name) => ({ name, status: "fulfilled" }))
	);
	expect(result.verifiedQc0).toMatchObject({ ok: true, phase: "prepare", round: 0 });
	expect(result.persistedQc0).toMatchObject({ ok: true });
	expect(result.roundChange1).toMatchObject({ ok: true });
	expect(result.publication.sentKeys).toHaveLength(1);
	expect(result.verifiedQc2).toMatchObject({ ok: true, phase: "prepare", round: 2 });
	expect(result.persistedQc2).toMatchObject({ ok: true });
	const exactRc = ({ table, key }: Readonly<{ table: string; key: unknown }>): boolean =>
		(table === "voteSlots" || table === "voteOutbox") && JSON.stringify(key) === JSON.stringify(result.nativeRcKey);
	expect(
		result.before.frames
			.filter(exactRc)
			.map(({ table }) => table)
			.sort()
	).toEqual(["voteOutbox", "voteSlots"]);
	expect(result.before.floor).toBe(0);
	// The decisive oracle follows genuine QC/RC/publication setup; a baseline
	// ROUND_CHANGE_DEBT_HELD is recorded, not treated as successful retirement.
	expect(result.after.frames.filter(exactRc), "AUTHENTICATED_DISPATCHED_ROUND_CHANGE_DETAILS_MUST_RETIRE").toHaveLength(
		0
	);
	expect(result.retirement).toMatchObject({ ok: true, deletedRows: 2, remaining: false, retiredBeforeRound: 2 });
	expect(result.after.floor).toBe(2);
	expect(result.after.revision).toBe(result.before.revision + 1);
	expect(result.retirement.revision).toBe(result.after.revision);
	expect(result.after.safety).toBe(result.before.safety);
	const protectedFrames = (image: typeof result.before): readonly unknown[] =>
		image.frames.filter((frame) => frame.table !== "signerState" && !exactRc(frame));
	expect(protectedFrames(result.after)).toEqual(protectedFrames(result.before));
	expect(result.inlineRc.signature).toMatch(/^[0-9a-f]{128}$/u);
	expect(result.inlineVerification).toMatchObject({ ok: true, round: 1, highestPrepareQcRound: 0 });
	expect(result.inlineVerification.highestPrepareQcBytes).toBe(result.inlineRc.qc0);
	expect(result.oldBundleVerification).toMatchObject({ ok: true, round: 1 });
	expect(result.mismatchedBundleVerification).toEqual({ ok: false, reason: "new-round-certificate-conflict" });
	expect(result.currentBundleVerification).toMatchObject({ ok: true, round: 2 });
	expect(result.reopened).toEqual(result.after);
	expect(result.coldBeforeAdmission.enteredRound).toBe(2);
	expect(result.coldBeforeAdmission.pendingRoundChangeCount).toBe(0);
	expect(result.oldProposalAdmission).toEqual({ ok: false, reason: "STALE_ROUND" });
	expect(result.mismatchedProposalAdmission).toEqual({ ok: false, reason: "new-round-certificate-conflict" });
	expect(result.currentProposalAdmission).toEqual({ ok: true });
	expect(result.futurePublication.sentKeys).toHaveLength(1);
	expect(result.published).toHaveLength(2);
	expect(new Set(result.published).size).toBe(2);
});

test("original publisher native custody refuses undispatched retirement debt and joins close before foreign ACK and fresh retirement", async ({
	page,
}, testInfo) => {
	await installTransactionObserver(page, true);
	await page.goto(server?.origin ?? "about:blank");
	type Frame = Readonly<{ table: string; key: unknown; bytes: string }>;
	type Image = Readonly<{ frames: readonly Frame[]; safety: string; revision: number; floor: number }>;
	type Checkpoint = Readonly<{ index: number; kind: string }>;
	type Status = Readonly<{
		publisherSettled: boolean;
		ackSettled: boolean;
		ackWrites: number;
		heldTerminal?: string;
		ackTerminal?: string;
		dispatcherClosed: boolean;
		storeClosed: boolean;
		publicationCalls: number;
	}>;
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runPublicationDebtCustody(databaseName),
		`phase6-publication-custody-${crypto.randomUUID()}`
	)) as Readonly<{
		error?: unknown;
		unexpectedAdmission?: boolean;
		vote0: Readonly<{ ok: boolean }>;
		verifiedQc2: Readonly<{ ok: boolean; phase: string; round: number }>;
		persistedQc2: Readonly<{ ok: boolean }>;
		originalCarrier: Readonly<{
			ok: boolean;
			epoch: number;
			round: number;
			phase: string;
			signerId: string;
			objectId: string;
		}>;
		originalKey: readonly [string, number, number, string, string];
		beforeDebt: Image;
		afterDebt: Image;
		expectedAfterAck: Image;
		afterJoinedPublication: Image;
		afterRetirement: Image;
		afterFuture: Image;
		debtRetirement: Readonly<{ ok: boolean; reason: string }>;
		freshRetirement: Readonly<{
			ok: boolean;
			deletedRows: number;
			remaining: boolean;
			retiredBeforeRound: number;
			revision: number;
		}>;
		heldTransaction: Readonly<{ databaseName: string; mode: string; stores: readonly string[] }>;
		foreignTransaction: Readonly<{
			databaseName: string;
			mode: string;
			durability: string;
			stores: readonly string[];
			differentConnection: boolean;
		}>;
		heldCheckpoint: Status;
		joined: Status;
		newAdmissionError: Readonly<{ name: string; message: string }>;
		originalDrain: Readonly<{ sentKeys: readonly string[] }>;
		closedDrain: Readonly<{ sentKeys: readonly string[] }>;
		futureVote: Readonly<{ ok: boolean }>;
		futurePublication: Readonly<{ sentKeys: readonly string[] }>;
		published: readonly string[];
		checkpoints: readonly Checkpoint[];
		taskJoins: readonly Readonly<{ status: string }>[];
		cleanup: readonly Readonly<{ name: string; status: string }>[];
	}>;
	await testInfo.attach("native-publication-debt-custody.json", {
		body: JSON.stringify({
			result,
			transactions: await page.evaluate(() => Reflect.get(window, "__phase5dTransactions")),
		}),
		contentType: "application/json",
	});
	expect(result.error).toBeUndefined();
	expect(result.cleanup).toHaveLength(9);
	expect(result.cleanup.every(({ status }) => status === "fulfilled")).toBe(true);
	expect(result.taskJoins).toHaveLength(5);
	expect(result.taskJoins.every(({ status }) => status === "fulfilled")).toBe(true);
	expect(result.vote0).toMatchObject({ ok: true });
	expect(result.verifiedQc2).toMatchObject({ ok: true, phase: "prepare", round: 2 });
	expect(result.persistedQc2).toMatchObject({ ok: true });
	expect(result.originalCarrier).toMatchObject({
		ok: true,
		objectId: result.originalKey[0],
		epoch: result.originalKey[1],
		round: result.originalKey[2],
		phase: result.originalKey[3],
		signerId: result.originalKey[4],
	});
	expect(result.originalKey.slice(1, 4)).toEqual([0, 0, "prepare"]);
	expect(result.debtRetirement).toEqual({ ok: false, reason: "PUBLICATION_DEBT_HELD" });
	expect(result.afterDebt, "UNDISPATCHED_ORIGINAL_OUTBOX_MUST_REFUSE_WITHOUT_ANY_NATIVE_WRITE").toEqual(
		result.beforeDebt
	);
	expect(result.beforeDebt.floor).toBe(0);
	expect(result.heldTransaction).toMatchObject({ mode: "readonly", stores: QC_TRANSACTION_STORES });
	expect(result.foreignTransaction).toEqual({
		databaseName: result.heldTransaction.databaseName,
		mode: "readwrite",
		durability: "strict",
		stores: QC_TRANSACTION_STORES,
		differentConnection: true,
	});
	expect(result.unexpectedAdmission).toBeUndefined();
	expect(result.newAdmissionError).toEqual({ name: "Error", message: "STORE_CLOSED" });
	expect(
		result.heldCheckpoint,
		"ACTUAL_HELD_NATIVE_SUCCESS_MUST_OBSERVE_FOREIGN_RW_BLOCKED_UNTIL_PUBLISHER_SETTLES"
	).toEqual({
		publisherSettled: false,
		ackSettled: false,
		ackWrites: 0,
		dispatcherClosed: false,
		storeClosed: false,
		publicationCalls: 1,
	});
	expect(result.joined).toEqual({
		publisherSettled: true,
		ackSettled: true,
		ackWrites: 1,
		heldTerminal: "complete",
		ackTerminal: "complete",
		dispatcherClosed: true,
		storeClosed: true,
		publicationCalls: 1,
	});
	const at = (kind: string): number => {
		const matching = result.checkpoints.filter((checkpoint) => checkpoint.kind === kind);
		expect(matching, `EXACT_ORIGINAL_CHECKPOINT:${kind}`).toHaveLength(1);
		const checkpoint = matching[0];
		if (checkpoint === undefined) throw new Error(`ORIGINAL_CHECKPOINT_MISSING:${kind}`);
		return checkpoint.index;
	};
	expect(at("publisher-entered")).toBeLessThan(at("foreign-ack-transaction-created"));
	expect(at("foreign-ack-transaction-created")).toBeLessThan(at("store-close-invoked"));
	expect(at("store-close-invoked")).toBeLessThan(at("new-admission-refused"));
	expect(at("new-admission-refused")).toBeLessThan(at("held-native-success-before-release"));
	expect(at("held-native-success-before-release")).toBeLessThan(at("publisher-gate-release"));
	expect(at("publisher-gate-release")).toBeLessThan(at("publisher-settled"));
	expect(at("publisher-settled")).toBeLessThan(at("held-native-complete"));
	expect(at("held-native-complete")).toBeLessThan(at("foreign-ack-put"));
	expect(at("foreign-ack-put")).toBeLessThan(at("foreign-ack-put-success"));
	expect(at("foreign-ack-put-success")).toBeLessThan(at("foreign-ack-complete"));
	expect(at("foreign-ack-complete")).toBeLessThan(at("foreign-ack-joined"));
	expect(at("publisher-settled")).toBeLessThan(at("dispatcher-close-joined"));
	expect(at("held-native-complete")).toBeLessThan(at("store-close-joined"));
	expect(result.originalDrain.sentKeys).toHaveLength(0);
	expect(result.closedDrain.sentKeys).toHaveLength(0);
	expect(result.afterJoinedPublication, "ONLY_ORIGINAL_DISPATCHED_BIT_MAY_CHANGE_AFTER_JOINED_FOREIGN_ACK").toEqual(
		result.expectedAfterAck
	);
	const oldDetail = ({ table, key }: Frame): boolean =>
		(table === "voteSlots" || table === "voteOutbox") && Array.isArray(key) && key[2] === 0;
	expect(result.afterJoinedPublication.frames.filter(oldDetail)).toHaveLength(2);
	expect(result.freshRetirement).toMatchObject({ ok: true, deletedRows: 2, remaining: false, retiredBeforeRound: 2 });
	expect(result.afterRetirement.frames.filter(oldDetail)).toHaveLength(0);
	expect(result.afterRetirement.floor).toBe(2);
	expect(result.afterRetirement.revision).toBe(result.afterJoinedPublication.revision + 1);
	expect(result.freshRetirement.revision).toBe(result.afterRetirement.revision);
	expect(result.afterRetirement.safety).toBe(result.afterJoinedPublication.safety);
	const protectedFrames = (image: Image): readonly Frame[] =>
		image.frames.filter((frame) => frame.table !== "signerState" && !oldDetail(frame));
	expect(protectedFrames(result.afterRetirement)).toEqual(protectedFrames(result.afterJoinedPublication));
	expect(result.futureVote).toMatchObject({ ok: true });
	expect(result.futurePublication.sentKeys).toHaveLength(1);
	expect(result.afterFuture.floor).toBe(2);
	expect(result.published).toHaveLength(2);
	expect(new Set(result.published).size).toBe(2);
});
test("genuine final QC limits detail retirement and stale native currency refuses without effects", async ({
	page,
}, testInfo) => {
	await installTransactionObserver(page, true);
	await page.goto(server?.origin ?? "about:blank");
	type Frame = Readonly<{ table: string; key: unknown; bytes: string }>;
	type Image = Readonly<{ frames: readonly Frame[]; safety: string; revision: number; floor: number }>;
	type Transaction = Readonly<{ mode: string; terminal?: string; durability: string; stores: readonly string[] }>;
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runFinalQcMinimumRetirement(databaseName),
		`phase6-final-qc-minimum-${crypto.randomUUID()}`
	)) as Readonly<{
		error?: unknown;
		vote0: Readonly<{ ok: boolean }>;
		vote1: Readonly<{ ok: boolean }>;
		publication0: Readonly<{ sentKeys: readonly string[] }>;
		publication1: Readonly<{ sentKeys: readonly string[] }>;
		verifiedPrepare1: Readonly<{ ok: boolean; phase: string; round: number }>;
		verifiedPrepare2: Readonly<{ ok: boolean; phase: string; round: number }>;
		verifiedPrepare3: Readonly<{ ok: boolean; phase: string; round: number }>;
		verifiedCommit1: Readonly<{ ok: boolean; phase: string; round: number }>;
		persistedPrepare1: Readonly<{ ok: boolean }>;
		persistedPrepare2: Readonly<{ ok: boolean }>;
		persistedPrepare3: Readonly<{ ok: boolean }>;
		persistedCommit1: Readonly<{ ok: boolean }>;
		capture: Readonly<{
			objectId: string;
			expectedRevision: number;
			expectedIncarnation: string;
			imageDigest: string;
			enteredRound: number;
			highestPrepareQcBytes: string;
			finalizedCommitQcBytes: string;
			frames: readonly string[];
			presentFrames: readonly string[];
			absentFrames: readonly string[];
		}>;
		captureReleaseJoined: boolean;
		negatives: readonly Readonly<{
			operation: string;
			result: Readonly<{ ok: boolean; reason: string }>;
			before: Image;
			after: Image;
			transactions: readonly Transaction[];
		}>[];
		afterHigherQc: Image;
		before: Image;
		after: Image;
		reopened: Image;
		retirement: Readonly<{
			ok: boolean;
			reason?: string;
			deletedRows?: number;
			remaining?: boolean;
			retiredBeforeRound?: number;
			revision?: number;
		}>;
		retirementTransactions: readonly Transaction[];
		coldStatus: Readonly<{ enteredRound: number; terminal: boolean; finalizedValueDigest: string | null }>;
		coldQcBytes: Readonly<{ prepare: string; commit: string; expectedPrepare: string; expectedCommit: string }>;
		coldPrepareVerified: Readonly<{ ok: boolean; phase: string; round: number }>;
		coldCommitVerified: Readonly<{ ok: boolean; phase: string; round: number }>;
		published: readonly string[];
		cleanup: readonly Readonly<{ name: string; status: string }>[];
	}>;
	await testInfo.attach("native-final-qc-minimum.json", {
		body: JSON.stringify({
			result,
			transactions: await page.evaluate(() => Reflect.get(window, "__phase5dTransactions")),
		}),
		contentType: "application/json",
	});
	expect(result.error).toBeUndefined();
	expect(result.cleanup).toEqual(
		["voter", "pacemaker", "dispatch-store", "dispatcher", "cold-voter", "cold-pacemaker"].map((name) => ({
			name,
			status: "fulfilled",
		}))
	);
	expect(result.vote0).toMatchObject({ ok: true });
	expect(result.vote1).toMatchObject({ ok: true });
	expect(result.publication0.sentKeys).toHaveLength(1);
	expect(result.publication1.sentKeys).toHaveLength(2);
	expect(result.published).toHaveLength(2);
	expect(new Set(result.published).size).toBe(2);
	for (const [round, verified, persisted] of [
		[1, result.verifiedPrepare1, result.persistedPrepare1],
		[2, result.verifiedPrepare2, result.persistedPrepare2],
		[3, result.verifiedPrepare3, result.persistedPrepare3],
	] as const) {
		expect(verified).toMatchObject({ ok: true, phase: "prepare", round });
		expect(persisted).toMatchObject({ ok: true });
	}
	expect(result.verifiedCommit1).toMatchObject({ ok: true, phase: "commit", round: 1 });
	expect(result.persistedCommit1).toMatchObject({ ok: true });
	expect(result.captureReleaseJoined).toBe(true);
	expect(result.capture).toMatchObject({ enteredRound: 2 });
	expect(result.capture.expectedIncarnation).toMatch(/^[0-9a-f]{32}$/u);
	expect(result.capture.imageDigest).toMatch(/^[0-9a-f]{64}$/u);
	expect(result.capture.highestPrepareQcBytes).toMatch(/^[0-9a-f]+$/u);
	expect(result.capture.finalizedCommitQcBytes).toBe(result.coldQcBytes.commit);
	// The original held scanner commits metadata absence explicitly; the raw
	// whole-nine-table helper lists present rows only. Validate both exactly.
	const canonicalHex = (value: unknown): string =>
		Array.from(encodeCanonical(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
	expect([...result.capture.absentFrames].sort()).toEqual(
		[
			canonicalHex(["storageMeta", `ahe-retirement:${result.capture.objectId}`, null]),
			canonicalHex(["storageMeta", `signing-retirement:${result.capture.objectId}`, null]),
		].sort()
	);
	expect([...result.capture.frames].sort()).toEqual(
		[...result.capture.presentFrames, ...result.capture.absentFrames].sort()
	);
	expect(result.negatives.map((item) => item.operation)).toEqual([
		"wrong-incarnation",
		"wrong-revision",
		"wrong-image",
		"captured-before-higher-qc",
	]);
	for (const negative of result.negatives) {
		expect(negative.result).toEqual({
			ok: false,
			reason: negative.operation === "wrong-incarnation" ? "STORAGE_LOSS" : "REVALIDATION_REQUIRED",
		});
		expect(negative.after, `STALE_NATIVE_REQUEST_HAS_NO_EFFECT:${negative.operation}`).toEqual(negative.before);
		const writes = negative.transactions.filter((transaction) => transaction.mode === "readwrite");
		if (negative.operation === "wrong-incarnation") expect(writes).toHaveLength(0);
		else {
			expect(writes).toHaveLength(1);
			expect(writes[0]).toMatchObject({ terminal: "abort", durability: "strict", stores: QC_TRANSACTION_STORES });
		}
		if (negative.operation === "captured-before-higher-qc") {
			expect(negative.before).toEqual(result.afterHigherQc);
			expect(negative.before.revision).toBe(result.capture.expectedRevision + 1);
		} else
			expect(negative.before.frames.map((frame) => frame.bytes).sort()).toEqual(
				[...result.capture.presentFrames].sort()
			);
	}
	expect(result.before).toEqual(result.afterHigherQc);
	const roundDetail =
		(round: number) =>
		({ table, key }: Frame): boolean =>
			(table === "voteSlots" || table === "voteOutbox") &&
			Array.isArray(key) &&
			key[2] === round &&
			key[3] === "prepare";
	expect(result.before.frames.filter(roundDetail(0))).toHaveLength(2);
	expect(result.before.frames.filter(roundDetail(1))).toHaveLength(2);
	// Genuine min(final1, highest3, entered3) is1, never the highest-QC round.
	expect(result.retirement).toEqual({
		ok: true,
		deletedRows: 2,
		remaining: false,
		retiredBeforeRound: 1,
		revision: result.before.revision + 1,
	});
	expect(result.after.frames.filter(roundDetail(0))).toHaveLength(0);
	expect(result.after.frames.filter(roundDetail(1))).toEqual(result.before.frames.filter(roundDetail(1)));
	expect(result.after.floor).toBe(1);
	expect(result.after.revision).toBe(result.before.revision + 1);
	expect(result.after.safety).toBe(result.before.safety);
	const protectedFrames = (image: Image): readonly Frame[] =>
		image.frames.filter((frame) => frame.table !== "signerState" && !roundDetail(0)(frame));
	expect(protectedFrames(result.after)).toEqual(protectedFrames(result.before));
	const retirementWrites = result.retirementTransactions.filter((transaction) => transaction.mode === "readwrite");
	expect(retirementWrites).toHaveLength(1);
	expect(retirementWrites[0]).toMatchObject({
		terminal: "complete",
		durability: "strict",
		stores: QC_TRANSACTION_STORES,
	});
	expect(result.reopened).toEqual(result.after);
	expect(result.coldStatus).toMatchObject({ enteredRound: 3, terminal: false });
	expect(result.coldStatus.finalizedValueDigest).toMatch(/^[0-9a-f]{64}$/u);
	expect(result.coldQcBytes.prepare).toBe(result.coldQcBytes.expectedPrepare);
	expect(result.coldQcBytes.commit).toBe(result.coldQcBytes.expectedCommit);
	expect(result.coldPrepareVerified).toMatchObject({ ok: true, phase: "prepare", round: 3 });
	expect(result.coldCommitVerified).toMatchObject({ ok: true, phase: "commit", round: 1 });
});
test("original pre-opened voter refuses retired QC restoration and stale current work after physical deletion", async ({
	page,
}, testInfo) => {
	await installTransactionObserver(page, true);
	await page.goto(server?.origin ?? "about:blank");
	type Frame = Readonly<{ table: string; key: unknown; bytes: string }>;
	type Image = Readonly<{ frames: readonly Frame[]; safety: string; revision: number; floor: number }>;
	type Status = Readonly<{ enteredRound: number; revision: number; terminal: boolean; highestPrepareQcBytes: unknown }>;
	type Transaction = Readonly<{ mode: string; terminal?: string; durability: string; stores: readonly string[] }>;
	const result = (await page.evaluate(
		(databaseName) => window.phase5dPacemaker.runStaleHandleDetailRestore(databaseName),
		`phase6-stale-live-restore-${crypto.randomUUID()}`
	)) as Readonly<{
		error?: unknown;
		vote0: Readonly<{ ok: boolean }>;
		publication0: Readonly<{ sentKeys: readonly string[] }>;
		oldStatus: Status;
		currentStatus: Status;
		coldStatus: Status;
		oldIncarnation: string;
		coldIncarnation: string;
		verifiedRestoreQc0: Readonly<{ ok: boolean; phase: string; round: number }>;
		verifiedQc2: Readonly<{ ok: boolean; phase: string; round: number }>;
		persistedQc2: Readonly<{ ok: boolean }>;
		before: Image;
		after: Image;
		afterOldSnapshot: Image;
		reopened: Image;
		afterFuture: Image;
		retirement: Readonly<{
			ok: boolean;
			deletedRows: number;
			remaining: boolean;
			retiredBeforeRound: number;
			revision: number;
		}>;
		negatives: readonly Readonly<{
			operation: string;
			result: Readonly<{ ok: boolean; reason: string }>;
			before: Image;
			after: Image;
			statusBefore: Status;
			statusAfter: Status;
			transactions: readonly Transaction[];
		}>[];
		oldNativeSnapshot: Readonly<{
			incarnation: string;
			revision: number;
			enteredRound: number;
			retiredBeforeRound: number;
			highestPrepareQcBytes: string;
		}>;
		expectedQc2: string;
		futureVote: Readonly<{ ok: boolean }>;
		futurePublication: Readonly<{ sentKeys: readonly string[] }>;
		published: readonly string[];
		cleanup: readonly Readonly<{ name: string; status: string }>[];
	}>;
	await testInfo.attach("native-stale-handle-restore.json", {
		body: JSON.stringify({
			result,
			transactions: await page.evaluate(() => Reflect.get(window, "__phase5dTransactions")),
		}),
		contentType: "application/json",
	});
	expect(result.error).toBeUndefined();
	expect(result.cleanup).toEqual(
		[
			"old-voter",
			"old-pacemaker",
			"old-native-store",
			"dispatcher",
			"current-voter",
			"current-pacemaker",
			"cold-voter",
			"cold-pacemaker",
			"future-store",
			"future-dispatcher",
		].map((name) => ({ name, status: "fulfilled" }))
	);
	expect(result.vote0).toMatchObject({ ok: true });
	expect(result.publication0.sentKeys).toHaveLength(1);
	expect(result.oldStatus).toMatchObject({ enteredRound: 0, revision: 1, terminal: false });
	expect(result.oldStatus.highestPrepareQcBytes).toBeNull();
	expect(result.verifiedRestoreQc0).toMatchObject({ ok: true, phase: "prepare", round: 0 });
	expect(result.verifiedQc2).toMatchObject({ ok: true, phase: "prepare", round: 2 });
	expect(result.persistedQc2).toMatchObject({ ok: true });
	const detail =
		(round: number) =>
		({ table, key }: Frame): boolean =>
			(table === "voteSlots" || table === "voteOutbox") &&
			Array.isArray(key) &&
			key[2] === round &&
			key[3] === "prepare";
	expect(result.before.frames.filter(detail(0))).toHaveLength(2);
	expect(result.retirement).toEqual({
		ok: true,
		deletedRows: 2,
		remaining: false,
		retiredBeforeRound: 2,
		revision: result.before.revision + 1,
	});
	expect(result.after.frames.filter(detail(0))).toHaveLength(0);
	expect(result.after.floor).toBe(2);
	expect(result.after.revision).toBe(result.before.revision + 1);
	expect(result.after.safety).toBe(result.before.safety);
	const protectedFrames = (image: Image): readonly Frame[] =>
		image.frames.filter((frame) => frame.table !== "signerState" && !detail(0)(frame));
	expect(protectedFrames(result.after)).toEqual(protectedFrames(result.before));
	expect(result.currentStatus).toMatchObject({ enteredRound: 2, revision: result.after.revision, terminal: false });
	expect(result.negatives.map((item) => item.operation)).toEqual([
		"restore-retired-qc0",
		"stale-current-qc2",
		"old-live-vote0",
	]);
	for (const negative of result.negatives) {
		expect(negative.result).toEqual({
			ok: false,
			reason: negative.operation === "stale-current-qc2" ? "REVALIDATION_REQUIRED" : "SIGNING_RETIRED",
		});
		expect(negative.statusBefore).toEqual(result.oldStatus);
		expect(negative.statusAfter, `OLD_HANDLE_REFUSAL_DOES_NOT_REFRESH_OR_TERMINALIZE:${negative.operation}`).toEqual(
			result.oldStatus
		);
		expect(negative.before).toEqual(result.after);
		expect(negative.after, `DELAYED_RESTORE_DOES_NOT_RESURRECT:${negative.operation}`).toEqual(result.after);
		const writes = negative.transactions.filter((transaction) => transaction.mode === "readwrite");
		if (negative.operation === "old-live-vote0") expect(writes).toHaveLength(0);
		else {
			expect(writes).toHaveLength(1);
			expect(writes[0]).toMatchObject({ terminal: "abort", durability: "strict", stores: QC_TRANSACTION_STORES });
		}
	}
	// A pre-opened native connection observes actual post-drain state, not the
	// old voter's cached summary. Its read does not replace a native reservation.
	expect(result.oldNativeSnapshot).toEqual({
		incarnation: result.oldIncarnation,
		revision: result.after.revision,
		enteredRound: 2,
		retiredBeforeRound: 2,
		highestPrepareQcBytes: result.expectedQc2,
	});
	expect(result.afterOldSnapshot).toEqual(result.after);
	expect(result.reopened).toEqual(result.after);
	expect(result.coldIncarnation).toBe(result.oldIncarnation);
	expect(result.coldStatus).toEqual(result.currentStatus);
	expect(result.futureVote).toMatchObject({ ok: true });
	expect(result.futurePublication.sentKeys).toHaveLength(1);
	expect(result.afterFuture.frames.filter(detail(0))).toHaveLength(0);
	expect(result.afterFuture.frames.filter(detail(2))).toHaveLength(2);
	expect(result.afterFuture.floor).toBe(2);
	expect(result.afterFuture.revision).toBe(result.after.revision + 1);
	expect(result.afterFuture.frames.filter((frame) => frame.table !== "signerState" && !detail(2)(frame))).toEqual(
		result.after.frames.filter((frame) => frame.table !== "signerState")
	);
	expect(result.published).toHaveLength(2);
	expect(new Set(result.published).size).toBe(2);
});

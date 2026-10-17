import { expect, type Page, test } from "@playwright/test";
import type { LiveJournalPageResult, LiveJournalReadinessResult } from "@ts-drp/live-journal";

import { type P4AssetServer, startP4AssetServer } from "./fixtures/phase-3a1b-p4-asset-server.js";
import {
	P4_BROWSER_DEATH_TUPLES,
	P4_BROWSER_METHODS,
	P4_BROWSER_NO_WRITE_DEATH_TUPLES,
	P4_BROWSER_SCHEMA,
} from "./fixtures/phase-3a1b-p4-browser-contract.js";

let server: P4AssetServer;
type SuccessfulPage = Extract<LiveJournalPageResult, { readonly ok: true }>;
type PageRead = {
	readonly rows: number;
	readonly bytes: number;
	readonly count: number | null;
	readonly transaction: number;
};
type MeasuredPage = { readonly value: SuccessfulPage; readonly reads: readonly PageRead[] };

test.beforeAll(async () => {
	const directory = process.env.PHASE_3A1B_P4_BROWSER_ASSET_DIR;
	if (directory === undefined) throw new TypeError("p4 browser global setup did not install assets");
	server = await startP4AssetServer(directory);
});

test.afterAll(async () => server.close());

async function runCase(
	page: Page,
	caseId:
		| "concurrency"
		| "decision-mutants"
		| "duplicates"
		| "faults"
		| "interleaving"
		| "lifecycle"
		| "persisted-shapes"
		| "strict-downgrade"
		| "surface-schema"
		| "reserved-page-bound"
		| "reserved-page-foreign"
		| "reserved-page-lifetime"
		| "reserved-page-poison"
		| "reserved-readiness-reuse"
		| "reserved-readiness-scopes"
		| "incremental-replay-validation"
		| "closed-membership-after-drain"
		| "reserved-retirement-reuse"
		| "reserved-retirement-abort"
		| "reserved-retirement-admission"
		| "reserved-retirement-current-probe",
	asset = "phase-3a1b-p4.html"
): Promise<Record<string, unknown>> {
	const url = server.issueTransitionURL(asset);
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase3a1bP4Run === "function");
		return (await page.evaluate((id) => window.phase3a1bP4Run(id), caseId)) as Record<string, unknown>;
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
}

type RetirementMeasurement = {
	value: {ok: boolean; kind?: string; value?: {image: {rowCount: number}}};
	cursors: {scopes: number; acceptedEntries: number}; getKeyInvocations: number; transactions: number[];
};
const retirementScan = {scopes: 1, acceptedEntries: 1};
const noRetirementScan = {scopes: 0, acceptedEntries: 0};

test("reuses only the exact held native retirement book with detached bytes and fresh currency", async ({page}) => {
	const result = await runCase(page, "reserved-retirement-reuse");
	const first = result.first as Pick<RetirementMeasurement, "cursors" | "transactions">;
	const repeated = result.repeated as RetirementMeasurement, during = result.duringForeign as RetirementMeasurement;
	const foreign = result.foreignFacade as RetirementMeasurement, wrong = result.wrongObject as RetirementMeasurement;
	const recaptured = result.recaptured as RetirementMeasurement, ordinary = result.ordinary as RetirementMeasurement;
	const replacement = result.replacement as RetirementMeasurement, replacementRepeat = result.replacementRepeat as RetirementMeasurement;
	expect(first.cursors).toEqual(retirementScan);
	for (const value of [repeated, during, replacementRepeat]) {
		expect(value.value.ok).toBe(true); expect(value.cursors).toEqual(noRetirementScan);
		expect(value.getKeyInvocations).toBeGreaterThan(0); // Original native fence; includes keeper invocations, not just checks.
	}
	expect(repeated.transactions).toEqual(first.transactions); expect(during.transactions).toEqual(first.transactions);
	expect(foreign.cursors).toEqual(retirementScan); expect(foreign.transactions).not.toEqual(first.transactions);
	expect(wrong.value).toEqual({ok: false, kind: "not-installed"}); expect(wrong.cursors).toEqual(retirementScan);
	expect(recaptured.cursors).toEqual(retirementScan); expect(recaptured.transactions).toEqual(first.transactions);
	expect(result.isolated).toBe(true); expect(result.excluded).toBe(true);
	expect(result.appended).toMatchObject({ok: true});
	for (const key of ["revokedQueued", "afterRevocation", "closedQueued", "afterClose"]) expect(result[key]).toMatchObject({ok: false});
	expect(result.afterClose).toEqual({ok: false, kind: "store-closed"});
	for (const value of [ordinary, replacement]) {
		expect(value.value).toMatchObject({ok: true, value: {image: {rowCount: 5}}}); expect(value.cursors).toEqual(retirementScan);
		expect(value.transactions).not.toEqual(first.transactions);
	}
	expect(replacementRepeat.transactions).toEqual(replacement.transactions);
});

test("revokes a captured retirement basis when the original native transaction aborts", async ({page}) => {
	const result = await runCase(page, "reserved-retirement-abort"), after = result.afterAbort as RetirementMeasurement;
	expect(result.checkRejected).toBe(true); expect(result.releaseRejected).toBe(true);
	expect(result.probeAfterAbort).toMatchObject({ok: false});
	expect(after.value).toMatchObject({ok: false}); expect(after.cursors).toEqual(noRetirementScan);
});

test("readmits new retirement books through original corruption and native quota failures", async ({page}) => {
	const result = await runCase(page, "reserved-retirement-admission");
	for (const fate of ["control-corruption", "native-byte-quota"]) {
		const value = result[fate] as {ordinary: RetirementMeasurement; fresh: RetirementMeasurement; repeated: RetirementMeasurement};
		expect(value.ordinary.value).toEqual({ok: false,
			kind: fate === "native-byte-quota" ? "retirement-fenced" : "substrate-failure"});
		for (const attempt of [value.fresh, value.repeated]) {
			expect(attempt.value).toEqual(value.ordinary.value); expect(attempt.cursors).toEqual(retirementScan);
		}
		expect(value.fresh.transactions).not.toEqual(value.ordinary.transactions);
		expect(value.repeated.transactions).toEqual(value.fresh.transactions);
	}
	const poisoned = result["poisoned-facade"] as {readiness: unknown; after: RetirementMeasurement; probeAfterPoison: unknown};
	expect(poisoned.readiness).toEqual({ok: false, kind: "store-poisoned"});
	expect(poisoned.probeAfterPoison).toEqual(poisoned.readiness);
	expect(poisoned.after.value).toEqual(poisoned.readiness); expect(poisoned.after.cursors).toEqual(noRetirementScan);
});

test("probes the genuine held retirement basis without rematerialization or copied authority", async ({page}) => {
	const result = await runCase(page, "reserved-retirement-current-probe"), first = result.first as RetirementMeasurement;
	for (const key of ["producerFrozen", "copiedObservationRefused", "forgedObservationRefused", "wrongProducerReceiverRefused",
		"consumedEnrollmentRefused", "mutatedObservationRefused", "excluded", "wrongBookObservationRefused"]) expect(result[key], key).toBe(true);
	for (const key of ["isolated", "afterHarmlessRead", "afterMutatedObservation", "afterRecapture"]) {
		const current = result[key] as RetirementMeasurement;
		expect(current.value).toEqual({ok: true, value: null}); expect(current.cursors).toEqual(noRetirementScan);
		expect(current.getKeyInvocations).toBeGreaterThan(0); expect(current.transactions).toEqual(first.transactions);
	}
	expect(result.wrongProbeReceiver).toEqual({ok: false, kind: "malformed-input"});
	const evicted = result.evicted as RetirementMeasurement;
	expect(evicted.value).toEqual({ok: false, kind: "retirement-stale"}); expect(evicted.cursors).toEqual(noRetirementScan);
	expect(evicted.getKeyInvocations).toBeGreaterThan(0);
	const replacement = result.replacement as RetirementMeasurement, current = result.replacementProbe as RetirementMeasurement;
	expect(replacement.cursors).toEqual(retirementScan); expect(replacement.transactions).not.toEqual(first.transactions);
	expect(current.value).toEqual({ok: true, value: null}); expect(current.cursors).toEqual(noRetirementScan);
	expect(current.transactions).toEqual(replacement.transactions);
	for (const key of ["revokedQueued", "afterRevocation", "oldProbeNewBook", "closedQueued", "afterClose"])
		expect(result[key], key).toMatchObject({ok: false});
	expect(result.afterClose).toEqual({ok: false, kind: "store-closed"});
	expect(result.appended).toMatchObject({ok: true});
});

test("records native closed membership after completed row-only drain and preserves currency on reopen", async ({ page }) => {
	const result = await runCase(page, "closed-membership-after-drain");
	expect(result.completedDrain).toMatchObject({ cursor: 1, batches: 1 });
	expect(result.fresh).toMatchObject({ ok: true, value: { idempotent: false } });
	expect(result.stale).toEqual({ ok: false, kind: "retirement-stale" });
	const fresh = result.fresh as { value: { imageDigest: string } };
	expect(result.afterStale).toMatchObject({ ok: true, value: { image: { imageDigest: fresh.value.imageDigest, rowCount: 0, scopeCount: 2 }, control: { drain: null } } });
	expect(result.reopened).toEqual(result.afterStale);
	expect(result.retry).toMatchObject({ ok: true, value: { idempotent: true, imageDigest: fresh.value.imageDigest } });
	expect(result.inlineRejected).toMatchObject({ ok: false });
});

test("reuses readiness in held native custody and refuses incomplete prefix reuse", async ({page}) => {
	const result = await runCase(page, "reserved-readiness-reuse");
	const first = result.first as {reads: PageRead[]; value: {ready: LiveJournalReadinessResult;
		repeated: LiveJournalReadinessResult[]; bounded: SuccessfulPage}};
	const afterAppend = result.afterAppend as {reads: PageRead[]; value: {oldPrefix: SuccessfulPage;
		complete: LiveJournalReadinessResult; completeRepeat: LiveJournalReadinessResult}};
	// These are read phases, not a whole-job resource total. Original append costs remain separate.
	expect(result.append).toMatchObject({ok: true});
	expect(first.reads.map(read => read.rows)).toEqual([64, 2]);
	expect(first.reads.map(read => read.count)).toEqual([null, 2]);
	expect(new Set(first.reads.map(read => read.transaction)).size).toBe(1);
	expect(afterAppend.reads.map(read => read.rows)).toEqual([65, 65]);
	expect(afterAppend.reads.map(read => read.count)).toEqual([null, null]);
	expect(new Set(afterAppend.reads.map(read => read.transaction)).size).toBe(1);
	expect(first.value.ready).toMatchObject({ok: true, ready: true, rowCount: 64});
	for (const repeated of first.value.repeated) expect(repeated).toEqual(first.value.ready);
	expect(first.value.bounded).toMatchObject({ok: true, nextSequence: 0});
	expect(afterAppend.value.oldPrefix).toMatchObject({ok: true, snapshot: Reflect.get(first.value.ready, "snapshot")});
	expect(afterAppend.value.complete).toMatchObject({ok: true, ready: true, rowCount: 65});
	expect(Reflect.get(afterAppend.value.complete, "snapshot")).not.toEqual(Reflect.get(first.value.ready, "snapshot"));
	expect(afterAppend.value.completeRepeat).toEqual(afterAppend.value.complete);
});

test("retains bounded exact-scope replay facts across alternating scopes in one native hold", async ({page}) => {
	const result = await runCase(page, "reserved-readiness-scopes");
	await test.info().attach("held-journal-scope-materialization", {body: JSON.stringify(result), contentType: "application/json"});
	const reads = result.reads as PageRead[];
	const value = result.value as {first: LiveJournalReadinessResult; second: LiveJournalReadinessResult;
		repeated: LiveJournalReadinessResult; replacement: LiveJournalReadinessResult; originalByte: number; detachedByte: number};
	expect(value.first).toMatchObject({ok: true, rowCount: 8});
	expect(value.second).toMatchObject({ok: true, rowCount: 4});
	expect(value.repeated).toEqual(value.first); expect(value.replacement).toEqual(value.first);
	expect(value.detachedByte).toBe(value.originalByte);
	// Two complete initial validations, bounded detached native pages, then a
	// mandatory complete capture in a replacement native transaction.
	expect(reads.map(read => read.rows)).toEqual([8, 4, 2, 2, 2, 8]);
	expect(reads.map(read => read.count)).toEqual([null, null, 2, 2, 2, null]);
	expect(reads.slice(0, -1).every(read => read.transaction === reads[0]?.transaction)).toBe(true);
	expect(reads.at(-1)?.transaction).not.toBe(reads[0]?.transaction);
});

test("reuses exact journal leaf validation across fresh native images without sharing currency or mutable output", async ({page}) => {
	const result = await runCase(page, "incremental-replay-validation");
	await test.info().attach("incremental-journal-validation", {body: JSON.stringify(result), contentType: "application/json"});
	type Observation = {value: LiveJournalReadinessResult; strings: number; reads: PageRead[]};
	const {first, repeated, afterMutation, foreignFirst, foreignRepeated, corrupted} = result as Record<string, Observation>;
	for (const observation of [first, repeated, afterMutation, foreignFirst, foreignRepeated]) {
		expect(observation.value).toMatchObject({ok: true, rowCount: 8});
		expect(observation.reads.map(read => ({rows: read.rows, count: read.count}))).toEqual([{rows: 8, count: null}]);
	}
	for (const observation of [repeated, afterMutation, foreignRepeated]) expect(observation.strings).toBe(0);
	expect(foreignFirst.strings).toBeGreaterThan(0); // No cross-owner facts.
	expect(first.value).toEqual(repeated.value); expect(afterMutation.value).toEqual(repeated.value);
	expect(corrupted.value).toEqual({ok: false, kind: "store-poisoned"});
	expect(corrupted.reads.map(read => read.rows)).toEqual([8]);
});

test("bounds native journal page materialization inside the exact held readonly transaction", async ({ page }) => {
	const result = await runCase(page, "reserved-page-bound");
	const reads = result.reads as { rows: number; bytes: number; count: number | null; transaction: number }[];
	expect(reads.map((read) => read.rows)).toEqual([64, 3, 3, 2]);
	expect(reads.map((read) => read.count)).toEqual([null, 3, 3, 3]);
	expect(new Set(reads.map((read) => read.transaction)).size).toBe(1);
	const [full, bounded] = reads;
	if (full === undefined || bounded === undefined) throw new TypeError("missing native read measurements");
	expect(bounded.bytes).toBeLessThan(full.bytes / 10);
	const value = result.value as {
		first: SuccessfulPage;
		repeat: SuccessfulPage;
		tail: SuccessfulPage;
		empty: SuccessfulPage;
		detached: { signature: number; bytes: number };
		frozen: boolean;
	};
	expect(value.first).toMatchObject({ ok: true, nextSequence: 1 });
	expect(value.first.rows.map((row) => row.journalSequence)).toEqual([0, 1]);
	const repeated = value.repeat.rows[0];
	expect(repeated?.sourceKind).toBe("received");
	if (repeated?.sourceKind !== "received") throw new TypeError("expected genuine received row");
	expect(repeated.detachedSignature[0]).toBe(value.detached.signature);
	expect(repeated.exactCanonicalPreimageBytes[0]).toBe(value.detached.bytes);
	expect(value.tail.rows.map((row) => row.journalSequence)).toEqual([62, 63]);
	expect(value.tail.nextSequence).toBe(null);
	expect(value.empty).toMatchObject({ ok: true, rows: [], nextSequence: null });
	expect(value.frozen).toBe(true);
});

test("holds native foreign corruption until release then fully detects off-page poison", async ({ page }) => {
	const result = (await runCase(page, "reserved-page-foreign")) as {
		before: { committed: boolean; requestSucceeded: boolean };
		during: MeasuredPage;
		after: MeasuredPage;
		sticky: LiveJournalReadinessResult;
		committed: boolean;
		requestSucceeded: boolean;
	};
	expect(result.before).toEqual({ committed: false, requestSucceeded: false });
	expect(result.during.value).toMatchObject({ ok: true, nextSequence: 0 });
	expect(result.during.reads).toMatchObject([{ rows: 2, count: 2 }]);
	expect(result.committed).toBe(true);
	expect(result.requestSucceeded).toBe(true);
	expect(result.after.reads).toMatchObject([{ rows: 8, count: null }]);
	expect(result.after.value).toEqual({ ok: false, kind: "store-poisoned" });
	expect(result.sticky).toEqual({ ok: false, kind: "store-poisoned" });
});

test("never reuses a basis across completed or new transactions and preserves captured prefix tokens", async ({
	page,
}) => {
	const result = (await runCase(page, "reserved-page-lifetime")) as Record<string, MeasuredPage>;
	for (const [key, rows] of [
		["newTransaction", 4],
		["unreserved", 5],
		["restored", 5],
		["ownAppend", 6],
		["forged", 5],
		["stale", 5],
	] as const) {
		expect(result[key].reads).toMatchObject([{ rows, count: null }]);
	}
	expect(result.reused.reads).toMatchObject([{ rows: 2, count: 2 }]);
	expect(result.prefix.reads).toMatchObject([{ rows: 1, count: 3 }]);
	for (const key of ["unreserved", "restored", "prefix", "ownAppend"]) {
		expect(result[key].value.rows.map((row) => row.journalSequence)).toEqual([3]);
		expect(result[key].value.snapshot.highWatermark).toBe(4);
		expect(result[key].value.nextSequence).toBe(null);
	}
	expect(result.forged.value).toEqual({ ok: false, kind: "digest-mismatch" });
	expect(result.stale.value).toEqual({ ok: false, kind: "stale-snapshot" });
	expect(result.wrong.value).toEqual({ ok: false, kind: "wrong-scope" });
	expect(result.wrong.reads).toEqual([]);
});

test("fully revalidates released journal images and retains holes header absence wrong-scope and uniqueness laws", async ({
	page,
}) => {
	const result = (await runCase(page, "reserved-page-poison")) as Record<
		string,
		{ page: MeasuredPage; next: LiveJournalReadinessResult; duplicateRefused?: boolean }
	>;
	for (const key of ["hole", "offpage", "header"]) {
		expect(result[key].page.value).toEqual({ ok: false, kind: "store-poisoned" });
		expect(result[key].next).toEqual({ ok: false, kind: "store-poisoned" });
	}
	expect(result.hole.page.reads).toMatchObject([{ rows: 3, count: null }]);
	expect(result.offpage.page.reads).toMatchObject([{ rows: 4, count: null }]);
	expect(result.absent.page.value).toEqual({ ok: false, kind: "not-installed" });
	expect(result.absent.page.reads).toMatchObject([{ rows: 4, count: null }]);
	expect(result.absent.next).toMatchObject({ ok: true, ready: false });
	expect(result["wrong-anchor"].page.value).toEqual({ ok: false, kind: "wrong-scope" });
	expect(result["wrong-anchor"].page.reads).toMatchObject([{ rows: 0, count: null }]);
	expect(result.duplicate.duplicateRefused).toBe(true);
	expect(result.duplicate.page.value).toMatchObject({ ok: true });
	expect(result.duplicate.page.reads).toMatchObject([{ rows: 4, count: null }]);
	expect(result.duplicate.next).toMatchObject({ ok: true, ready: true, rowCount: 4 });
});

test("routes all four shared pure decisions through the real Browser adapter build", async ({ page }) => {
	const value = await runCase(page, "decision-mutants", "phase-3a1b-p4-decision-mutant.html");
	const expected = value.expected as Readonly<Record<string, string>>;
	const results = value.results as Readonly<Record<string, unknown>>;
	for (const mode of ["capture", "duplicate", "snapshot", "observation"] as const) {
		const result = results[mode] as {
			readonly outcome: unknown;
			readonly raw: { readonly rows: readonly unknown[]; readonly scopes: readonly Record<string, unknown>[] };
		};
		expect(result.outcome).toMatchObject({ ok: false });
		expect(result.outcome).not.toMatchObject({ idempotent: true, ok: true });
		expect(result.raw.rows).toHaveLength(mode === "capture" ? 0 : 1);
		expect(result.raw.scopes).toHaveLength(mode === "capture" ? 0 : 1);
		if (mode !== "capture") {
			expect(result.raw.rows).toMatchObject([
				{
					anchorDigest: expected.anchorDigest,
					epoch: 0,
					journalSequence: 0,
					objectId: expected.objectId,
					sourceKind: "received",
					vertexDigest: expected.vertexDigest,
				},
			]);
			expect(result.raw.scopes).toMatchObject([
				{
					anchorDigest: expected.anchorDigest,
					nextJournalSequence: 1,
					objectId: expected.objectId,
					parametersDigest: expected.parametersDigest,
				},
			]);
		}
	}
});

test("opens the exact six-method facade and native strict-IDB schema without touching primary", async ({ page }) => {
	const value = await runCase(page, "surface-schema");
	expect(value.keys).toEqual([...P4_BROWSER_METHODS].sort());
	expect(value.primaryCreated).toBe(false);
	expect(value.schema).toEqual({
		stores: [
			{
				autoIncrement: false,
				indexes: [
					{
						keyPath: P4_BROWSER_SCHEMA.digestUniq,
						multiEntry: false,
						name: "digestUniq",
						unique: true,
					},
					{
						keyPath: P4_BROWSER_SCHEMA.localRefUniq,
						multiEntry: false,
						name: "localRefUniq",
						unique: true,
					},
				],
				keyPath: P4_BROWSER_SCHEMA.acceptedEntriesKeyPath,
				name: "acceptedEntries",
			},
			{ autoIncrement: false, indexes: [], keyPath: P4_BROWSER_SCHEMA.scopesKeyPath, name: "scopes" },
		],
		version: 1,
	});
});

test("accepts a legal distinct append between commit and readback and snapshots idempotent/no-write paths", async ({
	page,
}) => {
	const value = await runCase(page, "interleaving");
	expect(value.genesisRepeat).toMatchObject({ idempotent: true, ok: true });
	expect(value.target).toMatchObject({ idempotent: false, journalSequence: 0, ok: true, sourceKind: "received" });
	expect(value.repeat).toMatchObject({ idempotent: true, journalSequence: 0, ok: true, sourceKind: "received" });
	expect(value.localRepeat).toMatchObject({
		idempotent: true,
		journalSequence: 1,
		ok: true,
		sourceKind: "local-issued",
	});
	expect(value.crossKind).toMatchObject({ idempotent: true, journalSequence: 0, ok: true, sourceKind: "received" });
	expect(value.localRefConflict).toEqual({ kind: "evidence-conflict", ok: false });
	expect(value.ready).toMatchObject({ ok: true, ready: true, rowCount: 2 });
	const closure = value.closure as {
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	};
	expect(closure.rows.map(({ journalSequence }) => journalSequence)).toEqual([0, 1]);
	expect(closure.scopes).toMatchObject([{ nextJournalSequence: 2 }]);
	const ledger = value.ledger as readonly string[];
	const significant = ledger.filter((event) =>
		/(?:received-new:(?:target:commit:readwrite|distinct:(?:commit:readwrite|readonly-readback|return)|target:(?:readonly-readback|return)))$/u.test(
			event
		)
	);
	expect(significant).toEqual([
		"received-new:target:commit:readwrite",
		"received-new:distinct:commit:readwrite",
		"received-new:distinct:readonly-readback",
		"received-new:distinct:return",
		"received-new:target:readonly-readback",
		"received-new:target:return",
	]);
	for (const label of ["genesis-repeat", "received-repeat", "local-repeat", "cross-kind"]) {
		expect(ledger.filter((event) => event === `${label}:target:transaction:readwrite`)).toHaveLength(1);
		expect(ledger.filter((event) => event === `${label}:target:commit:readwrite`)).toHaveLength(1);
		expect(ledger.filter((event) => event === `${label}:target:abort:readwrite`)).toHaveLength(0);
		expect(ledger.filter((event) => event === `${label}:target:readonly-readback`)).toHaveLength(1);
		expect(ledger.filter((event) => event === `${label}:target:return`)).toHaveLength(1);
	}
	expect(ledger.filter((event) => event === "local-ref:target:transaction:readwrite")).toHaveLength(1);
	expect(ledger.filter((event) => event === "local-ref:target:commit:readwrite")).toHaveLength(0);
	expect(ledger.filter((event) => event === "local-ref:target:abort:readwrite")).toHaveLength(1);
	expect(ledger.filter((event) => event === "local-ref:target:readonly-readback")).toHaveLength(1);
	expect(ledger.filter((event) => event === "local-ref:target:return")).toHaveLength(1);
	for (const label of ["readiness", "page"] as const) {
		const events = ledger.filter((event) => event.startsWith(`${label}:target:`));
		expect(events).toEqual([
			`${label}:target:transaction:readonly`,
			`${label}:target:readonly-readback`,
			`${label}:target:request:scopes:get`,
			`${label}:target:request:acceptedEntries:getAll`,
			`${label}:target:commit:readonly`,
			`${label}:target:return`,
		]);
	}
});

test("validates exact persisted scope/received/local own-key variants and poisons sediment", async ({ page }) => {
	const value = await runCase(page, "persisted-shapes");
	const received = value.receivedClosure as {
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	};
	const local = value.localClosure as typeof received;
	expect(Object.keys(received.scopes[0] ?? {}).sort()).toEqual([
		"anchorDigest",
		"detachedAnchorSignature",
		"epoch",
		"exactCanonicalAnchorPreimageBytes",
		"exactCanonicalParametersCarrierBytes",
		"nextJournalSequence",
		"objectId",
		"parametersDigest",
	]);
	expect(Object.keys(received.rows[0] ?? {}).sort()).toEqual([
		"anchorDigest",
		"detachedSignature",
		"epoch",
		"exactCanonicalPreimageBytes",
		"journalSequence",
		"objectId",
		"sourceKind",
		"vertexDigest",
	]);
	expect(Object.keys(local.rows[0] ?? {}).sort()).toEqual([
		"anchorDigest",
		"epoch",
		"journalSequence",
		"localAuthor",
		"localAuthorSequence",
		"objectId",
		"sourceKind",
		"vertexDigest",
	]);
	expect(value.receivedLocalRefKeys).toEqual([]);
	expect(value.rowPoison).toEqual({ kind: "store-poisoned", ok: false });
	expect(value.scopePoison).toEqual({ kind: "store-poisoned", ok: false });
	expect(value.variantPoisons).toEqual(Array(16).fill({ kind: "store-poisoned", ok: false }));
});

test("stores exact received keys, retains first label and returns one capped durable-prefix page", async ({ page }) => {
	const value = await runCase(page, "lifecycle");
	expect(value.installed).toMatchObject({ idempotent: false, ok: true });
	expect(value.received).toMatchObject({ idempotent: false, journalSequence: 0, ok: true, sourceKind: "received" });
	expect(value.echo).toMatchObject({ idempotent: true, journalSequence: 0, ok: true, sourceKind: "received" });
	expect(value.ready).toMatchObject({ ok: true, ready: true, rowCount: 1 });
	expect(value.page).toMatchObject({ nextSequence: null, ok: true, rows: [{ journalSequence: 0 }] });
	const rawRows = value.rawRows as readonly Record<string, unknown>[];
	expect(rawRows).toHaveLength(1);
	expect(Object.keys(rawRows[0] ?? {}).sort()).toEqual([
		"anchorDigest",
		"detachedSignature",
		"epoch",
		"exactCanonicalPreimageBytes",
		"journalSequence",
		"objectId",
		"sourceKind",
		"vertexDigest",
	]);
});

test("serializes independent facades to one cross-kind winner and dense sequence", async ({ page }) => {
	const value = await runCase(page, "concurrency");
	const race = value.race as readonly Record<string, unknown>[];
	expect(race.every(({ ok, journalSequence }) => ok === true && journalSequence === 0)).toBe(true);
	expect(new Set(race.map(({ sourceKind }) => sourceKind)).size).toBe(1);
	expect(race.filter(({ idempotent }) => idempotent === false)).toHaveLength(1);
	const closure = value.closure as {
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	};
	expect(value.rawVerified).toBe(true);
	expect(closure.rows).toHaveLength(1);
	expect(closure.rows[0]).toMatchObject({ journalSequence: 0, vertexDigest: race[0]?.vertexDigest });
	expect(Object.keys(closure.rows[0] ?? {}).sort()).toEqual(
		race[0]?.sourceKind === "received"
			? [
					"anchorDigest",
					"detachedSignature",
					"epoch",
					"exactCanonicalPreimageBytes",
					"journalSequence",
					"objectId",
					"sourceKind",
					"vertexDigest",
				]
			: [
					"anchorDigest",
					"localAuthor",
					"localAuthorSequence",
					"epoch",
					"journalSequence",
					"objectId",
					"sourceKind",
					"vertexDigest",
				]
	);
	expect(closure.scopes).toHaveLength(1);
	expect(closure.scopes[0]).toMatchObject({ nextJournalSequence: 1 });
	expect(Object.keys(closure.scopes[0] ?? {}).sort()).toEqual([
		"anchorDigest",
		"detachedAnchorSignature",
		"epoch",
		"exactCanonicalAnchorPreimageBytes",
		"exactCanonicalParametersCarrierBytes",
		"nextJournalSequence",
		"objectId",
		"parametersDigest",
	]);
});

test("executes the full duplicate and cross-kind precedence matrix against strict IDB", async ({ page }) => {
	const value = await runCase(page, "duplicates");
	const results = value.results as readonly unknown[];
	expect(results).toHaveLength(15);
	expect(results.slice(0, 3)).toMatchObject([
		{ idempotent: false, journalSequence: 0, ok: true, sourceKind: "received" },
		{ idempotent: true, journalSequence: 0, ok: true, sourceKind: "received" },
		{ idempotent: true, journalSequence: 0, ok: true, sourceKind: "received" },
	]);
	expect(results[3]).toEqual({ kind: "evidence-conflict", ok: false });
	expect(results[4]).toMatchObject({
		rows: [{ journalSequence: 0, sourceKind: "received" }],
		scopes: [{ nextJournalSequence: 1 }],
	});
	expect(results.slice(5, 8)).toMatchObject([
		{ idempotent: false, journalSequence: 0, ok: true, sourceKind: "local-issued" },
		{ idempotent: true, journalSequence: 0, ok: true, sourceKind: "local-issued" },
		{ idempotent: true, journalSequence: 0, ok: true, sourceKind: "local-issued" },
	]);
	expect(results[8]).toEqual({ kind: "evidence-conflict", ok: false });
	expect(results[9]).toEqual({ kind: "evidence-conflict", ok: false });
	expect(results[10]).toMatchObject({
		rows: [{ journalSequence: 0, sourceKind: "local-issued" }],
		scopes: [{ nextJournalSequence: 1 }],
	});
	expect(results[11]).toMatchObject({ idempotent: false, journalSequence: 0, ok: true });
	expect(results[12]).toMatchObject({ idempotent: false, journalSequence: 1, ok: true });
	expect(results[13]).toEqual({ kind: "evidence-conflict", ok: false });
	expect(results[14]).toMatchObject({
		rows: [{ journalSequence: 0 }, { journalSequence: 1 }],
		scopes: [{ nextJournalSequence: 2 }],
	});
});

test("classifies the bounded exact-old/new/mixed/unreadable readback seam without authority", async ({ page }) => {
	const value = await runCase(page, "faults");
	const results = value.results as readonly Record<string, unknown>[];
	expect(results).toHaveLength(8);
	expect(results[0]).toMatchObject({
		fate: "exact-new",
		operation: "install",
		result: { idempotent: false, ok: true },
	});
	expect(results[1]).toMatchObject({
		fate: "exact-old",
		operation: "install",
		result: { kind: "substrate-failure", ok: false },
	});
	expect(results[2]).toMatchObject({
		after: { kind: "store-poisoned", ok: false },
		fate: "mixed",
		operation: "install",
		result: { kind: "store-poisoned", ok: false },
	});
	expect(results[3]).toMatchObject({
		fate: "unreadable",
		operation: "install",
		result: { kind: "outcome-unknown", ok: false },
	});
	expect(results[4]).toMatchObject({
		fate: "exact-new",
		operation: "append",
		result: { idempotent: false, journalSequence: 0, ok: true },
	});
	expect(results[5]).toMatchObject({
		fate: "exact-old",
		operation: "append",
		result: { kind: "substrate-failure", ok: false },
	});
	expect(results[6]).toMatchObject({
		after: { kind: "store-poisoned", ok: false },
		fate: "mixed",
		operation: "append",
		result: { kind: "store-poisoned", ok: false },
	});
	expect(results[7]).toMatchObject({
		fate: "unreadable",
		operation: "append",
		result: { kind: "outcome-unknown", ok: false },
	});
	for (const result of results.filter(({ fate }) => fate !== "exact-new")) {
		expect(Object.keys(result.result as object).sort()).toEqual(["kind", "ok"]);
	}
});

test("fails closed when the observed IndexedDB transaction durability is downgraded", async ({ page }) => {
	const value = await runCase(page, "strict-downgrade");
	expect(value).toMatchObject({ error: { kind: "durability-unavailable" } });
	expect(value).not.toHaveProperty("unexpectedSuccess");
});

test("freezes the three-engine 36-tuple genuine process-death roster as nightly-owned", ({ browserName }) => {
	expect(["chromium", "firefox", "webkit"]).toContain(browserName);
	expect(P4_BROWSER_DEATH_TUPLES).toHaveLength(36);
	expect(new Set(P4_BROWSER_DEATH_TUPLES.map(({ id }) => id)).size).toBe(36);
	expect(P4_BROWSER_NO_WRITE_DEATH_TUPLES.map(({ scenario }) => scenario)).toEqual([
		"idempotent-genesis",
		"received-repeat",
		"local-repeat",
		"cross-kind-race",
		"local-ref-race",
	]);
});

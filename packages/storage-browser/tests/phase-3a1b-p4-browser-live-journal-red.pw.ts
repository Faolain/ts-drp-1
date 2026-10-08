import { expect, type Page, test } from "@playwright/test";

import { type P4AssetServer, startP4AssetServer } from "./fixtures/phase-3a1b-p4-asset-server.js";
import {
	P4_BROWSER_DEATH_TUPLES,
	P4_BROWSER_METHODS,
	P4_BROWSER_NO_WRITE_DEATH_TUPLES,
	P4_BROWSER_SCHEMA,
} from "./fixtures/phase-3a1b-p4-browser-contract.js";

let server: P4AssetServer;

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
		| "surface-schema",
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

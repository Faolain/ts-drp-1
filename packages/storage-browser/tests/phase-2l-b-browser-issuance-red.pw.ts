import { expect, type Page, test } from "@playwright/test";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import {
	PHASE_2L_B_FAST_CASES,
	PHASE_2L_B_SCHEMA,
	PHASE_2L_B_SETTLEMENT_SCHEMA,
} from "./fixtures/phase-2l-b-browser-issuance-contract.js";

let server: AssetServer;

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2L_B_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("Phase 2l-b global setup did not install assets");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => server.close());

type JsonRecord = Record<string, unknown>;

async function runCase(page: Page, caseId: string): Promise<JsonRecord> {
	const url = server.issueTransitionURL("phase-2l-b.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lBRunFastCase === "function");
		const envelope = (await page.evaluate(
			(id: string) => window.phase2lBRunFastCase(id as never),
			caseId
		)) as JsonRecord;
		expect(envelope.candidateAvailable).toBe(true);
		return envelope.value as JsonRecord;
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
}

test("exact two-symbol surface, closed options and opaque identity are promise-only", async ({ page }) => {
	const value = await runCase(page, "surface-options-identity");
	expect(value.keys).toEqual([
		"close",
		"compareAndMarkOutboxPublished",
		"readIssued",
		"readLineage",
		"readOutboxPage",
		"readSettlementPlan",
		"transactIssue",
		"transactWriteSettlementPlan",
	]);
	expect(value.prototypeKeys).toEqual([]);
	expect(value.closeSamePromise).toBe(true);
	expect(value.getterCalls).toBe(0);
	expect(value.invalid).toHaveLength(9);
	for (const observation of value.invalid as JsonRecord[]) {
		expect(observation.synchronous ?? false).toBe(false);
		const failure = observation.rejection ?? observation.accessor;
		expect(failure).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT", name: "DurableIssuanceTypeError" });
	}
	const derived = value.derived as string[];
	expect(derived[0]).toBe(`   --drp-issuance-v1`);
	expect(derived[1]).toHaveLength(1025 + "--drp-issuance-v1".length);
});

test("derived v2 schema is exact while primary identity remains completely opaque", async ({ page }) => {
	const value = await runCase(page, "primary-opacity-schema-admission");
	expect(value.absentPrimaryCreated).toBe(false);
	expect(value.primaryObservation).toEqual({ stores: ["sentinel"], version: 7 });
	expect(value.nativeSchemaControl).toEqual(PHASE_2L_B_SCHEMA);
	expect(value.schema).toEqual(PHASE_2L_B_SETTLEMENT_SCHEMA);
	expect(value.badError).toMatchObject({ code: "ISSUANCE_UNSUPPORTED_SCHEMA" });
});

test("exact adapter-derived v1 rows survive the in-place v2 settlement-plan upgrade", async ({ page }) => {
	const value = await runCase(page, "v1-upgrade-preserves-committed-rows");
	expect(value.beforeSchema).toEqual(PHASE_2L_B_SCHEMA);
	expect(value.afterSchema).toEqual(PHASE_2L_B_SETTLEMENT_SCHEMA);
	expect(value.readable).toEqual({
		issued: {
			authorSequence: 0,
			canonicalPreimageBytes: value.expectedCanonicalPreimageBytes,
			digest: [37, 209],
			issuedScope: { author: "alice", objectId: "room:alpha" },
			outboxScope: { author: "alice", objectId: "room:alpha" },
			signature: [37, 81],
		},
		lineage: { exhausted: false, next: 1 },
		outbox: [
			{
				authorSequence: 0,
				digest: [37, 209],
				publishState: "published",
				scope: { author: "alice", objectId: "room:alpha" },
			},
		],
		settlementPlan: null,
	});
});

test("real adapter commits one detached closure and pages in shared UTF-16 order", async ({ page }) => {
	const value = await runCase(page, "issue-read-copy-paging");
	expect(value.schema).toEqual(PHASE_2L_B_SETTLEMENT_SCHEMA);
	expect(value.lineage).toEqual({ exhausted: false, next: 1 });
	expect(value.copy).toEqual({ digest: [23, 209], freshEnvelope: true, freshGraph: true, signature: [23, 81] });
	expect(value.order).toEqual([
		["a", "a", 0],
		["room:alpha", "alice", 0],
		["😀", "a", 0],
		["\ue000", "z", 0],
	]);
});

test("two tabs make one same-scope winner while unrelated scope commits during suspended build", async ({ page }) => {
	const value = await runCase(page, "same-scope-race-and-cross-scope-progress");
	expect(value.buildCalls).toBe(2);
	expect((value.race as string[]).slice().sort()).toEqual(["ISSUANCE_RETRY_REQUIRED", "success"]);
	expect(value.lineage).toEqual({ exhausted: false, next: 1 });
	expect(value.outboxCount).toBe(1);
	expect(value.crossScopeB).toBe(0);
});

test("close does not await suspended signing and MAX commits once without +1", async ({ page }) => {
	const value = await runCase(page, "close-versionchange-and-max");
	expect(value.closeSamePromise).toBe(true);
	expect(value.closeWon).toBe(true);
	expect(value.suspendedError).toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });
	expect(value.max).toEqual({
		builds: 1,
		exhausted: expect.objectContaining({ code: "ISSUANCE_EXHAUSTED" }),
		final: Number.MAX_SAFE_INTEGER,
		lineage: { exhausted: true, next: Number.MAX_SAFE_INTEGER },
	});
});

test("raw key collision poisons and all five ambiguity cases execute through the real adapter", async ({ page }) => {
	const value = await runCase(page, "collision-poison-and-ambiguity");
	expect(value.collision).toEqual([
		expect.objectContaining({ code: "ISSUANCE_RECOVERY_CORRUPT" }),
		expect.objectContaining({ code: "ISSUANCE_RECOVERY_CORRUPT" }),
	]);
	const ambiguity = value.ambiguity as Array<JsonRecord & { caseId: string; code: string; exposedKeys: string[] }>;
	expect(ambiguity.map(({ caseId }) => caseId)).toEqual([
		"exact-pair",
		"absent-old",
		"foreign-pair",
		"torn-or-inconsistent",
		"unreadable",
	]);
	expect(ambiguity.map(({ code }) => code)).toEqual([
		"SUCCESS",
		"ISSUANCE_SUBSTRATE_FAILURE",
		"ISSUANCE_RETRY_REQUIRED",
		"ISSUANCE_RECOVERY_CORRUPT",
		"ISSUANCE_OUTCOME_UNKNOWN",
	]);
	for (const row of ambiguity) {
		if (row.caseId === "unreadable") expect(row.exposedKeys.slice().sort()).toEqual(["code", "scope"]);
		else expect(row.exposedKeys).not.toEqual(expect.arrayContaining(["candidate", "digest", "token"]));
	}
});

test("the bounded fast inventory is fully consumed", () => {
	expect(PHASE_2L_B_FAST_CASES).toHaveLength(7);
});

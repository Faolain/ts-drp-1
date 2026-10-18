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
	expect(value.outboxCopy).toEqual({
		independentEnvelopes: true,
		independentScopes: true,
		freshGraph: true,
		unchanged: true,
	});
	expect(value.order).toEqual([
		["a", "a", 0],
		["room:alpha", "alice", 0],
		["😀", "a", 0],
		["\ue000", "z", 0],
	]);
});

test("R8 initial outbox validation streams the global closure without whole-store arrays", async ({ page }) => {
	const url = server.issueTransitionURL("phase-2l-b.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lBR8OutboxMaterialization === "function");
		const value = (await page.evaluate(() => window.phase2lBR8OutboxMaterialization())) as JsonRecord;
		await test.info().attach("r8-initial-outbox-materialization", {
			body: Buffer.from(JSON.stringify(value)),
			contentType: "application/json",
		});
		expect(value.page).toEqual(
			[1, 2].map((sequence) => ({
				sequence,
				scope: { author: "alice", objectId: "room:alpha" },
				publishState: "pending",
			}))
		);
		expect(value.arrays).toEqual([]);
		expect(value.cursorRows).toEqual({ lineages: 3, issuedRecords: 192, issuanceOutbox: 192 });
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
});

test("R8 issuer current probe stays original exact-held native currency without data credit or detached release", async ({ page }, info) => {
	const url = server.issueTransitionURL("phase-2l-b.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lBR8IssuanceCurrentProbe === "function");
		const result = (await page.evaluate(() => window.phase2lBR8IssuanceCurrentProbe())) as JsonRecord;
		await info.attach("r8-issuer-exact-held-current-probe", { body: JSON.stringify(result), contentType: "application/json" });
		expect(result.ok, JSON.stringify(result)).toBe(true);
		const value = result.value as JsonRecord, seed = value.seedWork as JsonRecord;
		expect(seed.transactions).toHaveLength(1);
		expect(seed.cursorRows).toEqual({ lineages: 1, issuedRecords: 3, issuanceOutbox: 3, settlementPlans: 1 });
		expect(value.probeRefusals).toEqual({ nonheld: true, copied: true, forged: true, foreignReceiver: true, wrongObject: true, wrongLimits: true, wrongByteLimit: true, mutated: true, consumed: true });
		expect(value.probeSurface).toEqual({ keys: ["checkCurrent"], frozen: true });
		expect(value.foreignProbeReceiver).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
		expect(value.current).toBe(true);
		const current = value.currentWork as JsonRecord;
		expect(current.transactions).toEqual(seed.transactions);
		expect(current.getKeyRequests).toBeGreaterThan(0); // A fresh genuine request; keeper requests are included, not call-credited away.
		expect(current.calls).toEqual({});
		expect(current.cursorRows).toEqual({});
		expect(value.otherObjectFallback).toEqual({ rows: 1 });
		expect((value.otherObjectFallbackWork as JsonRecord).cursorRows).toEqual({ lineages: 1, issuedRecords: 1, issuanceOutbox: 1 });
		expect(value.lowerRows).toMatchObject({ code: "ISSUANCE_RETRY_REQUIRED" });
		expect(Object.keys((value.lowerRowsWork as JsonRecord).calls as JsonRecord).some(key => key.startsWith("count:"))).toBe(true);
		expect(value.lowerBytes).toMatchObject({ code: "ISSUANCE_SUBSTRATE_FAILURE", retryClass: "transient" });
		expect(Object.keys((value.lowerBytesWork as JsonRecord).calls as JsonRecord).some(key => key.startsWith("openCursor:"))).toBe(true);
		expect(value.currentAfterRefusals).toBe(true);
		expect(value.released).toBe(false);
		expect(value.replaced).toBe(false);
		expect((value.replacedWork as JsonRecord).calls).toEqual({});
		expect(value.newBook).toEqual({ sameImage: true, signature: true });
		expect((value.newBookWork as JsonRecord).transactions).not.toEqual(seed.transactions);
		expect((value.newBookWork as JsonRecord).cursorRows).toEqual(seed.cursorRows); // Identical bytes never replace new-book admission.
		const controls = value.joinedProbeControls as JsonRecord[];
		expect(controls.map(row => row.mode)).toEqual(["release", "abort", "close"]);
		for (const row of controls) {
			expect(row.midpoint).toMatchObject({ stopJoined: false, delivered: false });
			expect(row.revokedProbe).not.toMatchObject({ resolved: true, current: true });
			if (row.mode === "close") {
				expect((row.revokedProbe as JsonRecord).failure).toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });
				expect(row.closedCapture).toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });
			}
			expect((row.admission as JsonRecord).code).not.toBe("RESOLVED");
			expect((row.admissionWork as JsonRecord).calls).toEqual({});
			expect(row.delivered).toBe(true); expect(row.stopJoined).toBe(true); expect(row.writerRead).toBe(true);
			expect(row.checked).not.toMatchObject({ resolved: true, current: true });
			if (row.mode === "abort") {
				expect((row.checked as JsonRecord).resolved).toBe(false);
				expect((row.stopped as JsonRecord).code).not.toBe("RESOLVED"); // Original native terminal failure is not converted to a successful join.
			}
		} // Original native/closed failures join; no stronger admitted-work cancellation policy is inferred.
		expect(value.probeControlsZeroCrypto).toBe(true);
		expect(value.probeControlsNativeUnchanged).toBe(true);
		expect(value.foreignExcluded).toBe(true);
		expect(value.oldBookAfterCorruption).toBe(false);
		expect((value.corruptNewBookWork as JsonRecord).cursorRows).toEqual(seed.cursorRows);
		expect(value.foreignCorruption).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		expect(Object.values((value.foreignScanWork as JsonRecord).cursorRows as Record<string, number>).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
		expect(value.poisonedProbe).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		expect(value.poisonedCapture).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		expect(value.foreignSticky).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		expect(value.cryptoEntries).toBe(4);
		expect(value.cleanup).toEqual(["reservation:joined", "store:joined", "database:deleted"]);
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
});

test("R8 outbox cursor validation preserves off-page poison, ordering and detached delivery", async ({ page }) => {
	const url = server.issueTransitionURL("phase-2l-b.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lBR8OutboxStreamingControls === "function");
		const value = (await page.evaluate(() => window.phase2lBR8OutboxStreamingControls())) as JsonRecord;
		await test
			.info()
			.attach("r8-outbox-streaming-controls", {
				body: Buffer.from(JSON.stringify(value)),
				contentType: "application/json",
			});
		const failures = value.failures as JsonRecord[];
		expect(failures).toHaveLength(18);
		for (const failure of failures) expect(failure).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT", sticky: true });
		expect(value.positive).toEqual({
			empty: 0,
			lineageOnly: 0,
			order: ["room:alpha", "\u{10000}", "\uE000"],
			after: ["\u{10000}", "\uE000"],
			absent: 0,
			digest: [7, 0xd1],
			signature: [7, 0x51],
		});
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
});

test("one native held outbox image bounds subsequent page materialization without hiding foreign poison", async ({
	page,
}) => {
	const value = await runCase(page, "held-outbox-page-work");
	await test.info().attach("held-outbox-native-work", {
		body: Buffer.from(JSON.stringify(value)),
		contentType: "application/json",
	});
	expect(value.first).toEqual([0, 1]);
	expect(value.second).toEqual([2, 3]);
	expect(value.last).toEqual([63]);
	expect(value.absent).toBe(0);
	expect(value.initialReads).toEqual([]);
	expect(value.initialCursorRows).toEqual({ lineages: 1, issuedRecords: 64, issuanceOutbox: 64 });
	expect(value.pageReads).toEqual([{ store: "issuanceOutbox", rows: 2, count: 2 }]);
	expect(value.lastReads).toEqual([{ store: "issuanceOutbox", rows: 1, count: 2 }]);
	expect(value.excluded).toEqual({ foreignRead: false, foreignCommitted: false });
	expect(value.foreignRead).toBe(true);
	expect(value.foreignCommitted).toBe(true);
	expect(value.postRelease).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
	expect(value.postReleaseReads).toEqual([]);
	expect(value.postReleaseCursorRows).toEqual({ lineages: 1, issuedRecords: 64, issuanceOutbox: 64 });
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

async function runR8Native(page: Page, caseId: "job" | "unknown"): Promise<JsonRecord> {
	const url = server.issueTransitionURL("phase-2l-b.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lBR8Native === "function");
		const result = (await page.evaluate((id) => window.phase2lBR8Native(id), caseId)) as JsonRecord;
		expect(result.ok, JSON.stringify(result)).toBe(true);
		return result.value as JsonRecord;
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
}
test("R8 supplied native hook joins post-sign builder before close and revokes new admission", async ({
	page,
}, info) => {
	const value = await runR8Native(page, "job");
	await info.attach("r8-native-job", { body: JSON.stringify(value), contentType: "application/json" });
	expect(value.entries).toBe(1);
	expect(value.beforeJoin).toEqual({ closeDelivered: false, foreignDelivered: false });
	expect(value.revoked).toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });
	expect(value.result).toMatchObject({ ok: false, code: "ISSUANCE_STORE_CLOSED" });
	expect(value.foreignLineage).toEqual({ next: 0, exhausted: false });
	expect(value.cleanup).toEqual(["fulfilled", "fulfilled", "database:deleted"]);
});
test("R8 uncertain verified signature keeps exact unsigned identity across SAME-IDB reopen", async ({ page }, info) => {
	const value = await runR8Native(page, "unknown");
	await info.attach("r8-unknown-identity", { body: JSON.stringify(value), contentType: "application/json" });
	expect(value.initial).toMatchObject({
		code: "ISSUANCE_OUTCOME_UNKNOWN",
		cause: "Error: R8_TEST_ENTERED_CRYPTO_DELIVERY_LOST",
	});
	expect(value.conflictEntries).toBe(0);
	expect(value.conflicting).toMatchObject({ code: "ISSUANCE_OUTCOME_UNKNOWN" });
	expect(value.wholeNativeUnchanged).toBe(true);
	expect(value.retryEntries).toBe(1);
	expect(value.sameIntent).toEqual({ sequence: 0, next: 1, outboxCount: 1, digestMatches: true });
	expect(value.cleanup).toEqual(["initial:fulfilled", "cold:fulfilled", "database:deleted"]);
});

test("R8 native writer abort retains entered signer custody and exact identity across SAME-IDB reopen", async ({
	page,
}, info) => {
	const url = server.issueTransitionURL("phase-2l-b.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lBR8NativeAbort === "function");
		const result = (await page.evaluate(() => window.phase2lBR8NativeAbort())) as JsonRecord;
		await info.attach("r8-entered-native-abort", { body: JSON.stringify(result), contentType: "application/json" });
		expect(result.ok, JSON.stringify(result)).toBe(true);
		const value = result.value as JsonRecord;
		expect(value.pulseCount).toBeGreaterThan(0);
		expect(value.beforeJoin).toEqual({ closeDelivered: false });
		expect(value.revoked).toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });
		expect(value.result).toMatchObject({ ok: false, code: "ISSUANCE_STORE_CLOSED" });
		expect(value.debt).toEqual({ phase: "entered", sequence: 0, next: 0, digestMatches: true, issued: 0, outbox: 0 });
		expect(value.conflicting).toMatchObject({ code: "ISSUANCE_OUTCOME_UNKNOWN" });
		expect(value.conflictEntries).toBe(0);
		expect(value.wholeNativeUnchanged).toBe(true);
		expect(value.retryEntries).toBe(1);
		expect(value.sameIntent).toEqual({ sequence: 0, next: 1, outboxCount: 1, digestMatches: true });
		expect(value.cleanup).toEqual(["fulfilled", "fulfilled", "database:deleted"]);
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
});

for (const caseId of [
	"control-stale",
	"rows-stale",
	"matching-null",
	"malformed-pair",
	"inherited-entered-stale",
	"reserved-ack-interposition",
] as const) {
	test(
		"R8 paired native currency " + caseId + " binds initial rows and exact control before crypto",
		async ({ page }, info) => {
			const url = server.issueTransitionURL("phase-2l-b.html");
			try {
				await page.goto(url, { waitUntil: "load" });
				await page.waitForFunction(() => typeof window.phase2lBR8NativeCurrency === "function");
				const result = (await page.evaluate((id) => window.phase2lBR8NativeCurrency(id), caseId)) as JsonRecord;
				await info.attach("r8-paired-native-currency", {
					body: JSON.stringify(result),
					contentType: "application/json",
				});
				expect(result.ok, JSON.stringify(result)).toBe(true);
				const value = result.value as JsonRecord;
				if (caseId === "matching-null") {
					expect(value.entries).toBe(2);
					expect(value.sequences).toEqual([0, 1]);
					expect(value.next).toBe(2);
					expect(value.outboxCount).toBe(2);
				} else if (caseId === "reserved-ack-interposition") {
					expect(value.exactDefinedNativeDeltas).toBe(true);
					expect(value.refused).toMatchObject({
						code: "ISSUANCE_RETRY_REQUIRED",
						message: "native issuance reserved currency changed",
					});
					expect(value.refusalCryptoEntries).toBe(0);
					expect(value.phases).toEqual([
						"reserved-put-success",
						"original-foreign-ack-invoked",
						"reserved-currency-refused",
						"original-foreign-ack-joined",
					]);
					expect(value.debt).toEqual({ next: 1, phase: "reserved", sequence: 1 });
					expect(value.priorOutbox).toEqual([{ sequence: 0, state: "published" }]);
					expect(value.continuation).toEqual({ addedCrypto: 1, sequence: 1, next: 2, outboxCount: 2 });
				} else {
					expect(value.refusalCryptoEntries).toBe(0);
					expect(value.wholeNativeUnchanged).toBe(true);
					if (caseId === "malformed-pair") {
						expect(value.refused).toMatchObject({ code: "ISSUANCE_INVALID_ARGUMENT" });
						expect(value.continuation).toBeUndefined();
					} else {
						expect(value.refused).toMatchObject(
							caseId === "inherited-entered-stale"
								? {
										code: "ISSUANCE_OUTCOME_UNKNOWN",
										cause: "DurableIssuanceError: native issuance quote currency changed",
									}
								: { code: "ISSUANCE_RETRY_REQUIRED", message: "native issuance quote currency changed" }
						);
						expect(value.continuation).toEqual({
							addedCrypto: 1,
							sequence: caseId === "rows-stale" ? 1 : 0,
							next: caseId === "rows-stale" ? 2 : 1,
							outboxCount: caseId === "rows-stale" ? 2 : 1,
						});
					}
				}
				expect(value.cleanup).toEqual(
					caseId === "reserved-ack-interposition"
						? ["fulfilled", "fulfilled", "fulfilled", "database:deleted"]
						: ["fulfilled", "fulfilled", "database:deleted"]
				);
			} finally {
				server.revoke(new URL(url).pathname.split("/")[2] ?? "");
			}
		}
	);
}

test("R8 foreign SAME-intent completion preserves consumed-ordinal uncertainty before selected crypto", async ({
	page,
}, info) => {
	const url = server.issueTransitionURL("phase-2l-b.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lBR8ForeignCompletion === "function");
		const result = (await page.evaluate(() => window.phase2lBR8ForeignCompletion())) as JsonRecord;
		await info.attach("r8-foreign-same-intent-completion", {
			body: JSON.stringify(result),
			contentType: "application/json",
		});
		expect(result.ok, JSON.stringify(result)).toBe(true);
		const value = result.value as JsonRecord;
		expect(value.refusal).toMatchObject({
			code: "ISSUANCE_OUTCOME_UNKNOWN",
			cause: "DurableIssuanceError: unsigned intent marker changed",
		});
		expect(value.selectedCrypto).toBe(0);
		expect(value.foreignCrypto).toBe(1);
		expect(value.wholeNativeUnchanged).toBe(true);
		expect(value.phases).toEqual([
			"reserved-native-complete-delivery-held",
			"foreign-same-intent-new-joined",
			"reserved-completion-delivered",
			"selected-refusal-joined",
		]);
		expect(value.foreignNew).toEqual({ sequence: 0, next: 1, outboxCount: 1, digestMatches: true });
		expect(value.cleanup).toEqual(["fulfilled", "fulfilled", "database:deleted"]);
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
});

test("R8 same native held census reuses bounded facts without crossing copies limits objects or release", async ({ page }, info) => {
	const url = server.issueTransitionURL("phase-2l-b.html");
	try {
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2lBR8HeldCensusFacts === "function");
		const result = (await page.evaluate(() => window.phase2lBR8HeldCensusFacts())) as JsonRecord;
		await info.attach("r8-same-held-native-census-facts", { body: JSON.stringify(result), contentType: "application/json" });
		expect(result.ok, JSON.stringify(result)).toBe(true);
		const value = result.value as JsonRecord;
		const seed = value.seedWork as JsonRecord, repeated = value.repeatCensusWork as JsonRecord;
		for (const phase of ["unheldBefore", "unheldAfter"] as const) {
			expect(value[phase]).toEqual({ rows: 3, imageMatches: true, rowsetMatches: true, controlMatches: true, signature: true });
			const work = value[phase + "Work"] as JsonRecord;
			expect(work.transactions).toHaveLength(1);
			expect(work.completedTransactions).toEqual(work.transactions); // Actual native complete, not a synthetic join.
			expect(work.abortedTransactions).toEqual([]);
			expect(work.cursorRows).toEqual({ lineages: 1, issuedRecords: 3, issuanceOutbox: 3, settlementPlans: 1 });
			expect(work.calls).toEqual({ "count:lineages": 1, "count:issuedRecords": 1, "count:issuanceOutbox": 1, "count:settlementPlans": 1,
				"openCursor:lineages": 1, "openCursor:issuedRecords": 1, "openCursor:issuanceOutbox": 1, "openCursor:settlementPlans": 1, "get:retirementControls": 1 });
			expect(work.transactions).not.toEqual(seed.transactions); // No held-image credit crosses native transaction identity.
		}
		expect((value.unheldBeforeWork as JsonRecord).transactions).not.toEqual((value.unheldAfterWork as JsonRecord).transactions);
		expect(seed.cursorRows).toEqual({ lineages: 1, issuedRecords: 3, issuanceOutbox: 3, settlementPlans: 1 });
		expect(seed.transactions).toHaveLength(1);
		expect(repeated.transactions).toEqual(seed.transactions);
		expect(repeated.cursorRows).toEqual({});
		const repeatCalls = repeated.calls as Record<string, number>;
		expect(Object.entries(repeatCalls).filter(([key]) => /^(count|openCursor|getAll|getAllKeys):/u.test(key))).toEqual([]);
		expect(repeatCalls["get:retirementControls"]).toBe(1); // Fresh native control, not cached authority.
		const pointWork = value.pointPlanLineageWork as JsonRecord;
		expect(pointWork.transactions).toEqual(seed.transactions);
		expect(pointWork.calls).toEqual({}); // getKey currency/lifetime work is intentionally not removed/count-credited.
		expect(value.copyIsolation).toMatchObject({ census: true, control: true, point: true, plan: true, lineage: true, signature: true });
		expect(value.pages).toEqual({ next: [2], isolated: true });
		expect((value.firstPageWork as JsonRecord).cursorRows).toEqual({ lineages: 2, issuedRecords: 4, issuanceOutbox: 4 });
		expect(value.otherObject).toEqual({ rows: 1, differentImage: true, signature: true });
		expect((value.otherObjectWork as JsonRecord).cursorRows).toEqual({ lineages: 1, issuedRecords: 1, issuanceOutbox: 1 });
		expect(value.lowerRows).toMatchObject({ code: "ISSUANCE_RETRY_REQUIRED" });
		expect(value.lowerBytes).toMatchObject({ code: "ISSUANCE_SUBSTRATE_FAILURE", retryClass: "transient" }); // Original read boundary maps the smaller-limit codec refusal.
		expect(value.limitsPreserve).toBe(true);
		expect(value.readOnlyNativeUnchanged).toBe(true);
		expect(value.readControlsZeroCrypto).toBe(true);
		expect(value.readControlsNativeUnchanged).toBe(true);
		const controls = value.joinedControls as JsonRecord[];
		expect(controls.map(row => row.mode)).toEqual(["release", "abort", "close"]);
		for (const row of controls) {
			expect(row.midpoint).toMatchObject({ stopJoined: false, readDelivered: false });
			expect((row.admission as JsonRecord).code).not.toBe("RESOLVED");
			expect((row.admissionWork as JsonRecord).calls).toEqual({});
			expect(row.stopJoined).toBe(true); expect(row.writerRead).toBe(true);
			if (row.mode === "close") {
				expect((row.midpoint as JsonRecord).writerRead).toBe(false);
				expect(row.read).toMatchObject({ code: "ISSUANCE_STORE_CLOSED" });
			} // Release/abort joins admitted work; no stronger cancellation policy is inferred.
		}
		expect(value.refresh).toEqual({ sequence: 3, rows: 4, next: 4, newImage: true, published: true, oneNewSignature: true, signature: true });
		expect(value.sameConnectionRefresh).toEqual({ rows: 4, newImage: true, published: true });
		expect((value.sameConnectionRefreshWork as JsonRecord).cursorRows).toEqual({ lineages: 1, issuedRecords: 4, issuanceOutbox: 4, settlementPlans: 1 });
		expect((value.refreshWork as JsonRecord).cursorRows).toEqual({ lineages: 1, issuedRecords: 4, issuanceOutbox: 4, settlementPlans: 1 });
		expect(value.actualNativeWrite).toBe(true);
		expect(value.continuation).toEqual({ sequence: 4, signature: true });
		expect(value.foreignExcluded).toEqual({ foreignRead: false, foreignCommitted: false });
		expect(value.foreignCorruption).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		expect(value.foreignSticky).toMatchObject({ code: "ISSUANCE_RECOVERY_CORRUPT" });
		expect(Object.values((value.foreignScanWork as JsonRecord).cursorRows as Record<string, number>).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
		expect(value.cryptoEntries).toBe(6);
		expect(value.cleanup).toEqual(["reservation:joined", "store:joined", "database:deleted"]);
	} finally {
		server.revoke(new URL(url).pathname.split("/")[2] ?? "");
	}
});

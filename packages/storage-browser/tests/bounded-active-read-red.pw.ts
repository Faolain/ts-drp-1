import { expect, test } from "@playwright/test";

import { server } from "../../../tests/fixtures/bounded-active-read/browser-server.js";
import { type Case, CASES, IDB_KEYS } from "../../../tests/fixtures/bounded-active-read/contract.js";

let served: Awaited<ReturnType<typeof server>>;
test.beforeAll(async () => {
	served = await server();
});
test.afterAll(async () => {
	await served?.close();
});

test("native public no-settlement close retains genuine filtered issuance source", async ({ page }, info) => {
	page.on("pageerror", (error) => console.error("SOURCE_FACADE_HANDOFF_ENTRY:" + error.stack));
	await page.goto(served.origin + "/producer");
	await page.waitForFunction(() => Reflect.has(globalThis, "boundedCreatorFacadeHandoff"));
	const result = await page.evaluate(
		async () => await Reflect.get(globalThis, "boundedCreatorFacadeHandoff")("source-facade-" + crypto.randomUUID())
	);
	await info.attach("native-public-source-facade-handoff", {
		body: JSON.stringify(result, null, 2),
		contentType: "application/json",
	});
	expect(result).toMatchObject({
		passed: true,
		failed: false,
		profile: "creator-trusted-v1",
		transportAndHostFloorFixturePremises: true,
	});
	expect(result.milestones.map((m: { site: string }) => m.site)).toEqual([
		"issue0", "close0", "adopt1", "issue1", "close1", "adopt2", "issue2", "before-close2", "close2",
	]);
	expect(result.cleanup).toEqual([{ owner: "room", status: "fulfilled" }]);
});

test("native public pool turnover commits one source-bound durable retirement intent", async ({ page }, info) => {
	page.on("pageerror", error => console.error("PUBLIC_RETIREMENT_INTENT_ENTRY:" + error.stack));
	await page.goto(served.origin + "/producer");
	await page.waitForFunction(() => Reflect.has(globalThis, "boundedCreatorFacadeHandoff"));
	const result = await page.evaluate(async () => await Reflect.get(globalThis, "boundedCreatorFacadeHandoff")(
		"public-retirement-intent-" + crypto.randomUUID(), 4, false, false, false, true
	));
	await info.attach("native-public-retirement-intent", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
	expect(result).toMatchObject({ passed: true, failed: false, profile: "creator-trusted-v1",
		nativeFloorOriginCustody: true, independentAntiRollback: false,
		durableRetirement: { protectedBytesPreserved: true, stableFloorPreserved: true,
			preexistingSnapshotTurnoverDistinct: true, continuation: { authority: { epoch: 5 } } } });
	expect(result.milestones.map((row: { site: string }) => row.site)).toEqual([
		"issue0", "close0", "adopt1", "issue1", "close1", "adopt2", "issue2", "close2", "adopt3", "issue3",
		"close3", "adopt4", "issue4", "before-close4", "close4", "durable-retirement-native-readback",
		"durable-retirement-ordinary-continuation",
	]);
	expect(result.cleanup).toEqual([{ owner: "room", status: "fulfilled" }, { owner: "snapshot-observer", status: "fulfilled" }, { owner: "native-floor", status: "fulfilled" }]);
});

test("native public no-settlement pool turnover retains genuine filtered issuance custody", async ({ page }, info) => {
	page.on("pageerror", (error) => console.error("SOURCE_FACADE_TURNOVER_ENTRY:" + error.stack));
	await page.goto(served.origin + "/producer");
	await page.waitForFunction(() => Reflect.has(globalThis, "boundedCreatorFacadeHandoff"));
	const result = await page.evaluate(
		async () => await Reflect.get(globalThis, "boundedCreatorFacadeHandoff")("source-facade-turnover-" + crypto.randomUUID(), 4)
	);
	await info.attach("native-public-source-facade-turnover", {
		body: JSON.stringify(result, null, 2), contentType: "application/json",
	});
	expect(result).toMatchObject({ passed: true, failed: false, profile: "creator-trusted-v1", transportAndHostFloorFixturePremises: true, nativeFloorOriginCustody: true, independentAntiRollback: false });
	expect(result.milestones.map((m: { site: string }) => m.site)).toEqual([
		"issue0", "close0", "adopt1", "issue1", "close1", "adopt2", "issue2", "close2", "adopt3", "issue3", "close3", "adopt4", "issue4", "before-close4", "close4",
	]);
	expect(result.cleanup).toEqual([{ owner: "room", status: "fulfilled" }, { owner: "snapshot-observer", status: "fulfilled" }, { owner: "native-floor", status: "fulfilled" }]);
});

test("native public pool turnover refuses invalid retained epoch-one vote signature", async ({ page }, info) => {
	page.on("pageerror", (error) => console.error("HISTORICAL_SIGNATURE_ENTRY:" + error.stack));
	await page.goto(served.origin + "/producer");
	await page.waitForFunction(() => Reflect.has(globalThis, "boundedCreatorFacadeHandoff"));
	const result = await page.evaluate(
		async () => await Reflect.get(globalThis, "boundedCreatorFacadeHandoff")("historical-signature-" + crypto.randomUUID(), 4, true)
	);
	await info.attach("native-public-historical-signature-refusal", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
	expect(result).toMatchObject({ passed: true, failed: false, profile: "creator-trusted-v1",
		nativeFloorOriginCustody: true, independentAntiRollback: false,
		historicalSignatureNegative: { originalEpoch: 1, phase: "prepare", originalValid: true, corruptedValid: false,
			refused: true, mutationJoined: true, restoreJoined: true } });
	expect(result.milestones.map((m: { site: string }) => m.site)).toEqual([
		"issue0", "close0", "adopt1", "issue1", "close1", "adopt2", "issue2", "close2", "adopt3", "issue3", "close3", "adopt4", "issue4", "before-close4", "close4-refused",
	]);
	expect(result.historicalSignatureNegative.after).toEqual(result.historicalSignatureNegative.before);
	expect(result.cleanup).toEqual([{ owner: "room", status: "fulfilled" }, { owner: "snapshot-observer", status: "fulfilled" }, { owner: "native-floor", status: "fulfilled" }]);
});

test("native public pool turnover refuses undiscovered object-level settlement plan", async ({ page }, info) => {
	page.on("pageerror", (error) => console.error("UNMATCHED_PLAN_ENTRY:" + error.stack));
	await page.goto(served.origin + "/producer");
	await page.waitForFunction(() => Reflect.has(globalThis, "boundedCreatorFacadeHandoff"));
	const result = await page.evaluate(
		async () => await Reflect.get(globalThis, "boundedCreatorFacadeHandoff")("unmatched-plan-" + crypto.randomUUID(), 4, false, true)
	);
	await info.attach("native-public-unmatched-plan-refusal", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
	expect(result).toMatchObject({ passed: true, failed: false, profile: "creator-trusted-v1",
		nativeFloorOriginCustody: true, independentAntiRollback: false,
		unmatchedPlanNegative: { mechanicalDebtNotAuthenticatedSource: true, refused: true } });
	expect(result.milestones.map((m: { site: string }) => m.site)).toEqual([
		"issue0", "close0", "adopt1", "issue1", "close1", "adopt2", "issue2", "close2", "adopt3", "issue3", "close3", "adopt4", "issue4", "before-close4", "close4-unmatched-plan-result",
	]);
	expect(result.unmatchedPlanNegative.after).toEqual(result.unmatchedPlanNegative.before);
	expect(result.cleanup).toEqual([{ owner: "room", status: "fulfilled" }, { owner: "snapshot-observer", status: "fulfilled" }, { owner: "native-floor", status: "fulfilled" }, { owner: "issuance-observer", status: "fulfilled" }]);
});

test("native public pool turnover succeeds after held noncreating object issuance census", async ({ page }, info) => {
	page.on("pageerror", (error) => console.error("OBJECT_CENSUS_POSITIVE_ENTRY:" + error.stack));
	await page.goto(served.origin + "/producer");
	await page.waitForFunction(() => Reflect.has(globalThis, "boundedCreatorFacadeHandoff"));
	const result = await page.evaluate(
		async () => await Reflect.get(globalThis, "boundedCreatorFacadeHandoff")("object-census-positive-" + crypto.randomUUID(), 4, false, false, true)
	);
	await info.attach("native-public-object-census-positive", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
	expect(result).toMatchObject({ passed: true, failed: false, profile: "creator-trusted-v1",
		nativeFloorOriginCustody: true, independentAntiRollback: false,
		nativeCensusPositive: { heldCheck: true, noncreating: true, releaseJoined: true, afterReleaseRefused: true } });
	expect(result.milestones.map((m: { site: string }) => m.site)).toEqual([
		"issue0", "close0", "adopt1", "issue1", "close1", "adopt2", "issue2", "close2", "adopt3", "issue3", "close3", "adopt4", "issue4", "before-close4", "native-object-census-held-and-released", "close4",
	]);
	expect(result.nativeCensusPositive.after).toEqual(result.nativeCensusPositive.before);
	const completed = result.milestones.find((m: { site: string }) => m.site === "close4");
	expect(completed).toMatchObject({
		closed: { ok: true, epoch: 4, successorEpoch: 5, lifecycle: "successor-pending-adoption" },
		pool: { recoveryScopes: 3, limits: { maxRecoveryScopes: 4 }, migration: "ready" },
	});
	expect(result.cleanup).toEqual([{ owner: "room", status: "fulfilled" }, { owner: "snapshot-observer", status: "fulfilled" }, { owner: "native-floor", status: "fulfilled" }, { owner: "issuance-observer", status: "fulfilled" }]);
});

test("native public room close activates and issues after completed AHE floor", async ({ page }, info) => {
	page.on("pageerror", (error) => console.error("COMPLETED_FLOOR_ROOM_ENTRY:" + error.stack));
	await page.goto(served.origin + "/producer");
	await page.waitForFunction(() => Reflect.has(globalThis, "boundedAheCompletedFloorRoom"));
	const result = await page.evaluate(
		async () =>
			await Reflect.get(globalThis, "boundedAheCompletedFloorRoom")("completed-floor-room-" + crypto.randomUUID())
	);
	await info.attach("native-public-room-completed-floor", {
		body: JSON.stringify(result, null, 2),
		contentType: "application/json",
	});
	expect(result).toMatchObject({
		passed: true,
		failed: false,
		mechanicalCheckpointNotAllOwnerAuthority: true,
		transportAndHostFloorFixturePremises: true,
	});
	expect(result.milestones.map((m: { site: string }) => m.site)).toEqual([
		"completed-before-public-close",
		"public-close-returned",
		"public-adopt-activated",
		"next-public-issue",
	]);
	expect(result.cleanup).toEqual([
		{ owner: "room", status: "fulfilled" },
		{ owner: "preopened-ahe", status: "fulfilled" },
		{ owner: "fresh-ahe", status: "fulfilled" },
	]);
});

test("native public room retries exact nominee after withheld stage readback", async ({ page }, info) => {
	page.on("pageerror", (error) => console.error("COMPLETED_FLOOR_RETRY_ENTRY:" + error.stack));
	await page.goto(served.origin + "/producer");
	await page.waitForFunction(() => Reflect.has(globalThis, "boundedAheCompletedFloorRoom"));
	const result = await page.evaluate(
		async () =>
			await Reflect.get(globalThis, "boundedAheCompletedFloorRoom")(
				"completed-floor-retry-" + crypto.randomUUID(),
				true
			)
	);
	await info.attach("native-public-room-completed-floor-retry", {
		body: JSON.stringify(result, null, 2),
		contentType: "application/json",
	});
	expect(result).toMatchObject({
		passed: true,
		failed: false,
		withheldStageReadback: true,
		mechanicalCheckpointNotAllOwnerAuthority: true,
		transportAndHostFloorFixturePremises: true,
	});
	expect(result.milestones.map((m: { site: string }) => m.site)).toEqual([
		"completed-before-public-close",
		"public-close-returned",
		"first-stage-readback-withheld",
		"exact-nominee-resumed",
		"public-adopt-activated",
		"next-public-issue",
	]);
	expect(result.cleanup).toEqual([
		{ owner: "room", status: "fulfilled" },
		{ owner: "preopened-ahe", status: "fulfilled" },
		{ owner: "fresh-ahe", status: "fulfilled" },
	]);
});

test("native AHE bound completion fences preopened and fresh facades", async ({ page }, info) => {
	await page.goto(served.origin);
	await page.waitForFunction(() => Reflect.has(globalThis, "retirementBoundCompletion"));
	const result = await page.evaluate(
		async () =>
			await Reflect.get(globalThis, "retirementBoundCompletion")("ahe-bound-completion-" + crypto.randomUUID())
	);
	await info.attach("native-bound-completion", {
		body: JSON.stringify(result, null, 2),
		contentType: "application/json",
	});
	expect(result.incomplete).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
	expect(result.wrongDecision).toEqual({ ok: false, reason: "ILLEGAL_TRANSITION" });
	expect(result.forged).toEqual({ ok: false, reason: "INVALID_ARGUMENT" });
	expect(result.preopened).toEqual({ ok: false, reason: "RETIREMENT_FENCED" });
	expect(result.fresh).toEqual({ ok: false, reason: "RETIREMENT_FENCED" });
	expect(result.page.generations).toHaveLength(1);
	expect(result.completed.completed.generationIdentities).toHaveLength(1);
	expect(result.completed.kind).toBe("ahe-retirement-control-3");
	expect(result.completed.completed.throughEpoch).toBe(0);
});

test("native retirement image CAS refuses valid foreign rows with unchanged head and control", async ({
	page,
}, info) => {
	await page.goto(served.origin);
	await page.waitForFunction(() => Reflect.has(globalThis, "retirementImageCAS"));
	for (const mutation of ["unchanged", "generation", "promotion", "cached-blob"] as const) {
		const result = await page.evaluate(
			async ({ name, mutation }) => {
				const run = Reflect.get(globalThis, "retirementImageCAS") as (
					name: string,
					mutation: string
				) => Promise<unknown>;
				return run(name, mutation);
			},
			{ name: "native-retirement-image-" + crypto.randomUUID(), mutation }
		);
		await info.attach(`native-retirement-image-${mutation}`, {
			body: JSON.stringify(result),
			contentType: "application/json",
		});
		expect(result).toMatchObject({ headUnchanged: true });
		if (mutation === "unchanged")
			expect(result).toMatchObject({ result: { ok: true, value: { active: { phase: "prepared" } } } });
		else
			expect(result).toMatchObject({ result: { ok: false, reason: "READ_STALE_ROLE_VIEW" }, controlUnchanged: true });
	}
});
for (const settlement of [false, true]) {
	test(`genuine producer native data control ${settlement ? "settlement-normalized" : "unpruned-seven"}`, async ({
		page,
	}, info) => {
		await page.goto(served.origin + "/producer");
		await page.waitForFunction(() => Reflect.has(globalThis, "boundedAheProducer"));
		const data = await page.evaluate(
			async ({ identity, settlement }) =>
				(Reflect.get(globalThis, "boundedAheProducer") as (id: string, settlement: boolean) => Promise<unknown>)(
					identity,
					settlement
				),
			{ identity: "bounded-ahe-producer-" + crypto.randomUUID(), settlement }
		);
		await info.attach("genuine-producer-data-observation-NOT-API-green", {
			body: JSON.stringify(data),
			contentType: "application/json",
		});
		// Empirical correction: the actual shipped create path has an extra genesis live-projection head.
		// Original1/3/5/7 oracle and failed reports are archived unchanged; G7 is never raised.
		expect(data).toMatchObject({
			dataObservationOnly: true,
			settlement,
			counts: settlement ? [2, 3, 3, 3] : [2, 4, 6, 8],
		});
	});
	test(`genuine producer fresh-realm bounded read ${settlement ? "normalized-oldest" : "valid-eight-row-budget-refusal"}`, async ({
		page,
		context,
	}, info) => {
		await page.goto(served.origin + "/producer");
		await page.waitForFunction(() => Reflect.has(globalThis, "boundedAheProducer"));
		const data = await page.evaluate(
			async ({ identity, settlement }) =>
				(
					Reflect.get(globalThis, "boundedAheProducer") as (
						id: string,
						settlement: boolean
					) => Promise<{ identity: string; objectId: string; selectedIds: string[]; settlement: boolean }>
				)(identity, settlement),
			{ identity: "bounded-ahe-genuine-read-" + crypto.randomUUID(), settlement }
		);
		await info.attach("genuine-producer-before-close", { body: JSON.stringify(data), contentType: "application/json" });
		await page.close();
		const fresh = await context.newPage();
		try {
			await fresh.goto(served.origin + "/producer");
			await fresh.waitForFunction(() => Reflect.has(globalThis, "boundedAheGenuineRead"));
			const result = await fresh.evaluate(
				async (data) =>
					(
						Reflect.get(globalThis, "boundedAheGenuineRead") as (
							id: string,
							objectId: string,
							ids: string[],
							settlement: boolean
						) => Promise<unknown>
					)(data.identity, data.objectId, data.selectedIds, data.settlement),
				data
			);
			await info.attach("genuine-native-read-or-wiring", {
				body: JSON.stringify(result),
				contentType: "application/json",
			});
			expect(result).toMatchObject({ passed: true });
		} finally {
			await fresh.close();
		}
	});
}
for (const selected of [...CASES, ...IDB_KEYS])
	test(`bounded AHE fresh-realm ${selected}`, async ({ context, page }, info) => {
		const name = "bounded-active-read-" + crypto.randomUUID();
		await page.goto(served.origin);
		await page.waitForFunction(() => Reflect.has(globalThis, "boundedAheSetup"));
		const proof = await page.evaluate(
			async ({ name, selected }) =>
				(Reflect.get(globalThis, "boundedAheSetup") as (name: string, selected: Case) => Promise<unknown>)(
					name,
					selected
				),
			{ name, selected }
		);
		await info.attach("native-setup-control", { body: JSON.stringify(proof), contentType: "application/json" });
		await page.close(); // All setup clients closed; fresh realm owns only identity/case, no generation/blob expectations.
		const fresh = await context.newPage();
		try {
			await fresh.goto(served.origin);
			await fresh.waitForFunction(() => Reflect.has(globalThis, "boundedAheRun"));
			const result = await fresh.evaluate(
				async ({ name, selected }) =>
					(Reflect.get(globalThis, "boundedAheRun") as (name: string, selected: Case) => Promise<unknown>)(
						name,
						selected
					),
				{ name, selected }
			);
			await info.attach("native-product-or-wiring-red", {
				body: JSON.stringify(result),
				contentType: "application/json",
			});
			expect(result).toMatchObject({ case: selected, passed: true });
		} finally {
			await fresh.evaluate(
				(name) => (Reflect.get(globalThis, "boundedAheDelete") as (name: string) => Promise<unknown>)(name),
				name
			);
			await fresh.close();
		}
	});

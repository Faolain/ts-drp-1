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

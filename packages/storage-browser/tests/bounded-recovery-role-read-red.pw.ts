import { expect, test } from "@playwright/test";

import { server } from "../../../tests/fixtures/bounded-active-read/browser-server.js";
import { ROLE_CASES, type RoleCase, supported } from "../../../tests/fixtures/bounded-active-read/role-contract.js";

let served: Awaited<ReturnType<typeof server>>;
test.beforeAll(async () => {
	served = await server("role");
});
test.afterAll(async () => {
	await served?.close();
});
for (const selected of ["burst-and-completed-boundary", "release", "abort", "close", "sequential-and-views"] as const)
	test(`native reservation future point ${selected}`, async ({page}, info) => {
		const name = "bounded-future-point-" + crypto.randomUUID();
		await page.goto(served.origin + "/role");
		await page.waitForFunction(() => Reflect.has(globalThis, "boundedHeldFuturePoint"));
		try {
			await page.evaluate(async name => Reflect.get(globalThis, "boundedRoleSetup")(name, "whole-view"), name);
			const result = await page.evaluate(async ({name, selected}) =>
				Reflect.get(globalThis, "boundedHeldFuturePoint")(name, selected), {name, selected});
			await info.attach("native-reservation-future-point", {body: JSON.stringify(result), contentType: "application/json"});
			expect(result).toMatchObject({selected, passed: true, emergency: false});
		} finally {await page.evaluate(async name => Reflect.get(globalThis, "boundedRoleDelete")(name), name);}
	});
for (const selected of ["role", "active", "borrowed-mutation", "optional-corruption", "optional-oversize",
	"replacement-corruption", "foreign-object", "abort"] as const)
	test(`bounded recovery held capture overlap ${selected}`, async ({page}, info) => {
		const name = "bounded-held-capture-" + crypto.randomUUID();
		await page.goto(served.origin + "/role");
		await page.waitForFunction(() => Reflect.has(globalThis, "boundedHeldCaptureOverlap"));
		try {
			await page.evaluate(async name => Reflect.get(globalThis, "boundedRoleSetup")(name, "whole-view"), name);
			const result = await page.evaluate(async ({name, selected}) =>
				Reflect.get(globalThis, "boundedHeldCaptureOverlap")(name, selected), {name, selected});
			await info.attach("native-held-capture-overlap", {body: JSON.stringify(result), contentType: "application/json"});
			expect(result).toMatchObject({selected, passed: true});
		} finally {await page.evaluate(async name => Reflect.get(globalThis, "boundedRoleDelete")(name), name);}
	});
for (const selected of ["repeat-and-mutation", "replacement-and-corruption", "abort", "close"] as const)
	test(`bounded recovery role exact held currency ${selected}`, async ({page}, info) => {
		const name = "bounded-held-role-" + crypto.randomUUID();
		await page.goto(served.origin + "/role");
		await page.waitForFunction(() => Reflect.has(globalThis, "boundedHeldRoleCurrency"));
		try {
			await page.evaluate(async name => Reflect.get(globalThis, "boundedRoleSetup")(name, "whole-view"), name);
			const result = await page.evaluate(async ({name, selected}) =>
				Reflect.get(globalThis, "boundedHeldRoleCurrency")(name, selected), {name, selected});
			await info.attach("native-exact-held-currency", {body: JSON.stringify(result), contentType: "application/json"});
			expect(result).toMatchObject({selected, passed: true});
		} finally {
			await page.evaluate(async name => Reflect.get(globalThis, "boundedRoleDelete")(name), name);
		}
	});
for (const selected of ROLE_CASES.filter((name) => supported(name, "idb")))
	test(`bounded recovery role fresh realm ${selected}`, async ({ context, page }, info) => {
		const name = "bounded-recovery-role-" + crypto.randomUUID();
		await page.goto(served.origin + "/role");
		await page.waitForFunction(() => Reflect.has(globalThis, "boundedRoleSetup"));
		const setup = await page.evaluate(
			async ({ name, selected }) =>
				(Reflect.get(globalThis, "boundedRoleSetup") as (name: string, selected: RoleCase) => Promise<unknown>)(
					name,
					selected
				),
			{ name, selected }
		);
		await info.attach("native-producer-closed", { body: JSON.stringify(setup), contentType: "application/json" });
		await page.close();
		const fresh = await context.newPage();
		try {
			await fresh.goto(served.origin + "/role");
			await fresh.waitForFunction(() => Reflect.has(globalThis, "boundedRoleRun"));
			const result = await fresh.evaluate(
				async ({ name, selected }) =>
					(Reflect.get(globalThis, "boundedRoleRun") as (name: string, selected: RoleCase) => Promise<unknown>)(
						name,
						selected
					),
				{ name, selected }
			);
			await info.attach("native-product-or-wiring-red", {
				body: JSON.stringify(result),
				contentType: "application/json",
			});
			console.log(JSON.stringify({ engine: info.project.name, case: selected, result }));
			expect(result).toMatchObject({ case: selected, passed: true, downstreamExecuted: true });
		} finally {
			await fresh.evaluate(
				(name) => (Reflect.get(globalThis, "boundedRoleDelete") as (name: string) => Promise<unknown>)(name),
				name
			);
			await fresh.close();
			console.log(
				JSON.stringify({ engine: info.project.name, case: selected, nativeDeleteJoined: true, freshRealmClosed: true })
			);
		}
	});

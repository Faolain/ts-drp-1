/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await -- Page evaluation forwards genuine async fixture functions unchanged. */
import type { BrowserContext, Page } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { browserServer } from "./browser-server.js";
import { ownedTest } from "./ownership.js";
import {
	assertRoleObservation,
	extraCases,
	negativeCases,
	positiveCases,
	type RoleBootstrap,
	type RoleConfig,
	type RoleFault,
	type RoleOracle,
	type RoleReport,
} from "./role-assertions.js";
const artifacts = process.env.ROLLBACK_ARTIFACTS;
if (!artifacts) throw Error("ROLLBACK_ARTIFACTS_REQUIRED");
let server: Awaited<ReturnType<typeof browserServer>>;
const test = ownedTest(() => server.origin);
test.beforeAll(async () => {
	server = await browserServer(artifacts, true);
});
test.afterAll(async () => {
	await server.close();
});
const cases = [...positiveCases.map((c) => ({ ...c, fault: "none" as RoleFault })), ...negativeCases, ...extraCases];
async function produce(
	context: BrowserContext,
	cleanupOwner: {
		register(identity: string, epochs: number): Promise<void>;
		closeWork(page: Page): Promise<void>;
	},
	config: RoleConfig
) {
	const identity = "protected-role-" + randomUUID();
	await cleanupOwner.register(identity, config.epoch);
	const page = await context.newPage();
	await page.goto(server.origin + "/setup");
	await page.waitForFunction(() => typeof Reflect.get(globalThis, "roleSetup") === "function");
	const installed = (await page.evaluate(
		async ({ identity, config }) => Reflect.get(globalThis, "roleSetup")(identity, config),
		{ identity, config }
	)) as { realm: number; bootstrap: RoleBootstrap; oracle: RoleOracle; cleanup: unknown };
	await cleanupOwner.closeWork(page);
	return installed;
}
test("genuine native reachability pending n1 published settlement (no Node role claim)", async ({
	context,
	cleanupOwner,
}, info) => {
	const installed = await produce(context, cleanupOwner, {
		epoch: 2,
		profile: "creator-trusted-settlement-v1",
		stop: "already-published",
	});
	assert.equal(installed.oracle.pending?.publication, "already-published");
	assert.equal(installed.oracle.preconditions.length, 2);
	assert.ok(installed.oracle.preconditions.every((p) => p.early && p.deferred));
	assert.notEqual(
		installed.oracle.current.snapshot?.payloadDigest,
		installed.oracle.pending?.role.snapshot?.payloadDigest
	);
	await info.attach("native-role-reachability", { body: JSON.stringify(installed), contentType: "application/json" });
});
for (const { name, config, fault } of cases)
	test("whole role observation: " + name, async ({ context, cleanupOwner }, info) => {
		const installed = await produce(context, cleanupOwner, config);
		const page = await context.newPage();
		await page.goto(server.origin + "/recovery");
		await page.waitForFunction(() => typeof Reflect.get(globalThis, "roleRecover") === "function");
		const value = (await page.evaluate(async ({ b, fault }) => Reflect.get(globalThis, "roleRecover")(b, fault), {
			b: installed.bootstrap,
			fault,
		})) as RoleReport & { realm: number };
		assert.notEqual(value.realm, installed.realm);
		await info.attach("fresh-role-result", {
			body: JSON.stringify({ installed, value, artifactsSha256: server.artifactsSha256 }),
			contentType: "application/json",
		});
		assertRoleObservation(value, installed.oracle, fault);
	});

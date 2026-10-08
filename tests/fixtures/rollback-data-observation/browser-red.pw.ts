/* eslint-disable @typescript-eslint/require-await -- Fixture-selected positions follow actual-byte prerequisites; native callback inference is retained. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { assertObservation, assertPresentPrecondition, type ObservationReport } from "./assertions.js";
import { browserServer } from "./browser-server.js";
import { ownedTest } from "./ownership.js";
import { type Bootstrap, type Fault, POSITIVES, type ProducerReport } from "./types.js";
const artifacts = process.env.ROLLBACK_ARTIFACTS;
if (!artifacts) throw new Error("ROLLBACK_ARTIFACTS_REQUIRED");
let server: Awaited<ReturnType<typeof browserServer>>;
const test = ownedTest(() => server.origin);
test.beforeAll(async () => {
	server = await browserServer(artifacts);
});
test.afterAll(async () => {
	await server.close();
});
const cases = [
	...POSITIVES.map((config) => ({ config, fault: "none" as Fault })),
	...(["older-missing-chunk", "older-replaced", "abort-second", "head-stale", "floor-pending"] as const).map(
		(fault) => ({ config: POSITIVES[2], fault })
	),
	...(["forged-old-acl", "wrong-retirement-anchor", "missing-anchor"] as const).map((fault) => ({
		config: POSITIVES[5],
		fault,
	})),
];
for (const { config, fault } of cases)
	test(config.name + ":" + fault, async ({ context, cleanupOwner }, info) => {
		const identity = "rollback-data-" + randomUUID();
		await cleanupOwner.register(identity, config.epoch);
		const setup = await context.newPage();
		await setup.goto(server.origin + "/setup");
		await setup.waitForFunction(() => typeof Reflect.get(globalThis, "rollbackSetup") === "function");
		const installed = (await setup.evaluate(
			async ({ identity, config }) => Reflect.get(globalThis, "rollbackSetup")(identity, config),
			{ identity, config }
		)) as {
			realm: number;
			report: ProducerReport;
			precondition: ObservationReport["precondition"];
			integrity: unknown;
		};
		await info.attach("genuine-setup-precondition", {
			body: JSON.stringify(installed),
			contentType: "application/json",
		});
		assertPresentPrecondition(installed.precondition, config.epoch, installed.report.expectedStates, config.legacy);
		await cleanupOwner.closeWork(setup);
		const recovery = await context.newPage();
		await recovery.goto(server.origin + "/recovery");
		await recovery.waitForFunction(() => typeof Reflect.get(globalThis, "rollbackRecover") === "function");
		const bootstrap: Bootstrap = installed.report.bootstrap;
		const value = (await recovery.evaluate(
			async ({ bootstrap, fault }) => Reflect.get(globalThis, "rollbackRecover")(bootstrap, fault),
			{ bootstrap, fault }
		)) as ObservationReport & { realm: number };
		await info.attach("fresh-recovery-result", {
			body: JSON.stringify({ artifactsSha256: server.artifactsSha256, installedRealm: installed.realm, value }),
			contentType: "application/json",
		});
		assert.notEqual(value.realm, installed.realm);
		assertPresentPrecondition(value.precondition, config.epoch, installed.report.expectedStates, config.legacy);
		assertObservation(value, installed.precondition.targets, fault);
	});

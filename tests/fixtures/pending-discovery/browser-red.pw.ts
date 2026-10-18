import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { assertProbe, assertRecovery } from "./assertions.js";
import { browserServer } from "./browser-server.js";
import { browserAuthProbes, browserCases, type Case, probeModes } from "./roster.js";
import type { OwnerCase, ProbeInput, ProbeReport, RecoveryCase, RecoveryReport, SetupReport } from "./types.js";
declare global {
	interface Window {
		pendingSetup?(identity: string, epoch: 1 | 2, published: boolean, mode: RecoveryCase): Promise<SetupReport>;
		pendingRecover?(bootstrap: SetupReport["bootstrap"], mode: RecoveryCase): Promise<RecoveryReport>;
		pendingProbe?(input: ProbeInput, mode: OwnerCase): Promise<ProbeReport>;
		pendingAuthProbe?(input: ProbeInput, mode: RecoveryCase): Promise<RecoveryReport>;
	}
}
let server: Awaited<ReturnType<typeof browserServer>>;
test.beforeAll(async () => {
	const artifacts = process.env.PENDING_ARTIFACTS;
	if (artifacts === undefined) throw new Error("PENDING_ARTIFACTS");
	server = await browserServer(artifacts);
});
test.afterAll(async () => {
	await server?.close();
});
async function cleanup(context: BrowserContext, pages: Page[], identity: string, epoch: 1 | 2): Promise<void> {
	const closeResults = await Promise.allSettled(pages.map((page) => page.close()));
	const errors = closeResults.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
	let cleanup: Page | undefined;
	const names = [
		identity + "--ahe",
		identity + "--drp-issuance-v1",
		identity + "--drp-live-journal-v1",
		identity + "--drp-snapshot-quarantine-v1",
		...Array.from({ length: epoch }, (_, i) => identity + "--seal-" + i),
	];
	try {
		cleanup = await context.newPage();
		await cleanup.goto(server.origin + "/recovery");
		await cleanup.evaluate(async (names) => {
			const settled = await Promise.allSettled(
				names.map(
					(name) =>
						new Promise<void>((resolve, reject) => {
							const r = indexedDB.deleteDatabase(name);
							r.onsuccess = (): void => resolve();
							r.onerror = (): void => reject(r.error);
							r.onblocked = (): void => reject(new Error("EXACT_NATIVE_CLEANUP_BLOCKED:" + name));
						})
				)
			);
			const failures = settled.flatMap((entry, index) =>
				entry.status === "rejected" ? [{ name: names[index], failure: String(entry.reason) }] : []
			);
			if (failures.length !== 0) throw new Error("EXACT_NATIVE_CLEANUP_FAILED:" + JSON.stringify(failures));
		}, names);
	} catch (error) {
		errors.push(error);
	} finally {
		try {
			await cleanup?.close();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length !== 0) throw new AggregateError(errors, "BROWSER_PENDING_CLEANUP");
	console.log(
		JSON.stringify({
			lane: "native-cleanup",
			identity,
			exactTargets: names,
			setupRecoveryProbePagesClosed: pages.every((page) => page.isClosed()),
			cleanupPageClosed: cleanup?.isClosed(),
			deleteRequestsSettled: true,
		})
	);
}
async function prepare(context: BrowserContext, identity: string, scenario: Case, pages: Page[]): Promise<SetupReport> {
	const setupPage = await context.newPage();
	pages.push(setupPage);
	await setupPage.goto(server.origin + "/setup");
	await setupPage.waitForFunction(() => typeof window.pendingSetup === "function");
	const setup = await setupPage.evaluate(
		async ({ identity, scenario }) => {
			if (window.pendingSetup === undefined) throw new Error("SETUP_ENTRY_MISSING");
			return window.pendingSetup(identity, scenario.epoch, scenario.published, scenario.mode);
		},
		{ identity, scenario }
	);
	expect(setupPage.workers()).toHaveLength(0);
	await setupPage.close();
	expect(setupPage.isClosed()).toBe(true);
	expect(setup.oracle.closeEpochs).toEqual(scenario.epoch === 1 ? [0] : [0, 1]);
	expect(setup.oracle.lookupScope.objectId).toBe(setup.bootstrap.expectedPreviousRoomHead.objectId);
	expect(setup.oracle.lookupScope.epoch).toBe(setup.bootstrap.expectedPreviousRoomHead.epoch);
	expect(setup.oracle.lookupScope.anchor).toBe(setup.bootstrap.expectedPreviousRoomHead.currentAnchorDigest);
	expect((setup.oracle.pendingHead as { generationId: string }).generationId).toBe(
		scenario.published
			? setup.oracle.pendingGenerationId
			: (setup.oracle.proposedHead as { generationId: string }).generationId
	);
	return setup;
}
for (const scenario of browserCases)
	test("IndexedDB declaration-free: " + scenario.id, async ({ context }, info) => {
		const identity = "pending-product-" + info.project.name + "-" + scenario.id + "-" + crypto.randomUUID(),
			pages: Page[] = [];
		let primary: { error: unknown } | undefined;
		try {
			const setup = await prepare(context, identity, scenario, pages),
				page = await context.newPage();
			pages.push(page);
			await page.goto(server.origin + "/recovery");
			await page.waitForFunction(() => typeof window.pendingRecover === "function");
			expect(
				await page.evaluate(() => ({
					setup: typeof window.pendingSetup,
					probe: typeof window.pendingProbe,
					auth: typeof window.pendingAuthProbe,
				}))
			).toEqual({ setup: "undefined", probe: "undefined", auth: "undefined" });
			const report = await page.evaluate(
				async ({ bootstrap, mode }) => {
					if (window.pendingRecover === undefined) throw new Error("RECOVERY_ENTRY_MISSING");
					return window.pendingRecover(bootstrap, mode);
				},
				{
					bootstrap: setup.bootstrap,
					mode: scenario.mode,
				}
			);
			await info.attach("native-restart", {
				body: JSON.stringify({
					lane: "product",
					scenario,
					engine: info.project.name,
					setup,
					report,
					setupPageClosedBeforeRecovery: true,
					setupWorkers: 0,
					artifactsSha256: server.artifactsSha256,
				}),
				contentType: "application/json",
			});
			console.log(
				JSON.stringify({
					lane: "product",
					scenario,
					classification: report.classification,
					result: report.result,
					effects: report.effects,
				})
			);
			try {
				assertRecovery(report, setup, scenario);
			} finally {
				await info.attach("executed-assertions", {
					body: JSON.stringify({
						scenario,
						classification: report.classification,
						downstream: report.downstreamAssertions,
						assertions: report.executedAssertions,
						expectedObservations: report.expectedObservations,
					}),
					contentType: "application/json",
				});
			}
		} catch (error) {
			primary = { error };
		} finally {
			try {
				await cleanup(context, pages, identity, scenario.epoch);
			} catch (error) {
				await info.attach("cleanup-failure", { body: String(error), contentType: "text/plain" });
				if (primary === undefined) primary = { error };
				else
					primary = {
						error: new AggregateError([primary.error, error], "PRIMARY_AND_CLEANUP", { cause: primary.error }),
					};
			}
		}
		if (primary !== undefined) throw primary.error;
	});
for (const mode of probeModes)
	test("IndexedDB direct-owner unmasked: " + mode, async ({ context }, info) => {
		const identity = "pending-owner-" + info.project.name + "-" + mode + "-" + crypto.randomUUID(),
			pages: Page[] = [];
		let primary: { error: unknown } | undefined;
		try {
			const scenario: Case = { id: mode, epoch: 1, published: false, mode },
				setup = await prepare(context, identity, scenario, pages),
				page = await context.newPage();
			pages.push(page);
			await page.goto(server.origin + "/probe");
			await page.waitForFunction(() => typeof window.pendingProbe === "function");
			const report = await page.evaluate(
				async ({ input, mode }) => {
					if (window.pendingProbe === undefined) throw new Error("PROBE_ENTRY_MISSING");
					return window.pendingProbe(input, mode);
				},
				{
					input: {
						bootstrap: setup.bootstrap,
						scope: setup.oracle.lookupScope,
						competingScope: setup.oracle.competingScope,
					},
					mode,
				}
			);
			await info.attach("unmasked-owner-probe", {
				body: JSON.stringify({
					lane: "direct-owner",
					engine: info.project.name,
					setup,
					report,
					setupPageClosedBeforeProbe: true,
				}),
				contentType: "application/json",
			});
			console.log(JSON.stringify({ lane: "direct-owner-unmasked", mode, report }));
			assertProbe(report, mode, setup);
		} catch (error) {
			primary = { error };
		} finally {
			try {
				await cleanup(context, pages, identity, 1);
			} catch (error) {
				primary = {
					error:
						primary === undefined
							? error
							: new AggregateError([primary.error, error], "PRIMARY_AND_CLEANUP", { cause: primary.error }),
				};
			}
		}
		if (primary !== undefined) throw primary.error;
	});
for (const scenario of browserAuthProbes)
	test("IndexedDB RED-baseline instrumentation ONLY: " + scenario.id, async ({ context }, info) => {
		const identity = "pending-instrumentation-" + info.project.name + "-" + scenario.id + "-" + crypto.randomUUID(),
			pages: Page[] = [];
		let primary: { error: unknown } | undefined;
		try {
			const setup = await prepare(context, identity, scenario, pages),
				page = await context.newPage();
			pages.push(page);
			await page.goto(server.origin + "/auth-probe");
			await page.waitForFunction(() => typeof window.pendingAuthProbe === "function");
			const report = await page.evaluate(
				async ({ input, mode }) => {
					if (window.pendingAuthProbe === undefined) throw new Error("AUTH_PROBE_ENTRY_MISSING");
					return window.pendingAuthProbe(input, mode);
				},
				{
					input: {
						bootstrap: setup.bootstrap,
						scope: setup.oracle.lookupScope,
						competingScope: setup.oracle.competingScope,
					},
					mode: scenario.mode,
				}
			);
			await info.attach("RED-baseline-instrumentation-only", {
				body: JSON.stringify({
					lane: "RED_BASELINE_INSTRUMENTATION_ONLY",
					engine: info.project.name,
					scenario,
					setup,
					report,
					setupPageClosedBeforeProbe: true,
				}),
				contentType: "application/json",
			});
			console.log(JSON.stringify({ lane: "RED_BASELINE_INSTRUMENTATION_ONLY", scenario, report }));
			try {
				assertRecovery(report, setup, scenario, true);
			} finally {
				await info.attach("executed-assertions", {
					body: JSON.stringify({
						lane: "RED_BASELINE_INSTRUMENTATION_ONLY",
						scenario,
						classification: report.classification,
						downstream: report.downstreamAssertions,
						assertions: report.executedAssertions,
						expectedObservations: report.expectedObservations,
					}),
					contentType: "application/json",
				});
			}
		} catch (error) {
			primary = { error };
		} finally {
			try {
				await cleanup(context, pages, identity, scenario.epoch);
			} catch (error) {
				primary = {
					error:
						primary === undefined
							? error
							: new AggregateError([primary.error, error], "PRIMARY_AND_CLEANUP", { cause: primary.error }),
				};
			}
		}
		if (primary !== undefined) throw primary.error;
	});

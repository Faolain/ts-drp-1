import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { requireValue } from "./assert.js";
import { server as startServer } from "./server.js";
import type { Bootstrap, Fault, RecoveryFault, Report, Scenario, SetupReport } from "./types.js";
declare global {
	interface Window {
		startupShippedChat(
			identity: string,
			invite?: string
		): Promise<{ invite: string; before: unknown; after: unknown; trace: Report["trace"] }>;
		startupShippedGrid(
			identity: string,
			invite?: string
		): Promise<{ invite: string; before: unknown; after: unknown; trace: Report["trace"]; databases: string[] }>;
		startupShippedMigration(identity: string): Promise<{
			receipt: unknown;
			activation: unknown;
			before: unknown;
			after: unknown;
			trace: Report["trace"];
			databases: string[];
		}>;
		startupSetup(identity: string, scenario: Scenario): Promise<SetupReport>;
		startupRecover(b: Bootstrap, fault: RecoveryFault, oldHint?: boolean): Promise<Report>;
		startupSettlementRecovery(identity: string): Promise<Report>;
		startupProvider(
			identity: string,
			mode: "missing" | "null" | "primitive" | "incomplete"
		): Promise<{ detail: string; trace: Report["trace"] }>;
		startupLifecycle(
			identity: string,
			fault:
				| Fault
				| "noop-read"
				| "lost-after-hot"
				| "regressed-after-hot"
				| "invalid-after-hot"
				| "unavailable-after-hot"
		): Promise<Report>;
		startupComposition(
			identity: string,
			profile: Bootstrap["profile"],
			composition: "factory" | "rebase" | "signer"
		): Promise<{
			detail: string;
			calls: Record<string, number>;
			reads: Record<string, number>;
			trace: Report["trace"];
		}>;
	}
}
let server: Awaited<ReturnType<typeof startServer>>;
const nativeDatabases = (page: Page): Promise<string[]> =>
	page.evaluate(async () => (await indexedDB.databases()).flatMap(({ name }) => (name === undefined ? [] : [name])));
test.beforeAll(async () => {
	server = await startServer(requireValue(process.env.STARTUP_ARTIFACTS, "STARTUP_FIXTURE_PRECONDITION"));
});
test.afterAll(async () => {
	await server?.close();
});
async function cleanup(
	context: BrowserContext,
	pages: Page[],
	identity: string,
	exactTargets: string[] = []
): Promise<void> {
	const results = await Promise.allSettled(pages.map((p) => p.close()));
	const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
	const page = await context.newPage();
	try {
		await page.goto(server.origin + "/recovery");
		const targets = await page.evaluate(
			async ({ identity, exactTargets }) => {
				const names = (await indexedDB.databases()).flatMap(({ name }) =>
					name !== undefined && (name === identity || name.startsWith(identity + "--") || exactTargets.includes(name))
						? [name]
						: []
				);
				const results = await Promise.allSettled(
					names.map(
						(name) =>
							new Promise<void>((resolve, reject) => {
								const r = indexedDB.deleteDatabase(name);
								r.onsuccess = (): void => resolve();
								r.onerror = (): void => reject(r.error);
								r.onblocked = (): void => reject(new Error("STARTUP_EXACT_CLEANUP_BLOCKED:" + name));
							})
					)
				);
				const errors = results.flatMap((r, i) =>
					r.status === "rejected" ? [{ name: names[i], error: String(r.reason) }] : []
				);
				if (errors.length) throw new Error("STARTUP_EXACT_CLEANUP_FAILED:" + JSON.stringify(errors));
				return names;
			},
			{ identity, exactTargets }
		);
		console.log(
			JSON.stringify({
				lane: "startup-cleanup",
				origin: server.origin,
				identity,
				targets,
				pagesClosed: pages.every((p) => p.isClosed()),
			})
		);
	} catch (error) {
		errors.push(error);
	} finally {
		await page.close();
	}
	if (errors.length) throw new AggregateError(errors, "STARTUP_CLEANUP_FAILURE");
}
for (const consumer of ["chat", "grid"] as const) {
	test(
		"shipped " + consumer + " public genesis omission replays in fresh realm and continues",
		async ({ context }, info) => {
			const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
				pages: Page[] = [];
			let primary: unknown;
			let exactTargets: string[] = [];
			let freshNativeOwner = false;
			try {
				const setup = await context.newPage();
				pages.push(setup);
				await setup.goto(server.origin + "/shipped");
				await setup.waitForFunction(() => typeof window.startupShippedChat === "function");
				expect(await nativeDatabases(setup), "SHIPPED_CONTEXT_NATIVE_BASELINE_MUST_BE_EMPTY").toEqual([]);
				freshNativeOwner = true;
				const initial = await setup.evaluate(
					({ identity, consumer }) =>
						consumer === "chat" ? window.startupShippedChat(identity) : window.startupShippedGrid(identity),
					{ identity, consumer }
				);
				if ("databases" in initial) exactTargets = initial.databases as string[];
				expect(setup.workers()).toHaveLength(0);
				await setup.close();
				expect(setup.isClosed()).toBe(true);
				const recovery = await context.newPage();
				pages.push(recovery);
				await recovery.goto(server.origin + "/shipped");
				await recovery.waitForFunction(() => typeof window.startupShippedChat === "function");
				const report = await recovery.evaluate(
					({ identity, consumer, invite }) =>
						consumer === "chat"
							? window.startupShippedChat(identity, invite)
							: window.startupShippedGrid(identity, invite),
					{ identity, consumer, invite: initial.invite }
				);
				if ("databases" in report) exactTargets = report.databases as string[];
				await info.attach("actual-shipped-consumer", {
					body: JSON.stringify({ consumer, initial, report }),
					contentType: "application/json",
				});
				if (consumer === "chat") {
					const texts = (value: unknown): string[] =>
						(value as { accepted: { text: string }[] }).accepted.map((x) => x.text);
					expect(texts(initial.after)).toEqual(["shipped-zero"]);
					expect(texts(report.before)).toEqual(texts(initial.after));
					expect(texts(report.after)).toEqual(["shipped-zero", "shipped-continued"]);
				} else {
					const blocks = (value: unknown): unknown[] => (value as { blocks: unknown[] }).blocks;
					expect(blocks(initial.after)).toEqual([{ id: "first", kind: "stone", x: 1, y: 1 }]);
					expect(blocks(report.before)).toEqual(blocks(initial.after));
					expect(blocks(report.after)).toEqual([
						{ id: "continued", kind: "stone", x: 2, y: 1 },
						...blocks(initial.after),
					]);
					const sites = report.trace.map((e) => e.site);
					expect(sites.indexOf("floor-read")).toBeGreaterThan(-1);
					expect(sites.indexOf("floor-read")).toBeLessThan(sites.indexOf("prepareV3LiveGeneration"));
				}
				if (consumer === "grid") {
					expect(report.trace.filter((e) => e.site === "transport-open")).toHaveLength(1);
					expect(report.trace.filter((e) => e.site === "transport-close")).toHaveLength(1);
				} else expect(report.trace.filter((e) => e.site === "activateV3LivePlane")).toHaveLength(1);
			} catch (error) {
				primary = error;
			} finally {
				try {
					const livePage = pages.findLast((p) => !p.isClosed());
					if (freshNativeOwner && livePage !== undefined) exactTargets = await nativeDatabases(livePage);
					await cleanup(context, pages, identity, exactTargets);
				} catch (error) {
					primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
				}
			}
			if (primary !== undefined) throw primary;
		}
	);
}
test("shipped chat explicit private rehearsal and activation routes preserve replay and redirect", async ({
	context,
}, info) => {
	const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
		pages: Page[] = [];
	let primary: unknown;
	let exactTargets: string[] = [];
	let freshNativeOwner = false;
	try {
		const page = await context.newPage();
		pages.push(page);
		await page.goto(server.origin + "/shipped");
		await page.waitForFunction(() => typeof window.startupShippedMigration === "function");
		expect(await nativeDatabases(page), "SHIPPED_CONTEXT_NATIVE_BASELINE_MUST_BE_EMPTY").toEqual([]);
		freshNativeOwner = true;
		const report = await page.evaluate((identity) => window.startupShippedMigration(identity), identity);
		exactTargets = report.databases;
		await info.attach("actual-private-routes", { body: JSON.stringify(report), contentType: "application/json" });
		expect(report.receipt).toMatchObject({ activated: false, importedOperationCount: 1 });
		expect(report.activation).toMatchObject({ activated: true });
		const texts = (value: unknown): string[] => (value as { accepted: { text: string }[] }).accepted.map((x) => x.text);
		expect(texts(report.before)).toEqual(["migration-zero"]);
		expect(texts(report.after)).toEqual(["migration-zero", "migration-continued"]);
		expect(report.trace.filter((e) => e.site === "explicit-rehearsal-start")).toHaveLength(1);
		expect(report.trace.filter((e) => e.site === "explicit-activation-start")).toHaveLength(1);
	} catch (error) {
		primary = error;
	} finally {
		try {
			const livePage = pages.findLast((p) => !p.isClosed());
			if (freshNativeOwner && livePage !== undefined) exactTargets = await nativeDatabases(livePage);
			await cleanup(context, pages, identity, exactTargets);
		} catch (error) {
			primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
		}
	}
	if (primary !== undefined) throw primary;
});
for (const fault of [
	"missing-metadata",
	"poisoned",
	"missing-chunk",
	"corrupt-chunk",
	"replace-after-lookup",
	"floor-lost",
	"floor-invalid",
	"floor-unavailable",
	"wrong-head",
	"floor-ahead",
	"genesis-over-successor",
] as const) {
	test("public room independent no-hint refusal: " + fault, async ({ context }, info) => {
		const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
			pages: Page[] = [];
		let primary: unknown;
		try {
			const setup = await context.newPage();
			pages.push(setup);
			await setup.goto(server.origin + "/setup");
			await setup.waitForFunction(() => typeof window.startupSetup === "function");
			const expected = await setup.evaluate((identity) => window.startupSetup(identity, "stable-2"), identity);
			expect(setup.workers()).toHaveLength(0);
			await setup.close();
			expect(setup.isClosed()).toBe(true);
			const page = await context.newPage();
			pages.push(page);
			await page.goto(server.origin + "/recovery");
			await page.waitForFunction(() => typeof window.startupRecover === "function");
			if (fault === "wrong-head")
				await page.evaluate((prior) => Object.assign(globalThis, { startupPrior: prior }), expected.priorStable);
			const report = await page.evaluate(({ b, fault }) => window.startupRecover(b, fault), {
				b: expected.bootstrap,
				fault,
			});
			await info.attach("actual-owner-no-hint-refusal", {
				body: JSON.stringify({ fault, expectedFloor: expected.floor, report }),
				contentType: "application/json",
			});
			console.log(
				JSON.stringify({
					lane: "no-hint-negative",
					fault,
					detail: report.detail,
					sites: names(report),
					native: report.native,
				})
			);
			const sites = names(report);
			expect(report.detail).not.toBe("fulfilled");
			expect(report.downstream).toEqual([]);
			if (fault.startsWith("floor-") && fault !== "floor-ahead") {
				expect(sites).not.toContain("transport-open");
				expect(sites).not.toContain("reopenCreatorSuccessorAdoption");
				expect(report.detail).toBe(
					fault === "floor-lost"
						? "D110C_FLOOR_MIGRATION_REQUIRED"
						: fault === "floor-invalid"
							? "D110C_FLOOR_INVALID"
							: "D110C_FLOOR_UNAVAILABLE"
				);
			} else if (fault === "genesis-over-successor") {
				expect(report.detail).toBe("v3 room trust installation failed: trust-rejected");
				expect(sites).not.toContain("transport-open");
				expect(sites).not.toContain("sign");
				expect(sites).not.toContain("activateV3LivePlane");
			} else {
				expect(sites, "REAL_COLD_GATE_REQUIRED_NOT_OBSOLETE_HINT_REFUSAL").toContain("reopenCreatorSuccessorAdoption");
				expect(sites).toContain("transport-open");
				expect(sites).toContain("transport-close");
				expect(sites).not.toContain("activateV3LivePlane");
				expect(sites).not.toContain("sign");
				if (["wrong-head", "floor-ahead"].includes(fault)) expect(report.detail).toContain("chain-invalid");
				else {
					expect(report.detail).toContain("snapshot-unavailable");
					expect((report.native as { nativeLookups: number }).nativeLookups).toBeGreaterThan(0);
				}
			}
		} catch (error) {
			primary = error;
		} finally {
			try {
				await cleanup(context, pages, identity);
			} catch (error) {
				primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
			}
		}
		if (primary !== undefined) throw primary;
	});
}
for (const fault of [
	"none",
	"missing-metadata",
	"poisoned",
	"missing-chunk",
	"corrupt-chunk",
	"replace-after-lookup",
	"wrong-head",
	"floor-ahead",
] as const) {
	test("actual old-hint diagnostic reaches independent kernel gate: " + fault, async ({ context }, info) => {
		const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
			pages: Page[] = [];
		let primary: unknown;
		try {
			const setup = await context.newPage();
			pages.push(setup);
			await setup.goto(server.origin + "/setup");
			await setup.waitForFunction(() => typeof window.startupSetup === "function");
			const expected = await setup.evaluate((identity) => window.startupSetup(identity, "stable-2"), identity);
			expect(setup.workers()).toHaveLength(0);
			await setup.close();
			const page = await context.newPage();
			pages.push(page);
			await page.goto(server.origin + "/recovery");
			await page.waitForFunction(() => typeof window.startupRecover === "function");
			if (fault === "wrong-head")
				await page.evaluate((prior) => Object.assign(globalThis, { startupPrior: prior }), expected.priorStable);
			const report = await page.evaluate(({ b, fault }) => window.startupRecover(b, fault, true), {
				b: expected.bootstrap,
				fault,
			});
			await info.attach("actual-old-selector-control", {
				body: JSON.stringify({ fault, report }),
				contentType: "application/json",
			});
			console.log(
				JSON.stringify({
					lane: "old-hint-diagnostic",
					fault,
					detail: report.detail,
					sites: names(report),
					native: report.native,
				})
			);
			expect(names(report)).toContain("reopenCreatorSuccessorAdoption");
			if (fault === "none") {
				expect(report.detail).toBe("fulfilled");
				expect(report.projection).toEqual(expected.expectedProjection);
				expect(projectionTexts(report.afterIssue)).toEqual([
					...projectionTexts(expected.expectedProjection),
					"continued",
				]);
			} else {
				expect(report.detail).not.toBe("fulfilled");
				expect(report.detail).toContain(
					["wrong-head", "floor-ahead"].includes(fault) ? "chain-invalid" : "snapshot-unavailable"
				);
				expect(names(report)).toContain("transport-close");
			}
		} catch (error) {
			primary = error;
		} finally {
			try {
				await cleanup(context, pages, identity);
			} catch (error) {
				primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
			}
		}
		if (primary !== undefined) throw primary;
	});
}
const names = (report: Report): string[] => report.trace.map((e) => String(e.site));

test("actual old-hint diagnostic reaches pending reconciliation and historical synthetic gate", async ({
	context,
}, info) => {
	const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
		pages: Page[] = [];
	let primary: unknown;
	try {
		for (const scenario of ["pending-old-1", "pending-new-1", "pending-old-2", "pending-new-2", "genesis"] as const) {
			const setup = await context.newPage();
			pages.push(setup);
			await setup.goto(server.origin + "/setup");
			await setup.waitForFunction(() => typeof window.startupSetup === "function");
			const expected = await setup.evaluate(({ identity, scenario }) => window.startupSetup(identity, scenario), {
				identity: identity + "--" + scenario,
				scenario,
			});
			expect(setup.workers()).toHaveLength(0);
			await setup.close();
			const page = await context.newPage();
			pages.push(page);
			await page.goto(server.origin + "/recovery");
			await page.waitForFunction(() => typeof window.startupRecover === "function");
			const report = await page.evaluate(
				({ b, scenario }) => window.startupRecover(b, scenario === "genesis" ? "historic-floor-ahead" : "none", true),
				{ b: expected.bootstrap, scenario }
			);
			await info.attach("old-selector-precondition-" + scenario, {
				body: JSON.stringify({ scenario, report }),
				contentType: "application/json",
			});
			console.log(
				JSON.stringify({ lane: "old-hint-preconditions", scenario, detail: report.detail, sites: names(report) })
			);
			const sites = names(report);
			expect(sites).toContain("reopenCreatorSuccessorAdoption");
			if (scenario === "genesis") {
				expect(report.detail).toBe(
					"v3 room successor reopen failed: chain-invalid: creator successor generation lineage is invalid"
				);
				expect(sites).toContain("transport-close");
				expect(sites).not.toContain("activateV3LivePlane");
			} else {
				expect(report.detail).toBe("fulfilled");
				expect(report.projection).toEqual(expected.expectedProjection);
				expect(projectionTexts(report.afterIssue)).toEqual([
					...projectionTexts(expected.expectedProjection),
					"continued",
				]);
				const commit = sites.indexOf("floor-commit"),
					reread = sites.indexOf("floor-read", commit + 1),
					cold = sites.indexOf("reopenCreatorSuccessorAdoption");
				expect(sites.indexOf("recoverPendingCreatorSuccessorAdoption")).toBeLessThan(commit);
				expect(commit).toBeGreaterThan(-1);
				expect(reread).toBeGreaterThan(commit);
				expect(cold).toBeGreaterThan(reread);
			}
			await page.close();
		}
	} catch (error) {
		primary = error;
	} finally {
		try {
			await cleanup(context, pages, identity);
		} catch (error) {
			primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
		}
	}
	if (primary !== undefined) throw primary;
});

test("genesis hot adoption reused settlement recovery reads actual successor and rebinds twice", async ({
	context,
}, info) => {
	const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
		pages: Page[] = [];
	let primary: unknown;
	try {
		const page = await context.newPage();
		pages.push(page);
		await page.goto(server.origin + "/lifecycle");
		await page.waitForFunction(() => typeof window.startupSettlementRecovery === "function");
		const report = await page.evaluate((identity) => window.startupSettlementRecovery(identity), identity);
		await info.attach("actual-reused-settlement-recovery", {
			body: JSON.stringify(report),
			contentType: "application/json",
		});
		console.log(
			JSON.stringify({
				lane: "actual-reused-settlement",
				detail: report.detail,
				sites: names(report),
				downstream: report.downstream,
			})
		);
		const sites = names(report),
			faults = sites.flatMap((s, i) => (s === "issue-after-sign-fault" ? [i] : []));
		expect(faults.length, "GENUINE_SIGNED_SETTLEMENT_FAILURE_REACHED").toBeGreaterThan(0);
		for (const i of faults) {
			const after = sites.slice(i + 1);
			expect(after[0], "REUSED_RECOVERY_ACTUAL_HOST_REFRESH").toBe("floor-read");
			expect(after).toContain("reopenCreatorSuccessorAdoption");
			expect(after).not.toContain("prepareV3LiveGeneration");
		}
		expect(report.detail).toBe("fulfilled");
		expect(faults).toHaveLength(2);
		expect(report.authority).toMatchObject({ epoch: 2, profileId: "creator-trusted-settlement-v1" });
		expect(projectionTexts(report.afterIssue)).toEqual(["zero", "continued"]);
		expect(report.downstream).toEqual([
			"reused-settlement-recovery",
			"continued-issue",
			"repeated-settlement-recovery",
		]);
	} catch (error) {
		primary = error;
	} finally {
		try {
			await cleanup(context, pages, identity);
		} catch (error) {
			primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
		}
	}
	if (primary !== undefined) throw primary;
});

for (const mode of ["missing", "null", "primitive", "incomplete"] as const)
	test("ordinary provider missing capability never auto-genesis: " + mode, async ({ context }, info) => {
		const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
			pages: Page[] = [];
		let primary: unknown;
		try {
			const page = await context.newPage();
			pages.push(page);
			await page.goto(server.origin + "/lifecycle");
			await page.waitForFunction(() => typeof window.startupProvider === "function");
			const report = await page.evaluate(({ identity, mode }) => window.startupProvider(identity, mode), {
				identity,
				mode,
			});
			await info.attach("ordinary-provider-boundary", {
				body: JSON.stringify(report),
				contentType: "application/json",
			});
			expect(report.detail).toBe("D110C_FLOOR_MIGRATION_REQUIRED");
			expect(report.trace).toEqual([]);
		} catch (error) {
			primary = error;
		} finally {
			try {
				await cleanup(context, pages, identity);
			} catch (error) {
				primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
			}
		}
		if (primary !== undefined) throw primary;
	});

for (const profile of ["creator-trusted-v1", "creator-trusted-settlement-v1"] as const)
	for (const composition of ["factory", "rebase", "signer"] as const)
		test("state composition zero room invocation: " + profile + " " + composition, async ({ context }, info) => {
			const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
				pages: Page[] = [];
			let primary: unknown;
			try {
				const page = await context.newPage();
				pages.push(page);
				await page.goto(server.origin + "/lifecycle");
				await page.waitForFunction(() => typeof window.startupComposition === "function");
				const report = await page.evaluate(
					({ identity, profile, composition }) => window.startupComposition(identity, profile, composition),
					{ identity, profile, composition }
				);
				const databases = (await nativeDatabases(page)).sort();
				await info.attach("actual-state-composition", {
					body: JSON.stringify({ ...report, databases }),
					contentType: "application/json",
				});
				expect(databases, "COMPOSITION_MUST_NOT_OPEN_ROOM_STORES").toEqual([identity + "--startup-floor"]);
				expect(report.calls).toEqual({ policy: 0, sign: 0, transport: 0 });
				expect(report.trace.map((e) => e.site)).toEqual(["floor-read"]);
				if (profile === "creator-trusted-settlement-v1" && composition === "signer") {
					expect(report.detail).toBe("COMPOSITION_DEFERRED_TRANSPORT_READ");
					expect(report.reads.transport).toBe(1);
				} else {
					expect(report.detail).toBe("v3 room successor authority composition is unsupported");
					expect(report.reads).toEqual({ sign: 0, transport: 0 });
				}
			} catch (error) {
				primary = error;
			} finally {
				try {
					await cleanup(context, pages, identity);
				} catch (error) {
					primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
				}
			}
			if (primary !== undefined) throw primary;
		});
function projectionTexts(value: unknown): string[] {
	return (value as { accepted: { text: string }[] }).accepted.map((row) => row.text);
}
for (const scenario of [
	"genesis",
	"stable-1",
	"stable-2",
	"pending-old-1",
	"pending-new-1",
	"pending-old-2",
	"pending-new-2",
	"lost-commit-1",
	"failed-reread-1",
] as const) {
	test("public room no-hint fresh recovery: " + scenario, async ({ context }, info) => {
		const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
			pages: Page[] = [];
		let primary: unknown;
		try {
			const setup = await context.newPage();
			pages.push(setup);
			await setup.goto(server.origin + "/setup");
			await setup.waitForFunction(() => typeof window.startupSetup === "function");
			const expected = await setup.evaluate(({ identity, scenario }) => window.startupSetup(identity, scenario), {
				identity,
				scenario,
			});
			if (scenario.startsWith("pending") || scenario === "lost-commit-1" || scenario === "failed-reread-1") {
				expect(expected.interrupted).not.toBeNull();
				const attempted = expected.trace.map((e) => e.site);
				expect(attempted.slice(attempted.lastIndexOf("floor-begin"))).not.toContain("activateCreatorSuccessorAdoption");
			}
			expect(setup.workers()).toHaveLength(0);
			await setup.close();
			expect(setup.isClosed()).toBe(true);
			const recovery = await context.newPage();
			pages.push(recovery);
			await recovery.goto(server.origin + "/recovery");
			await recovery.waitForFunction(() => typeof window.startupRecover === "function");
			expect(await recovery.evaluate(() => typeof window.startupSetup)).toBe("undefined");
			const report = await recovery.evaluate((b) => window.startupRecover(b, "none"), expected.bootstrap);
			await info.attach("actual-room-restart", {
				body: JSON.stringify({ origin: server.origin, scenario, expected, report, setupClosed: true, setupWorkers: 0 }),
				contentType: "application/json",
			});
			console.log(
				JSON.stringify({
					lane: "actual-room",
					scenario,
					detail: report.detail,
					downstream: report.downstream,
					sites: names(report),
				})
			);
			expect(report.detail, "ORIGINAL_ROOM_SELECTOR_FAILURE").toBe("fulfilled");
			expect(report.projection).toEqual(expected.expectedProjection);
			if (!scenario.startsWith("pending-old"))
				expect(report.durableHead, "NO_DUPLICATE_BOOTSTRAP_OR_HEAD_REPLACEMENT").toEqual(expected.durableHead);
			expect(projectionTexts(report.afterIssue)).toEqual([
				...projectionTexts(expected.expectedProjection),
				"continued",
			]);
			const sites = names(report);
			expect(sites[0]).toBe("floor-read");
			if (scenario !== "genesis") {
				expect(sites).not.toContain("prepareV3LiveGeneration");
				expect(sites.filter((s) => s === "reopenCreatorSuccessorAdoption")).toHaveLength(1);
				expect(report.authority).toMatchObject({
					epoch: Number(scenario.at(-1)),
					objectId: expected.bootstrap.objectId,
					anchorDigest: (expected.floor.pending?.next ?? expected.floor.stable).currentAnchorDigest,
				});
				const cold = sites.indexOf("reopenCreatorSuccessorAdoption");
				expect(sites.indexOf("transport-open")).toBeLessThan(cold);
				const continued = sites.indexOf("continued-issue-start");
				const startupProjects = report.trace.slice(0, continued).filter((e) => e.site === "project");
				expect(startupProjects.length).toBeGreaterThan(0);
				for (const projection of startupProjects)
					expect(projection.value).toMatchObject({ baseEpoch: Number(scenario.at(-1)) });
				expect(sites.indexOf("projection")).toBeGreaterThan(sites.indexOf("project"));
				expect(sites.indexOf("accepted", continued)).toBeGreaterThan(continued);
				expect(sites.indexOf("projection", continued)).toBeGreaterThan(sites.indexOf("accepted", continued));
				if (scenario.startsWith("pending")) {
					const pending = sites.indexOf("recoverPendingCreatorSuccessorAdoption"),
						commit = sites.indexOf("floor-commit"),
						reread = sites.indexOf("floor-read", commit + 1);
					expect(pending).toBeGreaterThan(-1);
					expect(commit).toBeGreaterThan(pending);
					expect(reread).toBeGreaterThan(commit);
					expect(cold).toBeGreaterThan(reread);
				}
			}
			expect(report.floor).toMatchObject({ pending: null, stable: { epoch: Number(scenario.at(-1)) || 0 } });
			expect(sites.filter((s) => s === "transport-close")).toHaveLength(1);
		} catch (error) {
			primary = error;
		} finally {
			try {
				await cleanup(context, pages, identity);
			} catch (error) {
				primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
			}
		}
		if (primary !== undefined) throw primary;
	});
}
for (const fault of [
	"noop-read",
	"begin-unavailable",
	"publication",
	"commit-unavailable",
	"commit-lost-response",
	"reread-unavailable",
	"lost-after-hot",
	"regressed-after-hot",
	"invalid-after-hot",
	"unavailable-after-hot",
] as const) {
	test("public room hot explicit retry refresh: " + fault, async ({ context }, info) => {
		const identity = "startup-" + info.project.name + "-" + crypto.randomUUID(),
			pages: Page[] = [];
		let primary: unknown;
		try {
			const page = await context.newPage();
			pages.push(page);
			await page.goto(server.origin + "/lifecycle");
			await page.waitForFunction(() => typeof window.startupLifecycle === "function");
			const report = await page.evaluate(({ identity, fault }) => window.startupLifecycle(identity, fault), {
				identity,
				fault,
			});
			await info.attach("actual-hot-retry", { body: JSON.stringify(report), contentType: "application/json" });
			console.log(
				JSON.stringify({
					lane: "hot-retry",
					fault,
					detail: report.detail,
					downstream: report.downstream,
					sites: names(report),
				})
			);
			const sites = names(report),
				retry = sites.indexOf("retry-start"),
				after = sites.slice(retry + 1);
			const refusedEffects = [
				"prepareV3LiveGeneration",
				"reopenCreatorSuccessorAdoption",
				"recoverPendingCreatorSuccessorAdoption",
				"recoverV3LiveReplica",
				"activateV3LivePlane",
				"activateCreatorSuccessorAdoption",
				"bindV3BlueprintLivePlane",
				"project",
				"projection",
				"accepted",
				"sign",
				"retained-request",
			] as const;
			const first = requireValue(
				report.trace.find((e) => e.site === "first-attempt-settled"),
				"STARTUP_FIXTURE_PRECONDITION"
			);
			const firstStart = sites.indexOf("first-adoption-attempt-start"),
				firstEnd = sites.indexOf("first-attempt-settled");
			expect(firstStart).toBeGreaterThan(sites.indexOf("sign"));
			expect(firstEnd).toBeGreaterThan(firstStart);
			if (
				[
					"begin-unavailable",
					"publication",
					"commit-unavailable",
					"commit-lost-response",
					"reread-unavailable",
				].includes(fault)
			) {
				expect((first.value as { failed: string }).failed).not.toBe(null);
				const firstAttempt = sites.slice(firstStart + 1, firstEnd);
				for (const effect of refusedEffects)
					expect(firstAttempt, "FAILED_FIRST_ATTEMPT_HAS_NO_SUCCESSOR_EFFECTS:" + effect).not.toContain(effect);
			}
			expect(after[0], "EXPLICIT_RETRY_MUST_READ_ACTUAL_HOST").toBe("floor-read");
			if (fault.endsWith("after-hot")) {
				expect(report.detail).not.toBe("fulfilled");
				for (const effect of refusedEffects)
					expect(after, "BAD_REFRESH_HAS_NO_RECOVERY_ACTIVATION_OR_REPLAY:" + effect).not.toContain(effect);
			} else {
				expect(report.detail).toBe("fulfilled");
				expect(projectionTexts(report.afterIssue)).toEqual(["zero", "continued"]);
				expect(report.floor).toMatchObject({ pending: null, stable: { epoch: fault === "noop-read" ? 2 : 1 } });
				if (["publication", "commit-unavailable", "commit-lost-response", "reread-unavailable"].includes(fault))
					expect(after).toContain("reopenCreatorSuccessorAdoption");
			}
			if (fault === "noop-read") {
				const second = sites.indexOf("second-hot-adoption");
				expect(second).toBeGreaterThan(-1);
				expect(sites[second + 1], "REPEATED_HOT_NOOP_MUST_REFRESH_HOST").toBe("floor-read");
			}
		} catch (error) {
			primary = error;
		} finally {
			try {
				await cleanup(context, pages, identity);
			} catch (error) {
				primary = primary === undefined ? error : new AggregateError([primary, error], "STARTUP_PRIMARY_AND_CLEANUP");
			}
		}
		if (primary !== undefined) throw primary;
	});
}

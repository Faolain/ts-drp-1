import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { captureProcessForest, processClosure, type ProcessIdentity } from "./fixtures/process-forest.js";
import { startProductBrowserServer } from "./fixtures/product-browser-server.js";
import type {} from "./assets/phase-6a-creator-successor-product-entry.js";

type RecordValue = Record<string, unknown>;
interface Observation {
	readonly state: {
		readonly authority: { readonly anchorDigest: string; readonly profileId: string };
		readonly roomId: string;
		readonly acl: unknown;
		readonly projection: {
			readonly blocks?: unknown;
			readonly roster?: unknown;
			readonly accepted: readonly { readonly text: string }[];
		};
	};
	readonly issuance: readonly {
		readonly authorSequence: number;
		readonly epoch: number;
		readonly publishState: string;
	}[];
}
interface CensusRow {
	readonly database: string;
	readonly store: string;
	readonly rows: number;
	readonly logicalPayloadBytes: number;
}
interface SweepObservation {
	readonly deleted: number;
	readonly selectedEpochs: readonly number[];
	readonly clockRestored: boolean;
	readonly otherBefore: unknown;
	readonly otherAfter: unknown;
}
interface ExpiredObservation {
	readonly detail: string;
	readonly classification: string;
	readonly maintenance: SweepObservation;
	readonly otherAfterRecovery: unknown;
}
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new TypeError("native browser fixture value is absent");
	return value;
}
const ROOT = resolve(import.meta.dirname, "../../..");
const ENTRY = resolve(import.meta.dirname, "assets/phase-6a-creator-successor-product-entry.ts");

function ownedForest(profile: string): readonly ProcessIdentity[] {
	const forest = captureProcessForest();
	const roots = forest.filter(
		({ ppid, command }) => ppid === process.pid && command.split(" ").includes(`--user-data-dir=${profile}`)
	);
	expect(roots).toHaveLength(1);
	return processClosure(forest, required(roots[0]).pid);
}

async function assertGone(owned: readonly ProcessIdentity[]): Promise<void> {
	await expect
		.poll(
			() => {
				const live = captureProcessForest();
				return owned.filter((old) =>
					live.some(
						(current) =>
							old.pid === current.pid && old.birthToken === current.birthToken && old.command === current.command
					)
				).length;
			},
			{ timeout: 10_000 }
		)
		.toBe(0);
}

function processRss(owned: readonly ProcessIdentity[]): number {
	const output = execFileSync("ps", ["-o", "rss=", "-p", owned.map(({ pid }) => pid).join(",")], { encoding: "utf8" });
	return output
		.trim()
		.split(/\s+/u)
		.reduce((sum, kib) => sum + Number(kib) * 1024, 0);
}

for (const nativeGrid of [false, true]) {
	test(`native browser: ${nativeGrid ? "fixed-state settlement grid" : "legacy chat"} transitions and persistent-process cold reopen`, async ({
		browserName,
	}, testInfo) => {
		expect(browserName).toBe("chromium");
		const started = performance.now();
		const profileInput = testInfo.outputPath("profile");
		mkdirSync(profileInput, { recursive: true });
		const profile = realpathSync(profileInput);
		const server = await startProductBrowserServer(ENTRY);
		const events: RecordValue[] = [];
		let context: BrowserContext | undefined;
		let owned: readonly ProcessIdentity[] = [];
		let terminal = "incomplete";
		let cleanupComplete = false;
		let quarantineScopes: number | undefined;
		const name = nativeGrid ? "native-grid-settlement" : "native-memory-baseline";
		const transitions = nativeGrid ? 6 : 3;
		const call = <T = Observation>(
			page: Page,
			action: Parameters<typeof window.phase6aCreatorSuccessorProduct.nativeMemory>[0]["action"],
			epoch: number
		): Promise<T> =>
			page.evaluate((input) => window.phase6aCreatorSuccessorProduct.nativeMemory(input), {
				name,
				action,
				epoch,
				nativeGrid,
			}) as Promise<T>;
		const boot = async (): Promise<Page> => {
			context = await chromium.launchPersistentContext(profile, { headless: true });
			const page = context.pages()[0] ?? (await context.newPage());
			await page.goto(server.origin);
			await page.waitForFunction(() => typeof window.phase6aCreatorSuccessorProduct === "object");
			const admission = await page.evaluate(async () => {
				const storage = navigator.storage;
				const estimate = storage.estimate;
				const before = await storage.estimate();
				await window.phase6aCreatorSuccessorProduct.boot("native-memory", { nativeStorage: true });
				return {
					before,
					sameObject: storage === navigator.storage,
					sameEstimate: estimate === navigator.storage.estimate,
					ownStorage: Object.hasOwn(navigator, "storage"),
					lifetimeInstrumentation: Reflect.has(globalThis, "__d108e2bLifetimeInstrumentation"),
				};
			});
			expect(admission).toMatchObject({
				sameObject: true,
				sameEstimate: true,
				ownStorage: false,
				lifetimeInstrumentation: false,
			});
			expect(admission.before.quota).toBeGreaterThan(0);
			owned = ownedForest(profile);
			events.push({ phase: "boot", elapsedMs: performance.now() - started, admission, owned });
			return page;
		};
		const checkpoint = async (page: Page, phase: string, epoch: number): Promise<void> => {
			const session = await required(context).newCDPSession(page);
			let heap: unknown;
			let browserVersion: unknown;
			try {
				browserVersion = await session.send("Browser.getVersion");
				await session.send("HeapProfiler.collectGarbage");
				heap = await session.send("Runtime.getHeapUsage");
			} finally {
				await session.detach();
			}
			const storage = await page.evaluate(() => navigator.storage.estimate());
			const forest = ownedForest(profile);
			const rssBytes = processRss(forest);
			const census = await call<readonly CensusRow[]>(page, "census", epoch);
			if (nativeGrid && epoch > 0) {
				const rows = census;
				const count = (suffix: string, store: string): number =>
					rows
						.filter((row) => row.database.endsWith(suffix) && row.store === store)
						.reduce((sum, row) => sum + row.rows, 0);
				expect(count("--ahe", "generations")).toBe(3);
				expect(count("--drp-live-journal-v1", "scopes")).toBe(epoch + 1);
				expect(count("--drp-snapshot-quarantine-v1", "scopes")).toBe(quarantineScopes ?? epoch);
			}
			events.push({
				phase,
				epoch,
				elapsedMs: performance.now() - started,
				heap,
				heapScope: "renderer-isolate",
				browserVersion,
				gc: "HeapProfiler.collectGarbage",
				storage,
				processTreeRssBytes: rssBytes,
				census,
			});
			console.log(
				JSON.stringify({
					phase,
					epoch,
					elapsedMs: performance.now() - started,
					heap,
					storage,
					processTreeRssBytes: rssBytes,
				})
			);
		};
		try {
			let page = await boot();
			await checkpoint(page, "before-create", 0);
			let stable = await call(page, "create", 0);
			for (let epoch = 0; epoch < transitions; epoch += 1) {
				stable = await call(page, "transition", epoch);
				expect(stable.state.authority).toMatchObject({ epoch: epoch + 1, lifecycle: "active" });
				expect(stable.state.roomId).toBe(stable.state.authority.anchorDigest);
				if (nativeGrid) {
					expect(stable.state.authority.profileId).toBe("creator-trusted-settlement-v1");
					expect(stable.state.projection.blocks).toEqual([{ id: "writer-00", kind: "stone", x: epoch % 2, y: 0 }]);
					expect(stable.state.projection.roster).toHaveLength(1);
					expect(stable.issuance.every((row) => row.epoch >= Math.max(0, epoch - 1))).toBe(true);
				} else {
					expect(stable.state.projection.accepted.map(({ text }) => text)).toEqual(
						Array.from({ length: epoch + 1 }, (_, index) => `epoch-${index}`)
					);
				}
				expect(stable.issuance.every(({ publishState }) => publishState === "published")).toBe(true);
				await checkpoint(page, "after-transition", epoch + 1);
			}
			events.push({ phase: "stable", evidence: stable });
			await page.waitForTimeout(250);
			await checkpoint(page, "bounded-idle", transitions);
			await call(page, "close", transitions);
			owned = ownedForest(profile);
			await required(context).close();
			context = undefined;
			await assertGone(owned);
			events.push({ phase: "cold-boundary", gone: owned });
			page = await boot();
			if (nativeGrid) {
				const swept = await call<SweepObservation>(page, "sweep-old", transitions);
				events.push({ phase: "expired-old-quarantine", evidence: swept });
				expect(swept.deleted).toBe(transitions - 2);
				expect(swept.selectedEpochs).toEqual([0, 1, 2, 3]);
				expect(swept.clockRestored).toBe(true);
				expect(swept.otherAfter).toEqual(swept.otherBefore);
				quarantineScopes = 2;
				await checkpoint(page, "after-expired-old-sweep", transitions);
			}
			const reopened = await call(page, "reopen", transitions);
			expect(reopened.state.authority).toEqual(stable.state.authority);
			expect(reopened.state.projection).toEqual(stable.state.projection);
			expect(reopened.state.acl).toEqual(stable.state.acl);
			expect(reopened.issuance).toEqual(stable.issuance);
			const after = await call(page, "issue", transitions);
			if (nativeGrid)
				expect(after.state.projection.blocks).toEqual([{ id: "writer-00", kind: "stone", x: transitions % 2, y: 0 }]);
			else
				expect(after.state.projection.accepted.map(({ text }) => text)).toEqual([
					"epoch-0",
					"epoch-1",
					"epoch-2",
					"epoch-3",
				]);
			expect(after.issuance.slice(0, -1)).toEqual(stable.issuance);
			expect(after.issuance.at(-1)).toMatchObject({
				epoch: transitions,
				publishState: "published",
				authorSequence: required(stable.issuance.at(-1)).authorSequence + 1,
			});
			events.push({ phase: "recovered", evidence: after });
			await checkpoint(page, "after-reopen-issue", transitions);
			await call(page, "close", transitions);
			if (nativeGrid) {
				owned = ownedForest(profile);
				await required<BrowserContext>(context).close();
				context = undefined;
				await assertGone(owned);
				page = await boot();
				const expired = await call<ExpiredObservation>(page, "reopen-expired", transitions);
				events.push({ phase: "expired-required-snapshot", evidence: expired });
				console.log(
					JSON.stringify({
						phase: "expired-required-snapshot",
						detail: expired.detail,
						classification: expired.classification,
					})
				);
				expect(expired.maintenance.deleted).toBe(2);
				expect(expired.maintenance.clockRestored).toBe(true);
				expect(expired.maintenance.otherAfter).toEqual(expired.maintenance.otherBefore);
				expect(expired.otherAfterRecovery).toEqual(expired.maintenance.otherBefore);
				expect(expired.classification).toBe("rejected");
				expect(expired.detail).toBe(
					"v3 room successor reopen failed: snapshot-unavailable: creator successor snapshot is unavailable"
				);
			}
			terminal = "completed";
		} finally {
			try {
				if (context !== undefined) {
					owned = ownedForest(profile);
					await context.close();
				}
				await assertGone(owned);
				cleanupComplete = true;
				events.push({ phase: "cleanup", processesGone: true });
			} finally {
				await server.close();
				const sourceFiles = [
					ENTRY,
					import.meta.filename,
					resolve(import.meta.dirname, "fixtures/product-browser-server.ts"),
					resolve(ROOT, "tests/fixtures/grid-memory-storage-census.ts"),
				];
				const evidencePath = testInfo.outputPath("native-browser-evidence.json");
				writeFileSync(
					evidencePath,
					JSON.stringify(
						{
							terminal: cleanupComplete ? terminal : "cleanup-incomplete",
							productionAcceptance: "not-evaluated",
							node: process.version,
							command: process.argv,
							revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
							sourceHashes: sourceFiles.map((path) => ({
								path,
								sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
							})),
							bundleSha256: server.bundleSha256,
							profile,
							origin: server.origin,
							topology: `one creator; ${nativeGrid ? "fixed-state production grid application; settlement profile" : "growing chat projection; legacy profile"}; native IndexedDB; no lifetime plugin; deterministic existing fixture identity`,
							observer:
								"existing fixture maps and durable room-head events; scalar cursor census after heap measurement",
							heapReference: "https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage",
							events,
						},
						null,
						2
					),
					{ flag: "wx" }
				);
				await testInfo.attach("native-browser-evidence.json", {
					path: evidencePath,
					contentType: "application/json",
				});
			}
		}
	});
}

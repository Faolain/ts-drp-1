import "fake-indexeddb/auto";

import { expect, type Page, test } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const D108D1_BROWSER_BEHAVIORS = [
	"missing or hostile LockManager authority fails activation closed",
	"two tabs elect one lifetime-held writer then a freshly reverified loser wins after release",
] as const;
const D108D1B_ORACLE_BROWSER_BEHAVIORS = [
	"wrong-key and throwing browser possession fail before writer activation",
] as const;
const D108E2A_BROWSER_BEHAVIORS = [
	"dedicated worker holds the origin-wide lifetime lock against a Window contender then releases it",
	"missing or hostile worker LockManager authority fails closed before activation",
] as const;
const D108E2C_ACTIVATION_BROWSER_BEHAVIORS = [
	"window probes distinguish production lock contention from fixture busy state and isolate possession failures",
] as const;
const D108E4_ACTIVATION_BROWSER_BEHAVIORS = [
	"window observes lock authority before durable store opening and possession probes use exact suffixed databases",
] as const;

interface WorkerReply {
	readonly counters?: Readonly<{
		readonly acquisitionCount: number;
		readonly callbackCount: number;
		readonly lookupCount: number;
		readonly releaseCount: number;
	}>;
	readonly detail?: string;
	readonly kind: "result" | "worker-error";
	readonly released?: boolean;
	readonly result?: Readonly<Record<string, unknown>>;
}

let material: unknown;
let server: Phase4cBrowserServer | undefined;

test.beforeAll(async () => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
	const contract = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-6a-v3/creator-successor-activation-contract.ts")).href
	)) as {
		createD108d1PackedDurableMaterial(fixture: unknown): Promise<unknown>;
	};
	const adoption = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-6a-v3/creator-adoption-contract.ts")).href
	)) as {
		openGenuineCreatorAdoptionFixture(): Promise<Readonly<{ close(): Promise<void> }>>;
	};
	const fixture = await adoption.openGenuineCreatorAdoptionFixture();
	try {
		material = await contract.createD108d1PackedDurableMaterial(fixture);
	} finally {
		await fixture.close();
	}
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-6a-creator-successor-activation-entry.ts"),
		workerPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-6a-creator-successor-activation-worker.ts"),
	});
});

async function workerCommand(page: Page, command: Readonly<Record<string, unknown>>): Promise<WorkerReply> {
	return page.evaluate(async (selected) => {
		const owner = globalThis as typeof globalThis & {
			phase6aD108e2aWorker?: Worker;
			phase6aD108e2aWorkerReady?: Promise<void>;
		};
		if (owner.phase6aD108e2aWorker === undefined) {
			owner.phase6aD108e2aWorker = new Worker("/worker.js", { type: "module" });
			owner.phase6aD108e2aWorkerReady = new Promise<void>((resolvePromise, reject) => {
				const timer = setTimeout(() => reject(new Error("D.108e2a worker ready timed out")), 20_000);
				owner.phase6aD108e2aWorker?.addEventListener(
					"message",
					(event: MessageEvent<Readonly<{ readonly kind?: string }>>) => {
						if (event.data.kind !== "ready") return;
						clearTimeout(timer);
						resolvePromise();
					},
					{ once: true }
				);
			});
		}
		await owner.phase6aD108e2aWorkerReady;
		const worker = owner.phase6aD108e2aWorker;
		if (worker === undefined) throw new TypeError("D.108e2a worker is unavailable");
		const id = crypto.randomUUID();
		return new Promise<WorkerReply>((resolvePromise, reject) => {
			const timer = setTimeout(() => reject(new Error("D.108e2a worker response timed out")), 20_000);
			const receive = (event: MessageEvent<WorkerReply & Readonly<{ readonly id?: string }>>): void => {
				if (event.data.id !== id) return;
				clearTimeout(timer);
				worker.removeEventListener("message", receive);
				if (event.data.kind === "worker-error") reject(new Error(event.data.detail ?? "D.108e2a worker failed"));
				else resolvePromise(event.data);
			};
			worker.addEventListener("message", receive);
			worker.postMessage({ ...selected, id });
		});
	}, command);
}

async function terminateWorker(page: Page): Promise<void> {
	await page.evaluate(() => {
		const owner = globalThis as typeof globalThis & {
			phase6aD108e2aWorker?: Worker;
			phase6aD108e2aWorkerReady?: Promise<void>;
		};
		owner.phase6aD108e2aWorker?.terminate();
		delete owner.phase6aD108e2aWorker;
		delete owner.phase6aD108e2aWorkerReady;
	});
}

function expectedPossessionDatabaseNames(databasePrefix: string): readonly string[] {
	return ["throw", "wrong-key"]
		.flatMap((suffix) => [
			`${databasePrefix}-${suffix}-ahe`,
			`${databasePrefix}-${suffix}-issuance--drp-issuance-v1`,
			`${databasePrefix}-${suffix}-journal--drp-live-journal-v1`,
			`${databasePrefix}-${suffix}-snapshot--drp-snapshot-quarantine-v1`,
		])
		.sort();
}

async function possessionDatabaseNames(page: Page, databasePrefix: string): Promise<readonly string[]> {
	return page.evaluate(async (selectedPrefix) => {
		return (await indexedDB.databases())
			.flatMap(({ name }) => (name?.startsWith(`${selectedPrefix}-`) === true ? [name] : []))
			.sort();
	}, databasePrefix);
}

test.afterAll(async () => server?.close());
test("pins the complete browser behavior inventory", () => {
	expect(D108D1_BROWSER_BEHAVIORS).toEqual([
		"missing or hostile LockManager authority fails activation closed",
		"two tabs elect one lifetime-held writer then a freshly reverified loser wins after release",
	]);
	expect(D108D1B_ORACLE_BROWSER_BEHAVIORS).toEqual([
		"wrong-key and throwing browser possession fail before writer activation",
	]);
	expect(D108E2A_BROWSER_BEHAVIORS).toEqual([
		"dedicated worker holds the origin-wide lifetime lock against a Window contender then releases it",
		"missing or hostile worker LockManager authority fails closed before activation",
	]);
	expect(D108E2C_ACTIVATION_BROWSER_BEHAVIORS).toEqual([
		"window probes distinguish production lock contention from fixture busy state and isolate possession failures",
	]);
	expect(D108E4_ACTIVATION_BROWSER_BEHAVIORS).toEqual([
		"window observes lock authority before durable store opening and possession probes use exact suffixed databases",
	]);
});

test(D108E2A_BROWSER_BEHAVIORS[0], async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `d108e2a-worker-owner-${crypto.randomUUID()}`;
	await page.evaluate(
		({ databaseName: selected, material: carrier }) => window.phase6aCreatorSuccessorActivation.seed(selected, carrier),
		{ databaseName, material }
	);
	try {
		const worker = await workerCommand(page, { databaseName, kind: "open", lockMode: "native", material });
		expect(worker.result).toMatchObject({ lockHeld: true, ok: true, verificationCount: 1 });
		expect(worker.counters).toEqual({ acquisitionCount: 1, callbackCount: 1, lookupCount: 1, releaseCount: 0 });
		expect(worker.result).toMatchObject({ epoch: 1, publicationCount: 0, recovery: "active-new", signerCount: 1 });
		const blocked = await page.evaluate(
			({ databaseName: selected, material: carrier }) =>
				window.phase6aCreatorSuccessorActivation.openContender(selected, carrier),
			{ databaseName, material }
		);
		expect(blocked).toMatchObject({ kind: "authority-unavailable", lockHeld: false, ok: false });
		const released = await workerCommand(page, { kind: "release" });
		expect(released).toMatchObject({
			counters: { acquisitionCount: 1, callbackCount: 1, lookupCount: 1, releaseCount: 1 },
			released: true,
		});
		const reacquired = await page.evaluate(
			({ databaseName: selected, material: carrier }) =>
				window.phase6aCreatorSuccessorActivation.openContender(selected, carrier),
			{ databaseName, material }
		);
		expect(reacquired).toMatchObject({ lockHeld: true, ok: true, verificationCount: 1 });
		expect(await page.evaluate(() => window.phase6aCreatorSuccessorActivation.release())).toBe(true);
	} finally {
		await terminateWorker(page);
	}
});

test(D108E2A_BROWSER_BEHAVIORS[1], async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	for (const lockMode of ["missing", "non-callable", "throwing", "rejecting"] as const) {
		const databaseName = `d108e2a-worker-${lockMode}-${crypto.randomUUID()}`;
		await page.evaluate(
			({ databaseName: selected, material: carrier }) =>
				window.phase6aCreatorSuccessorActivation.seed(selected, carrier),
			{ databaseName, material }
		);
		try {
			const observed = await workerCommand(page, { databaseName, kind: "open", lockMode, material });
			expect(observed.result).toMatchObject({
				kind: "authority-unavailable",
				lockHeld: false,
				ok: false,
				publicationCount: 0,
				signerCount: 1,
				verificationCount: 1,
			});
			expect(observed.counters).toEqual({
				acquisitionCount: lockMode === "throwing" || lockMode === "rejecting" ? 1 : 0,
				callbackCount: 0,
				lookupCount: 1,
				releaseCount: 0,
			});
			expect(await workerCommand(page, { kind: "release" })).toMatchObject({ released: false });
		} finally {
			await terminateWorker(page);
		}
	}
});

test("wrong-key and throwing browser possession fail before writer activation", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `d108d1b-possession-failure-${crypto.randomUUID()}`;
	const results = await page.evaluate(
		({ databaseName: selected, material: carrier }) =>
			window.phase6aCreatorSuccessorActivation.probePossessionFailure(selected, carrier),
		{ databaseName, material }
	);
	expect(results).toEqual([
		expect.objectContaining({
			detail: "creator issuance possession proof failed",
			kind: "chain-invalid",
			lockHeld: false,
			ok: false,
			publicationCount: 0,
			signerCount: 1,
			verificationCount: 1,
		}),
		expect.objectContaining({
			detail: "creator issuance possession proof failed",
			kind: "chain-invalid",
			lockHeld: false,
			ok: false,
			publicationCount: 0,
			signerCount: 1,
			verificationCount: 1,
		}),
	]);
	expect(await possessionDatabaseNames(page, databaseName)).toEqual(expectedPossessionDatabaseNames(databaseName));
});

test(D108E2C_ACTIVATION_BROWSER_BEHAVIORS[0], async ({ browser, page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const possessionDatabase = `d108e2c-possession-${crypto.randomUUID()}`;
	const possessionResults = (await page.evaluate(
		({ databaseName, material: carrier }) =>
			window.phase6aCreatorSuccessorActivation.probePossessionFailure(databaseName, carrier),
		{ databaseName: possessionDatabase, material }
	)) as unknown as readonly Readonly<Record<string, unknown>>[];
	expect.soft(possessionResults).toEqual([
		expect.objectContaining({
			databaseName: `${possessionDatabase}-wrong-key`,
			fixtureDisposition: "production-result",
			lockAcquiredCount: 0,
			lockCallbackCount: 0,
			probeFinishOrder: 2,
			probeStartOrder: 1,
		}),
		expect.objectContaining({
			databaseName: `${possessionDatabase}-throw`,
			fixtureDisposition: "production-result",
			lockAcquiredCount: 0,
			lockCallbackCount: 0,
			probeFinishOrder: 4,
			probeStartOrder: 3,
		}),
	]);
	expect.soft(new Set(possessionResults.map(({ databaseName }) => databaseName)).size).toBe(2);
	expect
		.soft(await possessionDatabaseNames(page, possessionDatabase))
		.toEqual(expectedPossessionDatabaseNames(possessionDatabase));

	const context = await browser.newContext();
	const ownerPage = await context.newPage();
	const contenderPage = await context.newPage();
	try {
		await Promise.all([
			ownerPage.goto(server?.origin ?? "about:blank"),
			contenderPage.goto(server?.origin ?? "about:blank"),
		]);
		const databaseName = `d108e2c-contention-${crypto.randomUUID()}`;
		await ownerPage.evaluate(
			({ databaseName: selected, material: carrier }) =>
				window.phase6aCreatorSuccessorActivation.seed(selected, carrier),
			{ databaseName, material }
		);
		const owner = (await ownerPage.evaluate(
			({ databaseName: selected, material: carrier }) =>
				window.phase6aCreatorSuccessorActivation.openContender(selected, carrier),
			{ databaseName, material }
		)) as unknown as Readonly<Record<string, unknown>>;
		const blocked = (await contenderPage.evaluate(
			({ databaseName: selected, material: carrier }) =>
				window.phase6aCreatorSuccessorActivation.openContender(selected, carrier),
			{ databaseName, material }
		)) as unknown as Readonly<Record<string, unknown>>;
		const fixtureBusy = (await ownerPage.evaluate(
			({ databaseName: selected, material: carrier }) =>
				window.phase6aCreatorSuccessorActivation.openContender(selected, carrier),
			{ databaseName, material }
		)) as unknown as Readonly<Record<string, unknown>>;
		expect.soft(owner).toMatchObject({
			fixtureDisposition: "production-result",
			lockAcquiredCount: 1,
			lockCallbackCount: 1,
			ok: true,
		});
		expect.soft(blocked).toMatchObject({
			fixtureDisposition: "production-result",
			kind: "authority-unavailable",
			lockAcquiredCount: 0,
			lockCallbackCount: 1,
			ok: false,
		});
		expect.soft(fixtureBusy).toMatchObject({
			fixtureDisposition: "harness-busy",
			lockAcquiredCount: 0,
			lockCallbackCount: 0,
			ok: false,
		});
		expect(await ownerPage.evaluate(() => window.phase6aCreatorSuccessorActivation.release())).toBe(true);
	} finally {
		await context.close();
	}
});

test(D108E4_ACTIVATION_BROWSER_BEHAVIORS[0], async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `d108e4-possession-${crypto.randomUUID()}`;
	const results = (await page.evaluate(
		({ databaseName: selected, material: carrier }) =>
			window.phase6aCreatorSuccessorActivation.probePossessionFailure(selected, carrier),
		{ databaseName, material }
	)) as unknown as readonly Readonly<Record<string, unknown>>[];
	expect.soft(results).toEqual([
		expect.objectContaining({
			databaseName: `${databaseName}-wrong-key`,
			firstStoreOpenOrder: 2,
			lockObservationOrder: 1,
		}),
		expect.objectContaining({
			databaseName: `${databaseName}-throw`,
			firstStoreOpenOrder: 2,
			lockObservationOrder: 1,
		}),
	]);
	expect.soft(await possessionDatabaseNames(page, databaseName)).toEqual(expectedPossessionDatabaseNames(databaseName));
	const storeOpenFailureRestoredLocks = await page.evaluate(
		async ({ databaseName: selected, material: carrier }) => {
			const locks = navigator.locks;
			const openDescriptor = Object.getOwnPropertyDescriptor(indexedDB, "open");
			try {
				Object.defineProperty(indexedDB, "open", {
					configurable: true,
					value: (): never => {
						throw new Error("D108E4_STORE_OPEN_FAILURE");
					},
				});
				await window.phase6aCreatorSuccessorActivation.openContender(selected, carrier);
				return false;
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "D108E4_STORE_OPEN_FAILURE") throw error;
				return Object.is(navigator.locks, locks);
			} finally {
				if (openDescriptor === undefined) Reflect.deleteProperty(indexedDB, "open");
				else Object.defineProperty(indexedDB, "open", openDescriptor);
			}
		},
		{ databaseName: `${databaseName}-store-open-failure`, material }
	);
	expect.soft(storeOpenFailureRestoredLocks).toBe(true);
});

test("missing or hostile LockManager authority fails activation closed", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const databaseName = `d108d1-lock-failure-${crypto.randomUUID()}`;
	await page.evaluate(
		({ databaseName: selected, material: carrier }) => window.phase6aCreatorSuccessorActivation.seed(selected, carrier),
		{ databaseName, material }
	);
	const results = await page.evaluate(
		({ databaseName: selected, material: carrier }) =>
			window.phase6aCreatorSuccessorActivation.probeAuthorityFailure(selected, carrier),
		{ databaseName, material }
	);
	expect(results).toEqual([
		expect.objectContaining({ kind: "authority-unavailable", ok: false, verificationCount: 1 }),
		expect.objectContaining({ kind: "authority-unavailable", ok: false, verificationCount: 1 }),
	]);
});

test("two tabs elect one lifetime-held writer then a freshly reverified loser wins after release", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const first = await context.newPage();
	const second = await context.newPage();
	try {
		await Promise.all([first.goto(server?.origin ?? "about:blank"), second.goto(server?.origin ?? "about:blank")]);
		const databaseName = `d108d1-election-${crypto.randomUUID()}`;
		await first.evaluate(
			({ databaseName: selected, material: carrier }) =>
				window.phase6aCreatorSuccessorActivation.seed(selected, carrier),
			{ databaseName, material }
		);
		const [left, right] = await Promise.all([
			first.evaluate(
				({ databaseName: selected, material: carrier }) =>
					window.phase6aCreatorSuccessorActivation.openContender(selected, carrier),
				{ databaseName, material }
			),
			second.evaluate(
				({ databaseName: selected, material: carrier }) =>
					window.phase6aCreatorSuccessorActivation.openContender(selected, carrier),
				{ databaseName, material }
			),
		]);
		const winner = left.ok ? first : second;
		const loser = left.ok ? second : first;
		expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
		expect(left.ok ? right : left).toMatchObject({ kind: "authority-unavailable", lockHeld: false, ok: false });
		expect(left.ok ? left : right).toMatchObject({
			epoch: 1,
			lockHeld: true,
			ok: true,
			publicationCount: 0,
			recovery: "active-new",
			verificationCount: 1,
		});
		expect(await winner.evaluate(() => window.phase6aCreatorSuccessorActivation.release())).toBe(true);
		let reacquired: Awaited<ReturnType<typeof window.phase6aCreatorSuccessorActivation.openContender>> | null = null;
		await expect
			.poll(
				async () => {
					reacquired = await loser.evaluate(
						({ databaseName: selected, material: carrier }) =>
							window.phase6aCreatorSuccessorActivation.openContender(selected, carrier),
						{ databaseName, material }
					);
					return reacquired.ok;
				},
				{ timeout: 10_000 }
			)
			.toBe(true);
		expect(reacquired).toMatchObject({
			epoch: 1,
			lockHeld: true,
			ok: true,
			publicationCount: 0,
			recovery: "active-new",
			verificationCount: 1,
		});
		expect(await loser.evaluate(() => window.phase6aCreatorSuccessorActivation.release())).toBe(true);
	} finally {
		await context.close();
	}
});

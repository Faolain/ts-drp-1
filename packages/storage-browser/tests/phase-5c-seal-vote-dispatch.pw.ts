import { expect, type Page, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const REQUIRED_OWNERS = (
	JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-5-v3/seal-safety-contract.json"), "utf8")) as {
		readonly requiredOwners: readonly string[];
	}
).requiredOwners;
const GREEN_READY = REQUIRED_OWNERS.every((path) => existsSync(resolve(REPOSITORY_ROOT, path)));

let server: Phase4cBrowserServer | undefined;

async function installSendObserver(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const sends: { bytesHex: string; key: string }[] = [];
		Object.defineProperty(window, "__phase5cObservedSends", { value: sends });
		window.addEventListener("phase5c-seal-send", (event) => {
			const detail = (event as CustomEvent).detail as { readonly bytesHex?: unknown; readonly key?: unknown };
			if (typeof detail?.bytesHex !== "string" || typeof detail.key !== "string") {
				throw new TypeError("invalid Phase 5c send observation");
			}
			sends.push({ bytesHex: detail.bytesHex, key: detail.key });
		});
	});
}

async function observedSends(page: Page): Promise<readonly Readonly<{ bytesHex: string; key: string }>[]> {
	return page.evaluate(() => Reflect.get(window, "__phase5cObservedSends"));
}

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5c-seal-vote-entry.ts"),
		workerPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5c-seal-vote-worker.ts"),
	});
});
test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.105b product owners are intentionally absent in RED");

test("same-context tabs drain only committed exact carriers across every LockManager failure mode", async ({
	context,
}) => {
	const primary = await context.newPage();
	const successor = await context.newPage();
	await Promise.all([installSendObserver(primary), installSendObserver(successor)]);
	await Promise.all([primary.goto(server?.origin ?? "about:blank"), successor.goto(server?.origin ?? "about:blank")]);
	for (const mode of ["native", "absent", "non-callable", "throw", "reject", "abort", "timeout"] as const) {
		const databaseName = `phase-5c-dispatch-${mode}-${crypto.randomUUID()}`;
		const [left, right] = await Promise.all([
			primary.evaluate(([name, selected]) => window.phase5cSealVote.runDispatchScenario(name, selected), [
				databaseName,
				mode,
			] as const),
			successor.evaluate(([name, selected]) => window.phase5cSealVote.runDispatchScenario(name, selected), [
				databaseName,
				mode,
			] as const),
		]);
		for (const result of [left, right] as readonly unknown[]) {
			expect(result).toMatchObject({ provisionalSends: 0, sentOnlyCommittedBytes: true });
		}
	}
});

test("primary loss, bounded overflow and total volatile loss recover every durable nonempty key", async ({
	context,
}) => {
	const primary = await context.newPage();
	const successor = await context.newPage();
	await Promise.all([installSendObserver(primary), installSendObserver(successor)]);
	await Promise.all([primary.goto(server?.origin ?? "about:blank"), successor.goto(server?.origin ?? "about:blank")]);
	const databaseName = `phase-5c-takeover-${crypto.randomUUID()}`;
	const committed = (await primary.evaluate(
		(name) => window.phase5cSealVote.runDispatchScenario(name, "commit-only"),
		databaseName
	)) as {
		readonly committedKeys: readonly string[];
	};
	expect(committed.committedKeys.length).toBeGreaterThan(0);
	expect(await observedSends(primary)).toEqual([]);
	await primary.close();
	const takeover = (await successor.evaluate(
		(name) => window.phase5cSealVote.runDispatchScenario(name, "takeover-only"),
		databaseName
	)) as {
		readonly first: {
			readonly overflowReason: string;
			readonly sentKeys: readonly string[];
		};
		readonly inFlightPeak: number;
		readonly overflowReason: string | undefined;
		readonly second: {
			readonly overflowReason: string | undefined;
			readonly sentKeys: readonly string[];
		};
		readonly sentKeys: readonly string[];
	};
	expect(takeover.inFlightPeak).toBeLessThanOrEqual(4);
	expect(takeover.first.overflowReason).toBe("DISPATCH_QUEUE_FULL_RETRY_LATER");
	expect(takeover.first.sentKeys).toHaveLength(4);
	expect(takeover.second.overflowReason).toBeUndefined();
	expect(takeover.second.sentKeys).toHaveLength(6);
	expect(takeover.overflowReason).toBeUndefined();
	expect([...takeover.sentKeys].sort()).toEqual([...committed.committedKeys].sort());
	const rawSends = await observedSends(successor);
	expect(rawSends.length).toBe(committed.committedKeys.length);
	expect(rawSends.every(({ bytesHex }) => /^[0-9a-f]+$/u.test(bytesHex) && bytesHex.length > 0)).toBe(true);
	expect(rawSends.map(({ key }) => key).sort()).toEqual([...committed.committedKeys].sort());
});

test("a separate BrowserContext is a negative control and cannot satisfy shared-lock takeover", async ({ browser }) => {
	const leftContext = await browser.newContext();
	const rightContext = await browser.newContext();
	try {
		const left = await leftContext.newPage();
		const right = await rightContext.newPage();
		await Promise.all([left.goto(server?.origin ?? "about:blank"), right.goto(server?.origin ?? "about:blank")]);
		const databaseName = `phase-5c-negative-${crypto.randomUUID()}`;
		await left.evaluate((name) => window.phase5cSealVote.runDispatchScenario(name, "commit-only"), databaseName);
		const observed = await right.evaluate(
			(name) => window.phase5cSealVote.runDispatchScenario(name, "inspect-only"),
			databaseName
		);
		expect(observed).toMatchObject({ committedKeys: [], sentKeys: [] });
	} finally {
		await Promise.all([leftContext.close(), rightContext.close()]);
	}
});

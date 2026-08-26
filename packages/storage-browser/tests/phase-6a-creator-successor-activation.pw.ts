import "fake-indexeddb/auto";

import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const GREEN_PATHS = [
	"packages/node/src/creator-adoption-activate.ts",
	"packages/node/src/creator-adoption.ts",
	"packages/node/src/creator-adoption-commit.ts",
	"packages/node/src/creator-close.ts",
	"packages/node/src/internal/creator-adoption-intent.ts",
	"packages/node/src/internal/creator-successor-live.ts",
	"packages/node/src/v3-live.ts",
	"packages/node/package.json",
] as const;
const D108D1_BROWSER_BEHAVIORS = [
	"missing or hostile LockManager authority fails activation closed",
	"two tabs elect one lifetime-held writer then a freshly reverified loser wins after release",
] as const;

function ready(): boolean {
	if (!GREEN_PATHS.every((path) => existsSync(resolve(REPOSITORY_ROOT, path)))) return false;
	const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "packages/node/package.json"), "utf8")) as {
		readonly exports?: Readonly<Record<string, unknown>>;
	};
	const entry = manifest.exports?.["./creator-adoption-activate"] as Readonly<Record<string, unknown>> | undefined;
	return (
		entry?.types === "./dist/src/creator-adoption-activate.d.ts" &&
		entry.import === "./dist/src/creator-adoption-activate.js"
	);
}

const GREEN_READY = ready();
let material: unknown;
let server: Phase4cBrowserServer | undefined;

test.beforeAll(async () => {
	if (!GREEN_READY) return;
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
	});
});

test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.108d1 successor activation owners are intentionally absent in RED");

test("pins the complete browser behavior inventory", () => {
	expect(D108D1_BROWSER_BEHAVIORS).toEqual([
		"missing or hostile LockManager authority fails activation closed",
		"two tabs elect one lifetime-held writer then a freshly reverified loser wins after release",
	]);
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

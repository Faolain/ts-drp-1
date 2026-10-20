import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

// Slice 14f (specs/bounded-storage-lifecycle/slices/14f-retention-native-evidence.md),
// mechanism cases 1-4 for the slice 14a room retirement session, in Chromium, Firefox
// and WebKit. The process-death cases (5-9) are not covered here.

let server: Server;
let origin: string;

test.beforeAll(async () => {
	const entry = path.join(import.meta.dirname, "assets/room-retirement-session-native-entry.ts");
	const bundled = await build({
		bundle: true,
		entryPoints: [entry],
		format: "esm",
		platform: "browser",
		target: "es2022",
		write: false,
		nodePaths: [path.join(import.meta.dirname, "../node_modules")],
	});
	const script = bundled.outputFiles[0]!.contents;
	const html = '<!doctype html><meta charset="utf-8"><script type="module" src="/entry.js"></script>';
	server = createServer((request, response) => {
		if (request.url === "/entry.js") {
			response.writeHead(200, { "content-type": "text/javascript" });
			response.end(Buffer.from(script));
		} else {
			response.writeHead(200, { "content-type": "text/html" });
			response.end(html);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ready(page: Page): Promise<void> {
	await page.goto(origin + "/", { waitUntil: "load" });
	await page.waitForFunction(() => Reflect.get(globalThis, "r3SessionReady") === true);
}

async function run<T = Record<string, unknown>>(page: Page, name: string, arg?: string): Promise<T> {
	return (await page.evaluate(
		async ([caseName, caseArg]) =>
			(Reflect.get(globalThis, "r3SessionCase") as (n: string, a?: string) => Promise<unknown>)(caseName!, caseArg),
		[name, arg] as const
	)) as T;
}

test("case 1: the room session's read-write transaction is strict", async ({ page, browserName }) => {
	await ready(page);
	const result = await run(page, "strict");
	const version = page.context().browser()?.version();
	test.info().annotations.push({ type: "result", description: JSON.stringify({ browserName, version, result }) });
	expect(result).toEqual({ ok: true, durability: "strict", mode: "readwrite" });
});

test("case 2: one transaction over every owner store commits whole or not at all", async ({ page }) => {
	await ready(page);
	const result = await run<{
		stores: string[];
		before: Record<string, number>;
		afterAbort: Record<string, number>;
		refusedAfterAbort: boolean;
		afterCommit: Record<string, number>;
		ownerRefusal: string;
		commitAfterFailure: string;
		afterFailure: Record<string, number>;
	}>(page, "atomic");
	// Every owner namespace is in the one transaction.
	for (const prefix of ["ahe:", "snapshot:", "journal:", "issuance:"])
		expect(
			result.stores.some((store) => store.startsWith(prefix)),
			prefix
		).toBe(true);
	expect(result.stores).toContain("voteSlots");
	expect(result.afterAbort).toEqual(result.before);
	expect(result.refusedAfterAbort).toBe(true);
	for (const store of result.stores) expect(result.afterCommit[store], store).toBe(result.before[store]! + 1);
	expect(result.ownerRefusal).toContain("owner refusal");
	expect(result.commitAfterFailure).not.toBe("committed");
	expect(result.afterFailure).toEqual(result.afterCommit);
});

test("case 2: a checkpoint is durable and an abort discards only what follows it", async ({ page }) => {
	await ready(page);
	expect(await run(page, "checkpoint")).toEqual({ afterCheckpoint: 1, journal: 1, issuance: 0 });
});

test("case 3: another page's strict writer is ordered after the session", async ({ context }) => {
	const owner = await context.newPage();
	const foreign = await context.newPage();
	await ready(owner);
	await ready(foreign);
	const name = `r3-native-serial-${Date.now()}`;
	await run(owner, "hold-open", name);
	const started = await run<{ settledEarly: boolean }>(foreign, "foreign-write", name);
	expect(started.settledEarly).toBe(false);
	const committed = await run<{ committedAt: number; finishedAt: number }>(owner, "commit-held");
	const done = await run<{ completedAt: number; rows: number[][] }>(foreign, "foreign-done", name);
	expect(done.completedAt).toBeGreaterThanOrEqual(committed.committedAt);
	expect(done.rows).toEqual([[9]]);
});

test("case 4: a higher version from another page ends the session and fences version 7", async ({ context }) => {
	const owner = await context.newPage();
	const upgrader = await context.newPage();
	await ready(owner);
	await ready(upgrader);
	const name = `r3-native-fence-${Date.now()}`;
	await run(owner, "hold-open", name);
	const upgraded = await run<{ version: number }>(upgrader, "upgrade", name);
	expect(upgraded.version).toBe(8);
	const late = await run<{ ok: boolean; error?: string }>(owner, "run-held");
	expect(late.ok).toBe(false);
	const reopened = await run<{ session: string; pinned: string }>(owner, "reopen-pinned", name);
	expect(reopened.session).not.toBe("opened");
	expect(reopened.pinned).toContain("VersionError");
	// The write the ended session held was never committed.
	expect(await run(upgrader, "journal-rows", name)).toEqual({ rows: [] });
});

test("a database that is not a ready room is refused before any write", async ({ page }) => {
	await ready(page);
	const result = await run<{ legacySession: string; missingSession: string }>(page, "not-ready");
	expect(result.legacySession).not.toBe("opened");
	expect(result.missingSession).not.toBe("opened");
});

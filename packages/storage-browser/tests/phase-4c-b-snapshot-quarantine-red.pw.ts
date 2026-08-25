import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Phase4cBServer, startPhase4cBServer } from "./phase-4c-b-snapshot-quarantine-server.js";
import {
	SNAPSHOT_QUARANTINE_RETENTION_MS,
	SNAPSHOT_QUARANTINE_SCHEMA,
} from "../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-contract.js";

const OWNER = resolve(fileURLToPath(new URL("../src/snapshot-transfer.ts", import.meta.url)));
const ownerExists = existsSync(OWNER);
let server: Phase4cBServer;

test.beforeAll(async () => {
	if (ownerExists) server = await startPhase4cBServer();
});

test.afterAll(async () => {
	if (ownerExists) await server.close();
});

test.skip(!ownerExists, "Phase 4c-b browser owner is intentionally absent in RED");

test("admits the exact isolated schema in Chromium, Firefox and WebKit", async ({ page }) => {
	await page.goto(server.origin);
	await page.waitForFunction(() => typeof window.phase4cBRun === "function");
	const value = (await page.evaluate(() => window.phase4cBRun("schema"))) as {
		chunks: number;
		estimateCalls: number;
		schema: Record<string, unknown>;
		scopeFields: readonly string[];
		scopes: number;
		strict: boolean;
	};
	expect(value.chunks).toBe(0);
	expect(value.scopes).toBe(1);
	expect(value.estimateCalls).toBe(1);
	expect(value.strict).toBe(true);
	expect(value.schema).toEqual({
		chunkKeyPath: SNAPSHOT_QUARANTINE_SCHEMA.browser.chunksKeyPath,
		expiryIndex: true,
		scopeKeyPath: SNAPSHOT_QUARANTINE_SCHEMA.browser.scopesKeyPath,
		stores: SNAPSHOT_QUARANTINE_SCHEMA.browser.stores,
		version: 1,
	});
	expect(value.scopeFields).toEqual(SNAPSHOT_QUARANTINE_SCHEMA.browser.scopeFields);
});

test("copies bounded carriers before await and rejects unsupported schema exactly", async ({ page }) => {
	await page.goto(server.origin);
	await page.waitForFunction(() => typeof window.phase4cBRun === "function");
	const carriers = (await page.evaluate(() => window.phase4cBRun("carriers"))) as Record<string, unknown>;
	expect(carriers.hostile).toBe("invalid-carrier");
	expect(carriers.aborted).toBe("aborted");
	expect(carriers.afterClose).toBe("closed");
	expect(carriers.status).toMatchObject({ kind: "open" });
	expect(carriers.detachedRead).toBe(true);
	const schema = (await page.evaluate(() => window.phase4cBRun("unsupported-schema"))) as Record<string, unknown>;
	expect(schema.code).toBe("unsupported-schema");
});

test("shares non-prefix resume, duplicate, conflict, poison and cancel semantics", async ({ page }) => {
	await page.goto(server.origin);
	await page.waitForFunction(() => typeof window.phase4cBRun === "function");
	const value = (await page.evaluate(() => window.phase4cBRun("lifecycle"))) as Record<string, unknown>;
	expect(value.missing).toEqual([0, 2]);
	expect(value.duplicateExpiry).toBe(value.firstExpiry);
	expect(value.detachedRead).toBe(true);
	expect(value.declarationFailures).toEqual([
		"malformed-input",
		"malformed-input",
		"malformed-input",
		"malformed-input",
		"invalid-carrier",
		"invalid-carrier",
		"invalid-carrier",
	]);
	expect(value.foreign).toBe("malformed-input");
	expect(value.conflict).toBe("conflict");
	expect(value.poisoned).toBe("poisoned");
	expect(value.afterCancel).toMatchObject({ chunks: 0, scopes: 0 });
});

test("consumes the one-use receipt and returns only an opaque verified reference", async ({ page }) => {
	await page.goto(server.origin);
	await page.waitForFunction(() => typeof window.phase4cBRun === "function");
	const value = (await page.evaluate(() => window.phase4cBRun("receipt"))) as Record<string, unknown>;
	expect(value.completion).toMatchObject({ chunkCount: 3, exactByteLength: 262_149 });
	expect(value.reference).toMatchObject({ chunkCount: 3, exactByteLength: 262_149 });
	expect(value.reference).not.toHaveProperty("bytes");
	expect(value.reference).not.toHaveProperty("database");
	expect(value.replay).toBe("receipt-invalid");
	expect(value.rows).toMatchObject({ chunks: 3, scopes: 1 });
	expect(value.rows).toMatchObject({
		chunkFields: SNAPSHOT_QUARANTINE_SCHEMA.browser.chunkFields,
		chunkLengths: [131_072, 131_072, 5],
		scopeFields: SNAPSHOT_QUARANTINE_SCHEMA.browser.scopeFields,
	});
});

test("sweeps at the exact owner-local retention boundary", async ({ page }) => {
	await page.goto(server.origin);
	await page.waitForFunction(() => typeof window.phase4cBRun === "function");
	const value = (await page.evaluate(() => window.phase4cBRun("expiry"))) as Record<string, unknown>;
	expect(value.expiresAt).toBe(4_000 + SNAPSHOT_QUARANTINE_RETENTION_MS);
	expect(value.before).toBe(0);
	expect(value.at).toBe(1);
	expect(value.rows).toMatchObject({ chunks: 0, scopes: 0 });
});

test("terminates a genuine writer and reopens only old-or-exact-new state", async ({ browser }) => {
	const firstContext = await browser.newContext();
	const firstPage = await firstContext.newPage();
	await firstPage.goto(server.origin);
	for (const target of [
		{ edge: "precommit", operation: "manifest" },
		{ edge: "postcommit", operation: "manifest" },
		{ edge: "precommit", operation: "chunk" },
		{ edge: "postcommit", operation: "chunk" },
	] as const) {
		const primaryDatabaseName = `phase4cb-death-${target.operation}-${target.edge}-${crypto.randomUUID()}`;
		const outcome = await firstPage.evaluate(
			async ({ name, selectedTarget }) => {
				const worker = new Worker("/worker.js", { type: "module" });
				const first = await new Promise<Record<string, string>>((resolvePromise, reject) => {
					worker.onerror = (): void => reject(new Error("worker failed"));
					worker.onmessage = (event): void => resolvePromise(event.data as Record<string, string>);
					worker.postMessage({ primaryDatabaseName: name, target: selectedTarget });
				});
				worker.terminate();
				return first;
			},
			{ name: primaryDatabaseName, selectedTarget: target }
		);
		expect(outcome).toEqual({ edge: target.edge, kind: "checkpoint", operation: target.operation });
		const reopenedPage = await firstContext.newPage();
		await reopenedPage.goto(server.origin);
		await reopenedPage.waitForFunction(() => typeof window.phase4cBRun === "function");
		const reopened = (await reopenedPage.evaluate(
			(name) => window.phase4cBRun("death-reopen", name),
			primaryDatabaseName
		)) as { missing: readonly number[]; rows: { chunks: number; scopes: number } };
		const chunkCommitted = target.operation === "chunk" && target.edge === "postcommit";
		expect(reopened.missing).toEqual(chunkCommitted ? [] : [0]);
		expect(reopened.rows).toEqual({ chunks: chunkCommitted ? 1 : 0, scopes: 1 });
		await reopenedPage.close();
	}
	await firstContext.close();
});

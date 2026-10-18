import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OWNER = resolve(CURRENT_DIRECTORY, "../../node/src/snapshot-transfer.ts");
const ENTRY = resolve(CURRENT_DIRECTORY, "assets/phase-4c-c-snapshot-transfer-entry.ts");
const SOURCE_ENTRY = resolve(CURRENT_DIRECTORY, "assets/phase-4c-c-snapshot-source-entry.ts");
const ownerExists = existsSync(OWNER);
let sourceServer: Phase4cBrowserServer | undefined;
let transferServer: Phase4cBrowserServer | undefined;

declare global {
	interface Window {
		phase4cCResume(): Promise<unknown>;
		phase4cCSource(): Promise<unknown>;
	}
}

test.beforeAll(async () => {
	sourceServer = await startPhase4cBrowserServer({ entryPoint: SOURCE_ENTRY });
	if (ownerExists) transferServer = await startPhase4cBrowserServer({ entryPoint: ENTRY });
});

test.afterAll(async () => {
	await transferServer?.close();
	await sourceServer?.close();
});

test("prepares, recovers, folds, adopts and exports the genuine browser source", async ({ page }) => {
	if (sourceServer === undefined) throw new TypeError("Phase 4c-c source server is absent");
	await page.goto(sourceServer.origin);
	await page.waitForFunction(() => typeof window.phase4cCSource === "function");
	const result = (await page.evaluate(() => window.phase4cCSource())) as {
		byteLength: number;
		chunkCount: number;
		payloadDigest: string;
		stable: boolean;
	};
	expect(result.byteLength).toBeGreaterThan(16_384);
	expect(result.byteLength).toBeLessThanOrEqual(131_072);
	expect(result.chunkCount).toBe(1);
	expect(result.payloadDigest).toMatch(/^[0-9a-f]{64}$/u);
	expect(result.stable).toBe(true);
});

test("interrupts, reopens IndexedDB, resumes the exact missing set and verifies terminally", async ({ page }) => {
	test.skip(!ownerExists, "Phase 4c-c transfer owner is intentionally absent in RED");
	if (transferServer === undefined) throw new TypeError("Phase 4c-c transfer server is absent");
	await page.goto(transferServer.origin);
	await page.waitForFunction(() => typeof window.phase4cCResume === "function");
	const result = (await page.evaluate(() => window.phase4cCResume())) as {
		beforeResume: readonly number[];
		byteIdentical: boolean;
		expectedFetched: readonly number[];
		expectedReceivedBytes: number;
		fetchedIndices: readonly number[];
		interruptedCode: string;
		receivedBytes: number;
		retainedMissing: readonly number[];
		reusedIndices: readonly number[];
		snapshotClosed: boolean;
		sourceUnchanged: boolean;
		status: Readonly<{ readonly kind: string; readonly missingIndices: readonly number[] }>;
	};
	expect(result.interruptedCode).toBe("aborted");
	expect(result.expectedFetched).toEqual([0]);
	expect(result.retainedMissing).toEqual(result.expectedFetched);
	expect(result.beforeResume).toEqual(result.expectedFetched);
	expect(result.reusedIndices).toEqual([]);
	expect(result.fetchedIndices).toEqual(result.expectedFetched);
	expect(result.receivedBytes).toBe(result.expectedReceivedBytes);
	expect(result.status).toMatchObject({ kind: "verified", missingIndices: [] });
	expect(result.byteIdentical).toBe(true);
	expect(result.snapshotClosed).toBe(true);
	expect(result.sourceUnchanged).toBe(true);
});

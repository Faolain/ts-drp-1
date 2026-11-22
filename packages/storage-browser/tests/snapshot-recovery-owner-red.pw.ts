import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

import type {} from "./assets/snapshot-recovery-owner-entry.js";
import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";
import { COMMON_CASES, expectedCommonCase } from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";

let server: Phase4cBrowserServer;
test.beforeAll(async () => {
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(import.meta.dirname, "assets/snapshot-recovery-owner-entry.ts"),
	});
});
test.afterAll(async () => {
	await server.close();
});
test.beforeEach(async ({ page }) => {
	await page.goto(server.origin);
	await page.waitForFunction(() => typeof window.runSnapshotRecoveryOwner === "function");
});

for (const name of COMMON_CASES)
	test(`1a-0 native snapshot owner ${name}`, async ({ page }, testInfo) => {
		const result = await page.evaluate((selected) => window.runSnapshotRecoveryOwner(selected), name);
		await testInfo.attach("owner-observation", {
			body: Buffer.from(JSON.stringify(result)),
			contentType: "application/json",
		});
		expect(result).toEqual(expectedCommonCase(name));
	});

test("actual old browser owner closes on versionchange and cannot mutate or reopen v2", async ({ page }, testInfo) => {
	const result = await page.evaluate(() => window.runSnapshotRecoveryOwner("versionchange"));
	await testInfo.attach("old-client-observation", {
		body: Buffer.from(JSON.stringify(result)),
		contentType: "application/json",
	});
	expect(result).toEqual({
		version: 2,
		changes: [{ oldVersion: 1, newVersion: 2 }],
		oldRefused: true,
		unchanged: true,
	});
});

test("sweep preserves unsupported-schema classification for missing owner metadata without mutation", async ({
	page,
}) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("owner-metadata-sweep"))).toEqual({
		code: "unsupported-schema",
		unchanged: true,
	});
});

test("uncooperative v1 client blocks migration and late unblock cannot commit or leak", async ({ page }, testInfo) => {
	const result = await page.evaluate(() => window.runSnapshotRecoveryOwner("blocked-open"));
	await testInfo.attach("blocked-open-observation", {
		body: Buffer.from(JSON.stringify(result)),
		contentType: "application/json",
	});
	expect(result).toEqual({
		code: "storage-failed",
		diagnostic: true,
		blockedObserved: true,
		stayedPending: true,
		bounded: true,
		version: 1,
		unchanged: true,
		noLeak: true,
	});
});

test("malformed v1 schema is refused without committing an upgrade", async ({ page }) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("malformed-schema"))).toEqual({
		code: "unsupported-schema",
		unchanged: true,
		version: 1,
	});
});

test("low-free-space legacy reopen does not estimate hypothetical new payload admission", async ({ page }) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("low-space"))).toEqual({
		estimateCalls: 0,
		exactBytes: true,
		migration: "classification-required",
		unchanged: true,
	});
});

test("legacy arithmetic overflow rolls back admission without truncation", async ({ page }) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("overflow"))).toEqual({
		code: "storage-failed",
		version: 1,
		unchanged: true,
	});
});

test("synchronous injected metadata QuotaExceededError preserves v1 (not real disk exhaustion)", async ({ page }) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("allocation-failure"))).toEqual({
		code: "storage-failed",
		injected: true,
		version: 1,
		unchanged: true,
	});
});

test("native upgrade transaction abort after asynchronous request success preserves v1", async ({ page }) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("async-upgrade-abort"))).toEqual({
		code: "storage-failed",
		requestSucceeded: true,
		abortObserved: true,
		nativeOpenError: "AbortError",
		version: 1,
		unchanged: true,
	});
});

test("pinned-v1 native abort control observes request success then actual transaction abort", async ({ page }) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("async-upgrade-abort-control"))).toEqual({
		code: "AbortError",
		requestSucceeded: true,
		abortObserved: true,
		nativeOpenError: "AbortError",
		version: 1,
		unchanged: true,
	});
});

test("pinned-v1 native durable-image control detects metadata-only changes", async ({ page }) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("durable-image-control"))).toEqual({
		detected: [true, true, true, true],
	});
});

test("cooperative unblock disarms deadline during a slow native upgrade transaction", async ({ page }) => {
	expect(await page.evaluate(() => window.runSnapshotRecoveryOwner("cooperative-upgrade"))).toEqual({
		code: "none",
		blocked: true,
		released: true,
		upgradeExceededDeadline: true,
		version: 2,
		unchanged: true,
	});
});

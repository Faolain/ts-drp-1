import { expect, test } from "@playwright/test";

import { bundleBrowserFixture } from "./fixtures/bundle.js";
import { CUSTODY_SCHEMA, type HandshakeCustody, validateCustody } from "./fixtures/custody.js";

test("module-worker harness control is live", async ({ page }) => {
	await page.setContent("<!doctype html><title>worker-host control</title>");
	const result = await page.evaluate(async (): Promise<number> => {
		const source = "self.onmessage = event => self.postMessage(event.data + 1)";
		const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
		try {
			const worker = new Worker(url, { type: "module" });
			return await new Promise<number>((resolve, reject) => {
				worker.onerror = (): void => reject(new Error("control worker failed"));
				worker.onmessage = (event): void => {
					worker.terminate();
					resolve(Number(event.data));
				};
				worker.postMessage(6);
			});
		} finally {
			URL.revokeObjectURL(url);
		}
	});
	expect(result).toBe(7);
});

test("ready ordering and never-ready recovery produce exact engine custody", async ({
	browser,
	browserName,
	page,
}, testInfo) => {
	expect(["firefox", "webkit"]).toContain(browserName);
	const [pageSource, workerSource] = await Promise.all([
		bundleBrowserFixture(new URL("./fixtures/page-entry.ts", import.meta.url), "iife"),
		bundleBrowserFixture(new URL("./fixtures/positive-worker.ts", import.meta.url), "esm"),
	]);
	await page.setContent("<!doctype html><title>worker-host handshake</title>");
	await page.addScriptTag({ content: pageSource });
	const identity = await page.evaluate(() => ({ os: navigator.platform }));
	const positive = await page.evaluate(async (source) => {
		return (
			globalThis as typeof globalThis & {
				Phase2fBHandshake: { runPositive(source: string): Promise<Record<string, unknown>> };
			}
		).Phase2fBHandshake.runPositive(source);
	}, workerSource);
	expect(positive).toMatchObject({ chunks: 1, marker: "handshake-ok", state: "ready" });
	expect(positive.bytes).toBeGreaterThan(0);
	expect(positive.requestReceivedAtMs).toBeGreaterThanOrEqual(positive.readySentAtMs as number);

	const neverReady = await page.evaluate(async () => {
		return (
			globalThis as typeof globalThis & {
				Phase2fBHandshake: { runNeverReady(source: string): Promise<Record<string, unknown>> };
			}
		).Phase2fBHandshake.runNeverReady("self.onmessage = () => undefined");
	});
	expect(neverReady).toMatchObject({ code: "worker-host-handshake-timeout", state: "terminated" });
	expect(neverReady.durationMs).toBeLessThan(5_000);

	const common = {
		schema: CUSTODY_SCHEMA,
		engine: browserName as "firefox" | "webkit",
		build: browser.version(),
		os: identity.os,
		verdict: "pass" as const,
	} as const;
	const custody: HandshakeCustody[] = [
		{
			...common,
			scenario: "ready-ordering",
			readySentAtMs: positive.readySentAtMs as number,
			requestReceivedAtMs: positive.requestReceivedAtMs as number,
			chunks: positive.chunks as number,
			bytes: positive.bytes as number,
		},
		{
			...common,
			scenario: "never-ready",
			readySentAtMs: null,
			requestReceivedAtMs: null,
			chunks: 0,
			bytes: 0,
		},
	];
	for (const record of custody) validateCustody(record);
	expect(custody.map((record) => record.scenario).sort()).toEqual(["never-ready", "ready-ordering"]);
	await testInfo.attach("phase-2f-b-custody.json", {
		body: Buffer.from(JSON.stringify(custody)),
		contentType: "application/json",
	});
});

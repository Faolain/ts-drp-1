import { type BrowserContext, expect, test, type TestInfo } from "@playwright/test";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { type AnchorEvidence, expectedAnchorOutcomes } from "../../../tests/fixtures/journal-anchor-read/assertions.js";
import { ANCHOR_CASES, anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import { decodeCanonical, hashDomain } from "../../canonical/dist/src/index.js";

let server: http.Server;
let url: string;
test.beforeAll(async () => {
	const bundle = await build({
		bundle: true,
		entryPoints: [path.resolve("tests/fixtures/journal-anchor-read/browser-entry.ts")],
		format: "esm",
		metafile: true,
		platform: "browser",
		target: "es2022",
		write: false,
	});
	const bytes = bundle.outputFiles[0]?.contents;
	if (bytes === undefined) throw new Error("missing browser bundle");
	console.log(
		JSON.stringify({
			runtimeBinding: "journal-anchor-browser",
			bundleSha256: createHash("sha256").update(bytes).digest("hex"),
			inputs: Object.keys(bundle.metafile?.inputs ?? {}).map((file) => ({
				file,
				sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
			})),
		})
	);
	server = http.createServer((request, response) => {
		response.setHeader("Cache-Control", "no-store");
		if (request.url === "/anchor.js") response.writeHead(200, { "Content-Type": "text/javascript" }).end(bytes);
		else if (request.url === "/")
			response
				.writeHead(200, { "Content-Type": "text/html" })
				.end('<!doctype html><meta charset="utf-8"><script type="module" src="/anchor.js"></script>');
		else response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing server address");
	url = `http://127.0.0.1:${address.port}/`;
});
test.afterAll(
	() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
);

async function cleanupDatabase(context: BrowserContext, name: string, testInfo: TestInfo): Promise<void> {
	const page = await context.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.journalAnchorRemove === "function");
		await page.evaluate((name) => window.journalAnchorRemove(name), name);
		await testInfo.attach("owned-cleanup", {
			body: JSON.stringify({ name, deleted: true, setupAndRecoveryPagesClosed: true }),
			contentType: "application/json",
		});
	} finally {
		await page.close();
	}
}

function exactGetOnlyEvents(traces: readonly Record<string, unknown>[]): boolean {
	return traces.every((entry) => ["transaction", "get", "complete", "abort"].includes(String(entry.operation)));
}

test("control: native exact get plus range getKey is observed and rejected", async ({ context }, testInfo) => {
	const name = `anchor-getkey-control-${testInfo.project.name}-${Date.now()}`;
	const setupPage = await context.newPage();
	let recoveryPage;
	try {
		await setupPage.goto(url);
		await setupPage.waitForFunction(() => typeof window.journalAnchorSetup === "function");
		const setup = (await setupPage.evaluate((name) => window.journalAnchorSetup(name, "genesis"), name)) as {
			installed: unknown;
			expectedScope: unknown;
			realm: number;
		};
		await setupPage.close();
		recoveryPage = await context.newPage();
		await recoveryPage.goto(url);
		await recoveryPage.waitForFunction(() => typeof window.journalAnchorGetKeyControl === "function");
		const value = (await recoveryPage.evaluate((name) => window.journalAnchorGetKeyControl(name), name)) as {
			baseline: unknown;
			observed: unknown;
			traces: Record<string, unknown>[];
			key: unknown[];
			expectedBytes: number[];
			rangeArgumentSame: boolean;
			prototypesRestored: boolean;
			realm: number;
		};
		await testInfo.attach("native-getkey-control", {
			body: JSON.stringify({ setup, value }),
			contentType: "application/json",
		});
		expect(setup.installed).toMatchObject({ ok: true, scope: setup.expectedScope });
		expect(value.realm).not.toBe(setup.realm);
		expect(value.baseline).toEqual({
			exactBytes: value.expectedBytes,
			occupancyKey: value.key,
			nativeRequests: true,
			readyStates: ["done", "done"],
			successes: 2,
			terminal: "complete",
		});
		expect(value.observed).toEqual(value.baseline);
		expect(value.rangeArgumentSame).toBe(true);
		expect(value.prototypesRestored).toBe(true);
		expect(value.traces).toEqual([
			{ mode: "readonly", operation: "transaction", stores: ["scopes"] },
			{ operation: "get", store: "scopes", key: value.key },
			{ operation: "getKey", store: "scopes", key: {} },
			{ operation: "complete" },
		]);
		expect(exactGetOnlyEvents(value.traces.filter((entry) => entry.operation !== "getKey"))).toBe(true);
		expect(exactGetOnlyEvents(value.traces)).toBe(false);
	} finally {
		await setupPage.close();
		await recoveryPage?.close();
		await cleanupDatabase(context, name, testInfo);
	}
});

for (const id of ["genesis", "non-genesis"] as const)
	test(`control: fresh native installed ${id} bytes and8193 clone`, async ({ context }, testInfo) => {
		const name = `anchor-control-${testInfo.project.name}-${id}-${Date.now()}`;
		const setupPage = await context.newPage();
		let recoveryPage;
		try {
			await setupPage.goto(url);
			await setupPage.waitForFunction(() => typeof window.journalAnchorSetup === "function");
			const setup = (await setupPage.evaluate(([name, id]) => window.journalAnchorSetup(name, id), [
				name,
				id,
			] as const)) as { installed: unknown; expectedScope: unknown; realm: number };
			await setupPage.close();
			recoveryPage = await context.newPage();
			await recoveryPage.goto(url);
			await recoveryPage.waitForFunction(() => typeof window.journalAnchorControl === "function");
			const value = (await recoveryPage.evaluate(([name, id]) => window.journalAnchorControl(name, id), [
				name,
				id,
			] as const)) as { before: unknown; expectedBytes: unknown; nativeLength: number; entries: number; realm: number };
			await testInfo.attach("native-anchor-control", {
				body: JSON.stringify({ setup, value }),
				contentType: "application/json",
			});
			expect(setup.installed).toMatchObject({ ok: true, scope: setup.expectedScope });
			expect(value.before).toEqual(value.expectedBytes);
			expect(value.nativeLength).toBe(8193);
			expect(value.entries).toBe(0);
			expect(value.realm).not.toBe(setup.realm);
		} finally {
			await setupPage.close();
			await recoveryPage?.close();
			await cleanupDatabase(context, name, testInfo);
		}
	});

for (const id of ANCHOR_CASES)
	test(`fresh IndexedDB exact anchor: ${id}`, async ({ context }, testInfo) => {
		const name = `anchor-${testInfo.project.name}-${id}-${Date.now()}`;
		const setupPage = await context.newPage();
		let recoveryPage;
		try {
			await setupPage.goto(url);
			await setupPage.waitForFunction(() => typeof window.journalAnchorSetup === "function");
			const setup = (await setupPage.evaluate(([name, id]) => window.journalAnchorSetup(name, id), [
				name,
				id,
			] as const)) as { installed: unknown; expectedScope: unknown; realm: number };
			await setupPage.close();
			recoveryPage = await context.newPage();
			await recoveryPage.goto(url);
			await recoveryPage.waitForFunction(() => typeof window.journalAnchorRecover === "function");
			const value = (await recoveryPage.evaluate(([name, id]) => window.journalAnchorRecover(name, id), [
				name,
				id,
			] as const)) as AnchorEvidence & { realm: number };
			await testInfo.attach("native-anchor-observation", {
				body: JSON.stringify({ id, setup, value }),
				contentType: "application/json",
			});
			expect(setup.installed).toMatchObject({ ok: true, scope: setup.expectedScope });
			expect(value.realm).not.toBe(setup.realm);
			if (id === "scope") {
				const rows = (
					value.before as {
						scopes: {
							exactCanonicalAnchorPreimageBytes: object;
							objectId: string;
							epoch: number;
							anchorDigest: string;
						}[];
					}
				).scopes;
				expect(rows).toHaveLength(1);
				const row = rows[0];
				if (row === undefined) throw new Error("missing exact raw scope precondition");
				const actualBytes = Uint8Array.from(Object.values(row.exactCanonicalAnchorPreimageBytes) as number[]);
				const decoded = decodeCanonical(actualBytes) as { objectId: string; epoch: number };
				const digest = Buffer.from(hashDomain("ts-drp/epoch-anchor/v3", actualBytes)).toString("hex");
				expect(actualBytes).toEqual(anchorMaterial(1).bytes);
				expect(decoded).toMatchObject({ objectId: row.objectId, epoch: 1 });
				expect(row.epoch).toBe(0);
				expect(row.anchorDigest).toBe(digest);
				expect((value as unknown as { requestedInput: unknown }).requestedInput).toEqual({
					maxBytes: 8192,
					scope: { objectId: row.objectId, epoch: row.epoch, anchorDigest: row.anchorDigest },
				});
				expect(value.expectedScope).toEqual({ objectId: row.objectId, epoch: 0, anchorDigest: digest });
			}
			expect(value.results).toEqual(expectedAnchorOutcomes(value, id));
			if (id !== "replace-delete" && id !== "poison-close") expect(value.after).toEqual(value.before);
			expect(value.getterReads).toBe(0);
			if (id === "invalid-input" || id === "close" || id === "capture-close") expect(value.traces).toEqual([]);
			else if (id !== "capture" && id !== "poison-close" && id !== "executing-close" && id !== "independent-session") {
				const transactions = value.traces.filter((entry) => entry.operation === "transaction");
				expect(transactions).toEqual([{ mode: "readonly", operation: "transaction", stores: ["scopes"] }]);
				const scope = value.expectedScope as { objectId: string; epoch: number; anchorDigest: string };
				expect(value.traces.filter((entry) => entry.operation === "get")).toEqual([
					{
						operation: "get",
						store: "scopes",
						key: [scope.objectId, scope.epoch, id === "neighbor-missing" ? "f".repeat(64) : scope.anchorDigest],
					},
				]);
				expect(exactGetOnlyEvents(value.traces)).toBe(true);
			}
		} finally {
			await setupPage.close();
			await recoveryPage?.close();
			await cleanupDatabase(context, name, testInfo);
		}
	});

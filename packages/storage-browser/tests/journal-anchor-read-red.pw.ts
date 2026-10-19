import { type BrowserContext, expect, test, type TestInfo } from "@playwright/test";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { type AnchorEvidence, expectedAnchorOutcomes } from "../../../tests/fixtures/journal-anchor-read/assertions.js";
import { type AnchorCase, ANCHOR_CASES, anchorMaterial } from "../../../tests/fixtures/journal-anchor-read/material.js";
import { decodeCanonical, hashDomain } from "../../canonical/dist/src/index.js";

// Page globals installed by the bundled journal-anchor browser entry, which
// lives outside this package's program (see its own declarations).
declare global {
	interface Window {
		journalAnchorSetup(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorRecover(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorControl(name: string, id: AnchorCase): Promise<unknown>;
		journalAnchorGetKeyControl(name: string): Promise<unknown>;
		journalRetirementExactRows(name: string): Promise<unknown>;
		journalRetirementSourceImage(name: string): Promise<unknown>;
		journalAnchorRemove(name: string): Promise<void>;
		journalRetirementNoops(name: string): Promise<unknown>;
		journalPhysicalHeaderBounds(name: string): Promise<unknown>;
	}
}

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

test("journal noncreating retirement source image borrows original native custody", async ({ context }, info) => {
	const name = `journal-retirement-source-${info.project.name}-${Date.now()}`;
	const page = await context.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.journalRetirementSourceImage === "function");
		const result = await page.evaluate((name) => window.journalRetirementSourceImage(name), name);
		await info.attach("native-journal-retirement-source-image", {
			body: JSON.stringify(result),
			contentType: "application/json",
		});
		expect(result).toMatchObject({
			absent: { ok: false, kind: "not-installed" },
			exact: true,
			originalImage: true,
			detached: true,
			frozen: true,
			controlAbsent: true,
			readOnlyBorrowed: true,
			underHeldControl: { ok: false, kind: "retirement-transition" },
			birthPreserved: true,
			oversize: { ok: false, kind: "retirement-fenced" },
			malformed: { ok: false, kind: "substrate-failure" },
			failedBorrowedReadDidNotRelease: true,
			restored: true,
		});
	} finally {
		await page.close();
		await cleanupDatabase(context, name, info);
	}
});

test("journal retirement exposes exact bounded native rows with joined one-use custody", async ({ context }, info) => {
	const name = `journal-retirement-rows-${info.project.name}-${Date.now()}`;
	const page = await context.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.journalRetirementExactRows === "function");
		const result = await page.evaluate((name) => window.journalRetirementExactRows(name), name);
		await info.attach("native-journal-retirement-rows", {
			body: JSON.stringify(result),
			contentType: "application/json",
		});
		expect(result).toMatchObject({
			exact: true,
			originalImageUnchanged: true,
			frozen: true,
			detached: true,
			receiverRefused: true,
			releasedRefused: true,
			consumedRefused: true,
			staleResult: { ok: false, kind: "retirement-stale" },
			nativeCounts: { scopes: 2, rows: 1 },
		});
		const final = (result as { finalCensus: { scopes: unknown[]; entries: unknown[] } }).finalCensus;
		expect(final.scopes).toHaveLength(2);
		expect(final.entries).toHaveLength(2);
	} finally {
		await page.close();
		await cleanupDatabase(context, name, info);
	}
});

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

test("journal exact retries preserve native retirement control while real writes and fences remain", async ({
	context,
}, info) => {
	const name = `journal-retirement-noops-${info.project.name}-${Date.now()}`;
	const page = await context.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.journalRetirementNoops === "function");
		const result = await page.evaluate((name) => window.journalRetirementNoops(name), name);
		await info.attach("native-journal-exact-noops", { body: JSON.stringify(result), contentType: "application/json" });
		expect(result).toMatchObject({
			passed: true,
			cryptoAuthority: false,
			physicalDeletion: false,
			noops: ["genesis", "epoch-anchor", "historical-import", "append"],
			refusals: ["genesis", "epoch-anchor", "historical-import", "append"],
			transitions: [
				{ label: "append-new", before: 0, after: 1, scopes: 2, rows: 2 },
				{ label: "install-new", before: 1, after: 2, scopes: 3, rows: 2 },
				{ label: "import-new", before: 2, after: 3, scopes: 4, rows: 2 },
				{ label: "append-protected", before: 3, after: 4, scopes: 4, rows: 3 },
				{ label: "future-install", before: 5, after: 6, scopes: 5, rows: 3 },
			],
		});
	} finally {
		await page.close();
		await cleanupDatabase(context, name, info);
	}
});
test("journal physical eight-header image is complete while role and resource bounds remain distinct", async ({
	context,
}, info) => {
	const name = "journal-eight-headers-" + info.project.name + "-" + Date.now();
	const page = await context.newPage();
	try {
		await page.goto(url);
		await page.waitForFunction(() => typeof window.journalPhysicalHeaderBounds === "function");
		const result = await page.evaluate((name) => window.journalPhysicalHeaderBounds(name), name);
		await info.attach("native-journal-eight-header-bounds", {
			body: JSON.stringify(result),
			contentType: "application/json",
		});
		expect(result).toMatchObject({ passed: true, cryptoAuthority: false, physicalDeletion: false });
		expect((result as { checks: readonly string[] }).checks).toEqual([
			"exact-eight-headers-and-rows",
			"no-control-birth",
			"physical-scope-overflow",
			"physical-row-overflow",
			"physical-byte-overflow",
			"seven-protected-scopes-bound",
			"seven-prefix-bound",
			"all-headers-retained",
			"same-database-reopen",
		]);
	} finally {
		await page.close();
		await cleanupDatabase(context, name, info);
	}
});

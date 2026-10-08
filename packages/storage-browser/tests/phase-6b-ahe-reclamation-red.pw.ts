import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

let origin = "";
let server: Server;
const tokens = new Set<string>();

test.beforeAll(async () => {
	const directory = process.env.PHASE_6B_AHE_RECLAMATION_ASSET_DIR;
	if (directory === undefined) throw new TypeError("D109C_BROWSER_ASSETS_MISSING");
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const [, token, asset] = url.pathname.split("/");
		if (!tokens.has(token ?? "") || !/^phase-6b-ahe-reclamation(?:-worker)?\.(?:html|js)$/u.test(asset ?? "")) {
			response.writeHead(404).end();
			return;
		}
		try {
			response
				.writeHead(200, {
					"content-type": asset?.endsWith(".js") === true ? "text/javascript" : "text/html",
					"cross-origin-embedder-policy": "require-corp",
					"cross-origin-opener-policy": "same-origin",
				})
				.end(readFileSync(join(directory, asset as string)));
		} catch {
			response.writeHead(404).end();
		}
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	if (address === null || typeof address === "string") throw new TypeError("D109C_BROWSER_SERVER_BIND_FAILED");
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolvePromise, reject) =>
		server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
	);
});

function transition(): Readonly<{ readonly token: string; readonly url: string }> {
	const token = crypto.randomUUID();
	tokens.add(token);
	return Object.freeze({ token, url: `${origin}/${token}/phase-6b-ahe-reclamation.html` });
}

test("[RED readiness] requires the browser identity owner and strict reclamation transaction", async ({ page }) => {
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const ready = await page.evaluate(() =>
			Boolean(
				(globalThis as unknown as { phase6bAheReclamation?: { readonly ready?: boolean } }).phase6bAheReclamation?.ready
			)
		);
		expect(ready, "D109C_BROWSER_MAINTENANCE_MISSING").toBe(true);
	} finally {
		tokens.delete(issued.token);
	}
});

test("reclaims and replays a genuine five-generation IndexedDB lineage", async ({ page }) => {
	test.skip(process.env.D109C_BROWSER_MAINTENANCE_READY !== "true", "D109C_BROWSER_MAINTENANCE_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const value = await page.evaluate(async () => {
			const fixture = (
				globalThis as unknown as {
					phase6bAheReclamation: {
						run(databaseName: string): Promise<Record<string, unknown>>;
						runPositiveControls(prefix: string): Promise<Record<string, unknown>>;
					};
				}
			).phase6bAheReclamation;
			const prefix = `d109c-${crypto.randomUUID()}`;
			return {
				controls: await fixture.runPositiveControls(`${prefix}-controls`),
				value: await fixture.run(`${prefix}-primary`),
			};
		});
		expect(value.controls).toEqual({ concurrentDeletedCounts: [0, 2], empty: true });
		expect(value.value).toMatchObject({
			asynchronousClosed: true,
			closedCode: "AHE_RECLAMATION_STORE_CLOSED",
			copiedDenied: true,
			invalidCode: "AHE_RECLAMATION_INVALID_ARGUMENT",
			memoryDenied: true,
			proxyDenied: true,
		});
		expect(value.value.receipt).toMatchObject({ deletedPromotionCount: 2, floor: { normalizedThisCall: true } });
		expect(value.value.replay).toMatchObject({ deletedGenerationIds: [], floor: { normalizedThisCall: false } });
		expect(value.value.successor).toMatchObject({ head: { generationId: "6".padStart(64, "0"), revision: 6 } });
	} finally {
		tokens.delete(issued.token);
	}
});

test("refuses the frozen native mutant matrix without partial deletion", async ({ page }) => {
	test.skip(process.env.D109C_BROWSER_MAINTENANCE_READY !== "true", "D109C_BROWSER_MAINTENANCE_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const result = await page.evaluate(async () => {
			const fixture = (
				globalThis as unknown as {
					phase6bAheReclamation: {
						runMutantMatrix(prefix: string): Promise<Record<string, unknown>>;
						runReferenceMatrix(prefix: string): Promise<Record<string, unknown>>;
					};
				}
			).phase6bAheReclamation;
			const prefix = `d109c-${crypto.randomUUID()}`;
			return {
				mutants: await fixture.runMutantMatrix(`${prefix}-mutants`),
				references: await fixture.runReferenceMatrix(`${prefix}-references`),
			};
		});
		expect(result.mutants).toMatchObject({ total: 28 });
		expect(result.references).toMatchObject({ total: 6 });
	} finally {
		tokens.delete(issued.token);
	}
});

test("terminates at every live IndexedDB mutation edge and reopens old XOR complete-new", async ({ page }) => {
	test.skip(process.env.D109C_BROWSER_MAINTENANCE_READY !== "true", "D109C_BROWSER_MAINTENANCE_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const result = await page.evaluate(() =>
			(
				globalThis as unknown as {
					phase6bAheReclamation: { runCrashMatrix(prefix: string): Promise<Record<string, unknown>> };
				}
			).phase6bAheReclamation.runCrashMatrix(`d109c-${crypto.randomUUID()}-crash`)
		);
		expect(result).toMatchObject({ total: 6 });
	} finally {
		tokens.delete(issued.token);
	}
});

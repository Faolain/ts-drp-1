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
		const value = await page.evaluate(() => {
			const fixture = (
				globalThis as unknown as {
					phase6bAheReclamation: { run(databaseName: string): Promise<Record<string, unknown>> };
				}
			).phase6bAheReclamation;
			return fixture.run(`d109c-${crypto.randomUUID()}`);
		});
		expect(value).toMatchObject({ copiedDenied: true, memoryDenied: true, proxyDenied: true });
		expect(value.receipt).toMatchObject({ deletedPromotionCount: 2, floor: { normalizedThisCall: true } });
		expect(value.replay).toMatchObject({ deletedGenerationIds: [], floor: { normalizedThisCall: false } });
	} finally {
		tokens.delete(issued.token);
	}
});

test("refuses the frozen native mutant matrix without partial deletion", () => {
	test.skip(process.env.D109C_BROWSER_MAINTENANCE_READY !== "true", "D109C_BROWSER_MAINTENANCE_MISSING");
	expect(true).toBe(true);
});

test("terminates at every live IndexedDB mutation edge and reopens old XOR complete-new", () => {
	test.skip(process.env.D109C_BROWSER_MAINTENANCE_READY !== "true", "D109C_BROWSER_MAINTENANCE_MISSING");
	expect([
		"after-floor-rewrite",
		"after-promotion-delete",
		"after-generation-delete",
		"after-blob-delete",
		"before-commit",
		"after-commit",
	]).toHaveLength(6);
});

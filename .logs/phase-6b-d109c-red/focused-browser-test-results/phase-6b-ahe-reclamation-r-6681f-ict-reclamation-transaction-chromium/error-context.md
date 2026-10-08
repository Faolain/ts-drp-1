# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase-6b-ahe-reclamation-red.pw.ts >> [RED readiness] requires the browser identity owner and strict reclamation transaction
- Location: packages/storage-browser/tests/phase-6b-ahe-reclamation-red.pw.ts:50:1

# Error details

```
Error: D109C_BROWSER_MAINTENANCE_MISSING

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  1   | import { expect, test } from "@playwright/test";
  2   | import { readFileSync } from "node:fs";
  3   | import { createServer, type Server } from "node:http";
  4   | import { join } from "node:path";
  5   | 
  6   | let origin = "";
  7   | let server: Server;
  8   | const tokens = new Set<string>();
  9   | 
  10  | test.beforeAll(async () => {
  11  | 	const directory = process.env.PHASE_6B_AHE_RECLAMATION_ASSET_DIR;
  12  | 	if (directory === undefined) throw new TypeError("D109C_BROWSER_ASSETS_MISSING");
  13  | 	server = createServer((request, response) => {
  14  | 		const url = new URL(request.url ?? "/", "http://127.0.0.1");
  15  | 		const [, token, asset] = url.pathname.split("/");
  16  | 		if (!tokens.has(token ?? "") || !/^phase-6b-ahe-reclamation(?:-worker)?\.(?:html|js)$/u.test(asset ?? "")) {
  17  | 			response.writeHead(404).end();
  18  | 			return;
  19  | 		}
  20  | 		try {
  21  | 			response
  22  | 				.writeHead(200, {
  23  | 					"content-type": asset?.endsWith(".js") === true ? "text/javascript" : "text/html",
  24  | 					"cross-origin-embedder-policy": "require-corp",
  25  | 					"cross-origin-opener-policy": "same-origin",
  26  | 				})
  27  | 				.end(readFileSync(join(directory, asset as string)));
  28  | 		} catch {
  29  | 			response.writeHead(404).end();
  30  | 		}
  31  | 	});
  32  | 	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  33  | 	const address = server.address();
  34  | 	if (address === null || typeof address === "string") throw new TypeError("D109C_BROWSER_SERVER_BIND_FAILED");
  35  | 	origin = `http://127.0.0.1:${address.port}`;
  36  | });
  37  | 
  38  | test.afterAll(async () => {
  39  | 	await new Promise<void>((resolvePromise, reject) =>
  40  | 		server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
  41  | 	);
  42  | });
  43  | 
  44  | function transition(): Readonly<{ readonly token: string; readonly url: string }> {
  45  | 	const token = crypto.randomUUID();
  46  | 	tokens.add(token);
  47  | 	return Object.freeze({ token, url: `${origin}/${token}/phase-6b-ahe-reclamation.html` });
  48  | }
  49  | 
  50  | test("[RED readiness] requires the browser identity owner and strict reclamation transaction", async ({ page }) => {
  51  | 	const issued = transition();
  52  | 	try {
  53  | 		await page.goto(issued.url, { waitUntil: "load" });
  54  | 		const ready = await page.evaluate(() =>
  55  | 			Boolean(
  56  | 				(globalThis as unknown as { phase6bAheReclamation?: { readonly ready?: boolean } }).phase6bAheReclamation?.ready
  57  | 			)
  58  | 		);
> 59  | 		expect(ready, "D109C_BROWSER_MAINTENANCE_MISSING").toBe(true);
      |                                                      ^ Error: D109C_BROWSER_MAINTENANCE_MISSING
  60  | 	} finally {
  61  | 		tokens.delete(issued.token);
  62  | 	}
  63  | });
  64  | 
  65  | test("reclaims and replays a genuine five-generation IndexedDB lineage", async ({ page }) => {
  66  | 	test.skip(process.env.D109C_BROWSER_MAINTENANCE_READY !== "true", "D109C_BROWSER_MAINTENANCE_MISSING");
  67  | 	const issued = transition();
  68  | 	try {
  69  | 		await page.goto(issued.url, { waitUntil: "load" });
  70  | 		const value = await page.evaluate(() => {
  71  | 			const fixture = (
  72  | 				globalThis as unknown as {
  73  | 					phase6bAheReclamation: { run(databaseName: string): Promise<Record<string, unknown>> };
  74  | 				}
  75  | 			).phase6bAheReclamation;
  76  | 			return fixture.run(`d109c-${crypto.randomUUID()}`);
  77  | 		});
  78  | 		expect(value).toMatchObject({ copiedDenied: true, memoryDenied: true, proxyDenied: true });
  79  | 		expect(value.receipt).toMatchObject({ deletedPromotionCount: 2, floor: { normalizedThisCall: true } });
  80  | 		expect(value.replay).toMatchObject({ deletedGenerationIds: [], floor: { normalizedThisCall: false } });
  81  | 	} finally {
  82  | 		tokens.delete(issued.token);
  83  | 	}
  84  | });
  85  | 
  86  | test("refuses the frozen native mutant matrix without partial deletion", () => {
  87  | 	test.skip(process.env.D109C_BROWSER_MAINTENANCE_READY !== "true", "D109C_BROWSER_MAINTENANCE_MISSING");
  88  | 	expect(true).toBe(true);
  89  | });
  90  | 
  91  | test("terminates at every live IndexedDB mutation edge and reopens old XOR complete-new", () => {
  92  | 	test.skip(process.env.D109C_BROWSER_MAINTENANCE_READY !== "true", "D109C_BROWSER_MAINTENANCE_MISSING");
  93  | 	expect([
  94  | 		"after-floor-rewrite",
  95  | 		"after-promotion-delete",
  96  | 		"after-generation-delete",
  97  | 		"after-blob-delete",
  98  | 		"before-commit",
  99  | 		"after-commit",
  100 | 	]).toHaveLength(6);
  101 | });
  102 | 
```
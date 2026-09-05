import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

let origin = "";
let server: Server;

test.beforeAll(async () => {
	const directory = process.env.D110C_F5B0T_BROWSER_ASSET_DIR;
	if (directory === undefined) throw new TypeError("D110C_0C1F5B0T_BROWSER_ASSETS_MISSING");
	server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const asset = pathname.slice(1);
		if (!/^(?:phase-6b-settlement-progress)(?:\.html|\.js)$/u.test(asset)) {
			response.writeHead(404).end();
			return;
		}
		response
			.writeHead(200, { "content-type": asset.endsWith(".js") ? "text/javascript" : "text/html" })
			.end(readFileSync(join(directory, asset)));
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	if (address === null || typeof address === "string") throw new TypeError("D110C_0C1F5B0T_BROWSER_BIND_FAILED");
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolvePromise, reject) =>
		server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
	);
});

test("Chromium persists the exact progress value through native structured clone", async ({ page }) => {
	await page.goto(`${origin}/phase-6b-settlement-progress.html`, { waitUntil: "load" });
	const result = await page.evaluate(() =>
		(
			globalThis as unknown as {
				d110cF5b0tBrowserProgress: { run(databaseName: string): Promise<Record<string, unknown>> };
			}
		).d110cF5b0tBrowserProgress.run(`d110c-f5b0t-${crypto.randomUUID()}`)
	);
	expect(result).toMatchObject({
		accepted: true,
		errorCode: undefined,
		plan: {
			entries: [
				{
					replacementProgress: {
						chunks: [],
						intentCount: 2,
						intentDigest: Array.from({ length: 32 }, () => 0xa5),
						version: 1,
					},
				},
			],
		},
	});
});

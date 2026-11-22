import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

let origin = "";
let server: Server;
const tokens = new Set<string>();

test.beforeAll(async () => {
	const directory = process.env.PHASE_6B_DIFFERENTIAL_EXIT_ASSET_DIR;
	if (directory === undefined) throw new TypeError("D109F_BROWSER_ASSETS_MISSING");
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const [, token, asset] = url.pathname.split("/");
		if (!tokens.has(token ?? "") || !/^phase-6b-differential-exit\.(?:html|js)$/u.test(asset ?? "")) {
			response.writeHead(404).end();
			return;
		}
		try {
			response
				.writeHead(200, { "content-type": asset?.endsWith(".js") === true ? "text/javascript" : "text/html" })
				.end(readFileSync(join(directory, asset as string)));
		} catch {
			response.writeHead(404).end();
		}
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	if (address === null || typeof address === "string") throw new TypeError("D109F_BROWSER_BIND_FAILED");
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolvePromise, reject) =>
		server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
	);
});

test("preserves eligible cleanup, facade identity, replay, and reopened-origin behavior", async ({ page }) => {
	const token = crypto.randomUUID();
	tokens.add(token);
	try {
		await page.goto(`${origin}/${token}/phase-6b-differential-exit.html`, { waitUntil: "load" });
		const result = await page.evaluate(() =>
			(
				globalThis as unknown as {
					phase6bDifferentialExit: { run(prefix: string): Promise<Record<string, unknown>> };
				}
			).phase6bDifferentialExit.run(`d109f-${crypto.randomUUID()}`)
		);
		expect(result.invalidCode, "D109F_BROWSER_EMPTY_PRESENT_NOT_REJECTED").toBe("AHE_RECLAMATION_INVALID_ARGUMENT");
		expect(result.facadeKeys).toEqual(result.expectedFacadeKeys);
		expect(result.generationCount).toBe(3);
		expect(result.receipt).toMatchObject({ deletedGenerationIds: ["1".padStart(64, "0")] });
		expect(result.replay).toMatchObject({ deletedGenerationIds: [] });
		expect(result.head).toMatchObject({ generationId: "4".padStart(64, "0"), revision: 4 });
	} finally {
		tokens.delete(token);
	}
});

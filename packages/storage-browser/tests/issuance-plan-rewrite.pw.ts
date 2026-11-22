import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server, origin: string;
test.beforeAll(async () => {
	const source = (path: string) => new URL(path, import.meta.url).pathname;
	const bundle = await build({entryPoints: [source("./assets/issuance-plan-rewrite-entry.ts")], bundle: true,
		format: "esm", platform: "browser", target: "es2022", write: false,
		alias: {"@ts-drp/issuance-store/maintenance": source("../../issuance-store/src/maintenance.ts"),
			"@ts-drp/issuance-store": source("../../issuance-store/src/index.ts"),
			"@ts-drp/storage/room-head": source("../../storage/src/room-head.ts")}});
	server = createServer((request, response) => {
		response.writeHead(200, {"content-type": request.url === "/entry.js" ? "text/javascript" : "text/html"});
		response.end(request.url === "/entry.js" ? Buffer.from(bundle.outputFiles[0]!.contents) :
			'<!doctype html><script type="module" src="/entry.js"></script>');
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {if (server) await new Promise<void>(resolve => server.close(() => resolve()));});
for (const mode of ["legacy", "room-owner", "room-commit", "room-abort", "room-budget"]) {
	test(`${mode}: exact native issuance plan/control postimage`, async ({page, browserName}) => {
		await page.goto(origin);
		await page.waitForFunction(() => typeof Reflect.get(globalThis, "runIssuanceRewrite") === "function");
		const result = await page.evaluate(async mode => Reflect.get(globalThis, "runIssuanceRewrite")(mode), mode);
		test.info().annotations.push({type: "native-evidence", description: JSON.stringify({browserName,
			version: page.context().browser()!.version(), mode, result})});
		const committed = mode !== "room-abort" && mode !== "room-budget";
		expect(result.image).toBe(committed ? result.targetImage : result.sourceImage);
		expect(result.planRevision).toBe(committed ? 1 : 0);
		expect(result.sources).toEqual(committed ? [] : [0, 1, 2]);
		expect(result.controlRevision).toBe(committed ? 2 : 0);
		expect(result.active).toBeNull(); expect(result.completed).toBe(committed);
		if (mode === "room-commit" || mode === "room-abort") {
			expect(result.writes).toBe(2); expect(result.chargeBeforeWrites).toBe(true);
		}
		if (mode === "room-budget") {expect(result.budgetRefused).toBe(true); expect(result.writes).toBe(0);}
	});
}

import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// appendAcceptedLocalBatch conformance on IndexedDB (both browser journals): the expectations the SQLite
// journal meets in tests/journal-append-batch-conformance-native.test.ts, unchanged.
let server: Server, origin: string;
test.beforeAll(async () => {
	const source = (path: string) => new URL(path, import.meta.url).pathname;
	const bundle = await build({
		entryPoints: [source("./assets/journal-append-batch-entry.ts")],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		write: false,
	});
	server = createServer((request, response) => {
		response.writeHead(200, { "content-type": request.url === "/entry.js" ? "text/javascript" : "text/html" });
		response.end(
			request.url === "/entry.js"
				? Buffer.from(bundle.outputFiles[0]!.contents)
				: '<!doctype html><script type="module" src="/entry.js"></script>'
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
for (const mode of ["legacy", "room"]) {
	test(`${mode}: appendAcceptedLocalBatch journals a chunk in one write and one readback, whole or not at all`, async ({
		page,
		browserName,
	}) => {
		await page.goto(origin);
		await page.waitForFunction(() => typeof Reflect.get(globalThis, "runJournalAppendBatch") === "function");
		const report = (await page.evaluate(
			async (mode) => Reflect.get(globalThis, "runJournalAppendBatch")(mode),
			mode
		)) as Record<string, unknown>;
		test.info().annotations.push({
			type: "native-evidence",
			description: JSON.stringify({ browserName, version: page.context().browser()!.version(), mode, report }),
		});
		expect(report.shape).toEqual({ batch: "function" });
		expect(report.commit).toMatchObject({
			ok: true,
			sequences: [2, 3, 4, 5, 6, 7, 8, 9],
			singleSequences: [2, 3, 4, 5, 6, 7, 8, 9],
			digests: true,
			rowCountBefore: 2,
			rowCountAfter: 10,
			postimageIsRead: true,
			imageEqualsSingles: true,
			rowsEqualSingles: true,
			transactions: { writes: 1, reads: 1 },
		});
		expect(report.stale).toEqual({ ok: false, kind: "retirement-stale", unchanged: true });
		expect(report.refusals).toEqual({
			exact: "evidence-conflict",
			conflict: "evidence-conflict",
			repeated: "malformed-input",
			empty: "malformed-input",
			oversized: "malformed-input",
			unchanged: true,
			thenValid: [10, 11],
		});
	});
}

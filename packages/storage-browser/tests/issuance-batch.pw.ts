import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// transactIssueBatch conformance on IndexedDB (both browser stores): the expectations the
// SQLite store meets in tests/issuance-batch-conformance-native.test.ts, unchanged.
let server: Server, origin: string;
test.beforeAll(async () => {
	const source = (path: string): string => new URL(path, import.meta.url).pathname;
	const bundle = await build({
		entryPoints: [source("./assets/issuance-batch-entry.ts")],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		write: false,
		alias: {
			"@ts-drp/issuance-store/maintenance": source("../../issuance-store/src/maintenance.ts"),
			"@ts-drp/issuance-store": source("../../issuance-store/src/index.ts"),
			"@ts-drp/storage/room-head": source("../../storage/src/room-head.ts"),
		},
	});
	server = createServer((request, response) => {
		const entry = bundle.outputFiles[0];
		if (entry === undefined) throw new Error("esbuild produced no entry");
		response.writeHead(200, { "content-type": request.url === "/entry.js" ? "text/javascript" : "text/html" });
		response.end(
			request.url === "/entry.js"
				? Buffer.from(entry.contents)
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
	test(`${mode}: transactIssueBatch commits whole, refuses whole, and equals the same singles`, async ({
		page,
		browserName,
	}) => {
		await page.goto(origin);
		await page.waitForFunction(() => typeof Reflect.get(globalThis, "runIssuanceBatch") === "function");
		const report = (await page.evaluate((mode) => Reflect.get(globalThis, "runIssuanceBatch")(mode), mode)) as Record<
			string,
			Record<string, unknown>
		>;
		test.info().annotations.push({
			type: "native-evidence",
			description: JSON.stringify({ browserName, version: page.context().browser()?.version(), mode, report }),
		});
		const all = [9, 10, 11, 12, 13, 14, 15, 16];
		expect(report.commit).toMatchObject({
			ok: true,
			sequences: all,
			lineageBefore: { exhausted: false, next: 9 },
			lineageAfter: { exhausted: false, next: 17 },
			issuedAfter: all,
			planEqualsSingles: true,
			replaced: all,
			signed: all,
		});
		const commit = report.commit ?? {};
		expect(commit.revisionAfter).toBe((commit.revisionBefore as number) + 8);
		expect(commit.revisionAfter).toBe(commit.revisionSingles);
		expect(report.revisionCas).toEqual({
			ok: false,
			code: "ISSUANCE_RETRY_REQUIRED",
			signed: 0,
			unchanged: true,
			retryOk: true,
		});
		expect(report.validation).toEqual({ ok: false, code: "ISSUANCE_COMMIT_INVALID", unchanged: true });
		expect(report.duplicate).toMatchObject({
			duplicateOk: false,
			duplicateCode: "ISSUANCE_COMMIT_INVALID",
			mixedOk: false,
			mixedCode: "ISSUANCE_COMMIT_INVALID",
			unchanged: true,
			thenValidOk: true,
			duplicateSigned: 0,
			mixedSigned: 0,
		});
		expect(report.precondition).toMatchObject({
			ok: false,
			code: "ISSUANCE_RETRY_REQUIRED",
			unchanged: true,
			restOk: true,
			signed: 0,
		});
		expect(report.progress).toEqual({
			firstOk: true,
			secondOk: true,
			midEqualsSingles: true,
			endEqualsSingles: true,
			twoChunksOneBatchOk: false,
			twoChunksOneBatchCode: "ISSUANCE_COMMIT_INVALID",
		});
		expect(report.resume).toEqual({
			failedOk: false,
			failedCode: "ISSUANCE_OUTCOME_UNKNOWN",
			between: [null, null, null, null],
			foreignOk: false,
			resumedOk: true,
			after: [5, 6, 7, 8],
			lineageAfter: { exhausted: false, next: 9 },
		});
		expect(report.prefix).toEqual({
			stoppedOk: true,
			stoppedCode: null,
			sequences: [9, 10, 11],
			signed: [9, 10, 11],
			lineageBetween: { exhausted: false, next: 12 },
			issuedBetween: [9, 10, 11, null, null, null, null, null],
			replacedBetween: [9, 10, 11, null, null, null, null, null],
			revisionStep: 3,
			restOk: true,
			restSequences: [12, 13, 14, 15, 16],
			issuedAfter: [9, 10, 11, 12, 13, 14, 15, 16],
			planEqualsSingles: true,
		});
		expect(report.sizing).toMatchObject({
			overOk: false,
			overSigned: 0,
			unchanged: true,
			fitsOk: true,
			after: [9, 10, 11, 12, 13, 14, 15, null],
			chargedCoversWritten: true,
		});
	});
}

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

test("Chromium preserves atomic settlement progress and exact CAS refusal across reopen", async ({
	page,
}, testInfo) => {
	await page.goto(origin + "/phase-6b-settlement-progress.html", { waitUntil: "load" });
	const result = await page.evaluate(() =>
		(
			globalThis as unknown as {
				d110cF5b0tBrowserProgress: { run(databaseName: string): Promise<readonly Record<string, unknown>[]> };
			}
		).d110cF5b0tBrowserProgress.run("d110c-f5b0u-" + crypto.randomUUID())
	);
	await testInfo.attach("complete-native-progress-vectors", {
		body: JSON.stringify({ browser: page.context().browser()?.version(), result }, null, 2),
		contentType: "application/json",
	});
	const ok = { ok: true, errorCode: null };
	const lineage = (next: number): unknown => ({ exhausted: false, next });
	const expectedPlan = (
		revision: number,
		chunks?: readonly unknown[],
		replacementSequence: number | null = null
	): unknown => ({
		entries: [
			{
				disposition: "rebase",
				...(chunks === undefined
					? {}
					: {
							replacementProgress: {
								chunks,
								intentCount: 2,
								intentDigest: Array.from({ length: 32 }, () => 0xa5),
								version: 1,
							},
						}),
				replacementSequence,
				sourceDigest: Array.from({ length: 32 }, () => 0xd1),
				sourceSequence: 7,
			},
		],
		fenceSequence: 4,
		revision,
		scope: { author: "author:browser-progress", objectId: "room:browser-progress" },
	});
	const first = { lastLogicalTime: 7, replacementSequence: 0, throughIntent: 1 };
	const second = { lastLogicalTime: 9, replacementSequence: 1, throughIntent: 2 };
	const vectors = [
		{
			name: "zero-origin",
			setup: [ok],
			attempt: ok,
			before: expectedPlan(0),
			beforeLineage: lineage(0),
			after: expectedPlan(1, []),
			lineage: lineage(0),
			issuedSequences: [],
			outboxSequences: [],
		},
		{
			name: "nonempty-origin",
			setup: [ok],
			attempt: { ok: false, errorCode: "ISSUANCE_RETRY_REQUIRED" },
			before: expectedPlan(0),
			beforeLineage: lineage(0),
			after: expectedPlan(0),
			lineage: lineage(0),
			issuedSequences: [],
			outboxSequences: [],
		},
		{
			name: "partial",
			setup: [ok, ok],
			attempt: ok,
			before: expectedPlan(1, []),
			beforeLineage: lineage(0),
			after: expectedPlan(2, [first]),
			lineage: lineage(1),
			issuedSequences: [0],
			outboxSequences: [0],
		},
		{
			name: "final",
			setup: [ok, ok, ok],
			attempt: ok,
			before: expectedPlan(2, [first]),
			beforeLineage: lineage(1),
			after: expectedPlan(3, [first, second], 1),
			lineage: lineage(2),
			issuedSequences: [0, 1],
			outboxSequences: [0, 1],
		},
		{
			name: "stale-revision",
			setup: [ok, ok],
			attempt: { ok: false, errorCode: "ISSUANCE_RETRY_REQUIRED" },
			before: expectedPlan(1),
			beforeLineage: lineage(0),
			after: expectedPlan(1),
			lineage: lineage(0),
			issuedSequences: [],
			outboxSequences: [],
		},
		{
			name: "inexact-revision",
			setup: [ok],
			attempt: { ok: false, errorCode: "ISSUANCE_INVALID_ARGUMENT" },
			before: expectedPlan(0),
			beforeLineage: lineage(0),
			after: expectedPlan(0),
			lineage: lineage(0),
			issuedSequences: [],
			outboxSequences: [],
		},
	];
	expect(result).toHaveLength(vectors.length);
	for (const [index, expected] of vectors.entries()) {
		expect
			.soft(result[index], "D110C_F5B0U_BROWSER_" + expected.name)
			.toEqual({ ...expected, reopened: expected.after });
	}
});

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

let origin = "";
let server: Server;
const tokens = new Set<string>();

test.beforeAll(async () => {
	const directory = process.env.PHASE_6B_ISSUANCE_RETENTION_ASSET_DIR;
	if (directory === undefined) throw new TypeError("D109B_BROWSER_ASSETS_MISSING");
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const [, token, asset] = url.pathname.split("/");
		if (!tokens.has(token ?? "") || !/^(?:phase-6b-issuance-retention)(?:\.html|\.js)$/u.test(asset ?? "")) {
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
	if (address === null || typeof address === "string") throw new TypeError("D109B_BROWSER_SERVER_BIND_FAILED");
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
	return Object.freeze({ token, url: `${origin}/${token}/phase-6b-issuance-retention.html` });
}

test("[RED readiness] requires the browser identity-gated pruning owner", async ({ page }) => {
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const ready = await page.evaluate(() =>
			Boolean(
				(globalThis as unknown as { phase6bIssuanceRetention?: { readonly ready?: boolean } }).phase6bIssuanceRetention
					?.ready
			)
		);
		expect(ready, "D109B_BROWSER_MAINTENANCE_MISSING").toBe(true);
	} finally {
		tokens.delete(issued.token);
	}
});

test("prunes, reopens and preserves v1 plus later numeric-watermark issuance in Chromium", async ({ page }) => {
	test.skip(process.env.D109B_BROWSER_MAINTENANCE_READY !== "true", "D109B_BROWSER_MAINTENANCE_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const value = await page.evaluate(() => {
			const fixture = (
				globalThis as unknown as {
					phase6bIssuanceRetention: { run(databaseName: string): Promise<Record<string, unknown>> };
				}
			).phase6bIssuanceRetention;
			return fixture.run(`d109b-${crypto.randomUUID()}`);
		});
		expect(value).toMatchObject({
			crossBackendDenied: true,
			copiedFacadeDenied: true,
			facadeKeys: [
				"close",
				"compareAndMarkOutboxPublished",
				"readIssued",
				"readLineage",
				"readOutboxPage",
				"transactIssue",
			],
			lineage: { exhausted: false, next: 3 },
			lateExact: "ISSUANCE_RECORD_PRUNED",
			lateWrong: "ISSUANCE_RECORD_PRUNED",
			legacyLineage: {
				keys: ["author", "exhausted", "next", "objectId"],
				watermark: null,
			},
			numericLineage: {
				keys: ["author", "exhausted", "next", "objectId", "prunedThroughAuthorSequence"],
				watermark: 0,
			},
			outbox: [1, 2],
			otherScope: [0],
			proxyFacadeDenied: true,
			prunedRead: null,
			replayRange: null,
			state: { lineage: { exhausted: false, next: 2 }, prunedThroughAuthorSequence: 0 },
			version: 1,
		});
	} finally {
		tokens.delete(issued.token);
	}
});

test("refuses stale, pending and wrong-epoch state while allowing a later closed epoch", async ({ page }) => {
	test.skip(process.env.D109B_BROWSER_MAINTENANCE_READY !== "true", "D109B_BROWSER_MAINTENANCE_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const value = await page.evaluate(() => {
			const fixture = (
				globalThis as unknown as {
					phase6bIssuanceRetention: { runSemantics(databaseName: string): Promise<Record<string, unknown>> };
				}
			).phase6bIssuanceRetention;
			return fixture.runSemantics(`d109b-semantics-${crypto.randomUUID()}`);
		});
		expect(value).toEqual({
			laterOutbox: 0,
			laterRange: { from: 2, through: 3 },
			pendingCode: "ISSUANCE_RETRY_REQUIRED",
			pendingLineage: { exhausted: false, next: 2 },
			staleLineageCode: "ISSUANCE_RETRY_REQUIRED",
			staleWatermarkCode: "ISSUANCE_RETRY_REQUIRED",
			wrongEpochCode: "ISSUANCE_INVALID_ARGUMENT",
		});
	} finally {
		tokens.delete(issued.token);
	}
});

test("rejects the genuine IndexedDB native-row mutant matrix without pruning writes", async ({ page }) => {
	test.skip(process.env.D109B_BROWSER_MAINTENANCE_READY !== "true", "D109B_BROWSER_MAINTENANCE_MISSING");
	const issued = transition();
	try {
		await page.goto(issued.url, { waitUntil: "load" });
		const value = await page.evaluate(() => {
			const fixture = (
				globalThis as unknown as {
					phase6bIssuanceRetention: {
						runNativeMutants(databaseName: string): Promise<readonly Record<string, unknown>[]>;
					};
				}
			).phase6bIssuanceRetention;
			return fixture.runNativeMutants(`d109b-mutants-${crypto.randomUUID()}`);
		});
		expect(value.map(({ mutant }) => mutant)).toEqual([
			"canonical-malformed",
			"vertex-kind-wrong",
			"protocol-major-wrong",
			"scope-wrong",
			"ordinal-wrong",
			"epoch-wrong",
			"issued-only",
			"outbox-only",
			"digest-mismatch",
			"sequence-gap",
			"epoch-regression",
		]);
		for (const result of value) {
			expect(result.code, String(result.mutant)).toBe(
				result.mutant === "epoch-wrong" || result.mutant === "epoch-regression"
					? "ISSUANCE_INVALID_ARGUMENT"
					: "ISSUANCE_RECOVERY_CORRUPT"
			);
			expect(result.watermark, String(result.mutant)).toBeNull();
			expect(result.issuedCount, String(result.mutant)).toBe(
				result.mutant === "outbox-only" || result.mutant === "sequence-gap" ? 2 : 3
			);
			expect(result.outboxCount, String(result.mutant)).toBe(
				result.mutant === "issued-only" || result.mutant === "sequence-gap" ? 2 : 3
			);
		}
	} finally {
		tokens.delete(issued.token);
	}
});

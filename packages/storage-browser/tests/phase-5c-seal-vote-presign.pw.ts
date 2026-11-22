import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

let server: Awaited<ReturnType<typeof startPhase4cBrowserServer>>;
test.beforeAll(async () => {
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(import.meta.dirname, "assets/phase-5c-presign-entry.ts"),
	});
});

for (const mode of ["retired", "initial", "close"] as const)
	test(`native bound pre-sign ${mode}`, async ({ page }, info) => {
		await page.goto(server.origin);
		const raw = (await page.evaluate(({ name, mode }) => window.presignBoundRun(name, mode), {
			name: `bound-presign-${crypto.randomUUID()}`,
			mode,
		})) as {
			outcome: {
				setupFailure?: string;
				result: { ok: boolean; reason?: string };
				entered: number;
				beforeDigest?: string;
				afterDigest?: string;
				blocked?: { foreignDone: boolean; closeDone: boolean };
				foreignResult?: { ok: boolean };
			};
			cleanup: { status: string }[];
		};
		await writeFile(info.outputPath("native-bound-presign.json"), JSON.stringify(raw), { flag: "wx" });
		expect(raw.outcome.setupFailure).toBeUndefined();
		expect(raw.cleanup.every((row) => row.status === "fulfilled")).toBe(true);
		if (mode === "retired") {
			expect(raw.outcome.result).toMatchObject({ ok: false, reason: "SIGNING_RETIRED" });
			expect(raw.outcome.entered).toBe(0);
			expect(raw.outcome.afterDigest).toBe(raw.outcome.beforeDigest);
		} else if (mode === "initial") {
			expect(raw.outcome.result.ok).toBe(true);
			expect(raw.outcome.entered).toBe(1);
		} else {
			expect(raw.outcome.blocked).toEqual({ foreignDone: false, closeDone: false });
			expect(raw.outcome.result.ok).toBe(false);
			expect(raw.outcome.entered).toBe(1);
			expect(raw.outcome.foreignResult?.ok).toBe(true);
		}
	});
test.afterAll(async () => server?.close());
test("native bound pre-sign vote retirement", async ({ page }, info) => {
	await page.goto(server.origin);
	const raw = (await page.evaluate(
		(name) => window.presignBoundRun(name, "retired", "vote"),
		`bound-vote-${crypto.randomUUID()}`
	)) as {
		outcome: {
			setupFailure?: string;
			result: { ok: boolean; reason?: string };
			entered: number;
			beforeDigest?: string;
			afterDigest?: string;
		};
		cleanup: { status: string }[];
	};
	await writeFile(info.outputPath("native-bound-vote.json"), JSON.stringify(raw), { flag: "wx" });
	expect(raw.outcome.setupFailure).toBeUndefined();
	expect(raw.cleanup.every((row) => row.status === "fulfilled")).toBe(true);
	expect(raw.outcome.result).toMatchObject({ ok: false, reason: "SIGNING_RETIRED" });
	expect(raw.outcome.entered).toBe(0);
	expect(raw.outcome.beforeDigest).toBeDefined();
	expect(raw.outcome.afterDigest).toBe(raw.outcome.beforeDigest);
});
test("native bound pre-sign anchor closing scope", async ({ page }, info) => {
	await page.goto(server.origin);
	const raw = (await page.evaluate((name) => window.presignAnchorRun(name), `bound-anchor-${crypto.randomUUID()}`)) as {
		outcome: {
			setupFailure?: string;
			healthy: { entered: number; signatureBytes: number };
			refused: { fulfilled: boolean; reason?: string };
			delayedEntered: number;
			beforeDigest: string;
			afterDigest: string;
			authoredScopes: { epoch: number; round: number; wireEpoch: number; wireHasRound: boolean }[];
		};
		cleanup: { status: string }[];
	};
	await writeFile(info.outputPath("native-bound-anchor.json"), JSON.stringify(raw), { flag: "wx" });
	expect(raw.outcome.setupFailure).toBeUndefined();
	expect(raw.cleanup.every((row) => row.status === "fulfilled")).toBe(true);
	expect(raw.outcome.healthy).toEqual({ entered: 1, signatureBytes: 64 });
	expect(raw.outcome.authoredScopes).toHaveLength(2);
	for (const scope of raw.outcome.authoredScopes)
		expect(scope).toMatchObject({ epoch: 0, round: 1, wireEpoch: 1, wireHasRound: false });
	expect(raw.outcome.refused).toMatchObject({ fulfilled: false, reason: "SIGNING_RETIRED" });
	expect(raw.outcome.delayedEntered).toBe(0);
	expect(raw.outcome.beforeDigest).toBeDefined();
	expect(raw.outcome.afterDigest).toBe(raw.outcome.beforeDigest);
});
for (const kind of ["vote", "round", "anchor"] as const)
	test(`native pre-sign retired ${kind}`, async ({ page }, info) => {
		await page.goto(server.origin);
		const raw = (await page.evaluate(({ name, kind }) => window.presignRun(name, kind), {
			name: `presign-${crypto.randomUUID()}`,
			kind,
		})) as { outcome: { setupFailure?: string; fulfilled: boolean; entered: number }; cleanup: { status: string }[] };
		await writeFile(info.outputPath("native-presign.json"), JSON.stringify(raw), { flag: "wx" });
		expect(raw.outcome.setupFailure).toBeUndefined();
		expect(raw.cleanup.every((row) => row.status === "fulfilled")).toBe(true);
		expect(raw.outcome.fulfilled).toBe(false);
		expect(raw.outcome.entered).toBe(0);
	});

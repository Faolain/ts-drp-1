import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

declare global {
	interface Window {
		readonly phase3a1bP5: Readonly<{
			configuredSummary(
				seed: string
			): Promise<Readonly<{ authorId: string; signatureHex: string; strictVerification: boolean }>>;
			controlSummary(
				seed: string
			): Promise<Readonly<{ authorId: string; signatureHex: string; strictVerification: boolean }>>;
			unavailableSummary(): Promise<Readonly<{ identity: string; signing: string }>>;
		}>;
	}
}

const ENGINES = ["chromium", "firefox", "webkit"] as const;
const VECTOR = Object.freeze({
	authorId: "c92939c726ba0235d368408c456090a21f8e9edd3781f72e5a7bc75afdc6df73",
	seed: "phase-3a1b-p5-browser-vector",
	signatureHex:
		"b33a2dd733f689ad4f44260854298199fca0486527de0ac3c0a7511e7cb952c43acdaa4de6122dab0a5fa82b6cd4e97f0af299ba681543841e56985e70411904",
});

let bundleDirectory = "";
let bundleSource = "";

test.beforeAll(async () => {
	bundleDirectory = mkdtempSync(join(tmpdir(), "phase-3a1b-p5-browser-"));
	const bundlePath = join(bundleDirectory, "local-author.mjs");
	await build({
		bundle: true,
		entryPoints: [resolve("tests/fixtures/phase-3a1b-p5/browser-local-author-entry.ts")],
		format: "esm",
		logLevel: "silent",
		outfile: bundlePath,
		platform: "browser",
		target: "es2022",
	});
	bundleSource = readFileSync(bundlePath, "utf8");
	if (bundleSource.length === 0) throw new Error("p5 browser bundle is empty");
});

test.afterAll(() => {
	if (bundleDirectory !== "") rmSync(bundleDirectory, { force: true, recursive: true });
});

async function install(page: Page): Promise<void> {
	await page.goto("about:blank");
	await page.addScriptTag({ content: bundleSource, type: "module" });
	await page.waitForFunction(() => "phase3a1bP5" in globalThis);
}

test("the locked dependency graph independently produces the frozen browser vector", async ({ page }, testInfo) => {
	expect(ENGINES).toContain(testInfo.project.name);
	await install(page);
	await expect(page.evaluate((seed) => window.phase3a1bP5.controlSummary(seed), VECTOR.seed)).resolves.toEqual({
		authorId: VECTOR.authorId,
		signatureHex: VECTOR.signatureHex,
		strictVerification: true,
	});
});

test("configured local-author vectors and strict verification agree in every genuine browser engine", async ({
	page,
}, testInfo) => {
	expect(ENGINES).toContain(testInfo.project.name);
	await install(page);
	const observed = await page.evaluate((seed) => window.phase3a1bP5.configuredSummary(seed), VECTOR.seed);
	expect(observed).toEqual({
		authorId: VECTOR.authorId,
		signatureHex: VECTOR.signatureHex,
		strictVerification: true,
	});
});

test("seedless browser instances preserve legacy startup but expose no local-author authority", async ({
	page,
}, testInfo) => {
	expect(ENGINES).toContain(testInfo.project.name);
	await install(page);
	await expect(page.evaluate(() => window.phase3a1bP5.unavailableSummary())).resolves.toEqual({
		identity: "Error:local author identity is unavailable",
		signing: "Error:local author identity is unavailable",
	});
});

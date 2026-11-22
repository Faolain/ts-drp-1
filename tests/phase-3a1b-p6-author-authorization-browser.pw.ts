import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

declare global {
	interface Window {
		readonly phase3a1bP6: Readonly<{ summary(): Readonly<Record<string, unknown>> }>;
	}
}

const AUTHOR = "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664";
const ENTRY = resolve("tests/fixtures/phase-3a1b-p6/browser-author-authorization-entry.ts");
const PRODUCTION = resolve("packages/protocol-v3/src/author-authorization.ts");
let directory = "";
let source = "";

test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "phase-3a1b-p6-browser-"));
	if (!existsSync(PRODUCTION)) {
		source =
			'Object.defineProperty(globalThis,"phase3a1bP6",{value:Object.freeze({summary:()=>Object.freeze({available:false})})});';
		return;
	}
	const output = join(directory, "author-authorization.mjs");
	await build({
		bundle: true,
		entryPoints: [ENTRY],
		format: "esm",
		logLevel: "silent",
		outfile: output,
		platform: "browser",
		target: "es2022",
	});
	source = readFileSync(output, "utf8");
});

test.afterAll(() => {
	if (directory !== "") rmSync(directory, { force: true, recursive: true });
});

async function install(page: Page): Promise<void> {
	await page.goto("about:blank");
	await page.addScriptTag({ content: source, type: "module" });
	await page.waitForFunction(() => "phase3a1bP6" in globalThis);
}

test("genuine browser runtime shares trust authority and enforces strict byte capture", async ({ page }) => {
	await install(page);
	await expect(page.evaluate(() => window.phase3a1bP6.summary())).resolves.toEqual({
		available: true,
		keyHex: AUTHOR,
		opened: true,
		precedence: { cause: "invalid-signature", ok: false, reason: "anchor-rejected" },
		proxy: { ok: false, reason: "malformed-input" },
		resolved: true,
	});
});

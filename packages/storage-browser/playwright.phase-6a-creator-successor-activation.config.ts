import { defineConfig } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePackageRoot = resolve(repositoryRoot, "tests/fixtures/node_modules/@ts-drp");
const browserPackageRoot = resolve(import.meta.dirname, "node_modules/@ts-drp");
mkdirSync(fixturePackageRoot, { recursive: true });
mkdirSync(browserPackageRoot, { recursive: true });

for (const directory of readdirSync(resolve(repositoryRoot, "packages"))) {
	const packageDirectory = resolve(repositoryRoot, "packages", directory);
	const manifestPath = resolve(packageDirectory, "package.json");
	if (!existsSync(manifestPath)) continue;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Readonly<{
		readonly exports?: unknown;
		readonly name?: string;
	}>;
	if (typeof manifest.name !== "string" || !manifest.name.startsWith("@ts-drp/")) continue;
	const shim = resolve(fixturePackageRoot, manifest.name.slice("@ts-drp/".length));
	mkdirSync(shim, { recursive: true });
	writeFileSync(
		resolve(shim, "package.json"),
		JSON.stringify({ exports: manifest.exports, name: manifest.name, type: "module" })
	);
	for (const child of ["conformance", "dist", "registry", "supplements"]) {
		const target = resolve(packageDirectory, child);
		const link = resolve(shim, child);
		if (existsSync(target) && !existsSync(link)) symlinkSync(target, link, "dir");
	}
	if (manifest.name === "@ts-drp/node") {
		const browserLink = resolve(browserPackageRoot, "node");
		if (!existsSync(browserLink)) symlinkSync(packageDirectory, browserLink, "dir");
	}
}

export default defineConfig({
	forbidOnly: true,
	fullyParallel: false,
	globalTimeout: 300_000,
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	retries: 0,
	testDir: "./tests",
	testMatch: "phase-6a-creator-successor-activation.pw.ts",
	timeout: 60_000,
	use: { headless: true },
	workers: 1,
});

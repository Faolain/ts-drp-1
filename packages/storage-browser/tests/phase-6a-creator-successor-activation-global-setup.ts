import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Creates package shims only for the bounded activation Playwright lifetime.
 * @returns Cleanup for the exact setup-owned shim root.
 */
export default function globalSetup(): Promise<() => void> {
	const repositoryRoot = resolve(import.meta.dirname, "../../..");
	const shimRoot = resolve(repositoryRoot, "tests/fixtures/node_modules/@ts-drp");
	if (existsSync(shimRoot)) return Promise.reject(new Error("workspace package shim root already exists"));
	try {
		mkdirSync(shimRoot, { recursive: true });
		for (const directory of readdirSync(resolve(repositoryRoot, "packages"))) {
			const packageDirectory = resolve(repositoryRoot, "packages", directory);
			const manifestPath = resolve(packageDirectory, "package.json");
			if (!existsSync(manifestPath)) continue;
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Readonly<{
				readonly exports?: unknown;
				readonly name?: string;
			}>;
			if (typeof manifest.name !== "string" || !manifest.name.startsWith("@ts-drp/")) continue;
			const shim = resolve(shimRoot, manifest.name.slice("@ts-drp/".length));
			mkdirSync(shim, { recursive: true });
			writeFileSync(
				resolve(shim, "package.json"),
				JSON.stringify({ exports: manifest.exports, name: manifest.name, type: "module" }),
				"utf8"
			);
			for (const child of ["conformance", "dist", "registry", "supplements"]) {
				const target = resolve(packageDirectory, child);
				if (existsSync(target)) symlinkSync(target, resolve(shim, child), "dir");
			}
		}
	} catch (error) {
		rmSync(shimRoot, { force: true, recursive: true });
		return Promise.reject(error);
	}
	return Promise.resolve(() => rmSync(shimRoot, { force: true, recursive: true }));
}

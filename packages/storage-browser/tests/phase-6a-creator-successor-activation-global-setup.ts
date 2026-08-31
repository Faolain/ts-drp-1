import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

interface ActivationWorkspaceShimSetupHooks {
	afterRootCreated?(): void;
}

function errorCode(value: unknown): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const code = Reflect.get(value, "code");
	return typeof code === "string" ? code : undefined;
}

function entryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function removeOwnedShimRoot(shimRoot: string, shimParent: string, parentExisted: boolean): void {
	rmSync(shimRoot, { force: true, recursive: true });
	if (parentExisted) return;
	try {
		rmdirSync(shimParent);
	} catch (error) {
		if (errorCode(error) !== "ENOTEMPTY") throw error;
	}
}

/**
 * Creates package shims only for the bounded activation Playwright lifetime.
 * @param hooks - Test-only lifecycle hooks; the Playwright default supplies none.
 * @returns Cleanup for the exact setup-owned shim root.
 */
export function setupActivationWorkspaceShims(
	hooks: Readonly<ActivationWorkspaceShimSetupHooks> = Object.freeze({})
): Promise<() => void> {
	const repositoryRoot = resolve(import.meta.dirname, "../../..");
	const shimParent = resolve(repositoryRoot, "tests/fixtures/node_modules");
	const shimRoot = resolve(repositoryRoot, "tests/fixtures/node_modules/@ts-drp");
	if (entryExists(shimRoot)) {
		return Promise.reject(
			new Error(
				`workspace package shim root already exists at ${shimRoot}; serialized activation setup will not remove caller-owned contents`
			)
		);
	}
	const parentExisted = entryExists(shimParent);
	let rootCreated = false;
	try {
		mkdirSync(shimRoot, { recursive: true });
		rootCreated = true;
		hooks.afterRootCreated?.();
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
		if (rootCreated) removeOwnedShimRoot(shimRoot, shimParent, parentExisted);
		return Promise.reject(error);
	}
	let released = false;
	return Promise.resolve(() => {
		if (released) return;
		released = true;
		removeOwnedShimRoot(shimRoot, shimParent, parentExisted);
	});
}

/**
 * Creates activation shims for one serialized Playwright configuration.
 * @returns Cleanup for the exact setup-owned shim root.
 */
export default function globalSetup(): Promise<() => void> {
	return setupActivationWorkspaceShims();
}

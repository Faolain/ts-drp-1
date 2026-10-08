/* eslint-disable @typescript-eslint/explicit-function-return-type -- this JavaScript fixture exposes its shape through behavior tests */
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const mismatch = (detail) => new TypeError(`workspace package export file mismatch: ${detail}`);

/**
 * Imports one explicit package's freshly built export file without bare-specifier resolution.
 * @param input - Explicit package identity, export key and absolute workspace directory.
 * @returns The imported module and both resolved real paths.
 */
export async function importWorkspacePackageExportFile(input) {
	if (input === null || typeof input !== "object") throw mismatch("input");
	const { expectedPackageName, exportKey, packageDirectory } = input;
	if (typeof expectedPackageName !== "string" || expectedPackageName.length === 0) {
		throw mismatch("expected package name");
	}
	if (typeof exportKey !== "string" || exportKey.length === 0) throw mismatch("export key");
	if (typeof packageDirectory !== "string" || !isAbsolute(packageDirectory)) {
		throw mismatch("explicit package directory");
	}

	let packageDirectoryRealpath;
	try {
		packageDirectoryRealpath = await realpath(packageDirectory);
	} catch {
		throw mismatch("package directory realpath");
	}
	if (packageDirectoryRealpath.split(sep).includes("node_modules")) {
		throw mismatch("node_modules package directory");
	}

	let manifest;
	try {
		manifest = JSON.parse(await readFile(resolve(packageDirectoryRealpath, "package.json"), "utf8"));
	} catch {
		throw mismatch("package manifest");
	}
	if (manifest === null || typeof manifest !== "object" || manifest.name !== expectedPackageName) {
		throw mismatch("package name");
	}
	const selectedExport = manifest.exports?.[exportKey];
	const importTarget =
		selectedExport !== null && typeof selectedExport === "object" ? selectedExport.import : undefined;
	if (
		typeof importTarget !== "string" ||
		importTarget.length === 0 ||
		isAbsolute(importTarget) ||
		!importTarget.startsWith("./dist/") ||
		importTarget.endsWith(".d.ts")
	) {
		throw mismatch("package export target");
	}

	const unresolvedTarget = resolve(packageDirectoryRealpath, importTarget);
	let targetRealpath;
	try {
		targetRealpath = await realpath(unresolvedTarget);
	} catch {
		throw mismatch("built export target realpath");
	}
	const targetWithinPackage = relative(packageDirectoryRealpath, targetRealpath);
	if (targetWithinPackage === "" || targetWithinPackage.startsWith(`..${sep}`) || isAbsolute(targetWithinPackage)) {
		throw mismatch("built export target confinement");
	}
	let targetStat;
	try {
		targetStat = await stat(targetRealpath);
	} catch {
		throw mismatch("built export target stat");
	}
	if (!targetStat.isFile() || targetStat.size === 0) throw mismatch("nonempty built export target");

	const imported = await import(pathToFileURL(targetRealpath).href);
	return Object.freeze({ module: imported, packageDirectoryRealpath, targetRealpath });
}

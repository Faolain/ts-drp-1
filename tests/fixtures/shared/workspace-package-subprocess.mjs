/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, parse } from "node:path";
import { fileURLToPath } from "node:url";

function deterministicEnvironment() {
	const environment = {};
	for (const name of ["HOME", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
		if (process.env[name] !== undefined) environment[name] = process.env[name];
	}
	return environment;
}

function plainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolves exact import-only package exports from one workspace package graph,
 * then executes a separate fresh Node child with only those resolved file URLs.
 * @param input - Exact child, package anchor, expected export targets and Node arguments.
 * @returns Exact UTF-8 child stdout.
 */
export function runWorkspacePackageSubprocess(input) {
	if (
		!plainRecord(input) ||
		Reflect.ownKeys(input).some(
			(key) => !["childPath", "expectedImports", "mode", "nodeArguments", "packageDirectory"].includes(String(key))
		) ||
		typeof input.childPath !== "string" ||
		!plainRecord(input.expectedImports) ||
		typeof input.mode !== "string" ||
		typeof input.packageDirectory !== "string" ||
		(input.nodeArguments !== undefined && !Array.isArray(input.nodeArguments))
	) {
		throw new TypeError("workspace package subprocess input is malformed");
	}
	const expectedEntries = Object.entries(input.expectedImports);
	if (
		expectedEntries.length === 0 ||
		expectedEntries.some(
			([specifier, expectedPath]) =>
				specifier.length === 0 || typeof expectedPath !== "string" || expectedPath.length === 0
		)
	) {
		throw new TypeError("workspace package subprocess imports are malformed");
	}
	const environment = deterministicEnvironment();
	const resolverSource =
		`for (const specifier of ${JSON.stringify(expectedEntries.map(([specifier]) => specifier))}) ` +
		`console.log(specifier + "\\t" + import.meta.resolve(specifier));`;
	const resolution = execFileSync(process.execPath, ["--input-type=module", "--eval", resolverSource], {
		cwd: input.packageDirectory,
		encoding: "utf8",
		env: environment,
		maxBuffer: 1024 * 1024,
	});
	const rows = resolution.trim().split("\n");
	if (rows.length !== expectedEntries.length) throw new Error("workspace package resolution count mismatch");
	const resolvedImports = {};
	for (const [index, [expectedSpecifier, expectedPath]] of expectedEntries.entries()) {
		const [specifier, resolvedUrl, ...extra] = rows[index]?.split("\t") ?? [];
		if (specifier !== expectedSpecifier || resolvedUrl === undefined || extra.length !== 0) {
			throw new Error(`workspace package resolution mismatch for ${expectedSpecifier}`);
		}
		const resolvedPath = fileURLToPath(resolvedUrl);
		if (resolvedPath !== expectedPath || readFileSync(resolvedPath).byteLength === 0) {
			throw new Error(`workspace package target mismatch for ${expectedSpecifier}`);
		}
		resolvedImports[specifier] = resolvedUrl;
	}
	return execFileSync(
		process.execPath,
		[...(input.nodeArguments ?? []), input.childPath, input.mode, JSON.stringify(resolvedImports)],
		{
			cwd: input.packageDirectory,
			encoding: "utf8",
			env: environment,
			maxBuffer: 1024 * 1024,
		}
	);
}

/**
 * Creates a fresh-process Node import hook bound to exact freshly built files.
 * @param input - Bare specifiers mapped to their exact built targets.
 * @returns One `--import` argument that registers the closed resolver.
 */
export function workspacePackageImportHook(input) {
	if (
		!plainRecord(input) ||
		Reflect.ownKeys(input).some((key) => String(key) !== "expectedImports") ||
		!plainRecord(input.expectedImports) ||
		Object.keys(input.expectedImports).length === 0
	) {
		throw new TypeError("workspace package import hook is malformed");
	}
	const expectedImports = input.expectedImports;
	const resolved = {};
	for (const [specifier, expectedPath] of Object.entries(expectedImports)) {
		if (
			typeof specifier !== "string" ||
			specifier.length === 0 ||
			typeof expectedPath !== "string" ||
			expectedPath.length === 0 ||
			!existsSync(expectedPath) ||
			readFileSync(expectedPath).byteLength === 0
		) {
			throw new Error(`workspace package target mismatch for ${specifier}`);
		}
		const parts = specifier.split("/");
		const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
		let packageDirectory = dirname(expectedPath);
		const filesystemRoot = parse(packageDirectory).root;
		while (packageDirectory !== filesystemRoot && !existsSync(`${packageDirectory}/package.json`)) {
			packageDirectory = dirname(packageDirectory);
		}
		if (!existsSync(`${packageDirectory}/package.json`)) {
			throw new Error(`workspace package target mismatch for ${specifier}`);
		}
		const manifest = JSON.parse(readFileSync(`${packageDirectory}/package.json`, "utf8"));
		if (!plainRecord(manifest) || manifest.name !== packageName) {
			throw new Error(`workspace package target mismatch for ${specifier}`);
		}
		let resolvedUrl;
		try {
			resolvedUrl = execFileSync(
				process.execPath,
				["--input-type=module", "--eval", `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`],
				{
					cwd: packageDirectory,
					encoding: "utf8",
					env: deterministicEnvironment(),
					maxBuffer: 1024 * 1024,
				}
			).trim();
		} catch {
			throw new Error(`workspace package target mismatch for ${specifier}`);
		}
		if (resolvedUrl.length === 0 || fileURLToPath(resolvedUrl) !== expectedPath) {
			throw new Error(`workspace package target mismatch for ${specifier}`);
		}
		resolved[specifier] = resolvedUrl;
	}
	const hookSource =
		`const targets=${JSON.stringify(resolved)};` +
		`export async function resolve(specifier,context,nextResolve){` +
		`const target=targets[specifier];return target===undefined?nextResolve(specifier,context):{shortCircuit:true,url:target};}`;
	const hookUrl = `data:text/javascript;base64,${Buffer.from(hookSource).toString("base64")}`;
	const preloadSource = `import{register}from"node:module";register(${JSON.stringify(hookUrl)},import.meta.url);`;
	return `--import=data:text/javascript;base64,${Buffer.from(preloadSource).toString("base64")}`;
}

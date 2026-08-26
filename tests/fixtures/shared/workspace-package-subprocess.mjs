/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

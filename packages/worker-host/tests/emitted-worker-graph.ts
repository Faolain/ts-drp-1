/* eslint-disable jsdoc/require-jsdoc */
import { build, type BuildResult, type Metafile, type Plugin } from "esbuild";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const MAX_INPUTS = 256;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_EMITTED_BYTES = 4 * 1024 * 1024;
const APPROVED_BARE_IMPORTS = new Set([
	"@ts-drp/canonical",
	"@ts-drp/compaction",
	"@ts-drp/worker-host",
	"@ts-drp/worker-host/host",
	"@ts-drp/worker-host/worker",
]);
const IGNORED_DIRECTORIES = new Set([".git", "dist", "node_modules", "playwright-report", "test-results"]);
const FORBIDDEN_GRAPH_OWNERS = /(?:^|\/)(?:packages\/)?(application|object|protocol-v3|reducer|fold)(?:\/|$)/u;

export interface EmittedWorkerArtifact {
	readonly bytes: Uint8Array;
	readonly entry: string;
	readonly inputs: readonly string[];
}

function graphFailure(entry: string, source: string, reason: string): Error {
	return new Error(`worker graph ${entry}: ${source}: ${reason}`);
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isBareImport(path: string): boolean {
	return !path.startsWith(".") && !path.startsWith("/") && !path.startsWith("node:") && !path.startsWith("data:");
}

function isOwnedImporter(packageRoot: string, importer: string): boolean {
	if (!isWithin(packageRoot, importer)) return false;
	const normalized = importer.split(sep).join("/");
	return normalized.endsWith(".worker.ts") || normalized.includes("/fixtures/");
}

function importOwnershipPlugin(packageRoot: string, entry: string): Plugin {
	return {
		name: "phase-2f-c-import-ownership",
		setup(buildContext): void {
			buildContext.onResolve({ filter: /.*/ }, (args) => {
				if (
					args.importer !== "" &&
					isOwnedImporter(packageRoot, args.importer) &&
					isBareImport(args.path) &&
					!APPROVED_BARE_IMPORTS.has(args.path)
				) {
					return {
						errors: [{ text: graphFailure(entry, args.importer, `forbidden bare import ${args.path}`).message }],
					};
				}
				return undefined;
			});
		},
	};
}

function assertParserPredicates(entry: string, source: string, text: string, scriptKind: ts.ScriptKind): void {
	const parsed = ts.createSourceFile(source, text, ts.ScriptTarget.ES2022, true, scriptKind);
	const diagnostics = (parsed as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] })
		.parseDiagnostics;
	if (diagnostics.length !== 0) {
		throw graphFailure(entry, source, `TypeScript parser failure: ${diagnostics[0]?.messageText}`);
	}

	function visit(node: ts.Node, insideFunction: boolean): void {
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			throw graphFailure(entry, source, "dynamic import is forbidden");
		}
		if (!insideFunction && ts.isAwaitExpression(node)) {
			throw graphFailure(entry, source, "top-level await is forbidden");
		}
		if (!insideFunction && ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
			throw graphFailure(entry, source, "top-level for-await is forbidden");
		}
		const childInsideFunction = insideFunction || ts.isFunctionLike(node);
		node.forEachChild((child) => visit(child, childInsideFunction));
	}

	visit(parsed, false);
}

function absoluteInputPath(packageRoot: string, input: string): string {
	return isAbsolute(input) ? input : resolve(packageRoot, input);
}

async function scanInputs(packageRoot: string, entry: string, metafile: Metafile): Promise<readonly string[]> {
	const workspaceRoot = await findWorkspaceRoot(packageRoot);
	const inputs = Object.keys(metafile.inputs).sort();
	if (inputs.length > MAX_INPUTS) throw graphFailure(entry, "inputs", `${inputs.length} exceeds ${MAX_INPUTS}`);
	for (const input of inputs) {
		const normalizedInput = input.split(sep).join("/");
		const forbiddenOwner = FORBIDDEN_GRAPH_OWNERS.exec(normalizedInput)?.[1];
		if (forbiddenOwner !== undefined) {
			throw graphFailure(entry, input, `forbidden dependency owner ${forbiddenOwner}`);
		}
		const absolute = absoluteInputPath(packageRoot, input);
		if (!isWithin(workspaceRoot, absolute) || absolute.split(sep).includes("node_modules")) continue;
		let bytes: Buffer;
		try {
			bytes = await readFile(absolute);
		} catch (error) {
			throw graphFailure(entry, input, `read failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (bytes.byteLength > MAX_SOURCE_BYTES) {
			throw graphFailure(entry, input, `${bytes.byteLength} source bytes exceeds ${MAX_SOURCE_BYTES}`);
		}
		assertParserPredicates(entry, input, bytes.toString("utf8"), ts.ScriptKind.TS);
	}
	return inputs;
}

async function buildEntry(packageRoot: string, entry: string): Promise<BuildResult<{ metafile: true; write: false }>> {
	try {
		return await build({
			absWorkingDir: packageRoot,
			bundle: true,
			entryPoints: [resolve(packageRoot, entry)],
			format: "esm",
			metafile: true,
			platform: "browser",
			plugins: [importOwnershipPlugin(packageRoot, entry)],
			target: "es2022",
			write: false,
		});
	} catch (error) {
		throw graphFailure(entry, "build", error instanceof Error ? error.message : String(error));
	}
}

async function findWorkspaceRoot(packageRoot: string): Promise<string> {
	let candidate = packageRoot;
	while (true) {
		if ((await stat(resolve(candidate, "pnpm-workspace.yaml")).catch(() => undefined))?.isFile() === true) {
			return candidate;
		}
		const parent = resolve(candidate, "..");
		if (parent === candidate) return packageRoot;
		candidate = parent;
	}
}

async function workerCensus(packageRoot: string): Promise<readonly string[]> {
	const found: string[] = [];
	async function walk(directory: string): Promise<void> {
		for (const item of await readdir(directory, { withFileTypes: true })) {
			if (item.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(item.name)) await walk(resolve(directory, item.name));
			} else if (item.isFile() && item.name.endsWith(".worker.ts")) {
				found.push(relative(packageRoot, resolve(directory, item.name)).split(sep).join("/"));
			}
		}
	}
	await walk(packageRoot);
	return found.sort();
}

async function readManifest(packageRoot: string): Promise<readonly string[]> {
	const path = resolve(packageRoot, "worker-entries.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		throw graphFailure(
			"worker-entries.json",
			path,
			`manifest read failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw graphFailure("worker-entries.json", path, "manifest must be a JSON string array");
	}
	const entries = [...parsed].sort();
	if (new Set(entries).size !== entries.length) {
		throw graphFailure("worker-entries.json", path, "manifest entries must be unique");
	}
	for (const entry of entries) {
		if (entry.startsWith("/") || entry.startsWith("../") || !entry.endsWith(".worker.ts")) {
			throw graphFailure("worker-entries.json", entry, "manifest entry must be a relative *.worker.ts path");
		}
	}
	return entries;
}

export async function checkEmittedWorkerGraph(packageRoot: string): Promise<readonly EmittedWorkerArtifact[]> {
	packageRoot = await realpath(packageRoot);
	const [entries, census] = await Promise.all([readManifest(packageRoot), workerCensus(packageRoot)]);
	if (JSON.stringify(entries) !== JSON.stringify(census)) {
		const listed = new Set(entries);
		const present = new Set(census);
		const missing = entries.filter((entry) => !present.has(entry));
		const unlisted = census.filter((entry) => !listed.has(entry));
		throw graphFailure(
			"worker-entries.json",
			packageRoot,
			`manifest mismatch missing=[${missing.join(",")}] unlisted=[${unlisted.join(",")}]`
		);
	}

	const artifacts: EmittedWorkerArtifact[] = [];
	for (const entry of entries) {
		const sourcePath = resolve(packageRoot, entry);
		const sourceStat = await stat(sourcePath).catch(() => undefined);
		if (sourceStat?.isFile() !== true) throw graphFailure(entry, sourcePath, "listed entry is not a file");
		const result = await buildEntry(packageRoot, entry);
		const inputs = await scanInputs(packageRoot, entry, result.metafile);
		if (result.outputFiles.length !== 1) {
			throw graphFailure(entry, "artifact", `expected one emitted artifact, got ${result.outputFiles.length}`);
		}
		const output = result.outputFiles[0] as (typeof result.outputFiles)[number];
		if (output.contents.byteLength > MAX_EMITTED_BYTES) {
			throw graphFailure(entry, "artifact", `${output.contents.byteLength} emitted bytes exceeds ${MAX_EMITTED_BYTES}`);
		}
		assertParserPredicates(entry, "artifact", output.text, ts.ScriptKind.JS);
		artifacts.push({ bytes: new Uint8Array(output.contents), entry, inputs });
	}
	return artifacts;
}

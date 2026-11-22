import type { Plugin } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

import type { NativeReadBackend } from "./read-observer.js";

const root = resolve(import.meta.dirname, "../../..");
const observerPath = join(root, "tests/fixtures/cold-discovery/read-observer.ts");
const modulePaths = {
	node: join(root, "packages/storage-node/dist/src/snapshot-transfer.js"),
	browser: join(root, "packages/storage-browser/dist/src/snapshot-transfer.js"),
};
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Insert only registration and native-port invocation observation into exact dist bytes.
 * @param raw - Actual loaded module bytes.
 * @param backend - Selected native owner, not an inferred filename suffix.
 * @returns Transformed bytes and the exact insertion operations.
 */
export function transformNativeRead(
	raw: string,
	backend: NativeReadBackend
): { code: string; insertions: { offset: number; text: string }[] } {
	if (raw.includes("__coldNativePortRead") || raw.includes("__coldRegisterNativeRead"))
		throw new Error("NATIVE_READ_TRANSFORM_ALREADY_PRESENT");
	const ast = ts.createSourceFile(modulePaths[backend], raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const quarantines: ts.VariableDeclaration[] = [];
	const findQuarantine = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "verificationQuarantine")
			quarantines.push(node);
		ts.forEachChild(node, findQuarantine);
	};
	findQuarantine(ast);
	const quarantine = quarantines[0]?.initializer;
	if (
		quarantines.length !== 1 ||
		quarantine === undefined ||
		!ts.isCallExpression(quarantine) ||
		quarantine.expression.getText(ast) !== "Object.freeze" ||
		quarantine.arguments.length !== 1 ||
		!ts.isObjectLiteralExpression(quarantine.arguments[0] as ts.Node)
	)
		throw new Error("NATIVE_READ_QUARANTINE_SITE_NOT_UNIQUE");
	const object = quarantine.arguments[0] as ts.ObjectLiteralExpression;
	if (object.properties.length !== 1 || object.properties[0]?.name?.getText(ast) !== "open")
		throw new Error("NATIVE_READ_QUARANTINE_OPEN_SHAPE");
	const reads: ts.ArrowFunction[] = [];
	const findRead = (node: ts.Node): void => {
		if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "read" && ts.isArrowFunction(node.initializer))
			reads.push(node.initializer);
		ts.forEachChild(node, findRead);
	};
	findRead(object);
	const read = reads[0];
	if (
		reads.length !== 1 ||
		read === undefined ||
		read.parameters.length !== 1 ||
		read.parameters[0]?.name.getText(ast) !== (backend === "node" ? "descriptorInput" : "input")
	)
		throw new Error("NATIVE_READ_METHOD_SITE_NOT_UNIQUE");
	const call = `__coldNativePortRead(${JSON.stringify(backend)})`;
	const insertions: { offset: number; text: string }[] = [];
	if (backend === "node") {
		if (
			!ts.isBlock(read.body) ||
			read.body.statements.length !== 1 ||
			!ts.isReturnStatement(read.body.statements[0] as ts.Node) ||
			!(read.body.statements[0] as ts.ReturnStatement).expression?.getText(ast).startsWith("promiseCapture(")
		)
			throw new Error("NATIVE_READ_NODE_RETURN_SHAPE");
		insertions.push({ offset: read.body.getStart(ast) + 1, text: `\n${call};` });
	} else {
		if (!ts.isCallExpression(read.body) || read.body.expression.getText(ast) !== "promiseCapture")
			throw new Error("NATIVE_READ_BROWSER_RETURN_SHAPE");
		// A comma expression returns the original promise without a promise wrapper.
		insertions.push({ offset: read.body.getStart(ast), text: `(${call}, ` }, { offset: read.body.end, text: ")" });
	}
	insertions.push({
		offset: 0,
		text: `import { nativePortRead as __coldNativePortRead, registerNativeReadSite as __coldRegisterNativeRead } from ${JSON.stringify(observerPath)};\n__coldRegisterNativeRead(${JSON.stringify(backend)});\n`,
	});
	let code = raw;
	for (const insertion of [...insertions].sort((a, b) => b.offset - a.offset))
		code = code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.offset);
	return { code, insertions };
}

/**
 * Build-only observation with original/transformed custody and exact path checks.
 * @param backend - Required native module for this entry.
 * @param archive - New directory for original bytes, observed bytes and diff.
 * @returns Plugin and completion audit refusing missing or duplicate modules.
 */
export function nativeReadTransform(
	backend: NativeReadBackend,
	archive: string
): { plugin: Plugin; finish(): Readonly<Record<string, unknown>> } {
	let loads = 0;
	let receipt: Readonly<Record<string, unknown>> | undefined;
	return {
		plugin: {
			name: "cold-discovery-native-port-read-observation",
			setup(context): void {
				// esbuild uses Go regex syntax, which rejects JavaScript's Unicode flag.
				context.onLoad({ filter: /snapshot-transfer\.js$/ }, ({ path }) => {
					const actual = resolve(path);
					if (!Object.values(modulePaths).includes(actual)) return undefined;
					if (actual !== modulePaths[backend] || loads !== 0) throw new Error("NATIVE_READ_UNEXPECTED_MODULE");
					loads += 1;
					const raw = readFileSync(actual, "utf8");
					const transformed = transformNativeRead(raw, backend);
					mkdirSync(archive, { recursive: true });
					const rawPath = join(archive, "native.raw.js");
					const transformedPath = join(archive, "native.observed.js");
					writeFileSync(rawPath, raw, { flag: "wx" });
					writeFileSync(transformedPath, transformed.code, { flag: "wx" });
					writeFileSync(join(archive, "read-observer.ts"), readFileSync(observerPath), { flag: "wx" });
					writeFileSync(join(archive, "read-transform.ts"), readFileSync(import.meta.filename), { flag: "wx" });
					const diff = spawnSync("diff", ["-u", rawPath, transformedPath], { encoding: "utf8" });
					if (diff.status !== 1) throw new Error("NATIVE_READ_INSERTION_DIFF_FAILED");
					const diffPath = join(archive, "insertion.patch");
					writeFileSync(diffPath, diff.stdout, { flag: "wx" });
					receipt = {
						modulePath: actual,
						backend,
						readSites: 1,
						rawPath,
						rawSha256: digest(raw),
						transformedPath,
						transformedSha256: digest(transformed.code),
						diffPath,
						diffSha256: digest(diff.stdout),
						insertions: transformed.insertions,
						observerPath,
						observerSha256: digest(readFileSync(observerPath)),
						transformPath: import.meta.filename,
						transformSha256: digest(readFileSync(import.meta.filename)),
					};
					writeFileSync(join(archive, "transform.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
					return { contents: transformed.code, loader: "js", resolveDir: resolve(actual, "..") };
				});
			},
		},
		finish(): Readonly<Record<string, unknown>> {
			if (loads !== 1 || receipt === undefined) throw new Error(`NATIVE_READ_LOADED_MODULE_COUNT:${loads}`);
			if (digest(readFileSync(modulePaths[backend])) !== receipt.rawSha256)
				throw new Error("NATIVE_READ_RAW_MODULE_CHANGED_DURING_BUILD");
			if (
				digest(readFileSync(observerPath)) !== receipt.observerSha256 ||
				digest(readFileSync(import.meta.filename)) !== receipt.transformSha256
			)
				throw new Error("NATIVE_READ_OBSERVER_CHANGED_DURING_BUILD");
			return receipt;
		},
	};
}

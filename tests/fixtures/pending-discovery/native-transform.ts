import type { Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

import { transformNativeRead } from "../cold-discovery/read-transform.js";
const root = resolve(import.meta.dirname, "../../..");
const observer = join(root, "tests/fixtures/pending-discovery/observer.ts");
const owners = {
	node: join(root, "packages/storage-node/dist/src/snapshot-transfer.js"),
	browser: join(root, "packages/storage-browser/dist/src/snapshot-transfer.js"),
};
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/**
 * Insertion-only method-entry accounting; original return expressions and promises are unchanged.
 * @param raw - Exact built owner module bytes.
 * @param backend - The single expected native owner.
 * @returns Exact insertion-only operations and resulting bytes.
 */
export function transformNativeOwners(
	raw: string,
	backend: "node" | "browser"
): { code: string; insertions: { offset: number; text: string }[] } {
	if (raw.includes("__pendingNativeOwner")) throw new Error("NATIVE_OWNER_ALREADY_OBSERVED");
	const ast = ts.createSourceFile(owners[backend], raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const matches = new Map<string, ts.ArrowFunction[]>();
	const completes: ts.ArrowFunction[] = [];
	const mutables: ts.ArrowFunction[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === (backend === "node" ? "requireMutable" : "mutable") &&
			node.initializer !== undefined &&
			ts.isArrowFunction(node.initializer)
		)
			mutables.push(node.initializer);
		if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "complete" && ts.isArrowFunction(node.initializer))
			completes.push(node.initializer);
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			["lookupRecoveryDeclaration", "openScope"].includes(node.name.text)
		) {
			if (node.initializer === undefined || !ts.isArrowFunction(node.initializer))
				throw new Error("NATIVE_OWNER_METHOD_SHAPE");
			matches.set(node.name.text, [...(matches.get(node.name.text) ?? []), node.initializer]);
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	for (const name of ["lookupRecoveryDeclaration", "openScope"])
		if (matches.get(name)?.length !== 1) throw new Error("NATIVE_OWNER_SEAM_NOT_UNIQUE:" + name);
	const insertions = [
		{
			offset: 0,
			text: `import {nativeOwner as __pendingNativeOwner, lookupOutcome as __pendingLookupOutcome, lookupRefusal as __pendingLookupRefusal, mutationRefusal as __pendingMutationRefusal} from ${JSON.stringify(observer)};\n`,
		},
	];
	const mutable = mutables[0];
	if (mutables.length !== 1 || mutable === undefined) throw new Error("NATIVE_MUTABLE_REFUSAL_SEAM_NOT_UNIQUE");
	let migrationRefusals = 0;
	const observeMigration = (node: ts.Node): void => {
		if (
			ts.isThrowStatement(node) &&
			node.expression !== undefined &&
			ts.isCallExpression(node.expression) &&
			node.expression.expression.getText(ast) === "failure" &&
			node.expression.arguments[0]?.getText(ast) === '"migration-required"'
		) {
			migrationRefusals++;
			insertions.push(
				{ offset: node.expression.getStart(ast), text: "__pendingMutationRefusal(" },
				{ offset: node.expression.end, text: ")" }
			);
		}
		ts.forEachChild(node, observeMigration);
	};
	observeMigration(mutable.body);
	if (migrationRefusals !== 1) throw new Error("NATIVE_MUTABLE_REFUSAL_SEAM_NOT_UNIQUE");
	for (const name of ["lookupRecoveryDeclaration", "openScope"]) {
		const methods = matches.get(name),
			method = methods?.[0];
		if (methods?.length !== 1 || method === undefined || method.parameters.length !== 2)
			throw new Error("NATIVE_OWNER_SEAM_NOT_UNIQUE:" + name);
		const input = method.parameters[0]?.name.getText(ast);
		if (input !== (name === "openScope" && backend === "node" ? "declarationInput" : "input"))
			throw new Error("NATIVE_OWNER_ARGUMENT_CHANGED");
		if (name === "lookupRecoveryDeclaration") {
			let misses = 0,
				resolutions = 0,
				conflicts = 0;
			const observeResolution = (node: ts.Node): void => {
				if (ts.isReturnStatement(node) && node.expression !== undefined) {
					const value = node.expression,
						text = value.getText(ast).replace(/\s+/gu, " ");
					const validated =
						ts.isCallExpression(value) &&
						value.expression.getText(ast) === "snapshotQuarantineContract.validateRecoveryManifest" &&
						value.arguments.length === 2 &&
						value.arguments[0]?.getText(ast) === "scope" &&
						(backend === "browser"
							? value.arguments[1]?.getText(ast) === "row"
							: value.arguments[1] !== undefined &&
								ts.isObjectLiteralExpression(value.arguments[1]) &&
								value.arguments[1].getText(ast).replace(/\s+/gu, " ") ===
									"{ exactCanonicalManifestBytes: row.exact_manifest_bytes, totalBytes: row.total_bytes, chunkCount: row.chunk_count, expiresAt: row.expires_at, state: row.state, retention: row.retention, incarnation: row.incarnation, descriptors, }");
					if (text === 'Object.freeze({ kind: "missing" })' || validated) {
						if (text.startsWith("Object.freeze")) misses++;
						else resolutions++;
						insertions.push(
							{ offset: value.getStart(ast), text: "__pendingLookupOutcome(scope, " },
							{ offset: value.end, text: ")" }
						);
					}
				}
				if (
					ts.isThrowStatement(node) &&
					node.expression !== undefined &&
					ts.isCallExpression(node.expression) &&
					node.expression.expression.getText(ast) === "failure" &&
					node.expression.arguments[0]?.getText(ast) === '"conflict"'
				) {
					conflicts++;
					insertions.push(
						{ offset: node.expression.getStart(ast), text: "__pendingLookupRefusal(scope, " },
						{ offset: node.expression.end, text: ")" }
					);
				}
				ts.forEachChild(node, observeResolution);
			};
			observeResolution(method.body);
			if (misses !== 1 || resolutions !== 1 || conflicts !== 1)
				throw new Error("NATIVE_LOOKUP_RESOLUTION_SEAM_NOT_UNIQUE");
		}
		const call = `__pendingNativeOwner(${JSON.stringify(name === "openScope" ? "native-acquire" : "native-lookup")}, ${input})`;
		if (ts.isBlock(method.body)) {
			if (
				backend !== "node" ||
				name !== "openScope" ||
				method.body.statements.length !== 1 ||
				!ts.isReturnStatement(method.body.statements[0] as ts.Node)
			)
				throw new Error("NATIVE_OWNER_BLOCK_CHANGED");
			insertions.push({ offset: method.body.getStart(ast) + 1, text: `\n${call};` });
		} else {
			if (!ts.isCallExpression(method.body) || method.body.expression.getText(ast) !== "promiseCapture")
				throw new Error("NATIVE_OWNER_PROMISE_CHANGED");
			insertions.push(
				{ offset: method.body.getStart(ast), text: `(${call}, ` },
				{ offset: method.body.end, text: ")" }
			);
		}
	}
	const complete = completes[0];
	if (
		completes.length !== 1 ||
		complete === undefined ||
		complete.parameters.length !== 2 ||
		complete.parameters[0]?.name.getText(ast) !== "receipt"
	)
		throw new Error("NATIVE_COMPLETE_SEAM_NOT_UNIQUE");
	const completeCall = '__pendingNativeOwner("complete", declaration.scope)';
	if (ts.isBlock(complete.body)) {
		if (
			backend !== "node" ||
			complete.body.statements.length !== 2 ||
			!ts.isReturnStatement(complete.body.statements[1] as ts.Node)
		)
			throw new Error("NATIVE_COMPLETE_BLOCK_CHANGED");
		insertions.push({ offset: complete.body.getStart(ast) + 1, text: `\n${completeCall};` });
	} else {
		if (
			backend !== "browser" ||
			!ts.isCallExpression(complete.body) ||
			complete.body.expression.getText(ast) !== "promiseCapture"
		)
			throw new Error("NATIVE_COMPLETE_PROMISE_CHANGED");
		insertions.push(
			{ offset: complete.body.getStart(ast), text: `(${completeCall}, ` },
			{ offset: complete.body.end, text: ")" }
		);
	}
	let code = raw;
	for (const insertion of [...insertions].sort((a, b) => b.offset - a.offset))
		code = code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.offset);
	return { code, insertions };
}
/**
 * Compose exact native owner and unchanged neutral read insertions in one loaded module.
 * @param backend - The single expected native owner.
 * @param archive - Fresh fixture evidence directory.
 * @returns Fail-closed plugin and source custody receipt.
 */
export function pendingNativeTransform(
	backend: "node" | "browser",
	archive: string
): { plugin: Plugin; finish(): unknown } {
	let receipt: Record<string, unknown> | undefined;
	return {
		plugin: {
			name: "pending-native-owner-and-port-observation",
			setup(context): void {
				context.onLoad({ filter: /snapshot-transfer\.js$/ }, ({ path }) => {
					if (!Object.values(owners).includes(resolve(path))) return undefined;
					if (resolve(path) !== owners[backend] || receipt !== undefined)
						throw new Error("NATIVE_OWNER_UNEXPECTED_MODULE");
					const raw = readFileSync(path, "utf8"),
						methods = transformNativeOwners(raw, backend),
						reads = transformNativeRead(methods.code, backend);
					mkdirSync(archive, { recursive: true });
					for (const [name, bytes] of [
						["raw.js", raw],
						["methods.js", methods.code],
						["observed.js", reads.code],
					])
						writeFileSync(join(archive, name as string), bytes as string, { flag: "wx" });
					receipt = {
						owner: owners[backend],
						backend,
						rawSha256: hash(raw),
						methodsSha256: hash(methods.code),
						observedSha256: hash(reads.code),
						methodInsertions: methods.insertions,
						readInsertions: reads.insertions,
						observer,
						observerSha256: hash(readFileSync(observer)),
						transformSha256: hash(readFileSync(import.meta.filename)),
						neutralReadTransformSha256: hash(
							readFileSync(join(root, "tests/fixtures/cold-discovery/read-transform.ts"))
						),
					};
					writeFileSync(join(archive, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
					return { contents: reads.code, loader: "js", resolveDir: dirname(path) };
				});
			},
		},
		finish(): unknown {
			if (
				receipt === undefined ||
				hash(readFileSync(owners[backend])) !== receipt.rawSha256 ||
				hash(readFileSync(observer)) !== receipt.observerSha256 ||
				hash(readFileSync(import.meta.filename)) !== receipt.transformSha256
			)
				throw new Error("NATIVE_OWNER_CUSTODY_FAILED");
			return receipt;
		},
	};
}

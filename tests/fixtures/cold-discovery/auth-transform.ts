import type { Plugin } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

import type { AuthModule, AuthSite } from "./auth-observer.js";

const root = resolve(import.meta.dirname, "../../..");
const observerPath = join(root, "tests/fixtures/cold-discovery/auth-observer.ts");
const modules: Record<
	AuthModule,
	{ path: string; owner: string; sites: Record<string, { site: AuthSite; callee: string }> }
> = {
	cold: {
		path: join(root, "packages/node/dist/src/creator-adoption.js"),
		owner: "reopenCreatorSuccessorMaterial",
		sites: {
			openedCurrent: { site: "cold-genesis", callee: "openCurrentAnchorTrust" },
			openedSuccessor: { site: "cold-successor", callee: "openCreatorSuccessorTrust" },
			openedCheckpoint: { site: "cold-checkpoint", callee: "openCreatorCheckpointTrust" },
		},
	},
	successor: {
		path: join(root, "packages/protocol-v3/dist/src/creator-close.js"),
		owner: "openCreatorSuccessorTrust",
		sites: {
			verified: { site: "successor-qc", callee: "verifySealQC" },
			valueDigest: { site: "successor-cut-binding", callee: "hex" },
		},
	},
};
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Insert observation statements after genuine production assignments; never wrap calls or returns.
 * @param raw - Exact loaded production bytes.
 * @param module - Expected production owner.
 * @returns Original text plus fully enumerated insertions.
 */
export function transformAuthentication(
	raw: string,
	module: AuthModule
): { code: string; insertions: { offset: number; text: string }[] } {
	if (raw.includes("__coldAuthEvent") || raw.includes("__coldRegisterAuth"))
		throw new Error("AUTH_TRANSFORM_ALREADY_PRESENT");
	const spec = modules[module];
	const ast = ts.createSourceFile(spec.path, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const owners = ast.statements.filter(
		(node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === spec.owner
	);
	if (owners.length !== 1 || owners[0]?.body === undefined) throw new Error("AUTH_OWNER_SITE_NOT_UNIQUE");
	const insertions: { offset: number; text: string }[] = [];
	const found = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableStatement(node))
			for (const declaration of node.declarationList.declarations) {
				const name = declaration.name.getText(ast),
					selected = spec.sites[name];
				if (selected === undefined) continue;
				if (
					found.has(name) ||
					node.declarationList.declarations.length !== 1 ||
					declaration.initializer === undefined ||
					!ts.isCallExpression(declaration.initializer) ||
					declaration.initializer.expression.getText(ast) !== selected.callee
				)
					throw new Error("AUTH_RESULT_SITE_NOT_UNIQUE_OR_GENUINE");
				if (
					name === "valueDigest" &&
					declaration.initializer.arguments[0]?.getText(ast) !==
						'hashDomain((_d = (_c = registry.kinds.cutValue) === null || _c === void 0 ? void 0 : _c.domain) !== null && _d !== void 0 ? _d : "", cutBytes)'
				)
					throw new Error("AUTH_CUT_DIGEST_SITE_CHANGED");
				found.add(name);
				insertions.push({
					offset: node.end,
					text: `\n__coldAuthEvent(${JSON.stringify(selected.site)}, ${name === "valueDigest" ? "{ matches: verified.valueDigest === valueDigest }" : name});`,
				});
			}
		ts.forEachChild(node, visit);
	};
	visit(owners[0].body);
	if (found.size !== Object.keys(spec.sites).length) throw new Error("AUTH_RESULT_SITE_NOT_UNIQUE_OR_GENUINE");
	insertions.push({
		offset: 0,
		text: `import { authEvent as __coldAuthEvent, registerAuthModule as __coldRegisterAuth } from ${JSON.stringify(observerPath)};\n__coldRegisterAuth(${JSON.stringify(module)});\n`,
	});
	let code = raw;
	for (const insertion of [...insertions].sort((left, right) => right.offset - left.offset))
		code = code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.offset);
	return { code, insertions };
}

/**
 * Observe the two exact loaded owners and archive original/transformed bytes with hash custody.
 * @param archive - Fresh evidence directory.
 * @returns Build plugin and fail-closed final custody check.
 */
export function authenticationTransform(archive: string): {
	plugin: Plugin;
	finish(): Readonly<Record<string, unknown>>;
} {
	const receipts = new Map<
		AuthModule,
		{ modulePath: string; rawSha256: string; observedSha256: string; insertions: { offset: number; text: string }[] }
	>();
	const observerSha256 = hash(readFileSync(observerPath)),
		transformSha256 = hash(readFileSync(import.meta.filename));
	return {
		plugin: {
			name: "cold-discovery-authentication-result-observation",
			setup(context): void {
				context.onLoad({ filter: /(?:creator-adoption|creator-close)\.js$/ }, ({ path }) => {
					const selected = (Object.keys(modules) as AuthModule[]).find(
						(module) => modules[module].path === resolve(path)
					);
					if (selected === undefined) return undefined;
					if (receipts.has(selected)) throw new Error("AUTH_MODULE_LOADED_TWICE");
					const raw = readFileSync(path, "utf8"),
						transformed = transformAuthentication(raw, selected);
					mkdirSync(archive, { recursive: true });
					const rawPath = join(archive, `${selected}.raw.js`),
						observedPath = join(archive, `${selected}.observed.js`);
					writeFileSync(rawPath, raw, { flag: "wx" });
					writeFileSync(observedPath, transformed.code, { flag: "wx" });
					const diff = spawnSync("diff", ["-u", rawPath, observedPath], { encoding: "utf8" });
					if (diff.status !== 1) throw new Error("AUTH_INSERTION_DIFF_FAILED");
					writeFileSync(join(archive, `${selected}.patch`), diff.stdout, { flag: "wx" });
					const receipt = {
						modulePath: path,
						rawSha256: hash(raw),
						observedSha256: hash(transformed.code),
						insertions: transformed.insertions,
					};
					receipts.set(selected, receipt);
					return { contents: transformed.code, loader: "js", resolveDir: dirname(path) };
				});
			},
		},
		finish(): Readonly<Record<string, unknown>> {
			if (receipts.size !== 2) throw new Error(`AUTH_LOADED_MODULE_COUNT:${receipts.size}`);
			for (const receipt of receipts.values())
				if (hash(readFileSync(receipt.modulePath)) !== receipt.rawSha256)
					throw new Error("AUTH_PRODUCT_CHANGED_DURING_BUILD");
			if (
				hash(readFileSync(observerPath)) !== observerSha256 ||
				hash(readFileSync(import.meta.filename)) !== transformSha256
			)
				throw new Error("AUTH_OBSERVER_CHANGED_DURING_BUILD");
			writeFileSync(join(archive, "auth-observer.ts"), readFileSync(observerPath), { flag: "wx" });
			writeFileSync(join(archive, "auth-transform.ts"), readFileSync(import.meta.filename), { flag: "wx" });
			const result = {
				modules: Object.fromEntries(receipts),
				observerPath,
				observerSha256,
				transformPath: import.meta.filename,
				transformSha256,
			};
			writeFileSync(join(archive, "transform.json"), JSON.stringify(result, null, 2), { flag: "wx" });
			return result;
		},
	};
}

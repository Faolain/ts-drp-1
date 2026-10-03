/* eslint-disable jsdoc/require-jsdoc -- Frozen insertion-only observation of genuine internal result call sites. */
import type { Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

export function liveFrameObservation(root: string, archive: string): Plugin {
	const owner = join(root, "packages/node/src/internal/creator-closed-rollback-data.ts");
	return {
		name: "signed-anchor-genuine-live-frame-observation",
		setup(context): void {
			context.onLoad({ filter: /live-journal\.js$/ }, ({ path }) => {
				const backend = path.includes("/storage-node/dist/")
					? "node"
					: path.includes("/storage-browser/dist/")
						? "browser"
						: undefined;
				if (!backend || resolve(path) !== join(root, "packages/storage-" + backend, "dist/src/live-journal.js"))
					return undefined;
				const raw = readFileSync(path, "utf8"),
					ast = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS),
					sites: number[] = [];
				const visit = (node: ts.Node): void => {
					if (
						ts.isVariableDeclaration(node) &&
						ts.isIdentifier(node.name) &&
						node.name.text === "readSignedAnchorEnvelope" &&
						node.initializer &&
						(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
						ts.isBlock(node.initializer.body)
					)
						sites.push(node.initializer.body.getStart(ast) + 1);
					if (ts.isFunctionDeclaration(node) && node.name?.text === "readSignedAnchorEnvelope" && node.body)
						sites.push(node.body.getStart(ast) + 1);
					ts.forEachChild(node, visit);
				};
				visit(ast);
				if (sites.length > 1) throw new Error("SIGNED_READER_ENTRY_NOT_UNIQUE");
				const insertions = sites.map((offset) => ({
					offset,
					text: `\n__signedReadDispatch(input, ${JSON.stringify(backend)});\n`,
				}));
				if (sites.length)
					insertions.push({
						offset: 0,
						text: `import {observeSignedRead as __signedReadDispatch} from ${JSON.stringify(join(root, "tests/fixtures/signed-anchor-mechanism/capture.ts"))};\n`,
					});
				let code = raw;
				for (const i of [...insertions].sort((a, b) => b.offset - a.offset))
					code = code.slice(0, i.offset) + i.text + code.slice(i.offset);
				mkdirSync(archive, { recursive: true });
				const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
				writeFileSync(join(archive, backend + "-reader-raw.js"), raw, { flag: "wx" });
				writeFileSync(join(archive, backend + "-reader-observed.js"), code, { flag: "wx" });
				writeFileSync(
					join(archive, backend + "-reader-insertions.json"),
					JSON.stringify(
						{
							owner: path,
							missingFutureReader: !sites.length,
							insertions,
							rawSha256: hash(raw),
							observedSha256: hash(code),
						},
						null,
						2
					),
					{ flag: "wx" }
				);
				return { contents: code, loader: "js", resolveDir: dirname(path) };
			});
			context.onLoad({ filter: /creator-closed-rollback-data\.ts$/ }, ({ path }) => {
				if (resolve(path) !== owner) return undefined;
				const raw = readFileSync(path, "utf8"),
					insertions: { offset: number; text: string }[] = [];
				for (const [needle, text] of [
					[
						"const accounting = createCreatorClosedRollbackProofAccounting(reader.blobs);",
						"\n__observeLedger(accounting, reader.blobs);",
					],
					[
						"const requirement = deriveAnchorRequirement(input, reader, floor, evidence, trust, binding, closure, cuts);",
						"\nawait __observeRequirement(requirement, trust);",
					],
				] as const) {
					const at = raw.indexOf(needle);
					if (at < 0 || raw.indexOf(needle, at + 1) !== -1) throw new Error("OBSERVATION_SITE_CHANGED:" + needle);
					insertions.push({ offset: at + needle.length, text });
				}
				insertions.push({
					offset: 0,
					text: `import {observeLedger as __observeLedger, observeRequirement as __observeRequirement} from ${JSON.stringify(join(root, "tests/fixtures/signed-anchor-mechanism/capture.ts"))};\n`,
				});
				let code = raw;
				for (const i of [...insertions].sort((a, b) => b.offset - a.offset))
					code = code.slice(0, i.offset) + i.text + code.slice(i.offset);
				mkdirSync(archive, { recursive: true });
				const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
				writeFileSync(join(archive, "raw.ts"), raw, { flag: "wx" });
				writeFileSync(join(archive, "observed.ts"), code, { flag: "wx" });
				writeFileSync(
					join(archive, "insertions.json"),
					JSON.stringify({ owner, insertions, rawSha256: hash(raw), observedSha256: hash(code) }, null, 2),
					{ flag: "wx" }
				);
				return { contents: code, loader: "ts", resolveDir: dirname(path) };
			});
		},
	};
}

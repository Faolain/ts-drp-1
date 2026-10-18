import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const destination = process.argv[2];
if (!destination) throw new Error("FRESH_OUTPUT_REQUIRED");
mkdirSync(destination);
const root = resolve(import.meta.dirname, "../../.."),
	product = join(root, "packages/node/src/internal/creator-closed-rollback-data.ts"),
	hooks = join(root, "tests/fixtures/rollback-same-u/hooks.ts"),
	available = existsSync(product),
	hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const entries = [];
for (const name of ["setup", "composition"]) {
	const result = await build({
		entryPoints: [
			join(
				root,
				"tests/fixtures",
				name === "setup" ? "rollback-data-observation/node-entry.ts" : "rollback-same-u/composition.ts"
			),
		],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "es2022",
		write: false,
		metafile: true,
		alias: {
			"same-u-observer-under-test": available ? product : join(root, "tests/fixtures/rollback-same-u/missing-api.ts"),
		},
		banner: {
			js: 'import { createRequire as __fixtureCreateRequire } from "node:module"; const require = __fixtureCreateRequire(import.meta.url);',
		},
		plugins: [
			{
				name: "same-u-real-owner-call-observation",
				setup(context): void {
					context.onLoad({ filter: /live-journal\.js$/ }, ({ path }) => {
						if (
							resolve(path) !== join(root, "packages/storage-node/dist/src/live-journal.js") ||
							name !== "composition"
						)
							return undefined;
						const raw = readFileSync(path, "utf8"),
							start = raw.indexOf("const readAnchorPreimage ="),
							end = raw.indexOf("const close =", start);
						if (start < 0 || end < start) throw new Error("EXACT_NATIVE_JOURNAL_OWNER_CHANGED");
						const body = raw.slice(start, end),
							insertions: { offset: number; text: string }[] = [];
						for (const [needle, text] of [
							["const selected = captured.value;", "\n__sameUJournalDispatch(input);"],
							["return result;", "__sameUJournalResult(result);\n"],
						] as const) {
							const at = body.indexOf(needle);
							if (at < 0 || body.indexOf(needle, at + 1) >= 0)
								throw new Error("EXACT_NATIVE_JOURNAL_SITE_CHANGED:" + needle);
							insertions.push({ offset: start + at + (needle.startsWith("const") ? needle.length : 0), text });
						}
						let observed = raw;
						for (const edit of [...insertions].sort((a, b) => b.offset - a.offset))
							observed = observed.slice(0, edit.offset) + edit.text + observed.slice(edit.offset);
						observed =
							"import {journalDispatch as __sameUJournalDispatch,journalResult as __sameUJournalResult} from " +
							JSON.stringify(hooks) +
							";\n" +
							observed;
						writeFileSync(join(destination, "journal-raw.js"), raw, { flag: "wx" });
						writeFileSync(join(destination, "journal-observed.js"), observed, { flag: "wx" });
						writeFileSync(
							join(destination, "journal-insertions.json"),
							JSON.stringify({ rawSha256: hash(raw), observedSha256: hash(observed), insertions }, null, 2),
							{ flag: "wx" }
						);
						return { contents: observed, loader: "js", resolveDir: dirname(path) };
					});
					context.onLoad({ filter: /creator-closed-rollback-data\.ts$/ }, ({ path }) => {
						if (resolve(path) !== product) return undefined;
						const raw = readFileSync(path, "utf8"),
							source = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
							edits: { start: number; end: number; replacement: string; kind: string }[] = [];
						function visit(node: ts.Node): void {
							// Never instrument the owner implementation itself or its initial charging.
							if (
								(ts.isFunctionDeclaration(node) && node.name?.text === "createCreatorClosedRollbackProofAccounting") ||
								(ts.isVariableDeclaration(node) &&
									ts.isIdentifier(node.name) &&
									node.name.text === "createCreatorClosedRollbackProofAccounting")
							)
								return;
							if (
								ts.isCallExpression(node) &&
								ts.isIdentifier(node.expression) &&
								node.expression.text === "createCreatorClosedRollbackProofAccounting"
							) {
								if (node.arguments.length !== 1) throw new Error("FACTORY_SEAM_ARITY_CHANGED");
								edits.push({
									start: node.getStart(source),
									end: node.end,
									replacement:
										"__sameUCreated(createCreatorClosedRollbackProofAccounting, " +
										node.arguments[0]?.getText(source) +
										")",
									kind: "real-factory-call",
								});
							} else if (
								ts.isCallExpression(node) &&
								ts.isPropertyAccessExpression(node.expression) &&
								node.expression.name.text === "charge"
							) {
								if (node.arguments.length !== 1) throw new Error("CHARGE_SEAM_ARITY_CHANGED");
								edits.push({
									start: node.getStart(source),
									end: node.end,
									replacement:
										"__sameUCharged(" +
										node.expression.expression.getText(source) +
										", " +
										node.arguments[0]?.getText(source) +
										")",
									kind: "real-owner-charge-call",
								});
							}
							ts.forEachChild(node, visit);
						}
						visit(source);
						if (
							!edits.some((edit) => edit.kind === "real-factory-call") ||
							!edits.some((edit) => edit.kind === "real-owner-charge-call")
						)
							throw new Error("ACTUAL_OBSERVER_OWNER_WIRING_MISSING");
						let observed = raw;
						for (const edit of [...edits].sort((a, b) => b.start - a.start))
							observed = observed.slice(0, edit.start) + edit.replacement + observed.slice(edit.end);
						observed =
							"import {created as __sameUCreated, charged as __sameUCharged} from " +
							JSON.stringify(hooks) +
							";\n" +
							observed;
						writeFileSync(join(destination, "owner-raw.ts"), raw, { flag: "wx" });
						writeFileSync(join(destination, "owner-observed.ts"), observed, { flag: "wx" });
						writeFileSync(
							join(destination, "owner-call-edits.json"),
							JSON.stringify({ rawSha256: hash(raw), observedSha256: hash(observed), edits }, null, 2),
							{ flag: "wx" }
						);
						return { contents: observed, loader: "ts", resolveDir: dirname(path) };
					});
				},
			},
		],
	});
	const bytes = result.outputFiles[0]?.contents;
	if (!bytes) throw new Error("BUNDLE_MISSING");
	writeFileSync(join(destination, name + ".mjs"), bytes, { flag: "wx" });
	writeFileSync(join(destination, name + ".metafile.json"), JSON.stringify(result.metafile), { flag: "wx" });
	entries.push({
		name,
		outputSha256: hash(bytes),
		available,
		inputs: Object.fromEntries(Object.keys(result.metafile.inputs).map((path) => [path, hash(readFileSync(path))])),
	});
}
writeFileSync(join(destination, "artifacts.json"), JSON.stringify({ entries }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ available, entries: entries.map(({ name, outputSha256 }) => ({ name, outputSha256 })) }));

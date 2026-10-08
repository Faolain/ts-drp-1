import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

import { requireValue } from "./assert.js";
import { pendingNativeTransform } from "../pending-discovery/native-transform.js";

const root = resolve(import.meta.dirname, "../../.."),
	destination = process.argv[2];
if (destination === undefined) throw new Error("STARTUP_NEW_ARTIFACT_DIRECTORY_REQUIRED");
mkdirSync(destination); // Existing artifacts cannot be overwritten.
const observer = join(root, "tests/fixtures/startup-discovery/observation.ts");
const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const functions = new Set([
	"prepareV3LiveGeneration",
	"recoverV3LiveReplica",
	"activateV3LivePlane",
	"stageCreatorSuccessorAdoption",
	"publishStagedCreatorSuccessorAdoption",
	"activateCreatorSuccessorAdoption",
	"reopenCreatorSuccessorAdoption",
	"recoverPendingCreatorSuccessorAdoption",
	"bindV3BlueprintLivePlane",
]);
function observation(directory: string): Plugin {
	return {
		name: "startup-room-effect-entry-observation",
		setup(context): void {
			context.onLoad(
				{
					filter:
						/packages\/node\/src\/(?:v3-live|creator-adoption-stage|creator-adoption-activate|creator-adoption-recover)\.ts$/,
				},
				({ path }) => {
					const raw = readFileSync(path, "utf8"),
						ast = ts.createSourceFile(path, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
					const insertions: { offset: number; text: string }[] = [
						{
							offset: 0,
							text: `import {event as __startupEvent, control as __startupControl} from ${JSON.stringify(observer)};\n`,
						},
					];
					const visit = (node: ts.Node): void => {
						if (
							ts.isFunctionDeclaration(node) &&
							node.name !== undefined &&
							functions.has(node.name.text) &&
							node.body !== undefined
						) {
							const name = node.name.text;
							let text = `\n__startupEvent(${JSON.stringify(name)});`;
							if (name === "publishStagedCreatorSuccessorAdoption")
								text += `\nif (__startupControl.publicationFault) { __startupControl.publicationFault = false; __startupEvent("publication-fault"); return Promise.resolve(Object.freeze({ok:false, kind:"startup-injected-publication"})); }`;
							insertions.push({ offset: node.body.getStart(ast) + 1, text });
						}
						ts.forEachChild(node, visit);
					};
					visit(ast);
					if (path.endsWith("/v3-live.ts")) {
						const marker = "signerResolved = true;";
						const offsets = [...raw.matchAll(/signerResolved = true;/gu)].map(
							(match) => requireValue(match.index, "STARTUP_FIXTURE_PRECONDITION") + marker.length
						);
						if (offsets.length !== 2) throw new Error("STARTUP_POST_SIGN_FAULT_SEAM_NOT_UNIQUE");
						for (const offset of offsets)
							insertions.push({
								offset,
								text: '\nif (__startupControl.issueAfterSignFault && planEffect?.kind === "fence") { __startupControl.issueAfterSignFault = false; __startupEvent("issue-after-sign-fault"); throw new Error("STARTUP_SETTLEMENT_SIGNED_ISSUE_FAILURE"); }',
							});
					}
					let code = raw;
					for (const i of insertions.sort((a, b) => b.offset - a.offset))
						code = code.slice(0, i.offset) + i.text + code.slice(i.offset);
					const label = requireValue(path.split("/").at(-1), "STARTUP_FIXTURE_PRECONDITION");
					writeFileSync(join(directory, label + ".raw"), raw, { flag: "wx" });
					writeFileSync(join(directory, label + ".observed"), code, { flag: "wx" });
					writeFileSync(join(directory, label + ".insertions.json"), JSON.stringify(insertions), { flag: "wx" });
					return { contents: code, loader: "ts", resolveDir: dirname(path) };
				}
			);
		},
	};
}
const loaded = (await import(new URL("../../../vite.config.mts", import.meta.url).href)) as {
	workspaceAliases: Record<string, string>;
};
const alias = { ...loaded.workspaceAliases };
for (const name of [
	"creator-adoption",
	"creator-adoption-activate",
	"creator-adoption-commit",
	"creator-adoption-recover",
	"creator-adoption-stage",
	"creator-close",
	"v3-live",
])
	alias["@ts-drp/node/" + name] = join(root, "packages/node/src", name + ".ts");
const entries = [];
for (const name of ["setup", "recovery", "lifecycle", "shipped"]) {
	const archive = join(destination, name);
	mkdirSync(archive);
	const native = pendingNativeTransform("browser", join(archive, "native"));
	// Entry observers emit distinct immutable archives for each actual executable.
	const result = await build({
		entryPoints: [join(root, "tests/fixtures/startup-discovery", name + ".ts")],
		alias,
		nodePaths: [join(root, "packages/storage-browser/node_modules")],
		bundle: true,
		platform: "browser",
		format: "esm",
		target: "es2022",
		write: false,
		metafile: true,
		plugins: [
			observation(archive),
			native.plugin,
			{
				name: "shipped-grid-raw-kernel",
				setup(context): void {
					context.onLoad({ filter: /\?raw$/ }, ({ path }) => ({
						contents: "export default " + JSON.stringify(readFileSync(path.slice(0, -4), "utf8")),
						loader: "js",
					}));
					context.onResolve({ filter: /\?raw$/ }, ({ path, resolveDir }) => ({ path: resolve(resolveDir, path) }));
				},
			},
		],
	});
	const bytes = requireValue(result.outputFiles[0], "STARTUP_FIXTURE_PRECONDITION").contents;
	writeFileSync(join(archive, "entry.mjs"), bytes, { flag: "wx" });
	writeFileSync(join(archive, "metafile.json"), JSON.stringify(result.metafile), { flag: "wx" });
	entries.push({ name, sha256: hash(bytes), native: native.finish() });
}
writeFileSync(join(destination, "artifacts.json"), JSON.stringify({ entries }), { flag: "wx" });
console.log(JSON.stringify({ destination, entries }));

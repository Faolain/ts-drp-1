import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { pendingTransform } from "./auth-transform.js";
import { pendingNativeTransform } from "./native-transform.js";

const root = resolve(import.meta.dirname, "../../..");
const destination = process.argv[2];
if (destination === undefined || existsSync(destination)) throw new Error("BUILD_REQUIRES_NEW_OUTPUT_DIRECTORY");
mkdirSync(destination, { recursive: true });
const names = process.argv.slice(3);
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const entries: unknown[] = [];
const fixtureDirectory = join(root, "tests/fixtures/pending-discovery");
const controllers = Object.fromEntries(
	readdirSync(fixtureDirectory)
		.filter((name) => /\.(?:ts|json)$/u.test(name))
		.map((name) => {
			const path = join(fixtureDirectory, name);
			return [path, hash(readFileSync(path))];
		})
);
for (const name of names) {
	const platform = name.startsWith("browser-") ? "browser" : "node";
	const observation =
		name.includes("recovery") || name.includes("probe")
			? pendingNativeTransform(platform, join(destination, `${name}-read-observation`))
			: undefined;
	const authentication =
		name.includes("recovery") || name.includes("auth-probe")
			? pendingTransform(join(destination, `${name}-auth-observation`))
			: undefined;
	const result = await build({
		entryPoints: [join(root, `tests/fixtures/pending-discovery/${name}.ts`)],
		bundle: true,
		platform,
		format: "esm",
		target: "es2022",
		write: false,
		metafile: true,
		plugins: [
			...(observation === undefined ? [] : [observation.plugin]),
			...(authentication === undefined ? [] : [authentication.plugin]),
		],
		...(platform === "node"
			? {
					banner: {
						js: 'import { createRequire as __fixtureCreateRequire } from "node:module"; const require = __fixtureCreateRequire(import.meta.url);',
					},
				}
			: {}),
	});
	const output = result.outputFiles[0];
	if (output === undefined) throw new Error("NO_FIXTURE_OUTPUT");
	const inputs = Object.keys(result.metafile.inputs);
	const outputPath = join(destination, `${name}.mjs`);
	writeFileSync(outputPath, output.contents, { flag: "wx" });
	const inputHashes = Object.fromEntries(inputs.map((path) => [path, hash(readFileSync(resolve(root, path)))]));
	if (
		name.includes("recovery") &&
		inputs.some((path) =>
			/(?:node-setup|browser-setup|node-probe|browser-probe|node-auth-probe|browser-auth-probe|\/setup|\/probe|\/auth-probe|\/candidates|\/observation-oracle|oracle-controls\.node|candidate-fault-plan|node-candidate-fault|browser-candidate-fault|setup-owners|creator-adoption-contract|repeat-close-contract)\.[cm]?[jt]s$/u.test(
				path
			)
		)
	)
		throw new Error("RECOVERY_GRAPH_CONTAINS_PRODUCER_HELPER");
	const graphPath = join(destination, `${name}.metafile.json`);
	writeFileSync(graphPath, JSON.stringify(result.metafile, null, 2), { flag: "wx" });
	entries.push({
		name,
		platform,
		outputPath,
		outputSha256: hash(output.contents),
		inputs: inputHashes,
		graphPath,
		graphSha256: hash(readFileSync(graphPath)),
		observation: observation?.finish(),
		authentication: authentication?.finish(),
		builder: { path: import.meta.filename, sha256: hash(readFileSync(import.meta.filename)) },
	});
}
writeFileSync(
	join(destination, "artifacts.json"),
	JSON.stringify({ created: new Date().toISOString(), entries, controllers }, null, 2) + "\n",
	{ flag: "wx" }
);
console.log(JSON.stringify({ destination, entries: names }));

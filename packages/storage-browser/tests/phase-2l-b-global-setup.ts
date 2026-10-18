import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function candidatePlugin(packageDirectory: string): Plugin {
	const candidate = path.join(packageDirectory, "src/issuance.ts");
	const testControl = path.join(packageDirectory, "src/internal/issuance-test-control.ts");
	return {
		name: "phase-2l-b-candidate",
		setup(builder): void {
			builder.onResolve({ filter: /^#phase-2l-b-candidate$/ }, () =>
				fs.existsSync(candidate) ? { path: candidate } : { namespace: "phase-2l-b-absent", path: "candidate" }
			);
			builder.onResolve({ filter: /^#phase-2l-b-test-control$/ }, () =>
				fs.existsSync(testControl) ? { path: testControl } : { namespace: "phase-2l-b-absent", path: "control" }
			);
			builder.onLoad({ filter: /.*/, namespace: "phase-2l-b-absent" }, ({ path: absentPath }) => ({
				contents:
					absentPath === "candidate"
						? `export async function createBrowserDurableIssuanceStore() { const error = new Error("Phase 2l-b candidate absent"); error.code = "PHASE_2L_B_CANDIDATE_ABSENT"; throw error; }`
						: `export async function runBrowserTerminalAmbiguityCase() { return { code: "PHASE_2L_B_TEST_CONTROL_ABSENT", exposedKeys: [] }; }`,
				loader: "js",
			}));
		},
	};
}

/**
 * Bundles one private real-browser RED asset without creating a production seam.
 * @returns Cleanup for the exact generated asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = path.resolve(import.meta.dirname, "..");
	const r8Shared = process.env.PHASE_2L_B_R8_SHARED;
	const r8Main = process.env.PHASE_2L_B_R8_MAIN;
	const archive = process.env.PHASE_2L_B_R8_ARTIFACTS;
	if (r8Shared !== undefined && (r8Main === undefined || archive === undefined))
		throw new Error("R8 requires original MAIN/shared source and owned artifact directory");
	const assetDirectory = fs.mkdtempSync(path.join(archive ?? packageDirectory, ".phase-2l-b-assets-"));
	const sourcePlugin: Plugin = {
		name: "phase-2l-b-r8-current-source",
		setup(builder) {
			builder.onResolve({ filter: /^@ts-drp\// }, ({ path: name }) => {
				if (r8Shared === undefined || r8Main === undefined) return;
				const [pkg, ...subpath] = name.slice("@ts-drp/".length).split("/");
				const base = path.join(pkg === "issuance-store" ? r8Shared : r8Main, "packages", pkg);
				const manifest = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
				const entry = manifest.exports[subpath.length ? "./" + subpath.join("/") : "."];
				const imported = typeof entry === "string" ? entry : entry.import;
				const current = path.join(base, imported.replace("/dist/src/", "/src/").replace(/\.js$/u, ".ts"));
				return { path: current };
			});
			builder.onResolve({ filter: /^\./ }, (args) => {
				if (r8Shared === undefined || !args.path.endsWith(".js") || args.importer.includes("/node_modules/")) return;
				let target = path.resolve(path.dirname(args.importer), args.path).replace(/\.js$/u, ".ts");
				const original = path.join(packageDirectory, "src");
				if (
					r8Main !== undefined &&
					target.startsWith(original + path.sep) &&
					!target.endsWith("/browser-issuance-store.ts") &&
					!target.endsWith("/issuance.ts")
				) {
					const native = path.join(r8Main, "packages/storage-browser/src", path.relative(original, target));
					if (fs.existsSync(native)) target = native;
				}
				return fs.existsSync(target) ? { path: target } : undefined;
			});
		},
	};
	const bundled = await build({
		bundle: true,
		entryPoints:
			r8Shared === undefined
				? {
						"phase-2l-b-browser-death": path.join(packageDirectory, "tests/assets/phase-2l-b-browser-death-entry.ts"),
						"phase-2l-b-browser-death-worker": path.join(
							packageDirectory,
							"tests/assets/phase-2l-b-browser-death-worker.ts"
						),
						"phase-2l-b-browser-issuance": path.join(
							packageDirectory,
							"tests/assets/phase-2l-b-browser-issuance-entry.ts"
						),
					}
				: {
						"phase-2l-b-browser-issuance": path.join(
							packageDirectory,
							"tests/assets/phase-2l-b-browser-issuance-entry.ts"
						),
					},
		format: "esm",
		outdir: assetDirectory,
		platform: "browser",
		plugins: [candidatePlugin(packageDirectory), ...(r8Shared === undefined ? [] : [sourcePlugin])],
		metafile: r8Shared !== undefined,
		target: "es2022",
	});
	await build({
		bundle: true,
		entryPoints: {
			"phase-2l-b-crash-child": path.join(packageDirectory, "tests/process/phase-2l-b-crash-child.ts"),
		},
		format: "esm",
		outdir: assetDirectory,
		packages: "external",
		platform: "node",
		target: "node22",
	});
	fs.writeFileSync(
		path.join(assetDirectory, "phase-2l-b.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2l-b-browser-issuance.js"></script>',
		"utf8"
	);
	fs.writeFileSync(
		path.join(assetDirectory, "phase-2l-b-death.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-2l-b-browser-death.js"></script>',
		"utf8"
	);
	process.env.PHASE_2L_B_ASSET_DIR = assetDirectory;
	if (archive !== undefined && bundled.metafile !== undefined) {
		const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
		const inputs = Object.keys(bundled.metafile.inputs)
			.filter((p) => fs.existsSync(p))
			.map((p) => ({ path: path.resolve(p), sha256: hash(fs.readFileSync(p)) }));
		fs.writeFileSync(
			path.join(archive, "bundle-inputs.json"),
			JSON.stringify(
				{
					assetDirectory,
					inputs,
					bundles: Object.keys(bundled.metafile.outputs).map((p) => ({
						path: path.resolve(p),
						sha256: hash(fs.readFileSync(p)),
					})),
				},
				null,
				2
			)
		);
		fs.writeFileSync(path.join(archive, "metafile.json"), JSON.stringify(bundled.metafile, null, 2));
	}
	if (r8Shared !== undefined) return () => undefined; // Selected evidence assets retained; test server still joins.
	return () => fs.rmSync(assetDirectory, { force: true, recursive: true });
}

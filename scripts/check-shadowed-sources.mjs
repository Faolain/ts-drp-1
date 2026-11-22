/**
 * Compiled output left beside its TypeScript source (for example by an ad hoc
 * `tsc` run against a config without `outDir`) silently replaces that source:
 * esbuild bundles and most resolvers load `./x.js` from disk before trying
 * `./x.ts`, so tests and benchmarks run stale code while typecheck stays green.
 * Refuse to run when any such file exists. Move it out; never commit it.
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = join(import.meta.dirname, "..");
const searchRoots = ["packages", "tests", "examples"];
// What `tsc` emits for each source extension. A hand-written `.mjs` beside a
// `.ts` (as in some committed fixtures) is not emitted output and is allowed.
const emittedFrom = [
	[".d.ts.map", [".ts", ".tsx"]],
	[".js.map", [".ts", ".tsx"]],
	[".d.ts", [".ts", ".tsx"]],
	[".js", [".ts", ".tsx"]],
	[".mjs", [".mts"]],
	[".cjs", [".cts"]],
];

/**
 * Lists compiled files that sit beside the source they were emitted from.
 * @param root - Repository root to scan.
 * @returns Sorted repository-relative paths.
 */
export function findShadowedSources(root = repositoryRoot) {
	const shadowed = [];
	const visit = (directory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
		for (const name of files) {
			const emitted = emittedFrom.find(([suffix]) => name.endsWith(suffix));
			if (emitted === undefined) continue;
			const [suffix, sources] = emitted;
			const stem = name.slice(0, -suffix.length);
			if (sources.some((source) => files.has(stem + source))) shadowed.push(relative(root, join(directory, name)));
		}
		for (const entry of entries) {
			// Hidden directories hold frozen evidence and tool state, not sources.
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist")
				continue;
			visit(join(directory, entry.name));
		}
	};
	for (const searchRoot of searchRoots) visit(join(root, searchRoot));
	return shadowed.sort();
}

/** Vitest global setup: fail the run before any test loads stale output. */
export default function setup() {
	const shadowed = findShadowedSources();
	if (shadowed.length === 0) return;
	const listed = shadowed.slice(0, 20).join("\n  ");
	const more = shadowed.length > 20 ? `\n  ... and ${shadowed.length - 20} more` : "";
	throw new Error(
		`${shadowed.length} compiled file(s) shadow their TypeScript source and would run instead of it:\n  ${listed}${more}\n` +
			"Move them out of the repository (they are build output, not sources)."
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		setup();
	} catch (error) {
		console.error(`[check-shadowed-sources] ${error.message}`);
		process.exit(1);
	}
}

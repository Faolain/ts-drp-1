#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- A plain .mjs build script: its JSDoc carries the types. */
// Refuse a cycle between workspace packages. pnpm cannot order a cycle for
// `pnpm -r build`, so on a fresh clone one side of it compiles before the other
// has emitted its declarations and the postinstall build fails (TS2307). A
// long-lived checkout hides this, because both sides already have a dist/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * The workspace package directories named by pnpm-workspace.yaml. Only the
 * forms this repository uses are supported: `- "<dir>/*"` and `- "!<dir>/<name>"`.
 * @param root - Repository root.
 * @returns Absolute package directories that hold a package.json.
 */
export function workspacePackageDirectories(root) {
	const lines = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split("\n");
	const include = [],
		exclude = new Set();
	for (const line of lines) {
		const match = /^\s*-\s*["']?([^"']+)["']?\s*$/.exec(line);
		if (match === null) continue;
		const pattern = match[1];
		if (pattern.startsWith("!")) exclude.add(path.resolve(root, pattern.slice(1)));
		else if (pattern.endsWith("/*")) include.push(path.resolve(root, pattern.slice(0, -2)));
		else throw new Error(`unsupported pnpm-workspace pattern: ${pattern}`);
	}
	return include.flatMap((parent) =>
		existsSync(parent)
			? readdirSync(parent, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => path.join(parent, entry.name))
					.filter((directory) => !exclude.has(directory) && existsSync(path.join(directory, "package.json")))
			: []
	);
}

/**
 * Every dependency cycle among workspace packages, each as a closed path of names.
 * @param root - Repository root.
 * @returns Cycles (empty when the workspace graph is acyclic).
 */
export function workspaceDependencyCycles(root) {
	const manifests = new Map();
	for (const directory of workspacePackageDirectories(root)) {
		const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
		if (typeof manifest.name === "string") manifests.set(manifest.name, manifest);
	}
	const edges = new Map();
	for (const [name, manifest] of manifests)
		edges.set(
			name,
			[...new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})))]
				.filter((dependency) => dependency !== name && manifests.has(dependency))
				.sort()
		);
	const cycles = [],
		state = new Map(),
		stack = [];
	const visit = (name) => {
		state.set(name, "open");
		stack.push(name);
		for (const next of edges.get(name)) {
			if (state.get(next) === "open") cycles.push([...stack.slice(stack.indexOf(next)), next]);
			else if (!state.has(next)) visit(next);
		}
		stack.pop();
		state.set(name, "done");
	};
	for (const name of [...edges.keys()].sort()) if (!state.has(name)) visit(name);
	return cycles;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const cycles = workspaceDependencyCycles(root);
	if (cycles.length !== 0) {
		for (const cycle of cycles) console.error(`workspace dependency cycle: ${cycle.join(" -> ")}`);
		process.exit(1);
	}
}

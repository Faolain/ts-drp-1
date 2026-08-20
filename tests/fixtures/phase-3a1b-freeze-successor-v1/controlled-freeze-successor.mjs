#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

/** Test-control checker only. It proves the temporary Git harness, never repository conformance. */
import childProcess, { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-only registration used by unique temporary NODE_OPTIONS preload modules.
 * @param rootChildMutation - Exact controlled outcome, or passthrough.
 */
export function registerRootCheckerFault(rootChildMutation = "passthrough") {
	const isRootChecker = (args) =>
		Array.isArray(args) &&
		typeof args[0] === "string" &&
		/(?:protocol-v2\/scripts\/check-protocol-freeze|protocol-v3\/scripts\/check-protocol-v3-freeze)\.mjs$/u.test(
			args[0]
		);
	const mutateBytes = (bytes, text) =>
		typeof bytes === "string" ? `${bytes}${text}` : Buffer.concat([bytes ?? Buffer.alloc(0), Buffer.from(text)]);
	const actualExecFileSync = childProcess.execFileSync;
	const actualSpawnSync = childProcess.spawnSync;
	childProcess.execFileSync = function controlledExecFileSync(file, args, options) {
		const output = actualExecFileSync.call(this, file, args, options);
		if (!isRootChecker(args)) return output;
		if (rootChildMutation === "spoofed-root-stdout") return mutateBytes(output, "generic PASS spoof\n");
		if (rootChildMutation === "extra-root-stdout") return mutateBytes(output, "extra root stdout\n");
		if (
			["root-child-stderr", "root-child-signal", "root-child-timeout", "suppressed-root-exit"].includes(
				rootChildMutation
			)
		) {
			const error = new Error(`controlled root child ${rootChildMutation}`);
			error.code = rootChildMutation === "root-child-timeout" ? "ETIMEDOUT" : "CONTROLLED_ROOT_CHILD";
			error.signal = rootChildMutation === "root-child-signal" ? "SIGTERM" : null;
			error.status = rootChildMutation === "suppressed-root-exit" ? 7 : null;
			error.stderr = Buffer.from(rootChildMutation === "root-child-stderr" ? "unexpected root stderr\n" : "");
			throw error;
		}
		return output;
	};
	childProcess.spawnSync = function controlledSpawnSync(file, args, options) {
		const result = actualSpawnSync.call(this, file, args, options);
		if (!isRootChecker(args)) return result;
		if (rootChildMutation === "spoofed-root-stdout") {
			return { ...result, stdout: mutateBytes(result.stdout, "generic PASS spoof\n") };
		}
		if (rootChildMutation === "extra-root-stdout") {
			return { ...result, stdout: mutateBytes(result.stdout, "extra root stdout\n") };
		}
		if (rootChildMutation === "root-child-stderr") {
			return { ...result, stderr: mutateBytes(result.stderr, "unexpected root stderr\n") };
		}
		if (rootChildMutation === "root-child-signal") return { ...result, signal: "SIGTERM", status: null };
		if (rootChildMutation === "root-child-timeout") {
			return { ...result, error: Object.assign(new Error("controlled timeout"), { code: "ETIMEDOUT" }), status: null };
		}
		if (rootChildMutation === "suppressed-root-exit") return { ...result, status: 7 };
		return result;
	};
	syncBuiltinESMExports();
}

const isMain =
	process.argv[1] !== undefined &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
if (isMain) {
	const root = resolve(process.env.FREEZE_SUCCESSOR_CONTROL_ROOT ?? process.cwd());
	const upstream = process.argv[2];
	const owner = "packages/protocol-v3/conformance/freeze-successor-v1";
	const bundle = ["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"].map(
		(file) => `${owner}/${file}`
	);
	const workflows = Array.from({ length: 5 }, (_, index) => `.github/workflows/control-${index + 1}.yml`);
	const legacy = Array.from({ length: 5 }, (_, index) => `legacy/artifact-${index + 1}.txt`);
	const governed = [...bundle, ...workflows, ...legacy];

	function fail(message) {
		throw new Error(`controlled freeze successor violation: ${message}`);
	}

	function git(...args) {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	}

	function treeEntry(revision, path) {
		const output = git("ls-tree", revision, "--", path);
		if (output === "") return undefined;
		const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40})\t/u.exec(output);
		return match === null ? undefined : { mode: match[1], object: match[3], type: match[2] };
	}

	function treeEntries(revision, paths) {
		const byPath = new Map();
		const output = git("ls-tree", revision, "--", ...paths);
		for (const line of output.split("\n").filter(Boolean)) {
			const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]{40})\t(.+)$/u.exec(line);
			if (match !== null) byPath.set(match[4], { mode: match[1], object: match[3], type: match[2] });
		}
		return paths.map((path) => [path, byPath.get(path)]);
	}

	if (process.argv[2] === "--census") {
		const revision = process.argv[3];
		let inventory;
		try {
			inventory = JSON.parse(process.env.FREEZE_SUCCESSOR_CONTROL_CENSUS_PATHS ?? "null");
		} catch {
			fail("census inventory is not JSON");
		}
		if (
			typeof revision !== "string" ||
			!Array.isArray(inventory) ||
			inventory.length !== 62 ||
			new Set(inventory).size !== 62 ||
			inventory.some((path) => typeof path !== "string" || path === "")
		) {
			fail("census input differs");
		}
		const entries = treeEntries(revision, inventory);
		const present = entries.filter(([, entry]) => entry !== undefined).map(([path]) => path);
		const absent = entries.filter(([, entry]) => entry === undefined).map(([path]) => path);
		writeFileSync(
			1,
			JSON.stringify({
				absent,
				classification: "CONTROLLED_DIAGNOSTIC",
				entries: entries.filter(([, entry]) => entry !== undefined),
				present,
			}) + "\n"
		);
		process.exit(0);
	}

	if (upstream === undefined || !/^[0-9a-f]{40}$/u.test(upstream)) fail("upstream target is not exact");
	const bases = git("merge-base", "--all", upstream, "HEAD").split("\n").filter(Boolean);
	if (bases.length !== 1) fail("merge base is not unique");
	const base = bases[0];
	const parents = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
	let prHead = "HEAD";
	if (parents.length === 3) {
		if (parents[1] !== upstream) fail("merge first parent is not upstream");
		prHead = parents[2];
		for (const path of governed) {
			if (JSON.stringify(treeEntry("HEAD", path)) !== JSON.stringify(treeEntry(prHead, path))) {
				fail(`merge changed governed path: ${path}`);
			}
		}
	} else if (parents.length !== 2) fail("unsupported head topology");

	const baseBundleCount = bundle.filter((path) => treeEntry(base, path) !== undefined).length;
	if (baseBundleCount !== 0 && baseBundleCount !== bundle.length) fail("partial base bundle");
	for (const path of governed) {
		const status = git("status", "--porcelain=v1", "--", path);
		if (status !== "") fail(`dirty governed path: ${path}`);
		const current = treeEntry("HEAD", path);
		if (current === undefined || current.mode !== "100644" || current.type !== "blob") fail(`bad identity: ${path}`);
	}
	if (
		readdirSync(resolve(root, owner)).sort().join("\n") !==
		bundle
			.map((path) => path.slice(owner.length + 1))
			.sort()
			.join("\n")
	) {
		fail("owner inventory differs");
	}
	for (const path of bundle.slice(1))
		if (readFileSync(resolve(root, path), "utf8") !== "controlled\n") fail(`bundle bytes: ${path}`);
	for (const path of workflows)
		if (readFileSync(resolve(root, path), "utf8") !== "successor\n") fail(`workflow bytes: ${path}`);
	for (const path of legacy)
		if (readFileSync(resolve(root, path), "utf8") !== "legacy\n") fail(`legacy bytes: ${path}`);
	if (baseBundleCount === 0) {
		const changed = git("diff", "--name-only", base, prHead, "--", ...governed)
			.split("\n")
			.filter(Boolean)
			.sort();
		const expected = [...bundle, ...workflows].sort();
		if (JSON.stringify(changed) !== JSON.stringify(expected)) fail("bootstrap path set differs");
		const commits = git("log", "--format=%H", `${base}..${prHead}`, "--", ...governed)
			.split("\n")
			.filter(Boolean);
		if (new Set(commits).size !== 1) fail("bootstrap is not one commit");
		if (git("rev-list", "--parents", "-n", "1", commits[0]).split(" ").length !== 2) fail("bootstrap is a merge");
	} else {
		if (git("diff", "--name-only", base, prHead, "--", ...governed) !== "") fail("descendant drift");
	}
	for (const path of bundle) {
		if (!existsSync(resolve(root, path)) || !lstatSync(resolve(root, path)).isFile())
			fail(`irregular bundle path: ${path}`);
	}
	console.log("controlled freeze successor: PASS");
}

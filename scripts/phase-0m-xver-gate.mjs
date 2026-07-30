/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REFERENCE_SHA = "1d40885ffb2ab666ffb2817a99fe69a42af83e77";
const EXPECTED_COMPARISONS = 108;
const EXPECTED_SCHEDULE_COUNT = 18;
const ACCEPTANCE_TEST = "^Phase 0m authenticated fixed-corpus acceptance$";
const REQUIRED_PNPM_VERSION = "10.24.0";
const ACCEPTANCE_SUMMARY_MARKER = "XVER_ACCEPTANCE_SUMMARY";
const EXPECTED_FIXTURES = [
	"fixed-three-vertex-noncanonical-cut",
	"fixed-four-vertex-incomplete-tail",
	"fixed-four-vertex-cross-group-authority-chain",
	"fixed-held-group-coupling-regression",
	"fixed-same-group-pair-with-descendant",
	"fixed-three-way-held-group-attribution",
	"fixed-admin-revoke-group-the-target-does-not-hold",
	"fixed-critical-1-cross-type-acl-drop",
	"fixed-critical-2-transitive-join-with-two-children",
];
const EXPECTED_SURFACES = [
	"drp-state",
	"acl-state",
	"admission",
	"engine-authored-vertex-hashes",
	"raw-hash-membership",
	"raw-hash-order",
];
const ACCEPTANCE_SUMMARY_KEYS = [
	"referenceSha",
	"primarySha",
	"primaryArtifactSha256",
	"referenceArtifactSha256",
	"primaryRuntimeClosureSha256",
	"referenceRuntimeClosureSha256",
	"fixtures",
	"scheduleCount",
	"surfaces",
	"comparisons",
	"mapFixtures",
	"approvedDeltaCount",
].sort();
const ACCEPTANCE_EVIDENCE_FIELDS = [
	"primaryArtifactSha256",
	"referenceArtifactSha256",
	"primaryRuntimeClosureSha256",
	"referenceRuntimeClosureSha256",
];
const DESCRIPTOR = {
	referenceSha: REFERENCE_SHA,
	failClosed: true,
	freshDetachedWorktree: true,
	buildsReferenceInsideWorktree: true,
	authenticatesReferenceArtifact: true,
	authenticatesPrimaryArtifact: true,
	authenticatesRuntimeClosure: true,
	excludesLogsFromVitestDiscovery: true,
	acceptance: {
		testName: "Phase 0m authenticated fixed-corpus acceptance",
		comparisons: EXPECTED_COMPARISONS,
	},
};
const PLAN = {
	referenceSha: REFERENCE_SHA,
	steps: [
		"resolve-primary-head",
		"create-fresh-detached-reference-worktree",
		"install-reference-from-frozen-lockfile",
		"build-primary-inside-primary-worktree",
		"build-reference-inside-reference-worktree",
		"authenticate-primary-artifact",
		"authenticate-reference-artifact",
		"authenticate-reference-runtime-closure",
		"run-108-cell-acceptance",
		"validate-authenticated-acceptance-summary",
		"remove-reference-worktree",
	],
};
const BUILD_PACKAGES = [
	{ directory: "packages/types", bundle: true },
	{ directory: "packages/utils", bundle: true },
	{ directory: "packages/logger", bundle: true },
	{ directory: "packages/tracer", bundle: true },
	{ directory: "packages/validation", bundle: true },
	{ directory: "packages/blueprints", bundle: true },
	{ directory: "packages/keychain", bundle: true },
	{ directory: "packages/test-utils", bundle: false },
	{ directory: "packages/object", bundle: false },
];

function fail(message) {
	throw new Error(message);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		timeout: options.timeout ?? 60_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) fail(`${command} failed to start: ${result.error.message}`);
	if (result.status !== 0) {
		fail(
			`${command} ${args.join(" ")} exited ${String(result.status)}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
		);
	}
	if (options.forwardOutput) {
		process.stdout.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
	}
	return result.stdout.trim();
}

function git(cwd, args, options = {}) {
	return run("git", args, { cwd, ...options });
}

function inside(root, candidate) {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function assertCleanSourceProvenance(worktree, label) {
	const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=no"]);
	if (status !== "") fail(`${label} tracked source is not clean:\n${status}`);
	const untrackedBuildInputs = git(worktree, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"--",
		...BUILD_PACKAGES.map((entry) => entry.directory),
	]);
	if (untrackedBuildInputs !== "") {
		fail(`${label} has untracked build inputs:\n${untrackedBuildInputs}`);
	}
}

function assertExpectedHead(worktree, expected, label) {
	const actual = git(worktree, ["rev-parse", "HEAD"]);
	if (actual !== expected) fail(`${label} HEAD mismatch: expected=${expected} actual=${actual}`);
}

function assertSafeBuildDirectory(worktree, path) {
	const packagesRoot = resolve(worktree, "packages");
	if (!inside(packagesRoot, path) || basename(path) !== "dist") {
		fail(`refusing unsafe build-output path: ${path}`);
	}
}

function buildWorkspaceEngine(worktree) {
	for (const entry of BUILD_PACKAGES) {
		const packageRoot = resolve(worktree, entry.directory);
		const output = resolve(packageRoot, "dist");
		assertSafeBuildDirectory(worktree, output);
		rmSync(output, { recursive: true, force: true });
		run("pnpm", ["--dir", packageRoot, "exec", "tsc", "-b", "tsconfig.build.json", "--force"], {
			cwd: worktree,
			timeout: 120_000,
		});
		if (entry.bundle) run(process.execPath, ["build.mjs"], { cwd: packageRoot, timeout: 120_000 });
	}
}

function runtimeFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.flatMap((entry) => {
			const path = resolve(directory, entry);
			return statSync(path).isDirectory() ? runtimeFiles(path) : [path];
		})
		.filter((path) => !path.endsWith(".map") && !path.endsWith(".tsbuildinfo"))
		.sort();
}

function nearestPackageManifest(entry, worktree) {
	let directory = dirname(entry);
	while (inside(worktree, directory)) {
		const manifest = resolve(directory, "package.json");
		if (existsSync(manifest)) return manifest;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return fail(`${entry} has no package manifest inside ${worktree}`);
}

function authenticateRuntimeClosure(objectModule, worktree) {
	const checked = new Map();
	const visit = (manifestPath) => {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const packageName = typeof manifest.name === "string" ? manifest.name : manifestPath;
		if (checked.has(packageName)) return;
		checked.set(packageName, manifestPath);
		for (const dependency of Object.keys(manifest.dependencies ?? {})) {
			if (!dependency.startsWith("@ts-drp/")) continue;
			const dependencyRoot = realpathSync(resolve(dirname(manifestPath), "node_modules", dependency));
			if (!inside(worktree, dependencyRoot)) {
				fail(`${dependency} resolved outside ${worktree}: ${dependencyRoot}`);
			}
			visit(resolve(dependencyRoot, "package.json"));
		}
	};
	visit(nearestPackageManifest(objectModule, worktree));
	const digest = createHash("sha256");
	for (const [packageName, manifestPath] of [...checked].sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0
	)) {
		const packageRoot = dirname(manifestPath);
		for (const path of [manifestPath, ...runtimeFiles(resolve(packageRoot, "dist"))]) {
			digest
				.update(`${packageName}/${relative(packageRoot, path)}`)
				.update("\0")
				.update(readFileSync(path))
				.update("\0");
		}
	}
	return digest.digest("hex");
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertDigestUnchanged(label, expected, actual) {
	if (actual !== expected) fail(`${label} changed during acceptance: expected=${expected} actual=${actual}`);
}

function sameOrderedStrings(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((entry, index) => entry === expected[index])
	);
}

/**
 * Authenticate the sole machine-readable acceptance record emitted by the
 * filtered Vitest child. This is intentionally independent of Vitest's exit
 * status because a filter matching zero tests exits successfully.
 * @param output Captured child stdout.
 * @param expected Live runner-computed provenance.
 * @returns The authenticated acceptance summary.
 */
export function validateAcceptanceOutput(output, expected) {
	if (typeof output !== "string") fail("XVER_ACCEPTANCE_SUMMARY_JSON output must be a string");
	if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
		fail("XVER_ACCEPTANCE_SUMMARY_EVIDENCE expected live runner evidence");
	}
	const markerCount = output.split(ACCEPTANCE_SUMMARY_MARKER).length - 1;
	if (markerCount === 0) {
		fail("XVER_ACCEPTANCE_SUMMARY_REQUIRED expected=1 actual=0");
	}
	if (markerCount !== 1) {
		fail(`XVER_ACCEPTANCE_SUMMARY_COUNT expected=1 actual=${markerCount}`);
	}
	const summaryLine = output.split(/\r?\n/).find((line) => line.startsWith(`${ACCEPTANCE_SUMMARY_MARKER} `));
	if (!summaryLine) fail("XVER_ACCEPTANCE_SUMMARY_JSON marker must precede one JSON object");
	let summary;
	try {
		summary = JSON.parse(summaryLine.slice(ACCEPTANCE_SUMMARY_MARKER.length + 1));
	} catch {
		return fail("XVER_ACCEPTANCE_SUMMARY_JSON invalid JSON object");
	}
	if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
		fail("XVER_ACCEPTANCE_SUMMARY_JSON expected an object");
	}
	if (
		!Array.isArray(summary.mapFixtures) ||
		summary.mapFixtures.length === 0 ||
		summary.mapFixtures.some((fixture) => typeof fixture !== "string" || !EXPECTED_FIXTURES.includes(fixture))
	) {
		fail("XVER_ACCEPTANCE_SUMMARY_MAP_FIXTURES expected a non-empty subset of the acceptance corpus");
	}
	const actualKeys = Object.keys(summary).sort();
	if (!sameOrderedStrings(actualKeys, ACCEPTANCE_SUMMARY_KEYS)) {
		fail("XVER_ACCEPTANCE_SUMMARY_JSON expected the exact acceptance summary schema");
	}
	if (summary.referenceSha !== expected.referenceSha) {
		fail(
			`XVER_ACCEPTANCE_SUMMARY_REFERENCE_SHA actual=${String(summary.referenceSha)} expected=${String(expected.referenceSha)}`
		);
	}
	if (summary.primarySha !== expected.primarySha) {
		fail(
			`XVER_ACCEPTANCE_SUMMARY_PRIMARY_SHA actual=${String(summary.primarySha)} expected=${String(expected.primarySha)}`
		);
	}
	if (!sameOrderedStrings(summary.fixtures, EXPECTED_FIXTURES)) {
		fail("XVER_ACCEPTANCE_SUMMARY_FIXTURES expected the exact ordered nine-fixture corpus");
	}
	if (summary.scheduleCount !== EXPECTED_SCHEDULE_COUNT) {
		fail(
			`XVER_ACCEPTANCE_SUMMARY_SCHEDULE_COUNT expected=${EXPECTED_SCHEDULE_COUNT} actual=${String(summary.scheduleCount)}`
		);
	}
	if (!sameOrderedStrings(summary.surfaces, EXPECTED_SURFACES)) {
		fail("XVER_ACCEPTANCE_SUMMARY_SURFACES expected the exact ordered six-surface contract");
	}
	if (summary.comparisons !== EXPECTED_COMPARISONS) {
		fail(`XVER_ACCEPTANCE_SUMMARY_COMPARISONS expected=${EXPECTED_COMPARISONS} actual=${String(summary.comparisons)}`);
	}
	if (summary.approvedDeltaCount !== 0) {
		fail(`XVER_ACCEPTANCE_SUMMARY_APPROVED_DELTAS expected=0 actual=${String(summary.approvedDeltaCount)}`);
	}
	for (const field of ACCEPTANCE_EVIDENCE_FIELDS) {
		const actual = summary[field];
		const authenticated = expected[field];
		if (
			typeof actual !== "string" ||
			!/^[0-9a-f]{64}$/.test(actual) ||
			typeof authenticated !== "string" ||
			!/^[0-9a-f]{64}$/.test(authenticated)
		) {
			fail(`XVER_ACCEPTANCE_SUMMARY_EVIDENCE ${field} must be 64-character lowercase hex`);
		}
		if (actual !== authenticated) {
			fail(`XVER_ACCEPTANCE_SUMMARY_EVIDENCE ${field} mismatch`);
		}
	}
	return summary;
}

function validateCli() {
	if (process.argv.length === 2) return "run";
	if (process.argv.length !== 3) {
		fail("usage: phase-0m-xver-gate.mjs [--describe-contract|--plan|--validate-acceptance-output]");
	}
	const argument = process.argv[2];
	if (argument === "--describe-contract") return "describe";
	if (argument === "--plan") return "plan";
	if (argument === "--validate-acceptance-output") return "validate";
	return fail(`unknown argument: ${argument}`);
}

const invokedAsMain =
	process.argv[1] !== undefined &&
	realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
const mode = invokedAsMain ? validateCli() : "import";
if (mode === "import") {
	// Importers consume the pure validator without starting the hermetic gate.
} else if (mode === "describe") {
	process.stdout.write(`${JSON.stringify(DESCRIPTOR)}\n`);
} else if (mode === "plan") {
	process.stdout.write(`${JSON.stringify(PLAN)}\n`);
} else if (mode === "validate") {
	const envelope = JSON.parse(readFileSync(0, "utf8"));
	validateAcceptanceOutput(envelope.output, envelope.expected);
} else {
	const scriptPath = realpathSync(fileURLToPath(import.meta.url));
	const repositoryRoot = realpathSync(resolve(dirname(scriptPath), ".."));
	const gitRoot = realpathSync(git(repositoryRoot, ["rev-parse", "--show-toplevel"]));
	if (gitRoot !== repositoryRoot) fail(`runner is outside repository root: ${scriptPath}`);
	if (Number(process.versions.node.split(".")[0]) !== 22) {
		fail(`Node 22 is required, received ${process.versions.node}`);
	}
	const pnpmVersion = run("pnpm", ["--version"], { cwd: repositoryRoot });
	if (pnpmVersion !== REQUIRED_PNPM_VERSION) {
		fail(`pnpm ${REQUIRED_PNPM_VERSION} is required, received ${pnpmVersion}`);
	}
	const vitestEntry = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
	if (!existsSync(vitestEntry)) fail("primary dependencies are absent; run pnpm install --frozen-lockfile first");

	let temporaryRoot;
	let referenceWorktree;
	let registeredWorktree = false;
	let gateError;
	try {
		assertCleanSourceProvenance(repositoryRoot, "primary");
		const primarySha = git(repositoryRoot, ["rev-parse", "HEAD"]);
		temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-drp-phase-0m-xver-")));
		referenceWorktree = resolve(temporaryRoot, "reference");
		if (dirname(referenceWorktree) !== temporaryRoot || existsSync(referenceWorktree)) {
			fail(`refusing unresolved reference worktree target: ${referenceWorktree}`);
		}
		git(repositoryRoot, ["worktree", "add", "--detach", referenceWorktree, REFERENCE_SHA], {
			timeout: 30_000,
		});
		registeredWorktree = true;
		assertExpectedHead(referenceWorktree, REFERENCE_SHA, "reference");
		if (git(referenceWorktree, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "HEAD") {
			fail("reference worktree is not detached");
		}
		assertCleanSourceProvenance(referenceWorktree, "reference");

		run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], {
			cwd: referenceWorktree,
			timeout: 240_000,
		});
		buildWorkspaceEngine(repositoryRoot);
		assertExpectedHead(repositoryRoot, primarySha, "primary");
		assertCleanSourceProvenance(repositoryRoot, "primary");
		buildWorkspaceEngine(referenceWorktree);
		assertExpectedHead(referenceWorktree, REFERENCE_SHA, "reference");
		assertCleanSourceProvenance(referenceWorktree, "reference");

		const primaryObjectModule = realpathSync(resolve(repositoryRoot, "packages/object/dist/src/index.js"));
		const referenceObjectModule = realpathSync(resolve(referenceWorktree, "packages/object/dist/src/index.js"));
		if (!inside(repositoryRoot, primaryObjectModule)) fail("primary artifact escaped its worktree");
		if (!inside(referenceWorktree, referenceObjectModule)) fail("reference artifact escaped its worktree");
		const primaryArtifactSha256 = sha256File(primaryObjectModule);
		const referenceArtifactSha256 = sha256File(referenceObjectModule);
		const primaryRuntimeClosureSha256 = authenticateRuntimeClosure(primaryObjectModule, repositoryRoot);
		const referenceRuntimeClosureSha256 = authenticateRuntimeClosure(referenceObjectModule, referenceWorktree);

		const environment = {
			...process.env,
			FORCE_COLOR: "0",
			TS_DRP_XVER: "1",
			TS_DRP_XVER_ORACLE_SHA: REFERENCE_SHA,
			TS_DRP_XVER_ORACLE_WORKTREE: referenceWorktree,
			TS_DRP_XVER_ORACLE_OBJECT_MODULE: referenceObjectModule,
			TS_DRP_XVER_PRIMARY_OBJECT_MODULE: primaryObjectModule,
			TS_DRP_XVER_EXPECTED_COMPARISONS: String(EXPECTED_COMPARISONS),
			TS_DRP_XVER_DELTA_MANIFEST: resolve(
				repositoryRoot,
				"packages/object/tests/fixtures/phase-0m-xver/empty-delta-manifest.json"
			),
			TS_DRP_XVER_PRIMARY_SHA: primarySha,
			TS_DRP_XVER_PRIMARY_WORKTREE: repositoryRoot,
			TS_DRP_XVER_PRIMARY_ARTIFACT_SHA256: primaryArtifactSha256,
			TS_DRP_XVER_REFERENCE_ARTIFACT_SHA256: referenceArtifactSha256,
			TS_DRP_XVER_PRIMARY_RUNTIME_CLOSURE_SHA256: primaryRuntimeClosureSha256,
			TS_DRP_XVER_REFERENCE_RUNTIME_CLOSURE_SHA256: referenceRuntimeClosureSha256,
		};
		const acceptanceOutput = run(
			process.execPath,
			[
				vitestEntry,
				"run",
				resolve(repositoryRoot, "packages/object/tests/proptest/convergence-differential.test.ts"),
				"-t",
				ACCEPTANCE_TEST,
				"--reporter=dot",
				"--coverage.enabled=false",
				"--exclude=.logs/**",
				"--maxWorkers=1",
				"--fileParallelism=false",
			],
			{ cwd: repositoryRoot, env: environment, timeout: 180_000, forwardOutput: true }
		);
		validateAcceptanceOutput(acceptanceOutput, {
			referenceSha: REFERENCE_SHA,
			primarySha,
			primaryArtifactSha256,
			referenceArtifactSha256,
			primaryRuntimeClosureSha256,
			referenceRuntimeClosureSha256,
		});
		assertDigestUnchanged("primary artifact", primaryArtifactSha256, sha256File(primaryObjectModule));
		assertDigestUnchanged("reference artifact", referenceArtifactSha256, sha256File(referenceObjectModule));
		assertDigestUnchanged(
			"primary runtime closure",
			primaryRuntimeClosureSha256,
			authenticateRuntimeClosure(primaryObjectModule, repositoryRoot)
		);
		assertDigestUnchanged(
			"reference runtime closure",
			referenceRuntimeClosureSha256,
			authenticateRuntimeClosure(referenceObjectModule, referenceWorktree)
		);
		assertCleanSourceProvenance(repositoryRoot, "primary");
		assertCleanSourceProvenance(referenceWorktree, "reference");
	} catch (error) {
		gateError = error;
	} finally {
		if (registeredWorktree && referenceWorktree) {
			const removal = spawnSync("git", ["worktree", "remove", "--force", referenceWorktree], {
				cwd: repositoryRoot,
				encoding: "utf8",
				timeout: 30_000,
			});
			if (removal.status === 0) {
				registeredWorktree = false;
			} else if (!gateError) {
				gateError = new Error(`reference worktree cleanup failed: ${removal.stderr}`);
			}
		}
		if (temporaryRoot && !registeredWorktree) {
			const resolvedTemporaryRoot = temporaryRoot;
			if (
				dirname(resolvedTemporaryRoot) === realpathSync(tmpdir()) &&
				basename(resolvedTemporaryRoot).startsWith("ts-drp-phase-0m-xver-")
			) {
				rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
			} else if (!gateError) {
				gateError = new Error(`refusing unsafe temporary cleanup target: ${resolvedTemporaryRoot}`);
			}
		}
	}
	if (gateError) {
		process.stderr.write(
			`PHASE_0M_XVER_GATE_FAILURE ${gateError instanceof Error ? gateError.message : String(gateError)}\n`
		);
		process.exitCode = 1;
	}
}

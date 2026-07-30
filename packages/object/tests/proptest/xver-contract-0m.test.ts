import { MapDRP, SetDRP } from "@ts-drp/blueprints";
import { DrpType, Operation } from "@ts-drp/types";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

const REFERENCE_SHA = "1d40885ffb2ab666ffb2817a99fe69a42af83e77";
const GATE0_REFERENCE_SHA = "7f9e66adeb8cb919910827893ad6220a5aff323b";
const SELECTED_FIXTURE = "fixed-three-vertex-noncanonical-cut$";
const GATE0_APPROVED_FIXTURE = "fixed-admin-revoke-group-the-target-does-not-hold$";
const XVER_SURFACES = [
	"drp-state",
	"acl-state",
	"admission",
	"engine-authored-vertex-hashes",
	"raw-hash-membership",
	"raw-hash-order",
] as const;
const EXPECTED_COMPARISONS = String(XVER_SURFACES.length);
const ACCEPTANCE_FIXTURES = [
	"fixed-three-vertex-noncanonical-cut",
	"fixed-four-vertex-incomplete-tail",
	"fixed-four-vertex-cross-group-authority-chain",
	"fixed-held-group-coupling-regression",
	"fixed-same-group-pair-with-descendant",
	"fixed-three-way-held-group-attribution",
	"fixed-admin-revoke-group-the-target-does-not-hold",
	"fixed-critical-1-cross-type-acl-drop",
	"fixed-critical-2-transitive-join-with-two-children",
] as const;
const ACCEPTANCE_FIXTURE_COUNT = 9;
const ACCEPTANCE_SCHEDULE_COUNT = 18;
const ACCEPTANCE_COMPARISON_COUNT = 108;
const ACCEPTANCE_TEST = "^Phase 0m authenticated fixed-corpus acceptance$";
const RUNNER_PATH = "scripts/phase-0m-xver-gate.mjs";
const WORKFLOW_PATH = ".github/workflows/phase-0m-xver.yml";
const GATE_TRIGGER_PATHS = [
	"packages/object/**",
	"packages/validation/**",
	"packages/object/tests/proptest/convergence-differential.test.ts",
	"packages/object/tests/proptest/xver-contract-0m.test.ts",
	RUNNER_PATH,
	WORKFLOW_PATH,
	"pnpm-lock.yaml",
] as const;
const acceptanceRequested = process.env.PHASE_0M_XVER_ACCEPTANCE === "1";
const XVER_ENVIRONMENT_KEYS = [
	"TS_DRP_XVER",
	"TS_DRP_XVER_ORACLE_SHA",
	"TS_DRP_XVER_ORACLE_WORKTREE",
	"TS_DRP_XVER_ORACLE_OBJECT_MODULE",
	"TS_DRP_XVER_PRIMARY_OBJECT_MODULE",
	"TS_DRP_XVER_EXPECTED_COMPARISONS",
	"TS_DRP_XVER_DELTA_MANIFEST",
] as const;

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const vitestEntry = fileURLToPath(new URL("../../../../node_modules/vitest/vitest.mjs", import.meta.url));
const differentialTest = fileURLToPath(new URL("./convergence-differential.test.ts", import.meta.url));
const fixtureRoot = new URL("../fixtures/phase-0m-xver/", import.meta.url);
const emptyManifest = fileURLToPath(new URL("empty-delta-manifest.json", fixtureRoot));
const staleManifest = fileURLToPath(new URL("stale-delta-manifest.json", fixtureRoot));
const outcomeDivergentEngine = fileURLToPath(new URL("outcome-divergent-engine.mjs", fixtureRoot));
const hashDivergentEngine = fileURLToPath(new URL("hash-divergent-engine.mjs", fixtureRoot));
const mapLocalHashDivergentEngine = fileURLToPath(new URL("map-local-hash-divergent-engine.mjs", fixtureRoot));
const multiFixtureStaleManifest = fileURLToPath(new URL("multi-fixture-stale-delta-manifest.json", fixtureRoot));
const multiFixtureDuplicateManifest = fileURLToPath(
	new URL("multi-fixture-duplicate-delta-manifest.json", fixtureRoot)
);
const runnerWorkflowContract = fileURLToPath(new URL("runner-workflow-contract.json", fixtureRoot));
const currentObjectModule = fileURLToPath(new URL("../../dist/src/index.js", import.meta.url));
const currentHead = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: repositoryRoot,
	encoding: "utf8",
}).stdout.trim();
const pinnedWorktree = process.env.PHASE_0M_XVER_PINNED_WORKTREE;
const pinnedObjectModule = pinnedWorktree
	? fileURLToPath(new URL("packages/object/dist/src/index.js", new URL(`file://${pinnedWorktree}/`)))
	: undefined;

interface GateRun {
	status: number | null;
	output: string;
}

interface AcceptanceSummary {
	referenceSha: string;
	primarySha: string;
	primaryArtifactSha256: string;
	referenceArtifactSha256: string;
	referenceRuntimeClosureSha256: string;
	fixtures: string[];
	scheduleCount: number;
	surfaces: string[];
	comparisons: number;
	mapFixtures: string[];
	approvedDeltaCount: number;
}

function runDifferential(
	overrides: Readonly<Record<string, string | undefined>> = {},
	selectedFixture = SELECTED_FIXTURE
): GateRun {
	const environment: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
	for (const key of XVER_ENVIRONMENT_KEYS) delete environment[key];
	delete environment.TS_DRP_BASELINE_OBJECT_MODULE;
	delete environment.TS_DRP_PRIMARY_OBJECT_MODULE;
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete environment[key];
		else environment[key] = value;
	}
	const result = spawnSync(
		process.execPath,
		[
			vitestEntry,
			"run",
			differentialTest,
			"-t",
			selectedFixture,
			"--reporter=dot",
			"--coverage.enabled=false",
			"--exclude=.logs/**",
		],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
			env: environment,
			timeout: 20_000,
		}
	);
	return {
		status: result.status,
		output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
	};
}

function xverEnvironment(
	overrides: Readonly<Record<string, string | undefined>> = {}
): Record<string, string | undefined> {
	return {
		TS_DRP_XVER: "1",
		TS_DRP_XVER_ORACLE_SHA: REFERENCE_SHA,
		TS_DRP_XVER_ORACLE_WORKTREE: pinnedWorktree ?? repositoryRoot,
		TS_DRP_XVER_ORACLE_OBJECT_MODULE: pinnedObjectModule ?? currentObjectModule,
		TS_DRP_XVER_EXPECTED_COMPARISONS: EXPECTED_COMPARISONS,
		TS_DRP_XVER_DELTA_MANIFEST: emptyManifest,
		...overrides,
	};
}

function acceptanceEnvironment(
	overrides: Readonly<Record<string, string | undefined>> = {}
): Record<string, string | undefined> {
	return xverEnvironment({
		TS_DRP_XVER_EXPECTED_COMPARISONS: String(ACCEPTANCE_COMPARISON_COUNT),
		...overrides,
	});
}

function runAcceptance(overrides: Readonly<Record<string, string | undefined>> = {}): GateRun {
	return runDifferential(acceptanceEnvironment(overrides), ACCEPTANCE_TEST);
}

function runHermeticGate(args: readonly string[] = []): GateRun {
	const result = spawnSync(process.execPath, [resolve(repositoryRoot, RUNNER_PATH), ...args], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: { ...process.env, FORCE_COLOR: "0" },
		timeout: 600_000,
	});
	return {
		status: result.status,
		output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
	};
}

function readAcceptanceSummary(run: GateRun): AcceptanceSummary {
	const match = /XVER_ACCEPTANCE_SUMMARY\s+(\{[^\n]+\})/.exec(run.output);
	expect(match, run.output).not.toBeNull();
	return JSON.parse(match?.[1] ?? "{}") as AcceptanceSummary;
}

function expectAuthenticatedCorpusSummary(run: GateRun): void {
	expect(run.status, run.output).toBe(0);
	const summary = readAcceptanceSummary(run);
	expect(summary).toMatchObject({
		referenceSha: REFERENCE_SHA,
		primarySha: currentHead,
		fixtures: [...ACCEPTANCE_FIXTURES],
		scheduleCount: ACCEPTANCE_SCHEDULE_COUNT,
		surfaces: [...XVER_SURFACES],
		comparisons: ACCEPTANCE_COMPARISON_COUNT,
		mapFixtures: expect.arrayContaining([expect.any(String)]),
		approvedDeltaCount: 0,
	});
	expect(summary.primaryArtifactSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(summary.referenceArtifactSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(summary.referenceRuntimeClosureSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(summary.mapFixtures.every((fixture) => ACCEPTANCE_FIXTURES.includes(fixture as never))).toBe(true);
}

function expectCausalFailure(run: GateRun, diagnostic: RegExp): void {
	const singleLineOutput = run.output.replace(/\n/g, " ");
	expect(
		{
			exit: run.status,
			diagnostic: diagnostic.test(singleLineOutput),
			moduleResolutionFailure: /Cannot find module|ERR_MODULE_NOT_FOUND/.test(run.output),
		},
		run.output
	).toEqual({
		exit: 1,
		diagnostic: true,
		moduleResolutionFailure: false,
	});
}

describe("Phase 0m XVER positive controls", () => {
	it("executes the selected Gate-0 fixture and keeps the no-oracle legacy mode green", () => {
		const run = runDifferential();
		expect(run.status, run.output).toBe(0);
		expect(run.output).toMatch(/1 passed \| 12 skipped/);
	});

	it("loads both deliberately divergent engine controls", async () => {
		const outcomeControl = await import(new URL("outcome-divergent-engine.mjs", fixtureRoot).href);
		const hashControl = await import(new URL("hash-divergent-engine.mjs", fixtureRoot).href);
		expect(typeof outcomeControl.DRPObject).toBe("function");
		expect(typeof outcomeControl.createVertex).toBe("function");
		expect(typeof hashControl.DRPObject).toBe("function");
		expect(typeof hashControl.createVertex).toBe("function");
		const operation = Operation.create({ drpType: DrpType.DRP, opType: "add", value: ["control"] });
		const referenceVertex = outcomeControl.createVertex("writer-a", operation, ["root"], 1);
		const divergentVertex = hashControl.createVertex("writer-a", operation, ["root"], 1);
		expect(divergentVertex.hash).not.toBe(referenceVertex.hash);

		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			const referenceObject = new outcomeControl.DRPObject({
				peerId: "writer-a",
				id: "writer-a:phase-0m-local-hash-control",
				acl: outcomeControl.createPermissionlessACL("writer-a"),
				drp: new SetDRP(),
				config: { log_config: { level: "silent" } },
			});
			const divergentObject = new hashControl.DRPObject({
				peerId: "writer-a",
				id: "writer-a:phase-0m-local-hash-control",
				acl: hashControl.createPermissionlessACL("writer-a"),
				drp: new SetDRP(),
				config: { log_config: { level: "silent" } },
			});
			await referenceObject.drp.add("local-control");
			await divergentObject.drp.add("local-control");
			const referenceLocalHash = referenceObject.vertices.at(-1)?.hash;
			const divergentLocalHash = divergentObject.vertices.at(-1)?.hash;
			expect(referenceLocalHash).toBeDefined();
			expect(divergentLocalHash?.slice(1)).toBe(referenceLocalHash?.slice(1));
			expect(divergentLocalHash?.[0]).not.toBe(referenceLocalHash?.[0]);
		} finally {
			now.mockRestore();
		}
	});

	it("proves the kind-correct Map.set local-hash control reaches engine-local authoring", async () => {
		const reference = await import(currentObjectModule);
		const divergent = await import(new URL("map-local-hash-divergent-engine.mjs", fixtureRoot).href);
		type LocalMapObject = {
			drp: { set(key: unknown, value: unknown): Promise<unknown> };
			vertices: { hash: string }[];
		};
		const makeMapObject = (engine: typeof reference): LocalMapObject =>
			new engine.DRPObject({
				peerId: "writer-a",
				id: "writer-a:phase-0m-map-local-hash-control",
				acl: engine.createPermissionlessACL("writer-a"),
				drp: new MapDRP<unknown, unknown>(),
				config: { log_config: { level: "silent" } },
			}) as unknown as LocalMapObject;
		const referenceObject = makeMapObject(reference);
		const divergentObject = makeMapObject(divergent);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_730_000_000_000);
		try {
			await referenceObject.drp.set("map-key", "map-value");
			await divergentObject.drp.set("map-key", "map-value");
		} finally {
			now.mockRestore();
		}
		const referenceHash = referenceObject.vertices.at(-1)?.hash;
		const divergentHash = divergentObject.vertices.at(-1)?.hash;
		expect(referenceHash).toBeDefined();
		expect(divergentHash?.slice(1)).toBe(referenceHash?.slice(1));
		expect(divergentHash?.[0]).not.toBe(referenceHash?.[0]);
	});

	it("proves existing Gate-0 detects the outcome-divergent control for a comparison dimension", () => {
		const run = runDifferential({
			TS_DRP_BASELINE_OBJECT_MODULE: outcomeDivergentEngine,
		});
		expect(run.status, run.output).toBe(1);
		expect(run.output).toMatch(/graph-membership|admission|drp-state/);
		expect(run.output).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
	});

	it("keeps the XVER delta manifest an exact, isolated, initially-empty tuple", () => {
		const manifest = JSON.parse(readFileSync(emptyManifest, "utf8")) as unknown;
		expect(manifest).toEqual({
			schemaVersion: "phase-0m-xver-delta-v1",
			referenceSha: REFERENCE_SHA,
			deltas: [],
		});
		expect(JSON.stringify(manifest)).not.toMatch(
			/approvedBaselineDivergence|dependency-shape|deterministic-acl-admission|7f9e66a|predicate|category/
		);
	});

	it("pins the hermetic gate's minimal observable runner/workflow contract", () => {
		const contract = JSON.parse(readFileSync(runnerWorkflowContract, "utf8")) as unknown;
		expect(contract).toEqual({
			schemaVersion: "phase-0m-xver-runner-v1",
			referenceSha: REFERENCE_SHA,
			runner: RUNNER_PATH,
			workflow: WORKFLOW_PATH,
			acceptanceTest: "Phase 0m authenticated fixed-corpus acceptance",
			corpus: {
				fixtureCount: ACCEPTANCE_FIXTURE_COUNT,
				scheduleCount: ACCEPTANCE_SCHEDULE_COUNT,
				surfaceCount: XVER_SURFACES.length,
				comparisonCount: ACCEPTANCE_COMPARISON_COUNT,
				requiresMapFixture: true,
			},
			triggerPaths: [...GATE_TRIGGER_PATHS],
		});
	});
});

describe("Phase 0m XVER fail-closed oracle contract", () => {
	it("fails rather than passing or skipping when the exact oracle tuple is unset", () => {
		const run = runDifferential({ TS_DRP_XVER: "1" });
		expectCausalFailure(run, /XVER_ORACLE_REQUIRED.*1d40885ffb2ab666ffb2817a99fe69a42af83e77/);
	});

	it("rejects a present but mismatched oracle SHA before comparisons", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_ORACLE_SHA: GATE0_REFERENCE_SHA,
			})
		);
		expectCausalFailure(
			run,
			/XVER_ORACLE_SHA_MISMATCH.*7f9e66adeb8cb919910827893ad6220a5aff323b.*1d40885ffb2ab666ffb2817a99fe69a42af83e77/
		);
	});

	it("authenticates the oracle worktree HEAD instead of trusting the configured label", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_ORACLE_WORKTREE: repositoryRoot,
				TS_DRP_XVER_ORACLE_OBJECT_MODULE: currentObjectModule,
			})
		);
		expectCausalFailure(
			run,
			new RegExp(`XVER_ORACLE_WORKTREE_SHA_MISMATCH.*${REFERENCE_SHA}.*${currentHead.slice(0, 7)}`)
		);
	});
});

describe.skipIf(!acceptanceRequested)("Phase 0m XVER acceptance-command fail-closed guard", () => {
	it("fails rather than skipping the aggregate acceptance entry when the oracle tuple is absent", () => {
		const run = runDifferential({ TS_DRP_XVER: "1" }, ACCEPTANCE_TEST);
		expectCausalFailure(run, /XVER_ORACLE_REQUIRED.*1d40885ffb2ab666ffb2817a99fe69a42af83e77/);
	});
});

describe.skipIf(pinnedWorktree === undefined)("Phase 0m XVER authenticated pinned-worktree controls", () => {
	it("proves the pinned build resolves workspace runtime dependencies from its own worktree", () => {
		const revision = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: pinnedWorktree,
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(revision.status, revision.stderr).toBe(0);
		expect(revision.stdout.trim()).toBe(REFERENCE_SHA);

		const result = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", "process.stdout.write(import.meta.resolve('@ts-drp/types'))"],
			{
				cwd: `${pinnedWorktree}/packages/object`,
				encoding: "utf8",
				timeout: 10_000,
			}
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(`${pinnedWorktree}/packages/types/dist/`);
		expect(result.stdout).not.toContain(`${repositoryRoot}packages/types/dist/`);
	});

	it("rejects an oracle module and runtime dependency closure from the current workspace", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_ORACLE_OBJECT_MODULE: currentObjectModule,
			})
		);
		expectCausalFailure(run, /XVER_ORACLE_RUNTIME_CLOSURE.*outside oracle worktree/);
	});

	it("requires the exact nonzero fixture × schedule × surface count", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_EXPECTED_COMPARISONS: "0",
			})
		);
		expectCausalFailure(run, /XVER_COMPARISON_COUNT_NONZERO.*expected=0/);
	});

	it("detects a one-comparison corpus shrink", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_EXPECTED_COMPARISONS: "7",
			})
		);
		expectCausalFailure(run, /XVER_COMPARISON_COUNT.*expected=7.*actual=6/);
	});

	it("detects the checked divergent engine through XVER, not module resolution", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_PRIMARY_OBJECT_MODULE: outcomeDivergentEngine,
			})
		);
		expectCausalFailure(run, /XVER_DELTA.*(drp-state|graph-membership|admission)/);
	});

	it("does not reuse a Gate-0 category allowance for an XVER delta", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_PRIMARY_OBJECT_MODULE: outcomeDivergentEngine,
				TS_DRP_XVER_EXPECTED_COMPARISONS: "12",
			}),
			GATE0_APPROVED_FIXTURE
		);
		expectCausalFailure(run, /XVER_DELTA.*(drp-state|graph-membership|admission)/);
	});

	it("observes engine-authored hashing and compares raw-hash order and membership", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_PRIMARY_OBJECT_MODULE: hashDivergentEngine,
			})
		);
		expectCausalFailure(
			run,
			/XVER_DELTA(?=.*engine-authored-vertex-hashes)(?=.*raw-hash-order)(?=.*raw-hash-membership)/
		);
	});

	it("rejects a stale unexercised exact XVER delta entry", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_DELTA_MANIFEST: staleManifest,
			})
		);
		expectCausalFailure(run, /XVER_STALE_DELTA.*never-exercised-phase-0m-control/);
	});

	it("rejects a duplicate exact tuple even when another fixture separates the copies", () => {
		const run = runDifferential(
			xverEnvironment({
				TS_DRP_XVER_DELTA_MANIFEST: multiFixtureDuplicateManifest,
			})
		);
		expectCausalFailure(run, /XVER_DELTA_MANIFEST_SCHEMA.*duplicate exact tuple.*fixed-three-vertex-noncanonical-cut/);
	});
});

describe.skipIf(!acceptanceRequested || pinnedWorktree === undefined)(
	"Phase 0m XVER corrective full-corpus authenticated controls RED",
	() => {
		it("detects a one-cell fixed-corpus shrink with a 109 expectation", () => {
			const run = runAcceptance({
				TS_DRP_XVER_EXPECTED_COMPARISONS: String(ACCEPTANCE_COMPARISON_COUNT + 1),
			});
			expectCausalFailure(
				run,
				new RegExp(
					`XVER_COMPARISON_COUNT.*expected=${ACCEPTANCE_COMPARISON_COUNT + 1}.*actual=${ACCEPTANCE_COMPARISON_COUNT}`
				)
			);
		});

		it("uses a kind-correct Map operation and detects controlled Map local-hash divergence", () => {
			const run = runAcceptance({
				TS_DRP_XVER_PRIMARY_OBJECT_MODULE: mapLocalHashDivergentEngine,
			});
			expectCausalFailure(
				run,
				/XVER_DELTA(?=.*resolver-bearing-map)(?=.*engine-authored-vertex-hashes)(?=.*mapFixtures=[1-9])/
			);
		});

		it("accounts for stale exact tuples once, after the complete multi-fixture corpus", () => {
			const run = runAcceptance({
				TS_DRP_XVER_DELTA_MANIFEST: multiFixtureStaleManifest,
			});
			expectCausalFailure(
				run,
				/XVER_STALE_DELTA(?=.*count=2)(?=.*comparisons=108)(?=.*fixed-three-vertex-noncanonical-cut)(?=.*fixed-critical-2-transitive-join-with-two-children)/
			);
		});
	}
);

describe.skipIf(!acceptanceRequested)("Phase 0m XVER hermetic full-corpus positive RED", () => {
	it("runs primary HEAD against the exact pin over all 9 × 18 × 6 = 108 cells through the gate runner", () => {
		expectAuthenticatedCorpusSummary(runHermeticGate());
	});
});

describe("Phase 0m XVER hermetic runner and workflow RED", () => {
	it("exposes a fail-closed fresh-worktree/build/authentication runner contract", () => {
		const runnerPath = resolve(repositoryRoot, RUNNER_PATH);
		expect(existsSync(runnerPath), `${runnerPath} must exist`).toBe(true);
		const described = runHermeticGate(["--describe-contract"]);
		expect(described.status, described.output).toBe(0);
		const descriptor = JSON.parse(described.output.trim()) as Record<string, unknown>;
		expect(descriptor).toMatchObject({
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
				comparisons: ACCEPTANCE_COMPARISON_COUNT,
			},
		});

		const planned = runHermeticGate(["--plan"]);
		expect(planned.status, planned.output).toBe(0);
		expect(JSON.parse(planned.output.trim())).toEqual({
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
				"remove-reference-worktree",
			],
		});
	});

	it("runs the hermetic gate for relevant object and validation pull-request changes", () => {
		const workflowPath = resolve(repositoryRoot, WORKFLOW_PATH);
		expect(existsSync(workflowPath), `${workflowPath} must exist`).toBe(true);
		const workflow = parseDocument(readFileSync(workflowPath, "utf8"), { schema: "core" }).toJS() as {
			on?: { pull_request?: { paths?: string[] }; workflow_dispatch?: unknown };
			jobs?: Record<string, { steps?: { run?: string }[] }>;
		};
		expect(workflow.on?.pull_request?.paths).toEqual(expect.arrayContaining([...GATE_TRIGGER_PATHS]));
		expect(workflow.on).toHaveProperty("workflow_dispatch");
		const commands = Object.values(workflow.jobs ?? {})
			.flatMap((job) => job.steps ?? [])
			.flatMap((step) => (step.run ? [step.run] : []));
		expect(commands.some((command) => command.includes(RUNNER_PATH))).toBe(true);
	});
});

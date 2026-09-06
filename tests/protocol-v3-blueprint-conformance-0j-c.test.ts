import { chromium, firefox, webkit } from "@playwright/test";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import contract from "./fixtures/phase-0j-c-v3/blueprint-conformance-contract.json" with { type: "json" };
import workflowContract from "./fixtures/phase-0j-c-v3/conformance-workflow-contract.json" with { type: "json" };

interface EngineReceipt {
	readonly build: string;
	readonly canonicalIntermediate: { readonly executed: true; readonly rejected: true };
	readonly conformanceDigest: string;
	readonly executedCaseIds: readonly string[];
	readonly finalState: unknown;
	readonly hooks: Readonly<Record<string, { readonly installed: true; readonly probe: string }>>;
	readonly name: "chromium" | "firefox" | "node" | "webkit";
	readonly normalization: {
		readonly negativeZeroOperationArguments: 1;
		readonly normalizedNegativeZeroOutputs: 1;
	};
	readonly outputs: readonly unknown[];
	readonly replays: {
		readonly freshInstances: readonly string[];
		readonly sameModuleInstance: readonly string[];
	};
	readonly sentinel: {
		readonly ambientHookConsumption: readonly (typeof HOOK_NAMES)[number][];
		readonly badFixtureDigest: string;
		readonly badFixtureMismatch: true;
		readonly intrinsicMutationDetected: true;
		readonly throwModeFailedClosed: true;
	};
	readonly sparseIntermediate: { readonly executed: true; readonly rejected: true };
	readonly thenable: { readonly executed: true; readonly rejected: true };
	readonly intrinsicSnapshots: {
		readonly afterEvaluation: string;
		readonly afterEveryReplay: readonly string[];
		readonly beforeEvaluation: string;
	};
}

interface ConformanceReceipt {
	readonly artifactDigest: string;
	readonly artifacts: Readonly<Record<string, { readonly artifactDigest: string; readonly exactBytesSha256: string }>>;
	readonly corpus: {
		readonly corpusVersion: string;
		readonly nightly: {
			readonly dropped: number;
			readonly selected: number;
			readonly selectedCaseIds: readonly string[];
			readonly total: number;
		};
		readonly operationOrder: readonly string[];
		readonly pr: {
			readonly dropped: number;
			readonly selected: number;
			readonly selectedCaseIds: readonly string[];
			readonly total: number;
		};
		readonly seed: string;
	};
	readonly catalogEntry: {
		readonly artifactDigest: string;
		readonly corpusVersion: string;
		readonly engineBuilds: Readonly<Record<EngineReceipt["name"], string>>;
		readonly executionTier: "nightly" | "pr";
		readonly operationOrder: readonly string[];
		readonly result: "passed";
		readonly runtimeProfile: string;
		readonly seed: string;
	};
	readonly engines: readonly EngineReceipt[];
	readonly executionTier: "nightly" | "pr";
	readonly receiptSchemaVersion: number;
	readonly runtimeProfile: string;
	readonly selectedIntrinsicDescriptorTargets: readonly string[];
	readonly negativeControls: {
		readonly intrinsicMutation: {
			readonly detected: true;
			readonly snapshotAfterEvaluation: string;
			readonly snapshotBeforeEvaluation: string;
		};
		readonly moduleGlobalDrift: {
			readonly detected: true;
			readonly freshInstanceDigests: readonly string[];
			readonly sameModuleInstanceDigests: readonly string[];
		};
	};
	readonly packageBinding: {
		readonly artifactDigest: string;
		readonly artifactId: string;
		readonly runtimeProfile: string;
	};
}

type WorkflowObject = Readonly<Record<string, unknown>>;

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const FIXTURE_DIRECTORY = resolve(CURRENT_DIRECTORY, "fixtures/phase-0j-c-v3");
const RUNNER_PATH = resolve(REPOSITORY_ROOT, contract.runner.relativePath);
const HOOK_NAMES = ["Date", "Math.random", "performance", "timers", "io", "dom"] as const;

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function artifactDigest(file: string): string {
	return toHex(
		hashDomain(contract.artifactDigestDomain, new Uint8Array(readFileSync(resolve(FIXTURE_DIRECTORY, file))))
	);
}

function exactBytesSha256(file: string): string {
	return createHash("sha256")
		.update(readFileSync(resolve(FIXTURE_DIRECTORY, file)))
		.digest("hex");
}

function conformanceDigest(finalState: unknown, outputs: unknown): string {
	return toHex(hashDomain(contract.conformance.digestDomain, encodeCanonical({ outputs, state: finalState })));
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function invokeConformance(
	contractPath = resolve(FIXTURE_DIRECTORY, "blueprint-conformance-contract.json"),
	extraArguments: readonly string[] = [],
	tier: "nightly" | "pr" = "pr"
) {
	return spawnSync(process.execPath, [RUNNER_PATH, "--contract", contractPath, "--tier", tier, ...extraArguments], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		env: { ...process.env, CI: "1" },
	});
}

function runConformance(tier: "nightly" | "pr" = "pr"): ConformanceReceipt {
	const invocation = invokeConformance(undefined, [], tier);
	if (invocation.error !== undefined) throw invocation.error;
	expect(invocation.status, `${invocation.stderr}\n${invocation.stdout}`).toBe(0);
	return JSON.parse(invocation.stdout) as ConformanceReceipt;
}

function runnerIsAbsent(output: string): boolean {
	return output.includes(`Cannot find module '${RUNNER_PATH}'`);
}

function asWorkflowObject(value: unknown, label: string): WorkflowObject {
	expect(value, `${label} must be a mapping, not a comment or scalar`).toBeTypeOf("object");
	expect(value, `${label} must not be null`).not.toBeNull();
	expect(Array.isArray(value), `${label} must not be a sequence`).toBe(false);
	return value as WorkflowObject;
}

function asWorkflowArray(value: unknown, label: string): readonly unknown[] {
	expect(Array.isArray(value), `${label} must be a sequence`).toBe(true);
	return value as readonly unknown[];
}

function readWorkflow(relativePath: string): WorkflowObject {
	const absolutePath = resolve(REPOSITORY_ROOT, relativePath);
	expect(existsSync(absolutePath), `${relativePath} must exist as an executable workflow`).toBe(true);
	const document = parseDocument(readFileSync(absolutePath, "utf8"), { schema: "core" });
	expect(
		document.errors.map((error) => error.message),
		`${relativePath} must parse without YAML errors`
	).toEqual([]);
	expect(
		document.warnings.map((warning) => warning.message),
		`${relativePath} must parse without YAML warnings`
	).toEqual([]);
	return asWorkflowObject(document.toJS(), relativePath);
}

function workflowJobs(workflow: WorkflowObject, label: string): WorkflowObject {
	return asWorkflowObject(workflow.jobs, `${label}.jobs`);
}

function jobSteps(job: WorkflowObject, label: string): readonly WorkflowObject[] {
	return asWorkflowArray(job.steps, `${label}.steps`).map((step, index) =>
		asWorkflowObject(step, `${label}.steps[${index}]`)
	);
}

function requireActionSteps(steps: readonly WorkflowObject[]): void {
	const actions = steps.map((step) => step.uses).filter((value): value is string => typeof value === "string");
	for (const action of workflowContract.requiredSetupActions) expect(actions).toContain(action);
}

function requireFocusedTestRun(steps: readonly WorkflowObject[], nightly: boolean): void {
	const runs = steps.map((step) => step.run).filter((value): value is string => typeof value === "string");
	const focusedRun = runs.find((run) => run.includes(workflowContract.focusedTestPath));
	expect(
		focusedRun,
		"the focused conformance test must run as a workflow step, not appear only in comments"
	).toBeTypeOf("string");
	if (focusedRun === undefined) return;
	expect(focusedRun).toMatch(/pnpm\s+exec\s+vitest\s+run/u);
	if (nightly) expect(focusedRun).toMatch(/RUN_PHASE_0J_C_NIGHTLY\s*=\s*true/u);
	else expect(focusedRun).not.toMatch(/RUN_PHASE_0J_C_NIGHTLY\s*=\s*true/u);
}

describe("Phase 0j-c exact-byte cross-engine blueprint conformance RED", () => {
	it("preflights the required Node, Chromium, Firefox and WebKit engines without skips", async () => {
		const browsers = [
			["chromium", chromium],
			["firefox", firefox],
			["webkit", webkit],
		] as const;
		for (const [name, browserType] of browsers) {
			const browser = await browserType.launch({ headless: true });
			try {
				expect(browser.version(), `${name} must expose an exact browser build`).not.toBe("");
			} finally {
				await browser.close();
			}
		}
		expect(process.version).toMatch(/^v\d+/u);
	});

	it("preserves the canonical negative-zero operation argument in raw contract bytes", () => {
		const rawContract = JSON.parse(
			readFileSync(resolve(FIXTURE_DIRECTORY, "blueprint-conformance-contract.json"), "utf8")
		) as { prOperations: readonly { readonly arguments: { readonly requestOrdinal?: number } }[] };
		expect(Object.is(rawContract.prOperations[0]?.arguments.requestOrdinal, -0)).toBe(true);
	});

	it("requires a non-vacuous PR, nightly, reusable-release and publish-blocking workflow graph", () => {
		const conformanceWorkflow = readWorkflow(workflowContract.workflowPath);
		const triggers = asWorkflowObject(conformanceWorkflow.on, `${workflowContract.workflowPath}.on`);
		expect(triggers).toHaveProperty("pull_request");
		const schedule = asWorkflowArray(triggers.schedule, `${workflowContract.workflowPath}.on.schedule`);
		expect(schedule).not.toHaveLength(0);
		for (const [index, entry] of schedule.entries()) {
			const scheduledEntry = asWorkflowObject(entry, `schedule[${index}]`);
			expect(scheduledEntry.cron).toMatch(/^\S.*\S$|^\S$/u);
		}
		const workflowCall = asWorkflowObject(triggers.workflow_call, `${workflowContract.workflowPath}.on.workflow_call`);
		const workflowInputs = asWorkflowObject(
			workflowCall.inputs,
			`${workflowContract.workflowPath}.on.workflow_call.inputs`
		);
		const tierInput = asWorkflowObject(
			workflowInputs.tier,
			`${workflowContract.workflowPath}.on.workflow_call.inputs.tier`
		);
		expect(tierInput.required).toBe(true);
		expect(tierInput.type).toBe("string");

		const conformanceJobs = workflowJobs(conformanceWorkflow, workflowContract.workflowPath);
		const prJob = asWorkflowObject(conformanceJobs[workflowContract.prJobId], workflowContract.prJobId);
		const nightlyJob = asWorkflowObject(conformanceJobs[workflowContract.nightlyJobId], workflowContract.nightlyJobId);
		expect(prJob["runs-on"]).toBeTypeOf("string");
		expect(nightlyJob["runs-on"]).toBeTypeOf("string");
		expect(prJob.if).toMatch(/pull_request/u);
		expect(nightlyJob.if).toMatch(/schedule|inputs\.tier/u);
		for (const [label, job, nightly] of [
			[workflowContract.prJobId, prJob, false],
			[workflowContract.nightlyJobId, nightlyJob, true],
		] as const) {
			const steps = jobSteps(job, label);
			requireActionSteps(steps);
			const runs = steps.map((step) => step.run).filter((value): value is string => typeof value === "string");
			expect(runs.some((run) => /pnpm\s+install\s+--frozen-lockfile/u.test(run))).toBe(true);
			const browserInstall = runs.find((run) => /playwright\s+install/u.test(run));
			expect(browserInstall, `${label} must install the actual three-engine matrix`).toBeTypeOf("string");
			for (const browser of workflowContract.requiredBrowsers)
				expect(browserInstall).toMatch(new RegExp(`\\b${browser}\\b`, "u"));
			requireFocusedTestRun(steps, nightly);
		}

		const releaseWorkflow = readWorkflow(workflowContract.releaseWorkflowPath);
		const releaseJobs = workflowJobs(releaseWorkflow, workflowContract.releaseWorkflowPath);
		const releaseGate = asWorkflowObject(
			releaseJobs[workflowContract.releaseGateJobId],
			workflowContract.releaseGateJobId
		);
		expect(releaseGate.uses).toBe(`./${workflowContract.workflowPath}`);
		const releaseInputs = asWorkflowObject(releaseGate.with, `${workflowContract.releaseGateJobId}.with`);
		expect(releaseInputs.tier).toBe(workflowContract.releaseTier);
		const publishJob = asWorkflowObject(
			releaseJobs[workflowContract.npmPublishJobId],
			workflowContract.npmPublishJobId
		);
		expect(publishJob.uses).toBe(`./${workflowContract.npmPublishWorkflowPath}`);
		const publishNeeds = Array.isArray(publishJob.needs) ? publishJob.needs : [publishJob.needs];
		expect(publishNeeds).toContain(workflowContract.releaseGateJobId);
	});

	it("requires the package-owned release oracle to prove the complete exact-byte conformance matrix", () => {
		const receipt = runConformance();

		expect(receipt.executionTier).toBe("pr");
		expect(receipt.receiptSchemaVersion).toBe(contract.runner.receiptSchemaVersion);
		expect(receipt.runtimeProfile).toBe(contract.runtimeProfile);
		expect(receipt.artifactDigest).toBe(artifactDigest(contract.artifacts.primary.file));
		expect(receipt.packageBinding).toEqual({
			artifactDigest: artifactDigest(contract.artifacts.primary.file),
			artifactId: contract.packageTemplate.implementation.artifactId,
			runtimeProfile: contract.runtimeProfile,
		});
		for (const [name, fixture] of Object.entries(contract.artifacts)) {
			expect(receipt.artifacts[name]?.artifactDigest, `${name} exact bytes must be independently digest-bound`).toBe(
				artifactDigest(fixture.file)
			);
			expect(receipt.artifacts[name]?.exactBytesSha256).toBe(exactBytesSha256(fixture.file));
		}

		expect(receipt.corpus).toMatchObject({
			corpusVersion: contract.conformance.corpusVersion,
			seed: contract.conformance.seed,
			operationOrder: contract.conformance.operationOrder,
			pr: contract.conformance.pr,
			nightly: {
				total: contract.conformance.nightly.total,
				selected: contract.conformance.nightly.selected,
				dropped: contract.conformance.nightly.dropped,
			},
		});
		const prCaseIds = contract.prOperations.map((operation) => operation.id);
		const nightlyCaseIds = contract.nightlyOperations.map((operation) => operation.id);
		expect(nightlyCaseIds).toEqual([...prCaseIds, ...contract.conformance.nightly.additionalSelectedCaseIds]);
		expect(receipt.corpus.pr.selectedCaseIds).toEqual(prCaseIds);
		expect(receipt.corpus.nightly.selectedCaseIds).toHaveLength(contract.conformance.nightly.selected);
		expect(receipt.corpus.nightly.selectedCaseIds).toEqual(
			expect.arrayContaining([...prCaseIds, ...contract.conformance.nightly.additionalSelectedCaseIds])
		);
		expect(receipt.corpus.nightly.selectedCaseIds).not.toEqual(receipt.corpus.pr.selectedCaseIds);
		expect(receipt.corpus.pr.selected + receipt.corpus.pr.dropped).toBe(receipt.corpus.pr.total);
		expect(receipt.corpus.nightly.selected + receipt.corpus.nightly.dropped).toBe(receipt.corpus.nightly.total);
		expect(receipt.selectedIntrinsicDescriptorTargets).toEqual(contract.conformance.selectedIntrinsicDescriptorTargets);
		expect(receipt.catalogEntry).toMatchObject({
			artifactDigest: receipt.artifactDigest,
			corpusVersion: contract.conformance.corpusVersion,
			operationOrder: contract.conformance.operationOrder,
			result: "passed",
			runtimeProfile: contract.runtimeProfile,
			seed: contract.conformance.seed,
			executionTier: "pr",
		});

		expect(receipt.engines.map((engine) => engine.name).sort()).toEqual(["chromium", "firefox", "node", "webkit"]);
		for (const engine of receipt.engines) {
			expect(engine.build, `${engine.name} build must be recorded`).not.toBe("");
			expect(engine.conformanceDigest).toBe(conformanceDigest(engine.finalState, engine.outputs));
			expect(receipt.catalogEntry.engineBuilds[engine.name]).toBe(engine.build);
			const negativeZeroOutput = engine.outputs[0] as {
				readonly normalizedNegativeZero?: unknown;
				readonly outputDetachmentProbe?: unknown;
				readonly requestOrdinal?: unknown;
			};
			expect(negativeZeroOutput.normalizedNegativeZero).toBe(true);
			expect(Object.is(negativeZeroOutput.requestOrdinal, 0)).toBe(true);
			expect(Object.is(negativeZeroOutput.requestOrdinal, -0)).toBe(false);
			expect(Object.is(negativeZeroOutput.outputDetachmentProbe, 0)).toBe(true);
			expect(Object.is(negativeZeroOutput.outputDetachmentProbe, -0)).toBe(false);
			const stateDetachmentOutput = engine.outputs[1] as {
				readonly receivedCanonicalNestedKeyOrder?: unknown;
				readonly receivedStateDetachmentProbe?: unknown;
			};
			expect(stateDetachmentOutput.receivedStateDetachmentProbe).toBe(true);
			expect(stateDetachmentOutput.receivedCanonicalNestedKeyOrder).toBe(true);
			expect(engine.executedCaseIds).toEqual(prCaseIds);
			expect(engine.normalization).toEqual({
				negativeZeroOperationArguments: 1,
				normalizedNegativeZeroOutputs: 1,
			});
			expect(engine.replays.sameModuleInstance).toEqual([engine.conformanceDigest, engine.conformanceDigest]);
			expect(engine.replays.freshInstances).toEqual([engine.conformanceDigest, engine.conformanceDigest]);
			expect(engine.thenable.rejected).toBe(true);
			expect(engine.thenable.executed).toBe(true);
			expect(engine.canonicalIntermediate).toEqual({ executed: true, rejected: true });
			expect(engine.sparseIntermediate).toEqual({ executed: true, rejected: true });
			expect(engine.sentinel.badFixtureMismatch).toBe(true);
			expect(engine.sentinel.badFixtureDigest).not.toBe(engine.conformanceDigest);
			expect(engine.sentinel.throwModeFailedClosed).toBe(true);
			expect(engine.sentinel.intrinsicMutationDetected).toBe(true);
			expect(engine.sentinel.ambientHookConsumption).toEqual(HOOK_NAMES);
			for (const hookName of HOOK_NAMES) {
				const hook = engine.hooks[hookName];
				expect(hook?.installed, `${engine.name} ${hookName} poison must be installed`).toBe(true);
				expect(hook?.probe, `${engine.name} ${hookName} poison must be observable`).toMatch(
					new RegExp(`^${engine.name}:`, "u")
				);
			}
			expect(engine.intrinsicSnapshots.afterEvaluation).toBe(engine.intrinsicSnapshots.beforeEvaluation);
			expect(engine.intrinsicSnapshots.afterEveryReplay).toEqual([
				engine.intrinsicSnapshots.beforeEvaluation,
				engine.intrinsicSnapshots.beforeEvaluation,
				engine.intrinsicSnapshots.beforeEvaluation,
				engine.intrinsicSnapshots.beforeEvaluation,
			]);
		}
		expect(new Set(receipt.engines.map((engine) => engine.conformanceDigest))).toHaveLength(1);
		expect(receipt.negativeControls.moduleGlobalDrift.detected).toBe(true);
		expect(receipt.negativeControls.moduleGlobalDrift.sameModuleInstanceDigests).toHaveLength(2);
		expect(receipt.negativeControls.moduleGlobalDrift.freshInstanceDigests).toHaveLength(2);
		expect(receipt.negativeControls.moduleGlobalDrift.sameModuleInstanceDigests[0]).not.toBe(
			receipt.negativeControls.moduleGlobalDrift.sameModuleInstanceDigests[1]
		);
		expect(receipt.negativeControls.moduleGlobalDrift.freshInstanceDigests[0]).toBe(
			receipt.negativeControls.moduleGlobalDrift.freshInstanceDigests[1]
		);
		expect(receipt.negativeControls.intrinsicMutation.detected).toBe(true);
		expect(receipt.negativeControls.intrinsicMutation.snapshotAfterEvaluation).not.toBe(
			receipt.negativeControls.intrinsicMutation.snapshotBeforeEvaluation
		);
	});

	it.runIf(process.env.RUN_PHASE_0J_C_NIGHTLY === "true")(
		"executes the bounded nightly strict superset in every required engine",
		() => {
			const receipt = runConformance("nightly");
			const nightlyCaseIds = contract.nightlyOperations.map((operation) => operation.id);
			expect(contract.nightlyOperations.slice(0, contract.prOperations.length)).toEqual(contract.prOperations);
			expect(receipt.executionTier).toBe("nightly");
			expect(receipt.corpus.nightly.selectedCaseIds).toEqual(nightlyCaseIds);
			expect(receipt.corpus.nightly.selectedCaseIds).toHaveLength(contract.conformance.nightly.selected);
			for (const engine of receipt.engines) {
				expect(engine.executedCaseIds).toEqual(nightlyCaseIds);
				expect(engine.outputs).toHaveLength(contract.conformance.nightly.selected);
			}
			expect(receipt.catalogEntry).toMatchObject({
				artifactDigest: artifactDigest(contract.artifacts.primary.file),
				corpusVersion: contract.conformance.corpusVersion,
				executionTier: "nightly",
				operationOrder: contract.nightlyOperations.map((operation) => operation.action),
				result: "passed",
				runtimeProfile: contract.runtimeProfile,
				seed: contract.conformance.seed,
			});
		}
	);

	it("fails closed on package-template artifactId and runtimeProfile mutations before engine execution", () => {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "ts-drp-phase-0j-c-package-mutant-"));
		try {
			for (const [name, mutate] of [
				[
					"artifactId",
					(value: { packageTemplate: { implementation: { artifactId: string } } }): void => {
						value.packageTemplate.implementation.artifactId += ".mutant";
					},
				],
				[
					"runtimeProfile",
					(value: { packageTemplate: { implementation: { runtimeProfile: string } } }): void => {
						value.packageTemplate.implementation.runtimeProfile += ".mutant";
					},
				],
			] as const) {
				const mutant = JSON.parse(JSON.stringify(contract)) as {
					packageTemplate: { implementation: { artifactId: string; runtimeProfile: string } };
				};
				mutate(mutant);
				const mutantPath = resolve(temporaryDirectory, `${name}.json`);
				writeFileSync(mutantPath, `${JSON.stringify(mutant)}\n`, "utf8");
				const invocation = invokeConformance(mutantPath);
				if (invocation.error !== undefined) throw invocation.error;
				const output = `${invocation.stderr}\n${invocation.stdout}`;
				if (runnerIsAbsent(output)) continue;
				expect(invocation.status, `${name}: ${output}`).not.toBe(0);
				expect(output).toMatch(new RegExp(`${name}|package.*(mismatch|bind|valid)|fail.closed`, "iu"));
				expect(output).not.toMatch(/worker|chromium|firefox|webkit/u);
			}
		} finally {
			rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("fails closed when exact verified artifact bytes disagree across Node and browser engines", () => {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "ts-drp-phase-0j-c-engine-divergent-"));
		try {
			const divergentArtifact = contract.artifacts.engineDivergent;
			if (divergentArtifact === undefined)
				throw new Error("engine-divergent fixture is missing from the frozen contract");
			for (const fixture of Object.values(contract.artifacts)) {
				writeFileSync(
					resolve(temporaryDirectory, fixture.file),
					readFileSync(resolve(FIXTURE_DIRECTORY, fixture.file))
				);
			}
			const rawContract = readFileSync(resolve(FIXTURE_DIRECTORY, "blueprint-conformance-contract.json"), "utf8");
			const primaryArtifact = contract.artifacts.primary;
			const primaryFragment = [
				'\t\t"primary": {',
				`\t\t\t"file": ${JSON.stringify(primaryArtifact.file)},`,
				`\t\t\t"artifactId": ${JSON.stringify(primaryArtifact.artifactId)}`,
				"\t\t},",
			].join("\n");
			const divergentPrimaryFragment = [
				'\t\t"primary": {',
				`\t\t\t"file": ${JSON.stringify(divergentArtifact.file)},`,
				`\t\t\t"artifactId": ${JSON.stringify(divergentArtifact.artifactId)}`,
				"\t\t},",
			].join("\n");
			const primaryReboundContract = rawContract.replace(primaryFragment, divergentPrimaryFragment);
			expect(primaryReboundContract).not.toBe(rawContract);
			const mutantContract = primaryReboundContract.replace(
				contract.packageTemplate.implementation.artifactId,
				divergentArtifact.artifactId
			);
			expect(mutantContract).not.toContain(contract.packageTemplate.implementation.artifactId);
			const mutantPath = resolve(temporaryDirectory, "blueprint-conformance-engine-divergent-contract.json");
			writeFileSync(mutantPath, mutantContract, "utf8");
			const invocation = invokeConformance(mutantPath);
			if (invocation.error !== undefined) throw invocation.error;
			const output = `${invocation.stderr}\n${invocation.stdout}`;
			if (runnerIsAbsent(output)) return;
			expect(invocation.status, output).not.toBe(0);
			expect(output).toMatch(/cross.engine.*digest.*(disagree|mismatch)|engine.*digest.*(disagree|mismatch)/iu);
			expect(output).not.toMatch(/"result"\s*:\s*"passed"/u);
		} finally {
			rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("fails closed for thenable, module-global, descriptor-mutation, canonical-value, sparse-array and accounting controls", () => {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "ts-drp-phase-0j-c-mutant-"));
		const mutantPath = resolve(temporaryDirectory, "blueprint-conformance-contract-mutant.json");
		const mutant = JSON.parse(JSON.stringify(contract)) as {
			conformance: { pr: { total: number } };
		};
		mutant.conformance.pr.total -= 1;
		writeFileSync(mutantPath, `${JSON.stringify(mutant)}\n`, "utf8");
		try {
			for (const [control, controlContractPath] of [
				["thenable", resolve(FIXTURE_DIRECTORY, "blueprint-conformance-contract.json")],
				["module-global-drift", resolve(FIXTURE_DIRECTORY, "blueprint-conformance-contract.json")],
				["intrinsic-mutation", resolve(FIXTURE_DIRECTORY, "blueprint-conformance-contract.json")],
				["noncanonical-intermediate", resolve(FIXTURE_DIRECTORY, "blueprint-conformance-contract.json")],
				["sparse-intermediate", resolve(FIXTURE_DIRECTORY, "blueprint-conformance-contract.json")],
				["corpus-accounting", mutantPath],
			] as const) {
				const invocation = invokeConformance(controlContractPath, ["--negative-control", control]);
				if (invocation.error !== undefined) throw invocation.error;
				expect(invocation.status, `${control}: ${invocation.stderr}\n${invocation.stdout}`).not.toBe(0);
				const output = `${invocation.stderr}\n${invocation.stdout}`;
				expect(output).not.toMatch(/unknown|unsupported.*negative.*control/iu);
				expect(output).toMatch(new RegExp(`${control.replace(/-/gu, ".*")}|fail.closed|reject|detect`, "iu"));
				if (control === "corpus-accounting") expect(output).not.toMatch(/ENOENT|no such file|artifact.*read/iu);
			}
		} finally {
			rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});
});

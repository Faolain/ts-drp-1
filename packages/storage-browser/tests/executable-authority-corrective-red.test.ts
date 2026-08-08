import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { validCorrectiveCampaign } from "./fixtures/corrective-artifact-fixtures.js";
import type { ProcessIdentity } from "./fixtures/process-forest.js";
import { finalizeFailedRun, type FinalizeFailedRunInput } from "./fixtures/run-finalizer.js";
import { inspectSettledRunOwnership, profileDispositionFor } from "./fixtures/settled-run-lifecycle.js";

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";
const PROFILE = "/tmp/phase-2b-executable-authority-profile";
const PARENT_EXECUTABLE = "/opt/playwright/chromium/chrome";
const HEADLESS_SHELL = "/opt/playwright/chromium_headless_shell/chrome-headless-shell";
const CONTROLLER_PID = 901;
const BROWSER_PID = 420;

type OwnershipEvidenceState = "captured" | "unknown";

const PASS_CANDIDATE = validCorrectiveCampaign().find((artifact) => artifact.runKind === "discovery");
if (PASS_CANDIDATE?.runKind !== "discovery") throw new TypeError("missing discovery fixture");
const PASS = PASS_CANDIDATE;

function failureBase(): FinalizeFailedRunInput["base"] {
	return Object.freeze({
		schemaVersion: PASS.schemaVersion,
		browser: PASS.browser,
		databaseName: PASS.databaseName,
		expectedDigests: PASS.expectedDigests,
		gitSha: PASS.gitSha,
		objectId: PASS.objectId,
		platform: PASS.platform,
		profilePath: PASS.profilePath,
		runId: PASS.runId,
		runKind: PASS.runKind,
	});
}

function identity(pid: number, ppid: number, pgid: number, command: string): ProcessIdentity {
	return Object.freeze({
		birthToken: `Fri Aug  7 22:10:${String(pid % 60).padStart(2, "0")} 2026`,
		command,
		pgid,
		pid,
		ppid,
		state: "S",
	});
}

function reparentedForest(
	executablePath: string,
	profileArgument = `--user-data-dir=${PROFILE}`
): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, 900, "node playwright-controller.js"),
		identity(BROWSER_PID, 1, BROWSER_PID, `${executablePath} --headless ${profileArgument}`),
		identity(421, BROWSER_PID, BROWSER_PID, `${executablePath} --type=renderer`),
	]);
}

function inspect(forest: readonly ProcessIdentity[]): ReturnType<typeof inspectSettledRunOwnership> {
	return inspectSettledRunOwnership(forest, {
		childPid: 410,
		chromiumExecutablePath: PARENT_EXECUTABLE,
		controllerPid: CONTROLLER_PID,
		profilePath: PROFILE,
	});
}

function evidenceState(ownership: ReturnType<typeof inspect>): OwnershipEvidenceState {
	return ownership.evidenceState;
}

function finalize(ownership: ReturnType<typeof inspect>): {
	readonly disposition: ReturnType<typeof profileDispositionFor>;
	readonly signaled: readonly number[];
	readonly unresolved: readonly number[];
} {
	const signaled: number[] = [];
	const finalization = finalizeFailedRun(
		{
			base: failureBase(),
			code: "SETUP_FAILED",
			detail: "SETUP_FAILED: injected executable-authority failure",
			ownedGroups: ownership.ownedGroups,
			partialEvidence: { recordedForest: ownership.recordedForest },
			stage: "seed",
			validatedGroups: ownership.validatedGroups,
		},
		{
			killValidatedGroup: (pgid): void => {
				signaled.push(pgid);
			},
			writeArtifact: (): void => undefined,
		}
	);
	return Object.freeze({
		disposition: profileDispositionFor({
			kind: "failed-finalized",
			finalization,
			ownershipEvidenceState: ownership.evidenceState,
		}),
		signaled: Object.freeze(signaled),
		unresolved: finalization.unresolvedOwnedGroups,
	});
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b executable-authority correction", () => {
	it("retains a reparented exact-profile browser group when its executable disagrees with parent authority", () => {
		const ownership = inspect(reparentedForest(HEADLESS_SHELL));
		const result = finalize(ownership);

		expect
			.soft(evidenceState(ownership), "an executable contradiction makes ownership evidence incomplete")
			.toBe("unknown");
		expect.soft(ownership.ownedGroups, "the unique exact-profile browser group remains owned").toEqual([BROWSER_PID]);
		expect.soft(ownership.recordedForest.map(({ pid }) => pid)).toEqual([BROWSER_PID, 421]);
		expect.soft(ownership.validatedGroups, "an executable contradiction grants no signal authority").toEqual([]);
		expect.soft(result.signaled).toEqual([]);
		expect.soft(result.unresolved).toEqual([BROWSER_PID]);
		expect(result.disposition, "unknown browser ownership retains the live profile").toBe("retain");
	});

	it.each([
		{
			label: "complete empty capture",
			forest: Object.freeze([]),
			expectedOwned: [],
			expectedValidated: [],
			expectedSignaled: [],
			expectedDisposition: "remove",
		},
		{
			label: "profile prefix",
			forest: reparentedForest(PARENT_EXECUTABLE, `--user-data-dir=prefix${PROFILE}`),
			expectedOwned: [],
			expectedValidated: [],
			expectedSignaled: [],
			expectedDisposition: "remove",
		},
		{
			label: "profile suffix",
			forest: reparentedForest(PARENT_EXECUTABLE, `--user-data-dir=${PROFILE}-suffix`),
			expectedOwned: [],
			expectedValidated: [],
			expectedSignaled: [],
			expectedDisposition: "remove",
		},
		{
			label: "matching parent-forced executable",
			forest: reparentedForest(PARENT_EXECUTABLE),
			expectedOwned: [BROWSER_PID],
			expectedValidated: [BROWSER_PID],
			expectedSignaled: [BROWSER_PID],
			expectedDisposition: "remove",
		},
	] as const)("keeps the $label authority boundary closed", (control) => {
		const ownership = inspect(control.forest);
		const result = finalize(ownership);

		expect.soft(evidenceState(ownership)).toBe("captured");
		expect.soft(ownership.ownedGroups).toEqual(control.expectedOwned);
		expect.soft(ownership.validatedGroups).toEqual(control.expectedValidated);
		expect.soft(result.signaled).toEqual(control.expectedSignaled);
		expect.soft(result.unresolved).toEqual([]);
		expect(result.disposition).toBe(control.expectedDisposition);
	});
});

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = path.join(TEST_DIRECTORY, "crash-driver.pw.ts");
const CHILD_PATHS = [
	path.join(TEST_DIRECTORY, "process/settled-child.ts"),
	path.join(TEST_DIRECTORY, "process/crash-child.ts"),
	path.join(TEST_DIRECTORY, "process/arming-child.ts"),
] as const;
const EXECUTABLE_ENVIRONMENT_NAME = "PHASE_2B_EXECUTABLE_PATH";

function sourceFile(filePath: string): ts.SourceFile {
	return ts.createSourceFile(
		filePath,
		fs.readFileSync(filePath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
}

function callsWhere(root: ts.Node, predicate: (call: ts.CallExpression) => boolean): readonly ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && predicate(node)) calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return calls;
}

function propertyNamed(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
	return object.properties.find(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) &&
			((ts.isIdentifier(property.name) && property.name.text === name) ||
				(ts.isStringLiteral(property.name) && property.name.text === name))
	);
}

function chromiumExecutablePathCalls(root: ts.Node): readonly ts.CallExpression[] {
	return callsWhere(
		root,
		(call) =>
			ts.isPropertyAccessExpression(call.expression) &&
			ts.isIdentifier(call.expression.expression) &&
			call.expression.expression.text === "chromium" &&
			call.expression.name.text === "executablePath"
	);
}

function boundIdentifier(call: ts.CallExpression): string | undefined {
	return ts.isVariableDeclaration(call.parent) && ts.isIdentifier(call.parent.name) ? call.parent.name.text : undefined;
}

function requiredExecutableBinding(source: ts.SourceFile): string | undefined {
	const requiredCalls = callsWhere(
		source,
		(call) =>
			ts.isIdentifier(call.expression) &&
			call.expression.text === "required" &&
			call.arguments.length === 1 &&
			ts.isStringLiteral(call.arguments[0]) &&
			call.arguments[0].text === EXECUTABLE_ENVIRONMENT_NAME
	);
	return requiredCalls.length === 1 ? boundIdentifier(requiredCalls[0] as ts.CallExpression) : undefined;
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b parent-authoritative executable wiring", () => {
	it("binds one parent executable through every child launch and cleanup inspection", () => {
		const driver = sourceFile(DRIVER_PATH);
		const parentExecutableCalls = chromiumExecutablePathCalls(driver);
		expect.soft(parentExecutableCalls, "the parent resolves Chromium exactly once").toHaveLength(1);
		const parentBinding =
			parentExecutableCalls.length === 1 ? boundIdentifier(parentExecutableCalls[0] as ts.CallExpression) : undefined;
		expect.soft(parentBinding, "the resolved parent executable has one closed binding").toBeTypeOf("string");

		const childLaunches = callsWhere(
			driver,
			(call) =>
				ts.isIdentifier(call.expression) && (call.expression.text === "fork" || call.expression.text === "spawn")
		);
		expect.soft(childLaunches, "one settled/arming launch and one crash launch are wired").toHaveLength(2);
		for (const launch of childLaunches) {
			const options = launch.arguments.at(-1);
			const environment =
				options !== undefined && ts.isObjectLiteralExpression(options)
					? propertyNamed(options, "env")?.initializer
					: undefined;
			const executable =
				environment !== undefined && ts.isObjectLiteralExpression(environment)
					? propertyNamed(environment, EXECUTABLE_ENVIRONMENT_NAME)?.initializer
					: undefined;
			const executableBinding = executable !== undefined && ts.isIdentifier(executable) ? executable.text : undefined;
			expect
				.soft(executableBinding, `${launch.expression.getText(driver)} passes a closed executable binding`)
				.toBeTypeOf("string");
			expect.soft(executableBinding, "the child launch receives the parent executable").toBe(parentBinding);
		}

		const cleanupCalls = callsWhere(
			driver,
			(call) => ts.isIdentifier(call.expression) && call.expression.text === "captureSettledRunOwnership"
		);
		expect.soft(cleanupCalls, "both settled and tuple failure inspectors use the bound value").toHaveLength(2);
		for (const call of cleanupCalls) {
			const context = call.arguments[1];
			const executable =
				context !== undefined && ts.isObjectLiteralExpression(context)
					? propertyNamed(context, "chromiumExecutablePath")?.initializer
					: undefined;
			const executableBinding = executable !== undefined && ts.isIdentifier(executable) ? executable.text : undefined;
			expect.soft(executableBinding, "cleanup consumes a closed executable binding").toBeTypeOf("string");
			expect.soft(executableBinding, "cleanup consumes the launch-time parent binding").toBe(parentBinding);
		}
	});

	it.each(CHILD_PATHS)("uses the required parent executable in %s", (childPath) => {
		const source = sourceFile(childPath);
		const executableBinding = requiredExecutableBinding(source);
		expect.soft(executableBinding, "the child requires the parent-provided executable").toBeTypeOf("string");
		expect.soft(chromiumExecutablePathCalls(source), "the child never resolves a second executable").toHaveLength(0);

		const launches = callsWhere(
			source,
			(call) =>
				ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "launchPersistentContext"
		);
		expect.soft(launches).toHaveLength(1);
		const options = launches[0]?.arguments[1];
		const executable =
			options !== undefined && ts.isObjectLiteralExpression(options)
				? propertyNamed(options, "executablePath")?.initializer
				: undefined;
		expect(
			executable !== undefined && ts.isIdentifier(executable) ? executable.text : undefined,
			"launchPersistentContext receives the exact environment-bound value"
		).toBe(executableBinding);
	});
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { validCorrectiveCampaign } from "./fixtures/corrective-artifact-fixtures.js";
import type { ProcessIdentity } from "./fixtures/process-forest.js";
import { finalizeFailedRun, type FinalizeFailedRunInput } from "./fixtures/run-finalizer.js";
import {
	disposeProfileWhenAllowed,
	inspectSettledRunOwnership,
	profileDispositionFor,
} from "./fixtures/settled-run-lifecycle.js";

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";
const PROFILE = "/tmp/phase-2b-reparented-profile";
const EXECUTABLE = "/Applications/Chromium Test.app/Contents/MacOS/Chromium";
const CONTROLLER_PID = 901;
const CONTROLLER_PGID = 900;
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

function identity(
	pid: number,
	ppid: number,
	pgid: number,
	command: string,
	birthToken = `Fri Aug  7 17:00:${String(pid % 60).padStart(2, "0")} 2026`
): ProcessIdentity {
	return Object.freeze({ birthToken, command, pgid, pid, ppid, state: "S" });
}

function reparentedForest(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node playwright-controller.js"),
		identity(420, 1, 420, `${EXECUTABLE} --headless --user-data-dir=${PROFILE}`),
		identity(421, 420, 420, `${EXECUTABLE} --type=renderer`),
		identity(430, 1, 430, `${EXECUTABLE} --user-data-dir=${PROFILE}-other`),
	]);
}

function directForest(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node playwright-controller.js"),
		identity(410, CONTROLLER_PID, 410, "node settled-child.js"),
		identity(420, 410, 420, `${EXECUTABLE} --headless --user-data-dir=${PROFILE}`),
		identity(421, 420, 420, `${EXECUTABLE} --type=renderer`),
	]);
}

function inspect(
	forest: readonly ProcessIdentity[],
	trustedChildIdentity?: ProcessIdentity
): ReturnType<typeof inspectSettledRunOwnership> {
	const context: Parameters<typeof inspectSettledRunOwnership>[1] & {
		readonly trustedChildIdentity?: ProcessIdentity;
	} = {
		childPid: 410,
		chromiumExecutablePath: EXECUTABLE,
		controllerPid: CONTROLLER_PID,
		profilePath: PROFILE,
		...(trustedChildIdentity === undefined ? {} : { trustedChildIdentity }),
	};
	return inspectSettledRunOwnership(forest, context);
}

function expectCapturedOwnership(ownership: ReturnType<typeof inspectSettledRunOwnership>): void {
	expect(Object.keys(ownership).sort()).toEqual(["evidenceState", "ownedGroups", "recordedForest", "validatedGroups"]);
	expect(
		(ownership as ReturnType<typeof inspectSettledRunOwnership> & { readonly evidenceState?: unknown }).evidenceState
	).toBe("captured");
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b reparented settled ownership controls", () => {
	it("preserves both validated groups while the exact settled child relationship remains observable", () => {
		const forest = directForest();
		const trustedChildIdentity = forest.find(({ pid }) => pid === 410);
		if (trustedChildIdentity === undefined) throw new TypeError("missing direct child identity");
		const ownership = inspect(forest, trustedChildIdentity);
		expectCapturedOwnership(ownership);
		expect(ownership.ownedGroups).toEqual([410, 420]);
		expect(ownership.validatedGroups).toEqual([410, 420]);
		expect(new Set(ownership.recordedForest.map(({ pid }) => pid))).toEqual(new Set([410, 420, 421]));
	});

	it("validates only the unique exact-profile Chromium group after the settled child disappeared", () => {
		const ownership = inspect(reparentedForest());
		expectCapturedOwnership(ownership);
		expect(ownership.ownedGroups).toEqual([420]);
		expect(ownership.validatedGroups).toEqual([420]);
		expect(new Set(ownership.recordedForest.map(({ pid }) => pid))).toEqual(new Set([420, 421]));
		expect(ownership.recordedForest.some(({ pgid }) => pgid === CONTROLLER_PGID)).toBe(false);
		expect(ownership.ownedGroups).not.toContain(410);
	});

	it.each([
		{
			label: "ambiguous exact roots",
			forest: [...reparentedForest(), identity(440, 1, 440, `${EXECUTABLE} --user-data-dir=${PROFILE}`)],
			expectedOwned: [420, 440],
		},
		{
			label: "missing controller",
			forest: reparentedForest().filter(({ pid }) => pid !== CONTROLLER_PID),
			expectedOwned: [420],
		},
		{
			label: "ambiguous controller",
			forest: [...reparentedForest(), identity(CONTROLLER_PID, 2, 902, "node duplicate-controller.js", "duplicate")],
			expectedOwned: [420],
		},
		{
			label: "controller group collision",
			forest: reparentedForest().map((candidate) =>
				candidate.pid === CONTROLLER_PID ? identity(CONTROLLER_PID, 1, 420, candidate.command) : candidate
			),
			expectedOwned: [420],
		},
		{
			label: "duplicate identity",
			forest: [...reparentedForest(), identity(421, 420, 420, `${EXECUTABLE} --type=renderer`, "duplicate")],
			expectedOwned: [420],
		},
		{
			label: "malformed identity",
			forest: [...reparentedForest(), identity(Number.NaN, 420, 420, `${EXECUTABLE} --type=renderer`)],
			expectedOwned: [420],
		},
	])("keeps discoverable exact-profile groups unresolved for $label", ({ forest, expectedOwned }) => {
		const ownership = inspect(forest);
		expect(ownership.ownedGroups).toEqual(expectedOwned);
		expect(ownership.validatedGroups).toEqual([]);
	});

	it("does not discover substring-profile or non-authoritative executable lookalikes", () => {
		const substring = reparentedForest().map((candidate) =>
			candidate.pid === 420
				? identity(candidate.pid, candidate.ppid, candidate.pgid, `${EXECUTABLE} --user-data-dir=${PROFILE}-suffix`)
				: candidate
		);
		const executableLookalike = reparentedForest().map((candidate) =>
			candidate.pid === 420
				? identity(
						candidate.pid,
						candidate.ppid,
						candidate.pgid,
						`/tmp/wrapper-${path.basename(EXECUTABLE)} ${EXECUTABLE} --user-data-dir=${PROFILE}`
					)
				: candidate
		);
		expect(inspect(substring)).toEqual({
			evidenceState: "captured",
			ownedGroups: [],
			recordedForest: [],
			validatedGroups: [],
		});
		expect(inspect(executableLookalike)).toEqual({
			evidenceState: "captured",
			ownedGroups: [],
			recordedForest: [],
			validatedGroups: [],
		});
	});

	it("never turns unresolved discoverability into signal authority", () => {
		const ambiguous = inspect([
			...reparentedForest(),
			identity(440, 1, 440, `${EXECUTABLE} --user-data-dir=${PROFILE}`),
		]);
		const signaled: number[] = [];
		const observation = finalizeFailedRun(
			{
				base: failureBase(),
				code: "SETUP_FAILED",
				detail: "SETUP_FAILED: injected reparented ambiguity",
				ownedGroups: ambiguous.ownedGroups,
				partialEvidence: { recordedForest: ambiguous.recordedForest },
				stage: "seed",
				validatedGroups: ambiguous.validatedGroups,
			},
			{ killValidatedGroup: (pgid): number => signaled.push(pgid), writeArtifact: (): void => undefined }
		);
		expect(ambiguous.ownedGroups).toEqual([420, 440]);
		expect(ambiguous.validatedGroups).toEqual([]);
		expect(signaled).toEqual([]);
		expect(observation.unresolvedOwnedGroups).toEqual([420, 440]);
	});
});

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b closed profile disposal controls", () => {
	it.each([
		{ completion: { kind: "pass" } as const, expected: "remove" },
		{
			completion: {
				kind: "failed-finalized",
				finalization: { unresolvedOwnedGroups: [] },
				ownershipEvidenceState: "captured",
			} as const,
			expected: "remove",
		},
		{
			completion: {
				kind: "failed-finalized",
				finalization: { unresolvedOwnedGroups: [420] },
				ownershipEvidenceState: "captured",
			} as const,
			expected: "retain",
		},
		{ completion: { kind: "finalization-failed" } as const, expected: "retain" },
	])("returns $expected for $completion.kind", ({ completion, expected }) => {
		expect(profileDispositionFor(completion)).toBe(expected);
	});

	it("fails closed for omitted or unrecognized failed-finalized evidence state", () => {
		const untrustedCompletions: readonly unknown[] = [
			{ kind: "failed-finalized", finalization: { unresolvedOwnedGroups: [] } },
			{
				kind: "failed-finalized",
				finalization: { unresolvedOwnedGroups: [] },
				ownershipEvidenceState: "unrecognized",
			},
		];
		for (const completion of untrustedCompletions) {
			expect
				.soft(
					profileDispositionFor(completion as Parameters<typeof profileDispositionFor>[0]),
					"untyped failed-finalized input cannot create delete eligibility"
				)
				.toBe("retain");
		}
	});

	it("makes removal versus retention observable at the one disposal boundary", () => {
		const removed: string[] = [];
		expect(disposeProfileWhenAllowed(PROFILE, "retain", (value) => removed.push(value))).toBe(false);
		expect(removed).toEqual([]);
		expect(disposeProfileWhenAllowed(PROFILE, "remove", (value) => removed.push(value))).toBe(true);
		expect(removed).toEqual([PROFILE]);
	});
});

const DRIVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "crash-driver.pw.ts");
const DRIVER_SOURCE = ts.createSourceFile(
	DRIVER_PATH,
	fs.readFileSync(DRIVER_PATH, "utf8"),
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TS
);

function namedFunction(name: string): ts.FunctionDeclaration {
	const declaration = DRIVER_SOURCE.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === name
	);
	if (declaration === undefined) throw new TypeError(`missing ${name}`);
	return declaration;
}

function callsNamed(root: ts.Node, name: string): readonly ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name)
			calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return calls;
}

function catchClauseOf(declaration: ts.FunctionDeclaration): ts.CatchClause {
	let clause: ts.CatchClause | undefined;
	const visit = (node: ts.Node): void => {
		if (clause === undefined && ts.isCatchClause(node)) clause = node;
		else ts.forEachChild(node, visit);
	};
	visit(declaration);
	if (clause === undefined) throw new TypeError(`missing catch in ${declaration.name?.text ?? "function"}`);
	return clause;
}

function importedFromLifecycle(name: string): boolean {
	return DRIVER_SOURCE.statements.some(
		(statement) =>
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === "./fixtures/settled-run-lifecycle.js" &&
			statement.importClause?.namedBindings !== undefined &&
			ts.isNamedImports(statement.importClause.namedBindings) &&
			statement.importClause.namedBindings.elements.some((element) => element.name.text === name)
	);
}

function containsIdentifier(root: ts.Node, name: string): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && node.text === name) found = true;
		else ts.forEachChild(node, visit);
	};
	visit(root);
	return found;
}

function boundCallName(call: ts.CallExpression | undefined): string | undefined {
	const declaration = call?.parent;
	return declaration !== undefined && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
		? declaration.name.text
		: undefined;
}

function directProfileRemovals(root: ts.Node): readonly ts.CallExpression[] {
	const removals: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "fs" &&
			node.expression.name.text === "rmSync" &&
			node.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === "profilePath")
		) {
			removals.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return removals;
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b settled lifecycle integration RED", () => {
	it("runSettled rediscovers a reparented browser from parent-authoritative context", () => {
		const declaration = namedFunction("runSettled");
		const clause = catchClauseOf(declaration);
		const durable = callsNamed(clause, "captureSettledRunOwnership");
		const superseded = callsNamed(clause, "inspectSettledRunOwnership");
		const legacy = callsNamed(clause, "inspectSettledFailureOwnership");
		expect.soft(importedFromLifecycle("captureSettledRunOwnership")).toBe(true);
		expect.soft(durable).toHaveLength(1);
		expect.soft(superseded, "capture and inspection have one durable owner").toHaveLength(0);
		expect.soft(legacy, "no legacy settled-failure inspector remains").toHaveLength(0);
		const context = durable[0]?.arguments[1];
		expect.soft(context !== undefined && containsIdentifier(context, "childPid")).toBe(true);
		expect.soft(context !== undefined && containsIdentifier(context, "profilePath")).toBe(true);
		expect.soft(context !== undefined && containsIdentifier(context, "controllerPid")).toBe(true);
		expect.soft(context !== undefined && containsIdentifier(context, "chromium")).toBe(true);
		expect.soft(context !== undefined && containsIdentifier(context, "executablePath")).toBe(true);
	});

	it.each(["runTuple", "runControl"])("%s binds finalization and delegates one closed profile disposition", (name) => {
		const declaration = namedFunction(name);
		const finalizers = callsNamed(declaration, "finalizeFailedRun");
		const finalizationName = boundCallName(finalizers[0]);
		const policies = callsNamed(declaration, "profileDispositionFor");
		const disposals = callsNamed(declaration, "disposeProfileWhenAllowed");
		expect.soft(importedFromLifecycle("profileDispositionFor")).toBe(true);
		expect.soft(importedFromLifecycle("disposeProfileWhenAllowed")).toBe(true);
		expect.soft(finalizers).toHaveLength(1);
		expect.soft(finalizationName, "shared finalizer observation has one local owner").toBeDefined();
		expect
			.soft(
				finalizationName !== undefined && policies.some((call) => containsIdentifier(call, finalizationName)),
				"failure disposition consumes the returned finalizer observation"
			)
			.toBe(true);
		expect.soft(policies.length, "pass/failure paths use the same closed disposition policy").toBeGreaterThanOrEqual(2);
		expect.soft(disposals, "finally delegates to the guarded disposal boundary").toHaveLength(1);
		expect.soft(directProfileRemovals(declaration), "no unconditional profile removal remains").toHaveLength(0);
	});
});

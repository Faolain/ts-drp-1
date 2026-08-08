import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { validCorrectiveCampaign } from "./fixtures/corrective-artifact-fixtures.js";
import { parseProcessForest } from "./fixtures/process-forest.js";
import {
	finalizeFailedRun,
	type FinalizeFailedRunInput,
	type RunFinalizationObservation,
} from "./fixtures/run-finalizer.js";
import {
	inspectSettledFailureOwnership,
	ownershipFromSettledFailure,
	SettledRunFailure,
} from "./fixtures/settled-failure-ownership.js";

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";
const PROFILE = "/tmp/phase-2b-control-profile-exact";
const CONTROLLER_PID = 901;
const CONTROLLER_PGID = 900;
const VALID_FOREST = [
	" 901 1 900 Fri Aug  7 16:00:00 2026 S node playwright-controller.js",
	" 410 901 410 Fri Aug  7 16:00:01 2026 S node settled-child.js",
	` 420 410 420 Fri Aug  7 16:00:02 2026 S chromium --user-data-dir=${PROFILE}`,
	" 421 420 420 Fri Aug  7 16:00:03 2026 S chromium --type=renderer",
	` 430 410 430 Fri Aug  7 16:00:04 2026 S chromium --user-data-dir=${PROFILE}-other`,
].join("\n");

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

function finalizeOwnership(
	ownership: ReturnType<typeof inspectSettledFailureOwnership>,
	killValidatedGroup: (pgid: number) => void
): RunFinalizationObservation {
	return finalizeFailedRun(
		{
			base: failureBase(),
			code: "SETUP_FAILED",
			detail: "SETUP_FAILED: injected post-launch control failure",
			ownedGroups: ownership.ownedGroups,
			partialEvidence: { recordedForest: ownership.recordedForest },
			stage: "hit",
			validatedGroups: ownership.validatedGroups,
		},
		{ killValidatedGroup, writeArtifact: (): void => undefined }
	);
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b settled failure ownership model", () => {
	it("proves only the exact profile-bound child/browser groups and excludes the controller", () => {
		const ownership = inspectSettledFailureOwnership(parseProcessForest(VALID_FOREST), 410, PROFILE, CONTROLLER_PID);
		expect(ownership.ownedGroups).toEqual([410, 420]);
		expect(ownership.validatedGroups).toEqual([410, 420]);
		expect(new Set(ownership.recordedForest.map(({ pgid }) => pgid))).toEqual(new Set([410, 420]));
		expect(ownership.recordedForest.some(({ pgid }) => pgid === CONTROLLER_PGID)).toBe(false);
	});

	it("never signals ambiguous profile groups and reports every discoverable owned group unresolved", () => {
		const ambiguous = parseProcessForest(
			`${VALID_FOREST}\n 440 410 440 Fri Aug  7 16:00:05 2026 S chromium --user-data-dir=${PROFILE}`
		);
		const ownership = inspectSettledFailureOwnership(ambiguous, 410, PROFILE, CONTROLLER_PID);
		const signaled: number[] = [];
		const observation = finalizeOwnership(ownership, (pgid): void => {
			signaled.push(pgid);
		});
		expect(ownership.validatedGroups).toEqual([]);
		expect(signaled).toEqual([]);
		expect(observation.unresolvedOwnedGroups).toEqual([410, 420, 440]);
		expect(observation.artifact.partialEvidence.cleanup).toEqual({
			validatedGroups: [],
			unresolvedOwnedGroups: [410, 420, 440],
		});
	});

	it("records successful cleanup separately from a validated group whose signal fails", () => {
		const ownership = inspectSettledFailureOwnership(parseProcessForest(VALID_FOREST), 410, PROFILE, CONTROLLER_PID);
		const signaled: number[] = [];
		const observation = finalizeOwnership(ownership, (pgid): void => {
			signaled.push(pgid);
			if (pgid === 420) throw new TypeError("injected signal failure");
		});
		expect(signaled).toEqual([410, 420]);
		expect(observation.cleanupKilledGroups).toEqual([410]);
		expect(observation.unresolvedOwnedGroups).toEqual([420]);
		expect(observation.artifact.partialEvidence.cleanup).toEqual({
			validatedGroups: [410],
			unresolvedOwnedGroups: [420],
		});
	});

	it("preserves structured ownership without treating ordinary errors as kill authority", () => {
		const ownership = inspectSettledFailureOwnership(parseProcessForest(VALID_FOREST), 410, PROFILE, CONTROLLER_PID);
		const wrapped = new SettledRunFailure(new TypeError("SETUP_FAILED: injected"), ownership);
		expect(ownershipFromSettledFailure(wrapped)).toBe(ownership);
		expect(ownershipFromSettledFailure(new TypeError("untrusted"))).toEqual({
			ownedGroups: [],
			recordedForest: [],
			validatedGroups: [],
		});
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

function importsOwnershipSeam(): boolean {
	return DRIVER_SOURCE.statements.some(
		(statement) =>
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === "./fixtures/settled-failure-ownership.js"
	);
}

function propertyAssignment(root: ts.Node, name: string): ts.PropertyAssignment | undefined {
	let assignment: ts.PropertyAssignment | undefined;
	const visit = (node: ts.Node): void => {
		if (
			assignment === undefined &&
			ts.isPropertyAssignment(node) &&
			((ts.isIdentifier(node.name) && node.name.text === name) ||
				(ts.isStringLiteral(node.name) && node.name.text === name))
		) {
			assignment = node;
		} else {
			ts.forEachChild(node, visit);
		}
	};
	visit(root);
	return assignment;
}

function accessesProperty(node: ts.Node | undefined, name: string): boolean {
	return (
		node !== undefined &&
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "failureOwnership" &&
		node.name.text === name
	);
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b settled failure integration RED", () => {
	it("runSettled preserves the structured ownership envelope without directly killing the child", () => {
		const clause = catchClauseOf(namedFunction("runSettled"));
		let structuredThrow: ts.NewExpression | undefined;
		let directKill: ts.CallExpression | undefined;
		const visit = (node: ts.Node): void => {
			if (
				ts.isNewExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "SettledRunFailure"
			) {
				structuredThrow = node;
			}
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === "child" &&
				node.expression.name.text === "kill"
			) {
				directKill = node;
			}
			ts.forEachChild(node, visit);
		};
		visit(clause);
		expect.soft(importsOwnershipSeam(), "actual driver imports the durable ownership seam").toBe(true);
		expect.soft(structuredThrow, "catch propagates groups instead of discarding them").toBeDefined();
		expect.soft(directKill, "the ownership envelope never grants a direct child.kill escape hatch").toBeUndefined();
	});

	it("runControl forwards structured owned/validated groups and reached forest to the shared finalizer", () => {
		const clause = catchClauseOf(namedFunction("runControl"));
		const extraction = callsNamed(clause, "ownershipFromSettledFailure");
		const finalizer = callsNamed(clause, "finalizeFailedRun")[0];
		expect.soft(extraction, "control catch unwraps the settled failure exactly once").toHaveLength(1);
		expect.soft(finalizer, "control catch retains the shared finalizer").toBeDefined();
		const extractionDeclaration = extraction[0]?.parent;
		expect
			.soft(
				extractionDeclaration !== undefined &&
					ts.isVariableDeclaration(extractionDeclaration) &&
					ts.isIdentifier(extractionDeclaration.name) &&
					extractionDeclaration.name.text === "failureOwnership",
				"ownership extraction has one stable local owner"
			)
			.toBe(true);
		const failureInput = finalizer?.arguments[0];
		expect
			.soft(
				accessesProperty(propertyAssignment(failureInput ?? clause, "ownedGroups")?.initializer, "ownedGroups"),
				"owned groups reach the finalizer"
			)
			.toBe(true);
		expect
			.soft(
				accessesProperty(propertyAssignment(failureInput ?? clause, "validatedGroups")?.initializer, "validatedGroups"),
				"only validated owned groups become signal authority"
			)
			.toBe(true);
		expect
			.soft(
				accessesProperty(propertyAssignment(clause, "recordedForest")?.initializer, "recordedForest"),
				"reached forest evidence is retained"
			)
			.toBe(true);
	});
});

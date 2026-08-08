import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { validCorrectiveCampaign } from "./fixtures/corrective-artifact-fixtures.js";
import type { ProcessIdentity } from "./fixtures/process-forest.js";
import { finalizeFailedRun, type FinalizeFailedRunInput } from "./fixtures/run-finalizer.js";
import * as settledRunLifecycle from "./fixtures/settled-run-lifecycle.js";

const { inspectSettledRunOwnership, profileDispositionFor } = settledRunLifecycle;
type SettledRunOwnershipContext = Parameters<typeof inspectSettledRunOwnership>[1];

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";
const PROFILE = "/tmp/phase-2b-cleanup-authority-profile";
const EXECUTABLE = "/Applications/Chromium Test.app/Contents/MacOS/Chromium";
const CONTROLLER_PID = 901;
const CHILD_PID = 410;
const BROWSER_PID = 420;

type OwnershipEvidenceState = "captured" | "unknown";

interface AuthorityContext extends SettledRunOwnershipContext {
	readonly priorOwnershipEvidenceState?: OwnershipEvidenceState;
	readonly trustedChildIdentity?: ProcessIdentity;
}

interface CorrectiveOwnershipContext extends AuthorityContext {
	readonly captureState: OwnershipEvidenceState;
}

type CaptureOwnershipInspector = (
	captureProcessForest: () => readonly ProcessIdentity[],
	context: AuthorityContext
) => ReturnType<typeof inspectSettledRunOwnership>;

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
	birthToken = `Fri Aug  7 21:00:${String(pid % 60).padStart(2, "0")} 2026`,
	state = "S"
): ProcessIdentity {
	return Object.freeze({ birthToken, command, pgid, pid, ppid, state });
}

const TRUSTED_CHILD = identity(CHILD_PID, CONTROLLER_PID, CHILD_PID, "node crash-child.js", "trusted-child-birth");

function directForest(
	child: ProcessIdentity = TRUSTED_CHILD,
	browserCommand = `${EXECUTABLE} --headless --user-data-dir=${PROFILE}`
): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, 900, "node playwright-controller.js", "controller-birth"),
		child,
		identity(BROWSER_PID, CHILD_PID, BROWSER_PID, browserCommand, "browser-birth"),
		identity(421, BROWSER_PID, BROWSER_PID, `${EXECUTABLE} --type=renderer`, "renderer-birth"),
	]);
}

function authorityContext(
	trustedChildIdentity?: ProcessIdentity,
	childPid = CHILD_PID,
	priorOwnershipEvidenceState?: OwnershipEvidenceState
): AuthorityContext {
	return {
		childPid,
		chromiumExecutablePath: EXECUTABLE,
		controllerPid: CONTROLLER_PID,
		profilePath: PROFILE,
		...(trustedChildIdentity === undefined ? {} : { trustedChildIdentity }),
		...(priorOwnershipEvidenceState === undefined ? {} : { priorOwnershipEvidenceState }),
	};
}

function context(
	captureState: CorrectiveOwnershipContext["captureState"],
	trustedChildIdentity?: ProcessIdentity,
	childPid = CHILD_PID
): CorrectiveOwnershipContext {
	return { captureState, ...authorityContext(trustedChildIdentity, childPid) };
}

function captureInspector(): CaptureOwnershipInspector | undefined {
	return (
		settledRunLifecycle as unknown as {
			readonly captureSettledRunOwnership?: CaptureOwnershipInspector;
		}
	).captureSettledRunOwnership;
}

function captureOwnership(
	captureProcessForest: () => readonly ProcessIdentity[],
	ownerContext: AuthorityContext
): ReturnType<typeof inspectSettledRunOwnership> {
	const durableInspector = captureInspector();
	expect
		.soft(durableInspector, "one durable seam must own capture failure and ownership inspection")
		.toBeTypeOf("function");
	if (durableInspector !== undefined) return durableInspector(captureProcessForest, ownerContext);

	let capture: Readonly<{
		forest: readonly ProcessIdentity[];
		state: CorrectiveOwnershipContext["captureState"];
	}>;
	try {
		capture = Object.freeze({ forest: captureProcessForest(), state: "captured" });
	} catch {
		capture = Object.freeze({ forest: Object.freeze([]), state: "unknown" });
	}
	const correctiveContext: CorrectiveOwnershipContext = { ...ownerContext, captureState: capture.state };
	return inspectSettledRunOwnership(capture.forest, correctiveContext);
}

function finalize(ownership: ReturnType<typeof inspectSettledRunOwnership>): {
	readonly signaled: readonly number[];
	readonly observation: ReturnType<typeof finalizeFailedRun>;
} {
	const signaled: number[] = [];
	const observation = finalizeFailedRun(
		{
			base: failureBase(),
			code: "SETUP_FAILED",
			detail: "SETUP_FAILED: injected cleanup-authority failure",
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
	return Object.freeze({ observation, signaled: Object.freeze(signaled) });
}

function evidenceState(ownership: ReturnType<typeof inspectSettledRunOwnership>): OwnershipEvidenceState {
	return (
		ownership as ReturnType<typeof inspectSettledRunOwnership> & {
			readonly evidenceState?: OwnershipEvidenceState;
		}
	).evidenceState as OwnershipEvidenceState;
}

function failedDisposition(
	ownership: ReturnType<typeof inspectSettledRunOwnership>,
	finalization: ReturnType<typeof finalizeFailedRun>
): ReturnType<typeof profileDispositionFor> {
	const completion = Object.freeze({
		kind: "failed-finalized" as const,
		finalization,
		ownershipEvidenceState: evidenceState(ownership),
	});
	return profileDispositionFor(completion);
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b corrective cleanup-authority contract", () => {
	it("keeps capture failure UNKNOWN and retains the failed run profile without signaling a numeric PID", () => {
		const captureProcessForest = (): readonly ProcessIdentity[] => {
			throw new TypeError("injected captureProcessForest failure");
		};
		const ownership = captureOwnership(captureProcessForest, authorityContext());
		const { observation, signaled } = finalize(ownership);

		expect
			.soft(evidenceState(ownership), "capture failure must not masquerade as a captured empty forest")
			.toBe("unknown");
		expect
			.soft(ownership.ownedGroups, "the spawned numeric group remains unresolved, never validated")
			.toEqual([CHILD_PID]);
		expect.soft(ownership.validatedGroups).toEqual([]);
		expect.soft(signaled).toEqual([]);
		expect
			.soft(observation.unresolvedOwnedGroups, "UNKNOWN evidence must not manufacture clean delete eligibility")
			.toEqual([CHILD_PID]);
		expect(failedDisposition(ownership, observation)).toBe("retain");
	});

	it("uses explicit UNKNOWN evidence to retain even when no valid spawned child PID exists", () => {
		const ownership = captureOwnership(
			() => {
				throw new TypeError("injected captureProcessForest failure before spawn identity");
			},
			authorityContext(undefined, -1)
		);
		const { observation, signaled } = finalize(ownership);

		expect.soft(evidenceState(ownership)).toBe("unknown");
		expect.soft(ownership.ownedGroups).toEqual([]);
		expect.soft(ownership.validatedGroups).toEqual([]);
		expect.soft(signaled).toEqual([]);
		expect.soft(observation.unresolvedOwnedGroups).toEqual([]);
		expect(failedDisposition(ownership, observation), "UNKNOWN itself denies profile deletion").toBe("retain");
	});

	it("keeps a genuinely captured empty forest delete-eligible", () => {
		const ownership = captureOwnership(() => Object.freeze([]), authorityContext(undefined, -1));
		const { observation, signaled } = finalize(ownership);

		expect.soft(evidenceState(ownership)).toBe("captured");
		expect.soft(ownership.ownedGroups).toEqual([]);
		expect.soft(ownership.validatedGroups).toEqual([]);
		expect.soft(signaled).toEqual([]);
		expect.soft(observation.unresolvedOwnedGroups).toEqual([]);
		expect(failedDisposition(ownership, observation)).toBe("remove");
	});

	it("propagates pure inspection errors after the capture effect succeeds", () => {
		const durableInspector = captureInspector();
		expect
			.soft(durableInspector, "the durable capture seam is required for exception-boundary proof")
			.toBeTypeOf("function");
		if (durableInspector === undefined) return;

		const inspectionError = new TypeError("injected pure ownership inspection failure");
		const throwingForest = new Proxy<readonly unknown[]>(Object.freeze([]), {
			get: (target, property, receiver): unknown => {
				if (property === "filter") throw inspectionError;
				return Reflect.get(target, property, receiver) as unknown;
			},
		}) as unknown as readonly ProcessIdentity[];
		let propagated: unknown;
		try {
			durableInspector(() => throwingForest, authorityContext());
		} catch (error) {
			propagated = error;
		}
		expect(propagated, "only the capture callback may be translated to UNKNOWN").toBe(inspectionError);
	});

	it("keeps incoming settled-role UNKNOWN dominant over a later trustworthy local capture", () => {
		const ownership = captureOwnership(() => directForest(), authorityContext(TRUSTED_CHILD, CHILD_PID, "unknown"));
		const { observation, signaled } = finalize(ownership);

		expect.soft(evidenceState(ownership)).toBe("unknown");
		expect.soft(ownership.validatedGroups).toEqual([CHILD_PID, BROWSER_PID]);
		expect.soft(signaled).toEqual([CHILD_PID, BROWSER_PID]);
		expect.soft(observation.unresolvedOwnedGroups).toEqual([]);
		expect(failedDisposition(ownership, observation), "a local capture cannot erase prior UNKNOWN").toBe("retain");
	});

	it.each([
		{
			label: "no trustworthy child identity",
			forestChild: TRUSTED_CHILD,
			trustedChild: undefined,
			expectedValidated: [BROWSER_PID],
			expectedUnresolved: [CHILD_PID],
		},
		{
			label: "PID reuse with a different birth token",
			forestChild: identity(CHILD_PID, CONTROLLER_PID, CHILD_PID, TRUSTED_CHILD.command, "reused-child-birth"),
			trustedChild: TRUSTED_CHILD,
			expectedValidated: [BROWSER_PID],
			expectedUnresolved: [CHILD_PID],
		},
		{
			label: "same PID and birth token but a different full identity",
			forestChild: identity(
				CHILD_PID,
				CONTROLLER_PID,
				CHILD_PID,
				"node replacement-child.js",
				TRUSTED_CHILD.birthToken
			),
			trustedChild: TRUSTED_CHILD,
			expectedValidated: [BROWSER_PID],
			expectedUnresolved: [CHILD_PID],
		},
		{
			label: "exact full child identity and birth token",
			forestChild: TRUSTED_CHILD,
			trustedChild: TRUSTED_CHILD,
			expectedValidated: [CHILD_PID, BROWSER_PID],
			expectedUnresolved: [],
		},
	])(
		"grants child-group authority only for $label while proving the exact browser independently",
		({ expectedUnresolved, expectedValidated, forestChild, trustedChild }) => {
			const ownership = inspectSettledRunOwnership(directForest(forestChild), context("captured", trustedChild));
			const { observation, signaled } = finalize(ownership);

			expect.soft(ownership.ownedGroups).toEqual([CHILD_PID, BROWSER_PID]);
			expect.soft(ownership.validatedGroups).toEqual(expectedValidated);
			expect.soft(signaled, "only exact, trustworthy group identities may be signaled").toEqual(expectedValidated);
			expect
				.soft(observation.unresolvedOwnedGroups, "every owned group outside signal authority remains unresolved")
				.toEqual(expectedUnresolved);
		}
	);

	it.each([
		{
			label: "profile prefix",
			command: `${EXECUTABLE} --user-data-dir=prefix${PROFILE}`,
		},
		{
			label: "profile suffix",
			command: `${EXECUTABLE} --user-data-dir=${PROFILE}-suffix`,
		},
		{
			label: "executable prefix wrapper",
			command: `/tmp/chromium-wrapper ${EXECUTABLE} --user-data-dir=${PROFILE}`,
		},
		{
			label: "executable suffix lookalike",
			command: `${EXECUTABLE}-wrapper --user-data-dir=${PROFILE}`,
		},
	])("rejects $label substring evidence as browser and child signal authority", ({ command }) => {
		const ownership = inspectSettledRunOwnership(directForest(TRUSTED_CHILD, command), context("captured"));
		const { observation, signaled } = finalize(ownership);

		expect.soft(ownership.ownedGroups).toEqual([CHILD_PID]);
		expect.soft(ownership.validatedGroups).toEqual([]);
		expect.soft(signaled).toEqual([]);
		expect(observation.unresolvedOwnedGroups).toEqual([CHILD_PID]);
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
const LIFECYCLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/settled-run-lifecycle.ts");
const LIFECYCLE_SOURCE = ts.createSourceFile(
	LIFECYCLE_PATH,
	fs.readFileSync(LIFECYCLE_PATH, "utf8"),
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

function outerCatchClauseOf(declaration: ts.FunctionDeclaration): ts.CatchClause {
	const statement = declaration.body?.statements.find(ts.isTryStatement);
	if (statement?.catchClause === undefined) {
		throw new TypeError(`missing function-level catch in ${declaration.name?.text ?? "function"}`);
	}
	return statement.catchClause;
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

function usesProfileSubstringAuthority(root: ts.Node): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "includes" &&
			node.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === "profilePath")
		) {
			found = true;
		} else {
			ts.forEachChild(node, visit);
		}
	};
	visit(root);
	return found;
}

function hasPropertyAssignment(root: ts.Node, name: string): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isPropertyAssignment(node) &&
			((ts.isIdentifier(node.name) && node.name.text === name) ||
				(ts.isStringLiteral(node.name) && node.name.text === name))
		) {
			found = true;
		} else {
			ts.forEachChild(node, visit);
		}
	};
	visit(root);
	return found;
}

function failedFinalizedEvidenceMember(): ts.PropertySignature | undefined {
	const alias = LIFECYCLE_SOURCE.statements.find(
		(statement): statement is ts.TypeAliasDeclaration =>
			ts.isTypeAliasDeclaration(statement) && statement.name.text === "RunCompletion"
	);
	if (alias === undefined || !ts.isUnionTypeNode(alias.type)) return undefined;
	for (const candidate of alias.type.types) {
		const literal = ts.isTypeLiteralNode(candidate)
			? candidate
			: ts.isTypeReferenceNode(candidate) &&
				  ts.isIdentifier(candidate.typeName) &&
				  candidate.typeName.text === "Readonly" &&
				  candidate.typeArguments?.length === 1 &&
				  ts.isTypeLiteralNode(candidate.typeArguments[0])
				? candidate.typeArguments[0]
				: undefined;
		if (literal === undefined) continue;
		const kind = literal.members.find(
			(member): member is ts.PropertySignature =>
				ts.isPropertySignature(member) &&
				ts.isIdentifier(member.name) &&
				member.name.text === "kind" &&
				member.type !== undefined &&
				ts.isLiteralTypeNode(member.type) &&
				ts.isStringLiteral(member.type.literal) &&
				member.type.literal.text === "failed-finalized"
		);
		if (kind === undefined) continue;
		return literal.members.find(
			(member): member is ts.PropertySignature =>
				ts.isPropertySignature(member) && ts.isIdentifier(member.name) && member.name.text === "ownershipEvidenceState"
		);
	}
	return undefined;
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b cleanup-authority integration", () => {
	it("makes failed-finalized ownership evidence state a required completion field", () => {
		const evidenceMember = failedFinalizedEvidenceMember();
		expect.soft(evidenceMember, "failed-finalized completion declares ownershipEvidenceState").toBeDefined();
		expect.soft(evidenceMember?.questionToken, "ownershipEvidenceState is not optional").toBeUndefined();
	});

	it("makes runTuple delegate catch-path authority to the durable inspector", () => {
		const settledClause = outerCatchClauseOf(namedFunction("runSettled"));
		const tupleClause = outerCatchClauseOf(namedFunction("runTuple"));
		const controlClause = outerCatchClauseOf(namedFunction("runControl"));
		expect.soft(callsNamed(settledClause, "captureSettledRunOwnership")).toHaveLength(1);
		expect.soft(callsNamed(tupleClause, "captureSettledRunOwnership")).toHaveLength(1);
		expect
			.soft(callsNamed(tupleClause, "processClosure"), "runTuple no longer owns a numeric-PID closure validator")
			.toHaveLength(0);
		expect
			.soft(callsNamed(tupleClause, "validateTwoGroupForest"), "runTuple no longer owns a parallel two-group validator")
			.toHaveLength(0);
		expect
			.soft(usesProfileSubstringAuthority(tupleClause), "runTuple no longer owns profile-substring authority")
			.toBe(false);
		expect
			.soft(
				hasPropertyAssignment(tupleClause, "ownershipEvidenceState"),
				"the durable evidence state reaches tuple profile disposition"
			)
			.toBe(true);
		expect
			.soft(
				hasPropertyAssignment(controlClause, "ownershipEvidenceState"),
				"the durable evidence state reaches discovery/arming profile disposition"
			)
			.toBe(true);
	});
});

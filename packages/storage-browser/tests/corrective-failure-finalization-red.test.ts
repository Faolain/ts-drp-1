import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
	type FailureArtifact,
	type ParentFailureCode,
	parseFailureArtifact,
	type PassArtifact,
	type RunStage,
} from "./fixtures/artifacts.js";
import { validCorrectiveCampaign } from "./fixtures/corrective-artifact-fixtures.js";
import {
	finalizeFailedRun,
	type FinalizeFailedRunInput,
	type PartialFailureEvidence,
} from "./fixtures/run-finalizer.js";

const CLEAN_SNAPSHOT_CHILD = process.env.PHASE_2B_CLEAN_SNAPSHOT_CHILD === "1";

interface FailureCase {
	readonly code: ParentFailureCode;
	readonly expectedEvidenceKeys: readonly (keyof PartialFailureEvidence)[];
	readonly label: string;
	readonly partialEvidence: Omit<PartialFailureEvidence, "cleanup">;
	readonly passArtifact: PassArtifact;
	readonly stage: RunStage;
}

const CAMPAIGN = validCorrectiveCampaign();
const TUPLE = CAMPAIGN.find((artifact) => artifact.runKind === "tuple" && artifact.observedHits.length === 9);
const DISCOVERY = CAMPAIGN.find((artifact) => artifact.runKind === "discovery");
const ARMING = CAMPAIGN.find((artifact) => artifact.runKind === "arming");
if (TUPLE?.runKind !== "tuple" || DISCOVERY?.runKind !== "discovery" || ARMING?.runKind !== "arming") {
	throw new TypeError("corrective failure fixtures are incomplete");
}

const FAILURE_CASES: readonly FailureCase[] = Object.freeze([
	{
		label: "tuple seed failure",
		passArtifact: TUPLE,
		stage: "seed",
		code: "SETUP_FAILED",
		partialEvidence: Object.freeze({}),
		expectedEvidenceKeys: Object.freeze(["cleanup"] as const),
	},
	{
		label: "tuple hit failure",
		passArtifact: TUPLE,
		stage: "hit",
		code: "CHILD_PROTOCOL",
		partialEvidence: Object.freeze({
			settledChildren: Object.freeze([TUPLE.settledChildren[0]]),
			observedHits: TUPLE.observedHits,
		}),
		expectedEvidenceKeys: Object.freeze(["cleanup", "observedHits", "settledChildren"] as const),
	},
	{
		label: "tuple recovery failure",
		passArtifact: TUPLE,
		stage: "recovery",
		code: "RECOVERY_MIXED",
		partialEvidence: Object.freeze({
			settledChildren: Object.freeze([TUPLE.settledChildren[0]]),
			observedHits: TUPLE.observedHits,
			recordedForest: TUPLE.recordedForest,
			recoveryClassification: Object.freeze({ state: "mixed" as const, digest: "mixed-diagnostic" }),
		}),
		expectedEvidenceKeys: Object.freeze([
			"cleanup",
			"observedHits",
			"recordedForest",
			"recoveryClassification",
			"settledChildren",
		] as const),
	},
	{
		label: "discovery hit failure",
		passArtifact: DISCOVERY,
		stage: "hit",
		code: "DURABILITY_PROVENANCE",
		partialEvidence: Object.freeze({
			settledChildren: Object.freeze([DISCOVERY.settledChildren[0]]),
			observedHits: Object.freeze(DISCOVERY.observedHits.slice(0, 4)),
		}),
		expectedEvidenceKeys: Object.freeze(["cleanup", "observedHits", "settledChildren"] as const),
	},
	{
		label: "arming recovery failure",
		passArtifact: ARMING,
		stage: "recovery",
		code: "RECOVERY_MIXED",
		partialEvidence: Object.freeze({
			settledChildren: Object.freeze([ARMING.settledChildren[0], ARMING.settledChildren[1]]),
			observedHits: ARMING.observedHits,
			recoveryClassification: Object.freeze({ state: "mixed" as const, digest: "mixed-diagnostic" }),
		}),
		expectedEvidenceKeys: Object.freeze([
			"cleanup",
			"observedHits",
			"recoveryClassification",
			"settledChildren",
		] as const),
	},
]);

function failureBase(artifact: PassArtifact): FinalizeFailedRunInput["base"] {
	return Object.freeze({
		schemaVersion: artifact.schemaVersion,
		browser: artifact.browser,
		databaseName: artifact.databaseName,
		expectedDigests: artifact.expectedDigests,
		gitSha: artifact.gitSha,
		objectId: artifact.objectId,
		platform: artifact.platform,
		profilePath: artifact.profilePath,
		runId: artifact.runId,
		runKind: artifact.runKind,
	});
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b corrective failure finalization runtime contract", () => {
	it.each(FAILURE_CASES)("$label writes one parser-accepted truthful artifact with no future evidence", (candidate) => {
		const written: unknown[] = [];
		const killed: number[] = [];
		const observation = finalizeFailedRun(
			{
				base: failureBase(candidate.passArtifact),
				stage: candidate.stage,
				code: candidate.code,
				detail: `${candidate.code}: injected ${candidate.label}`,
				partialEvidence: candidate.partialEvidence,
				ownedGroups: [],
				validatedGroups: [],
			},
			{
				writeArtifact: (artifact): void => {
					written.push(artifact);
				},
				killValidatedGroup: (pgid): void => {
					killed.push(pgid);
				},
			}
		);
		expect(written).toHaveLength(1);
		expect(written[0]).toBe(observation.artifact);
		let parseError: unknown;
		try {
			parseFailureArtifact(written[0]);
		} catch (error) {
			parseError = error;
		}
		expect.soft(parseError, "closed failure parser must accept reached partial evidence").toBeUndefined();
		expect.soft(observation.artifact.stage).toBe(candidate.stage);
		expect.soft(observation.artifact.code).toBe(candidate.code);
		expect
			.soft(Object.keys(observation.artifact.partialEvidence).sort())
			.toEqual([...candidate.expectedEvidenceKeys].sort());
		expect.soft(killed).toEqual([]);
	});

	it("owns writer cardinality and kills only validated owned groups while reporting unresolved ownership", () => {
		const written: FailureArtifact[] = [];
		const killed: number[] = [];
		const observation = finalizeFailedRun(
			{
				base: failureBase(TUPLE),
				stage: "freeze",
				code: "FOREST_CONTRADICTION",
				detail: "FOREST_CONTRADICTION: injected partial validation",
				partialEvidence: { settledChildren: [TUPLE.settledChildren[0]], observedHits: TUPLE.observedHits },
				ownedGroups: [401, 402],
				validatedGroups: [401, 999],
			},
			{
				writeArtifact: (artifact): void => {
					written.push(artifact);
				},
				killValidatedGroup: (pgid): void => {
					killed.push(pgid);
				},
			}
		);
		expect(written).toHaveLength(1);
		expect(killed).toEqual([401]);
		expect(observation.unresolvedOwnedGroups).toEqual([402]);
		expect(observation.artifact.partialEvidence.cleanup).toEqual({
			validatedGroups: [401],
			unresolvedOwnedGroups: [402],
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
	if (declaration === undefined) throw new TypeError(`missing ${name} function declaration`);
	return declaration;
}

function callsFinalizerInCatch(root: ts.Node): boolean {
	let reached = false;
	const findCall = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "finalizeFailedRun") {
			reached = true;
		}
		ts.forEachChild(node, findCall);
	};
	const findCatch = (node: ts.Node): void => {
		if (ts.isCatchClause(node)) findCall(node.block);
		else ts.forEachChild(node, findCatch);
	};
	findCatch(root);
	return reached;
}

describe.skipIf(CLEAN_SNAPSHOT_CHILD)("Phase 2b corrective finalizer integration seam", () => {
	it("retains both actual run entry points as bounded AST controls", () => {
		expect(namedFunction("runTuple").name?.text).toBe("runTuple");
		expect(namedFunction("runControl").name?.text).toBe("runControl");
	});

	it("imports the required corrective finalizer into the actual crash driver", () => {
		const importsFinalizer = DRIVER_SOURCE.statements.some(
			(statement) =>
				ts.isImportDeclaration(statement) &&
				ts.isStringLiteral(statement.moduleSpecifier) &&
				statement.moduleSpecifier.text === "./fixtures/run-finalizer.js"
		);
		expect(importsFinalizer).toBe(true);
	});

	it.each(["runTuple", "runControl"])("routes the %s catch path through the required corrective finalizer", (name) => {
		expect(callsFinalizerInCatch(namedFunction(name))).toBe(true);
	});
});

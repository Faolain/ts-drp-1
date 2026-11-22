/* eslint-disable @typescript-eslint/explicit-function-return-type -- Premise stubs for the extracted private classifiers. */
import { decodeCanonical } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// fix/browser-rollover-member-stall, box m45 run rcd5 (red-cold on the probe build 2071e060, 1 of 10):
// the creator was SIGKILLed right after its recovery maintenance saved an ACTIVE AHE retirement
// preparation for closed epoch 3 and before any participant staged it. On reopen every source part
// re-derived byte for byte (summary, floor, rows, snapshots, journal, issuance, signing data), but the
// signing classification flipped from a SAME-P summary source to none, so the source proof differed
// and the closed-retirement law refused chain-invalid ("creator snapshot role reconciliation refused").
//
// The preparation was derived while the coordinator had no active preparation (a derivation with one
// only resumes it), on the coordinator's completed decision; preparing keeps everything else. The
// signing classification read the coordinator's ACTIVE labels whenever present, so a resume before the
// signing participant joined compared the signing control's completed decision with the new active
// labels: no SAME-P match, and the fresh path declined. A resume must classify on the coordinator the
// preparation was derived on, until the participant joins it (stages it or completes it).
//
// This executes the private production classifier on data: the signing rows' decoding, image checks
// and accounting are premises here.
const path = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
function declarations(name: string): ts.FunctionDeclaration[] {
	const found: ts.FunctionDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return found;
}
function declaration(name: string): string {
	const found = declarations(name);
	const [only] = found;
	if (found.length !== 1 || only === undefined) throw Error(`PRIVATE_FUNCTION_NOT_UNIQUE:${name}:${found.length}`);
	return only.getText(parsed);
}
// The fix's helper is absent at the RED base; the classifier itself is always present.
const names = [
	"classifyClosedSigningSummaries",
	"classifyClosedSigningEvidence",
	...["closedSigningClassificationCoordinator"].filter((name) => declarations(name).length === 1),
];
const code = names.map(declaration).join("\n");

type Labels = { decisionDigest: string; sourceProofDigest: string };
type SigningPreparation = Labels & { throughEpoch: number; protectedEpochs: number[]; summarySource?: unknown };
type SigningControl = {
	active: null | { sequence: number; preparation: SigningPreparation; sourceImageDigest: string };
	completed: SigningPreparation | null;
	drain: null | {
		plan: { kind: string; baseControl: { completed: SigningPreparation }; entries: unknown[] } & Record<
			string,
			unknown
		>;
		cursor: number;
	};
};
let control: SigningControl | null = null;
const context = {
	decodeCanonical,
	closedSigningControl: () => control,
	closedSigningDataRows: () => [],
	requireLaw: (condition: unknown, kind = "internal-invariant") => {
		if (!condition) throw Error(kind);
	},
	closedRetirementBytes: (value: unknown) => new TextEncoder().encode(JSON.stringify(value)),
	closedRetirementEqual: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
	isSigningSummaryRetirementPlan: (plan: { kind?: string }) => plan.kind === "summary",
	checkClosedSigningSummaryImage: () => undefined,
	// Residual summary selection over the (here empty) signing frames.
	compareSigningSummaryRetirementEntries: () => 0,
	signingRetirementFrameDigest: () => "frame",
	selectClosedSigningSummaryEpoch: (entries: unknown) => entries,
	signingRetirementDataDigest: () => "data",
	authenticateClosedSigningSummaryEpoch: () => true,
};
const { classifyClosedSigningSummaries, classifyClosedSigningEvidence } = Function(
	...Object.keys(context),
	`"use strict";${
		ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } })
			.outputText
	}return { classifyClosedSigningSummaries, classifyClosedSigningEvidence };`
)(...Object.values(context)) as {
	classifyClosedSigningSummaries(input: unknown): unknown;
	classifyClosedSigningEvidence(input: unknown): unknown;
};

// Closed epoch 3 at floor epoch 4. P2: the completed decision both stores hold (a summary pass whose
// stored summary source the next pass continues); P3: the preparation the killed pass saved.
const SUMMARY = {
	entries: [{ store: "signerState", key: ["object", 2, "signer"], frameDigest: "f" }],
	resumeBasisDigest: "r2",
	sourceDataDigest: "sd2",
	eligibilityFence: { throughEpoch: 2, protectedEpochs: [] },
};
const SUMMARY_3 = {
	entries: [{ store: "signerState", key: ["object", 3, "signer"], frameDigest: "g" }],
	resumeBasisDigest: "r3",
};
const P2: Labels = { decisionDigest: "d2", sourceProofDigest: "s2" };
const P3: Labels = { decisionDigest: "d3", sourceProofDigest: "s3" };
const signing = (labels: Labels, summarySource: unknown): SigningPreparation => ({
	...labels,
	throughEpoch: 3,
	protectedEpochs: [],
	summarySource,
});
const coordinator = (active: Labels | null) => ({
	kind: "ahe-retirement-control-3",
	objectId: "object",
	incarnation: "i",
	revision: 7,
	sequence: 3,
	completed: { ...P2, throughEpoch: 3, snapshotHoles: [], generationHoles: [] },
	active: active === null ? null : { sequence: 3, phase: "prepared", preparation: active },
});
const inputFor = (active: Labels | null) => ({
	objectId: "object",
	rows: [],
	trusts: [],
	reader: {},
	journal: { protectedReplayScopes: [], collectiblePrefixes: [] },
	unclassified: false,
	coordinator: coordinator(active),
	summary: { floor: { epoch: 4 } },
	accounting: { charge: () => true },
});
const classify = (active: Labels | null): unknown => classifySummaries(active);
const classifySummaries = (active: Labels | null): unknown => classifyClosedSigningSummaries(inputFor(active));
// The evidence classifier's outcome, or the refusal it throws.
const classifyEvidence = (active: Labels | null): unknown => {
	try {
		return classifyClosedSigningEvidence(inputFor(active));
	} catch (error) {
		return { refused: String(error) };
	}
};

describe("a resumed closed-retirement preparation classifies its signing source as it was prepared", () => {
	it("before the signing participant joins, an active preparation classifies on the coordinator it was derived on", () => {
		control = { active: null, completed: signing(P2, SUMMARY), drain: null };
		const prepared = classify(null);
		expect(prepared, "the live pass continues P2's summary source").toEqual(SUMMARY);
		expect(classify(P3), "the reopened pass, P3 active and not yet staged by the signing store").toEqual(prepared);
	});

	it("a signing store that staged the active preparation resumes that preparation's own summary source", () => {
		control = {
			active: { sequence: 4, preparation: signing(P3, SUMMARY_3), sourceImageDigest: "x" },
			completed: signing(P2, SUMMARY),
			drain: null,
		};
		expect(classify(P3)).toEqual(SUMMARY_3);
	});

	it("after a terminal SAME-P summary drain, the evidence classification of an unjoined active preparation is the prepared one", () => {
		// P2 was a summary drain, finished; the live pass classified no summary source and no evidence.
		control = {
			active: null,
			completed: signing(P2, SUMMARY),
			drain: { plan: { kind: "summary", baseControl: { completed: signing(P2, SUMMARY) }, ...SUMMARY }, cursor: 1 },
		};
		expect(classifySummaries(null)).toBeUndefined();
		expect(classifySummaries(P3)).toBeUndefined();
		const prepared = classifyEvidence(null);
		expect(prepared).toEqual({ rows: [], reconstructed: false, entries: [] });
		expect(classifyEvidence(P3), "the reopened pass, P3 active and not yet staged by the signing store").toEqual(
			prepared
		);
	});

	it("a signing store that completed the active preparation resumes it from its completion", () => {
		control = { active: null, completed: signing(P3, SUMMARY_3), drain: null };
		expect(classify(P3)).toEqual(SUMMARY_3);
	});
});

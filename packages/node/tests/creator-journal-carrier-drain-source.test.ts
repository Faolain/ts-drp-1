import { readFileSync } from "node:fs";

import { encodeCanonical } from "@ts-drp/canonical";
import ts from "typescript";
import { expect, it } from "vitest";

// A journal mid-drain is read with drainSource: the adapter's reconstruction of the pre-drain journal
// (control, image and every original row) from this same read's control (the plan carries the retired
// frames), image and residual rows. The journal observation carrier encoded it beside those same
// inputs, so a mid-drain capture held the journal about twice (residual rows + plan + all original
// rows) under the carrier's single encode cap (786,432). drainSource is a deterministic function of
// (control, image, rows) inside one adapter, so the carrier holds those inputs once, and readiness
// sizes the carrier the same way (no drainSource term). Sites that need the original keep using the
// adapter's own read.drainSource; no node-side reconstruction and no new trust path.

const CARRIER_CAP = 786_432;
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");

function carriersFunction(): (input: unknown) => readonly unknown[] {
	const ast = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
	const declaration = ast.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "creatorIssuanceMaintenanceObservationCarriers");
	if (declaration === undefined) throw new TypeError("journal observation carrier builder missing");
	return new Function(`${ts.transpile(declaration.getText(ast), { target: ts.ScriptTarget.ES2022 })};
		return creatorIssuanceMaintenanceObservationCarriers;`)() as (input: unknown) => readonly unknown[];
}

it("a mid-drain journal's observation carrier holds its rows once: no reconstructed drainSource beside them", () => {
	const frame = (index: number): Uint8Array => new Uint8Array(1_000).fill(index % 251);
	// 700 original rows (~0.7 MB), the first 300 retired: the plan carries their frames, 400 remain.
	const original = Array.from({ length: 700 }, (_, index) => frame(index));
	const residual = original.slice(300);
	const plan = { prefixes: [{ rows: original.slice(0, 300).map((bytes, index) => ({ journalSequence: index, exactCanonicalNativeFrameBytes: bytes })) }] };
	const control = { kind: "v3-live-journal-retirement-control-2", drain: { plan, cursor: 300, batches: 19, residualImageDigest: "ab".repeat(32) } };
	const image = { imageDigest: "ab".repeat(32), scopeCount: 4, rowCount: 400, byteCharge: 400_000 };
	const journal = { control, image, canonicalRows: residual,
		drainSource: { control: { kind: "v3-live-journal-retirement-control-2", drain: null }, image: { ...image, rowCount: 700 }, canonicalRows: original } };
	const [wrapper] = carriersFunction()({ journal, snapshot: null, ahe: null, floor: null, floorImage: null, snapshotInventory: null });
	expect(Object.keys(wrapper as object)).toEqual(["control", "image", "canonicalRows"]);
	const wide = { maxBytes: 64 * 1024 * 1024, maxItems: 10_000_000, maxDepth: 128 };
	// Before: residual + plan + every original row is about twice the journal and over the cap.
	expect(encodeCanonical({ control, image, canonicalRows: residual, drainSource: journal.drainSource }, wide).byteLength).toBeGreaterThan(CARRIER_CAP);
	expect(encodeCanonical(wrapper, wide).byteLength).toBeLessThanOrEqual(CARRIER_CAP);
});

it("readiness sizes the journal carrier as it is encoded: no drainSource term", () => {
	expect(source).not.toContain("drainSource: journalDrainSource");
	expect(source).not.toContain("const journalDrainSource");
	expect(source).not.toContain("canonicalRows: journal.canonicalRows, ...drain}");
	expect(source).not.toContain("...(capture.journal.drainSource === undefined ? {} : { drainSource: capture.journal.drainSource }),");
	expect(source).not.toContain("...(originalJournal.drainSource === undefined ? {} : {drainSource: resource(originalJournal.drainSource)})}");
});

import { readFileSync } from "node:fs";

import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import ts from "typescript";
import { expect, it } from "vitest";

// fix/maintenance-image-capacity (i), item 4: the maintenance capture keeps an in-memory copy of a mid-drain
// read's drainSource (the adapter's reconstruction of the pre-drain journal) only so the raw supplement sizing
// (creatorOrdinaryJournalRawSupplementForSizing) can charge the resumed close's reconstructed rows. It must never
// reach an encoder or a persisted carrier: encoded beside the residual journal it holds the journal about twice
// under the one 786,432-byte encode cap (CLOSED_RETIREMENT_BYTES), which refuses a mid-drain close.

const CAP = { maxBytes: 786_432, maxItems: 65_536, maxDepth: 128 };
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
// Every encoder in the owner: the canonical codec, its cap-bound wrapper, digests over encoded bytes, width
// measurement, and the decode(encode(...)) detach helpers.
const ENCODERS = new Set(["encodeCanonical", "closedRetirementBytes", "closedRetirementDigest", "maintenanceCanonicalWidth",
	"closedObservationCarrierBytes", "detach"]);
const CAPTURE = /(^|\.)(capture|captured|originalCapture|maintenanceCapture)$/u;

function declaration(name: string): string {
	const found = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (found === undefined) throw new Error(`missing source owner ${name}`);
	return found.getText(parsed);
}
const unwrap = (node: ts.Expression): ts.Expression =>
	ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

it("no encoder receives a maintenance capture's journal whole (its in-memory drainSource stays unencoded)", () => {
	const offenders: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ENCODERS.has(node.expression.text))
			for (const argument of node.arguments) {
				const value = unwrap(argument);
				if (ts.isPropertyAccessExpression(value) && value.name.text === "journal" && CAPTURE.test(unwrap(value.expression).getText(parsed)))
					offenders.push(`${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText(parsed).slice(0, 80)}`);
			}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	expect(offenders).toEqual([]);
});

it("the capture journal detach encodes only the observed fields and carries the in-memory drainSource beside them", () => {
	const encoded: unknown[] = [];
	const closedRetirementBytes = (value: unknown) => { encoded.push(value); return encodeCanonical(value, CAP); };
	const detachClosedCaptureJournal = new Function("decodeCanonical", "closedRetirementBytes",
		`${ts.transpile(declaration("detachClosedCaptureJournal"), { target: ts.ScriptTarget.ES2022 })}; return detachClosedCaptureJournal;`)(
		decodeCanonical, closedRetirementBytes) as <T>(journal: T) => T;
	const rows = Array.from({ length: 3 }, (_, index) => Uint8Array.of(index, 7));
	const observed = { control: { revision: 4, drain: { cursor: 1 } }, exactCanonicalControlCarriers: [Uint8Array.of(9)],
		image: { imageDigest: "d".repeat(64), scopeCount: 2, rowCount: 3, byteCharge: 99 }, canonicalRows: rows };
	const drainSource = Object.freeze({ control: { revision: 3, drain: null }, image: { imageDigest: "e".repeat(64) },
		canonicalRows: Object.freeze([...rows, Uint8Array.of(5, 5)]) });
	const detached = detachClosedCaptureJournal({ ...observed, drainSource }) as typeof observed & { drainSource?: unknown };
	// The encoder saw the observed fields only, byte-identical to a journal that never had a drainSource.
	expect(encoded).toHaveLength(1);
	expect(Object.keys(encoded[0] as object).sort()).toEqual(Object.keys(observed).sort());
	expect(encodeCanonical(encoded[0], CAP)).toEqual(encodeCanonical(observed, CAP));
	// The detached copy is independent of the capture; the in-memory reconstruction is the capture's own frozen copy.
	expect({ ...detached, drainSource: undefined }).toEqual({ ...observed, drainSource: undefined });
	expect(detached.canonicalRows[0]).not.toBe(rows[0]);
	expect(detached.drainSource).toBe(drainSource);
	// A journal with no drain detaches exactly as before (no drainSource key appears).
	encoded.length = 0;
	const plain = detachClosedCaptureJournal(observed);
	expect(Object.hasOwn(plain, "drainSource")).toBe(false);
	expect(encodeCanonical(plain, CAP)).toEqual(encodeCanonical(observed, CAP));
});

it("the journal observation carrier drops drainSource: its bytes equal the no-drain carrier's", () => {
	const carriers = new Function(`${ts.transpile(declaration("creatorIssuanceMaintenanceObservationCarriers"),
		{ target: ts.ScriptTarget.ES2022 })}; return creatorIssuanceMaintenanceObservationCarriers;`)() as
		(input: Record<string, unknown>) => readonly unknown[];
	const journal = { control: null, image: { imageDigest: "a".repeat(64) }, canonicalRows: [Uint8Array.of(1)] };
	const rest = { snapshot: 1, ahe: 2, floor: 3, floorImage: 4, snapshotInventory: 5 };
	const withDrain = carriers({ journal: { ...journal, drainSource: { control: null, image: {}, canonicalRows: [Uint8Array.of(2)] } }, ...rest });
	expect(Object.keys(withDrain[0] as object)).toEqual(["control", "image", "canonicalRows"]);
	expect(encodeCanonical(withDrain, CAP)).toEqual(encodeCanonical(carriers({ journal, ...rest }), CAP));
});

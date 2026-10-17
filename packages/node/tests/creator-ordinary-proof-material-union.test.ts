import {readFileSync} from "node:fs";
import {compareBytes, encodeCanonical} from "@ts-drp/canonical";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Original private book and both actual numerical expressions. This is a
// resource-union regression, not an authentication or native-currency fixture.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const node = tree.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name);
	if (!node) throw new Error(`missing original owner: ${name}`);
	return node.getText(tree).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as T;
}
const expressions: {scalar?: string; program?: string} = {};
function visit(node: ts.Node): void {
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "allCurrentRaw")
		expressions.scalar = node.initializer!.getText(tree);
	if (ts.isCallExpression(node) && node.expression.getText(tree) === "parameters.set" &&
		ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "book.wholeCurrentRaw")
		expressions.program = node.arguments[1].getText(tree);
	ts.forEachChild(node, visit);
} visit(tree);
if (!expressions.scalar || !expressions.program) throw new Error("missing original scalar/program book input");
const material = execute<(facts: any, knownCarriers: readonly Uint8Array[]) => readonly number[]>(`
	${declaration("maintenanceWidthSum")}
	return (facts, knownCarriers) => {const sum=(...values)=>maintenanceWidthSum(values);
	 return [${expressions.scalar},${expressions.program}];};`, {CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 4_194_304});
function fixture() {
	const proofMaterialOwners = new WeakMap<object, any>();
	const create = execute<(initial: any[]) => any>(`${declaration("createCreatorClosedRollbackProofAccounting")}
	 return createCreatorClosedRollbackProofAccounting;`, {proofMaterialOwners, compareBytes,
		closedRetirementEqual: (a: unknown, b: unknown) => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0,
		CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 4_194_304, CREATOR_ORDINARY_PROOF_MAX_BYTES: 1_310_720});
	const accounting = create([]), owner = proofMaterialOwners.get(accounting)!;
	return {accounting, owner};
}
describe("same-owner ordinary whole material union", () => {
	it("counts protected annotations once while retaining complete standalone PRE and its distinct wrapped occurrence", () => {
		const {accounting, owner} = fixture();
		const preimage = encodeCanonical({kind: "drp-vertex", operation: {action: "installRoster", bytes: new Uint8Array(8334).fill(7)}});
		const signature = new Uint8Array(64).fill(9), wrapper = encodeCanonical({control: null, canonicalRows: [preimage], signature});
		expect(owner.chargeObservation(wrapper)).toBe(true);
		expect(owner.chargeObservation(preimage)).toBe(true);
		expect(accounting.charge(preimage.slice())).toBe(true); // Promotes the same exact sequence, not another encoding.
		expect(accounting.charge(signature)).toBe(true);
		expect(accounting.chargeUnknownEncodedLength(128)).toBe(true);
		expect(accounting.chargeUnknownEncodedLength(128)).toBe(true); // UNKNOWN occurrences never dedup.
		const totals = owner.captureKnownResourceTotals();
		expect(totals).toEqual({knownBytes: wrapper.byteLength + preimage.byteLength + 64,
			protectedBytes: preimage.byteLength + 64, unknownEncodedBytes: 256});
		expect(totals.knownBytes + totals.unknownEncodedBytes).toBe(accounting.chargedBytes);
		const candidate = encodeCanonical({operation: {action: "placeBlock", x: 1}}), known = [candidate, preimage.slice()];
		const [scalar, program] = material({knownResourceTotals: totals}, known);
		expect(scalar).toBe(totals.knownBytes + totals.unknownEncodedBytes + candidate.byteLength + preimage.byteLength);
		expect(program).toBe(scalar);
		// SAME original full factory projects ONE union, choosing whole/protected.
		// Positive sizing may retain an already-known candidate twice, but never
		// needs to add the entire protected subset again to dominate that owner.
		expect(scalar).toBeGreaterThanOrEqual(owner.projectByteLengths(known).whole);
		expect(scalar).toBeGreaterThanOrEqual(owner.projectByteLengths(known).protected);
		expect(owner.captureKnownMaterial()).toContainEqual(preimage);
		expect(owner.captureKnownMaterial()).toContainEqual(wrapper);
		expect(owner.captureKnownProtectedMaterial()).toContainEqual(preimage);
	});
	it("protection promotion changes no root, and repeated UNKNOWN remains in both roots without refund", () => {
		const {accounting, owner} = fixture(), raw = encodeCanonical({actual: "raw"});
		expect(owner.chargeObservation(raw)).toBe(true);
		const initial = material({knownResourceTotals: owner.captureKnownResourceTotals()}, []);
		expect(accounting.charge(raw.slice())).toBe(true);
		expect(owner.captureKnownResourceTotals().protectedBytes).toBe(raw.byteLength);
		expect(material({knownResourceTotals: owner.captureKnownResourceTotals()}, [])).toEqual(initial);
		expect(accounting.chargeUnknownEncodedLength(65_536)).toBe(true);
		expect(accounting.chargeUnknownEncodedLength(65_536)).toBe(true);
		expect(material({knownResourceTotals: owner.captureKnownResourceTotals()}, [])).toEqual(initial.map(value => value + 131_072));
		expect(accounting.chargedBytes).toBe(raw.byteLength + 131_072);
	});
});

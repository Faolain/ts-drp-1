import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const path = "examples/v3-room/src/index.ts";
const source = readFileSync(path, "utf8");

/**
 * Select the unique real call and reject any unresolved argument structure.
 * @param file
 * @param name
 */
function call(file: ts.SourceFile, name: string): ts.CallExpression {
	const matches: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name)
			matches.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	if (matches.length !== 1) throw new Error(`CALLSITE_NOT_UNIQUE:${name}:${matches.length}`);
	return matches[0] as ts.CallExpression;
}

/**
 * Require one literal with unambiguous own named data properties.
 * @param node
 */
function keys(node: ts.CallExpression): ReadonlySet<string> {
	const argument = node.arguments[0];
	if (node.arguments.length !== 1 || argument === undefined || !ts.isObjectLiteralExpression(argument))
		throw new Error("CALL_ARGUMENT_UNRESOLVED");
	const result = new Set<string>();
	for (const property of argument.properties) {
		if (
			(!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
			!ts.isIdentifier(property.name)
		)
			throw new Error("CALL_PROPERTY_UNRESOLVED");
		if (result.has(property.name.text)) throw new Error("CALL_PROPERTY_DUPLICATE");
		result.add(property.name.text);
	}
	return result;
}

/**
 * Inspect the exact shared startup selector, not another declaration occurrence.
 * @param text
 */
function inspect(text: string): { cold: boolean; pending: boolean; selector: boolean } {
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const cold = call(file, "reopenCreatorSuccessorAdoption");
	const pending = call(file, "recoverPendingCreatorSuccessorAdoption");
	const coldKeys = keys(cold);
	const pendingKeys = keys(pending);
	const ancestors: ts.IfStatement[] = [];
	for (let node: ts.Node | undefined = cold.parent; node !== undefined; node = node.parent)
		if (ts.isIfStatement(node)) ancestors.push(node);
	const contains = (outer: ts.Node, inner: ts.Node): boolean => outer.pos <= inner.pos && outer.end >= inner.end;
	const selectors = ancestors.filter(
		(node) =>
			node.elseStatement !== undefined && contains(node.elseStatement, cold) && contains(node.elseStatement, pending)
	);
	if (selectors.length !== 1) throw new Error(`STARTUP_SELECTOR_NOT_UNIQUE:${selectors.length}`);
	const expression = (selectors[0] as ts.IfStatement).expression;
	const selector =
		ts.isBinaryExpression(expression) &&
		expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
		ts.isPropertyAccessExpression(expression.left) &&
		ts.isIdentifier(expression.left.expression) &&
		expression.left.expression.text === "input" &&
		expression.left.name.text === "successorSnapshotDeclaration" &&
		ts.isIdentifier(expression.right) &&
		expression.right.text === "undefined";
	return { cold: !coldKeys.has("snapshotDeclaration"), pending: pendingKeys.has("snapshotDeclaration"), selector };
}

/**
 * Build diagnostic source only, with no change to the product file.
 * @param text
 * @param name
 * @param action
 */
function mutateCall(text: string, name: string, action: "remove" | "add" | "spread"): string {
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const argument = call(file, name).arguments[0] as ts.ObjectLiteralExpression;
	const property = argument.properties.find((value) => value.name?.getText(file) === "snapshotDeclaration");
	if (action === "remove") {
		if (property === undefined) return text;
		let end = property.end;
		if (text[end] === ",") end += 1;
		return text.slice(0, property.pos) + text.slice(end);
	}
	const stripped = mutateCall(text, name, "remove");
	const cleanFile = ts.createSourceFile(path, stripped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const start = (call(cleanFile, name).arguments[0] as ts.ObjectLiteralExpression).getStart(cleanFile) + 1;
	return (
		stripped.slice(0, start) +
		(action === "spread" ? "...unresolved," : "snapshotDeclaration: obsolete,") +
		stripped.slice(start)
	);
}

describe("cold-only room wiring", () => {
	it("COLD_CALL_MUST_OMIT_DECLARATION", () => {
		expect(inspect(source).cold, "COLD_CALL_RETAINS_SNAPSHOT_DECLARATION").toBe(true);
	});
	it("pending declaration remains supplied", () => {
		expect(inspect(source).pending).toBe(true);
	});
	it("actual shared startup selector remains declaration-driven", () => {
		expect(inspect(source).selector).toBe(true);
	});
	it("retained cold-key mutant kills the cold assertion", () => {
		const observed = inspect(mutateCall(source, "reopenCreatorSuccessorAdoption", "add"));
		expect(observed).toEqual({ cold: false, pending: true, selector: true });
		expect(() => expect(observed.cold, "MUTANT_COLD_KEY").toBe(true)).toThrow("MUTANT_COLD_KEY");
	});
	it("removed pending-key mutant kills the pending assertion", () => {
		const observed = inspect(mutateCall(source, "recoverPendingCreatorSuccessorAdoption", "remove"));
		expect(observed.pending).toBe(false);
		expect(observed.selector).toBe(true);
		expect(() => expect(observed.pending, "MUTANT_PENDING_KEY").toBe(true)).toThrow("MUTANT_PENDING_KEY");
	});
	it("removed actual selector dependency kills its assertion despite other occurrences", () => {
		const marker = "if (input.successorSnapshotDeclaration === undefined) {";
		const start = source.indexOf(marker, source.indexOf("const activateStartupPlane ="));
		expect(start).toBeGreaterThan(0);
		const mutant = source.slice(0, start) + source.slice(start).replace(marker, "if (input.unrelated === undefined) {");
		expect(mutant).toContain("input.successorSnapshotDeclaration");
		const observed = inspect(mutant);
		expect(observed.selector).toBe(false);
		expect(observed.pending).toBe(true);
		expect(() => expect(observed.selector, "MUTANT_SELECTOR").toBe(true)).toThrow("MUTANT_SELECTOR");
	});
	it("removing only the cold key makes all three gates green", () => {
		expect(inspect(mutateCall(source, "reopenCreatorSuccessorAdoption", "remove"))).toEqual({
			cold: true,
			pending: true,
			selector: true,
		});
	});
	it("spreads, missing and ambiguous cold calls fail closed", () => {
		expect(() => inspect(mutateCall(source, "reopenCreatorSuccessorAdoption", "spread"))).toThrow(
			"CALL_PROPERTY_UNRESOLVED"
		);
		expect(() => inspect(source.replace("await reopenCreatorSuccessorAdoption({", "await anotherFunction({"))).toThrow(
			"CALLSITE_NOT_UNIQUE"
		);
		expect(() => inspect(source + "\nreopenCreatorSuccessorAdoption({});")).toThrow("CALLSITE_NOT_UNIQUE");
	});
});

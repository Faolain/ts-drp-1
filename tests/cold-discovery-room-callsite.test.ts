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
 * Inspect the exact shared startup selector and its floor dependency. Runtime
 * refresh/route behavior is independently exercised through real public rooms.
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
	const declarations = new Map<string, ts.Node[]>();
	const collect = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined)
			declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node.initializer]);
		if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined)
			declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node.body]);
		ts.forEachChild(node, collect);
	};
	collect(file);
	const seen = new Set<string>();
	const floorDependency = (node: ts.Node): boolean => {
		if (ts.isIdentifier(node) && !seen.has(node.text)) {
			seen.add(node.text);
			if (
				[
					"openedRoomHeadState",
					"roomHeadAuthority",
					"captureRoomHeadState",
					"initializeRoomHeadAuthority",
					"readRoomHeadAuthority",
				].includes(node.text)
			)
				return true;
			if (node.text !== "input" && (declarations.get(node.text) ?? []).some(floorDependency)) return true;
		}
		return node.getChildren(file).some(floorDependency);
	};
	const selector = !expression.getText(file).includes("successorSnapshotDeclaration") && floorDependency(expression);
	return { cold: !coldKeys.has("snapshotDeclaration"), pending: !pendingKeys.has("snapshotDeclaration"), selector };
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

describe("declaration-free recovery room wiring (source-only)", () => {
	it("COLD_CALL_MUST_OMIT_DECLARATION", () => {
		expect(inspect(source).cold, "COLD_CALL_RETAINS_SNAPSHOT_DECLARATION").toBe(true);
	});
	it("PENDING_CALL_MUST_OMIT_DECLARATION", () => {
		expect(inspect(source).pending, "PENDING_CALL_RETAINS_SNAPSHOT_DECLARATION").toBe(true);
	});
	it("actual shared startup selector depends on current floor, never caller hint", () => {
		expect(inspect(source).selector).toBe(true);
	});
	it("retained cold-key mutant kills the cold assertion", () => {
		const omitted = mutateCall(source, "recoverPendingCreatorSuccessorAdoption", "remove");
		const observed = inspect(mutateCall(omitted, "reopenCreatorSuccessorAdoption", "add"));
		expect(observed.cold).toBe(false);
		expect(observed.pending).toBe(true);
		expect(() => expect(observed.cold, "MUTANT_COLD_KEY").toBe(true)).toThrow("MUTANT_COLD_KEY");
	});
	it("retained pending-key mutant kills the pending assertion", () => {
		const observed = inspect(mutateCall(source, "recoverPendingCreatorSuccessorAdoption", "add"));
		expect(observed.pending).toBe(false);
		expect(() => expect(observed.pending, "MUTANT_PENDING_KEY").toBe(true)).toThrow("MUTANT_PENDING_KEY");
	});
	it("old hint and unrelated selectors kill the actual selector assertion", () => {
		const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const cold = call(file, "reopenCreatorSuccessorAdoption"),
			pending = call(file, "recoverPendingCreatorSuccessorAdoption");
		const selectors: ts.IfStatement[] = [];
		for (let node: ts.Node | undefined = cold.parent; node !== undefined; node = node.parent)
			if (
				ts.isIfStatement(node) &&
				node.elseStatement !== undefined &&
				node.elseStatement.pos <= cold.pos &&
				node.elseStatement.end >= cold.end &&
				node.elseStatement.pos <= pending.pos &&
				node.elseStatement.end >= pending.end
			)
				selectors.push(node);
		expect(selectors).toHaveLength(1);
		const selector = selectors[0];
		if (selector === undefined) throw new TypeError("COLD_SELECTOR_CONTROL_NOT_UNIQUE");
		const expression = selector.expression;
		for (const replacement of ["input.successorSnapshotDeclaration === undefined", "input.unrelated === undefined"]) {
			const mutant = source.slice(0, expression.getStart(file)) + replacement + source.slice(expression.end);
			const observed = inspect(mutant);
			expect(observed.selector).toBe(false);
			expect(observed.pending).toBe(true);
			expect(() => expect(observed.selector, "MUTANT_SELECTOR").toBe(true)).toThrow("MUTANT_SELECTOR");
		}
	});
	it("key omission alone cannot establish a floor-selected startup", () => {
		const observed = inspect(mutateCall(source, "recoverPendingCreatorSuccessorAdoption", "remove"));
		expect(observed.cold).toBe(true);
		expect(observed.pending).toBe(true);
		if (source.includes("if (input.successorSnapshotDeclaration === undefined) {"))
			expect(observed.selector).toBe(false);
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
	it("malformed, symbol, duplicate and unresolved pending arguments fail closed", () => {
		const marker = "recoverPendingCreatorSuccessorAdoption({";
		for (const property of ["...unresolved,", "[Symbol.iterator]: unresolved,", "get unresolved() { return 0; },"]) {
			expect(() => inspect(source.replace(marker, marker + property))).toThrow("CALL_PROPERTY_UNRESOLVED");
		}
		expect(() => inspect(source.replace(marker, marker + "snapshotStore: duplicate,"))).toThrow(
			"CALL_PROPERTY_DUPLICATE"
		);
		expect(() => inspect(source.replace(marker, "recoverPendingCreatorSuccessorAdoption(unresolved, {"))).toThrow(
			"CALL_ARGUMENT_UNRESOLVED"
		);
		expect(() => inspect(source.replace(marker, "anotherFunction({"))).toThrow("CALLSITE_NOT_UNIQUE");
		expect(() => inspect(source + "\nrecoverPendingCreatorSuccessorAdoption({});")).toThrow("CALLSITE_NOT_UNIQUE");
	});
});

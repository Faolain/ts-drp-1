import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import ts from "typescript";
import {describe, expect, it} from "vitest";
import {context, criticalMetrics} from "./critical-observer.js";

const requireCanonical = createRequire(new URL("../../../packages/canonical/package.json", import.meta.url));
const build = readFileSync(new URL("./build.ts", import.meta.url), "utf8");
const buildAst = ts.createSourceFile("build.ts", build, ts.ScriptTarget.Latest, true);
const declaration = (name: string) => {
	const node = buildAst.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (node === undefined) throw Error("original observation helper missing: " + name);
	return node.getText(buildAst);
};
const counters = new Function("ts", ts.transpile(declaration("canonicalCaptureObservationInsertions") +
	"\nreturn canonicalCaptureObservationInsertions;", {target: ts.ScriptTarget.ES2022}))(ts);
const apply = new Function(ts.transpile(declaration("applyObservationInsertions") +
	"\nreturn applyObservationInsertions;", {target: ts.ScriptTarget.ES2022}))();
function codec(observed: boolean) {
	const raw = readFileSync(new URL("../../../packages/canonical/src/internal/codec.ts", import.meta.url), "utf8");
	const ast = ts.createSourceFile("codec.ts", raw, ts.ScriptTarget.Latest, true);
	const source = observed ? apply(raw, counters(ast)) : raw;
	const out: any = {};
	new Function("require", "exports", ts.transpile(source, {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}))(requireCanonical, out);
	return out;
}

describe("existing canonical capture observations", () => {
	it("counts capture, full composition and logical reused fragments separately under the actual command context", () => {
		criticalMetrics.clear(); Reflect.set(globalThis, "__r8CriticalProfiling", true);
		Object.assign(context, {role: "creator", transition: 4, command: "sealing-inclusive"});
		const actual = codec(true), original = codec(false), owner = actual.createCanonicalEncodingCapture();
		const bytes = Uint8Array.of(3, 7), value = {payload: bytes}, limits = {maxBytes: 4096, maxItems: 128, maxDepth: 16};
		const expected = original.encodeCanonical({left: value, right: value}, limits);
		const captured = owner.capture(value, limits), logical = original.encodeCanonical(value, limits).byteLength;
		bytes.fill(99);
		expect(owner.encode({left: captured, right: captured}, limits)).toEqual(expected);
		const rows = [...criticalMetrics.values()];
		expect(rows.find(row => row.phase === "canonical-capture-row")).toMatchObject({entered: 1, completed: 1, thrown: 0,
			outputBytes: logical, role: "creator", transition: 4, command: "sealing-inclusive"});
		expect(rows.find(row => row.phase === "canonical-capture-compose")).toMatchObject({entered: 1, completed: 1,
			outputBytes: expected.byteLength, command: "sealing-inclusive"});
		expect(rows.find(row => row.phase === "canonical-capture-reused-fragment")).toMatchObject({entered: 2, completed: 2,
			inputBytes: 2 * logical, outputBytes: 0, command: "sealing-inclusive"});
		Object.assign(context, {command: "creator-adoption-inclusive"}); owner.capture(null, limits);
		expect([...criticalMetrics.values()].filter(row => row.phase === "canonical-capture-row")).toHaveLength(2);
		owner.release();
	});
	it("retains original failure identity and does not record reused bytes before the original capture guards pass", () => {
		criticalMetrics.clear(); Reflect.set(globalThis, "__r8CriticalProfiling", true);
		const actual = codec(true), owner = actual.createCanonicalEncodingCapture();
		const failure = Error("original primitive trap"), row = new Proxy({}, {ownKeys() {throw failure;}});
		let caught: unknown;
		try {owner.capture(row, {maxBytes: 128, maxItems: 8, maxDepth: 8});} catch (error) {caught = error;}
		expect(caught).toBe(failure);
		expect([...criticalMetrics.values()].find(row => row.phase === "canonical-capture-row"))
			.toMatchObject({entered: 1, completed: 1, thrown: 1, outputBytes: 0});
		const captured = owner.capture({a: 1}, {maxBytes: 128, maxItems: 8, maxDepth: 8});
		expect(() => owner.encode({a: captured}, {maxBytes: 64, maxItems: 8, maxDepth: 8})).toThrow("dominating byte and item limits");
		expect([...criticalMetrics.values()].some(row => row.phase === "canonical-capture-reused-fragment")).toBe(false);
		owner.release(); expect(() => owner.capture(null, {maxBytes: 128})).toThrow("released canonical capture");
	});
	it("refuses changed owner/return seams rather than silently missing internal encoding", () => {
		for (const source of ["function createCanonicalEncodingCapture(){}", "function encodeInternal(){}"])
			expect(() => counters(ts.createSourceFile("changed.ts", source, ts.ScriptTarget.Latest, true))).toThrow("CAPTURE_OWNERS_CHANGED");
		const source = readFileSync(new URL("../../../packages/canonical/src/internal/codec.ts", import.meta.url), "utf8");
		expect(() => counters(ts.createSourceFile("changed.ts", source.replace("return handle;", "return Object.freeze(handle);"), ts.ScriptTarget.Latest, true)))
			.toThrow("CAPTURE_RETURN_CHANGED");
	});
});

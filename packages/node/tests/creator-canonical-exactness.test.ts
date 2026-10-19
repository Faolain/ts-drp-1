import { readFileSync } from "node:fs";
import ts from "typescript";
import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";
import { decodeCanonicalWithExactness } from "../../protocol-v3/src/internal/canonical-exactness.js";
import { canonicalCreatorDataRecord } from "../src/internal/creator-snapshot-data.js";

// The exactness path may only skip the re-encode comparison. Every input must
// produce the same value (or refusal) as the ORIGINAL decode-encode-compare.
const path = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.filter((node): node is ts.FunctionDeclaration =>
	ts.isFunctionDeclaration(node) && node.name?.text === "canonicalCreatorDataRecord");
if (declaration.length !== 1) throw Error("ORIGINAL_RECORD_DECODER_NOT_UNIQUE");
const js = ts.transpileModule(`${declaration[0]!.getText(source).replace(/^export /u, "")}\ncanonicalCreatorDataRecord;`,
	{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const original = Function("decodeCanonical", "encodeCanonical", "compareBytes", `"use strict";return eval(${JSON.stringify(js)});`)(
	decodeCanonical, encodeCanonical, compareBytes) as typeof canonicalCreatorDataRecord;

function float64Record(value: number): Uint8Array {
	const prefix = encodeCanonical({ v: 0.5 });
	const bytes = prefix.slice();
	new DataView(bytes.buffer).setFloat64(bytes.byteLength - 8, value, false);
	return bytes;
}

function corpus(): Uint8Array[] {
	const records: unknown[] = [
		{ kind: "drp-hard-epoch-cut", epoch: 2 },
		{ kind: "drp-seal-qc", epoch: 2, phase: "commit", signers: ["a".repeat(64), "b".repeat(64)] },
		{ kind: "game-state", blocks: Array(64).fill({ x: 1, y: 2.5 }), data: new Uint8Array([1, 2, 3]) },
		{ kind: "﻿bom-kind", epoch: 1 }, { text: "a﻿b" }, { nested: { deeper: [null, true, false, -1, 2 ** 40] } },
		[1, 2, 3], "scalar", 7, null, new Map([["k", 1]]), new Set([1]), new Float64Array([1.5]),
	];
	const inputs = records.map((record) => encodeCanonical(record));
	inputs.push(float64Record(2 ** 60), float64Record(1.25), new Uint8Array(), Uint8Array.of(0xff));
	for (const bytes of inputs.slice(0, 6)) {
		inputs.push(bytes.subarray(0, bytes.byteLength - 1), Uint8Array.from([...bytes, 0]));
		const shifted = new Uint8Array(bytes.byteLength + 3);
		shifted.set(bytes, 3);
		inputs.push(shifted.subarray(3));
	}
	return inputs;
}

describe("canonical exactness only skips a proven re-encode comparison", () => {
	it("returns the original whole-record result for every input and view", () => {
		for (const [index, bytes] of corpus().entries()) {
			expect(canonicalCreatorDataRecord(bytes), `case ${index}`).toEqual(original(bytes));
			const lying = new Uint8Array(bytes);
			Object.defineProperty(lying, "byteLength", { value: 0 });
			expect(canonicalCreatorDataRecord(lying), `lying case ${index}`).toEqual(original(lying));
			class Bytes extends Uint8Array {}
			expect(canonicalCreatorDataRecord(new Bytes(bytes)), `subclass case ${index}`).toEqual(original(new Bytes(bytes)));
		}
		expect(canonicalCreatorDataRecord(encodeCanonical({ kind: "﻿x" }))).toBeUndefined();
		expect(canonicalCreatorDataRecord(float64Record(2 ** 60))).toBeUndefined();
	});

	it("decodes like decodeCanonical and reports exact only when the bounded re-encode is identical", () => {
		for (const limits of [undefined, { maxBytes: 212_387 }, { maxBytes: 8 }]) {
			for (const [index, bytes] of corpus().entries()) {
				let expected: unknown, expectedError: unknown, actual: Readonly<{ value: unknown; exact: boolean }> | undefined, actualError: unknown;
				try { expected = decodeCanonical(bytes, limits); } catch (error) { expectedError = error; }
				try { actual = decodeCanonicalWithExactness(bytes, limits); } catch (error) { actualError = error; }
				expect(actualError?.constructor, `case ${index}`).toBe(expectedError?.constructor);
				expect((actualError as Error | undefined)?.message, `case ${index}`).toBe((expectedError as Error | undefined)?.message);
				if (actual === undefined) continue;
				expect(actual.value, `case ${index}`).toEqual(expected);
				if (actual.exact) expect(compareBytes(encodeCanonical(actual.value, limits), bytes), `case ${index}`).toBe(0);
			}
		}
		expect(decodeCanonicalWithExactness(encodeCanonical({ kind: "x" })).exact).toBe(true);
		expect(decodeCanonicalWithExactness(encodeCanonical({ kind: "﻿x" })).exact).toBe(false);
		expect(decodeCanonicalWithExactness(float64Record(2 ** 60)).exact).toBe(false);
		const lying = encodeCanonical({ kind: "x" });
		Object.defineProperty(lying, "length", { value: 0 });
		expect(decodeCanonicalWithExactness(lying).exact).toBe(false);
	});
});

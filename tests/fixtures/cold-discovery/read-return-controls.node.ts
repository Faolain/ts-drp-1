import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

import { transformNativeRead } from "./read-transform.js";

void test("inserted native read retains the original promise and thrown-value identity", () => {
	for (const backend of ["node", "browser"] as const) {
		const raw = readFileSync(`packages/storage-${backend}/dist/src/snapshot-transfer.js`, "utf8");
		const transformed = transformNativeRead(raw, backend);
		const ast = ts.createSourceFile("observed.js", transformed.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const reads: ts.ArrowFunction[] = [];
		const find = (node: ts.Node): void => {
			if (
				ts.isPropertyAssignment(node) &&
				node.name.getText(ast) === "read" &&
				ts.isArrowFunction(node.initializer) &&
				node.initializer.getText(ast).includes("__coldNativePortRead")
			)
				reads.push(node.initializer);
			ts.forEachChild(node, find);
		};
		find(ast);
		assert.equal(reads.length, 1);
		const method = reads[0];
		assert.ok(method);
		const promise = Promise.resolve(Object.freeze({ unchanged: true }));
		const primary = Object.freeze({ originalFailure: true });
		const descriptor = Object.freeze({ index: 0 });
		for (const throws of [false, true]) {
			let calls = 0;
			const callable = new Script(`(${method.getText(ast)})`).runInNewContext({
				promiseCapture: (): Promise<unknown> => {
					if (throws) throw primary;
					return promise;
				},
				__coldNativePortRead: (actual: unknown): void => {
					assert.equal(actual, backend);
					calls += 1;
				},
			}) as (input: unknown) => unknown;
			if (throws)
				assert.throws(
					() => callable(descriptor),
					(error: unknown) => error === primary
				);
			else assert.equal(callable(descriptor), promise);
			assert.equal(calls, 1);
		}
	}
});

import { Linter } from "eslint";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildBlueprint } from "../packages/blueprint-toolchain/src/index.js";

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures/track-p2-a/forward-counter");
const EXPECTED_ARTIFACT = fs.readFileSync(path.join(FIXTURE_ROOT, "artifact.mjs"));
const temporaryDirectories: string[] = [];

type Authoring = {
	conformance: {
		nightlyAdditionalCases: Array<{ action: string; arguments: Record<string, unknown> }>;
		prCases: Array<{ action: string; arguments: Record<string, unknown> }>;
	};
	operations: Array<{
		argumentSchema: { fields: Array<{ name: string }> };
		name: string;
	}>;
};

function temporaryDirectory(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `track-p2-a-string-comment-${label}-`));
	temporaryDirectories.push(directory);
	return directory;
}

function authoringCopy(label: string): { readonly authoring: string; readonly output: string } {
	const root = temporaryDirectory(label);
	const authoring = path.join(root, "authoring");
	fs.mkdirSync(authoring);
	for (const filename of ["blueprint.json", "blueprint.ts"])
		fs.copyFileSync(path.join(FIXTURE_ROOT, filename), path.join(authoring, filename));
	return { authoring, output: path.join(root, "bundle") };
}

function writeAuthoring(authoring: string, mutate: (value: Authoring) => void): void {
	const filename = path.join(authoring, "blueprint.json");
	const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Authoring;
	mutate(value);
	const negativeZeroSentinel = "__track_p2_a_string_comment_negative_zero__";
	const text = JSON.stringify(
		value,
		(_key, candidate: unknown) =>
			typeof candidate === "number" && Object.is(candidate, -0) ? negativeZeroSentinel : candidate,
		"\t"
	).replace(`"${negativeZeroSentinel}"`, "-0");
	fs.writeFileSync(filename, `${text}\n`);
}

function renameAddOperation(value: Authoring, name: string): void {
	value.operations[0].name = name;
	value.conformance.prCases[0].action = name;
}

function renameAddField(value: Authoring, name: string): void {
	value.operations[0].argumentSchema.fields[0].name = name;
	const arguments_ = value.conformance.prCases[0].arguments;
	arguments_[name] = arguments_.value;
	delete arguments_.value;
}

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Track P2-a unpaired-surrogate causal RED", () => {
	it.each([
		["high", 0xd800],
		["low", 0xdc00],
	] as const)("rejects an unpaired %s surrogate in an authoring operation name before output", async (_kind, unit) => {
		const { authoring, output } = authoringCopy(`operation-${unit.toString(16)}`);
		writeAuthoring(authoring, (value) => renameAddOperation(value, `a${String.fromCharCode(unit)}`));
		await expect(buildBlueprint(authoring, output)).rejects.toThrow(/operations\[0\]\.name.*unpaired surrogate/u);
		expect(fs.existsSync(output)).toBe(false);
	});

	it.each([
		["high", 0xd800],
		["low", 0xdc00],
	] as const)(
		"rejects an unpaired %s surrogate in a recursively nested argument-schema field name before output",
		async (_kind, unit) => {
			const { authoring, output } = authoringCopy(`field-${unit.toString(16)}`);
			writeAuthoring(authoring, (value) => renameAddField(value, `value${String.fromCharCode(unit)}`));
			await expect(buildBlueprint(authoring, output)).rejects.toThrow(
				/operations\[0\]\.argumentSchema\.fields\[0\]\.name.*unpaired surrogate/u
			);
			expect(fs.existsSync(output)).toBe(false);
		}
	);

	it("keeps paired non-BMP operation and nested field strings valid with exact ASCII epilogue escaping", async () => {
		const { authoring, output } = authoringCopy("paired-non-bmp");
		writeAuthoring(authoring, (value) => {
			renameAddOperation(value, "add-😀");
			renameAddField(value, "value😀");
		});
		await expect(buildBlueprint(authoring, output)).resolves.toBeUndefined();
		const artifact = fs.readFileSync(path.join(output, "artifact.mjs"));
		const expected = Buffer.from(
			EXPECTED_ARTIFACT.toString("utf8").replace('"add": addReducer', '"add-\\ud83d\\ude00": addReducer')
		);
		expect(artifact).toEqual(expected);
		expect(artifact.some((byte) => byte > 0x7f)).toBe(false);
	});
});

describe("Track P2-a source and artifact comment boundary", () => {
	it("builds ordinary source line and block comments with unchanged exact emitter bytes", async () => {
		const { authoring, output } = authoringCopy("ordinary-comments");
		const source = path.join(authoring, "blueprint.ts");
		fs.writeFileSync(
			source,
			fs
				.readFileSync(source, "utf8")
				.replace(
					"type ReducerInput =",
					"// An ordinary author note is permitted.\n/// A non-directive triple-slash note is permitted.\n/* An ordinary block note is also permitted. */\ntype ReducerInput ="
				)
		);
		await expect(buildBlueprint(authoring, output)).resolves.toBeUndefined();
		expect(fs.readFileSync(path.join(output, "artifact.mjs"))).toEqual(EXPECTED_ARTIFACT);
	});

	it.each([
		["path", '/// <reference path="./forbidden.d.ts" />\n'],
		["types", '/// <reference types="forbidden" />\n'],
		["lib", '/// <reference lib="es2024" />\n'],
		["no-default-lib", '/// <reference no-default-lib="true" />\n'],
	] as const)("keeps triple-slash %s reference directives rejected before output", async (kind, directive) => {
		const { authoring, output } = authoringCopy(`reference-${kind}`);
		const source = path.join(authoring, "blueprint.ts");
		fs.writeFileSync(source, `${directive}${fs.readFileSync(source, "utf8")}`);
		await expect(buildBlueprint(authoring, output)).rejects.toThrow();
		expect(fs.existsSync(output)).toBe(false);
	});

	it("keeps a comment injected into the exact artifact lint target rejected", async () => {
		const { authoring, output } = authoringCopy("artifact-comment");
		const originalVerify = Linter.prototype.verify;
		let injected = false;
		Linter.prototype.verify = function verifyWithArtifactComment(
			this: Linter,
			...arguments_: Parameters<Linter["verify"]>
		): ReturnType<Linter["verify"]> {
			const [text, configuration, options] = arguments_;
			if (typeof text === "string" && typeof options === "object" && options.filename === "artifact.mjs") {
				expect(Buffer.from(text)).toEqual(EXPECTED_ARTIFACT);
				injected = true;
				return originalVerify.call(this, `${text}// exact artifact comment\n`, configuration, options);
			}
			return originalVerify.call(this, text, configuration, options);
		} as typeof originalVerify;
		try {
			await expect(buildBlueprint(authoring, output)).rejects.toThrow(/artifact\.mjs comments are forbidden/u);
			expect(injected).toBe(true);
			expect(fs.existsSync(output)).toBe(false);
		} finally {
			Linter.prototype.verify = originalVerify;
		}
	});
});

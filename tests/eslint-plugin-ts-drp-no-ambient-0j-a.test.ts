import tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0j-a/no-ambient-contract.json" with { type: "json" };

interface ExpectedDiagnostic {
	readonly message: string;
	readonly messageId: keyof typeof contract.messages;
}

interface ContractCase {
	readonly diagnostics: readonly ExpectedDiagnostic[];
	readonly filename: string;
	readonly fixture?: string;
	readonly id: string;
	readonly kind: "artifact" | "source";
	readonly text?: string;
}

interface RuleModule {
	readonly meta?: {
		readonly messages?: Readonly<Record<string, string>>;
		readonly type?: string;
	};
	create(context: unknown): Readonly<Record<string, unknown>>;
}

interface Plugin {
	readonly meta?: {
		readonly name?: string;
	};
	readonly rules?: Readonly<Record<string, RuleModule>>;
}

interface PluginModule {
	readonly default?: Plugin;
}

interface PluginLoad {
	readonly error?: unknown;
	readonly plugin?: Plugin;
}

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIRECTORY = resolve(CURRENT_DIRECTORY, "fixtures", "phase-0j-a");
const configuredPluginPath = process.env.PHASE_0J_A_PLUGIN_MODULE;
const pluginPath =
	configuredPluginPath === undefined
		? resolve(CURRENT_DIRECTORY, "..", "packages", "eslint-plugin-ts-drp", "src", "index.ts")
		: resolve(CURRENT_DIRECTORY, "..", configuredPluginPath);
const pluginUrl = pathToFileURL(pluginPath).href;
const pluginLoad: PluginLoad = await import(pluginUrl)
	.then((loaded: unknown) => ({ plugin: (loaded as PluginModule).default }))
	.catch((error: unknown) => ({ error }));

const cases = contract.cases as readonly ContractCase[];
const ruleName = "no-ambient-in-reducer";

async function exactCaseText(testCase: ContractCase): Promise<string> {
	if (testCase.fixture !== undefined) return readFile(resolve(FIXTURE_DIRECTORY, testCase.fixture), "utf8");
	if (testCase.text !== undefined) return testCase.text;
	throw new Error(`Phase 0j-a case ${testCase.id} has neither exact fixture bytes nor inline text`);
}

function languageOptions(testCase: ContractCase): Readonly<Record<string, unknown>> {
	return testCase.kind === "source"
		? {
				ecmaVersion: 2024 as const,
				parser: tsParser,
				sourceType: "module" as const,
			}
		: {
				ecmaVersion: 2024 as const,
				sourceType: "module" as const,
			};
}

async function lint(testCase: ContractCase, plugin: Plugin): Promise<readonly ExpectedDiagnostic[]> {
	const text = await exactCaseText(testCase);
	const linter = new Linter();
	const messages = linter.verify(
		text,
		[
			{
				files: ["**/*.ts", "**/*.mjs"],
				languageOptions: languageOptions(testCase),
				linterOptions: {
					noInlineConfig: true,
					reportUnusedDisableDirectives: false,
				},
				plugins: { drp: plugin },
				rules: { [contract.ruleId]: "error" },
			},
		],
		{ filename: testCase.filename }
	);

	for (const message of messages) {
		expect(message.fatal, `${testCase.id} must reach the rule instead of failing to parse`).not.toBe(true);
		expect(message.ruleId, `${testCase.id} emitted a diagnostic from the wrong rule`).toBe(contract.ruleId);
	}

	return messages.map((message) => ({
		message: message.message,
		messageId: message.messageId as ExpectedDiagnostic["messageId"],
	}));
}

describe("Phase 0j-a reusable ESLint plugin surface", () => {
	it("loads the real reusable plugin and stable rule metadata", () => {
		if (pluginLoad.error !== undefined) {
			throw new Error(`Phase 0j-a RED: reusable eslint-plugin-ts-drp is absent at ${pluginPath}`, {
				cause: pluginLoad.error,
			});
		}
		expect(pluginLoad.plugin, "eslint-plugin-ts-drp must default-export its flat-config plugin object").toBeDefined();
		expect(pluginLoad.plugin?.meta?.name).toBe("eslint-plugin-ts-drp");
		expect(pluginLoad.plugin?.rules?.[ruleName]?.meta).toMatchObject({
			messages: contract.messages,
			type: "problem",
		});
	});
});

describe.runIf(pluginLoad.plugin !== undefined)("drp/no-ambient-in-reducer whole-module contract", () => {
	for (const testCase of cases) {
		it(testCase.id, async () => {
			expect(await lint(testCase, pluginLoad.plugin as Plugin)).toEqual(testCase.diagnostics);
		});
	}
});

describe("Phase 0j-a sealed matrix", () => {
	it("keeps source, exact-artifact, alias, mutation, and legacy-inference controls independently represented", () => {
		const ids = new Set(cases.map((testCase) => testCase.id));
		const requiredIds = [
			"pure-whole-typescript-source",
			"pure-exact-emitted-artifact",
			"exact-artifact-date-not-source-only",
			"math-random",
			"deterministic-math-members",
			"crypto-randomness",
			"global-this-computed-alias",
			"window-destructured-alias",
			"self-computed-alias",
			"global-computed-alias",
			"host-intrinsic-mutation",
			"helper-mediated-object-mutation",
			"captured-mutable-collection",
			"export-named-from-source",
			"export-all-from-source",
			"type-reexport-from-source",
			"ordinary-local-export",
			"import-meta-module-surface",
			"type-only-ambient-names",
			"function-local-as-const",
			"module-as-const-captured-object",
			"module-ambient-declare-const",
			"module-ambient-declare-function",
			"global-this-nested-object-pattern",
			"window-nested-object-array-pattern",
			"self-nested-array-pattern",
			"global-nested-array-object-pattern",
			"local-nested-destructuring",
			"shadowed-math-random",
			"local-crypto-get-random-values",
			"top-level-for-await-local-sync-iterable",
			"captured-call-expression",
			"captured-new-expression",
			"module-function-property-write",
			"module-class-property-write",
			"module-object-property-write",
			"nested-function-declaration-property-write",
			"nested-class-prototype-property-write",
			"nested-arrow-function-property-write",
			"mutable-destructure-object-and-nested",
			"mutable-destructure-rest-and-default",
			"mutable-destructure-array-element",
			"mutable-destructure-direct-escape",
			"mutable-destructure-chained-alias",
			"mutable-satisfies-capture",
			"local-satisfies-expression",
			"module-write-for-targets",
			"module-write-assignment-patterns",
			"module-write-ts-wrappers",
			"local-write-shapes",
			"module-write-sequence-expression-targets",
			"module-write-conditional-expression-targets",
			"module-write-logical-expression-targets",
			"expression-target-pure-reads",
			"expression-target-local-writes",
			"member-projection-mutable",
			"member-projection-scalars",
			"expression-result-mutable",
			"expression-result-scalars",
			"inline-static-class-state",
			"class-local-state-control",
			"class-field-module-capture",
			"class-field-instance-owned",
			"stateful-regexp-capture",
			"stateless-regexp-control",
			"tagged-template-capture",
			"untagged-template-scalar",
			"static-auto-accessor-state",
			"instance-auto-accessor-control",
			"static-block-state",
			"module-function-class-direct-write-operators",
			"module-function-class-direct-write-patterns",
			"ordinary-function-class-binding-reads",
			"function-local-binding-writes",
			"assignment-result-module-binding-write-base",
			"assignment-result-local-write-base",
			"whole-module-not-legacy-name-inference",
			"legacy-method-names-are-inert",
			"computed-drp-property-is-inert",
			"prototype-method-name-is-inert",
			"prototype-property-read-is-inert",
		];
		for (const requiredId of requiredIds) {
			expect(ids.has(requiredId), `sealed Phase 0j-a case ${requiredId} is missing`).toBe(true);
		}
		for (const [mutant, controlIds] of Object.entries(contract.mutantControls)) {
			expect(controlIds.length, `mutant ${mutant} has no discriminating control`).toBeGreaterThan(0);
			for (const controlId of controlIds) {
				expect(ids.has(controlId), `mutant ${mutant} refers to missing control ${controlId}`).toBe(true);
			}
		}
		expect(cases.some((testCase) => testCase.kind === "source" && testCase.diagnostics.length > 0)).toBe(true);
		expect(cases.some((testCase) => testCase.kind === "artifact" && testCase.diagnostics.length > 0)).toBe(true);
	});

	it("proves every negative case discriminates against a fail-open rule", async () => {
		const failOpenPlugin: Plugin = {
			meta: { name: "eslint-plugin-ts-drp-fail-open-control" },
			rules: {
				[ruleName]: {
					meta: {
						messages: contract.messages,
						type: "problem",
					},
					create(): Readonly<Record<string, unknown>> {
						return {};
					},
				},
			},
		};
		const negativeCases = cases.filter((testCase) => testCase.diagnostics.length > 0);

		expect(negativeCases.length).toBeGreaterThan(0);
		for (const testCase of negativeCases) {
			expect(
				await lint(testCase, failOpenPlugin),
				`${testCase.id} must fail if the production rule becomes a no-op`
			).not.toEqual(testCase.diagnostics);
		}
	});

	it("parses every exact designated input before the production plugin exists", async () => {
		for (const testCase of cases) {
			const messages = new Linter().verify(
				await exactCaseText(testCase),
				[
					{
						files: ["**/*.ts", "**/*.mjs"],
						languageOptions: languageOptions(testCase),
						linterOptions: {
							noInlineConfig: true,
							reportUnusedDisableDirectives: false,
						},
					},
				],
				{ filename: testCase.filename }
			);
			expect(messages, `${testCase.id} must be a parseable whole module`).toEqual([]);
		}
	});
});

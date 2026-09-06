import tsParser from "@typescript-eslint/parser";
import { type ESLint, Linter } from "eslint";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import contract from "./fixtures/phase-0n-a-v3/numeric-determinism-contract.json" with { type: "json" };

type MessageId = keyof typeof contract.messages;

interface ExpectedDiagnostic {
	readonly messageId: MessageId;
	readonly name?: string;
}

interface ContractCase {
	readonly diagnostics: readonly ExpectedDiagnostic[];
	readonly filename?: string;
	readonly id: string;
	readonly kind: "artifact" | "source";
	readonly text: string;
}

interface ReportDescriptor {
	readonly data?: Readonly<Record<string, string>>;
	readonly messageId?: string;
}

interface RuleContextLike {
	readonly filename?: string;
	report(descriptor: ReportDescriptor): void;
}

interface RuleModule {
	readonly meta?: {
		readonly messages?: Readonly<Record<string, string>>;
		readonly type?: string;
	};
	create(context: unknown): Readonly<Record<string, unknown>>;
}

interface Plugin {
	readonly meta?: { readonly name?: string };
	readonly rules?: Readonly<Record<string, RuleModule>>;
}

interface PluginModule {
	readonly default?: Plugin;
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const configuredPluginPath = process.env.PHASE_0N_A_PLUGIN_MODULE;
const pluginPath =
	configuredPluginPath === undefined
		? resolve(REPOSITORY_ROOT, "packages/eslint-plugin-ts-drp/src/index.ts")
		: resolve(REPOSITORY_ROOT, configuredPluginPath);
const plugin = ((await import(pathToFileURL(pluginPath).href)) as PluginModule).default;
const ruleName = "no-ambient-in-reducer";

function renderedDiagnostic(expected: ExpectedDiagnostic): Readonly<{ message: string; messageId: MessageId }> {
	const template = contract.messages[expected.messageId];
	return {
		message: expected.name === undefined ? template : template.replace("{{name}}", expected.name),
		messageId: expected.messageId,
	};
}

function mathCase(member: string, kind: "artifact" | "source", form: string): ContractCase {
	const input = kind === "source" ? "input: number" : "input";
	const use = kind === "source" ? "use: (operation: (...values: number[]) => number, value: number) => number" : "use";
	let text: string;
	switch (form) {
		case "direct":
			text = `export function value(${input}) { return Math.${member}(input, input); }`;
			break;
		case "optional":
			text = `export function value(${input}) { return Math?.${member}?.(input, input); }`;
			break;
		case "static-computed":
			text = `export function value(${input}) { return Math['${member}'](input, input); }`;
			break;
		case "assigned":
			text = `export function value(${input}) { const selected = Math.${member}; return selected(input, input); }`;
			break;
		case "destructured":
			text = `export function value(${input}) { const { ${member}: selected } = Math; return selected(input, input); }`;
			break;
		case "passed":
			text = `export function value(${use}, ${input}) { return use(Math.${member}, input); }`;
			break;
		default:
			throw new Error(`unknown Math form ${form}`);
	}
	return {
		diagnostics: [{ messageId: "implementationApproximated", name: `Math.${member}` }],
		id: `math-${kind}-${form}-${member}`,
		kind,
		text,
	};
}

function retainedMathCase(member: string, kind: "artifact" | "source"): ContractCase {
	const constant = /^[A-Z0-9_]+$/u.test(member);
	return {
		diagnostics: [],
		id: `retained-math-${kind}-${member}`,
		kind,
		text: constant
			? `export function value(input) { return input + Math.${member}; }`
			: `export function value(input) { return Math.${member}(input, input); }`,
	};
}

function localeCase(member: string, kind: "artifact" | "source", form: string): ContractCase {
	const input = kind === "source" ? "input: string" : "input";
	let body: string;
	switch (form) {
		case "direct":
			body = `return input.${member}('x');`;
			break;
		case "optional":
			body = `return input?.${member}?.('x');`;
			break;
		case "static-computed":
			body = `return input['${member}']('x');`;
			break;
		case "extracted":
			body = `const selected = input.${member}; return selected.call(input, 'x');`;
			break;
		case "destructured":
			body = `const { ${member}: selected } = input; return selected.call(input, 'x');`;
			break;
		default:
			throw new Error(`unknown locale form ${form}`);
	}
	return {
		diagnostics: [{ messageId: "localeSensitive", name: member }],
		id: `locale-${kind}-${form}-${member}`,
		kind,
		text: `export function value(${input}) { ${body} }`,
	};
}

function exponentiationCase(operator: "**" | "**=", kind: "artifact" | "source"): ContractCase {
	const parameters = kind === "source" ? "left: number, right: number" : "left, right";
	const form = operator === "**" ? "binary" : "assignment";
	return {
		diagnostics: [{ messageId: "implementationApproximated", name: operator }],
		id: `exponentiation-${kind}-${form}`,
		kind,
		text:
			operator === "**"
				? `export function value(${parameters}) { return left ** right; }`
				: `export function value(${parameters}) { left **= right; return left; }`,
	};
}

function bigintExponentiationCase(operator: "**" | "**=", kind: "artifact" | "source"): ContractCase {
	const form = operator === "**" ? "binary" : "assignment";
	return {
		diagnostics: [{ messageId: "implementationApproximated", name: operator }],
		id: `bigint-exponentiation-${kind}-${form}`,
		kind,
		text:
			operator === "**"
				? "export function value() { return 2n ** 3n; }"
				: "export function value() { let current = 2n; current **= 3n; return current; }",
	};
}

function dynamicCallCase(kind: "artifact" | "source", form: string): ContractCase {
	const parameters = kind === "source" ? "state: any, key: string, use: any" : "state, key, use";
	let body: string;
	switch (form) {
		case "direct":
			body = "return state[key](1);";
			break;
		case "optional":
			body = "return state?.[key]?.(1);";
			break;
		case "extracted":
			body = "const selected = state[key]; return selected(1);";
			break;
		case "destructured":
			body = "const { [key]: selected } = state; return selected(1);";
			break;
		case "passed":
			body = "return use(state[key]);";
			break;
		case "tagged":
			body = "return state[key]`value`;";
			break;
		case "call":
			body = "return state[key].call(state, 1);";
			break;
		case "apply":
			body = "return state[key].apply(state, [1]);";
			break;
		case "bind":
			body = "return state[key].bind(state)(1);";
			break;
		default:
			throw new Error(`unknown dynamic-call form ${form}`);
	}
	return {
		diagnostics: [{ messageId: "dynamicCall" }],
		id: `dynamic-${kind}-${form}`,
		kind,
		text: `export function value(${parameters}) { ${body} }`,
	};
}

const syntaxKinds = contract.syntaxKinds as readonly ContractCase["kind"][];
const generatedCases = [
	...contract.forbiddenMathMembers.flatMap((member) =>
		syntaxKinds.flatMap((kind) => contract.mathUseForms.map((form) => mathCase(member, kind, form)))
	),
	...contract.retainedMathMembers.flatMap((member) => [
		retainedMathCase(member, "source"),
		retainedMathCase(member, "artifact"),
	]),
	...contract.localeSensitiveMembers.flatMap((member) =>
		syntaxKinds.flatMap((kind) => contract.localeUseForms.map((form) => localeCase(member, kind, form)))
	),
	...syntaxKinds.flatMap((kind) => [exponentiationCase("**", kind), exponentiationCase("**=", kind)]),
	...syntaxKinds.flatMap((kind) => [bigintExponentiationCase("**", kind), bigintExponentiationCase("**=", kind)]),
	...syntaxKinds.flatMap((kind) => contract.dynamicCallForms.map((form) => dynamicCallCase(kind, form))),
];
const explicitCases = contract.cases as readonly ContractCase[];
const cases = [...generatedCases, ...explicitCases];

function languageOptions(testCase: ContractCase): Readonly<Record<string, unknown>> {
	return testCase.kind === "source"
		? { ecmaVersion: 2024 as const, parser: tsParser, sourceType: "module" as const }
		: { ecmaVersion: 2024 as const, sourceType: "module" as const };
}

function lint(
	testCase: ContractCase,
	selectedPlugin: Plugin
): readonly Readonly<{ message: string; messageId: string }>[] {
	const linter = new Linter();
	const messages = linter.verify(
		testCase.text,
		[
			{
				files: ["**/*.ts", "**/*.mjs"],
				languageOptions: languageOptions(testCase),
				linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: false },
				plugins: { drp: selectedPlugin as ESLint.Plugin },
				rules: { [contract.ruleId]: "error" },
			},
		],
		{ filename: testCase.filename ?? `designated/${testCase.id}.${testCase.kind === "source" ? "ts" : "mjs"}` }
	);

	for (const message of messages) {
		expect(message.fatal, `${testCase.id} must parse before the policy runs`).not.toBe(true);
		expect(message.ruleId, `${testCase.id} emitted a diagnostic from the wrong rule`).toBe(contract.ruleId);
	}
	return messages.map((message) => ({ message: message.message, messageId: message.messageId ?? "fatal" }));
}

function caseById(id: string): ContractCase {
	const selected = cases.find((testCase) => testCase.id === id);
	if (selected === undefined) throw new Error(`missing Phase 0n-a case ${id}`);
	return selected;
}

function mutatedPlugin(
	selectedPlugin: Plugin,
	suppress: (context: RuleContextLike, descriptor: ReportDescriptor) => boolean
): Plugin {
	const rule = selectedPlugin.rules?.[ruleName];
	if (rule === undefined) throw new Error("Phase 0n-a mutation requires the production rule");
	return {
		meta: selectedPlugin.meta,
		rules: {
			[ruleName]: {
				meta: rule.meta,
				create(context: unknown): Readonly<Record<string, unknown>> {
					const target = context as RuleContextLike;
					const shadow = Object.create(target, {
						report: {
							value(descriptor: ReportDescriptor): void {
								if (!suppress(target, descriptor)) target.report(descriptor);
							},
						},
					}) as RuleContextLike;
					return rule.create(shadow);
				},
			},
		},
	};
}

const expectedForbiddenMath = [
	"acos",
	"acosh",
	"asin",
	"asinh",
	"atan",
	"atan2",
	"atanh",
	"cbrt",
	"cos",
	"cosh",
	"exp",
	"expm1",
	"hypot",
	"log",
	"log1p",
	"log10",
	"log2",
	"pow",
	"sin",
	"sinh",
	"sqrt",
	"tan",
	"tanh",
] as const;
const expectedRetainedMath = [
	"E",
	"LN10",
	"LN2",
	"LOG10E",
	"LOG2E",
	"PI",
	"SQRT1_2",
	"SQRT2",
	"abs",
	"ceil",
	"clz32",
	"floor",
	"fround",
	"imul",
	"max",
	"min",
	"round",
	"sign",
	"trunc",
] as const;
const expectedLocaleMembers = [
	"localeCompare",
	"toLocaleString",
	"toLocaleDateString",
	"toLocaleTimeString",
	"toLocaleLowerCase",
	"toLocaleUpperCase",
] as const;
const expectedMathUseForms = ["direct", "optional", "static-computed", "assigned", "destructured", "passed"] as const;
const expectedLocaleUseForms = ["direct", "optional", "static-computed", "extracted", "destructured"] as const;
const expectedDynamicCallForms = [
	"direct",
	"optional",
	"extracted",
	"destructured",
	"passed",
	"tagged",
	"call",
	"apply",
	"bind",
] as const;
const expectedExplicitControlIds = [
	"shadowed-math-control-source",
	"shadowed-math-control-artifact",
	"computed-data-read-write-control-source",
	"computed-data-read-write-control-artifact",
	"static-computed-call-control-source",
	"static-computed-call-control-artifact",
	"ordinary-arithmetic-and-order-control-source",
	"ordinary-arithmetic-and-order-control-artifact",
] as const;

describe("Phase 0n-a numeric-determinism contract", () => {
	it("loads the real production rule", () => {
		expect(plugin?.meta?.name).toBe("eslint-plugin-ts-drp");
		expect(plugin?.rules?.[ruleName]?.meta?.type).toBe("problem");
	});

	it("pins the complete forbidden, retained, locale and mutant matrices", () => {
		expect(contract.schemaVersion).toBe(1);
		expect(contract.forbiddenMathMembers).toEqual(expectedForbiddenMath);
		expect(contract.retainedMathMembers).toEqual(expectedRetainedMath);
		expect(contract.localeSensitiveMembers).toEqual(expectedLocaleMembers);
		expect(contract.syntaxKinds).toEqual(["source", "artifact"]);
		expect(contract.mathUseForms).toEqual(expectedMathUseForms);
		expect(contract.localeUseForms).toEqual(expectedLocaleUseForms);
		expect(contract.dynamicCallForms).toEqual(expectedDynamicCallForms);
		expect(explicitCases.map(({ id }) => id)).toEqual(expectedExplicitControlIds);
		for (const control of [
			"shadowed-math-control",
			"computed-data-read-write-control",
			"static-computed-call-control",
			"ordinary-arithmetic-and-order-control",
		]) {
			expect(syntaxKinds.map((kind) => caseById(`${control}-${kind}`).kind)).toEqual(syntaxKinds);
		}
		expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length);
		for (const [mutant, controls] of Object.entries(contract.mutantControls)) {
			expect(controls.length, `${mutant} has no causal control`).toBeGreaterThan(0);
			for (const id of controls) expect(caseById(id), `${mutant} refers to ${id}`).toBeDefined();
		}
		expect(cases.some(({ kind, diagnostics }) => kind === "source" && diagnostics.length > 0)).toBe(true);
		expect(cases.some(({ kind, diagnostics }) => kind === "artifact" && diagnostics.length > 0)).toBe(true);
	});

	it("shadows the frozen ESLint rule context without violating object invariants", () => {
		const harnessCase: ContractCase = {
			diagnostics: [],
			id: "mutant-harness-frozen-context",
			kind: "artifact",
			text: "export function value() { return Date.now(); }",
		};
		expect(lint(harnessCase, plugin as Plugin).length).toBeGreaterThan(0);
		expect(
			lint(
				harnessCase,
				mutatedPlugin(plugin as Plugin, () => true)
			)
		).toEqual([]);
	});

	it("activates the complete source-and-artifact policy as one readiness boundary", () => {
		const messages = plugin?.rules?.[ruleName]?.meta?.messages ?? {};
		const messageMismatches = Object.entries(contract.messages)
			.filter(([messageId, template]) => messages[messageId] !== template)
			.map(([messageId]) => messageId);
		const mismatches = cases.flatMap((testCase) => {
			const actual = lint(testCase, plugin as Plugin);
			const expected = testCase.diagnostics.map(renderedDiagnostic);
			return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ actual, expected, id: testCase.id }];
		});
		if (messageMismatches.length > 0 || mismatches.length > 0) {
			throw new Error(
				`Phase 0n-a production policy is not ready: messageIds=${messageMismatches.join(",") || "none"}; mismatches=${mismatches.length}; first=${
					mismatches
						.slice(0, 8)
						.map(({ id }) => id)
						.join(",") || "none"
				}`
			);
		}

		expect({
			messages: Object.fromEntries(Object.keys(contract.messages).map((messageId) => [messageId, messages[messageId]])),
			mismatches,
		}).toEqual({ messages: contract.messages, mismatches: [] });
	});

	it("parses every exact source and artifact before applying the rule", () => {
		for (const testCase of cases) {
			const messages = new Linter().verify(
				testCase.text,
				[{ files: ["**/*.ts", "**/*.mjs"], languageOptions: languageOptions(testCase) }],
				{ filename: `designated/${testCase.id}.${testCase.kind === "source" ? "ts" : "mjs"}` }
			);
			expect(messages, testCase.id).toEqual([]);
		}
	});
});

const policyReady = Object.keys(contract.messages).every(
	(messageId) => messageId in (plugin?.rules?.[ruleName]?.meta?.messages ?? {})
);

describe.runIf(policyReady)("Phase 0n-a causal policy mutants", () => {
	const controls = [
		{
			id: "reallow-one-math-member",
			caseId: "math-source-direct-sin",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "implementationApproximated" && descriptor.data?.name === "Math.sin",
		},
		{
			id: "reallow-exponentiation",
			caseId: "exponentiation-source-binary",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "implementationApproximated" && descriptor.data?.name === "**",
		},
		{
			id: "reallow-exponentiation-assignment",
			caseId: "exponentiation-artifact-assignment",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "implementationApproximated" && descriptor.data?.name === "**=",
		},
		{
			id: "reallow-bigint-exponentiation",
			caseId: "bigint-exponentiation-source-binary",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "implementationApproximated" && descriptor.data?.name === "**",
		},
		{
			id: "reallow-bigint-exponentiation-assignment",
			caseId: "bigint-exponentiation-artifact-assignment",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "implementationApproximated" && descriptor.data?.name === "**=",
		},
		{
			id: "drop-one-locale-member",
			caseId: "locale-source-direct-localeCompare",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "localeSensitive" && descriptor.data?.name === "localeCompare",
		},
		{
			id: "source-only-policy",
			caseId: "math-artifact-direct-sin",
			suppress: (context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				context.filename?.endsWith(".mjs") === true && descriptor.messageId === "implementationApproximated",
		},
		{
			id: "accept-math-alias",
			caseId: "math-source-assigned-sin",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "implementationApproximated",
		},
		{
			id: "accept-math-destructuring",
			caseId: "math-artifact-destructured-sin",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "implementationApproximated",
		},
		{
			id: "locale-destructuring",
			caseId: "locale-source-destructured-localeCompare",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "localeSensitive",
		},
		{
			id: "treat-dynamic-call-as-data",
			caseId: "dynamic-source-direct",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "dynamicCall",
		},
		{
			id: "computed-callee-extraction",
			caseId: "dynamic-source-extracted",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "dynamicCall",
		},
		{
			id: "computed-callee-destructuring",
			caseId: "dynamic-artifact-destructured",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "dynamicCall",
		},
		{
			id: "computed-callee-tagging",
			caseId: "dynamic-source-tagged",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "dynamicCall",
		},
		{
			id: "computed-receiver-call",
			caseId: "dynamic-artifact-call",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "dynamicCall",
		},
		{
			id: "computed-receiver-apply",
			caseId: "dynamic-artifact-apply",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "dynamicCall",
		},
		{
			id: "computed-receiver-bind",
			caseId: "dynamic-artifact-bind",
			suppress: (_context: RuleContextLike, descriptor: ReportDescriptor): boolean =>
				descriptor.messageId === "dynamicCall",
		},
	] as const;

	for (const control of controls) {
		it(`kills ${control.id}`, () => {
			const testCase = caseById(control.caseId);
			expect(lint(testCase, mutatedPlugin(plugin as Plugin, control.suppress))).not.toEqual(
				testCase.diagnostics.map(renderedDiagnostic)
			);
		});
	}
});

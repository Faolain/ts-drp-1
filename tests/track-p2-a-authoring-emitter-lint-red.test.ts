import tsParser from "@typescript-eslint/parser";
import { transformSync } from "esbuild";
import { Linter } from "eslint";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import acceptedLintContract from "./fixtures/phase-0j-a/no-ambient-contract.json" with { type: "json" };
import lintContract from "./fixtures/track-p2-a/no-ambient-lint-v1.json" with { type: "json" };
import preservation from "./fixtures/track-p2-a/preservation.json" with { type: "json" };
import { decodeCanonical, hashDomain } from "../packages/canonical/src/index.js";

interface PackageManifest {
	readonly bin?: Readonly<Record<string, string>> | string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly exports?: Readonly<Record<string, unknown>>;
	readonly name?: string;
	readonly private?: boolean;
	readonly version?: string;
}

interface LintEvidence {
	readonly artifactDigest: string;
	readonly artifactSha256: string;
	readonly authoringSha256: string;
	readonly eslintVersion: string;
	readonly kind: string;
	readonly lintContractSha256: string;
	readonly parserVersion: string;
	readonly result: string;
	readonly ruleId: string;
	readonly rulePackage: string;
	readonly ruleSourceSha256: string;
	readonly schemaVersion: number;
	readonly sourceSha256: string;
	readonly targets: readonly Readonly<Record<string, unknown>>[];
}

interface PluginModule {
	readonly default: unknown;
}

interface ModuleLexer {
	readonly init: Promise<void>;
	parse(
		source: string
	): readonly [readonly Readonly<{ n: string | null }>[], readonly Readonly<{ n: string | null }>[]];
}

interface CliRun {
	readonly result: SpawnSyncReturns<string>;
	readonly target?: string;
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const requireFromProtocolV3 = createRequire(path.join(REPOSITORY_ROOT, "packages/protocol-v3/package.json"));
const moduleLexer = requireFromProtocolV3("es-module-lexer") as ModuleLexer;
const FIXTURE_ROOT = path.resolve(import.meta.dirname, "fixtures/track-p2-a");
const AUTHORING_FIXTURE = path.join(FIXTURE_ROOT, "forward-counter");
const EXPECTED_ARTIFACT = fs.readFileSync(path.join(AUTHORING_FIXTURE, "artifact.mjs"));
const DATE_CONTROL_ROOT = path.join(FIXTURE_ROOT, "date-controls");
const EXPECTED_DATE_ARTIFACT = fs.readFileSync(path.join(DATE_CONTROL_ROOT, "artifact.mjs"));
const EXPECTED_LINT_CONTRACT = fs.readFileSync(path.join(FIXTURE_ROOT, "no-ambient-lint-v1.json"));
const TOOLCHAIN_DIRECTORY = path.join(REPOSITORY_ROOT, "packages/blueprint-toolchain");
const CATALOG_DIRECTORY = path.join(REPOSITORY_ROOT, "packages/blueprint-catalog");
const temporaryDirectories: string[] = [];
let successfulBuild: { readonly output: string; readonly run: CliRun } | undefined;

const TRANSFORM_OPTIONS: NonNullable<Parameters<typeof transformSync>[1]> = {
	charset: "ascii",
	format: "esm",
	keepNames: false,
	legalComments: "none",
	lineLimit: 0,
	loader: "ts",
	logLevel: "silent",
	minify: false,
	minifyIdentifiers: false,
	minifySyntax: false,
	minifyWhitespace: false,
	platform: "neutral",
	sourcemap: false,
	sourcefile: "blueprint.ts",
	target: "es2024",
	treeShaking: false,
	tsconfigRaw: {
		compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true },
	},
};

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function domainHex(domain: string, bytes: Uint8Array): string {
	return Buffer.from(hashDomain(domain, bytes)).toString("hex");
}

function temporaryDirectory(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `track-p2-a-${label}-`));
	temporaryDirectories.push(directory);
	return directory;
}

function readManifest(directory: string): PackageManifest | undefined {
	const filename = path.join(directory, "package.json");
	return fs.existsSync(filename) ? (JSON.parse(fs.readFileSync(filename, "utf8")) as PackageManifest) : undefined;
}

function binTarget(): string | undefined {
	const manifest = readManifest(TOOLCHAIN_DIRECTORY);
	const entry = typeof manifest?.bin === "string" ? manifest.bin : manifest?.bin?.["drp-blueprint"];
	if (typeof entry !== "string" || entry.length === 0 || path.isAbsolute(entry)) return undefined;
	const resolved = path.resolve(TOOLCHAIN_DIRECTORY, entry);
	return resolved.startsWith(`${TOOLCHAIN_DIRECTORY}${path.sep}`) ? resolved : undefined;
}

function runCli(arguments_: readonly string[], environment: Readonly<Record<string, string>> = {}): CliRun {
	const target = binTarget();
	if (target === undefined || !fs.existsSync(target)) {
		return {
			result: {
				error: new Error("P2-a RED: drp-blueprint package/bin is absent"),
				output: [null, "", ""],
				pid: 0,
				signal: null,
				status: null,
				stderr: "",
				stdout: "",
			},
		};
	}
	const preload = path.join(FIXTURE_ROOT, "read-once-preload.mjs");
	const nodeArguments = environment.P2_A_READ_AUDIT_PATH === undefined ? [target] : ["--import", preload, target];
	return {
		result: spawnSync(process.execPath, [...nodeArguments, ...arguments_], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			env: { ...process.env, ...environment },
			timeout: 20_000,
		}),
		target,
	};
}

function copyAuthoring(label: string): string {
	const directory = path.join(temporaryDirectory(label), "authoring");
	fs.cpSync(AUTHORING_FIXTURE, directory, { recursive: true });
	fs.rmSync(path.join(directory, "artifact.mjs"));
	return directory;
}

function invokeBuild(authoring: string, output: string, environment: Readonly<Record<string, string>> = {}): CliRun {
	return runCli(["build", "--dir", authoring, "--out", output, "--tier", "pr"], environment);
}

function requireSuccessfulBuild(): { readonly output: string; readonly run: CliRun } {
	if (successfulBuild === undefined || successfulBuild.run.result.status !== 0) {
		throw new Error(
			`P2-a causal RED: the valid authoring control must build first; status=${String(successfulBuild?.run.result.status)} stderr=${successfulBuild?.run.result.stderr ?? "missing toolchain"}`,
			{ cause: successfulBuild?.run.result.error }
		);
	}
	return successfulBuild;
}

function writeAuthoringJson(directory: string, transform: (value: Record<string, unknown>) => void): void {
	const filename = path.join(directory, "blueprint.json");
	const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
	transform(value);
	const negativeZeroSentinel = "__track_p2_a_negative_zero__";
	const text = JSON.stringify(
		value,
		(_key, candidate: unknown) =>
			typeof candidate === "number" && Object.is(candidate, -0) ? negativeZeroSentinel : candidate,
		"\t"
	).replace(`"${negativeZeroSentinel}"`, "-0");
	fs.writeFileSync(filename, `${text}\n`);
}

function exactEpilogue(
	operations: readonly { readonly name: string; readonly reducerBinding: string }[],
	artifactId = "counter.v1"
): string {
	const escape = (value: string): string =>
		JSON.stringify(value).replace(
			/[\u007f-\uffff]/g,
			(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
		);
	const pairs = operations.map(({ name, reducerBinding }) => `${escape(name)}: ${reducerBinding}`);
	return `export const blueprint = {\n  exportSchemaVersion: 1,\n  artifactId: ${escape(artifactId)},\n  runtimeProfile: ${escape("ecmascript-2024-sync-v1")},\n  reducers: { ${pairs.join(", ")} }\n};\n`;
}

function lintContractBytes(value: typeof lintContract): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

beforeAll(() => {
	const authoring = copyAuthoring("valid");
	const output = path.join(path.dirname(authoring), "bundle");
	successfulBuild = { output, run: invokeBuild(authoring, output) };
});

afterAll(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Track P2-a package and preservation boundaries", () => {
	it("creates exactly the published catalog skeleton and private root-plus-bin toolchain skeleton", () => {
		const catalog = readManifest(CATALOG_DIRECTORY);
		const toolchain = readManifest(TOOLCHAIN_DIRECTORY);
		expect(catalog).toMatchObject({ name: "@ts-drp/blueprint-catalog", version: "0.11.0" });
		expect(catalog?.private).not.toBe(true);
		expect(Object.keys(catalog?.exports ?? {})).toEqual(["."]);
		expect(catalog?.dependencies).toEqual({
			"@ts-drp/canonical": "0.11.0",
			"@ts-drp/errors": "0.11.0",
			"@ts-drp/protocol-v3": "0.11.0",
			"es-module-lexer": "1.6.0",
		});
		expect(toolchain).toMatchObject({ name: "@ts-drp/blueprint-toolchain", private: true, version: "0.11.0" });
		expect(Object.keys(toolchain?.exports ?? {})).toEqual(["."]);
		const toolchainBins = typeof toolchain?.bin === "object" ? toolchain.bin : {};
		expect(Object.keys(toolchainBins)).toEqual(["drp-blueprint"]);
		expect(toolchainBins["drp-blueprint"]).toEqual(expect.any(String));
		expect(toolchain?.dependencies).toEqual({
			"@ts-drp/blueprint-catalog": "0.11.0",
			"@ts-drp/canonical": "0.11.0",
			"@ts-drp/protocol-v3": "0.11.0",
			"@typescript-eslint/parser": "8.29.0",
			"es-module-lexer": "1.6.0",
			"esbuild": "0.25.3",
			"eslint": "9.23.0",
			"eslint-plugin-ts-drp": "0.11.0",
			"yaml": "2.8.0",
		});
		expect(toolchain?.devDependencies).toHaveProperty("@playwright/test");
		expect(toolchain?.dependencies).not.toHaveProperty("@playwright/test");
	});

	it("keeps every legacy, protocol-v3, lint-rule, workflow and shipping preservation byte unchanged", () => {
		for (const [relativePath, expected] of Object.entries(preservation)) {
			expect(sha256(fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath))), relativePath).toBe(expected);
		}
	});
});

describe("Track P2-a exact emission and lint evidence causal RED", () => {
	it("builds the valid read-once authoring fixture into exactly four nonempty atomic products", () => {
		const { output, run } = requireSuccessfulBuild();
		expect(run.result.signal).toBeNull();
		expect(run.result.stderr).toBe("");
		expect(fs.readdirSync(output).sort()).toEqual(["artifact.mjs", "lint.bin", "package.bin", "receipt.bin"]);
		for (const filename of fs.readdirSync(output)) {
			expect(fs.lstatSync(path.join(output, filename)).isFile(), filename).toBe(true);
			expect(fs.statSync(path.join(output, filename)).size, filename).toBeGreaterThan(0);
		}
	});

	it("emits the exact esbuild region, three-pair epilogue and single-LF artifact golden", () => {
		const { output } = requireSuccessfulBuild();
		const actual = fs.readFileSync(path.join(output, "artifact.mjs"));
		expect(actual).toEqual(EXPECTED_ARTIFACT);
		expect(actual.at(-1)).toBe(0x0a);
		expect(actual.at(-2)).not.toBe(0x0a);
		expect(actual.includes(0x0d)).toBe(false);
	});

	it("writes the exact compact lint contract and canonical clean lint evidence over the copied bytes", () => {
		const { output } = requireSuccessfulBuild();
		const productionContract = fs.readFileSync(path.join(TOOLCHAIN_DIRECTORY, "contracts/no-ambient-lint-v1.json"));
		expect(productionContract).toEqual(EXPECTED_LINT_CONTRACT);
		const evidence = decodeCanonical(new Uint8Array(fs.readFileSync(path.join(output, "lint.bin")))) as LintEvidence;
		const artifact = fs.readFileSync(path.join(output, "artifact.mjs"));
		const source = fs.readFileSync(path.join(AUTHORING_FIXTURE, "blueprint.ts"));
		const authoring = fs.readFileSync(path.join(AUTHORING_FIXTURE, "blueprint.json"));
		const rule = fs.readFileSync(path.join(REPOSITORY_ROOT, "packages/eslint-plugin-ts-drp/src/index.ts"));
		expect(evidence).toEqual({
			artifactDigest: domainHex("ts-drp/blueprint-artifact/v3", artifact),
			artifactSha256: sha256(artifact),
			authoringSha256: sha256(authoring),
			eslintVersion: "9.23.0",
			kind: "ts-drp-blueprint-lint-evidence",
			lintContractSha256: sha256(productionContract),
			parserVersion: "8.29.0",
			result: "clean",
			ruleId: "drp/no-ambient-in-reducer",
			rulePackage: "eslint-plugin-ts-drp",
			ruleSourceSha256: sha256(rule),
			schemaVersion: 1,
			sourceSha256: sha256(source),
			targets: [
				{ diagnosticCount: 0, kind: "artifact", sha256: sha256(artifact) },
				{ diagnosticCount: 0, kind: "source", sha256: sha256(source) },
			],
		});
	});

	it("reads each authoring file once into copied bytes", () => {
		requireSuccessfulBuild();
		const authoring = copyAuthoring("read-once");
		const output = path.join(path.dirname(authoring), "bundle");
		const auditPath = path.join(path.dirname(authoring), "read-audit.json");
		const targets = [path.join(authoring, "blueprint.json"), path.join(authoring, "blueprint.ts")];
		const run = invokeBuild(authoring, output, {
			P2_A_READ_AUDIT_PATH: auditPath,
			P2_A_READ_AUDIT_TARGETS: JSON.stringify(targets),
			P2_A_REALPATH_AUDIT_TARGETS: JSON.stringify([authoring]),
		});
		expect(run.result.status, run.result.stderr).toBe(0);
		const audit = JSON.parse(fs.readFileSync(auditPath, "utf8")) as {
			readonly reads: Readonly<Record<string, number>>;
			readonly realpaths: Readonly<Record<string, number>>;
			readonly renames: readonly { readonly from: string; readonly to: string }[];
		};
		expect(audit.reads).toEqual(Object.fromEntries(targets.map((target) => [path.resolve(target), 1])));
		expect(audit.realpaths).toEqual({ [path.resolve(authoring)]: 1 });
		const publicationRename = audit.renames.filter(({ to }) => to === path.resolve(output));
		expect(publicationRename).toHaveLength(1);
		expect(path.dirname(publicationRename[0].from)).toBe(path.dirname(output));

		const mutationAuthoring = copyAuthoring("read-once-mutation");
		const mutationOutput = path.join(path.dirname(mutationAuthoring), "bundle");
		const mutationSource = path.join(mutationAuthoring, "blueprint.ts");
		const mutationAudit = path.join(path.dirname(mutationAuthoring), "read-audit.json");
		const mutationRun = invokeBuild(mutationAuthoring, mutationOutput, {
			P2_A_MUTATE_AFTER_FIRST_READ: JSON.stringify({ [mutationSource]: "Date.now();\n" }),
			P2_A_READ_AUDIT_PATH: mutationAudit,
			P2_A_READ_AUDIT_TARGETS: JSON.stringify([path.join(mutationAuthoring, "blueprint.json"), mutationSource]),
			P2_A_REALPATH_AUDIT_TARGETS: JSON.stringify([mutationAuthoring]),
		});
		expect(mutationRun.result.status, mutationRun.result.stderr).toBe(0);
		expect(fs.readFileSync(path.join(mutationOutput, "artifact.mjs"))).toEqual(EXPECTED_ARTIFACT);
		const evidence = decodeCanonical(
			new Uint8Array(fs.readFileSync(path.join(mutationOutput, "lint.bin")))
		) as LintEvidence;
		expect(evidence.sourceSha256).toBe(sha256(fs.readFileSync(path.join(AUTHORING_FIXTURE, "blueprint.ts"))));
	});

	it("rejects closed-input, byte-grammar, schema and binding mutants without an admissible product", () => {
		requireSuccessfulBuild();
		const mutants: Array<readonly [string, (directory: string) => void]> = [
			["extra-file", (directory): void => fs.writeFileSync(path.join(directory, "extra.txt"), "x")],
			["empty-source", (directory): void => fs.writeFileSync(path.join(directory, "blueprint.ts"), "")],
			[
				"source-symlink",
				(directory): void => {
					fs.rmSync(path.join(directory, "blueprint.ts"));
					fs.symlinkSync(path.join(AUTHORING_FIXTURE, "blueprint.ts"), path.join(directory, "blueprint.ts"));
				},
			],
			[
				"bom",
				(directory): void =>
					fs.writeFileSync(
						path.join(directory, "blueprint.ts"),
						`\ufeff${fs.readFileSync(path.join(directory, "blueprint.ts"), "utf8")}`
					),
			],
			[
				"cr",
				(directory): void =>
					fs.writeFileSync(
						path.join(directory, "blueprint.ts"),
						fs.readFileSync(path.join(directory, "blueprint.ts"), "utf8").replace("\n", "\r\n")
					),
			],
			[
				"no-final-lf",
				(directory): void =>
					fs.writeFileSync(
						path.join(directory, "blueprint.ts"),
						fs.readFileSync(path.join(directory, "blueprint.ts"), "utf8").trimEnd()
					),
			],
			["two-final-lf", (directory): void => fs.appendFileSync(path.join(directory, "blueprint.ts"), "\n")],
			[
				"json-bom",
				(directory): void =>
					fs.writeFileSync(
						path.join(directory, "blueprint.json"),
						`\ufeff${fs.readFileSync(path.join(directory, "blueprint.json"), "utf8")}`
					),
			],
			[
				"json-cr",
				(directory): void =>
					fs.writeFileSync(
						path.join(directory, "blueprint.json"),
						fs.readFileSync(path.join(directory, "blueprint.json"), "utf8").replace("\n", "\r\n")
					),
			],
			[
				"json-no-final-lf",
				(directory): void =>
					fs.writeFileSync(
						path.join(directory, "blueprint.json"),
						fs.readFileSync(path.join(directory, "blueprint.json"), "utf8").trimEnd()
					),
			],
			["json-two-final-lf", (directory): void => fs.appendFileSync(path.join(directory, "blueprint.json"), "\n")],
			[
				"json-invalid-utf8",
				(directory): void => fs.writeFileSync(path.join(directory, "blueprint.json"), Buffer.from([0xc3])),
			],
			[
				"duplicate-json-key",
				(directory): void =>
					fs.writeFileSync(
						path.join(directory, "blueprint.json"),
						fs
							.readFileSync(path.join(directory, "blueprint.json"), "utf8")
							.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n\t"schemaVersion": 1,')
					),
			],
			[
				"extra-json-key",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						value.extra = true;
					}),
			],
			[
				"unsorted-operations",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						(value.operations as unknown[]).reverse();
					}),
			],
			[
				"duplicate-operation-name",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						(value.operations as Array<Record<string, unknown>>)[1].name = "add";
					}),
			],
			[
				"unsorted-bindings",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						(value.operations as Array<Record<string, unknown>>)[0].reducerBinding = "zzzReducer";
					}),
			],
			[
				"reserved-binding",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						((value.operations as Array<Record<string, unknown>>)[0] as Record<string, unknown>).reducerBinding =
							"await";
					}),
			],
			[
				"unicode-binding",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						((value.operations as Array<Record<string, unknown>>)[0] as Record<string, unknown>).reducerBinding =
							"réduce";
					}),
			],
			[
				"empty-nightly",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						(value.conformance as Record<string, unknown>).nightlyAdditionalCases = [];
					}),
			],
			[
				"missing-negative-zero",
				(directory): void => {
					const filename = path.join(directory, "blueprint.json");
					fs.writeFileSync(filename, fs.readFileSync(filename, "utf8").replace('"value": -0', '"value": 0'));
				},
			],
			[
				"nightly-negative-zero",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						(
							(value.conformance as Record<string, unknown>).nightlyAdditionalCases as Array<Record<string, unknown>>
						)[0].arguments = { value: -0 };
					}),
			],
			[
				"invalid-discriminator",
				(directory): void =>
					writeAuthoringJson(directory, (value) => {
						value.operationDiscriminator = "not-an-identifier";
					}),
			],
			["source-export", (directory): void => fs.appendFileSync(path.join(directory, "blueprint.ts"), "export {};\n")],
			["source-import", (directory): void => fs.appendFileSync(path.join(directory, "blueprint.ts"), 'import "x";\n')],
			["top-level-await", (directory): void => fs.appendFileSync(path.join(directory, "blueprint.ts"), "await 1;\n")],
		];
		for (const [label, mutate] of mutants) {
			const authoring = copyAuthoring(`mutant-${label}`);
			mutate(authoring);
			const output = path.join(path.dirname(authoring), "bundle");
			const run = invokeBuild(authoring, output);
			expect.soft(run.result.status, label).not.toBe(0);
			expect.soft(fs.existsSync(output), `${label} left an admissible product`).toBe(false);
		}
	});

	it("rejects source Date.now and leaves no clean evidence, receipt or catalogable bundle", () => {
		requireSuccessfulBuild();
		const authoring = copyAuthoring("date-source");
		fs.copyFileSync(path.join(DATE_CONTROL_ROOT, "blueprint.ts"), path.join(authoring, "blueprint.ts"));
		const output = path.join(path.dirname(authoring), "bundle");
		const run = invokeBuild(authoring, output);
		expect(run.result.status).not.toBe(0);
		expect(fs.existsSync(output)).toBe(false);
	});

	it("rejects nonempty output before staging and preserves its sentinel bytes", () => {
		requireSuccessfulBuild();
		const authoring = copyAuthoring("nonempty-output");
		const output = path.join(path.dirname(authoring), "bundle");
		fs.mkdirSync(output);
		const sentinel = path.join(output, "sentinel.bin");
		fs.writeFileSync(sentinel, "owned");
		const run = invokeBuild(authoring, output);
		expect(run.result.status).not.toBe(0);
		expect(fs.readdirSync(output)).toEqual(["sentinel.bin"]);
		expect(fs.readFileSync(sentinel, "utf8")).toBe("owned");
	});

	it("rejects malformed build CLI forms before creating an admissible product", () => {
		requireSuccessfulBuild();
		const authoring = copyAuthoring("cli-grammar");
		for (const [label, arguments_] of [
			["missing-command", []],
			["missing-dir", ["build", "--out", path.join(path.dirname(authoring), "missing-dir"), "--tier", "pr"]],
			[
				"unknown-flag",
				[
					"build",
					"--dir",
					authoring,
					"--out",
					path.join(path.dirname(authoring), "unknown"),
					"--tier",
					"pr",
					"--config",
					"x",
				],
			],
			[
				"repeated-dir",
				[
					"build",
					"--dir",
					authoring,
					"--dir",
					authoring,
					"--out",
					path.join(path.dirname(authoring), "repeated"),
					"--tier",
					"pr",
				],
			],
			["bad-tier", ["build", "--dir", authoring, "--out", path.join(path.dirname(authoring), "tier"), "--tier", "ci"]],
			[
				"positional",
				[
					"build",
					"--dir",
					authoring,
					"--out",
					path.join(path.dirname(authoring), "positional"),
					"--tier",
					"pr",
					"extra",
				],
			],
		] as const) {
			const run = runCli(arguments_);
			expect.soft(run.result.status, label).not.toBe(0);
		}
	});
});

describe("Track P2-a anti-hollow controls", () => {
	it("recomputes the checked-in artifact golden with the exact pinned transform and lexer", async () => {
		const source = fs.readFileSync(path.join(AUTHORING_FIXTURE, "blueprint.ts"), "utf8");
		const transformed = transformSync(source, TRANSFORM_OPTIONS);
		expect(transformed.warnings).toEqual([]);
		const body = transformed.code.replace(/\n+$/u, "");
		const epilogue = exactEpilogue([
			{ name: "add", reducerBinding: "addReducer" },
			{ name: "read-value", reducerBinding: "readReducer" },
			{ name: "set", reducerBinding: "setReducer" },
		]);
		const recomputed = `${body}\n${epilogue}`;
		expect(Buffer.from(recomputed)).toEqual(EXPECTED_ARTIFACT);
		await moduleLexer.init;
		const [imports, exports] = moduleLexer.parse(recomputed);
		expect(imports).toEqual([]);
		expect(exports.map(({ n: name }) => name)).toEqual(["blueprint"]);
		const dateSource = fs.readFileSync(path.join(DATE_CONTROL_ROOT, "blueprint.ts"), "utf8");
		const dateBody = transformSync(dateSource, TRANSFORM_OPTIONS).code.replace(/\n+$/u, "");
		expect(Buffer.from(`${dateBody}\n${epilogue}`)).toEqual(EXPECTED_DATE_ARTIFACT);
	});

	it("the exact epilogue oracle kills separator, ordering, quoting, trailing-comma and blank-line mutants", () => {
		const operations = [
			{ name: "add", reducerBinding: "addReducer" },
			{ name: "read-value", reducerBinding: "readReducer" },
			{ name: "set", reducerBinding: "setReducer" },
		];
		const expected = exactEpilogue(operations);
		expect(EXPECTED_ARTIFACT.toString("utf8").endsWith(expected)).toBe(true);
		expect(exactEpilogue([{ name: "\ud83d\ude00", reducerBinding: "unicodeReducer" }])).toContain(
			'"\\ud83d\\ude00": unicodeReducer'
		);
		for (const mutant of [
			exactEpilogue([...operations].reverse()),
			expected.replace(', "read-value"', ',\n    "read-value"'),
			expected.replace('"add": addReducer', "add: addReducer"),
			expected.replace("setReducer }", "setReducer, }"),
			`\n${expected}`,
		]) {
			expect(mutant).not.toBe(expected);
		}
	});

	it("the exact lint-contract oracle kills version, parser, message, option, whitespace and LF mutants", () => {
		expect(Buffer.from(lintContractBytes(lintContract))).toEqual(EXPECTED_LINT_CONTRACT);
		expect(lintContract.messages).toEqual(acceptedLintContract.messages);
		const text = EXPECTED_LINT_CONTRACT.toString("utf8");
		for (const mutant of [
			text.replace('"eslintVersion":"9.23.0"', '"eslintVersion":"9.24.0"'),
			text.replace('"parserVersion":"8.29.0"', '"parserVersion":"8.30.0"'),
			text.replace('"noInlineConfig":true', '"noInlineConfig":false'),
			text.replace("Ambient or unresolved", "Unresolved"),
			text.replace('{"schemaVersion"', '{ "schemaVersion"'),
			text.slice(0, -1),
		]) {
			expect(Buffer.from(mutant)).not.toEqual(EXPECTED_LINT_CONTRACT);
		}
	});

	it("the real frozen rule rejects the checked-in exact-artifact Date control but accepts the clean golden", async () => {
		const pluginPath = path.join(REPOSITORY_ROOT, "packages/eslint-plugin-ts-drp/src/index.ts");
		const plugin = (await import(pathToFileURL(pluginPath).href)) as PluginModule;
		const lint = (filename: string, kind: "artifact" | "source"): readonly string[] => {
			const linter = new Linter();
			const messages = linter.verify(
				fs.readFileSync(filename, "utf8"),
				[
					{
						files: kind === "artifact" ? ["**/*.mjs"] : ["**/*.ts"],
						languageOptions: {
							ecmaVersion: 2024,
							parser: kind === "source" ? tsParser : undefined,
							sourceType: "module",
						},
						linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: false },
						plugins: { drp: plugin.default as never },
						rules: { "drp/no-ambient-in-reducer": "error" },
					},
				],
				{ filename: kind === "artifact" ? "artifact.mjs" : "blueprint.ts" }
			);
			expect(linter.getSourceCode()?.getAllComments(), filename).toEqual([]);
			return messages.map((message) => message.messageId ?? "fatal");
		};
		expect(lint(path.join(DATE_CONTROL_ROOT, "artifact.mjs"), "artifact")).toContain("ambientAccess");
		expect(lint(path.join(DATE_CONTROL_ROOT, "blueprint.ts"), "source")).toContain("ambientAccess");
		expect(lint(path.join(AUTHORING_FIXTURE, "artifact.mjs"), "artifact")).toEqual([]);
		expect(lint(path.join(AUTHORING_FIXTURE, "blueprint.ts"), "source")).toEqual([]);
	});

	it("rejecting CLI controls are causal rather than a fail-closed missing-command false positive", () => {
		const valid = successfulBuild?.run.result;
		expect(valid?.status, valid?.stderr ?? "missing production toolchain").toBe(0);
		expect(binTarget()).toEqual(expect.any(String));
	});
});

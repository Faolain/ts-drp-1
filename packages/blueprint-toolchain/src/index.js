/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/check-tag-names, jsdoc/no-types, jsdoc/require-param, jsdoc/require-param-description, jsdoc/require-returns, jsdoc/valid-types -- native JavaScript is the directly executable CLI source */
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { init as initializeModuleLexer, parse as parseModule } from "es-module-lexer";
import { transformSync } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

/** @typedef {ReturnType<typeof import("@typescript-eslint/parser").parse>} BlueprintProgram */
/** @typedef {{type:string, name?:string, left?:BindingNode, argument?:BindingNode, elements?:readonly (BindingNode|null)[], properties?:readonly {type:string, argument?:BindingNode, value?:BindingNode}[]}} BindingNode */

const AUTHORING_KEYS = [
	"artifactId",
	"conformance",
	"kind",
	"operationDiscriminator",
	"operations",
	"runtimeProfile",
	"schemaVersion",
];
const CONFORMANCE_KEYS = ["corpusVersion", "initialState", "nightlyAdditionalCases", "prCases", "seed"];
const CASE_KEYS = ["action", "arguments", "id"];
const OPERATION_KEYS = ["argumentSchema", "name", "reducerBinding"];
const SCHEMA_KEYS = ["fields", "kind"];
const FIELD_KEYS = ["name", "required", "type"];
const RESERVED_BINDINGS = new Set([
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
]);
/** @type {import("esbuild").TransformOptions} */
const TRANSFORM_OPTIONS = {
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

/** @param {unknown} value @param {readonly string[]} keys @param {string} context */
function assertClosedRecord(value, keys, context) {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new TypeError(`${context} must be a plain record`);
	}
	const actual = Reflect.ownKeys(value);
	if (actual.some((key) => typeof key !== "string") || actual.length !== keys.length) {
		throw new TypeError(`${context} has invalid fields`);
	}
	const sorted = /** @type {string[]} */ (actual).sort();
	if (sorted.some((key, index) => key !== keys[index])) throw new TypeError(`${context} has invalid fields`);
}

/** @param {string} left @param {string} right */
function compareCodePoints(left, right) {
	const a = [...left].map((value) => value.codePointAt(0));
	const b = [...right].map((value) => value.codePointAt(0));
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		if (a[index] !== b[index]) return /** @type {number} */ (a[index]) - /** @type {number} */ (b[index]);
	}
	return a.length - b.length;
}

/** @param {Uint8Array | string} value */
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

/** @param {string} domain @param {Uint8Array} bytes */
function domainHex(domain, bytes) {
	return Buffer.from(hashDomain(domain, bytes)).toString("hex");
}

/** @param {Buffer} bytes @param {string} context */
function decodeExactText(bytes, context) {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw new TypeError(`${context} must be BOM-free`);
	}
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new TypeError(`${context} must be valid UTF-8`);
	}
	if (text.startsWith("\ufeff") || text.includes("\r") || !text.endsWith("\n") || text.endsWith("\n\n")) {
		throw new TypeError(`${context} must be BOM/CR-free with exactly one final LF`);
	}
	return text;
}

/** @param {unknown} value @param {number} depth */
function assertBoundedCanonical(value, depth = 0) {
	if (depth > 32) throw new RangeError("authoring value exceeds depth 32");
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("authoring numbers must be finite");
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertBoundedCanonical(item, depth + 1);
		return;
	}
	if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		for (const item of Object.values(value)) assertBoundedCanonical(item, depth + 1);
		return;
	}
	throw new TypeError("authoring value is outside the canonical domain");
}

/** @param {unknown} value */
function countNegativeZero(value) {
	if (typeof value === "number") return Object.is(value, -0) ? 1 : 0;
	if (Array.isArray(value)) return value.reduce((count, item) => count + countNegativeZero(item), 0);
	if (value !== null && typeof value === "object") {
		return Object.values(value).reduce((count, item) => count + countNegativeZero(item), 0);
	}
	return 0;
}

/** @param {unknown} value @param {string} context */
function requireNonemptyString(value, context) {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${context} must be a nonempty string`);
	return value;
}

/** @param {unknown} value @param {string} context */
function compileArgumentSchema(value, context) {
	assertClosedRecord(value, SCHEMA_KEYS, context);
	const schema = /** @type {Record<string, unknown>} */ (value);
	if (schema.kind !== "closed-record" || !Array.isArray(schema.fields)) throw new TypeError(`${context} is invalid`);
	let previous;
	const fields = [];
	for (let index = 0; index < schema.fields.length; index++) {
		const candidate = schema.fields[index];
		assertClosedRecord(candidate, FIELD_KEYS, `${context}.fields[${index}]`);
		const field = /** @type {Record<string, unknown>} */ (candidate);
		const name = requireNonemptyString(field.name, `${context}.fields[${index}].name`);
		if (previous !== undefined && compareCodePoints(previous, name) >= 0)
			throw new TypeError(`${context} fields are unsorted`);
		if (typeof field.required !== "boolean") throw new TypeError(`${context} required must be boolean`);
		const type = field.type;
		if (type !== "canonical-object" && type !== "safe-integer" && type !== "string") {
			throw new TypeError(`${context} field type is unsupported`);
		}
		fields.push({ name, required: field.required, type });
		previous = name;
	}
	return fields;
}

/** @param {unknown} value @param {readonly {name:string, required:boolean, type:string}[]} fields @param {string} context */
function validateArguments(value, fields, context) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${context} must be an object`);
	const allowed = new Set(fields.map((field) => field.name));
	const record = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`${context}.${key} is unknown`);
	for (const field of fields) {
		if (!Object.hasOwn(value, field.name)) {
			if (field.required) throw new TypeError(`${context}.${field.name} is required`);
			continue;
		}
		const candidate = record[field.name];
		if (field.type === "safe-integer" && !Number.isSafeInteger(candidate)) {
			throw new TypeError(`${context}.${field.name} must be a safe integer`);
		}
		if (field.type === "string" && typeof candidate !== "string") {
			throw new TypeError(`${context}.${field.name} must be a string`);
		}
		if (field.type === "canonical-object") {
			if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
				throw new TypeError(`${context}.${field.name} must be a canonical object`);
			}
			assertBoundedCanonical(candidate);
		}
	}
}

/** @param {BindingNode} pattern @param {Set<string>} bindings */
function addBindingNames(pattern, bindings) {
	if (pattern.type === "Identifier") {
		if (pattern.name === undefined) throw new TypeError("invalid identifier binding");
		bindings.add(pattern.name);
		return;
	}
	if (pattern.type === "AssignmentPattern") {
		if (pattern.left === undefined) throw new TypeError("invalid assignment binding pattern");
		addBindingNames(pattern.left, bindings);
		return;
	}
	if (pattern.type === "RestElement") {
		if (pattern.argument === undefined) throw new TypeError("invalid rest binding pattern");
		addBindingNames(pattern.argument, bindings);
		return;
	}
	if (pattern.type === "ArrayPattern") {
		if (pattern.elements === undefined) throw new TypeError("invalid array binding pattern");
		for (const element of pattern.elements) if (element !== null) addBindingNames(element, bindings);
		return;
	}
	if (pattern.type === "ObjectPattern") {
		if (pattern.properties === undefined) throw new TypeError("invalid object binding pattern");
		for (const property of pattern.properties) {
			const binding = property.type === "RestElement" ? property.argument : property.value;
			if (binding === undefined) throw new TypeError("invalid object binding property");
			addBindingNames(binding, bindings);
		}
	}
}

/** @param {BlueprintProgram} root */
function moduleBindings(root) {
	const bindings = new Set();
	for (const node of root.body) {
		if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id?.name) {
			bindings.add(node.id.name);
		}
		if (node.type === "VariableDeclaration") {
			for (const declaration of node.declarations) {
				addBindingNames(/** @type {BindingNode} */ (declaration.id), bindings);
			}
		}
	}
	return bindings;
}

/** @param {BlueprintProgram} root */
function validateSourceAst(root) {
	const forbidden = new Set([
		"Decorator",
		"ExportAllDeclaration",
		"ExportDefaultDeclaration",
		"ExportNamedDeclaration",
		"ImportDeclaration",
		"ImportExpression",
		"JSXElement",
		"JSXFragment",
		"TSDeclareFunction",
		"TSEnumDeclaration",
		"TSModuleDeclaration",
	]);
	/** @param {unknown} value @param {number} functionDepth */
	const visit = (value, functionDepth) => {
		if (value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, functionDepth);
			return;
		}
		const node = /** @type {Record<string, unknown>} */ (value);
		const nodeType = node.type;
		if (
			typeof nodeType === "string" &&
			(forbidden.has(nodeType) || nodeType.startsWith("TSDeclare") || node.declare === true)
		) {
			throw new TypeError(`blueprint.ts contains forbidden ${nodeType}`);
		}
		if (nodeType === "AwaitExpression" && functionDepth === 0)
			throw new TypeError("blueprint.ts contains top-level await");
		const nextDepth =
			typeof nodeType === "string" &&
			["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"].includes(nodeType)
				? functionDepth + 1
				: functionDepth;
		for (const [key, child] of Object.entries(node)) {
			if (!["loc", "parent", "range", "tokens", "comments"].includes(key)) visit(child, nextDepth);
		}
	};
	visit(root, 0);
}

/** @param {string} source @param {typeof import("@typescript-eslint/parser")} parser */
function parseSource(source, parser) {
	const program = parser.parse(source, {
		comment: true,
		ecmaVersion: 2024,
		loc: true,
		range: true,
		sourceType: "module",
		tokens: true,
	});
	if ((program.comments ?? []).length !== 0) throw new TypeError("blueprint.ts comments are forbidden");
	validateSourceAst(program);
	return program;
}

/** @param {Buffer} authoringBytes @param {string} text */
function parseAuthoring(authoringBytes, text) {
	const duplicateCheck = parseDocument(text, { uniqueKeys: true });
	if (duplicateCheck.errors.length !== 0) throw new TypeError("blueprint.json contains duplicate or invalid keys");
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new TypeError("blueprint.json is not valid JSON");
	}
	assertClosedRecord(value, AUTHORING_KEYS, "blueprint.json");
	if (value.schemaVersion !== 1 || value.kind !== "ts-drp-blueprint-authoring-source") {
		throw new TypeError("blueprint.json has an unsupported schema or kind");
	}
	if (value.runtimeProfile !== "ecmascript-2024-sync-v1") throw new TypeError("runtimeProfile is unsupported");
	const artifactId = requireNonemptyString(value.artifactId, "artifactId");
	if (
		Buffer.byteLength(artifactId) > 128 ||
		!/^[\x21-\x7e]+$/u.test(artifactId) ||
		artifactId.includes("\\") ||
		artifactId.split("/").some((segment) => segment === "." || segment === "..")
	) {
		throw new TypeError("artifactId is invalid");
	}
	const discriminator = requireNonemptyString(value.operationDiscriminator, "operationDiscriminator");
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(discriminator)) {
		throw new TypeError("operationDiscriminator is not an ASCII identifier");
	}
	if (!Array.isArray(value.operations) || value.operations.length === 0)
		throw new TypeError("operations must be nonempty");
	let previousName;
	let previousBinding;
	const operations = [];
	const operationsByName = new Map();
	for (let index = 0; index < value.operations.length; index++) {
		const operation = value.operations[index];
		assertClosedRecord(operation, OPERATION_KEYS, `operations[${index}]`);
		const name = requireNonemptyString(operation.name, `operations[${index}].name`);
		const reducerBinding = requireNonemptyString(operation.reducerBinding, `operations[${index}].reducerBinding`);
		if (previousName !== undefined && compareCodePoints(previousName, name) >= 0)
			throw new TypeError("operation names are unsorted");
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(reducerBinding) || RESERVED_BINDINGS.has(reducerBinding)) {
			throw new TypeError("reducerBinding is not an ES2024 ASCII BindingIdentifier");
		}
		if (previousBinding !== undefined && compareCodePoints(previousBinding, reducerBinding) >= 0) {
			throw new TypeError("reducer bindings are unsorted");
		}
		const fields = compileArgumentSchema(operation.argumentSchema, `operations[${index}].argumentSchema`);
		if (fields.some((field) => field.name === discriminator))
			throw new TypeError("argument schema redeclares discriminator");
		const compiled = { name, reducerBinding, fields };
		operations.push(compiled);
		operationsByName.set(name, compiled);
		previousName = name;
		previousBinding = reducerBinding;
	}
	assertClosedRecord(value.conformance, CONFORMANCE_KEYS, "conformance");
	const conformance = value.conformance;
	const corpusVersion = requireNonemptyString(conformance.corpusVersion, "conformance.corpusVersion");
	const seed = requireNonemptyString(conformance.seed, "conformance.seed");
	assertBoundedCanonical(conformance.initialState);
	if (countNegativeZero(conformance.initialState) !== 0) {
		throw new TypeError("negative zero is permitted only in PR operation arguments");
	}
	if (!Array.isArray(conformance.prCases) || !Array.isArray(conformance.nightlyAdditionalCases)) {
		throw new TypeError("conformance cases must be arrays");
	}
	if (conformance.nightlyAdditionalCases.length === 0) throw new TypeError("nightlyAdditionalCases must be nonempty");
	const ids = new Set();
	for (const [tier, cases] of [
		["pr", conformance.prCases],
		["nightly", conformance.nightlyAdditionalCases],
	]) {
		for (let index = 0; index < cases.length; index++) {
			const item = cases[index];
			assertClosedRecord(item, CASE_KEYS, `${tier}Cases[${index}]`);
			const id = requireNonemptyString(item.id, `${tier}Cases[${index}].id`);
			if (ids.has(id)) throw new TypeError("conformance case ids must be unique");
			ids.add(id);
			const action = requireNonemptyString(item.action, `${tier}Cases[${index}].action`);
			const operation = operationsByName.get(action);
			if (operation === undefined) throw new TypeError("conformance action is undeclared");
			validateArguments(item.arguments, operation.fields, `${tier}Cases[${index}].arguments`);
			assertBoundedCanonical(item.arguments);
		}
	}
	if (
		countNegativeZero(/** @type {Record<string, unknown>[]} */ (conformance.prCases).map((item) => item.arguments)) !==
		1
	) {
		throw new TypeError("PR arguments must contain exactly one negative-zero witness");
	}
	if (
		countNegativeZero(
			/** @type {Record<string, unknown>[]} */ (conformance.nightlyAdditionalCases).map((item) => item.arguments)
		) !== 0
	) {
		throw new TypeError("nightly arguments cannot contain negative zero");
	}
	encodeCanonical({
		corpusVersion,
		initialState: conformance.initialState,
		nightlyAdditionalCases: conformance.nightlyAdditionalCases,
		prCases: conformance.prCases,
		schemaVersion: 1,
		seed,
	});
	return { artifactId, authoringBytes, operations };
}

/** @param {string} value */
function escapeEpilogueString(value) {
	return JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
	);
}

/** @param {string} source @param {{artifactId:string, operations:readonly {name:string,reducerBinding:string}[]}} authoring */
async function emitArtifact(source, authoring) {
	const transformed = transformSync(source, TRANSFORM_OPTIONS);
	if (transformed.warnings.length !== 0) throw new TypeError("esbuild emitted warnings");
	const body = transformed.code.replace(/\n+$/u, "");
	if (body.length === 0 || Buffer.from(body, "utf8").some((byte) => byte > 0x7f) || body.includes("\r")) {
		throw new TypeError("transformed source has invalid bytes");
	}
	await initializeModuleLexer;
	const [bodyImports, bodyExports] = parseModule(body);
	if (bodyImports.length !== 0 || bodyExports.length !== 0) throw new TypeError("transformed source has module syntax");
	const pairs = authoring.operations.map(
		(operation) => `${escapeEpilogueString(operation.name)}: ${operation.reducerBinding}`
	);
	const epilogue =
		`export const blueprint = {\n  exportSchemaVersion: 1,\n  artifactId: ${escapeEpilogueString(authoring.artifactId)},\n` +
		`  runtimeProfile: ${escapeEpilogueString("ecmascript-2024-sync-v1")},\n  reducers: { ${pairs.join(", ")} }\n};\n`;
	const artifact = Buffer.from(`${body}\n${epilogue}`, "utf8");
	if (artifact.some((byte) => byte > 0x7f) || artifact.includes(0x0d) || artifact.at(-1) !== 0x0a) {
		throw new TypeError("artifact has invalid bytes");
	}
	const [imports, exports] = parseModule(artifact.toString("utf8"));
	if (imports.length !== 0 || exports.map(({ n }) => n).join(",") !== "blueprint") {
		throw new TypeError("artifact must have no imports and the sole blueprint export");
	}
	return artifact;
}

function repositoryRoot() {
	let directory = path.dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (fs.existsSync(path.join(directory, "pnpm-workspace.yaml"))) return directory;
		const parent = path.dirname(directory);
		if (parent === directory) throw new Error("repository root is unavailable");
		directory = parent;
	}
}

/** @param {string} ruleSource @returns {Promise<import("eslint").ESLint.Plugin>} */
async function loadRule(ruleSource) {
	const compiled = transformSync(ruleSource, {
		charset: "utf8",
		format: "esm",
		legalComments: "none",
		loader: "ts",
		logLevel: "silent",
		platform: "node",
		sourcemap: false,
		target: "node22",
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`;
	return (await import(moduleUrl)).default;
}

/** @param {string} text @param {string} filename @param {'artifact'|'source'} kind @param {import("eslint").ESLint.Plugin} plugin @param {import("eslint").Linter.Parser} parser @param {typeof import("eslint").Linter} LinterConstructor */
function lintTarget(text, filename, kind, plugin, parser, LinterConstructor) {
	const linter = new LinterConstructor();
	const messages = linter.verify(
		text,
		[
			{
				files: kind === "artifact" ? ["**/*.mjs"] : ["**/*.ts"],
				languageOptions: {
					ecmaVersion: 2024,
					parser: kind === "source" ? parser : undefined,
					sourceType: "module",
				},
				linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: false },
				plugins: { drp: plugin },
				rules: { "drp/no-ambient-in-reducer": "error" },
			},
		],
		{ filename }
	);
	if (linter.getSourceCode()?.getAllComments().length !== 0) throw new TypeError(`${filename} comments are forbidden`);
	if (messages.length !== 0) throw new TypeError(`${filename} failed deterministic lint`);
}

/** @param {Buffer} sourceBytes @param {Buffer} authoringBytes @param {Buffer} artifact */
async function createLintEvidence(sourceBytes, authoringBytes, artifact) {
	const [{ default: parser }, { Linter: LinterConstructor }] = await Promise.all([
		import("@typescript-eslint/parser"),
		import("eslint"),
	]);
	const root = repositoryRoot();
	const rulePath = path.join(root, "packages/eslint-plugin-ts-drp/src/index.ts");
	const contractPath = path.join(root, "packages/blueprint-toolchain/contracts/no-ambient-lint-v1.json");
	const ruleBytes = fs.readFileSync(rulePath);
	const contractBytes = fs.readFileSync(contractPath);
	const contractText = decodeExactText(contractBytes, "lint contract");
	const contract = JSON.parse(contractText);
	if (contract.eslintVersion !== "9.23.0" || contract.parserVersion !== "8.29.0") {
		throw new TypeError("lint contract versions are unsupported");
	}
	const plugin = await loadRule(new TextDecoder("utf-8", { fatal: true }).decode(ruleBytes));
	lintTarget(sourceBytes.toString("utf8"), "blueprint.ts", "source", plugin, parser, LinterConstructor);
	lintTarget(artifact.toString("utf8"), "artifact.mjs", "artifact", plugin, parser, LinterConstructor);
	const artifactSha256 = sha256(artifact);
	const sourceSha256 = sha256(sourceBytes);
	return Buffer.from(
		encodeCanonical({
			artifactDigest: domainHex("ts-drp/blueprint-artifact/v3", artifact),
			artifactSha256,
			authoringSha256: sha256(authoringBytes),
			eslintVersion: "9.23.0",
			kind: "ts-drp-blueprint-lint-evidence",
			lintContractSha256: sha256(contractBytes),
			parserVersion: "8.29.0",
			result: "clean",
			ruleId: "drp/no-ambient-in-reducer",
			rulePackage: "eslint-plugin-ts-drp",
			ruleSourceSha256: sha256(ruleBytes),
			schemaVersion: 1,
			sourceSha256,
			targets: [
				{ diagnosticCount: 0, kind: "artifact", sha256: artifactSha256 },
				{ diagnosticCount: 0, kind: "source", sha256: sourceSha256 },
			],
		})
	);
}

/** @param {string} filename @param {Uint8Array} bytes */
function writeAtomicFile(filename, bytes) {
	const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.tmp`);
	fs.writeFileSync(temporary, bytes, { flag: "wx" });
	fs.renameSync(temporary, filename);
}

/** @param {string} filename */
async function readRegularInput(filename) {
	let handle;
	try {
		handle = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size === 0) throw new TypeError("authoring inputs must be nonempty regular files");
		const bytes = await handle.readFile();
		if (bytes.length !== stat.size) throw new TypeError("authoring input changed while being read");
		return bytes;
	} finally {
		await handle?.close();
	}
}

/** @param {string} authoringDirectory @param {string} outputDirectory */
export async function buildBlueprint(authoringDirectory, outputDirectory) {
	const suppliedDirectory = path.resolve(authoringDirectory);
	const realDirectory = fs.realpathSync(suppliedDirectory);
	const directoryStat = fs.lstatSync(realDirectory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new TypeError("--dir must be a directory");
	const entries = fs.readdirSync(realDirectory).sort();
	if (entries.length !== 2 || entries[0] !== "blueprint.json" || entries[1] !== "blueprint.ts") {
		throw new TypeError("authoring directory must contain exactly blueprint.json and blueprint.ts");
	}
	const jsonPath = path.join(realDirectory, "blueprint.json");
	const sourcePath = path.join(realDirectory, "blueprint.ts");
	const [authoringBytes, sourceBytes] = await Promise.all([readRegularInput(jsonPath), readRegularInput(sourcePath)]);
	const authoringText = decodeExactText(authoringBytes, "blueprint.json");
	const sourceText = decodeExactText(sourceBytes, "blueprint.ts");
	const authoring = parseAuthoring(authoringBytes, authoringText);
	const { default: parser } = await import("@typescript-eslint/parser");
	const sourceAst = parseSource(sourceText, parser);
	const bindings = moduleBindings(sourceAst);
	for (const operation of authoring.operations) {
		if (!bindings.has(operation.reducerBinding)) {
			throw new TypeError(`reducer binding ${operation.reducerBinding} is not module-scoped`);
		}
	}
	const artifact = await emitArtifact(sourceText, authoring);
	const lintEvidence = await createLintEvidence(sourceBytes, authoringBytes, artifact);
	const packagePlaceholder = encodeCanonical({ kind: "track-p2-b-package-placeholder", schemaVersion: 1 });
	const receiptPlaceholder = encodeCanonical({ kind: "track-p2-c-receipt-placeholder", schemaVersion: 1 });

	const output = path.resolve(outputDirectory);
	if (fs.existsSync(output)) {
		const stat = fs.lstatSync(output);
		if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(output).length !== 0) {
			throw new TypeError("--out must not exist or must be an empty directory");
		}
	}
	const parent = path.dirname(output);
	if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory()) throw new TypeError("--out parent must exist");
	const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.tmp-`));
	try {
		writeAtomicFile(path.join(stage, "artifact.mjs"), artifact);
		writeAtomicFile(path.join(stage, "lint.bin"), lintEvidence);
		writeAtomicFile(path.join(stage, "package.bin"), packagePlaceholder);
		writeAtomicFile(path.join(stage, "receipt.bin"), receiptPlaceholder);
		fs.renameSync(stage, output);
	} catch (error) {
		fs.rmSync(stage, { force: true, recursive: true });
		throw error;
	}
}

/** @param {readonly string[]} arguments_ */
export async function runBlueprintCli(arguments_) {
	if (arguments_[0] !== "build" || arguments_.length !== 7) throw new TypeError("invalid command grammar");
	const values = new Map();
	for (let index = 1; index < arguments_.length; index += 2) {
		const flag = arguments_[index];
		const value = arguments_[index + 1];
		if (!["--dir", "--out", "--tier"].includes(flag) || values.has(flag) || value === undefined || value.length === 0) {
			throw new TypeError("invalid build flags");
		}
		values.set(flag, value);
	}
	if (values.size !== 3 || !["pr", "nightly"].includes(values.get("--tier"))) {
		throw new TypeError("invalid build flags");
	}
	await buildBlueprint(values.get("--dir"), values.get("--out"));
}

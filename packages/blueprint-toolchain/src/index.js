/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/check-tag-names, jsdoc/no-types, jsdoc/require-param, jsdoc/require-param-description, jsdoc/require-returns, jsdoc/valid-types -- native JavaScript is the directly executable CLI source */
import { openTrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { init as initializeModuleLexer, parse as parseModule } from "es-module-lexer";
import { transformSync } from "esbuild";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
/** @type {readonly string[]} */
const CONTROL_NAMES = [
	"ambientBad",
	"thenable",
	"intrinsicMutation",
	"moduleGlobalDrift",
	"noncanonicalIntermediate",
	"sparseIntermediate",
];
const ENGINE_NAMES = ["node", "chromium", "firefox", "webkit"];
const INTRINSIC_TARGETS = [
	"Array.prototype",
	"Date.prototype",
	"Function.prototype",
	"JSON",
	"Math",
	"Object.prototype",
	"Promise.prototype",
	"Reflect",
];
/** @type {Readonly<Record<string, string>>} */
const CONTROL_SOURCES = {
	ambientBad:
		'const ambientReducer = ({ state, operation }) => {\n\tconst timer = setTimeout(() => undefined, 0);\n\treturn {\n\t\toutput: {\n\t\t\tdate: Date.now(),\n\t\t\tdom: globalThis.document.createElement("track-p2-c"),\n\t\t\tio: fetch("https://invalid.example/track-p2-c"),\n\t\t\tperformance: performance.now(),\n\t\t\trandom: Math.random(),\n\t\t\ttimer,\n\t\t},\n\t\tstate: operation.action === "add" ? state + (operation.arguments.value ?? 1) : state,\n\t};\n};\n',
	thenable:
		"const thenableReducer = () => ({\n\tthen(resolve) {\n\t\tresolve({ output: null, state: 0 });\n\t},\n});\nconst unchangedReducer = ({ state }) => ({ output: null, state });\n",
	intrinsicMutation:
		'const originalMap = Array.prototype.map;\nObject.defineProperty(Array.prototype, "map", {\n\tconfigurable: true,\n\tenumerable: false,\n\tvalue: function trackP2CMap(...arguments_) {\n\t\treturn originalMap.call(this, ...arguments_);\n\t},\n\twritable: true,\n});\nconst unchangedReducer = ({ state }) => ({ output: null, state });\n',
	moduleGlobalDrift:
		"let ordinal = 0;\nconst driftReducer = ({ state }) => ({ output: ++ordinal, state });\nconst unchangedReducer = ({ state }) => ({ output: null, state });\n",
	noncanonicalIntermediate:
		'const invalidReducer = ({ state }) => ({ output: null, state: { "value": state, "\\ud800": "present" } });\nconst unchangedReducer = ({ state }) => ({ output: null, state });\n',
	sparseIntermediate:
		"const sparseReducer = ({ state }) => {\n\tconst sparse = [];\n\tsparse[1] = state;\n\treturn { output: null, state: sparse };\n};\nconst unchangedReducer = ({ state }) => ({ output: null, state });\n",
};
const CHILD_TIMEOUT_MS = 120_000;
const CHILD_OUTPUT_LIMIT = 16 * 1024 * 1024;
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
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
				throw new TypeError(`${context} contains an unpaired surrogate`);
			}
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			throw new TypeError(`${context} contains an unpaired surrogate`);
		}
	}
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
	for (const comment of program.comments ?? []) {
		if (
			comment.type === "Line" &&
			/^\/\s*<reference\s+[^>]*\b(?:path|types|lib|no-default-lib)\s*=/u.test(comment.value)
		) {
			throw new TypeError("blueprint.ts reference directives are forbidden");
		}
	}
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
	return {
		artifactId,
		authoringBytes,
		conformance: {
			corpusVersion,
			initialState: conformance.initialState,
			nightlyAdditionalCases: conformance.nightlyAdditionalCases,
			prCases: conformance.prCases,
			seed,
		},
		operationDiscriminator: discriminator,
		operations,
	};
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

/** @param {Uint8Array} artifact @param {{artifactId:string, operationDiscriminator:string, operations:readonly {name:string,fields:readonly {name:string,required:boolean,type:string}[]}[]}} authoring */
async function preparePackageBinding(artifact, authoring) {
	const blueprintPackage = {
		implementation: {
			artifactDigest: domainHex("ts-drp/blueprint-artifact/v3", artifact),
			artifactId: authoring.artifactId,
			runtimeProfile: "ecmascript-2024-sync-v1",
		},
		kind: "drp-blueprint-admission-package",
		manifest: {
			operationDiscriminator: authoring.operationDiscriminator,
			operations: authoring.operations.map((operation) => ({
				argumentSchema: {
					fields: operation.fields.map((field) => ({
						name: field.name,
						required: field.required,
						type: field.type,
					})),
					kind: "closed-record",
				},
				name: operation.name,
			})),
			schemaVersion: 1,
		},
		protocolMajor: 3,
		schemaVersion: 1,
	};
	const canonicalBlueprintPackageBytes = encodeCanonical(blueprintPackage);
	const expectedBlueprintDigest = domainHex("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes);
	const preparedBlueprintAdmission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes,
		expectedBlueprintDigest,
	});
	await prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes,
		exactArtifactBytes: artifact,
		expectedBlueprintDigest,
		preparedBlueprintAdmission,
	});
	return { blueprintPackage, canonicalBlueprintPackageBytes, expectedBlueprintDigest };
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
	if (kind === "artifact" && linter.getSourceCode()?.getAllComments().length !== 0) {
		throw new TypeError(`${filename} comments are forbidden`);
	}
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

/** @param {unknown} value @param {readonly string[]} keys @param {string} context */
function assertExactRecord(value, keys, context) {
	assertClosedRecord(value, [...keys].sort(), context);
	return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string} context */
function assertArray(value, context) {
	if (!Array.isArray(value)) throw new TypeError(`${context} must be an array`);
	return value;
}

/** @param {unknown} value @param {string} context */
function assertDigest(value, context) {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
		throw new TypeError(`${context} must be a lowercase digest`);
	}
	return value;
}

/** @param {unknown} left @param {unknown} right */
function canonicalEqual(left, right) {
	return Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right)));
}

/** @param {unknown} value @returns {string} */
function compactJson(value) {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("generated contract contains a non-finite number");
		return Object.is(value, -0) ? "-0" : JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => compactJson(item)).join(",")}]`;
	const record = assertExactRecord(
		value,
		Reflect.ownKeys(/** @type {object} */ (value)).map(String),
		"generated value"
	);
	return `{${Object.keys(record)
		.map((key) => `${JSON.stringify(key)}:${compactJson(record[key])}`)
		.join(",")}}`;
}

/** @param {string} name @param {string} operationName @param {string} selectedAction */
function controlReducerBinding(name, operationName, selectedAction) {
	if (name === "ambientBad") return "ambientReducer";
	if (name === "intrinsicMutation") return "unchangedReducer";
	if (operationName !== selectedAction) return "unchangedReducer";
	if (name === "thenable") return "thenableReducer";
	if (name === "moduleGlobalDrift") return "driftReducer";
	if (name === "noncanonicalIntermediate") return "invalidReducer";
	if (name === "sparseIntermediate") return "sparseReducer";
	throw new TypeError("unknown conformance control");
}

/** @param {string} source @param {string} filename */
async function proveAmbientLintRejects(source, filename) {
	const [{ default: parser }, { Linter: LinterConstructor }] = await Promise.all([
		import("@typescript-eslint/parser"),
		import("eslint"),
	]);
	const ruleBytes = fs.readFileSync(path.join(repositoryRoot(), "packages/eslint-plugin-ts-drp/src/index.ts"));
	const plugin = await loadRule(new TextDecoder("utf-8", { fatal: true }).decode(ruleBytes));
	try {
		lintTarget(source, filename, "source", plugin, parser, LinterConstructor);
	} catch {
		return;
	}
	throw new TypeError("ambientBad must be rejected by deterministic lint");
}

/** @param {string} snapshot @param {string} context */
function assertIntrinsicSnapshot(snapshot, context) {
	if (typeof snapshot !== "string") throw new TypeError(`${context} must be a string`);
	let parsed;
	try {
		parsed = JSON.parse(snapshot);
	} catch {
		throw new TypeError(`${context} must be JSON`);
	}
	const entries = assertArray(parsed, context);
	if (
		entries.length !== INTRINSIC_TARGETS.length ||
		entries.some((entry, index) => !Array.isArray(entry) || entry.length !== 2 || entry[0] !== INTRINSIC_TARGETS[index])
	) {
		throw new TypeError(`${context} has invalid targets`);
	}
	return snapshot;
}

/** @param {readonly Record<string, any>[]} operations @param {unknown} initialState @param {string} selectedAction @param {number} initialOrdinal */
function expectedDriftRun(operations, initialState, selectedAction, initialOrdinal) {
	let ordinal = initialOrdinal;
	const outputs = operations.map((operation) => (operation.action === selectedAction ? ++ordinal : null));
	return {
		digest: domainHex("ts-drp/blueprint-conformance/v1", encodeCanonical({ state: initialState, outputs })),
		ordinal,
	};
}

/**
 * @param {unknown} rawReceipt
 * @param {'pr'|'nightly'} tier
 * @param {any} authoring
 * @param {Record<string, Buffer>} artifacts
 */
function validateChildReceipt(rawReceipt, tier, authoring, artifacts) {
	const receipt = assertExactRecord(
		rawReceipt,
		[
			"receiptSchemaVersion",
			"runtimeProfile",
			"artifactDigest",
			"packageBinding",
			"executionTier",
			"artifacts",
			"corpus",
			"selectedIntrinsicDescriptorTargets",
			"engines",
			"negativeControls",
			"catalogEntry",
		],
		"child receipt"
	);
	const primaryDigest = domainHex("ts-drp/blueprint-artifact/v3", artifacts.primary);
	if (
		receipt.receiptSchemaVersion !== 1 ||
		receipt.runtimeProfile !== "ecmascript-2024-sync-v1" ||
		receipt.artifactDigest !== primaryDigest ||
		receipt.executionTier !== tier ||
		!canonicalEqual(receipt.selectedIntrinsicDescriptorTargets, INTRINSIC_TARGETS)
	) {
		throw new TypeError("child receipt header is invalid");
	}
	const packageBinding = assertExactRecord(
		receipt.packageBinding,
		["artifactDigest", "artifactId", "runtimeProfile"],
		"child package binding"
	);
	if (
		packageBinding.artifactDigest !== primaryDigest ||
		packageBinding.artifactId !== authoring.artifactId ||
		packageBinding.runtimeProfile !== "ecmascript-2024-sync-v1"
	) {
		throw new TypeError("child package binding is invalid");
	}
	const childArtifacts = assertExactRecord(receipt.artifacts, ["primary", ...CONTROL_NAMES], "child artifacts");
	for (const [name, bytes] of Object.entries(artifacts)) {
		const evidence = assertExactRecord(
			childArtifacts[name],
			["artifactDigest", "exactBytesSha256"],
			`child artifact ${name}`
		);
		if (
			evidence.artifactDigest !== domainHex("ts-drp/blueprint-artifact/v3", bytes) ||
			evidence.exactBytesSha256 !== sha256(bytes)
		) {
			throw new TypeError(`child artifact ${name} is not bound to exact bytes`);
		}
	}
	const prOperations = /** @type {Record<string, any>[]} */ (authoring.conformance.prCases).map(
		({ id, action, arguments: arguments_ }) => ({
			id,
			action,
			arguments: arguments_,
		})
	);
	const nightlyOperations = [
		...prOperations,
		.../** @type {Record<string, any>[]} */ (authoring.conformance.nightlyAdditionalCases).map(
			({ id, action, arguments: arguments_ }) => ({
				id,
				action,
				arguments: arguments_,
			})
		),
	];
	const selectedOperations = tier === "pr" ? prOperations : nightlyOperations;
	const selectedIds = selectedOperations.map(({ id }) => id);
	const selectedControlAction = prOperations[0].action;
	const corpus = assertExactRecord(
		receipt.corpus,
		["corpusVersion", "seed", "operationOrder", "pr", "nightly"],
		"child corpus"
	);
	const pr = assertExactRecord(corpus.pr, ["total", "selected", "dropped", "selectedCaseIds"], "child PR corpus");
	const nightly = assertExactRecord(
		corpus.nightly,
		["total", "selected", "dropped", "selectedCaseIds"],
		"child nightly corpus"
	);
	if (
		corpus.corpusVersion !== authoring.conformance.corpusVersion ||
		corpus.seed !== authoring.conformance.seed ||
		!canonicalEqual(
			corpus.operationOrder,
			selectedOperations.map(({ action }) => action)
		) ||
		!canonicalEqual(pr, {
			total: prOperations.length,
			selected: prOperations.length,
			dropped: 0,
			selectedCaseIds: prOperations.map(({ id }) => id),
		}) ||
		!canonicalEqual(nightly, {
			total: nightlyOperations.length,
			selected: nightlyOperations.length,
			dropped: 0,
			selectedCaseIds: nightlyOperations.map(({ id }) => id),
		})
	) {
		throw new TypeError("child corpus evidence is invalid");
	}
	const engines = assertArray(receipt.engines, "child engines");
	if (engines.length !== ENGINE_NAMES.length) throw new TypeError("child engine count is invalid");
	const conformanceDigests = [];
	const badFixtureDigests = [];
	for (let index = 0; index < engines.length; index++) {
		const engine = assertExactRecord(
			engines[index],
			[
				"build",
				"conformanceDigest",
				"finalState",
				"name",
				"outputs",
				"hooks",
				"executedCaseIds",
				"normalization",
				"replays",
				"sentinel",
				"thenable",
				"canonicalIntermediate",
				"sparseIntermediate",
				"intrinsicSnapshots",
			],
			`child engine ${index}`
		);
		if (
			engine.name !== ENGINE_NAMES[index] ||
			typeof engine.build !== "string" ||
			!/^[\x20-\x7e]{1,512}$/u.test(engine.build) ||
			!canonicalEqual(engine.executedCaseIds, selectedIds)
		) {
			throw new TypeError(`child engine ${index} identity is invalid`);
		}
		assertBoundedCanonical(engine.finalState);
		const outputs = assertArray(engine.outputs, `child engine ${index} outputs`);
		if (outputs.length !== selectedOperations.length)
			throw new TypeError(`child engine ${index} output count is invalid`);
		assertBoundedCanonical(outputs);
		const exactDigest = domainHex(
			"ts-drp/blueprint-conformance/v1",
			encodeCanonical({ state: engine.finalState, outputs })
		);
		if (engine.conformanceDigest !== exactDigest) throw new TypeError(`child engine ${index} digest is invalid`);
		conformanceDigests.push(assertDigest(engine.conformanceDigest, `child engine ${index} digest`));
		const hooks = assertExactRecord(
			engine.hooks,
			["Date", "Math.random", "performance", "timers", "io", "dom"],
			`child engine ${index} hooks`
		);
		for (const hookName of ["Date", "Math.random", "performance", "timers", "io", "dom"]) {
			const hook = assertExactRecord(hooks[hookName], ["installed", "probe"], `child hook ${hookName}`);
			if (hook.installed !== true || hook.probe !== `${engine.name}:${hookName}`) {
				throw new TypeError(`child hook ${hookName} is invalid`);
			}
		}
		const normalization = assertExactRecord(
			engine.normalization,
			["negativeZeroOperationArguments", "normalizedNegativeZeroOutputs"],
			`child engine ${index} normalization`
		);
		const normalizedOutputCount = outputs.filter(
			(output) => output !== null && typeof output === "object" && output.normalizedNegativeZero === true
		).length;
		if (
			normalization.negativeZeroOperationArguments !== 1 ||
			normalization.normalizedNegativeZeroOutputs !== normalizedOutputCount
		) {
			throw new TypeError(`child engine ${index} normalization is invalid`);
		}
		const replays = assertExactRecord(
			engine.replays,
			["freshInstances", "sameModuleInstance"],
			`child engine ${index} replays`
		);
		for (const kind of ["freshInstances", "sameModuleInstance"]) {
			const values = assertArray(replays[kind], `child engine ${index} ${kind}`);
			if (values.length !== 2 || values.some((value) => value !== exactDigest)) {
				throw new TypeError(`child engine ${index} ${kind} is invalid`);
			}
		}
		const sentinel = assertExactRecord(
			engine.sentinel,
			[
				"ambientHookConsumption",
				"badFixtureDigest",
				"badFixtureMismatch",
				"intrinsicMutationDetected",
				"throwModeFailedClosed",
			],
			`child engine ${index} sentinel`
		);
		if (
			!canonicalEqual(sentinel.ambientHookConsumption, ["Date", "Math.random", "performance", "timers", "io", "dom"]) ||
			sentinel.badFixtureMismatch !== true ||
			sentinel.intrinsicMutationDetected !== true ||
			sentinel.throwModeFailedClosed !== true ||
			sentinel.badFixtureDigest === exactDigest
		) {
			throw new TypeError(`child engine ${index} sentinel is invalid`);
		}
		badFixtureDigests.push(assertDigest(sentinel.badFixtureDigest, `child engine ${index} bad fixture digest`));
		for (const [name, value] of [
			["thenable", engine.thenable],
			["canonicalIntermediate", engine.canonicalIntermediate],
			["sparseIntermediate", engine.sparseIntermediate],
		]) {
			const control = assertExactRecord(value, ["executed", "rejected"], `child engine ${index} ${name}`);
			if (control.executed !== true || control.rejected !== true) {
				throw new TypeError(`child engine ${index} ${name} is invalid`);
			}
		}
		const snapshots = assertExactRecord(
			engine.intrinsicSnapshots,
			["beforeEvaluation", "afterEvaluation", "afterEveryReplay"],
			`child engine ${index} intrinsic snapshots`
		);
		const before = assertIntrinsicSnapshot(snapshots.beforeEvaluation, `child engine ${index} before snapshot`);
		if (assertIntrinsicSnapshot(snapshots.afterEvaluation, `child engine ${index} after snapshot`) !== before) {
			throw new TypeError(`child engine ${index} changed intrinsics during primary evaluation`);
		}
		const afterEveryReplay = assertArray(snapshots.afterEveryReplay, `child engine ${index} replay snapshots`);
		if (
			afterEveryReplay.length !== 4 ||
			afterEveryReplay.some(
				(value, replayIndex) =>
					assertIntrinsicSnapshot(value, `child engine ${index} replay snapshot ${replayIndex}`) !== before
			)
		) {
			throw new TypeError(`child engine ${index} replay snapshots are invalid`);
		}
	}
	if (new Set(conformanceDigests).size !== 1 || new Set(badFixtureDigests).size !== ENGINE_NAMES.length) {
		throw new TypeError("child cross-engine evidence disagrees");
	}
	const negative = assertExactRecord(
		receipt.negativeControls,
		["moduleGlobalDrift", "intrinsicMutation"],
		"child negative controls"
	);
	const moduleGlobal = assertExactRecord(
		negative.moduleGlobalDrift,
		["detected", "sameModuleInstanceDigests", "freshInstanceDigests"],
		"child module-global control"
	);
	const firstDrift = expectedDriftRun(selectedOperations, authoring.conformance.initialState, selectedControlAction, 0);
	const secondDrift = expectedDriftRun(
		selectedOperations,
		authoring.conformance.initialState,
		selectedControlAction,
		firstDrift.ordinal
	);
	if (
		moduleGlobal.detected !== true ||
		!canonicalEqual(moduleGlobal.sameModuleInstanceDigests, [firstDrift.digest, secondDrift.digest]) ||
		!canonicalEqual(moduleGlobal.freshInstanceDigests, [firstDrift.digest, firstDrift.digest])
	) {
		throw new TypeError("child module-global evidence is invalid");
	}
	const intrinsic = assertExactRecord(
		negative.intrinsicMutation,
		["detected", "snapshotBeforeEvaluation", "snapshotAfterEvaluation"],
		"child intrinsic control"
	);
	const nodeBefore = /** @type {any} */ (engines[0]).intrinsicSnapshots.beforeEvaluation;
	if (
		intrinsic.detected !== true ||
		assertIntrinsicSnapshot(intrinsic.snapshotBeforeEvaluation, "child intrinsic control before") !== nodeBefore ||
		assertIntrinsicSnapshot(intrinsic.snapshotAfterEvaluation, "child intrinsic control after") === nodeBefore
	) {
		throw new TypeError("child intrinsic control evidence is invalid");
	}
	const catalogEntry = assertExactRecord(
		receipt.catalogEntry,
		[
			"artifactDigest",
			"corpusVersion",
			"engineBuilds",
			"operationOrder",
			"result",
			"runtimeProfile",
			"seed",
			"executionTier",
		],
		"child catalog entry"
	);
	const engineBuilds = assertExactRecord(catalogEntry.engineBuilds, ENGINE_NAMES, "child engine builds");
	if (
		catalogEntry.artifactDigest !== primaryDigest ||
		catalogEntry.corpusVersion !== authoring.conformance.corpusVersion ||
		catalogEntry.result !== "passed" ||
		catalogEntry.runtimeProfile !== "ecmascript-2024-sync-v1" ||
		catalogEntry.seed !== authoring.conformance.seed ||
		catalogEntry.executionTier !== tier ||
		!canonicalEqual(
			catalogEntry.operationOrder,
			selectedOperations.map(({ action }) => action)
		) ||
		ENGINE_NAMES.some((name, index) => engineBuilds[name] !== /** @type {any} */ (engines[index]).build)
	) {
		throw new TypeError("child catalog evidence is invalid");
	}
	return { conformanceDigest: conformanceDigests[0], engines, selectedIds, selectedOperations };
}

/** @param {string} command @param {readonly string[]} arguments_ @param {string} cwd @returns {Promise<{code:number|null,signal:NodeJS.Signals|null,stderr:Buffer,stdout:Buffer}>} */
function spawnBounded(command, arguments_, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, arguments_, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		/** @type {Buffer[]} */
		const stdout = [];
		/** @type {Buffer[]} */
		const stderr = [];
		let stdoutLength = 0;
		let stderrLength = 0;
		let settled = false;
		/** @param {Error|undefined} error @param {{code:number|null,signal:NodeJS.Signals|null,stderr:Buffer,stdout:Buffer}} [value] */
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error === undefined && value !== undefined) resolve(value);
			else reject(error);
		};
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error("blueprint conformance child timed out"));
		}, CHILD_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdoutLength += chunk.length;
			if (stdoutLength > CHILD_OUTPUT_LIMIT) {
				child.kill("SIGKILL");
				finish(new Error("blueprint conformance stdout exceeded its bound"));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderrLength += chunk.length;
			if (stderrLength <= CHILD_OUTPUT_LIMIT) stderr.push(chunk);
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code, signal) =>
			finish(undefined, { code, signal, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) })
		);
	});
}

/** @param {Buffer} bytes */
function parseChildStdout(bytes) {
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new TypeError("blueprint conformance child stdout is not UTF-8");
	}
	if (!text.endsWith("\n") || text.includes("\r") || text.slice(0, -1).includes("\n") || text.length === 1) {
		throw new TypeError("blueprint conformance child must emit exactly one JSON record");
	}
	try {
		return JSON.parse(text.slice(0, -1));
	} catch {
		throw new TypeError("blueprint conformance child emitted malformed JSON");
	}
}

/** @param {any} authoring @param {Buffer} sourceBytes @param {Buffer} artifact @param {any} packageTemplate @param {'pr'|'nightly'} tier @param {Buffer} lintEvidence */
async function createConformanceReceipt(authoring, sourceBytes, artifact, packageTemplate, tier, lintEvidence) {
	const root = repositoryRoot();
	const runnerRelative = "packages/protocol-v3/scripts/run-blueprint-conformance-v1.mjs";
	const runner = path.join(root, runnerRelative);
	/** @param {string} name */
	const artifactIdFor = (name) => {
		const id = `${authoring.artifactId}::${name}`;
		if (Buffer.byteLength(id) > 128 || !/^[\x21-\x7e]+$/u.test(id)) {
			throw new TypeError(`control artifactId ${name} is invalid`);
		}
		return id;
	};
	/** @type {Record<string, Buffer>} */
	const artifacts = { primary: artifact };
	const prOperations = /** @type {Record<string, any>[]} */ (authoring.conformance.prCases).map(
		({ id, action, arguments: arguments_ }) => ({
			id,
			action,
			arguments: arguments_,
		})
	);
	const selectedControlAction = prOperations[0].action;
	/** @type {Record<string, {artifact:Buffer,artifactId:string,source:string}>} */
	const controls = {};
	for (const name of CONTROL_NAMES) {
		const source = CONTROL_SOURCES[name];
		const artifactId = artifactIdFor(name);
		const operations = /** @type {{name:string,reducerBinding:string}[]} */ (
			/** @type {Record<string, any>[]} */ (authoring.operations).map((operation) => ({
				...operation,
				reducerBinding: controlReducerBinding(name, operation.name, selectedControlAction),
			}))
		);
		controls[name] = { artifact: await emitArtifact(source, { artifactId, operations }), artifactId, source };
		artifacts[name] = controls[name].artifact;
	}
	await proveAmbientLintRejects(CONTROL_SOURCES.ambientBad, "ambientBad.ts");
	const nightlyOperations = [
		...prOperations,
		.../** @type {Record<string, any>[]} */ (authoring.conformance.nightlyAdditionalCases).map(
			({ id, action, arguments: arguments_ }) => ({
				id,
				action,
				arguments: arguments_,
			})
		),
	];
	const orderedPackageTemplate = {
		kind: packageTemplate.kind,
		protocolMajor: packageTemplate.protocolMajor,
		schemaVersion: packageTemplate.schemaVersion,
		implementation: {
			artifactId: packageTemplate.implementation.artifactId,
			artifactDigest: packageTemplate.implementation.artifactDigest,
			runtimeProfile: packageTemplate.implementation.runtimeProfile,
		},
		manifest: {
			schemaVersion: packageTemplate.manifest.schemaVersion,
			operationDiscriminator: packageTemplate.manifest.operationDiscriminator,
			operations: /** @type {Record<string, any>[]} */ (packageTemplate.manifest.operations).map((operation) => ({
				name: operation.name,
				argumentSchema: {
					kind: operation.argumentSchema.kind,
					fields: /** @type {Record<string, any>[]} */ (operation.argumentSchema.fields).map((field) => ({
						name: field.name,
						required: field.required,
						type: field.type,
					})),
				},
			})),
		},
	};
	const contract = {
		schemaVersion: 1,
		runner: { relativePath: runnerRelative, receiptSchemaVersion: 1 },
		runtimeProfile: "ecmascript-2024-sync-v1",
		artifactDigestDomain: "ts-drp/blueprint-artifact/v3",
		conformance: {
			digestDomain: "ts-drp/blueprint-conformance/v1",
			corpusVersion: authoring.conformance.corpusVersion,
			seed: authoring.conformance.seed,
			operationOrder: prOperations.map(({ action }) => action),
			initialState: authoring.conformance.initialState,
			selectedIntrinsicDescriptorTargets: INTRINSIC_TARGETS,
			pr: { total: prOperations.length, selected: prOperations.length, dropped: 0 },
			nightly: {
				total: nightlyOperations.length,
				selected: nightlyOperations.length,
				dropped: 0,
				additionalSelectedCaseIds: /** @type {Record<string, any>[]} */ (
					authoring.conformance.nightlyAdditionalCases
				).map(({ id }) => id),
			},
		},
		packageTemplate: orderedPackageTemplate,
		artifacts: {
			primary: { file: "primary.mjs", artifactId: authoring.artifactId },
			...Object.fromEntries(
				CONTROL_NAMES.map((name) => [name, { file: `${name}.mjs`, artifactId: controls[name].artifactId }])
			),
		},
		prOperations,
		nightlyOperations,
	};
	const contractBytes = Buffer.from(`${compactJson(contract)}\n`);
	const temporaryDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ts-drp-blueprint-conformance-"));
	try {
		fs.writeFileSync(path.join(temporaryDirectory, "contract.json"), contractBytes, { flag: "wx" });
		fs.writeFileSync(path.join(temporaryDirectory, "primary.ts"), sourceBytes, { flag: "wx" });
		fs.writeFileSync(path.join(temporaryDirectory, "primary.mjs"), artifact, { flag: "wx" });
		for (const name of CONTROL_NAMES) {
			fs.writeFileSync(path.join(temporaryDirectory, `${name}.ts`), CONTROL_SOURCES[name], { flag: "wx" });
			fs.writeFileSync(path.join(temporaryDirectory, `${name}.mjs`), controls[name].artifact, { flag: "wx" });
		}
		const completion = /** @type {{code:number|null,signal:NodeJS.Signals|null,stderr:Buffer,stdout:Buffer}} */ (
			await spawnBounded(
				process.execPath,
				[runner, "--contract", path.join(temporaryDirectory, "contract.json"), "--tier", tier],
				root
			)
		);
		if (completion.code !== 0 || completion.signal !== null) {
			const diagnostic = completion.stderr.toString("utf8").trim();
			throw new Error(`blueprint conformance child failed${diagnostic.length === 0 ? "" : `: ${diagnostic}`}`);
		}
		const childReceipt = parseChildStdout(completion.stdout);
		const validated = validateChildReceipt(childReceipt, tier, authoring, artifacts);
		const controlArtifactDigests = Object.fromEntries(
			CONTROL_NAMES.map((name) => [name, domainHex("ts-drp/blueprint-artifact/v3", artifacts[name])])
		);
		const corpusBytes = encodeCanonical({
			schemaVersion: 1,
			corpusVersion: authoring.conformance.corpusVersion,
			seed: authoring.conformance.seed,
			initialState: authoring.conformance.initialState,
			prCases: authoring.conformance.prCases,
			nightlyAdditionalCases: authoring.conformance.nightlyAdditionalCases,
		});
		const receipt = {
			schemaVersion: 1,
			kind: "ts-drp-blueprint-conformance-receipt",
			artifactId: authoring.artifactId,
			runtimeProfile: "ecmascript-2024-sync-v1",
			blueprintDigest: domainHex("ts-drp/blueprint-admission/v3", encodeCanonical(packageTemplate)),
			artifactDigest: domainHex("ts-drp/blueprint-artifact/v3", artifact),
			lintEvidenceDigest: domainHex("ts-drp/blueprint-lint-evidence/v1", lintEvidence),
			corpusDigest: domainHex("ts-drp/blueprint-conformance-corpus/v1", corpusBytes),
			executionTier: tier,
			result: "passed",
			conformanceDigest: validated.conformanceDigest,
			corpusVersion: authoring.conformance.corpusVersion,
			seed: authoring.conformance.seed,
			operationOrder: validated.selectedOperations.map(({ action }) => action),
			selectedCaseIds: validated.selectedIds,
			corpusAccounting: {
				pr: { total: prOperations.length, selected: prOperations.length, dropped: 0 },
				nightly: { total: nightlyOperations.length, selected: nightlyOperations.length, dropped: 0 },
			},
			engines: validated.engines.map(({ name, build, conformanceDigest }) => ({ name, build, conformanceDigest })),
			controlArtifactDigests,
			controlOutcomes: {
				ambientBad: { lintRejected: true, crossEngineDigestDisagreement: true },
				thenable: { executed: true, rejected: true },
				intrinsicMutation: { detected: true },
				moduleGlobalDrift: { detected: true },
				noncanonicalIntermediate: { executed: true, rejected: true },
				sparseIntermediate: { executed: true, rejected: true },
			},
			runnerSha256: sha256(fs.readFileSync(runner)),
		};
		const receiptBytes = Buffer.from(encodeCanonical(receipt));
		assertDigest(domainHex("ts-drp/blueprint-conformance-receipt/v1", receiptBytes), "receipt digest");
		return receiptBytes;
	} finally {
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	}
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

/** @param {string} bundleDirectory */
async function readCatalogBundle(bundleDirectory) {
	const supplied = path.resolve(bundleDirectory);
	const stat = fs.lstatSync(supplied);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("--bundle must be a directory");
	const directory = fs.realpathSync(supplied);
	const names = fs.readdirSync(directory).sort();
	const expected = ["artifact.mjs", "lint.bin", "package.bin", "receipt.bin"];
	if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
		throw new TypeError("bundle must contain exactly four build products");
	}
	const [artifactBytes, lintBytes, packageBytes, receiptBytes] = await Promise.all([
		readRegularInput(path.join(directory, "artifact.mjs")),
		readRegularInput(path.join(directory, "lint.bin")),
		readRegularInput(path.join(directory, "package.bin")),
		readRegularInput(path.join(directory, "receipt.bin")),
	]);
	let packageValue;
	let lintValue;
	let receiptValue;
	try {
		packageValue = decodeCanonical(packageBytes);
		lintValue = decodeCanonical(lintBytes);
		receiptValue = decodeCanonical(receiptBytes);
	} catch {
		throw new TypeError("bundle contains invalid canonical bytes");
	}
	if (
		packageValue === null ||
		typeof packageValue !== "object" ||
		Array.isArray(packageValue) ||
		lintValue === null ||
		typeof lintValue !== "object" ||
		Array.isArray(lintValue) ||
		receiptValue === null ||
		typeof receiptValue !== "object" ||
		Array.isArray(receiptValue)
	) {
		throw new TypeError("bundle canonical products must be records");
	}
	const implementation = /** @type {Record<string, unknown>} */ (packageValue).implementation;
	if (implementation === null || typeof implementation !== "object" || Array.isArray(implementation)) {
		throw new TypeError("bundle package implementation is invalid");
	}
	const implementationRecord = /** @type {Record<string, unknown>} */ (implementation);
	const blueprintDigest = domainHex("ts-drp/blueprint-admission/v3", packageBytes);
	return {
		directory,
		blueprintDigest,
		artifactBytes,
		lintBytes,
		packageBytes,
		receiptBytes,
		entry: {
			blueprintDigest,
			artifactDigest: implementationRecord.artifactDigest,
			artifactId: implementationRecord.artifactId,
			runtimeProfile: implementationRecord.runtimeProfile,
			lintEvidenceDigest: domainHex("ts-drp/blueprint-lint-evidence/v1", lintBytes),
			conformanceReceiptDigest: domainHex("ts-drp/blueprint-conformance-receipt/v1", receiptBytes),
		},
	};
}

/** @param {string} outputDirectory @param {readonly string[]} bundleDirectories */
async function constructCatalog(outputDirectory, bundleDirectories) {
	const output = path.resolve(outputDirectory);
	if (fs.existsSync(output)) {
		const stat = fs.lstatSync(output);
		if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(output).length !== 0) {
			throw new TypeError("--directory must not exist or must be empty");
		}
	}
	const parent = path.dirname(output);
	if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory()) {
		throw new TypeError("--directory parent must exist");
	}

	const seen = new Set();
	const resolvedBundles = [];
	for (const bundleDirectory of bundleDirectories) {
		const supplied = path.resolve(bundleDirectory);
		const stat = fs.lstatSync(supplied);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("--bundle must be a directory");
		const real = fs.realpathSync(supplied);
		if (seen.has(real)) throw new TypeError("--bundle directories must be distinct");
		seen.add(real);
		resolvedBundles.push(supplied);
	}
	const bundles = await Promise.all(resolvedBundles.map((directory) => readCatalogBundle(directory)));
	bundles.sort((left, right) => left.blueprintDigest.localeCompare(right.blueprintDigest));
	const catalogBytes = Buffer.from(
		encodeCanonical({
			schemaVersion: 1,
			kind: "ts-drp-trusted-blueprint-catalog",
			entries: bundles.map(({ entry }) => entry),
		})
	);
	const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.tmp-`));
	try {
		writeAtomicFile(path.join(stage, "catalog.bin"), catalogBytes);
		for (const bundle of bundles) {
			writeAtomicFile(path.join(stage, `${bundle.blueprintDigest}.artifact.mjs`), bundle.artifactBytes);
			writeAtomicFile(path.join(stage, `${bundle.blueprintDigest}.package.bin`), bundle.packageBytes);
			writeAtomicFile(path.join(stage, `${bundle.blueprintDigest}.lint.bin`), bundle.lintBytes);
			writeAtomicFile(path.join(stage, `${bundle.blueprintDigest}.receipt.bin`), bundle.receiptBytes);
		}
		openTrustedBlueprintCatalog({ catalogDirectory: stage });
		fs.renameSync(stage, output);
	} catch (error) {
		fs.rmSync(stage, { force: true, recursive: true });
		throw error;
	}
}

/** @param {string} authoringDirectory @param {string} outputDirectory @param {'pr'|'nightly'} [tier] */
export async function buildBlueprint(authoringDirectory, outputDirectory, tier) {
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
	const { blueprintPackage, canonicalBlueprintPackageBytes, expectedBlueprintDigest } = await preparePackageBinding(
		artifact,
		authoring
	);
	const receiptBytes =
		tier === undefined
			? encodeCanonical({ kind: "track-p2-c-receipt-placeholder", schemaVersion: 1 })
			: await createConformanceReceipt(authoring, sourceBytes, artifact, blueprintPackage, tier, lintEvidence);
	if (expectedBlueprintDigest !== domainHex("ts-drp/blueprint-admission/v3", canonicalBlueprintPackageBytes)) {
		throw new TypeError("blueprint package digest changed during conformance");
	}

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
		writeAtomicFile(path.join(stage, "package.bin"), canonicalBlueprintPackageBytes);
		writeAtomicFile(path.join(stage, "receipt.bin"), receiptBytes);
		fs.renameSync(stage, output);
	} catch (error) {
		fs.rmSync(stage, { force: true, recursive: true });
		throw error;
	}
}

/** @param {readonly string[]} arguments_ */
export async function runBlueprintCli(arguments_) {
	const command = arguments_[0];
	if (command === "build") {
		if (arguments_.length !== 7) throw new TypeError("invalid command grammar");
		const values = new Map();
		for (let index = 1; index < arguments_.length; index += 2) {
			const flag = arguments_[index];
			const value = arguments_[index + 1];
			if (
				!["--dir", "--out", "--tier"].includes(flag) ||
				values.has(flag) ||
				value === undefined ||
				value.length === 0
			) {
				throw new TypeError("invalid build flags");
			}
			values.set(flag, value);
		}
		if (values.size !== 3 || !["pr", "nightly"].includes(values.get("--tier"))) {
			throw new TypeError("invalid build flags");
		}
		await buildBlueprint(values.get("--dir"), values.get("--out"), values.get("--tier"));
		return;
	}
	if (command === "catalog") {
		if (arguments_.length < 5 || arguments_.length % 2 === 0) throw new TypeError("invalid command grammar");
		let directory;
		const bundles = [];
		for (let index = 1; index < arguments_.length; index += 2) {
			const flag = arguments_[index];
			const value = arguments_[index + 1];
			if (value === undefined || value.length === 0) throw new TypeError("invalid catalog flags");
			if (flag === "--directory" && directory === undefined) directory = value;
			else if (flag === "--bundle") bundles.push(value);
			else throw new TypeError("invalid catalog flags");
		}
		if (directory === undefined || bundles.length === 0) throw new TypeError("invalid catalog flags");
		await constructCatalog(directory, bundles);
		return;
	}
	if (command === "verify") {
		if (arguments_.length !== 5) throw new TypeError("invalid command grammar");
		const values = new Map();
		for (let index = 1; index < arguments_.length; index += 2) {
			const flag = arguments_[index];
			const value = arguments_[index + 1];
			if (
				!["--directory", "--blueprint-digest"].includes(flag) ||
				values.has(flag) ||
				value === undefined ||
				value.length === 0
			) {
				throw new TypeError("invalid verify flags");
			}
			values.set(flag, value);
		}
		if (values.size !== 2) throw new TypeError("invalid verify flags");
		openTrustedBlueprintCatalog({ catalogDirectory: values.get("--directory") }).resolve(
			values.get("--blueprint-digest")
		);
		return;
	}
	throw new TypeError("invalid command grammar");
}

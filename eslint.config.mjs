import eslint from "@eslint/js";
import tsparser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import jsdoc from "eslint-plugin-jsdoc";
import prettier from "eslint-plugin-prettier";
import unusedImports from "eslint-plugin-unused-imports";
import vitest from "eslint-plugin-vitest";
import globals from "globals";
import { configs, plugin, config as tsLintConfig } from "typescript-eslint";

/** @type {import("typescript-eslint").ConfigArray} */
const config = tsLintConfig(
	{
		ignores: [
			"**/.env",
			"**/.DS_Store",
			"**/.gitignore",
			"**/.prettierignore",
			"**/.vscode/*",
			"**/node_modules/*",
			"**/dist/*",
			"**/docs/*",
			"**/doc/*",
			"**/bundle/*",
			"**/coverage/*",
			"packages/protocol-v2/conformance/ahe-reference/**",
			"**/.network-spike-raw/*",
			"**/.tldr/*",
			"**/flamegraph.*",
			"**/tsconfig.tsbuildinfo",
			"**/benchmark-output.txt",
			"**/*.log",
			"**/*_pb.js",
			"**/*_pb.ts",
			"eslint.config.mjs",
		],
	},
	eslint.configs.recommended,
	configs.strict,
	importPlugin.flatConfigs.recommended,
	importPlugin.flatConfigs.typescript,
	jsdoc.configs["flat/recommended-typescript"],
	{
		settings: {
			"import/resolver": {
				typescript: {},
			},
		},
		plugins: {
			"@typescript-eslint": plugin,
			"prettier": prettier,
			"unused-imports": unusedImports,
			"vitest": vitest,
			jsdoc,
		},
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2021,
				sourceType: "module",
				tsconfigRootDir: import.meta.dirname,
				project: "./tsconfig.json",
			},
			globals: {
				...globals.node,
				...globals.es2021,
			},
		},
		rules: {
			"prettier/prettier": ["error", { printWidth: 120 }],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					args: "all",
					varsIgnorePattern: "_",
					argsIgnorePattern: "_",
					caughtErrors: "all",
					caughtErrorsIgnorePattern: "_",
				},
			],
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/explicit-module-boundary-types": "off",
			"@typescript-eslint/no-dynamic-delete": "off",
			"@typescript-eslint/no-inferrable-types": "off",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/consistent-type-exports": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/explicit-function-return-type": "error",
			"@typescript-eslint/await-thenable": "error", // disallows awaiting a value that is not a "Thenable"
			"@typescript-eslint/return-await": ["error", "in-try-catch"], // require awaiting thenables returned from try/catch
			"@typescript-eslint/method-signature-style": ["error", "method"], // enforce method signature style
			// cf: the doc https://typescript-eslint.io/rules/require-await/ say to disable it
			"require-await": "off",
			"@typescript-eslint/require-await": "error",
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{
					prefer: "type-imports",
					fixStyle: "inline-type-imports",
				},
			],
			"no-unused-vars": "off",
			"unused-imports/no-unused-imports": "error",
			"prefer-const": "error",
			"import/order": [
				"error",
				{
					"groups": [["builtin", "external", "internal"]],
					"newlines-between": "always",
					"alphabetize": {
						order: "asc",
						caseInsensitive: true,
					},
				},
			],
			"sort-imports": [
				"error",
				{
					ignoreCase: true,
					ignoreDeclarationSort: true, // Keep `import/order` sorting statements
					ignoreMemberSort: false, // Enforce sorting within named imports
					allowSeparatedGroups: true,
				},
			],
			"import/no-unresolved": ["error", { ignore: ["@libp2p/pubsub-peer-discovery"] }],
			"import/no-cycle": "error",
			"import/no-self-import": "error",
			"import/no-duplicates": "error",
			"import/no-named-default": "error",
			"import/no-webpack-loader-syntax": "error",
			"jsdoc/require-jsdoc": [
				"warn",
				{
					require: {
						ArrowFunctionExpression: true,
						ClassDeclaration: true,
						ClassExpression: true,
						FunctionDeclaration: true,
						FunctionExpression: true,
						MethodDefinition: true,
					},
					publicOnly: true,
				},
			],
		},
	},
	{
		files: ["packages/compaction/src/**/*.ts", "packages/protocol-v2/src/**/*.ts"],
		rules: {
			"no-restricted-globals": [
				"error",
				{
					name: "structuredClone",
					message: "Consensus state must use deepCloneCanonical.",
				},
				{
					name: "Buffer",
					message: "Consensus bytes must use Uint8Array and explicit-endian DataView operations.",
				},
			],
			"no-restricted-properties": [
				"error",
				{
					object: "globalThis",
					property: "structuredClone",
					message: "Consensus state must use deepCloneCanonical.",
				},
			],
		},
	},
	{
		files: ["packages/object/src/publication/publisher.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{ name: "es-toolkit", message: "Publication copies must use PublicationCapability." },
						{ name: "@msgpack/msgpack", message: "Publication equality must use PublicationCapability." },
						{ name: "@ts-drp/utils/serialization", message: "Decode-capable serialization is outside publication." },
						{ name: "../state-materialize.js", message: "Publication may depend only on the sink-free state store." },
					],
				},
			],
			"no-restricted-globals": ["error", "structuredClone", "Buffer"],
			"no-restricted-properties": [
				"error",
				{ object: "JSON", property: "parse", message: "Serialization is outside publication." },
				{ object: "JSON", property: "stringify", message: "Serialization is outside publication." },
				{ object: "globalThis", property: "structuredClone", message: "Copies use PublicationCapability." },
			],
			"no-restricted-syntax": [
				"error",
				{ selector: "ImportExpression", message: "Dynamic acquisition is forbidden in publication." },
				{
					selector: "CallExpression[callee.name=/^(eval|require|Function)$/]",
					message: "Dynamic acquisition is forbidden in publication.",
				},
			],
		},
	},
	{
		files: ["packages/object/src/publication/copy-capability.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{ name: "@msgpack/msgpack", message: "The capability uses the encode-only equality export." },
						{ name: "@ts-drp/utils/serialization", message: "Decode-capable serialization is outside publication." },
					],
				},
			],
			"no-restricted-globals": ["error", "structuredClone", "Buffer"],
			"no-restricted-properties": [
				"error",
				{ object: "JSON", property: "parse", message: "Serialization is outside publication." },
				{ object: "JSON", property: "stringify", message: "Serialization is outside publication." },
				{ object: "globalThis", property: "structuredClone", message: "Copies use the measured leaf." },
			],
			"no-restricted-syntax": [
				"error",
				{ selector: "ImportExpression", message: "Dynamic acquisition is forbidden in publication." },
				{
					selector: "CallExpression[callee.name=/^(eval|require|Function)$/]",
					message: "Dynamic acquisition is forbidden in publication.",
				},
			],
		},
	},
	{
		files: ["tests/fixtures/phase-0j-a/**/*.{ts,mjs}"],
		rules: {
			"@typescript-eslint/explicit-function-return-type": "off",
			"jsdoc/require-jsdoc": "off",
		},
	}
);

export default config;

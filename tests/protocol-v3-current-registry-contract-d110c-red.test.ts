import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { stringify } from "yaml";

import {
	assertRunnerExtraction,
	createFixture,
	disposeFixture,
	git,
	type GitFixture,
	installForwardingPreload,
	mutateWorkflow,
	type ProcessResult,
	put,
	routedStep,
	runChild,
	runDiscovery,
	runRootCli,
	runRunner,
} from "./fixtures/phase-6b-d110c-registry-current/current-routing.js";
import {
	assertBound,
	capture,
	CHECKER,
	clone,
	contract,
	json,
	knownGood,
	ORIGINAL_LOCK,
	parseWorkflow,
	POLICY,
	REGENERATED_LOCK,
	REGISTRY,
	type Registry,
	type RegistrySchema,
	repinInvalidBase,
	replaceSource,
	ROOT,
	SCHEMA,
	sha256,
	type Snapshot,
	snapshotFromCapture,
	workflowYaml,
} from "./fixtures/phase-6b-d110c-registry-current/current-snapshot.js";
import {
	parameterBytes,
	parameterDigest,
	parameterFrame,
} from "./fixtures/phase-6b-d110c-registry-current/parameters-oracle.mjs";
import { evaluateProtocolV3Freeze } from "../packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs";

const PURE_MS = contract.bounds.pureCaseMs;
const ROUTING_MS = contract.bounds.routingCaseMs;
const WORKFLOWS = Object.keys(contract.workflowOriginals);
const SEMANTIC_POSITIVES = [
	"format-comment",
	"alias-addition",
	"coverage-change",
	"ci-display-name",
	"codeowners-default-owner",
	"workspace-format",
];
const IDENTITY_CASES = [
	"insertion-order",
	"absent-present",
	"four-five",
	"wrong-domain",
	"drop-field",
	"default-injection",
];
const INSTANCE_CASES = ["absent", "one", "four", "million", "zero", "negative", "over-million", "fraction", "unknown"];
const GIT_POSITIVES = [
	"unchanged",
	"forwarding-preload",
	"unrelated-untracked",
	"semantic-alias",
	"unique-divergent-base",
	"push-before",
];
const CLI_NEGATIVES = ["no-args", "extra-args", "empty", "zero", "invalid", "option", "wrong-root"];
const LOCK_NEGATIVES = [
	"original-role",
	"regenerated-role",
	"original-restamped-registry",
	"regenerated-restamped-registry",
];

/** This is an assertion, never a readiness flag, skip, alternate evaluator or caught success. */
function acceptedBase(): Snapshot {
	const base = knownGood();
	assertBound(base);
	// Causal RED is this existing exported call. The old checker reaches validateTuple
	// and rejects current registry bytes; its later const-config lifecycle parser is
	// independently obsolete. Neither missing imports nor invented APIs are the seam.
	evaluateProtocolV3Freeze({ base, current: clone(base) });
	return base;
}

function rejects(base: Snapshot | undefined, current: Snapshot, diagnostic: RegExp): void {
	assert.throws(
		() => evaluateProtocolV3Freeze({ base, current }),
		(error: unknown) => {
			assert.ok(error instanceof Error, "root evaluator must throw a classified Error");
			assert.match(error.message, diagnostic, "the intended predicate must reject");
			return true;
		}
	);
}

function semanticRejection(base: Snapshot, diagnostic: RegExp): void {
	repinInvalidBase(base);
	assert.throws(
		() => evaluateProtocolV3Freeze({ base, current: clone(base) }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, diagnostic, "hash-consistent invalid base must reach the intended semantic family");
			assert.doesNotMatch(
				error.message,
				/stale|hash mismatch|source.{0,20}(?:binding|digest)|accepted successor input drifted|protected.{0,30}(?:drift|changed)/iu,
				"incidental digest/custody failure is not semantic evidence"
			);
			return true;
		}
	);
}

function schemaOf(snapshot: Snapshot): RegistrySchema {
	return JSON.parse(snapshot.sources[SCHEMA]) as RegistrySchema;
}

function registryOf(snapshot: Snapshot): Registry {
	return JSON.parse(snapshot.sources[REGISTRY]) as Registry;
}

function mutateSchema(base: Snapshot, id: string): void {
	const schema = schemaOf(base);
	const parameters = schema.$defs.parameters;
	const optional = parameters.properties.authorShareMultiplier;
	const registry = registryOf(base);
	const field = registry.kinds.parameters.fields[0];
	switch (id) {
		case "optional-required":
			parameters.required.push("authorShareMultiplier");
			break;
		case "optional-deleted":
			delete parameters.properties.authorShareMultiplier;
			break;
		case "optional-minimum":
			optional.minimum = 0;
			break;
		case "optional-maximum":
			optional.maximum = 1000001;
			break;
		case "optional-type":
			optional.type = "number";
			break;
		case "optional-native-type":
			optional["x-registry-type"] = "uint32";
			break;
		case "optional-native-constraints":
			optional["x-registry-constraints"] = { minimum: 0, maximum: 1000000 };
			break;
		case "optional-const":
			optional.const = 4;
			break;
		case "optional-default":
			optional.default = 4;
			break;
		case "parameter-domain":
			parameters["x-domain"] = "ts-drp/parameters/v2";
			break;
		case "parameter-encoding":
			parameters["x-encoding"] = "canonical-array";
			break;
		case "parameter-key-order":
			parameters["x-canonical-key-order"] = "codepoint";
			break;
		case "parameter-unknown-property":
			parameters.properties.unregistered = { type: "integer" };
			break;
		case "parameter-open-object":
			parameters.additionalProperties = true;
			break;
		case "parameter-review-order":
			delete parameters.properties.authorShareMultiplier;
			parameters.properties.authorShareMultiplier = optional;
			break;
		case "registry-optional-required":
			field.required = true;
			break;
		case "registry-optional-minimum":
			field.constraints.minimum = 0;
			break;
		case "registry-optional-maximum":
			field.constraints.maximum = 1000001;
			break;
		case "registry-parameter-domain":
			registry.kinds.parameters.domain = "ts-drp/parameters/v2";
			break;
		case "registry-extra-field":
			registry.kinds.parameters.fields.push({ ...clone(field), name: "unregistered" });
			break;
		case "schema-kind-deleted":
			delete schema.$defs.signerSet;
			break;
		case "schema-kind-added":
			schema.$defs.unregistered = clone(parameters);
			break;
		case "schema-signer-domain":
			schema.$defs.signerSet["x-domain"] = "ts-drp/signer-set/v2";
			break;
		case "schema-signer-encoding":
			schema.$defs.signerSet["x-encoding"] = "canonical-object";
			break;
		default:
			assert.fail(`unknown fixed schema mutation ${id}`);
	}
	replaceSource(base, SCHEMA, json(schema));
	replaceSource(base, REGISTRY, json(registry));
}

function mutateLifecycle(base: Snapshot, id: string): void {
	let file = "vite.config.mts";
	let source = base.sources[file];
	const addTest = (member: string): string => source.replace("test: {", `test: {\n\t\t${member},`);
	switch (id) {
		case "extra-exclusion":
			source = source.replace(
				"exclude: [",
				'exclude: ["tests/protocol-v3-current-registry-contract-d110c-red.test.ts",'
			);
			break;
		case "remove-logs-exclusion":
			source = source.replace('"**/.logs/**",', "");
			break;
		case "include-filter":
			source = addTest('include: ["tests/nothing.test.ts"]');
			break;
		case "name-filter":
			source = addTest('testNamePattern: "never matches"');
			break;
		case "computed-selection":
			source = addTest('["include"]: ["tests/nothing.test.ts"]');
			break;
		case "duplicate-test":
			source = source.replace("test: {", "test: { exclude: [] },\n\ttest: {");
			break;
		case "duplicate-exclude":
			source = addTest('exclude: ["tests/**"]');
			break;
		case "setup-hook":
			source = addTest('setupFiles: ["./candidate-setup.ts"]');
			break;
		case "global-setup-hook":
			source = addTest('globalSetup: ["./candidate-setup.ts"]');
			break;
		case "later-mutation":
			source += '\nconfig.test = { include: ["never.test.ts"] };\n';
			break;
		case "wrong-default-export":
			source = source.replace("export default config;", "export default {}; ");
			break;
		case "plugin-injection":
			source = source.replace(
				"plugins: [tsconfigPaths()]",
				'plugins: [tsconfigPaths(), { name: "selection-hook", config: () => ({ test: { include: [] } }) }]'
			);
			break;
		case "workspace-member-added":
			file = "vitest.workspace.ts";
			source = base.sources[file].replace("defineWorkspace([", 'defineWorkspace(["./candidate.config.mts",');
			break;
		case "workspace-member-removed":
			file = "vitest.workspace.ts";
			source = base.sources[file].replace('"./examples/chat/vite.config.mts",', "");
			break;
		case "workspace-computed":
			file = "vitest.workspace.ts";
			source = base.sources[file].replace("defineWorkspace([", "defineWorkspace([...[],");
			break;
		case "ci-comment-only":
		case "ci-step-condition":
		case "ci-job-condition":
		case "ci-ignored-exit":
		case "ci-continue-on-error": {
			file = ".github/workflows/test.yml";
			const workflow = parseWorkflow(base.sources[file]);
			const job = workflow.jobs.tests;
			const step = job.steps.find((entry) => entry.run?.trim() === "pnpm test");
			assert.ok(step);
			if (id === "ci-comment-only") step.run = "# pnpm test\ntrue\n";
			if (id === "ci-step-condition") step.if = false;
			if (id === "ci-job-condition") job.if = false;
			if (id === "ci-ignored-exit") step.run = "pnpm test || true\n";
			if (id === "ci-continue-on-error") step["continue-on-error"] = true;
			source = workflowYaml(workflow);
			break;
		}
		case "codeowners-missing-terminal":
			file = "CODEOWNERS";
			source = base.sources[file].replace(/^\/CODEOWNERS .+\n/mu, "");
			break;
		case "codeowners-shadow-rule":
			file = "CODEOWNERS";
			source = base.sources[file] + "\n/packages/protocol-v3/registry/** @unreviewed\n";
			break;
		default:
			assert.fail(`unknown fixed lifecycle mutation ${id}`);
	}
	assert.notEqual(source, base.sources[file], id);
	replaceSource(base, file, source);
}

function semanticPositive(base: Snapshot, id: string): Snapshot {
	const current = clone(base);
	switch (id) {
		case "format-comment":
			replaceSource(
				current,
				"vite.config.mts",
				"// harmless current config comment\n" + current.sources["vite.config.mts"]
			);
			break;
		case "alias-addition":
			replaceSource(
				current,
				"vite.config.mts",
				current.sources["vite.config.mts"].replace(
					"alias: {",
					'alias: {\n\t\t\t"@current/test-alias": path.resolve(__dirname, "packages/protocol-v3/src/public.ts"),'
				)
			);
			break;
		case "coverage-change":
			replaceSource(
				current,
				"vite.config.mts",
				current.sources["vite.config.mts"].replace("thresholds: { lines: 70 }", "thresholds: { lines: 71 }")
			);
			break;
		case "ci-display-name":
			replaceSource(
				current,
				".github/workflows/test.yml",
				current.sources[".github/workflows/test.yml"].replace("name: Test Packages", "name: Ordinary package tests")
			);
			break;
		case "codeowners-default-owner": {
			const source = current.sources.CODEOWNERS.replace(/^\*\s+.+$/mu, "* @d-roak");
			assert.notEqual(source, current.sources.CODEOWNERS);
			replaceSource(current, "CODEOWNERS", source);
			break;
		}
		case "workspace-format":
			replaceSource(
				current,
				"vitest.workspace.ts",
				"// Same five workspace members.\n" + current.sources["vitest.workspace.ts"]
			);
			break;
		default:
			assert.fail(`unknown semantic positive ${id}`);
	}
	return current;
}

function instanceValid(value: Record<string, unknown>, schema: RegistrySchema): boolean {
	const parameters = schema.$defs.parameters;
	if (parameters.required.some((key) => !Object.hasOwn(value, key))) return false;
	for (const [key, number] of Object.entries(value)) {
		const field = parameters.properties[key];
		if (field === undefined) {
			if (parameters.additionalProperties === false) return false;
			else continue;
		}
		if (field.type !== "integer" || typeof number !== "number" || !Number.isSafeInteger(number)) return false;
		if (field.minimum !== undefined && number < field.minimum) return false;
		if (field.maximum !== undefined && number > field.maximum) return false;
		if (Object.hasOwn(field, "const") && number !== field.const) return false;
	}
	return true;
}

function statusPassed(result: ProcessResult): void {
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function statusRejected(result: ProcessResult, diagnostic?: RegExp): void {
	assert.notEqual(result.status, 0, "real extracted process exit must propagate, independently of diagnostic prose");
	if (diagnostic !== undefined) assert.match(result.stdout + result.stderr, diagnostic);
}

describe("D110c current registry contract", () => {
	it(
		"prospective unchanged snapshot reaches the existing root evaluator",
		() => {
			acceptedBase();
		},
		PURE_MS
	);

	it(
		"actual current sources satisfy the root contract without fixture projection",
		() => {
			acceptedBase();
			const base = snapshotFromCapture(capture());
			assertBound(base);
			evaluateProtocolV3Freeze({ base, current: clone(base) });
		},
		PURE_MS
	);

	it(
		"freezes exhaustive custody and mixed historical/current fixture roles",
		() => {
			const base = acceptedBase();
			assert.equal(contract.inventory.records.length, 193);
			assert.equal(Object.keys(base.files).length, 191);
			assert.equal(contract.inventory.prospectiveByteProtectedPaths.length, 186);
			assert.equal(contract.inventory.semanticSourcePaths.length, 20);
			assert.deepEqual(base.policy.protectedPaths, contract.inventory.prospectiveByteProtectedPaths);
			assert.equal(contract.inventory.preservedSuccessorFixtureClosure.length, 26);
			assert.equal(contract.schemaMutationIds.length, contract.fixedCounts.schemaMutations);
			assert.equal(contract.lifecycleMutationIds.length, contract.fixedCounts.lifecycleMutations);
			assert.equal(contract.transitionMutationIds.length, contract.fixedCounts.transitionMutations);
			assert.equal(contract.workflowMutationIds.length, contract.fixedCounts.workflowMutationsPerWorkflow);
			assert.equal(contract.routingMutationIds.length, contract.fixedCounts.routingMutations);
			assert.equal(WORKFLOWS.length, contract.fixedCounts.workflows);
			assert.equal(contract.childCheckers.length, contract.fixedCounts.childCheckers);
			assert.equal(contract.testIdentities.length, 567);
			assert.equal(new Set(contract.testIdentities).size, 567);
			assert.equal(contract.executionCardinality.testCount, 567);
			for (const item of contract.inventory.records.filter((item) => item.classification.startsWith("preserved-"))) {
				assert.equal(sha256(readFileSync(join(ROOT, item.file))), item.sha256, item.file);
			}
			for (const file of contract.inventory.semanticOnlyPaths)
				assert.equal(base.policy.protectedPaths.includes(file), false);
			assert.equal(base.fileEntries[contract.childCheckers[1]].mode, "100755");
			for (const file of contract.inventory.newlyByteProtectedPaths)
				assert.ok(base.policy.protectedPaths.includes(file));
			// These contain active profile/vector/law/fixture identities as well as old attestations.
			for (const file of [
				"tests/fixtures/phase-5-v3/seal-digest-law-contract.json",
				"tests/fixtures/phase-5d-v3/pacemaker-law-contract.json",
				"tests/fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json",
				"tests/fixtures/phase-0j-b-v3/blueprint-runtime-contract.json",
				"tests/fixtures/phase-0p0-v3/blueprint-work-budget-contract.json",
			])
				assert.ok(
					base.policy.protectedPaths.includes(file),
					"historical label cannot retire current semantic payloads"
				);
			const profile = JSON.parse(
				readFileSync(join(ROOT, "packages/protocol-v3/supplements/blueprint-artifact-profile-v1/profile.json"), "utf8")
			) as { frozenTuple: Record<string, unknown> };
			assert.equal(Object.keys(profile.frozenTuple).length, 5);
			assert.equal(profile.frozenTuple.protectedPathCount, 47);
			assert.equal(
				profile.frozenTuple.freezePolicySha256,
				"fa2a69d4113f73bbd657d4490189b472a2ae04b5bdc88d35d2de5c87e572ccc3"
			);
		},
		PURE_MS
	);

	it.each(contract.oracle.cases)(
		"independent literal oracle: $id",
		(vector) => {
			const bytes = parameterBytes(vector.input);
			assert.equal(bytes.length, vector.byteLength);
			assert.equal(bytes.toString("hex"), vector.canonicalHex);
			assert.equal(parameterDigest(vector.input), vector.digestHex);
			if (vector.id === "absent") {
				const document = JSON.parse(
					readFileSync(join(ROOT, "packages/protocol-v3/conformance/vectors/registry-v1.json"), "utf8")
				) as { vectors: Array<{ id: string; canonicalHex: string; digestHex: string }> };
				const historical = document.vectors.find((item) => item.id === "parameters-basic");
				assert.ok(historical);
				assert.equal(historical.canonicalHex, vector.canonicalHex);
				assert.equal(historical.digestHex, vector.digestHex);
			}
			assert.equal(parameterFrame(bytes).subarray(0, 4).toString("hex"), "44525000");
			// Production is an observation against already frozen literals, not the oracle generator.
			const actual = encodeCanonical(vector.input);
			assert.equal(Buffer.from(actual).toString("hex"), vector.canonicalHex);
			assert.equal(Buffer.from(hashDomain(contract.oracle.domain, actual)).toString("hex"), vector.digestHex);
		},
		PURE_MS
	);

	it.each(IDENTITY_CASES)(
		"parameter identity control: %s",
		(id) => {
			const absent = clone(contract.oracle.cases[0].input);
			const four = clone(contract.oracle.cases[1].input);
			const expected = contract.oracle.cases[1].digestHex;
			switch (id) {
				case "insertion-order":
					assert.equal(parameterDigest(Object.fromEntries(Object.entries(four).reverse())), expected);
					break;
				case "absent-present":
					assert.notEqual(parameterDigest(absent), expected);
					break;
				case "four-five":
					assert.notEqual(parameterDigest({ ...four, authorShareMultiplier: 5 }), expected);
					break;
				case "wrong-domain":
					assert.notEqual(parameterDigest(four, "ts-drp/parameters/v2"), expected);
					break;
				case "drop-field":
					delete four.authorShareMultiplier;
					assert.notEqual(parameterDigest(four), expected);
					break;
				case "default-injection":
					assert.notEqual(parameterDigest({ ...absent, authorShareMultiplier: 4 }), contract.oracle.cases[0].digestHex);
					break;
				default:
					assert.fail(id);
			}
		},
		PURE_MS
	);

	it(
		"preserves all-kind schema bijection and v2 separation",
		() => {
			const base = acceptedBase();
			const registry = registryOf(base);
			const schema = schemaOf(base);
			assert.deepEqual(Object.keys(schema.$defs), Object.keys(registry.kinds));
			for (const [name, kind] of Object.entries(registry.kinds)) {
				const definition = schema.$defs[name];
				assert.equal(definition["x-domain"], kind.domain);
				assert.equal(definition["x-encoding"], kind.encoding);
				assert.equal(definition["x-canonical-key-order"], "encoded-key-bytes");
				assert.equal(definition.additionalProperties, false);
				assert.deepEqual(
					Object.keys(definition.properties),
					kind.fields.map((field) => field.name)
				);
				assert.deepEqual(
					definition.required,
					kind.fields.filter((field) => field.required).map((field) => field.name)
				);
				for (const field of kind.fields) {
					const property = definition.properties[field.name];
					assert.equal(property["x-registry-type"], field.type);
					assert.deepEqual(property["x-registry-constraints"], field.constraints);
				}
			}
			assert.equal(schema.$defs.parameters.required.length, 7);
			assert.equal(Object.keys(schema.$defs.parameters.properties)[0], "authorShareMultiplier");
			assert.equal(Object.hasOwn(schema.$defs.parameters.properties.authorShareMultiplier, "const"), false);
			assert.equal(Object.hasOwn(schema.$defs.parameters.properties.authorShareMultiplier, "default"), false);
			const v2File = "packages/protocol-v2/registry/field-registry.json";
			const v2 = readFileSync(join(ROOT, v2File), "utf8");
			assert.equal(sha256(v2), contract.inventory.verificationOnlyV2Closure.files[v2File]);
			assert.equal(v2.includes("authorShareMultiplier"), false);
			assert.notEqual(
				parameterDigest(contract.oracle.cases[0].input, "ts-drp/parameters/v2"),
				contract.oracle.cases[0].digestHex
			);
		},
		PURE_MS
	);

	it.each(INSTANCE_CASES)(
		"schema parameter instance: %s",
		(id) => {
			const base = acceptedBase();
			const value: Record<string, unknown> = clone(contract.oracle.cases[0].input);
			const selected: Record<string, number> = {
				"one": 1,
				"four": 4,
				"million": 1000000,
				"zero": 0,
				"negative": -1,
				"over-million": 1000001,
				"fraction": 1.5,
			};
			if (Object.hasOwn(selected, id)) value.authorShareMultiplier = selected[id];
			if (id === "unknown") value.unregistered = 4;
			assert.equal(instanceValid(value, schemaOf(base)), ["absent", "one", "four", "million"].includes(id));
		},
		PURE_MS
	);

	it.each(contract.schemaMutationIds)(
		"invalid-base schema semantic: %s",
		(id) => {
			const base = acceptedBase();
			mutateSchema(base, id);
			semanticRejection(base, /schema|parameters|registry.*(?:contract|domain|field|kind)|signerSet/iu);
		},
		PURE_MS
	);

	it.each(SEMANTIC_POSITIVES)(
		"semantic-only positive: %s",
		(id) => {
			const base = acceptedBase();
			const current = semanticPositive(base, id);
			assert.deepEqual(current.policy, base.policy, "semantic edits cannot rewrite root policy");
			evaluateProtocolV3Freeze({ base, current });
		},
		PURE_MS
	);

	it.each(contract.lifecycleMutationIds)(
		"invalid-base lifecycle semantic: %s",
		(id) => {
			const base = acceptedBase();
			mutateLifecycle(base, id);
			semanticRejection(
				base,
				id.startsWith("codeowners")
					? /CODEOWNERS|owner cohort/iu
					: /lifecycle|test|workspace|config|ordinary|coverage|plugin/iu
			);
		},
		PURE_MS
	);

	it.each(LOCK_NEGATIVES)(
		"invalid-base historical lock meaning: %s",
		(id) => {
			const base = acceptedBase();
			const file = id.startsWith("original") ? ORIGINAL_LOCK : REGENERATED_LOCK;
			const lock = JSON.parse(base.sources[file]) as Record<string, unknown>;
			if (id.endsWith("role")) lock.referenceRole = "current-transition-authority";
			else {
				const bindings = lock.provenanceBindings as Record<string, { path: string; sha256: string }>;
				bindings.registry.sha256 = base.files[REGISTRY];
			}
			replaceSource(base, file, json(lock));
			semanticRejection(base, /historical|reference|provenance|lock/iu);
		},
		PURE_MS
	);

	it.each(
		contract.inventory.semanticSourcePaths.flatMap((file) => [
			["base", file],
			["current", file],
		])
	)(
		"source roster binding: %s %s",
		(side, file) => {
			const base = acceptedBase();
			const current = clone(base);
			delete (side === "base" ? base : current).sources[file];
			rejects(base, current, /source|binding|snapshot|inventory|complete/iu);
		},
		PURE_MS
	);

	it.each(contract.inventory.prospectiveByteProtectedPaths)(
		"independent base protects bytes: %s",
		(file) => {
			const base = acceptedBase();
			const current = clone(base);
			if (Object.hasOwn(current.sources, file)) replaceSource(current, file, current.sources[file] + "\n");
			else current.files[file] = sha256("candidate-only byte mutation\n");
			rejects(base, current, /protected|changed|drift|immutable|preserv|base.*(?:hash|digest)/iu);
		},
		PURE_MS
	);

	it.each(contract.transitionMutationIds)(
		"independent-base transition mutation: %s",
		(id) => {
			let base: Snapshot | undefined = acceptedBase();
			const current = clone(base);
			let diagnostic =
				/source|binding|snapshot|inventory|complete|protected|changed|drift|immutable|policy|base|entry|mode|type|absent|CODEOWNERS|v2/iu;
			switch (id) {
				case "registry-drift":
					replaceSource(current, REGISTRY, current.sources[REGISTRY] + "\n");
					break;
				case "schema-drift":
					replaceSource(current, SCHEMA, current.sources[SCHEMA] + "\n");
					break;
				case "checker-noop":
					current.files[CHECKER] = sha256("process.exit(0);\n");
					break;
				case "checker-policy-coedit":
					current.files[CHECKER] = sha256("process.exit(0);\n");
					repinInvalidBase(current);
					break;
				case "artifact-policy-coedit":
					replaceSource(current, SCHEMA, current.sources[SCHEMA] + "\n");
					repinInvalidBase(current);
					break;
				case "policy-roster-shrink":
					current.policy.protectedPaths.pop();
					replaceSource(current, POLICY, json(current.policy));
					break;
				case "policy-byte-format":
					replaceSource(current, POLICY, current.sources[POLICY] + "\n");
					break;
				case "source-hash-mismatch":
					current.sources[SCHEMA] += "\n";
					break;
				case "source-view-mismatch":
					current.testLifecycle.rootConfig += "\n";
					break;
				case "policy-view-mismatch":
					current.policy.version = 999;
					break;
				case "lock-view-mismatch":
					current.locks.original.role = "forged";
					break;
				case "registry-view-mismatch":
					current.registryVersion = 999;
					break;
				case "workflow-view-mismatch":
					current.workflow += "\n";
					break;
				case "missing-source":
					delete current.sources["vite.config.mts"];
					break;
				case "extra-source":
					current.sources["candidate-config.ts"] = "export default {};\n";
					break;
				case "missing-file":
					delete current.files[CHECKER];
					delete current.fileEntries[CHECKER];
					break;
				case "missing-entry":
					delete current.fileEntries[CHECKER];
					break;
				case "extra-entry":
					current.fileEntries["candidate.ts"] = { type: "blob", mode: "100644" };
					break;
				case "executable-mode":
					current.fileEntries[CHECKER].mode = "100755";
					break;
				case "symlink-mode":
					current.fileEntries[CHECKER].mode = "120000";
					break;
				case "submodule-type":
					current.fileEntries[CHECKER] = { type: "commit", mode: "160000" };
					break;
				case "shadow-codeowners":
					current.files[".github/CODEOWNERS"] = sha256("* @unreviewed\n");
					current.fileEntries[".github/CODEOWNERS"] = { type: "blob", mode: "100644" };
					break;
				case "v2-status-failed":
					current.v2StatusPassed = false;
					break;
				case "missing-base":
					base = undefined;
					diagnostic = /base.*(?:required|missing|absent)/iu;
					break;
				case "obsolete-base":
					replaceSource(base, POLICY, json(contract.policyTemplate));
					diagnostic = /base|obsolete|current.*(?:policy|inventory)|incomplete/iu;
					break;
				case "partial-base":
					delete base.files[CHECKER];
					delete base.fileEntries[CHECKER];
					diagnostic = /base|inventory|complete|absent|missing/iu;
					break;
				case "bootstrap-fields-no-authority":
					base.preV3 = true;
					base.bootstrapConsumed = false;
					delete base.sources[POLICY];
					delete base.files[POLICY];
					delete base.fileEntries[POLICY];
					diagnostic = /base|bootstrap|source|policy|complete/iu;
					break;
				case "malformed-base-source":
					base.sources[POLICY] = "{";
					base.files[POLICY] = sha256("{");
					diagnostic = /base|JSON|policy|source/iu;
					break;
				case "base-hash-mismatch":
					base.files[SCHEMA] = sha256("unbound schema");
					diagnostic = /base|source|hash|digest|binding/iu;
					break;
				case "base-policy-roster-shrink":
					base.policy.protectedPaths.pop();
					replaceSource(base, POLICY, json(base.policy));
					repinInvalidBase(base);
					diagnostic = /base|inventory|policy|complete|required/iu;
					break;
				case "base-no-entry":
					delete base.fileEntries[CHECKER];
					diagnostic = /base|entry|entries|snapshot|inventory/iu;
					break;
				case "base-wrong-mode":
					base.fileEntries[CHECKER].mode = "100755";
					diagnostic = /base|entry|mode/iu;
					break;
				default:
					assert.fail(id);
			}
			rejects(base, current, diagnostic);
		},
		PURE_MS
	);

	it.each(WORKFLOWS)(
		"parsed workflow formatting positive: %s",
		(file) => {
			const base = acceptedBase();
			const source = base.sources[file];
			assert.equal(routedStep(file, source).run, contract.runner);
			const variants = [
				"# unrelated YAML comment\n" + source,
				stringify(parseWorkflow(source), { indent: 4, lineWidth: 0, defaultStringType: "QUOTE_DOUBLE" }),
			];
			assert.equal(variants.length, 2);
			for (const variant of variants) {
				assert.equal(routedStep(file, variant).run, contract.runner);
				const formatted = clone(base);
				replaceSource(formatted, file, variant);
				repinInvalidBase(formatted);
				evaluateProtocolV3Freeze({ base: formatted, current: clone(formatted) });
			}
		},
		PURE_MS
	);

	it.each(WORKFLOWS.flatMap((file) => contract.workflowMutationIds.map((id) => [file, id])))(
		"invalid-base workflow semantic: %s %s",
		(file, id) => {
			const base = acceptedBase();
			assert.equal(routedStep(file, base.sources[file]).run, contract.runner);
			const changed = mutateWorkflow(file, base.sources[file], id);
			assert.throws(() => routedStep(file, changed), /workflow|YAML/iu);
			replaceSource(base, file, changed);
			semanticRejection(base, /workflow|runner|YAML|retarget|subsystem|permissions|status/iu);
		},
		PURE_MS
	);

	it(
		"removes alternate child transition exports without retiring intrinsic payloads",
		() => {
			acceptedBase();
			const pairs = [
				[contract.childCheckers[2], "evaluateEd25519ProfileFreeze"],
				[contract.childCheckers[3], "evaluateBlueprintArtifactProfileFreeze"],
			];
			for (const [file, name] of pairs) {
				const source = readFileSync(join(ROOT, file), "utf8");
				assert.equal(source.includes(name), false, `${name} cannot remain an unused hidden transition owner`);
				assert.ok(/integrity.only/iu.test(source));
			}
		},
		PURE_MS
	);

	it(
		"ordinary file-only Vitest discovery retains every current consumer",
		async () => {
			acceptedBase();
			const fixture = createFixture();
			try {
				const result = await runDiscovery(fixture);
				statusPassed(result);
				const discovered = result.stdout
					.split(/\r?\n/u)
					.map((line) => line.trim().replace(`${ROOT}/`, ""))
					.filter(Boolean);
				const selected = [
					...contract.inventory.affectedCurrentTestFiles,
					"tests/protocol-v3-current-registry-contract-d110c-red.test.ts",
				];
				assert.equal(selected.length, 24);
				for (const file of selected) assert.equal(discovered.filter((entry) => entry === file).length, 1, file);
				assert.equal(discovered.includes("tests/protocol-v3-independent-reference-vectors-n1prime-c.test.ts"), false);
				assert.equal(fixture.gitCalls, 5);
				assert.equal(fixture.processCalls, 1);
			} finally {
				disposeFixture(fixture);
			}
		},
		ROUTING_MS
	);

	it.each(contract.childCheckers)(
		"child CLI is integrity-only and rejects transition base: %s",
		async (file) => {
			acceptedBase();
			const fixture = createFixture();
			try {
				const positive = await runChild(fixture, file, []);
				statusPassed(positive);
				assert.match(positive.stdout, /integrity.only/iu);
				assert.doesNotMatch(positive.stdout, /transition.{0,20}(?:pass|approv)|bootstrap.{0,20}(?:pass|approv)/iu);
				const negative = await runChild(fixture, file, [fixture.base]);
				statusRejected(negative, /root.{0,40}(?:owner|checker|transition)|transition.{0,40}root/iu);
				assert.equal(fixture.gitCalls, 5);
				assert.equal(fixture.processCalls, 2);
			} finally {
				disposeFixture(fixture);
			}
		},
		contract.bounds.childCaseMs
	);

	it.each(WORKFLOWS)(
		"executes actual workflow runner against committed current inventory: %s",
		async (file) => {
			acceptedBase();
			const actual = readFileSync(join(ROOT, file), "utf8");
			const step = routedStep(file, actual);
			const fixture = createFixture();
			try {
				statusPassed(await runRunner(fixture, fixture.base, {}, step.run));
				assertRunnerExtraction(fixture);
				assert.equal(fixture.gitCalls, 5);
				assert.equal(fixture.processCalls, 1);
			} finally {
				disposeFixture(fixture);
			}
		},
		ROUTING_MS
	);

	it.each(GIT_POSITIVES)(
		"real Git current routing positive: %s",
		async (id) => {
			acceptedBase();
			const fixture = createFixture();
			try {
				statusPassed(await runRunner(fixture));
				let base = fixture.base;
				let extra: NodeJS.ProcessEnv = {};
				let marker: string | undefined;
				if (id === "forwarding-preload") {
					const preload = installForwardingPreload(fixture);
					extra = { NODE_OPTIONS: preload.NODE_OPTIONS };
					marker = preload.marker;
				}
				if (id === "unrelated-untracked")
					put(fixture, "unrelated/notes.txt", "Unrelated untracked content is outside current boundaries.\n");
				if (id === "semantic-alias") {
					const current = semanticPositive(snapshotFromCapture(fixture.captured), "alias-addition");
					put(fixture, "vite.config.mts", current.sources["vite.config.mts"]);
				}
				if (id === "unique-divergent-base") {
					const left = git(fixture, ["commit-tree", fixture.tree, "-p", fixture.base, "-m", "left"]);
					base = git(fixture, ["commit-tree", fixture.tree, "-p", fixture.base, "-m", "right"]);
					git(fixture, ["update-ref", "refs/heads/main", left]);
					assert.equal(git(fixture, ["merge-base", "--all", base, "HEAD"]), fixture.base);
				}
				if (id === "push-before") {
					const before = fixture.base;
					const after = git(fixture, ["commit-tree", fixture.tree, "-p", before, "-m", "push"]);
					git(fixture, ["update-ref", "refs/heads/main", after]);
					base = before;
					assert.notEqual(base, after, "push must explicitly select before, not HEAD");
				}
				statusPassed(await runRunner(fixture, base, extra));
				assertRunnerExtraction(fixture);
				if (marker !== undefined)
					assert.equal(
						readFileSync(marker, "utf8"),
						"forwarded\nforwarded\n",
						"both real extracted Node checkers execute through the benign forwarding preload"
					);
				assert.equal(fixture.gitCalls, id === "unique-divergent-base" ? 9 : id === "push-before" ? 7 : 5);
				assert.equal(fixture.processCalls, 2);
			} finally {
				disposeFixture(fixture);
			}
		},
		ROUTING_MS
	);

	it.each(contract.routingMutationIds)(
		"real Git base-governed routing rejection: %s",
		async (id) => {
			acceptedBase();
			const fixture = createFixture();
			let other: GitFixture | undefined;
			try {
				statusPassed(await runRunner(fixture));
				let base: string | null = fixture.base;
				let extra: NodeJS.ProcessEnv = {};
				let expectedGitCalls = 5;
				const candidateMarker = join(fixture.runnerTemp, "candidate-was-loaded.txt");
				const registryFile = "packages/protocol-v2/registry/field-registry.json";
				switch (id) {
					case "missing-base":
						base = null;
						break;
					case "empty-base":
						base = "";
						break;
					case "zero-base":
						base = "0".repeat(40);
						break;
					case "invalid-base":
						base = "definitely-not-a-commit";
						break;
					case "option-like-base":
						base = "--help";
						break;
					case "no-common-ancestor": {
						base = git(fixture, ["commit-tree", fixture.tree, "-m", "independent root"]);
						assert.equal(git(fixture, ["merge-base", "--all", base, "HEAD"], 1), "");
						expectedGitCalls += 2;
						break;
					}
					case "criss-cross": {
						const left = git(fixture, ["commit-tree", fixture.tree, "-p", fixture.base, "-m", "left"]);
						const right = git(fixture, ["commit-tree", fixture.tree, "-p", fixture.base, "-m", "right"]);
						const leftMerge = git(fixture, ["commit-tree", fixture.tree, "-p", left, "-p", right, "-m", "left merge"]);
						base = git(fixture, ["commit-tree", fixture.tree, "-p", right, "-p", left, "-m", "right merge"]);
						git(fixture, ["update-ref", "refs/heads/main", leftMerge]);
						assert.deepEqual(
							git(fixture, ["merge-base", "--all", base, "HEAD"]).split("\n").sort(),
							[left, right].sort()
						);
						expectedGitCalls += 6;
						break;
					}
					case "candidate-noop":
					case "candidate-coedit": {
						const noOp = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(candidateMarker)}, "loaded");\nprocess.exit(0);\n`;
						put(fixture, CHECKER, noOp);
						if (id === "candidate-coedit") {
							const candidate = snapshotFromCapture(fixture.captured);
							candidate.files[CHECKER] = sha256(noOp);
							replaceSource(candidate, SCHEMA, candidate.sources[SCHEMA] + "\n");
							repinInvalidBase(candidate);
							put(fixture, POLICY, candidate.sources[POLICY]);
							put(fixture, SCHEMA, candidate.sources[SCHEMA]);
						}
						break;
					}
					case "missing-base-checker":
					case "partial-base-inventory": {
						const file =
							id === "missing-base-checker" ? CHECKER : "tests/fixtures/phase-5-v3/seal-digest-law-contract.json";
						git(fixture, ["rm", "--cached", "--", file]);
						git(fixture, ["commit", "-m", "invalid incomplete base"]);
						base = git(fixture, ["rev-parse", "HEAD"]);
						expectedGitCalls += 3;
						break;
					}
					case "wrong-root":
						other = createFixture(fixture.captured);
						extra = { GITHUB_WORKSPACE: other.root };
						assert.equal(other.base, fixture.base);
						break;
					case "symlink-file": {
						put(fixture, "outside-schema.json", fixture.captured.bytes[SCHEMA]);
						unlinkSync(join(fixture.root, SCHEMA));
						symlinkSync(join(fixture.root, "outside-schema.json"), join(fixture.root, SCHEMA));
						break;
					}
					case "symlink-ancestor": {
						const directory = join(fixture.root, "packages/protocol-v3/registry");
						const outside = join(fixture.root, "outside-registry");
						renameSync(directory, outside);
						symlinkSync(outside, directory);
						break;
					}
					case "mode-change":
						chmodSync(join(fixture.root, SCHEMA), 0o755);
						break;
					case "deleted-index":
						git(fixture, ["rm", "--cached", "--", SCHEMA]);
						expectedGitCalls++;
						break;
					case "unmerged-index": {
						const blob = git(fixture, ["rev-parse", `${fixture.base}:${SCHEMA}`]);
						git(
							fixture,
							["update-index", "--index-info"],
							0,
							`0 ${"0".repeat(40)}\t${SCHEMA}\n100644 ${blob} 1\t${SCHEMA}\n100644 ${blob} 2\t${SCHEMA}\n100644 ${blob} 3\t${SCHEMA}\n`
						);
						expectedGitCalls += 2;
						break;
					}
					case "submodule-entry":
						git(fixture, ["update-index", "--add", "--cacheinfo", `160000,${fixture.base},${SCHEMA}`]);
						expectedGitCalls++;
						break;
					case "dangling-codeowners":
						symlinkSync("missing-owner-target", join(fixture.root, ".github/CODEOWNERS"));
						break;
					case "closed-formal":
						put(fixture, "packages/protocol-v3/formal/extra.txt", "extra\n");
						put(fixture, ".git/info/exclude", "packages/protocol-v3/formal/extra.txt\n");
						break;
					case "closed-original":
						put(fixture, "packages/protocol-v3/conformance/original-reference/extra.txt", "extra\n");
						break;
					case "closed-regenerated":
						put(fixture, "packages/protocol-v3/conformance/regenerated-reference/extra.txt", "extra\n");
						break;
					case "closed-registry":
						put(fixture, "packages/protocol-v3/registry/extra.txt", "extra\n");
						break;
					case "closed-vectors":
						put(fixture, "packages/protocol-v3/conformance/vectors/extra.txt", "extra\n");
						break;
					case "v2-drift":
						put(fixture, registryFile, readFileSync(join(fixture.root, registryFile), "utf8") + "\n");
						break;
					default:
						assert.fail(id);
				}
				const result = await runRunner(fixture, base, extra);
				statusRejected(result, id === "v2-drift" ? /protocol freeze violation/iu : undefined);
				assert.equal(
					existsSync(candidateMarker),
					false,
					"candidate checker is data, never loaded as transition authority"
				);
				assert.equal(fixture.gitCalls, expectedGitCalls);
				assert.equal(fixture.processCalls, 2);
				if (other !== undefined) {
					assert.equal(other.gitCalls, 5);
					assert.equal(other.processCalls, 0);
				}
			} finally {
				if (other !== undefined) disposeFixture(other);
				disposeFixture(fixture);
			}
		},
		ROUTING_MS
	);

	it.each(CLI_NEGATIVES)(
		"root CLI explicit-base contract: %s",
		async (id) => {
			acceptedBase();
			const fixture = createFixture();
			let other: GitFixture | undefined;
			try {
				statusPassed(await runRootCli(fixture, [fixture.base]));
				const argumentsById: Record<string, string[]> = {
					"no-args": [],
					"extra-args": [fixture.base, fixture.base],
					"empty": [""],
					"zero": ["0".repeat(40)],
					"invalid": ["invalid-base"],
					"option": ["--help"],
					"wrong-root": [fixture.base],
				};
				if (id === "wrong-root") other = createFixture(fixture.captured);
				const result = await runRootCli(fixture, argumentsById[id], other?.root ?? fixture.root);
				statusRejected(
					result,
					id === "wrong-root" ? /root|repository|cwd|top.level/iu : /base|argument|reference|commit|usage/iu
				);
				assert.equal(fixture.gitCalls, 5);
				assert.equal(fixture.processCalls, 2);
			} finally {
				if (other !== undefined) disposeFixture(other);
				disposeFixture(fixture);
			}
		},
		ROUTING_MS
	);
});

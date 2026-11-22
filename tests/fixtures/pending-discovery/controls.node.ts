import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

import { transformPending } from "./auth-transform.js";
import { validateBootstrap } from "./bootstrap.js";
import { closeAll } from "./cleanup.js";
import { transformNativeOwners } from "./native-transform.js";
import { freshEffects, lookupOutcome, lookupRefusal, mutationRefusal, observe } from "./observer.js";
import type { SetupReport } from "./types.js";
const root = resolve(import.meta.dirname, "../../..");
for (const backend of ["node", "browser"] as const)
	void test("native lookup/acquisition insertion custody: " + backend, () => {
		const raw = readFileSync(resolve(root, `packages/storage-${backend}/dist/src/snapshot-transfer.js`), "utf8"),
			transformed = transformNativeOwners(raw, backend);
		let reproduced = raw;
		for (const insertion of [...transformed.insertions].sort((a, b) => b.offset - a.offset))
			reproduced = reproduced.slice(0, insertion.offset) + insertion.text + reproduced.slice(insertion.offset);
		assert.equal(reproduced, transformed.code);
		assert.throws(
			() => transformNativeOwners(raw.replaceAll("lookupRecoveryDeclaration =", "changedLookup ="), backend),
			/NATIVE_OWNER_SEAM_NOT_UNIQUE/u
		);
		assert.throws(() => transformNativeOwners(raw + raw, backend), /NATIVE_OWNER_SEAM_NOT_UNIQUE/u);
		assert.throws(() => transformNativeOwners(transformed.code, backend), /NATIVE_OWNER_ALREADY_OBSERVED/u);
		assert.throws(
			() =>
				transformNativeOwners(
					raw.replaceAll("snapshotQuarantineContract.validateRecoveryManifest", "changedRecoveryManifest"),
					backend
				),
			/NATIVE_LOOKUP_RESOLUTION_SEAM_NOT_UNIQUE/u
		);
		const resolution = /return snapshotQuarantineContract\.validateRecoveryManifest\(scope, [\s\S]*?\);/u.exec(
			raw
		)?.[0];
		assert.ok(resolution);
		assert.throws(
			() => transformNativeOwners(raw.replace(resolution, resolution + resolution), backend),
			/NATIVE_LOOKUP_RESOLUTION_SEAM_NOT_UNIQUE/u
		);
		assert.throws(
			() =>
				transformNativeOwners(raw.replaceAll('failure("migration-required",', 'failure("changed-migration",'), backend),
			/NATIVE_MUTABLE_REFUSAL_SEAM_NOT_UNIQUE/u
		);
		assert.equal(transformed.insertions.filter((entry) => entry.text === "__pendingLookupOutcome(scope, ").length, 2);
		assert.equal(transformed.insertions.filter((entry) => entry.text === "__pendingLookupRefusal(scope, ").length, 1);
		assert.equal(transformed.insertions.filter((entry) => entry.text === "__pendingMutationRefusal(").length, 1);
	});
void test("observer identity control ONLY: frozen native-value/error primitives return identical originals", async () => {
	const scope = JSON.parse(
		'{"objectId":"creator:00000000000000000000000000000000","epoch":0,"anchor":"' +
			"0".repeat(64) +
			'","manifestDigest":"' +
			"1".repeat(64) +
			'"}'
	) as SetupReport["oracle"]["lookupScope"];
	const value = Object.freeze({ kind: "present", state: "verified", retention: "recovery" }),
		conflict = Object.freeze(Object.assign(new Error("native conflict identity"), { code: "conflict" })),
		migration = Object.freeze(Object.assign(new Error("native migration identity"), { code: "migration-required" }));
	const effects = freshEffects();
	await observe(effects, async () => {
		assert.equal(lookupOutcome(scope, value), value);
		assert.equal(lookupRefusal(scope, conflict), conflict);
		assert.equal(mutationRefusal(migration), migration);
		await Promise.resolve();
	});
	assert.deepEqual(
		effects.traces.map(({ site, code }) => ({ site, code })),
		[
			{ site: "native-lookup-outcome", code: undefined },
			{ site: "native-lookup-refusal", code: "conflict" },
			{ site: "native-mutation-refusal", code: "migration-required" },
		]
	);
	// This is a helper identity control, NOT a genuine native reach claim.
});
void test("pending authentication insertion is insertion-only and fails closed on missing/duplicate seams", () => {
	// Source-model self-controls only: never execute a selected-facts GREEN implementation.
	const verifierSite = (
		source: string
	): {
		statement: { start: number; end: number };
		local: { start: number; end: number };
		callee: { start: number; end: number };
		arguments: { start: number; end: number };
	} => {
		const ast = ts.createSourceFile(
			"pending-verifier-control.js",
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.JS
		);
		const owners = ast.statements.filter(
			(node): node is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(node) && node.name?.text === "authenticatePendingCandidate"
		);
		assert.equal(owners.length, 1, "CONTROL_PENDING_AUTH_OWNER_NOT_UNIQUE");
		const owner = owners[0];
		assert.ok(owner?.body, "CONTROL_PENDING_AUTH_OWNER_BODY_MISSING");
		const targets: { statement: ts.VariableStatement; local: ts.BindingName; call: ts.CallExpression }[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
				const declaration = node.declarationList.declarations[0],
					original = declaration?.initializer;
				const call =
					original !== undefined && (ts.isAwaitExpression(original) || ts.isYieldExpression(original))
						? original.expression
						: original;
				if (
					declaration !== undefined &&
					call !== undefined &&
					ts.isCallExpression(call) &&
					ts.isIdentifier(call.expression) &&
					call.expression.text === "verifySnapshot"
				)
					targets.push({ statement: node, local: declaration.name, call });
			}
			ts.forEachChild(node, visit);
		};
		visit(owner.body);
		assert.equal(targets.length, 1, "CONTROL_PENDING_VERIFIER_NOT_UNIQUE");
		const target = targets[0];
		assert.ok(target);
		assert.ok(
			ts.isIdentifier(target.local) && target.local.text === "snapshot",
			"CONTROL_PENDING_VERIFIER_LOCAL_CHANGED"
		);
		return {
			statement: { start: target.statement.getStart(ast), end: target.statement.end },
			local: { start: target.local.getStart(ast), end: target.local.end },
			callee: { start: target.call.expression.getStart(ast), end: target.call.expression.end },
			arguments: { start: target.call.arguments.pos, end: target.call.arguments.end },
		};
	};
	const splice = (source: string, range: { start: number; end: number }, replacement: string): string => {
		assert.ok(range.start >= 0 && range.end > range.start && range.end <= source.length);
		const changed = source.slice(0, range.start) + replacement + source.slice(range.end);
		assert.notEqual(changed, source, "CONTROL_SOURCE_MUTANT_MUST_DIFFER");
		return changed;
	};
	const raw = readFileSync(resolve(root, "packages/node/dist/src/creator-adoption.js"), "utf8"),
		argumentRange = verifierSite(raw).arguments,
		selectedFacts =
			raw.slice(0, argumentRange.start) +
			"\n{ snapshotStore: input.snapshotStore, snapshotDeclaration: selectedDeclaration },\nchain\n" +
			raw.slice(argumentRange.end);
	// A future real call may already have these argument bytes: positive models need not differ.
	for (const [model, source] of [
		["actual-built-source", raw],
		["selected-facts-arguments-source-model", selectedFacts],
	] as const) {
		const site = verifierSite(source),
			transformed = transformPending(source);
		let reproduced = source;
		for (const insertion of [...transformed.insertions].sort((a, b) => b.offset - a.offset))
			reproduced = reproduced.slice(0, insertion.offset) + insertion.text + reproduced.slice(insertion.offset);
		assert.equal(reproduced, transformed.code);
		assert.equal(
			transformed.insertions.filter((entry) => entry.text.includes("__pendingSnapshot(snapshot);")).length,
			1
		);
		const missingLocal = splice(source, site.local, "changed"),
			statement = source.slice(site.statement.start, site.statement.end),
			duplicateStatement = splice(source, site.statement, statement + "\n" + statement),
			missingCallee = splice(source, site.callee, "changedVerifier");
		assert.notEqual(missingLocal, source);
		assert.throws(() => transformPending(missingLocal), /PENDING_VERIFIER_LOCAL_CHANGED/u);
		assert.notEqual(duplicateStatement, source);
		assert.throws(() => transformPending(duplicateStatement), /PENDING_AUTH_SITE_NOT_UNIQUE:snapshot-result:2/u);
		assert.notEqual(missingCallee, source);
		assert.throws(() => transformPending(missingCallee), /PENDING_AUTH_SITE_NOT_UNIQUE/u);
		assert.throws(() => verifierSite(missingLocal), /CONTROL_PENDING_VERIFIER_LOCAL_CHANGED/u);
		assert.throws(() => verifierSite(duplicateStatement), /CONTROL_PENDING_VERIFIER_NOT_UNIQUE/u);
		assert.throws(() => verifierSite(missingCallee), /CONTROL_PENDING_VERIFIER_NOT_UNIQUE/u);
		assert.throws(() => verifierSite(source + source), /CONTROL_PENDING_AUTH_OWNER_NOT_UNIQUE/u);
		assert.throws(() => verifierSite(""), /CONTROL_PENDING_AUTH_OWNER_NOT_UNIQUE/u);
		assert.throws(() => transformPending(transformed.code), /PENDING_TRANSFORM_ALREADY_PRESENT/u);
		console.log(
			JSON.stringify({
				lane: "SOURCE_MODEL_SELF_CONTROL_ONLY_NOT_NATIVE_OR_GREEN",
				model,
				insertionOnly: true,
				snapshotObservations: 1,
				actualMutantsRefused: ["missing-local", "duplicate-statement", "missing-callee"],
				locatorMissingAmbiguousRefused: true,
			})
		);
	}
	assert.throws(
		() => transformPending(raw.replace("function authenticatePendingCandidate(", "function changedPendingCandidate(")),
		/PENDING_AUTH_OWNER_NOT_UNIQUE/u
	);
	assert.throws(() => transformPending(raw + raw), /PENDING_AUTH_OWNER_NOT_UNIQUE/u);
});
for (const frozen of [false, true])
	void test("cleanup preserves primary/cause and every rejection; frozen=" + frozen, async () => {
		const primary = new Error("primary"),
			fault1 = new Error("close-one"),
			fault2 = new Error("close-two"),
			reached: string[] = [];
		if (frozen) Object.freeze(primary);
		let observed: unknown;
		try {
			await closeAll(
				[
					(): Promise<void> => {
						reached.push("one");
						return Promise.reject(fault1);
					},
					(): Promise<void> => {
						reached.push("two");
						return Promise.reject(fault2);
					},
					async (): Promise<void> => {
						reached.push("three");
						await Promise.resolve();
					},
				],
				{ error: primary }
			);
		} catch (error) {
			observed = error;
		}
		assert.deepEqual(reached, ["one", "two", "three"]);
		if (frozen) {
			assert.ok(observed instanceof AggregateError);
			assert.equal(observed.cause, primary);
			assert.deepEqual(observed.errors, [primary, fault1, fault2]);
		} else {
			assert.equal(observed, primary);
			assert.deepEqual(Reflect.get(primary, "cleanupFailures"), [fault1, fault2]);
		}
	});
void test("cleanup preserves deliberately thrown undefined and preannotated primary", async () => {
	let caught = false;
	try {
		await closeAll([], { error: undefined });
	} catch (error) {
		caught = true;
		assert.equal(error, undefined);
	}
	assert.equal(caught, true);
	const primary = new Error("preannotated");
	Object.defineProperty(primary, "cleanupFailures", { value: ["previous"], configurable: false });
	await assert.rejects(
		closeAll([(): Promise<void> => Promise.reject(new Error("later"))], { error: primary }),
		(error: unknown) => error instanceof AggregateError && error.cause === primary && error.errors.length === 2
	);
});
void test("product bootstrap rejects probe/setup oracle material as extra own keys", () => {
	const base = {
		identity: "identity",
		catalogDigest: "catalog",
		detachedSignature: "signature",
		exactCanonicalAnchorPreimageBytes: "anchor",
		exactCanonicalParametersCarrierBytes: "parameters",
		pinnedGenesisAnchorDigest: "pin",
		expectedPreviousRoomHead: { currentAnchorDigest: "previous", epoch: 0, objectId: "object" },
		expectedNextRoomHead: { currentAnchorDigest: "next", epoch: 1, objectId: "object" },
	};
	assert.equal(validateBootstrap(base), base);
	for (const key of [
		"scope",
		"manifest",
		"chunks",
		"payload",
		"snapshotDeclaration",
		"oracle",
		"lookupScope",
		"generationId",
	])
		assert.throws(() => validateBootstrap({ ...base, [key]: {} }), /PENDING_BOOTSTRAP_EXACT_KEYS/u);
});
void test("required pending discovery is an unconditional direct invocation, not optional feature detection", () => {
	const source = readFileSync(resolve(root, "packages/node/src/creator-adoption.ts"), "utf8"),
		ast = ts.createSourceFile("creator-adoption.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const owners = ast.statements.filter(
		(node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "authenticatePendingCandidate"
	);
	assert.equal(owners.length, 1);
	const owner = owners[0];
	assert.ok(owner?.body);
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "lookupRecoveryDeclaration"
		)
			calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(owner.body);
	assert.equal(calls.length, 1, "CAUSAL_RED: pending candidate has no required discovery invocation yet");
	const call = calls[0];
	assert.ok(call);
	assert.equal(call.questionDotToken, undefined);
	assert.ok(ts.isPropertyAccessExpression(call.expression));
	assert.equal(call.expression.questionDotToken, undefined);
	assert.doesNotMatch(
		owner.body.getText(ast),
		/typeof\s+[^;\n]*lookupRecoveryDeclaration|lookupRecoveryDeclaration\s+in\s|lookupRecoveryDeclaration\s*\?\./u
	);
});

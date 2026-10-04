/* eslint-disable @typescript-eslint/explicit-function-return-type -- Finite fixture helpers retain strict inferred native result types. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, it } from "vitest";

import {
	assertRoleObservation,
	extraCases,
	negativeCases,
	positiveCases,
	type RoleBootstrap,
	type RoleConfig,
	type RoleFault,
	type RoleOracle,
	type RoleReport,
} from "./fixtures/rollback-data-observation/role-assertions.js";
import { createCreatorClosedRollbackProofAccounting } from "../packages/node/src/internal/creator-closed-rollback-data.js";
const execute = promisify(execFile),
	directory = mkdtempSync(join(tmpdir(), "protected-role-native-")),
	artifacts = process.env.ROLLBACK_ARTIFACTS,
	raw = process.env.ROLLBACK_EVIDENCE;
if (!artifacts || !raw) throw Error("ROLE_FROZEN_ARTIFACTS_AND_EVIDENCE_REQUIRED");
const artifactDirectory = artifacts,
	evidence = raw;
mkdirSync(evidence, { recursive: true });
let serial = 0;
afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
	writeFileSync(
		join(evidence, "node-cleanup.json"),
		JSON.stringify({ exactOwnedTemporary: directory, childrenJoined: true, removed: true })
	);
});
async function child(name: string, args: string[]) {
	const custody = process.env.BOUNDED_AHE_RUNTIME_CUSTODY
		? ["--import", resolve("tests/fixtures/bounded-active-read/runtime-custody.mjs")]
		: [];
	const result = await execute(process.execPath, [...custody, join(artifactDirectory, name + ".mjs"), ...args], {
		timeout: 90000,
		maxBuffer: 5 * 1024 * 1024,
	});
	return JSON.parse(result.stdout) as Record<string, unknown>;
}
async function produce(config: RoleConfig) {
	return (await child("role-node-entry", [join(directory, String(serial++)), JSON.stringify(config)])) as unknown as {
		pid: number;
		bootstrap: RoleBootstrap;
		oracle: RoleOracle;
		cleanup: unknown;
	};
}
it("genuine native reachability stable n2 and pending n1 both phases/profiles (no Node role claim)", async () => {
	const records = [];
	for (const profile of ["creator-trusted-v1", "creator-trusted-settlement-v1"] as const)
		for (const config of [
			{ epoch: 2 as const, profile },
			{ epoch: 2 as const, profile, stop: "before-publication" as const },
			{ epoch: 2 as const, profile, stop: "already-published" as const },
		]) {
			const value = await produce(config);
			assert.ok(value.oracle.nativeUnionBytes <= 262144);
			assert.ok(value.oracle.allGenerations.length <= 7);
			assert.ok(value.oracle.preconditions.every((p) => p.early && p.deferred));
			assert.equal(value.oracle.current.roomHead.epoch, config.stop ? 1 : 2);
			assert.equal(value.oracle.pending?.publication ?? null, config.stop ?? null);
			records.push(value);
		}
	writeFileSync(join(evidence, "genuine-reachability.json"), JSON.stringify(records, null, 2));
});
for (const { name, config, fault } of [
	...positiveCases.map((c) => ({ ...c, fault: "none" as RoleFault })),
	...negativeCases,
	...extraCases,
])
	it("whole role observation: " + name, async () => {
		const installed = await produce(config),
			value = (await child("role-node-recovery", [
				JSON.stringify(installed.bootstrap),
				fault,
			])) as unknown as RoleReport & { pid: number };
		writeFileSync(join(evidence, name + ".json"), JSON.stringify({ installed, value }, null, 2));
		assert.notEqual(value.pid, installed.pid);
		assertRoleObservation(value, installed.oracle, fault);
	});
it("pure equation only: same digest unequal lengths cannot enter Node through native authentication", () => {
	const q = [
			{ digest: "a", byteLength: 2 },
			{ digest: "b", byteLength: 3 },
		],
		expected = [
			{ digest: "b", byteLength: 3 },
			{ digest: "c", byteLength: 4 },
			{ digest: "d", byteLength: 5 },
		],
		mutant = [
			{ digest: "b", byteLength: 4 },
			{ digest: "c", byteLength: 4 },
			{ digest: "d", byteLength: 5 },
		];
	const successorProjection = { digest: "c", byteLength: 4 },
		closedAcl = { digest: "d", byteLength: 5 };
	const complete = [...q.filter((r) => r.digest !== "a"), successorProjection, closedAcl].sort((a, b) =>
		a.digest.localeCompare(b.digest)
	);
	const equation = (refs: typeof q) =>
		refs.length === complete.length &&
		[...refs]
			.sort((a, b) => a.digest.localeCompare(b.digest))
			.every((r, i) => r.digest === complete[i]?.digest && r.byteLength === complete[i]?.byteLength);
	assert.equal(equation(expected), true);
	assert.equal(equation(mutant), false);
	assert.deepEqual(
		q.filter((r) => r.digest !== "a"),
		[{ digest: "b", byteLength: 3 }]
	);
	assert.equal(equation(expected.slice(1)), false, "no subset equation");
	assert.equal(equation([...expected, { digest: "e", byteLength: 1 }]), false, "every extra ref remains significant");
});
it("pure accounting equality, unequal same length and exact fixed boundary (not published native pressure)", () => {
	const owner = createCreatorClosedRollbackProofAccounting([
		{ ref: { digest: "a" as never, byteLength: 2 }, bytes: Uint8Array.of(1, 2) },
	]);
	assert.equal(owner.chargedBytes, 2);
	assert.equal(owner.charge(Uint8Array.of(1, 2)), true);
	assert.equal(owner.chargedBytes, 2);
	assert.equal(owner.charge(Uint8Array.of(2, 1)), true);
	assert.equal(owner.chargedBytes, 4);
	assert.equal(owner.charge(new Uint8Array(262140)), true);
	assert.equal(owner.chargedBytes, 262144);
	assert.equal(owner.charge(Uint8Array.of(9)), false);
	assert.equal(owner.chargedBytes, 262144);
});
it("source guard: retirement-only policy stays genuine-evidence gated and original aggregate producer stays intact", () => {
	const source = readFileSync("packages/node/src/internal/creator-closed-rollback-data.ts", "utf8"),
		producer = readFileSync("tests/fixtures/rollback-data-observation/producer.ts", "utf8"),
		manifest = readFileSync("packages/node/package.json", "utf8"),
		root = readFileSync("packages/node/src/index.ts", "utf8");
	assert.ok(!/erase|provisionLegacy|prepareCreatorAuthorIssuanceFrontiers/u.test(producer));
	assert.ok(
		!/observeCreatorProtectedRecoveryRoles|resolveCreatorProtectedRecoveryRoleObservation/u.test(manifest + root)
	);
	assert.match(source, /openCreatorTransitionClosedCutEvidence/u);
	assert.match(
		source,
		/RETIREMENT_ONLY_ADVANCE_UNAVAILABLE/u,
		"SOURCE_RED until genuine evidence-gated role policy refusal exists"
	);
	assert.match(source, /"pending-policy-unavailable"/u);
});

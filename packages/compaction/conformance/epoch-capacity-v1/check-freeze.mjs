#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root =
	process.env.COMPACTION_EPOCH_CAPACITY_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.COMPACTION_EPOCH_CAPACITY_REPOSITORY_ROOT);
const conformance = "packages/compaction/conformance/epoch-capacity-v1";
const paths = [
	`${conformance}/check-freeze.mjs`,
	`${conformance}/freeze-policy.json`,
	`${conformance}/profile.json`,
	`${conformance}/spec.md`,
	".github/workflows/compaction-epoch-capacity.yml",
	"tests/compaction-epoch-capacity-0p1.test.ts",
	"tests/fixtures/phase-0p1-v3/epoch-capacity-contract.json",
	"tests/fixtures/phase-0p1-v3/controlled-epoch-capacity.ts",
	"tests/fixtures/phase-0p1-v3/public-entry-type-audit.ts",
	"tests/fixtures/phase-0p1-v3/built-package-type-audit.ts",
	"tests/fixtures/phase-0p1-v3/tsconfig.public-entry-audit.json",
	"tests/fixtures/phase-0p1-v3/tsconfig.built-package-audit.json",
];
const hash = (path) => createHash("sha256").update(read(path)).digest("hex");
function fail(message) {
	throw new Error(`compaction epoch capacity freeze violation: ${message}`);
}
function read(path) {
	const absolute = resolve(root, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${path} is absent or irregular`);
	return readFileSync(absolute);
}
function git(...args) {
	return execFileSync("git", args, { cwd: root, encoding: null, stdio: ["ignore", "pipe", "ignore"] });
}

const policy = JSON.parse(read(`${conformance}/freeze-policy.json`));
if (
	JSON.stringify(readdirSync(resolve(root, conformance)).sort()) !==
	JSON.stringify(["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"])
) {
	fail("conformance file set differs");
}
if (
	policy.schemaVersion !== "ts-drp-compaction-epoch-capacity-freeze-v1" ||
	policy.profile !== "compaction-epoch-capacity-v1" ||
	JSON.stringify(policy.protectedArtifacts) !== JSON.stringify(paths)
) {
	fail("policy identity differs");
}
if (policy.checkerSha256 !== hash(paths[0])) fail("checker hash differs");
for (const path of paths.slice(2)) {
	if (policy.artifactSha256?.[path] !== hash(path)) fail(`artifact hash differs: ${path}`);
}

const profile = JSON.parse(read(`${conformance}/profile.json`));
if (
	profile.capacity?.anchorInclusive !== true ||
	profile.capacity?.ordinaryVertexMaximum !== "maxEpochVertices - 1" ||
	profile.outcome?.code !== "EPOCH_FULL" ||
	profile.outcome?.status !== "pending" ||
	profile.outcome?.latchByHash !== false ||
	profile.outcome?.finalMembershipAuthority !== false ||
	profile.claims?.maxEpochBytes !== false ||
	profile.claims?.executionMetering !== false
) {
	fail("capacity contract differs");
}
const workflow = read(".github/workflows/compaction-epoch-capacity.yml").toString();
for (const phrase of [
	"permissions:\n  contents: read",
	"PHASE_0P1_IMPLEMENTATION_MODULE",
	"--maxWorkers=1 --minWorkers=1",
	"causality-append-0e.test.ts",
]) {
	if (!workflow.includes(phrase)) fail(`workflow omits ${phrase}`);
}

const base = process.argv[2];
if (base !== undefined) {
	git("rev-parse", "--verify", `${base}^{commit}`);
	const present = paths.map((path) => {
		try {
			return git("show", `${base}:${path}`);
		} catch {
			return undefined;
		}
	});
	const count = present.filter(Boolean).length;
	if (count !== 0 && count !== paths.length) fail("bootstrap is non-atomic");
	if (count === paths.length) {
		for (let index = 0; index < paths.length; index++) {
			if (createHash("sha256").update(present[index]).digest("hex") !== hash(paths[index])) {
				fail(`frozen artifact changed: ${paths[index]}`);
			}
		}
	}
}
console.log("compaction epoch capacity freeze: PASS");

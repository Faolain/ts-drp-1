#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root =
	process.env.COMPACTION_EPOCH_BYTE_CAPACITY_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.COMPACTION_EPOCH_BYTE_CAPACITY_REPOSITORY_ROOT);
const conformance = "packages/compaction/conformance/epoch-byte-capacity-v1";
const predecessor = "packages/compaction/conformance/epoch-capacity-v1";
const paths = [
	`${conformance}/check-freeze.mjs`,
	`${conformance}/freeze-policy.json`,
	`${conformance}/profile.json`,
	`${conformance}/spec.md`,
	".github/workflows/compaction-epoch-byte-capacity.yml",
	"tests/compaction-epoch-byte-capacity-0p3.test.ts",
	"tests/fixtures/phase-0p3-v3/epoch-byte-capacity-contract.json",
	"tests/fixtures/phase-0p3-v3/controlled-epoch-byte-capacity.ts",
	"tests/fixtures/phase-0p3-v3/public-entry-type-audit.ts",
	"tests/fixtures/phase-0p3-v3/built-package-type-audit.ts",
	"tests/fixtures/phase-0p3-v3/tsconfig.public-entry-audit.json",
	"tests/fixtures/phase-0p3-v3/tsconfig.built-package-audit.json",
];
const exactTree = ["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"];
const hash = (path) => createHash("sha256").update(read(path)).digest("hex");
function fail(message) {
	throw new Error(`compaction epoch byte capacity freeze violation: ${message}`);
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
if (JSON.stringify(readdirSync(resolve(root, conformance)).sort()) !== JSON.stringify(exactTree)) {
	fail("conformance file set differs");
}
if (JSON.stringify(readdirSync(resolve(root, predecessor)).sort()) !== JSON.stringify(exactTree)) {
	fail("predecessor conformance file set differs");
}
if (JSON.parse(read(`${predecessor}/profile.json`)).claims?.maxEpochBytes !== false) {
	fail("predecessor maxEpochBytes claim was restamped");
}
if (
	policy.schemaVersion !== "ts-drp-compaction-epoch-byte-capacity-freeze-v1" ||
	policy.profile !== "compaction-epoch-byte-capacity-v1" ||
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
	profile.api?.maxBytesOption !== "maxEpochBytes" ||
	profile.api?.initialChargesOption !== "initialByteCharges" ||
	profile.api?.appendChargeArgument !== 3 ||
	profile.api?.optional !== true ||
	profile.api?.returnUnion !== "undefined | EpochFullOutcome" ||
	profile.accounting?.anchorInclusive !== true ||
	profile.accounting?.comparison !== "charge <= maxEpochBytes - total" ||
	profile.accounting?.countFirstSaturation !== true ||
	profile.accounting?.postCaptureDualRecheck !== true ||
	profile.errors?.invalidCharges !== "INVALID_BYTE_CHARGES" ||
	profile.errors?.initialOversize !== "EPOCH_CAPACITY_EXCEEDED" ||
	profile.outcome?.code !== "EPOCH_FULL" ||
	profile.outcome?.status !== "pending" ||
	profile.outcome?.latchByHash !== false ||
	profile.claims?.carrierAuthentication !== false ||
	profile.claims?.carrierMeasurement !== false ||
	profile.claims?.parametersDigestAuthentication !== false ||
	profile.claims?.finalMembershipAuthority !== false
) {
	fail("byte-capacity contract differs");
}
const contract = JSON.parse(read("tests/fixtures/phase-0p3-v3/epoch-byte-capacity-contract.json"));
if (
	!Array.isArray(contract.mutants) ||
	contract.mutants.length !== 17 ||
	JSON.stringify(Object.keys(contract.mutantRows ?? {})) !== JSON.stringify(contract.mutants)
) {
	fail("mutant matrix identity differs");
}
const workflow = read(".github/workflows/compaction-epoch-byte-capacity.yml").toString();
for (const phrase of [
	"permissions:\n  contents: read",
	"PHASE_0P3_IMPLEMENTATION_MODULE",
	"PHASE_0P3_MUTANT",
	"Tests  1 failed | 15 passed (16)",
	"mutant failure title mismatch",
	"--maxWorkers=1 --minWorkers=1",
	"epoch-capacity-v1/check-freeze.mjs",
	'git show "$BASE_SHA:packages/compaction/conformance/epoch-byte-capacity-v1/check-freeze.mjs"',
	"tsconfig.public-entry-audit.json",
	"tsconfig.built-package-audit.json",
]) {
	if (!workflow.includes(phrase)) fail(`workflow omits ${phrase}`);
}
for (const forbidden of [/\bpull_request_target\b/u, /\bcontinue-on-error\b/u, /contents:\s*write/u]) {
	if (forbidden.test(workflow)) fail(`workflow has forbidden structure: ${forbidden}`);
}
if (/\s-t\s/u.test(workflow)) fail("workflow targets mutant rows instead of running the full suite");

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
console.log("compaction epoch byte capacity freeze: PASS");

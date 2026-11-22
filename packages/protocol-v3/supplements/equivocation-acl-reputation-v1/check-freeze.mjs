#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root =
	process.env.PROTOCOL_V3_EQUIVOCATION_ACL_REPUTATION_REPOSITORY_ROOT === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
		: resolve(process.env.PROTOCOL_V3_EQUIVOCATION_ACL_REPUTATION_REPOSITORY_ROOT);
const supplement = "packages/protocol-v3/supplements/equivocation-acl-reputation-v1";
const paths = [
	`${supplement}/check-freeze.mjs`,
	`${supplement}/freeze-policy.json`,
	`${supplement}/profile.json`,
	`${supplement}/spec.md`,
	".github/workflows/protocol-v3-equivocation-acl-reputation.yml",
	"tests/protocol-v3-equivocation-acl-reputation-0o-b3.test.ts",
	"tests/fixtures/phase-0o-b3-v3/acl-reputation-contract.json",
	"tests/fixtures/phase-0o-b3-v3/controlled-acl-reputation.ts",
	"tests/fixtures/phase-0o-b3-v3/public-reexport-mutant.ts",
	"tests/fixtures/phase-0o-b3-v3/public-entry-type-audit.ts",
	"tests/fixtures/phase-0o-b3-v3/built-package-type-audit.ts",
	"tests/fixtures/phase-0o-b3-v3/tsconfig.public-entry-audit.json",
	"tests/fixtures/phase-0o-b3-v3/tsconfig.built-package-audit.json",
	"tests/fixtures/phase-0o-b3-v3/public-export-contract.mjs",
];
/**
 * @param path - Repository-relative file path.
 * @returns A SHA-256 digest.
 */
const hash = (path) => createHash("sha256").update(read(path)).digest("hex");
/**
 * @param message - Freeze violation detail.
 * @throws Always throws the described freeze violation.
 */
function fail(message) {
	throw new Error(`protocol-v3 equivocation ACL reputation freeze violation: ${message}`);
}
/**
 * @param path - Repository-relative file path.
 * @returns File bytes.
 */
function read(path) {
	const absolute = resolve(root, path);
	if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`${path} is absent or irregular`);
	return readFileSync(absolute);
}
/**
 * @param args - Git arguments.
 * @returns Git stdout bytes.
 */
function git(...args) {
	return execFileSync("git", args, { cwd: root, encoding: null, stdio: ["ignore", "pipe", "ignore"] });
}
const policy = JSON.parse(read(`${supplement}/freeze-policy.json`));
if (
	JSON.stringify(readdirSync(resolve(root, supplement)).sort()) !==
	JSON.stringify(["check-freeze.mjs", "freeze-policy.json", "profile.json", "spec.md"])
)
	fail("supplement file set differs");
if (
	policy.schemaVersion !== "ts-drp-equivocation-acl-reputation-freeze-v1" ||
	policy.profile !== "equivocation-acl-reputation-v1" ||
	JSON.stringify(policy.protectedArtifacts) !== JSON.stringify(paths)
)
	fail("policy identity differs");
if (policy.checkerSha256 !== hash(paths[0])) fail("checker hash differs");
for (const path of paths.slice(2))
	if (policy.artifactSha256?.[path] !== hash(path)) fail(`artifact hash differs: ${path}`);
const profile = JSON.parse(read(`${supplement}/profile.json`));
if (
	profile.reputation?.unit !== "canonical-unordered-distinct-digest-pair" ||
	profile.reputation?.higherPenalty !== "worse-reputation" ||
	profile.output?.perSlotDetailExposed !== false ||
	profile.claims?.aclMutation !== false ||
	profile.claims?.admissionAuthority !== false
)
	fail("aggregate reputation contract differs");
const workflow = read(".github/workflows/protocol-v3-equivocation-acl-reputation.yml").toString();
for (const phrase of [
	"permissions:\n  contents: read",
	"PHASE_0O_B3_IMPLEMENTATION_MODULE",
	"--maxWorkers=1 --minWorkers=1",
	"equivocation-gossip-budget-v1/check-freeze.mjs",
])
	if (!workflow.includes(phrase)) fail(`workflow omits ${phrase}`);
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
	if (count === paths.length)
		for (let index = 0; index < paths.length; index++)
			if (createHash("sha256").update(present[index]).digest("hex") !== hash(paths[index]))
				fail(`frozen artifact changed: ${paths[index]}`);
}
console.log("protocol-v3 equivocation ACL reputation freeze: PASS");

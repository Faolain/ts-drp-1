/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = process.env.PROTOCOL_V3_EQUIVOCATION_AUTHOR_PROJECTION_REPOSITORY_ROOT ?? process.cwd();
const supplementRoot = "packages/protocol-v3/supplements/equivocation-author-projection-v1";
const checkerPath = `${supplementRoot}/check-freeze.mjs`;
const policyPath = `${supplementRoot}/freeze-policy.json`;
const profilePath = `${supplementRoot}/profile.json`;
const specificationPath = `${supplementRoot}/spec.md`;
const workflowPath = ".github/workflows/protocol-v3-equivocation-author-projection.yml";
const baseSha = process.argv[2];

function fail(message) {
	throw new Error(`protocol-v3 equivocation author projection freeze violation: ${message}`);
}

function bytes(path) {
	return readFileSync(resolve(repositoryRoot, path));
}

function text(path) {
	return bytes(path).toString("utf8");
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function git(...arguments_) {
	return execFileSync("git", arguments_, {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function existsAtRevision(revision, path) {
	try {
		git("cat-file", "-e", `${revision}:${path}`);
		return true;
	} catch {
		return false;
	}
}

const policy = JSON.parse(text(policyPath));
if (
	policy.schemaVersion !== "ts-drp-equivocation-author-projection-freeze-v1" ||
	policy.profile !== "equivocation-author-projection-v1" ||
	policy.baseProfile !== "equivocation-evidence-projection-v1" ||
	policy.checker !== "check-freeze.mjs" ||
	policy.workflow !== workflowPath
) {
	fail("freeze policy identity is malformed");
}
if (!Array.isArray(policy.protectedArtifacts) || policy.protectedArtifacts.length === 0) {
	fail("protected artifact set is empty");
}
const uniqueArtifacts = new Set(policy.protectedArtifacts);
if (uniqueArtifacts.size !== policy.protectedArtifacts.length) fail("protected artifact set contains duplicates");
for (const required of [checkerPath, policyPath, profilePath, specificationPath, workflowPath]) {
	if (!uniqueArtifacts.has(required)) fail(`protected artifact set omits ${required}`);
}
if (sha256(bytes(checkerPath)) !== policy.checkerSha256) fail("checker hash does not match policy");
for (const [path, expected] of Object.entries(policy.artifactSha256)) {
	if (!uniqueArtifacts.has(path)) fail(`hashed artifact is not protected: ${path}`);
	if (sha256(bytes(path)) !== expected) fail(`artifact hash mismatch: ${path}`);
}
for (const path of policy.protectedArtifacts) {
	if (path !== checkerPath && path !== policyPath && policy.artifactSha256[path] === undefined) {
		fail(`protected artifact lacks a current hash: ${path}`);
	}
}

const profile = JSON.parse(text(profilePath));
if (
	profile.profileId !== "equivocation-author-projection-v1" ||
	profile.baseProfileId !== "equivocation-evidence-projection-v1" ||
	profile.authoritativeRead?.operation !== "readCommittedSlotState" ||
	profile.authorProjection?.pairExpansion !== "newDigests × postUnionDigests" ||
	profile.durability?.recoveryOperation !== "enumerateCommittedAuthorSlots" ||
	profile.durability?.externalHandoffExactlyOnceClaimed !== false ||
	profile.pendingRow?.proofBodyCopies !== 0 ||
	profile.pendingRow?.payloadCopies !== 0 ||
	profile.pendingRow?.uint8ArrayValues !== 0
) {
	fail("profile contract is malformed");
}

const specification = text(specificationPath);
for (const required of [
	"readCommittedSlotState",
	"newDigests × postUnionDigests",
	"enumerateCommittedAuthorSlots",
	"current committed witnesses",
	"at-least-once",
	"no acknowledgement API",
	"state.proofs",
]) {
	if (!specification.includes(required)) fail(`specification omits ${required}`);
}

const workflow = text(workflowPath);
for (const required of [
	"name: Protocol v3 equivocation author projection freeze",
	"permissions:\n  contents: read",
	"ref: ${{ github.sha }}",
	"timeout-minutes: 10",
	"PHASE_0O_B1B_IMPLEMENTATION_MODULE",
	"--no-coverage --maxWorkers=1 --minWorkers=1",
	"public-export-contract.mjs",
	"equivocation-digest-identity-v1/check-freeze.mjs",
	"equivocation-evidence-projection-v1/check-freeze.mjs",
]) {
	if (!workflow.includes(required)) fail(`workflow omits ${required}`);
}
if (/permissions:\s*(?:write-all|\{)/u.test(workflow) || /contents:\s*write/u.test(workflow)) {
	fail("workflow grants write permission");
}

if (baseSha !== undefined) {
	git("rev-parse", "--verify", `${baseSha}^{commit}`);
	const presence = policy.protectedArtifacts.map((path) => existsAtRevision(baseSha, path));
	const presentCount = presence.filter(Boolean).length;
	if (presentCount !== 0 && presentCount !== policy.protectedArtifacts.length) {
		fail("bootstrap is non-atomic at merge base");
	}
	if (presentCount === policy.protectedArtifacts.length) {
		for (const path of policy.protectedArtifacts) {
			const baseBytes = Buffer.from(git("show", `${baseSha}:${path}`));
			if (sha256(baseBytes) !== sha256(bytes(path))) fail(`frozen artifact changed from merge base: ${path}`);
		}
	}
}

console.log("protocol-v3 equivocation author projection freeze: PASS");

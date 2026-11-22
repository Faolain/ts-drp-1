import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import contract from "./fixtures/phase-5-v3/seal-digest-law-contract.json" with { type: "json" };

interface RegisteredField {
	readonly name: string;
	readonly constraints?: Readonly<Record<string, unknown>>;
}

interface RegisteredKind {
	readonly domain: string;
	readonly fields: readonly RegisteredField[];
}

interface RegistryV1 {
	readonly kinds: Readonly<Record<string, RegisteredKind>>;
	readonly protocolMajor: number;
	readonly registryVersion: number;
}

interface RegistryVector {
	readonly canonicalHex: string;
	readonly digestHex: string;
	readonly domain: string;
	readonly id: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly kind: string;
}

interface RegistryVectors {
	readonly vectors: readonly RegistryVector[];
}

interface ReferenceResult {
	readonly canonicalHex: string;
	readonly digestHex: string;
	readonly id: string;
	readonly normalized: Readonly<Record<string, unknown>>;
}

interface DigestBinding {
	phase: string;
	proposalDigestHex: string;
	proposalHashHex: string;
	round: number;
}

interface SemanticLawProjection {
	cutValueDigest: string;
	lockIdentity: string;
	proposalHash: string;
	qcBindings: DigestBinding[];
	qcProposalDigest: string;
	roundChangeDisposition: string;
	sameValueRoundCarryover: boolean;
	sealProposalValueDigest: string;
	sealVotePhases: string[];
	sealVoteProposalDigest: string;
	voteBindings: DigestBinding[];
}

interface WorkflowStep {
	readonly env?: Readonly<Record<string, unknown>>;
	readonly name?: string;
	readonly run?: string;
	readonly uses?: string;
	readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
	readonly permissions?: Readonly<Record<string, unknown>>;
	readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
	readonly jobs?: Readonly<Record<string, WorkflowJob>>;
	readonly on?: Readonly<Record<string, unknown>>;
	readonly permissions?: Readonly<Record<string, unknown>>;
}

interface CheckerResult {
	readonly output: string;
	readonly status: number | null;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCE = resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/original-reference/reference.mjs");
const REGISTRY_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json");
const VECTORS_PATH = resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/vectors/registry-v1.json");
const SUPPLEMENT_ROOT = resolve(REPOSITORY_ROOT, contract.supplement.directory);
const SUPPLEMENT_READY = supplementReady();
const DECISION_BLOCK_START = "<!-- PH-P5-D01:BEGIN -->";
const DECISION_BLOCK_END = "<!-- PH-P5-D01:END -->";
const CHECKER_ROOT_ENV = "PROTOCOL_V3_SEAL_DIGEST_IDENTITY_REPOSITORY_ROOT";

function bytesFromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError("fixture hex must be lowercase byte hex");
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function readJson<Value>(path: string): Value {
	return JSON.parse(readFileSync(path, "utf8")) as Value;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function u32be(value: number): Uint8Array {
	const output = new Uint8Array(4);
	new DataView(output.buffer).setUint32(0, value, false);
	return output;
}

function u64be(value: number): Uint8Array {
	const output = new Uint8Array(8);
	new DataView(output.buffer).setBigUint64(0, BigInt(value), false);
	return output;
}

function independentDomainHash(domain: string, part: Uint8Array): string {
	const domainBytes = new TextEncoder().encode(domain);
	return createHash("sha256")
		.update(Uint8Array.of(0x44, 0x52, 0x50, 0x00))
		.update(u32be(domainBytes.byteLength))
		.update(domainBytes)
		.update(u64be(part.byteLength))
		.update(part)
		.digest("hex");
}

function encodeWithIndependentReference(
	cases: readonly { readonly id: string; readonly input: Readonly<Record<string, unknown>>; readonly kind: string }[]
): readonly ReferenceResult[] {
	const stdout = execFileSync(process.execPath, [REFERENCE], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		input: JSON.stringify({ cases, operation: "encode-corpus" }),
		maxBuffer: 16 * 1024 * 1024,
	});
	return (JSON.parse(stdout) as { readonly results: readonly ReferenceResult[] }).results;
}

function supplementReady(): boolean {
	if (!existsSync(SUPPLEMENT_ROOT) || !statSync(SUPPLEMENT_ROOT).isDirectory()) return false;
	if (
		JSON.stringify(readdirSync(SUPPLEMENT_ROOT).sort()) !== JSON.stringify([...contract.supplement.exactFiles].sort())
	) {
		return false;
	}
	if (
		![
			...contract.supplement.exactFiles.map((file) => resolve(SUPPLEMENT_ROOT, file)),
			resolve(REPOSITORY_ROOT, contract.supplement.workflow),
		].every((path) => existsSync(path) && statSync(path).isFile())
	) {
		return false;
	}
	const checker = spawnSync(process.execPath, [resolve(REPOSITORY_ROOT, contract.supplement.checker)], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		timeout: 30_000,
	});
	return checker.status === 0;
}

function artifactHashes(paths: readonly string[]): Readonly<Record<string, string>> {
	return Object.fromEntries(paths.map((path) => [path, sha256File(resolve(REPOSITORY_ROOT, path))]));
}

function semanticLawFromContract(): SemanticLawProjection {
	return {
		cutValueDigest: contract.decision.requirements.cutValueDigest,
		lockIdentity: contract.decision.requirements.lockIdentity,
		proposalHash: contract.decision.requirements.proposalHash,
		qcBindings: structuredClone(contract.vectors.qcBindings),
		qcProposalDigest: contract.decision.requirements.qcProposalDigest,
		roundChangeDisposition: contract.decision.requirements.roundChangeDisposition,
		sameValueRoundCarryover: contract.decision.requirements.sameValueRoundCarryover,
		sealProposalValueDigest: contract.decision.requirements.sealProposalValueDigest,
		sealVotePhases: [...contract.decision.requirements.sealVotePhases],
		sealVoteProposalDigest: contract.decision.requirements.sealVoteProposalDigest,
		voteBindings: structuredClone(contract.vectors.voteBindings),
	};
}

function failSemanticLaw(code: string): never {
	throw new Error(code);
}

function auditSemanticLaw(law: SemanticLawProjection): void {
	if (law.cutValueDigest !== "hash-domain-exact-cut-value-bytes") {
		failSemanticLaw(contract.mutantRejections.ROUND_BEARING_VALUE_DIGEST);
	}
	if (law.proposalHash !== "hash-domain-exact-seal-proposal-bytes") {
		failSemanticLaw("PROPOSAL_HASH_IDENTITY_MISMATCH");
	}
	if (law.lockIdentity !== "valueDigest") {
		failSemanticLaw(contract.mutantRejections.PROPOSAL_HASH_AS_LOCK_IDENTITY);
	}
	if (
		law.sealProposalValueDigest !== "valueDigest" ||
		law.sealVoteProposalDigest !== "valueDigest" ||
		law.voteBindings.some(({ proposalDigestHex }) => proposalDigestHex !== contract.vectors.valueDigestHex)
	) {
		failSemanticLaw(contract.mutantRejections.VOTE_PROPOSAL_DIGEST_SUBSTITUTION);
	}
	if (
		law.qcProposalDigest !== "valueDigest" ||
		law.qcBindings.some(({ proposalDigestHex }) => proposalDigestHex !== contract.vectors.valueDigestHex)
	) {
		failSemanticLaw(contract.mutantRejections.QC_PROPOSAL_HASH_SUBSTITUTION);
	}
	if (
		JSON.stringify(law.sealVotePhases) !== JSON.stringify(["prepare", "commit"]) ||
		law.roundChangeDisposition !== "separate-kind-deferred-phase-5d"
	) {
		failSemanticLaw(contract.mutantRejections.ROUND_CHANGE_AS_SEAL_VOTE_PHASE);
	}
	if (!law.sameValueRoundCarryover) failSemanticLaw("ROUND_CARRYOVER_MISMATCH");
	for (const bindings of [law.voteBindings, law.qcBindings]) {
		if (
			bindings.length !== contract.vectors.proposals.length ||
			bindings.some(({ proposalHashHex, round }, index) => {
				const proposal = contract.vectors.proposals[index];
				return proposalHashHex !== proposal?.proposalHashHex || round !== proposal?.round;
			})
		) {
			failSemanticLaw("ROUND_BEARING_PROPOSAL_BINDING_MISMATCH");
		}
	}
}

function parseNormativeDecision(specification: string): unknown {
	const starts = specification.split(DECISION_BLOCK_START).length - 1;
	const ends = specification.split(DECISION_BLOCK_END).length - 1;
	if (starts !== 1 || ends !== 1) throw new Error("NORMATIVE_DECISION_BLOCK_COUNT");
	const start = specification.indexOf(DECISION_BLOCK_START) + DECISION_BLOCK_START.length;
	const end = specification.indexOf(DECISION_BLOCK_END, start);
	const body = specification.slice(start, end).trim();
	const match = /^```json\n(?<json>[\s\S]+)\n```$/u.exec(body);
	if (match?.groups?.json === undefined) throw new Error("NORMATIVE_DECISION_BLOCK_FORMAT");
	return JSON.parse(match.groups.json) as unknown;
}

function normalizedShellLines(source: string): readonly string[] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function expectedFreezeShellLines(): readonly string[] {
	return [
		'if git cat-file -e "$BASE_SHA:$CHECKER"; then',
		'git show "$BASE_SHA:$CHECKER" > "$RUNNER_TEMP/check-seal-digest-identity-base.mjs"',
		`${CHECKER_ROOT_ENV}="$GITHUB_WORKSPACE" \\`,
		'node "$RUNNER_TEMP/check-seal-digest-identity-base.mjs" "$BASE_SHA"',
		'elif ! git cat-file -e "$BASE_SHA:$POLICY" \\',
		'&& ! git cat-file -e "$BASE_SHA:$PROFILE" \\',
		'&& ! git cat-file -e "$BASE_SHA:$SCHEMA" \\',
		'&& ! git cat-file -e "$BASE_SHA:$SPECIFICATION" \\',
		'&& ! git cat-file -e "$BASE_SHA:$VECTORS" \\',
		'&& ! git cat-file -e "$BASE_SHA:$WORKFLOW" \\',
		'&& ! git cat-file -e "$BASE_SHA:$RED_TEST" \\',
		'&& ! git cat-file -e "$BASE_SHA:$RED_CONTRACT"; then',
		`${CHECKER_ROOT_ENV}="$GITHUB_WORKSPACE" node "$CHECKER" "$BASE_SHA"`,
		"else",
		'echo "Seal digest identity bootstrap is fail-closed and atomic." >&2',
		"exit 1",
		"fi",
		`${CHECKER_ROOT_ENV}="$GITHUB_WORKSPACE" node "$CHECKER" "$BASE_SHA"`,
	];
}

function auditWorkflow(source: string): void {
	const document = parse(source) as WorkflowDocument;
	expect(Object.keys(document.on ?? {})).toEqual([contract.workflowContract.trigger]);
	expect(document.permissions).toEqual(contract.workflowContract.permissions);
	const jobs = Object.values(document.jobs ?? {});
	expect(jobs).toHaveLength(1);
	const job = jobs[0];
	expect(job?.permissions === undefined || job.permissions).toEqual(
		job?.permissions === undefined ? undefined : contract.workflowContract.permissions
	);
	const steps = job?.steps ?? [];
	const checkout = steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
	expect(checkout).toBeDefined();
	expect(checkout?.with).toEqual({
		"fetch-depth": contract.workflowContract.fetchDepth,
		"ref": contract.workflowContract.checkoutRef,
	});
	const freeze = steps.find(({ env }) => env?.CHECKER === contract.supplement.checker);
	expect(freeze).toBeDefined();
	expect(freeze?.env?.BASE_SHA).toBe(contract.workflowContract.baseSha);
	expect(normalizedShellLines(freeze?.run ?? "")).toEqual(expectedFreezeShellLines());
	expect(source).not.toMatch(/pull_request_target|continue-on-error|write-all|contents:\s*write/u);
}

function git(root: string, ...args: readonly string[]): ReturnType<typeof spawnSync> {
	return spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function copyFileIntoControlledRepository(root: string, path: string): void {
	const target = resolve(root, path);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(resolve(REPOSITORY_ROOT, path), target);
}

function copyBaseTuple(root: string): void {
	for (const path of Object.keys(contract.baseTupleSha256)) copyFileIntoControlledRepository(root, path);
}

function copyGovernedOwner(root: string): void {
	for (const path of contract.supplement.protectedArtifacts) copyFileIntoControlledRepository(root, path);
}

function initializeControlledRepository(root: string): void {
	expect(git(root, "init", "-q").status).toBe(0);
	expect(git(root, "config", "user.email", "phase5@example.invalid").status).toBe(0);
	expect(git(root, "config", "user.name", "phase5-freeze-control").status).toBe(0);
	expect(git(root, "config", "commit.gpgsign", "false").status).toBe(0);
}

function commitControlledRepository(root: string, message: string): string {
	expect(git(root, "add", ".").status).toBe(0);
	const committed = git(root, "commit", "-q", "-m", message);
	if (committed.status !== 0) throw new Error(`${committed.stdout}\n${committed.stderr}`);
	return String(git(root, "rev-parse", "HEAD").stdout).trim();
}

function prepareCheckerDependencies(root: string): void {
	copyFileIntoControlledRepository(root, "package.json");
	const modules = resolve(root, "node_modules");
	if (!existsSync(modules)) symlinkSync(resolve(REPOSITORY_ROOT, "node_modules"), modules, "dir");
}

function executeChecker(root: string, base: string, checker = contract.supplement.checker): CheckerResult {
	const result = spawnSync(process.execPath, [resolve(root, checker), base], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, [CHECKER_ROOT_ENV]: root },
		timeout: 30_000,
	});
	return { output: `${result.stdout}\n${result.stderr}`, status: result.status };
}

function executeBaseThenCurrentChecker(root: string, base: string): CheckerResult {
	const baseSource = git(root, "show", `${base}:${contract.supplement.checker}`);
	if (baseSource.status !== 0) return executeChecker(root, base);
	const trusted = resolve(root, ".phase5-base-checker.mjs");
	writeFileSync(trusted, baseSource.stdout);
	const baseResult = executeChecker(root, base, ".phase5-base-checker.mjs");
	if (baseResult.status !== 0) return baseResult;
	return executeChecker(root, base);
}

function withControlledRepository(
	baseKind: "absent" | "complete" | "partial",
	action: (input: Readonly<{ base: string; root: string }>) => void
): void {
	const root = mkdtempSync(join(tmpdir(), "ts-drp-phase5-seal-law-"));
	try {
		initializeControlledRepository(root);
		copyBaseTuple(root);
		if (baseKind === "complete") copyGovernedOwner(root);
		if (baseKind === "partial") {
			copyFileIntoControlledRepository(root, "tests/phase-5a-seal-digest-law-red.test.ts");
		}
		const base = commitControlledRepository(root, "base");
		if (baseKind !== "complete") copyGovernedOwner(root);
		prepareCheckerDependencies(root);
		action({ base, root });
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

describe("D.105a governed protocol-v3 seal digest identity RED", () => {
	it("keeps the frozen v3 tuple byte-identical and proves the identities independently", () => {
		expect(artifactHashes(Object.keys(contract.baseTupleSha256))).toEqual(contract.baseTupleSha256);

		const registry = readJson<RegistryV1>(REGISTRY_PATH);
		expect({ protocolMajor: registry.protocolMajor, registryVersion: registry.registryVersion }).toEqual({
			protocolMajor: contract.decision.protocolMajor,
			registryVersion: contract.decision.registryVersion,
		});
		expect(registry.kinds.cutValue?.domain).toBe(contract.domains.cutValue);
		expect(registry.kinds.sealProposal?.domain).toBe(contract.domains.sealProposal);
		expect(registry.kinds.cutValue?.fields.map(({ name }) => name)).not.toContain("round");
		expect(registry.kinds.sealProposal?.fields.map(({ name }) => name)).toContain("valueDigest");
		expect(registry.kinds.sealVote?.fields.map(({ name }) => name)).toEqual([
			"kind",
			"objectId",
			"epoch",
			"round",
			"phase",
			"proposalDigest",
			"proposalHash",
			"signerId",
		]);
		expect(registry.kinds.sealVote?.fields.find(({ name }) => name === "phase")?.constraints).toEqual({
			values: ["prepare", "commit"],
		});

		const frozenVectors = readJson<RegistryVectors>(VECTORS_PATH);
		const cut = frozenVectors.vectors.find(({ id }) => id === contract.vectors.cutValueVectorId);
		expect(cut).toBeDefined();
		if (cut === undefined) return;
		expect(independentDomainHash(contract.domains.cutValue, bytesFromHex(cut.canonicalHex))).toBe(
			contract.vectors.valueDigestHex
		);
		expect(cut.digestHex).toBe(contract.vectors.valueDigestHex);

		const proposalCases = contract.vectors.proposals.map(({ round }) => ({
			id: `round-${round}`,
			input: {
				kind: "drp-seal-proposal",
				objectId: "object:cut",
				epoch: 7,
				round,
				valueDigest: contract.vectors.valueDigestHex,
			},
			kind: "sealProposal",
		}));
		const reference = encodeWithIndependentReference([
			{ id: cut.id, input: cut.input, kind: cut.kind },
			...proposalCases,
		]);
		expect(reference[0]).toMatchObject({ canonicalHex: cut.canonicalHex, digestHex: cut.digestHex });
		for (let index = 0; index < contract.vectors.proposals.length; index++) {
			const expected = contract.vectors.proposals[index];
			const observed = reference[index + 1];
			expect(observed).toMatchObject({
				canonicalHex: expected?.canonicalHex,
				digestHex: expected?.proposalHashHex,
				normalized: { round: expected?.round, valueDigest: contract.vectors.valueDigestHex },
			});
			expect(independentDomainHash(contract.domains.sealProposal, bytesFromHex(expected?.canonicalHex ?? ""))).toBe(
				expected?.proposalHashHex
			);
		}
		expect(new Set(contract.vectors.proposals.map(({ proposalHashHex }) => proposalHashHex)).size).toBe(2);
		expect(
			contract.vectors.voteBindings.every(
				({ proposalDigestHex }) => proposalDigestHex === contract.vectors.valueDigestHex
			)
		).toBe(true);
		expect(
			contract.vectors.qcBindings.every(
				({ proposalDigestHex }) => proposalDigestHex === contract.vectors.valueDigestHex
			)
		).toBe(true);

		const law = semanticLawFromContract();
		expect(() => auditSemanticLaw(law)).not.toThrow();
		const semanticMutants = [
			{
				id: "ROUND_BEARING_VALUE_DIGEST",
				mutate(value: SemanticLawProjection): void {
					value.cutValueDigest = "hash-domain-round-bearing-cut-value-bytes";
				},
			},
			{
				id: "PROPOSAL_HASH_AS_LOCK_IDENTITY",
				mutate(value: SemanticLawProjection): void {
					value.lockIdentity = "proposalHash";
				},
			},
			{
				id: "VOTE_PROPOSAL_DIGEST_SUBSTITUTION",
				mutate(value: SemanticLawProjection): void {
					value.sealVoteProposalDigest = "proposalHash";
				},
			},
			{
				id: "QC_PROPOSAL_HASH_SUBSTITUTION",
				mutate(value: SemanticLawProjection): void {
					value.qcProposalDigest = "proposalHash";
				},
			},
			{
				id: "ROUND_CHANGE_AS_SEAL_VOTE_PHASE",
				mutate(value: SemanticLawProjection): void {
					value.sealVotePhases.push("round-change");
				},
			},
		] as const;
		for (const mutant of semanticMutants) {
			const candidate = structuredClone(law);
			mutant.mutate(candidate);
			expect(() => auditSemanticLaw(candidate), mutant.id).toThrowError(contract.mutantRejections[mutant.id]);
		}
		expect(
			[
				...semanticMutants.map(({ id }) => id),
				"BASE_V3_TUPLE_EDIT",
				"UNPROTECTED_RED_OWNER",
				"CHECKER_WITHOUT_BASE_BOOTSTRAP",
			].sort()
		).toEqual(Object.keys(contract.mutantRejections).sort());

		const roundBearingCut = spawnSync(process.execPath, [REFERENCE], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			input: JSON.stringify({
				cases: [{ id: "round-bearing-cut", input: { ...cut.input, round: 1 }, kind: "cutValue" }],
				operation: "encode-corpus",
			}),
		});
		expect(roundBearingCut.status).not.toBe(0);
	});

	it("has the complete checker-authenticated seven-file PH-P5-D01 owner", () => {
		expect(SUPPLEMENT_READY).toBe(true);
	});
});

describe.skipIf(!SUPPLEMENT_READY)("D.105a frozen supplement behavior", () => {
	it("binds the exact profile, vectors, and normative law", () => {
		const profile = readJson(resolve(SUPPLEMENT_ROOT, "profile.json"));
		const vectors = readJson(resolve(SUPPLEMENT_ROOT, "vectors.json"));
		const specification = readFileSync(resolve(SUPPLEMENT_ROOT, "spec.md"), "utf8");
		expect(profile).toEqual(contract.profile);
		expect(vectors).toEqual(contract.vectors);
		expect(parseNormativeDecision(specification)).toEqual(contract.decision);
		expect(() => auditSemanticLaw(semanticLawFromContract())).not.toThrow();
	});

	it("pins its closed schema, protected owners, checker, and bootstrap workflow", () => {
		const schema = readJson<Record<string, unknown>>(resolve(SUPPLEMENT_ROOT, "schema.json"));
		const policy = readJson<{
			readonly artifactSha256: Readonly<Record<string, string>>;
			readonly checker: string;
			readonly checkerSha256: string;
			readonly profile: string;
			readonly protectedArtifacts: readonly string[];
			readonly schemaVersion: string;
			readonly workflow: string;
		}>(resolve(SUPPLEMENT_ROOT, "freeze-policy.json"));
		expect(schema).toMatchObject({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
		});
		expect(policy).toMatchObject({
			checker: "check-freeze.mjs",
			profile: contract.decision.profileId,
			protectedArtifacts: contract.supplement.protectedArtifacts,
			schemaVersion: "ts-drp-seal-digest-identity-freeze-v1",
			workflow: contract.supplement.workflow,
		});
		expect(policy.checkerSha256).toBe(sha256File(resolve(SUPPLEMENT_ROOT, "check-freeze.mjs")));
		for (const [path, digest] of Object.entries(policy.artifactSha256)) {
			expect(digest).toBe(sha256File(resolve(REPOSITORY_ROOT, path)));
		}
		expect(Object.keys(policy.artifactSha256).sort()).toEqual(
			contract.supplement.protectedArtifacts
				.filter((path) => !path.endsWith("check-freeze.mjs") && !path.endsWith("freeze-policy.json"))
				.sort()
		);

		const workflow = readFileSync(resolve(REPOSITORY_ROOT, contract.supplement.workflow), "utf8");
		auditWorkflow(workflow);

		withControlledRepository("absent", ({ base, root }) => {
			const bootstrap = executeChecker(root, base);
			expect(bootstrap.status, bootstrap.output).toBe(0);
		});
		withControlledRepository("complete", ({ base, root }) => {
			const unchanged = executeBaseThenCurrentChecker(root, base);
			expect(unchanged.status, unchanged.output).toBe(0);

			const baseTuplePath = Object.keys(contract.baseTupleSha256)[0];
			if (baseTuplePath === undefined) throw new Error("base tuple must be nonempty");
			writeFileSync(resolve(root, baseTuplePath), `${readFileSync(resolve(root, baseTuplePath), "utf8")}\n`);
			const drift = executeBaseThenCurrentChecker(root, base);
			expect(drift.status).not.toBe(0);
			expect(drift.output).toContain(contract.mutantRejections.BASE_V3_TUPLE_EDIT);
		});
		withControlledRepository("complete", ({ base, root }) => {
			const policyPath = resolve(root, contract.supplement.directory, "freeze-policy.json");
			const candidate = readJson<{
				artifactSha256: Record<string, string>;
				protectedArtifacts: string[];
			}>(policyPath);
			candidate.protectedArtifacts = candidate.protectedArtifacts.filter(
				(path) => path !== "tests/phase-5a-seal-digest-law-red.test.ts"
			);
			delete candidate.artifactSha256["tests/phase-5a-seal-digest-law-red.test.ts"];
			writeFileSync(policyPath, `${JSON.stringify(candidate, null, "\t")}\n`);
			const unprotected = executeBaseThenCurrentChecker(root, base);
			expect(unprotected.status).not.toBe(0);
			expect(unprotected.output).toContain(contract.mutantRejections.UNPROTECTED_RED_OWNER);
		});
		withControlledRepository("partial", ({ base, root }) => {
			const partial = executeChecker(root, base);
			expect(partial.status).not.toBe(0);
			expect(partial.output).toContain(contract.mutantRejections.CHECKER_WITHOUT_BASE_BOOTSTRAP);
		});
		withControlledRepository("complete", ({ base, root }) => {
			writeFileSync(resolve(root, contract.supplement.checker), "process.exit(0);\n");
			const bypass = executeBaseThenCurrentChecker(root, base);
			expect(bypass.status).not.toBe(0);
			expect(bypass.output).toContain(contract.mutantRejections.CHECKER_WITHOUT_BASE_BOOTSTRAP);
		});
	});

	it("passes the real supplement checker", () => {
		expect(() =>
			execFileSync(process.execPath, [resolve(REPOSITORY_ROOT, contract.supplement.checker)], {
				cwd: REPOSITORY_ROOT,
				stdio: "pipe",
				timeout: 30_000,
			})
		).not.toThrow();
	});
});

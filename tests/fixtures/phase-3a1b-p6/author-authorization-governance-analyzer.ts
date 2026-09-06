import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

const AUTHORIZATION_EXPORT = Object.freeze({
	types: "./dist/src/author-authorization.d.ts",
	import: "./dist/src/author-authorization.js",
});
const GOVERNANCE_ARTIFACTS = Object.freeze([
	"packages/protocol-v3/supplements/author-authorization-v1/check-freeze.mjs",
	"packages/protocol-v3/supplements/author-authorization-v1/freeze-policy.json",
	"packages/protocol-v3/supplements/author-authorization-v1/profile.json",
	"packages/protocol-v3/supplements/author-authorization-v1/schema.json",
	"packages/protocol-v3/supplements/author-authorization-v1/spec.md",
	"packages/protocol-v3/supplements/author-authorization-v1/vectors.json",
	".github/workflows/protocol-v3-author-authorization.yml",
]);

interface PackageManifest {
	readonly exports?: Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

interface FreezePolicy {
	readonly artifactSha256?: Readonly<Record<string, unknown>>;
	readonly checkerSha256?: unknown;
	readonly protectedArtifacts?: readonly unknown[];
}

function withoutExports(value: PackageManifest): Readonly<Record<string, unknown>> {
	const { exports: _exports, ...rest } = value;
	return rest;
}

/** Audits the exact additive manifest transition without freezing JSON formatting or key order. */
export function auditAuthorizationManifestTransition(
	base: PackageManifest,
	candidate: PackageManifest
): readonly string[] {
	const violations: string[] = [];
	if (!isDeepStrictEqual(withoutExports(base), withoutExports(candidate))) violations.push("non-export-manifest-drift");
	const expected = {
		".": { types: "./dist/src/public.d.ts", import: "./dist/src/public.js" },
		"./author-authorization": AUTHORIZATION_EXPORT,
		"./registry/registry-v1.json": "./registry/registry-v1.json",
	};
	if (!isDeepStrictEqual(candidate.exports, expected)) violations.push("export-map");
	return violations;
}

/** Audits workflow behavior through parsed YAML rather than textual layout. */
export function auditAuthorizationWorkflow(source: string): readonly string[] {
	const violations: string[] = [];
	let workflow: Record<string, unknown>;
	try {
		workflow = parse(source) as Record<string, unknown>;
	} catch {
		return ["workflow-yaml"];
	}
	if (workflow.name !== "Protocol v3 author authorization freeze") violations.push("workflow-name");
	const permissions = workflow.permissions as Record<string, unknown> | undefined;
	if (permissions?.contents !== "read" || Object.keys(permissions).length !== 1)
		violations.push("workflow-permissions");
	const on = workflow.on as Record<string, unknown> | undefined;
	if (on === undefined || !("pull_request" in on) || !("push" in on)) violations.push("workflow-triggers");
	const jobs = workflow.jobs as Record<string, unknown> | undefined;
	const job = jobs?.["author-authorization"] as Record<string, unknown> | undefined;
	if (job?.["timeout-minutes"] !== 15) violations.push("workflow-timeout");
	const steps = Array.isArray(job?.steps) ? (job.steps as readonly Record<string, unknown>[]) : [];
	const runs = steps.map((step) => step.run).filter((value): value is string => typeof value === "string");
	if (!runs.some((run) => run.includes("author-authorization-v1/check-freeze.mjs")))
		violations.push("workflow-checker");
	if (!runs.some((run) => run.includes("protocol-v3-current-epoch-author-authorization-p6-red.test.ts"))) {
		violations.push("workflow-focused");
	}
	if (!runs.some((run) => run.includes("check-protocol-v3-freeze.mjs"))) violations.push("workflow-v3-freeze");
	if (!runs.some((run) => run.includes("check-protocol-freeze.mjs"))) violations.push("workflow-v2-freeze");
	if (
		source.includes("pull_request_target") ||
		source.includes("continue-on-error") ||
		source.includes("contents: write")
	) {
		violations.push("workflow-unsafe");
	}
	return violations;
}

/** Audits the seven-artifact bundle and sole policy self-hash exception. */
export function auditAuthorizationFreezePolicy(policy: FreezePolicy): readonly string[] {
	const violations: string[] = [];
	if (!isDeepStrictEqual(policy.protectedArtifacts, GOVERNANCE_ARTIFACTS)) violations.push("protected-artifacts");
	if (typeof policy.checkerSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(policy.checkerSha256)) {
		violations.push("checker-hash");
	}
	const expectedPinned = GOVERNANCE_ARTIFACTS.filter(
		(path) => !path.endsWith("check-freeze.mjs") && !path.endsWith("freeze-policy.json")
	).sort();
	if (!isDeepStrictEqual(Object.keys(policy.artifactSha256 ?? {}).sort(), expectedPinned)) {
		violations.push("artifact-hash-set");
	}
	return violations;
}

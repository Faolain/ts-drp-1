import { parseDocument } from "yaml";

export interface WorkflowIdentity {
	readonly jobKey: string;
	readonly jobName: string | null;
	readonly workflowName: string;
}

const SUCCESSOR = "packages/protocol-v3/conformance/freeze-successor-v1/check-freeze.mjs";
const PULL_REQUEST_TYPES = ["edited", "opened", "ready_for_review", "reopened", "synchronize"];
const GOSSIP_JOB = "protocol-v3-equivocation-gossip-budget";
const GOSSIP_DIGEST_CHECKER = "packages/protocol-v3/supplements/equivocation-digest-identity-v1/check-freeze.mjs";
const GOSSIP_EVIDENCE_CHECKER = "packages/protocol-v3/supplements/equivocation-evidence-projection-v1/check-freeze.mjs";
const GOSSIP_AUTHOR_SUITE = "tests/protocol-v3-equivocation-author-projection-0o-b1b.test.ts";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function commandText(job: Record<string, unknown>): string {
	const steps = Array.isArray(job.steps) ? job.steps : [];
	return steps
		.map((step) => record(step)?.run)
		.filter((run): run is string => typeof run === "string")
		.join("\n");
}

function successorBindings(job: Record<string, unknown>): readonly string[] {
	const steps = Array.isArray(job.steps) ? job.steps : [];
	return steps.flatMap((step) => {
		const env = record(record(step)?.env);
		return env === undefined
			? []
			: Object.entries(env)
					.filter(([, value]) => value === SUCCESSOR)
					.map(([name]) => name);
	});
}

function executableLegacyReference(script: string, legacyCheckers: readonly string[]): boolean {
	const commands = script
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	return commands.some((line) => legacyCheckers.some((checker) => line.includes(checker)));
}

function invokesLiteral(script: string, executable: "node" | "vitest", value: string): boolean {
	const escaped = escapeRegularExpression(value);
	return executable === "node"
		? new RegExp(`(?:^|[;&|])\\s*node\\s+["']?${escaped}["']?(?:\\s|$)`, "mu").test(script)
		: new RegExp(`(?:^|[;&|])\\s*(?:pnpm\\s+exec\\s+)?vitest\\s+run[^\\n]*["']?${escaped}["']?(?:\\s|$)`, "mu").test(
				script
			);
}

function executableShell(script: string): string {
	return script
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

function reachableShell(script: string): string {
	return script
		.split("\n")
		.filter((line) => !/^\s*(?:false\s*&&|true\s*\|\|)/u.test(line))
		.join("\n");
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Analyzer-only routing audit. Git ancestry, bytes and child outcomes are deliberately outside its authority.
 * @param source - Candidate workflow YAML.
 * @param identity - Exact workflow and job identity.
 * @param legacyCheckers - Superseded checker paths forbidden as direct Node targets.
 * @returns Semantic routing violations.
 */
export function auditSuccessorWorkflowRouting(
	source: string,
	identity: WorkflowIdentity,
	legacyCheckers: readonly string[]
): readonly string[] {
	const violations: string[] = [];
	let root: Record<string, unknown> | undefined;
	try {
		root = record(parseDocument(source, { schema: "core" }).toJS());
	} catch {
		return ["yaml-invalid"];
	}
	if (root === undefined) return ["yaml-not-record"];
	if (root.name !== identity.workflowName) violations.push("workflow-name");
	const trigger = record(record(root.on)?.pull_request);
	const triggerTypes = Array.isArray(trigger?.types) ? [...trigger.types].sort() : [];
	if (JSON.stringify(triggerTypes) !== JSON.stringify(PULL_REQUEST_TYPES)) violations.push("pull-request-trigger");
	if (record(root.permissions)?.contents !== "read") violations.push("permissions");
	const jobs = record(root.jobs);
	if (jobs === undefined || Object.keys(jobs).length !== 1 || !(identity.jobKey in jobs)) {
		return [...violations, "job-key"];
	}
	const job = record(jobs[identity.jobKey]);
	if (job === undefined) return [...violations, "job-shape"];
	if (identity.jobName === null ? "name" in job : job.name !== identity.jobName) violations.push("job-name");
	if (job["runs-on"] !== "ubuntu-latest" || job["timeout-minutes"] !== 10) violations.push("job-runtime");
	if (job["continue-on-error"] !== undefined) violations.push("continue-on-error");
	const steps = Array.isArray(job.steps) ? job.steps.map(record).filter((step) => step !== undefined) : [];
	const checkout = steps.find((step) => step.uses === "actions/checkout@v4");
	const checkoutWith = record(checkout?.with);
	if (checkoutWith?.["fetch-depth"] !== 0 || checkoutWith.ref !== "${{ github.sha }}") {
		violations.push("checkout");
	}
	if (!steps.some((step) => typeof step.run === "string" && step.run.includes("pnpm install --frozen-lockfile"))) {
		violations.push("dependency-install");
	}
	const script = executableShell(commandText(job));
	const reachable = reachableShell(script);
	const bindings = successorBindings(job);
	const literalInvocation = new RegExp(
		`(?:^|[;&|])\\s*node\\s+["']?${escapeRegularExpression(SUCCESSOR)}["']?(?:\\s|$)`,
		"mu"
	).test(reachable);
	const boundInvocation = bindings.some((name) =>
		new RegExp(`(?:^|[;&|])\\s*node\\s+["']?\\$\\{?${name}\\}?["']?(?:\\s|$)`, "mu").test(reachable)
	);
	if (!literalInvocation && !boundInvocation) {
		violations.push("successor-path");
	}
	if (!script.includes("git merge-base --all")) violations.push("merge-base-all");
	if (
		!/(?:length|#\w+|wc\s+-l)[^\n]*(?:-ne|!=|===?)\s*1|(?:-ne|!=|===?)\s*1[^\n]*(?:length|#\w+|wc\s+-l)/u.test(script)
	) {
		violations.push("merge-base-singleton");
	}
	if (!script.includes("git cat-file -e") || !script.includes("git show")) violations.push("base-checker-selection");
	const nodeCalls = reachable.match(/(?:^|[;&|])\s*node\s+/gmu) ?? [];
	if (nodeCalls.length < 2) violations.push("dual-checker-execution");
	if (executableLegacyReference(reachable, legacyCheckers)) violations.push("legacy-checker-execution");
	if (identity.jobKey === GOSSIP_JOB) {
		if (!invokesLiteral(reachable, "node", GOSSIP_DIGEST_CHECKER)) violations.push("gossip-digest-checker");
		if (!invokesLiteral(reachable, "node", GOSSIP_EVIDENCE_CHECKER)) violations.push("gossip-evidence-checker");
		if (!invokesLiteral(reachable, "vitest", GOSSIP_AUTHOR_SUITE)) violations.push("gossip-author-suite");
	}
	if (/\bcontinue-on-error\b|\|\|\s*true\b|\btrue\s*\|\||if\s+false\b|\bfalse\s*&&/u.test(script))
		violations.push("bypass");
	return violations;
}

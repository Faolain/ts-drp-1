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
const UPSTREAM_ROOT_CHECKERS = [
	"packages/protocol-v2/scripts/check-protocol-freeze.mjs",
	"packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs",
] as const;

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

function jobEnvironment(job: Record<string, unknown>): Readonly<Record<string, string>> {
	const steps = Array.isArray(job.steps) ? job.steps : [];
	return Object.fromEntries(
		steps.flatMap((step) => {
			const env = record(record(step)?.env);
			return env === undefined
				? []
				: Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string");
		})
	);
}

function shellBindings(script: string, initial: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	const bindings: Record<string, string> = { ...initial };
	for (const statement of script.split(/[;\n]/u)) {
		for (const match of statement.matchAll(
			/(?:^|\s)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;]+))/gu
		)) {
			bindings[match[1]] = match[2] ?? match[3] ?? match[4];
		}
	}
	return bindings;
}

function resolveVariables(value: string, bindings: Readonly<Record<string, string>>): string {
	let resolved = value.replace(/^["']|["']$/gu, "");
	for (let pass = 0; pass < 8; pass += 1) {
		const next = resolved.replace(
			/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu,
			(whole, name: string) => bindings[name] ?? whole
		);
		if (next === resolved) return next;
		resolved = next;
	}
	return resolved;
}

function actualNodeTargets(script: string, initial: Readonly<Record<string, string>>): readonly string[] {
	const bindings = shellBindings(script, initial);
	const targets: string[] = [];
	for (const raw of script.split(/[;\n]/u)) {
		let statement = raw.trim().replace(/^(?:then|do)\s+/u, "");
		if (statement === "" || statement.startsWith("#")) continue;
		statement = statement.replace(/^(?:if|while|until)\s+/u, "");
		const tokens = statement.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? [];
		let index = 0;
		while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index])) index += 1;
		if (tokens[index] === "env") {
			index += 1;
			while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index])) index += 1;
		}
		const executable = resolveVariables(tokens[index] ?? "", bindings);
		if (executable !== "node") continue;
		const target = tokens[index + 1];
		if (target !== undefined) targets.push(resolveVariables(target, bindings));
	}
	return targets;
}

function invokesAnyNodeTarget(targets: readonly string[], candidates: readonly string[]): boolean {
	return targets.some((target) => candidates.includes(target));
}

function hasRepositoryRootBinding(script: string, initial: Readonly<Record<string, string>>): boolean {
	const bindings = shellBindings(script, initial);
	const value = resolveVariables(bindings.PROTOCOL_V3_FREEZE_SUCCESSOR_REPOSITORY_ROOT ?? "", bindings);
	return value === "${{ github.workspace }}" || value === "$GITHUB_WORKSPACE" || value === "${GITHUB_WORKSPACE}";
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
	const environment = jobEnvironment(job);
	const nodeTargets = actualNodeTargets(reachable, environment);
	if (!nodeTargets.includes(SUCCESSOR)) {
		violations.push("successor-path");
	}
	if (!script.includes("git merge-base --all")) violations.push("merge-base-all");
	if (
		!/(?:length|#\w+|wc\s+-l)[^\n]*(?:-ne|!=|===?)\s*1|(?:-ne|!=|===?)\s*1[^\n]*(?:length|#\w+|wc\s+-l)/u.test(script)
	) {
		violations.push("merge-base-singleton");
	}
	if (!script.includes("git cat-file -e") || !script.includes("git show")) violations.push("base-checker-selection");
	if (identity.jobKey.startsWith("protocol-v3-blueprint-") && !hasRepositoryRootBinding(reachable, environment)) {
		violations.push("successor-root-binding");
	}
	if (nodeTargets.length < 2) violations.push("dual-checker-execution");
	if (invokesAnyNodeTarget(nodeTargets, legacyCheckers)) violations.push("legacy-checker-execution");
	if (invokesAnyNodeTarget(nodeTargets, UPSTREAM_ROOT_CHECKERS)) {
		violations.push("upstream-root-checker-execution");
	}
	const bindings = shellBindings(reachable, environment);
	const objectReads = [
		...reachable.matchAll(/\bgit\s+(?:show|cat-file\s+(?:-p|-e))\s+("[^"]*"|'[^']*'|[^\s;]+)/gu),
	].map(([, value]) => resolveVariables(value, bindings));
	if (
		objectReads.some((value) => {
			if (!value.includes(":")) return false;
			const path = value.slice(value.indexOf(":") + 1);
			return path !== SUCCESSOR && !/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(path);
		})
	) {
		violations.push("upstream-byte-authority");
	}
	if (identity.jobKey === GOSSIP_JOB) {
		if (!invokesLiteral(reachable, "node", GOSSIP_DIGEST_CHECKER)) violations.push("gossip-digest-checker");
		if (!invokesLiteral(reachable, "node", GOSSIP_EVIDENCE_CHECKER)) violations.push("gossip-evidence-checker");
	}
	if (/\bcontinue-on-error\b|\|\|\s*true\b|\btrue\s*\|\||if\s+false\b|\bfalse\s*&&/u.test(script))
		violations.push("bypass");
	return violations;
}

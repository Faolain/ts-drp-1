import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const WORKFLOW_PATH = resolve(REPOSITORY_ROOT, ".github/workflows/playwright.yml");
const REQUIRED_ENGINES = ["chromium", "firefox", "webkit"] as const;
const REQUIRED_CONFIGS = [
	"packages/worker-host/playwright.phase-2f-b-handshake.config.ts",
	"packages/worker-host/playwright.phase-2f-c-real-workload.config.ts",
] as const;

interface WorkflowStep {
	readonly run?: unknown;
}

interface WorkflowJob {
	readonly "steps"?: readonly WorkflowStep[];
	readonly "timeout-minutes"?: unknown;
}

interface Workflow {
	readonly jobs?: Readonly<Record<string, WorkflowJob>>;
	readonly on?: Readonly<Record<string, unknown>>;
}

function readWorkflow(): Workflow {
	const document = parseDocument(readFileSync(WORKFLOW_PATH, "utf8"), { schema: "core" });
	expect(
		document.errors.map((error) => error.message),
		"playwright.yml must parse without errors"
	).toEqual([]);
	expect(
		document.warnings.map((warning) => warning.message),
		"playwright.yml must parse without warnings"
	).toEqual([]);
	return document.toJS() as Workflow;
}

function commands(job: WorkflowJob): readonly string[] {
	return (job.steps ?? []).flatMap(({ run }) => (typeof run === "string" ? [run] : []));
}

function escapesRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function invokesConfig(command: string, config: string): boolean {
	return new RegExp(
		String.raw`(?:^|&&|\n)\s*pnpm\s+exec\s+playwright\s+test\b[^&\n]*--config(?:=|\s+)${escapesRegularExpression(config)}(?=\s|$)`,
		"u"
	).test(command);
}

function invokesScript(command: string, script: string): boolean {
	return new RegExp(String.raw`(?:^|&&|\n)\s*pnpm\s+(?:run\s+)?${escapesRegularExpression(script)}(?=\s|$)`, "u").test(
		command
	);
}

function installsRequiredEngines(command: string): boolean {
	return command.split("\n").some((line) => {
		const tokens = line.trim().split(/\s+/u);
		if (tokens.slice(0, 4).join(" ") !== "pnpm exec playwright install") return false;
		const namedEngines = tokens.slice(4).filter((token) => !token.startsWith("-"));
		return namedEngines.length === 0 || REQUIRED_ENGINES.every((engine) => namedEngines.includes(engine));
	});
}

function prTierReachabilityErrors(workflow: Workflow, scripts: Readonly<Record<string, unknown>>): readonly string[] {
	const aggregate = Object.entries(scripts).find((entry): entry is [string, string] => {
		const command = entry[1];
		return typeof command === "string" && REQUIRED_CONFIGS.every((config) => invokesConfig(command, config));
	});
	if (aggregate === undefined) return ["a root script must aggregate both worker-host Playwright configs"];

	const [scriptName] = aggregate;
	const owningJob = Object.values(workflow.jobs ?? {}).find((job) =>
		commands(job).some((command) => invokesScript(command, scriptName))
	);
	if (owningJob === undefined) return [`playwright.yml must invoke the root ${scriptName} aggregate`];

	const timeout = owningJob["timeout-minutes"];
	if (!Number.isInteger(timeout) || (timeout as number) <= 0 || (timeout as number) > 60)
		return ["the worker-host PR job must have a positive timeout no longer than 60 minutes"];
	if (!commands(owningJob).some(installsRequiredEngines))
		return ["the worker-host PR job must install Chromium, Firefox, and WebKit"];
	return [];
}

describe("Phase 2f-c worker-host PR-tier wiring", () => {
	test("keeps the owned configs and ordinary Playwright workflow controls executable", () => {
		for (const config of REQUIRED_CONFIGS) {
			expect(existsSync(resolve(REPOSITORY_ROOT, config)), `${config} must remain package-owned`).toBe(true);
		}
		const configSources = REQUIRED_CONFIGS.map((config) => readFileSync(resolve(REPOSITORY_ROOT, config), "utf8"));
		expect(configSources[0]).toContain('testMatch: "phase-2f-b-handshake.pw.ts"');
		expect(configSources[1]).toContain('testMatch: "phase-2f-c-real-workload.pw.ts"');
		for (const engine of REQUIRED_ENGINES) expect(configSources.join("\n")).toContain(`name: "${engine}"`);

		const workflow = readWorkflow();
		expect(workflow.on).toHaveProperty("pull_request");
		const jobs = Object.values(workflow.jobs ?? {});
		expect(jobs.some((job) => commands(job).some(installsRequiredEngines))).toBe(true);
		expect(
			jobs.every((job) => Number.isInteger(job["timeout-minutes"]) && (job["timeout-minutes"] as number) > 0)
		).toBe(true);
	});

	test("reaches both worker-host browser gates through one bounded root PR command", () => {
		const workflow = readWorkflow();
		const root = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8")) as {
			readonly scripts?: Readonly<Record<string, unknown>>;
		};
		expect(prTierReachabilityErrors(workflow, root.scripts ?? {})).toEqual([]);
	});
});

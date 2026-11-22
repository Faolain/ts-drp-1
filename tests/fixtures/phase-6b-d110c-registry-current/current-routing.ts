import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	baseExpression,
	type Capture,
	CHECKER,
	contract,
	parseWorkflow,
	prospectiveCapture,
	prospectiveWorkflow,
	ROOT,
	sha256,
	V2_CHECKER,
	type Workflow,
	type WorkflowStep,
	workflowYaml,
} from "./current-snapshot.js";

const MAX_BUFFER = contract.bounds.runnerMaxBuffer;
// Trusted runtime executables; candidate node_modules/.bin is never on this PATH.
const NODE = realpathSync(process.execPath);
const GIT = "/usr/bin/git";
const BASH = "/bin/bash";
const TRUSTED_PATH = `${dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin`;

function executableCommands(steps: WorkflowStep[]): string[] {
	return steps
		.filter((step) => step.run !== contract.runner)
		.flatMap((step) => (step.run === undefined ? [] : [step.run.trim()]));
}

/** The parser locates the executable scalar; no comment/string presence is execution evidence. */
export function routedStep(file: string, source: string): WorkflowStep {
	const value = parseWorkflow(source);
	const expected = parseWorkflow(prospectiveWorkflow(file));
	assert.equal(value.name, expected.name, "workflow status identity");
	assert.deepEqual(Object.keys(value.jobs), Object.keys(expected.jobs), "workflow job identity");
	assert.deepEqual(value.permissions, expected.permissions, "workflow permissions");
	assert.deepEqual(value.on, expected.on, "workflow PR retarget/push events");
	const key = Object.keys(expected.jobs)[0];
	const job = value.jobs[key];
	const expectedJob = expected.jobs[key];
	assert.equal(job.name, expectedJob.name, "workflow named status identity");
	assert.equal(job.if, undefined, "workflow job condition can suppress governance");
	assert.equal(job["continue-on-error"], undefined, "workflow ignored job errors");
	assert.deepEqual(job.permissions, expectedJob.permissions, "workflow job permissions");
	assert.deepEqual(job.env, expectedJob.env, "workflow job execution environment");
	assert.equal(job["runs-on"], expectedJob["runs-on"], "workflow runner identity");
	const candidates = job.steps.filter((step) => step.run === contract.runner);
	assert.equal(candidates.length, 1, "workflow must execute the exact base-governed runner once");
	const selected = candidates[0];
	assert.equal(selected.shell, "bash", "workflow runner shell");
	assert.deepEqual(selected.env, { BASE_SHA: baseExpression(file) }, "workflow explicit event base");
	assert.deepEqual(
		Object.keys(selected).sort(),
		["env", "name", "run", "shell"],
		"workflow runner has no suppression keys"
	);
	const governanceIndex = job.steps.indexOf(selected);
	const checkoutIndex = job.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
	const nodeIndex = job.steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
	assert.ok(
		checkoutIndex >= 0 && checkoutIndex < nodeIndex && nodeIndex < governanceIndex,
		"workflow checkout/Node/governance order"
	);
	for (const step of job.steps.slice(0, governanceIndex))
		assert.equal(step.run, undefined, "workflow candidate commands precede governance");
	for (const step of job.steps) {
		assert.equal(step.if, undefined, "workflow dead or conditional step");
		assert.equal(step["continue-on-error"], undefined, "workflow ignored step failures");
	}
	assert.deepEqual(
		job.steps.filter((step) => step.uses !== undefined),
		expectedJob.steps.filter((step) => step.uses !== undefined),
		"workflow checkout/setup requirements"
	);
	assert.deepEqual(
		executableCommands(job.steps),
		executableCommands(expectedJob.steps),
		"workflow omitted/altered subsystem commands"
	);
	return selected;
}

export function mutateWorkflow(file: string, source: string, id: string): string {
	if (id === "duplicate-key") return source + "\njobs: {}\n";
	const value = parseWorkflow(source);
	const jobKey = Object.keys(value.jobs)[0];
	const job = value.jobs[jobKey];
	const index = job.steps.findIndex((step) => step.run === contract.runner);
	assert.ok(index >= 0);
	const step = job.steps[index];
	switch (id) {
		case "job-condition":
			job.if = false;
			break;
		case "step-condition":
			step.if = false;
			break;
		case "comment-only":
			step.run = contract.runner
				.split("\n")
				.map((line) => "# " + line)
				.join("\n");
			break;
		case "ignored-exit":
			step.run = contract.runner.replace(
				'node "$CHECK_DIRECTORY/check-protocol-v3-freeze.mjs" "$MERGE_BASE"',
				'node "$CHECK_DIRECTORY/check-protocol-v3-freeze.mjs" "$MERGE_BASE" || true'
			);
			break;
		case "continue-on-error":
			step["continue-on-error"] = true;
			break;
		case "candidate-dispatch":
			step.run = contract.runner.replace('node "$CHECK_DIRECTORY/check-protocol-v3-freeze.mjs"', `node ${CHECKER}`);
			break;
		case "missing-v2":
			step.run = contract.runner.replace(
				/PROTOCOL_FREEZE_REPOSITORY_ROOT=[\s\S]*?node "\$CHECK_DIRECTORY\/check-protocol-v2-freeze\.mjs" "\$MERGE_BASE"\n/u,
				""
			);
			break;
		case "missing-subsystem": {
			const subsystem = job.steps.findIndex((candidate, at) => at !== index && candidate.run !== undefined);
			// Registry/Ed25519/blueprint may have no ordinary subsystem step; their real v2 call is mandatory.
			if (subsystem < 0) return mutateWorkflow(file, source, "missing-v2");
			job.steps.splice(subsystem, 1);
			break;
		}
		case "status-identity":
			value.jobs[jobKey + "-shadow"] = job;
			delete value.jobs[jobKey];
			break;
		case "permissions-write":
			value.permissions.contents = "write";
			break;
		case "install-before-governance":
			job.steps.splice(index, 0, { run: "pnpm install --frozen-lockfile" });
			break;
		case "missing-retarget":
			value.on.pull_request = { types: ["opened", "synchronize", "reopened"] };
			break;
		case "wrong-base-expression":
			step.env = { BASE_SHA: "${{ github.sha }}" };
			break;
		case "wrong-root":
			step.run = contract.runner.replaceAll('"$GITHUB_WORKSPACE"', '"$RUNNER_TEMP"');
			break;
		default:
			assert.fail(`unknown fixed workflow mutation ${id}`);
	}
	const mutated = workflowText(value);
	assert.notEqual(mutated, source, id);
	return mutated;
}

function workflowText(value: Workflow): string {
	return workflowYaml(value);
}

export interface ProcessResult {
	status: number;
	stdout: string;
	stderr: string;
}

export interface GitFixture {
	root: string;
	runnerTemp: string;
	base: string;
	tree: string;
	gitCalls: number;
	processCalls: number;
	captured: Capture;
	env: NodeJS.ProcessEnv;
}

export function git(fixture: GitFixture, args: string[], expectedStatus = 0, input?: string): string {
	fixture.gitCalls++;
	const child = spawnSync(GIT, ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
		cwd: fixture.root,
		env: fixture.env,
		encoding: "utf8",
		input,
		timeout: contract.bounds.gitMs,
		killSignal: "SIGKILL",
		maxBuffer: MAX_BUFFER,
	});
	assert.equal(child.error, undefined, `bounded Git operation failed: ${args[0]}`);
	assert.equal(child.signal, null, `Git operation terminated: ${args[0]}`);
	assert.equal(child.status, expectedStatus, `Git ${args[0]}: ${child.stderr}`);
	return child.stdout.trim();
}

export function put(fixture: GitFixture, file: string, bytes: string, mode = "100644"): void {
	assert.ok(!file.startsWith("/") && !file.split("/").includes(".."));
	const absolute = join(fixture.root, file);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, bytes, "utf8");
	chmodSync(absolute, mode === "100755" ? 0o755 : 0o644);
}

/** Five Git operations; every v3 governed file and actual unchanged v2 input is committed. */
export function createFixture(captured = prospectiveCapture()): GitFixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "d110c-current-")));
	const runnerTemp = join(root, ".runner-temp");
	mkdirSync(runnerTemp);
	const fixture: GitFixture = {
		root,
		runnerTemp,
		base: "",
		tree: "",
		gitCalls: 0,
		processCalls: 0,
		captured,
		env: {
			PATH: TRUSTED_PATH,
			LANG: "C",
			LC_ALL: "C",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "D110c controlled fixture",
			GIT_AUTHOR_EMAIL: "d110c@example.invalid",
			GIT_COMMITTER_NAME: "D110c controlled fixture",
			GIT_COMMITTER_EMAIL: "d110c@example.invalid",
			GIT_AUTHOR_DATE: "2026-09-06T00:00:00Z",
			GIT_COMMITTER_DATE: "2026-09-06T00:00:00Z",
		},
	};
	for (const [file, bytes] of Object.entries(captured.bytes)) put(fixture, file, bytes, captured.entries[file].mode);
	const v2 = contract.inventory.verificationOnlyV2Closure;
	for (const [file, digest] of Object.entries(v2.files)) {
		const bytes = readFileSync(join(ROOT, file), "utf8");
		assert.equal(sha256(bytes), digest, `unchanged real v2 closure: ${file}`);
		if (Object.hasOwn(captured.bytes, file)) assert.equal(captured.bytes[file], bytes, "shared v2/v3 semantic input");
		else put(fixture, file, bytes, v2.fileEntries[file].mode);
	}
	git(fixture, ["init", "--initial-branch=main", "--template="]);
	git(fixture, ["add", "--all"]);
	git(fixture, ["commit", "-m", "Independent prospective current baseline"]);
	[fixture.base, fixture.tree] = git(fixture, ["rev-parse", "HEAD", "HEAD^{tree}"]).split("\n");
	const entries = git(fixture, ["ls-tree", "-r", "--full-tree", "HEAD"]).split("\n");
	const expected = { ...captured.entries, ...v2.fileEntries };
	assert.equal(entries.length, Object.keys(expected).length);
	assert.equal(entries.length, 218, "191 current present files plus 27 non-overlapping v2 files");
	for (const entry of entries) {
		const match = /^(\d{6}) (blob) ([0-9a-f]{40})\t(.+)$/u.exec(entry);
		assert.ok(match, "fixture commits actual regular blobs");
		assert.deepEqual({ mode: match[1], type: match[2] }, expected[match[4]], match[4]);
	}
	assert.equal(fixture.gitCalls, 5);
	return fixture;
}

export async function boundedProcess(
	fixture: GitFixture,
	command: string,
	args: string[],
	environment: NodeJS.ProcessEnv,
	timeout = contract.bounds.checkerMs,
	input?: string,
	cwd = fixture.root
): Promise<ProcessResult> {
	fixture.processCalls++;
	return new Promise((resolve, reject) => {
		// Never detach: an outer gate stop must own every Bash/Node/Git descendant.
		const child = spawn(command, args, { cwd, env: environment, detached: false, stdio: ["pipe", "pipe", "pipe"] });
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		let size = 0;
		let failure: Error | undefined;
		let cleaned = false;
		const stopOwnedTree = (): void => {
			if (cleaned || child.pid === undefined) return;
			cleaned = true;
			const owned = new Set<number>([child.pid]);
			const signal = (pid: number, kind: NodeJS.Signals): void => {
				try {
					process.kill(pid, kind);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error as Error;
				}
			};
			signal(child.pid, "SIGSTOP");
			// Abnormal-only cardinality: exactly two numeric PID/PPID probes, <=1s each.
			// Stop descendants after the first census so the second closes the spawn race.
			for (let pass = 0; pass < 2; pass++) {
				const census = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
					encoding: "utf8",
					env: fixture.env,
					timeout: 1000,
					killSignal: "SIGKILL",
					maxBuffer: MAX_BUFFER,
				});
				if (census.error !== undefined || census.status !== 0)
					failure = new Error("owned descendant census failed; outer group stop required");
				const rows = (census.stdout ?? "")
					.trim()
					.split("\n")
					.map((line) => line.trim().split(/\s+/u).map(Number));
				let changed = true;
				while (changed) {
					changed = false;
					for (const [pid, parent] of rows)
						if (owned.has(parent) && !owned.has(pid)) {
							owned.add(pid);
							changed = true;
						}
				}
				for (const pid of owned) signal(pid, "SIGSTOP");
			}
			for (const pid of [...owned].reverse()) signal(pid, "SIGKILL");
		};
		const timer = setTimeout(() => {
			failure = new Error(`bounded subprocess exceeded ${timeout}ms`);
			stopOwnedTree();
		}, timeout);
		const collect = (target: Buffer[], bytes: Buffer): void => {
			size += bytes.length;
			if (size > MAX_BUFFER) {
				failure = new Error("bounded subprocess output exceeded fixed limit");
				stopOwnedTree();
			} else target.push(bytes);
		};
		child.stdout.on("data", (bytes: Buffer) => collect(output, bytes));
		child.stderr.on("data", (bytes: Buffer) => collect(errors, bytes));
		child.on("error", (error) => {
			failure = error;
		});
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			if (failure !== undefined) reject(failure);
			else if (signal !== null || status === null) reject(new Error(`subprocess terminated by ${signal}`));
			else
				resolve({
					status,
					stdout: Buffer.concat(output).toString("utf8"),
					stderr: Buffer.concat(errors).toString("utf8"),
				});
		});
		child.stdin.end(input);
	});
}

export async function runRunner(
	fixture: GitFixture,
	base: string | null = fixture.base,
	extra: NodeJS.ProcessEnv = {},
	source = contract.runner
): Promise<ProcessResult> {
	assert.equal(source, contract.runner, "only reviewed executable runner text may execute");
	const env: NodeJS.ProcessEnv = {
		...fixture.env,
		GITHUB_WORKSPACE: fixture.root,
		RUNNER_TEMP: fixture.runnerTemp,
		...extra,
	};
	if (base !== null) env.BASE_SHA = base;
	return boundedProcess(fixture, BASH, ["--noprofile", "--norc", "-s"], env, contract.bounds.runnerMs, source);
}

export async function runRootCli(fixture: GitFixture, args: string[], root = fixture.root): Promise<ProcessResult> {
	const extracted = join(fixture.runnerTemp, "explicit-root.mjs");
	writeFileSync(extracted, fixture.captured.bytes[CHECKER]);
	return boundedProcess(fixture, NODE, [extracted, ...args], {
		...fixture.env,
		PROTOCOL_V3_FREEZE_REPOSITORY_ROOT: root,
	});
}

export async function runChild(fixture: GitFixture, file: string, args: string[]): Promise<ProcessResult> {
	return boundedProcess(
		fixture,
		NODE,
		[join(ROOT, file), ...args],
		{
			...fixture.env,
			PROTOCOL_V3_SEAL_DIGEST_IDENTITY_REPOSITORY_ROOT: ROOT,
			PROTOCOL_V3_PACEMAKER_PROFILE_REPOSITORY_ROOT: ROOT,
			PROTOCOL_V3_ED25519_PROFILE_REPOSITORY_ROOT: ROOT,
			PROTOCOL_V3_BLUEPRINT_ARTIFACT_PROFILE_REPOSITORY_ROOT: ROOT,
			PROTOCOL_V3_AUTHOR_AUTHORIZATION_REPOSITORY_ROOT: ROOT,
		},
		contract.bounds.checkerMs,
		undefined,
		ROOT
	);
}

export async function runDiscovery(fixture: GitFixture): Promise<ProcessResult> {
	// File-only collection is a lifecycle observation, not transition authority or a test run.
	return boundedProcess(
		fixture,
		NODE,
		[join(ROOT, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", "--no-color"],
		fixture.env,
		contract.bounds.discoveryMs,
		undefined,
		ROOT
	);
}

export function assertRunnerExtraction(fixture: GitFixture): void {
	const directories = readdirSync(fixture.runnerTemp).filter((name) => name.startsWith("protocol-v3-current."));
	assert.ok(directories.length > 0, "actual runner must have extracted base checker files");
	for (const name of directories) {
		const directory = join(fixture.runnerTemp, name);
		assert.deepEqual(readdirSync(directory).sort(), ["check-protocol-v2-freeze.mjs", "check-protocol-v3-freeze.mjs"]);
		assert.equal(
			readFileSync(join(directory, "check-protocol-v3-freeze.mjs"), "utf8"),
			fixture.captured.bytes[CHECKER]
		);
		assert.equal(
			sha256(readFileSync(join(directory, "check-protocol-v2-freeze.mjs"))),
			contract.inventory.verificationOnlyV2Closure.files[V2_CHECKER]
		);
	}
}

export function installForwardingPreload(fixture: GitFixture): { NODE_OPTIONS: string; marker: string } {
	const file = join(fixture.runnerTemp, "forwarding.cjs");
	const marker = join(fixture.runnerTemp, "forwarded.txt");
	writeFileSync(
		file,
		[
			'const cp = require("node:child_process");',
			"const original = cp.execFileSync;",
			"cp.execFileSync = function (...args) { return Reflect.apply(original, this, args); };",
			'require("node:module").syncBuiltinESMExports();',
			`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "forwarded\\n");`,
		].join("\n") + "\n"
	);
	return { NODE_OPTIONS: `--require=${file}`, marker };
}

export function disposeFixture(fixture: GitFixture): void {
	assert.ok(dirname(fixture.root) === realpathSync(tmpdir()) && /\/d110c-current-[^/]+$/u.test(fixture.root));
	assert.ok(lstatSync(fixture.root).isDirectory() && !lstatSync(fixture.root).isSymbolicLink());
	rmSync(fixture.root, { recursive: true, force: true });
	assert.equal(existsSync(fixture.root), false);
}

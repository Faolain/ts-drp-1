import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = "/Users/aristotle/Documents/Projects/ts-drp-1";
const out = dirname(fileURLToPath(import.meta.url));
const review = "/private/tmp/d110c-f5b0z-review-Kg6cuq/checkout";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => readFileSync(join(out, file), "utf8");
const json = (file) => JSON.parse(read(file));
const git = (cwd, ...args) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
const parse = (value) => JSON.parse(value.slice(value.indexOf('{"terminal"')));
const grok = parse(read("grok/public.txt"));
const sol = json("sol/final.txt");
const fableEvents = read("fable/events.jsonl")
	.trimEnd()
	.split("\n")
	.map((line) => JSON.parse(line));
const fableResult = fableEvents.findLast((event) => event.type === "result");
assert.ok(fableResult);
assert.equal(fableResult.is_error, false);
assert.deepEqual(fableResult.permission_denials ?? [], []);
const fable = JSON.parse(fableResult.result);
const grokStatus = json("grok/status.json");
assert.equal(grokStatus.classification, "TERMINAL_RESPONSE");
assert.equal(grokStatus.exit_code, 0);
assert.equal(grokStatus.stop_reason, "end_turn");
assert.equal(grokStatus.timed_out, false);
for (const name of ["sol", "fable", "grok-runner"]) {
	const status = json(name + "/runner-status.json");
	assert.equal(status.status, 0);
	assert.equal(status.signal, null);
}
const verdicts = { grok, sol, fable };
for (const [name, verdict] of Object.entries(verdicts)) {
	assert.equal(verdict.verdict, "PASS", name);
	assert.equal(verdict.terminal, "VERDICT: PASS", name);
	assert.equal(verdict.ready_to_close_f5b0z, true, name);
	for (const [level, field] of [
		["P0", "p0_count"],
		["P1", "p1_count"],
		["P2", "p2_count"],
	])
		assert.equal(
			verdict.findings.filter((finding) => finding.severity === level).length,
			verdict[field],
			name + ":" + level
		);
	assert.equal(verdict.p0_count, 0);
	assert.equal(verdict.p1_count, 0);
}
assert.deepEqual([grok.p2_count, sol.p2_count, fable.p2_count], [0, 1, 3]);
const reportedModels = [
	...new Set(fableEvents.flatMap((event) => [event.model, event.message?.model].filter(Boolean))),
];
assert.deepEqual(reportedModels, ["claude-fable-5-1"]);
const calls = fableEvents.flatMap((event) => event.message?.content ?? []).filter((part) => part.type === "tool_use");
assert.ok(calls.every((call) => ["Read", "Glob", "Grep"].includes(call.name)));
assert.equal(git(review, "rev-parse", "HEAD"), "5e7099dfbfb56cc06de75eab6c6d616cf871a4ea");
assert.equal(git(review, "status", "--porcelain=v1"), "");
const baseline = JSON.parse(readFileSync(join(root, ".logs/d110c-0c1f5b0z-red-1eba4f90/custody-after.json"), "utf8"));
for (const [file, expected] of Object.entries(baseline.productionHashes))
	assert.equal(hash(readFileSync(join(root, file))), expected, file);
assert.equal(hash(git(root, "stash", "list", "--format=%H %gd %s")), baseline.stashesSha256);
const plan = "docs/production-hardening/production-hardening-tdd-plan-v2.md";
assert.equal(git(root, "diff", "--check", "--", plan), "");
const expectedDirty = [...Object.keys(baseline.productionHashes), plan].sort();
assert.deepEqual(git(root, "diff", "--name-only").split("\n").sort(), expectedDirty);
const planText = readFileSync(join(root, plan), "utf8");
assert.ok(planText.includes("f5b0z closed; parent GREEN next"));
assert.ok(planText.includes("**Status: CLOSED — separate causal RED and GREEN signed/pushed; final"));
const dispositions = [
	{
		finding: "Fable P2-1",
		owner: "Root boundary owner",
		disposition:
			"Accepted trusted-process boundary; Proxy traps on an injected registry data value are outside the hostile-local threat model. No code change.",
	},
	{
		finding: "Fable P2-2",
		owner: "Future backend-construction change owner",
		disposition:
			"No reachable duplicate registration path today. Construction-failure cleanup is conditional on a future authorized change introducing that path; no parent scope expansion.",
	},
	{
		finding: "Fable P2-3",
		owner: "Root evidence convention",
		disposition:
			"Accept hash-proven apply_patch boundary. Future applicable recorders log the actual tool action; no invented shell receipt, retrospective evidence edit or rerun.",
	},
	{
		finding: "Sol P2-1",
		owner: "Root roadmap owner",
		disposition:
			"Resolved by Current frontier and f5b0z closure status update in this checkpoint; no prose confirmation review.",
	},
];
const result = {
	accepted: true,
	blockingUnion: [],
	verdicts,
	dispositions,
	fable: {
		session: fableResult.session_id,
		models: reportedModels,
		tools: [...new Set(calls.map((call) => call.name))],
	},
	reviewCheckoutUnchanged: true,
	parentFilesPreserved: 7,
	stashes: 27,
	productionCommit: "6f3d3049942c29f547f5cefdda628a3a01078077",
	greenEvidenceCommit: "5e7099dfbfb56cc06de75eab6c6d616cf871a4ea",
	closureScope: "f5b0z only; parent integration remains unexecuted/open",
	planSha256: hash(readFileSync(join(root, plan))),
};
writeFileSync(join(out, "closure.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
const walk = (directory, prefix = "") =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? walk(join(directory, entry.name), prefix + entry.name + "/") : [prefix + entry.name]
	);
const files = walk(out)
	.filter((file) => file !== "manifest.sha256")
	.sort();
const manifest = files.map((file) => hash(readFileSync(join(out, file))) + "  " + file + "\n").join("");
writeFileSync(join(out, "manifest.sha256"), manifest, { flag: "wx" });
for (const line of manifest.trimEnd().split("\n")) {
	const [expected, file] = line.split("  ");
	assert.equal(hash(readFileSync(join(out, file))), expected);
}
console.log(
	JSON.stringify({
		accepted: true,
		blockingUnion: [],
		verdicts: Object.fromEntries(
			Object.entries(verdicts).map(([name, verdict]) => [
				name,
				{ verdict: verdict.verdict, p0: verdict.p0_count, p1: verdict.p1_count, p2: verdict.p2_count },
			])
		),
		manifestEntries: files.length,
		manifestSha256: hash(manifest),
	})
);

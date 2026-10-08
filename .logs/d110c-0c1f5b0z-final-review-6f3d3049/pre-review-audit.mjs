import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = "/Users/aristotle/Documents/Projects/ts-drp-1";
const review = "/private/tmp/d110c-f5b0z-review-Kg6cuq/checkout";
const out = dirname(fileURLToPath(import.meta.url));
const green = join(root, ".logs/d110c-0c1f5b0z-green-b2594cc7");
const red = join(root, ".logs/d110c-0c1f5b0z-red-1eba4f90");
const production = "6f3d3049942c29f547f5cefdda628a3a01078077";
const evidence = "5e7099dfbfb56cc06de75eab6c6d616cf871a4ea";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (cwd, ...args) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const walk = (directory, prefix = "") =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? walk(join(directory, entry.name), prefix + entry.name + "/") : [prefix + entry.name]
	);
const manifests = [];
for (const [directory, expectedHash] of [
	[red, "9e56180ab6f58e05a0b443629fbe9acc066614ca84ad56755b28643ea53864ef"],
	[green, "43de3f011b6ba54120fbff0b2e1cefba7bd7bf34a6b4d2444f0ba566a861afbd"],
]) {
	const bytes = readFileSync(join(directory, "manifest.sha256"));
	assert.equal(hash(bytes), expectedHash);
	const entries = bytes
		.toString()
		.trimEnd()
		.split("\n")
		.map((line) => {
			const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
			assert.ok(match);
			assert.equal(hash(readFileSync(join(directory, match[2]))), match[1], match[2]);
			return match[2];
		});
	assert.deepEqual(
		entries.slice().sort(),
		walk(directory)
			.filter((file) => file !== "manifest.sha256")
			.sort()
	);
	manifests.push({ directory, entries: entries.length, sha256: expectedHash });
}
const redNames = json(join(red, "focused.json")).testResults[0].assertionResults.map((row) => row.fullName);
const outcomes = [];
for (const [label, files, count] of [
	["initial-focused", 1, 16],
	["initial-retained", 7, 125],
	["initial-issuance", 1, 12],
	["signed-focused", 1, 16],
]) {
	const report = json(join(green, label + ".json"));
	const assertions = report.testResults.flatMap((file) => file.assertionResults);
	assert.equal(json(join(green, label, "status.json")).code, 0);
	assert.equal(report.success, true);
	assert.deepEqual(
		[
			report.testResults.length,
			report.numTotalTests,
			report.numPassedTests,
			report.numFailedTests,
			report.numPendingTests,
			report.numTodoTests,
		],
		[files, count, count, 0, 0, 0]
	);
	assert.equal(assertions.length, count);
	for (const row of assertions) {
		assert.equal(row.status, "passed");
		assert.deepEqual(row.failureMessages, []);
	}
	for (const file of report.testResults) {
		assert.equal(file.status, "passed");
		assert.equal(file.message, "");
	}
	if (label.endsWith("focused"))
		assert.deepEqual(
			assertions.map((row) => row.fullName),
			redNames
		);
	outcomes.push({ label, files, count });
}
const validation = json(join(green, "validation.json"));
assert.deepEqual(
	[validation.browser.passed, validation.browser.skipped, validation.browser.failed, validation.browser.flaky],
	[4, 0, 0, 0]
);
assert.equal(json(join(green, "initial-browser/status.json")).code, 0);
for (const mode of ["duplicate", "value", "accessor", "descriptor"]) {
	const directory = join(green, "signed-native-" + mode);
	assert.equal(json(join(directory, "status.json")).code, 0);
	const report = json(join(directory, "stdout"));
	assert.equal(report.completed, true);
	assert.equal(report.token, null);
}
const before = json(join(green, "isolation-signed-before.json"));
const after = json(join(green, "isolation-signed-after.json"));
assert.deepEqual(before.sources, after.sources);
assert.deepEqual(before.runtimes, after.runtimes);
assert.equal(after.head, production);
assert.equal(after.signature, "G");
assert.equal(after.status, "");
assert.equal(after.noCopiedDist, true);
assert.equal(after.noParentPartialPatch, true);
for (const [file, expected] of Object.entries(after.sources))
	assert.equal(hash(execFileSync("git", ["-C", root, "show", production + ":" + file])), expected, file);
for (const runtime of Object.values(after.runtimes)) assert.equal(hash(readFileSync(runtime.path)), runtime.sha256);
for (const [file, expected] of Object.entries(validation.ownerHashes))
	assert.equal(hash(readFileSync(join(root, file))), expected);
const parent = json(join(red, "custody-after.json"));
for (const [file, expected] of Object.entries(parent.productionHashes))
	assert.equal(hash(readFileSync(join(root, file))), expected);
assert.equal(hash(git(root, "stash", "list", "--format=%H %gd %s")), parent.stashesSha256);
assert.equal(git(root, "rev-parse", "HEAD"), evidence);
assert.equal(git(root, "ls-remote", "origin", "refs/heads/codex/phase3a1b-p6-golden-path").split(/\s/)[0], evidence);
assert.equal(git(review, "rev-parse", "HEAD"), evidence);
assert.equal(git(review, "status", "--porcelain=v1"), "");
for (const commit of [production, evidence]) assert.equal(git(root, "log", "-1", "--format=%G?", commit), "G");
assert.equal(
	git(
		root,
		"diff",
		"1eba4f90.." + production,
		"--",
		"tests/phase-6b-d110c-0c1f5b0z-maintenance-discovery-red.test.ts",
		"tests/fixtures/phase-6b-d110c-0c1f5b0z"
	),
	""
);
const result = {
	acceptedForReview: true,
	production,
	evidence,
	reviewCheckout: review,
	manifests,
	outcomes,
	chromiumPasses: 4,
	nativeModes: 4,
	unchangedRedTests: true,
	parentFilesPreserved: 7,
	stashes: 27,
	packageTypechecks: validation.typecheck,
	signedRuntimeCheckout: after.root,
	sourceReview:
		"Root read the complete three-owner diff; no independent blocker found. Formal reviewers still decide their own verdicts.",
};
writeFileSync(join(out, "pre-review-audit.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(result));

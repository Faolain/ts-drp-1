import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = "/Users/aristotle/Documents/Projects/ts-drp-1";
const out = dirname(fileURLToPath(import.meta.url));
const evidence = join(root, ".logs/d110c-0c1f5b0z-red-1eba4f90");
const testCommit = "1eba4f9065d220afb0d77d90aac4a05b250a05bb";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (name) => JSON.parse(readFileSync(join(evidence, name), "utf8"));
const git = (...args) =>
	execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
const manifest = readFileSync(join(evidence, "manifest.sha256"), "utf8");
const entries = manifest
	.trimEnd()
	.split("\n")
	.map((line) => {
		const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
		assert.ok(match, "manifest grammar");
		assert.notEqual(match[2], "manifest.sha256");
		assert.equal(hash(readFileSync(join(evidence, match[2]))), match[1], match[2]);
		return match[2];
	});
const walk = (directory, prefix = "") =>
	readdirSync(directory, { withFileTypes: true }).flatMap((item) =>
		item.isDirectory() ? walk(join(directory, item.name), prefix + item.name + "/") : [prefix + item.name]
	);
assert.deepEqual(
	entries.slice().sort(),
	walk(evidence)
		.filter((name) => name !== "manifest.sha256")
		.sort()
);
const matrix = json("matrix.json");
assert.equal(
	hash(readFileSync(join(evidence, "matrix.json"))),
	"464e04a81d2d3e798f9cdcb43321b28b0070009b4291f0ed1fd79c98ca7f422d"
);
const report = json("focused.json");
assert.deepEqual(
	[report.numTotalTests, report.numFailedTests, report.numPassedTests, report.numPendingTests, report.numTodoTests],
	[16, 14, 2, 0, 0]
);
assert.equal(report.success, false);
assert.equal(report.testResults.length, 1);
const file = report.testResults[0];
assert.ok(file.name.endsWith("/" + matrix.files[0]));
assert.equal(file.message, "");
assert.equal(file.assertionResults.length, 16);
for (const [index, actual] of file.assertionResults.entries()) {
	const expected = matrix.entries[index];
	assert.equal(actual.fullName, expected.name);
	assert.equal(actual.status, expected.expectedStatus);
	assert.deepEqual(
		actual.failureMessages.map((message) => message.split("\n")[0]),
		expected.token ? ["Error: " + expected.token] : []
	);
}
assert.equal(json("result.json").executionCount, 1);
assert.deepEqual(json("result.json").violations, []);
assert.equal(json("result.json").runnerStatus, 1);
assert.equal(json("isolated-focused/status.json").code, 0);
for (const name of ["isolated-install", "isolated-build", "isolated-collection", "isolated-collection-validation"])
	assert.equal(json(name + "/status.json").code, 0, name);
const before = json("isolation-before.json");
const after = json("isolation-after.json");
assert.deepEqual(before.sourceHashes, after.sourceHashes);
assert.deepEqual(before.runtimes, after.runtimes);
assert.equal(after.head, testCommit);
assert.equal(after.signature, "G");
assert.equal(after.trackedStatus, "");
assert.equal(after.noProductionOverlay, true);
assert.equal(after.noCopiedDist, true);
for (const [path, expected] of Object.entries(after.sourceHashes))
	assert.equal(hash(execFileSync("git", ["-C", root, "show", testCommit + ":" + path])), expected, path);
for (const runtime of Object.values(after.runtimes)) {
	assert.ok(runtime.path.startsWith(after.root + "/"));
	assert.equal(hash(readFileSync(runtime.path)), runtime.sha256);
}
const mainBefore = json("custody-before.json");
const mainAfter = json("custody-after.json");
assert.deepEqual(mainBefore.productionHashes, mainAfter.productionHashes);
for (const [path, expected] of Object.entries(mainAfter.productionHashes))
	assert.equal(hash(readFileSync(join(root, path))), expected, path);
assert.equal(mainAfter.stashCount, 27);
assert.equal(mainAfter.stashesSha256, mainBefore.stashesSha256);
const validation = json("validation.json");
assert.equal(validation.targetTypeDiagnostics, 0);
assert.deepEqual(validation.protectedMissing, []);
const evidenceCommit = git("log", "-1", "--format=%H", "--", evidence);
assert.ok(evidenceCommit, "signed evidence commit must exist");
for (const commit of [testCommit, evidenceCommit]) assert.equal(git("log", "-1", "--format=%G?", commit), "G");
assert.equal(
	git("ls-remote", "origin", "refs/heads/codex/phase3a1b-p6-golden-path").split(/\s/)[0],
	git("rev-parse", "HEAD")
);
const result = {
	accepted: true,
	testCommit,
	evidenceCommit,
	evidenceManifestSha256: hash(manifest),
	manifestEntries: entries.length,
	cases: 16,
	discoveryFailures: 11,
	refusalFailures: 3,
	compatibilityPasses: 2,
	executionCount: 1,
	targetTypeDiagnostics: 0,
	packageTypecheckPassClaimed: false,
	childRawStreamsInRed: false,
	cleanCheckout: after.root,
	unchangedNativeRuntimes: Object.keys(after.runtimes).length,
	partialParentFilesPreserved: Object.keys(mainAfter.productionHashes).length,
	protectedPathsPresent: validation.protectedPaths,
	stashes: 27,
};
writeFileSync(join(out, "audit.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
const ownEntries = ["audit.json", "audit.mjs"];
writeFileSync(
	join(out, "manifest.sha256"),
	ownEntries.map((name) => hash(readFileSync(join(out, name))) + "  " + name + "\n").join(""),
	{ flag: "wx" }
);
console.log(JSON.stringify(result));
